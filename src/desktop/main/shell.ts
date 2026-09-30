import { randomBytes } from 'node:crypto';
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle } from 'electron';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import type { PanelTheme } from '../preload/panel-channels';
import { MAX_ACTION_LENGTH, MAX_ID_LENGTH, SHELL_CHANNELS, type RemoveProjectResult, type ShellState, type ShellToast } from '../preload/shell-channels';
import type { ToastSink } from './platform/notification-service';
import { APP_ORIGIN, SHELL_PAGE_URL } from './protocol';
import { loadAppPage, loggableUrl } from './security';
import { isPanelSender } from './views';

// What the shell may ask for; every key and id is resolved against main's own lists by the implementation.
export interface ShellActions {
  state(): ShellState;
  addProject(): Promise<void>;
  removeProject(key: string): Promise<RemoveProjectResult>;
  selectProject(key: string): Promise<void>;
  grantTrust(key: string): Promise<void>;
  newTab(projectKey: string | undefined): Promise<void>;
  selectTab(id: string): void;
  closeTab(id: string): void;
  togglePane(id: string): void;
  moveTab(id: string, toIndex: number): void;
  setContentBounds(bounds: Rectangle): void;
  resolveToast(id: string, action: string | undefined): void;
  pendingToasts(): readonly ShellToast[];
}

// Larger than any real display in DIP; anything above is a malformed report.
const MAX_BOUND = 100_000;

// A shell page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isShellId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

export function isToastAction(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_ACTION_LENGTH);
}

/** The shell's CSS-pixel content rectangle as window DIPs, or undefined for a malformed report. */
export function contentBoundsToDip(raw: unknown, zoomFactor: number): Rectangle | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const { x, y, width, height } = raw as Record<string, unknown>;
  const values = [x, y, width, height];
  if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BOUND)) return undefined;
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return undefined;
  const [dx, dy, dw, dh] = values.map((value) => value * zoomFactor) as [number, number, number, number];
  // Rounded outward on the far edge, so a fractional layout leaves no one-pixel gap under the view.
  const left = Math.round(dx);
  const top = Math.round(dy);
  return { x: left, y: top, width: Math.max(0, Math.ceil(dx + dw) - left), height: Math.max(0, Math.ceil(dy + dh) - top) };
}

/** A shell action whose failure the page cannot show: report logs it and tells the user, and the call resolves. */
export function reportFailure<A extends unknown[]>(action: (...args: A) => Promise<void>, report: (err: unknown) => void): (...args: A) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args);
    } catch (err) {
      report(err);
    }
  };
}

