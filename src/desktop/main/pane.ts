import { randomBytes } from 'node:crypto';
import { WebContentsView, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { isNavigableUrl } from '../../core/browser/net-guard';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import type { PanelTheme } from '../preload/panel-channels';
import { MAX_PANE_ID_LENGTH, MAX_PANE_URL_LENGTH, PANE_CHANNELS, type PaneState } from '../preload/pane-channels';
import { isPaneWidth } from './panel-state-store';
import { APP_ORIGIN, PANE_PAGE_URL } from './protocol';
import { loadAppPage, loggableUrl } from './security';
import { isPanelSender } from './views';

// What the pane may ask for; every page id is resolved against the selected chat's own pages by the implementation.
export interface PaneActions {
  state(): PaneState;
  requestWidth(width: number, commit: boolean): void;
  selectPage(id: string): void;
  closePage(id: string): void;
  newPage(): Promise<void>;
  // url is already normalized and navigable
  navigate(id: string, url: string): void;
  goBack(id: string): void;
  goForward(id: string): void;
  reload(id: string): void;
  openExternal(id: string): Promise<void>;
  pickElement(id: string): void;
  openDevTools(id: string): void;
  setMaximized(maximized: boolean): void;
  setCollapsed(collapsed: boolean): void;
}

// A pane page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;

// Transparent, so the overlay mode's scrim shows the chat beneath the pane view.
const TRANSPARENT = '#00000000';

export function isPaneId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PANE_ID_LENGTH;
}

/** The address as the user typed it, as a navigable URL: a bare host gets https://. Undefined when it is not http, https or about:blank. */
export function paneAddress(raw: unknown): string | undefined {
  if (typeof raw !== 'string' || raw.length > MAX_PANE_URL_LENGTH) return undefined;
  const text = raw.trim();
  if (text === '') return undefined;
  const url = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text) ? text : `https://${text}`;
  return isNavigableUrl(url) ? url : undefined;
}

/** The pane page main serves at PANE_PAGE_URL: the built pane app under a fresh script nonce; images only as data: URLs. */
export function paneHtml(theme: PanelTheme): string {
  const nonce = randomBytes(16).toString('base64');
  const assets = `${APP_ORIGIN}/desktop-shell/assets`;
  return `<!DOCTYPE html>
<html lang="en"${theme.reducedMotion ? ' data-reduced-motion' : ''}>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${APP_ORIGIN} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${APP_ORIGIN}; img-src data:; base-uri 'none'; form-action 'none';">
  <link href="${assets}/pane.css" rel="stylesheet">
  <style id="${HOST_THEME_STYLE_ID}">${theme.css}</style>
  <title>Damocles</title>
</head>
<body class="vscode-${theme.kind}" data-vscode-theme-kind="vscode-${theme.kind}">
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${assets}/pane.js"></script>
</body>
</html>`;
}

/** The one pane view of the window: the chrome of the selected chat's browser pane, talking to main only through the damocles:pane: channels. */
export class PaneHost {
  readonly view: WebContentsView;
  private readonly actions: PaneActions;
  private readonly log: (line: string) => void;
  private readonly onRendererGaveUp: () => void;
  private readonly invokeChannels: string[] = [];
  private readonly sendHandlers: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = [];
  private stateScheduled = false;
  private loaded = false;
  private crashes: number[] = [];
  private disposed = false;

  constructor(preloadPath: string, actions: PaneActions, log: (line: string) => void, onRendererGaveUp: () => void) {
    this.actions = actions;
    this.log = log;
    this.onRendererGaveUp = onRendererGaveUp;
    this.view = new WebContentsView({
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // Loading the pane page must not move keyboard focus out of the chat.
        focusOnNavigation: false,
      },
    });
    this.view.setBackgroundColor(TRANSPARENT);
    this.view.setVisible(false);

    this.handle(PANE_CHANNELS.getState, () => this.actions.state());
    this.handle(PANE_CHANNELS.selectPage, (id) => this.actions.selectPage(this.id(id)));
    this.handle(PANE_CHANNELS.closePage, (id) => this.actions.closePage(this.id(id)));
    this.handle(PANE_CHANNELS.newPage, () => this.actions.newPage());
    this.handle(PANE_CHANNELS.navigate, (id, raw) => {
      const pageId = this.id(id);
      const url = paneAddress(raw);
      if (url === undefined) return false;
      this.actions.navigate(pageId, url);
      return true;
    });
    this.handle(PANE_CHANNELS.goBack, (id) => this.actions.goBack(this.id(id)));
    this.handle(PANE_CHANNELS.goForward, (id) => this.actions.goForward(this.id(id)));
    this.handle(PANE_CHANNELS.reload, (id) => this.actions.reload(this.id(id)));
    this.handle(PANE_CHANNELS.openExternal, (id) => this.actions.openExternal(this.id(id)));
    this.handle(PANE_CHANNELS.pickElement, (id) => this.actions.pickElement(this.id(id)));
    this.handle(PANE_CHANNELS.openDevTools, (id) => this.actions.openDevTools(this.id(id)));
    this.handle(PANE_CHANNELS.setMaximized, (value) => this.actions.setMaximized(this.flag(value)));
    this.handle(PANE_CHANNELS.setCollapsed, (value) => this.actions.setCollapsed(this.flag(value)));
    this.on(PANE_CHANNELS.requestWidth, (width, commit) => {
      if (!isPaneWidth(width) || typeof commit !== 'boolean') {
        this.log('[pane] ignoring a malformed width request');
        return;
      }
      this.actions.requestWidth(width, commit);
    });