/** The shell page main serves at SHELL_PAGE_URL: the built shell app under a fresh script nonce and the current theme. */
export function shellHtml(theme: PanelTheme): string {
  const nonce = randomBytes(16).toString('base64');
  const assets = `${APP_ORIGIN}/desktop-shell/assets`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${APP_ORIGIN} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${APP_ORIGIN}; img-src ${APP_ORIGIN} data:;">
  <link href="${assets}/index.css" rel="stylesheet">
  <style id="${HOST_THEME_STYLE_ID}">${theme.css}</style>
  <title>Damocles</title>
</head>
<body class="vscode-${theme.kind}" data-vscode-theme-kind="vscode-${theme.kind}">
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${assets}/index.js"></script>
</body>
</html>`;
}

/** The window's own page: the project list and tab strip, talking to main only through the damocles:shell: channels. */
export class ShellHost implements ToastSink {
  private readonly window: BrowserWindow;
  private readonly actions: ShellActions;
  private readonly log: (line: string) => void;
  // The page crashed more than MAX_CRASHES_IN_WINDOW times within CRASH_WINDOW_MS and is left dead; it cannot show a toast itself.
  private readonly onRendererGaveUp: () => void;
  private readonly invokeChannels: string[] = [];
  private readonly sendHandlers: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = [];
  private stateScheduled = false;
  private loaded = false;
  private reportedBadBounds = false;
  private crashes: number[] = [];
  private disposed = false;

  constructor(window: BrowserWindow, actions: ShellActions, log: (line: string) => void, onRendererGaveUp: () => void) {
    this.window = window;
    this.actions = actions;
    this.log = log;
    this.onRendererGaveUp = onRendererGaveUp;

    this.handle(SHELL_CHANNELS.getState, () => this.actions.state());
    this.handle(SHELL_CHANNELS.addProject, () => this.actions.addProject());
    this.handle(SHELL_CHANNELS.removeProject, (key) => this.actions.removeProject(this.id(key)));
    this.handle(SHELL_CHANNELS.selectProject, (key) => this.actions.selectProject(this.id(key)));
    this.handle(SHELL_CHANNELS.grantTrust, (key) => this.actions.grantTrust(this.id(key)));
    this.handle(SHELL_CHANNELS.newTab, (key) => this.actions.newTab(key === undefined ? undefined : this.id(key)));
    this.handle(SHELL_CHANNELS.selectTab, (id) => this.actions.selectTab(this.id(id)));
    this.handle(SHELL_CHANNELS.closeTab, (id) => this.actions.closeTab(this.id(id)));
    this.handle(SHELL_CHANNELS.togglePane, (id) => this.actions.togglePane(this.id(id)));
    this.handle(SHELL_CHANNELS.moveTab, (id, toIndex) => {
      if (!Number.isInteger(toIndex)) throw new Error('moveTab needs an integer index');
      this.actions.moveTab(this.id(id), toIndex as number);
    });
    this.on(SHELL_CHANNELS.contentBounds, (raw) => {
      const bounds = contentBoundsToDip(raw, this.window.webContents.getZoomFactor());
      if (!bounds) {
        if (!this.reportedBadBounds) this.log('[shell] ignoring malformed content bounds');
        this.reportedBadBounds = true;
        return;
      }
      this.actions.setContentBounds(bounds);
    });
    this.on(SHELL_CHANNELS.resolveToast, (id, action) => {
      if (!isShellId(id) || !isToastAction(action)) {
        this.log('[shell] ignoring a malformed toast answer');
        return;
      }
      this.actions.resolveToast(id, action);
    });

    const contents = window.webContents;
    contents.on('did-finish-load', () => {
      this.loaded = true;
      this.sendState();
      for (const toast of this.actions.pendingToasts()) this.show(toast);
    });
    contents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.log(`[shell] renderer gone (${details.reason})`);
      if (this.disposed || details.reason === 'clean-exit') return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (this.crashes.length > MAX_CRASHES_IN_WINDOW) {
        this.log(`[shell] crashed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 1000} s; not reloading it`);
        this.onRendererGaveUp();
        return;
      }
      this.load();
    });
  }

  load(): void {
    this.loaded = false;
    loadAppPage(this.window.webContents, SHELL_PAGE_URL).catch((err: unknown) => {
      this.log(`[shell] failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // After the page gave up crashing, at the user's request: a fresh crash budget and a new load.
  restart(): void {
    if (this.disposed) return;
    this.crashes = [];
    this.load();
  }

  // Coalesces bursts (a session list broadcast touches every tab) into one snapshot per turn of the event loop.
  stateChanged(): void {
    if (this.stateScheduled || this.disposed) return;
    this.stateScheduled = true;
    setImmediate(() => {
      this.stateScheduled = false;
      this.sendState();
    });
  }

  sendTheme(theme: PanelTheme): void {
    this.send(SHELL_CHANNELS.theme, theme);
  }

  show(toast: ShellToast): void {
    this.send(SHELL_CHANNELS.toast, toast);
  }

  dismiss(id: string): void {
    this.send(SHELL_CHANNELS.toastDismiss, id);
  }

  // Keyboard focus moves to the window's own page; the shell then focuses its roving tab.
  focusTabStrip(): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.send(SHELL_CHANNELS.focusTabStrip, undefined);
  }

  // Undefined until the page has loaded, so toasts wait in the notification service and replay on load.
  get toastSink(): ToastSink | undefined {
    return this.loaded && !this.disposed ? this : undefined;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of this.invokeChannels) ipcMain.removeHandler(channel);
    for (const [channel, handler] of this.sendHandlers) ipcMain.removeListener(channel, handler);
  }

  private sendState(): void {
    this.send(SHELL_CHANNELS.state, this.actions.state());
  }

  private send(channel: string, payload: unknown): void {
    if (this.disposed || !this.loaded || this.window.isDestroyed()) return;
    const contents = this.window.webContents;
    if (contents.isDestroyed() || contents.isCrashed()) return;
    contents.send(channel, payload);
  }

  private id(value: unknown): string {
    if (!isShellId(value)) throw new Error('Malformed id from the shell');
    return value;
  }

  // Read at call time: the window's webContents is the only accepted sender, on the exact shell page, main frame.
  private accepts(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
    const accepted = !this.disposed && !this.window.isDestroyed() && isPanelSender(event, this.window.webContents, SHELL_PAGE_URL);
    if (!accepted) this.log(`[shell] rejected ${channel} from ${event.senderFrame ? loggableUrl(event.senderFrame.url) : 'a destroyed frame'} (webContents ${event.sender.id})`);
    return accepted;
  }

  private handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      if (!this.accepts(event, channel)) throw new Error('Rejected');
      try {
        return await handler(...args);
      } catch (err) {
        this.log(`[shell] ${channel} failed: ${errorText(err)}`);
        throw err;
      }
    });
    this.invokeChannels.push(channel);
  }

  private on(channel: string, handler: (...args: unknown[]) => void): void {
    const guarded = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (this.accepts(event, channel)) handler(...args);
    };
    ipcMain.on(channel, guarded);
    this.sendHandlers.push([channel, guarded]);
  }
}