    const contents = this.view.webContents;
    contents.on('did-finish-load', () => {
      this.loaded = true;
      // Main lays the page view out in DIPs and the chrome in CSS px, so they agree only at zoom 1.
      contents.setZoomFactor(1);
      this.sendState();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.log(`[pane] renderer gone (${details.reason})`);
      if (this.disposed || details.reason === 'clean-exit') return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (this.crashes.length > MAX_CRASHES_IN_WINDOW) {
        this.log(`[pane] crashed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 1000} s; not reloading it`);
        this.onRendererGaveUp();
        return;
      }
      this.load();
    });
  }

  load(): void {
    this.loaded = false;
    loadAppPage(this.view.webContents, PANE_PAGE_URL).catch((err: unknown) => {
      this.log(`[pane] failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // After the page gave up crashing, at the user's request: a fresh crash budget and a new load.
  restart(): void {
    if (this.disposed) return;
    this.crashes = [];
    this.load();
  }

  // Coalesces bursts (a drag, a page load) into one snapshot per turn of the event loop.
  stateChanged(): void {
    if (this.stateScheduled || this.disposed) return;
    this.stateScheduled = true;
    setImmediate(() => {
      this.stateScheduled = false;
      this.sendState();
    });
  }

  // Sent now rather than coalesced: a divider drag waits for main's clamped width.
  sendStateNow(): void {
    this.sendState();
  }

  sendTheme(theme: PanelTheme): void {
    this.send(PANE_CHANNELS.theme, theme);
  }

  // Keyboard focus moves into the pane view; the pane then focuses its active page tab.
  focus(): void {
    if (this.disposed || this.view.webContents.isDestroyed()) return;
    this.view.webContents.focus();
    this.send(PANE_CHANNELS.focus, undefined);
  }

  get focused(): boolean {
    return !this.disposed && !this.view.webContents.isDestroyed() && this.view.webContents.isFocused();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const contents = this.view.webContents;
    if (contents.isDestroyed()) return;
    for (const channel of this.invokeChannels) contents.ipc.removeHandler(channel);
    for (const [channel, handler] of this.sendHandlers) contents.ipc.removeListener(channel, handler);
    contents.close();
  }

  private sendState(): void {
    this.send(PANE_CHANNELS.state, this.actions.state());
  }

  private send(channel: string, payload: unknown): void {
    if (this.disposed || !this.loaded) return;
    const contents = this.view.webContents;
    if (contents.isDestroyed() || contents.isCrashed()) return;
    contents.send(channel, payload);
  }

  private id(value: unknown): string {
    if (!isPaneId(value)) throw new Error('Malformed page id from the pane');
    return value;
  }

  private flag(value: unknown): boolean {
    if (typeof value !== 'boolean') throw new Error('Malformed flag from the pane');
    return value;
  }

  // webContents.ipc receives only this view's messages; the check still pins them to its main frame on the exact pane page.
  private accepts(event: IpcMainEvent | IpcMainInvokeEvent, channel: string): boolean {
    const accepted = !this.disposed && isPanelSender(event, this.view.webContents, PANE_PAGE_URL);
    if (!accepted) this.log(`[pane] rejected ${channel} from ${event.senderFrame ? loggableUrl(event.senderFrame.url) : 'a destroyed frame'} (webContents ${event.sender.id})`);
    return accepted;
  }

  private handle(channel: string, handler: (...args: unknown[]) => unknown): void {
    this.view.webContents.ipc.handle(channel, async (event, ...args: unknown[]) => {
      if (!this.accepts(event, channel)) throw new Error('Rejected');
      try {
        return await handler(...args);
      } catch (err) {
        this.log(`[pane] ${channel} failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
    this.invokeChannels.push(channel);
  }

  private on(channel: string, handler: (...args: unknown[]) => void): void {
    const guarded = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (this.accepts(event, channel)) handler(...args);
    };
    this.view.webContents.ipc.on(channel, guarded);
    this.sendHandlers.push([channel, guarded]);
  }
}
