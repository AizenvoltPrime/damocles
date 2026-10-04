import { randomBytes } from 'node:crypto';
import { ipcMain, type BrowserWindow, type IpcMainEvent, type IpcMainInvokeEvent, type Rectangle, type WebContents } from 'electron';
import { HOST_THEME_STYLE_ID } from '../../shared/host-theme';
import { isSettingsSectionId, type SettingsSectionId } from '../../shared/settings-sections';
import type { OverlayAnswer, OverlayRequest } from '../preload/overlay-channels';
import type { PanelTheme } from '../preload/panel-channels';
import {
  MAX_CHAT_NAME_LENGTH,
  MAX_ID_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_SHELL_COORDINATE,
  MAX_TAG_LENGTH,
  SHELL_CHANNELS,
  type ChatMutationResult,
  type RemoveProjectResult,
  type SelectChatResult,
  type ShellChatList,
  type ShellFocusPart,
  type ShellLayout,
  type ShellState,
} from '../preload/shell-channels';
import { parseOverlayRequest } from './overlay';
import { APP_ORIGIN, SHELL_PAGE_URL } from './protocol';
import { loadAppPage, loggableUrl } from './security';
import { isPanelSender } from './views';
import { parseShellLayout } from './window-layout-store';

// What the shell may ask for; every key and chat id is resolved against main's own lists by the implementation.
export interface ShellActions {
  state(): ShellState;
  addProject(): Promise<void>;
  removeProject(key: string): Promise<RemoveProjectResult>;
  selectProject(key: string): Promise<void>;
  grantTrust(key: string): Promise<void>;
  togglePane(): void;
  listChats(projectKey: string): Promise<ShellChatList>;
  searchChats(projectKey: string, query: string): Promise<ShellChatList>;
  selectChat(chatId: string): Promise<SelectChatResult>;
  newChat(projectKey: string | undefined): Promise<void>;
  // name is trimmed and within bounds
  renameChat(chatId: string, name: string): Promise<ChatMutationResult>;
  // tag is trimmed and within bounds; null removes it
  tagChat(chatId: string, tag: string | null): Promise<ChatMutationResult>;
  deleteChat(chatId: string): Promise<ChatMutationResult>;
  // request is a validated copy; focus returns to the shell page when the popup closes
  requestOverlay(request: OverlayRequest, returnFocus: WebContents): Promise<OverlayAnswer>;
  // window DIP
  openAppMenu(anchor: { readonly x: number; readonly y: number }): void;
  toggleTheme(): void;
  toggleSidebar(): void;
  openSettings(section: SettingsSectionId | undefined): void;
  setContentBounds(bounds: Rectangle): void;
  setLayout(layout: ShellLayout): void;
  setFocusedPart(part: ShellFocusPart | null): void;
}

const MAX_BOUND = MAX_SHELL_COORDINATE;

// A shell page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function isShellId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH;
}

/** A chat name from the shell, trimmed, or undefined when it is not a string of 1..MAX_CHAT_NAME_LENGTH characters after trimming. */
export function chatName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  return name.length > 0 && name.length <= MAX_CHAT_NAME_LENGTH ? name : undefined;
}

/** A tag from the shell, trimmed, null to remove; undefined when malformed. */
export function chatTag(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const tag = value.trim();
  return tag.length > 0 && tag.length <= MAX_TAG_LENGTH ? tag : undefined;
}

/** A point in CSS px from the shell, or undefined when malformed. */
export function shellPoint(raw: unknown): { readonly x: number; readonly y: number } | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const x = Object.hasOwn(raw, 'x') ? (raw as Record<string, unknown>)['x'] : undefined;
  const y = Object.hasOwn(raw, 'y') ? (raw as Record<string, unknown>)['y'] : undefined;
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_BOUND;
  return valid(x) && valid(y) ? { x, y } : undefined;
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

/** A shell action whose failure the page cannot show: report logs it and tells the user, and the call resolves (with `fallback`). */
export function reportFailure<A extends unknown[]>(action: (...args: A) => Promise<void>, report: (err: unknown) => void): (...args: A) => Promise<void>;
export function reportFailure<A extends unknown[], R>(action: (...args: A) => Promise<R>, report: (err: unknown) => void, fallback: R): (...args: A) => Promise<R>;
export function reportFailure<A extends unknown[], R>(action: (...args: A) => Promise<R>, report: (err: unknown) => void, fallback?: R): (...args: A) => Promise<R | undefined> {
  return async (...args) => {
    try {
      return await action(...args);
    } catch (err) {
      report(err);
      return fallback;
    }
  };
}

/** The shell page main serves at SHELL_PAGE_URL: the built shell app under a fresh script nonce and the current theme. */
export function shellHtml(theme: PanelTheme): string {
  const nonce = randomBytes(16).toString('base64');
  const assets = `${APP_ORIGIN}/desktop-shell/assets`;
  return `<!DOCTYPE html>
<html lang="en"${theme.reducedMotion ? ' data-reduced-motion' : ''}>
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

/** The window's own page: the title bar and sidebar, talking to main only through the damocles:shell: channels. */
export class ShellHost {
  private readonly window: BrowserWindow;
  private readonly actions: ShellActions;
  private readonly log: (line: string) => void;
  // The page crashed more than MAX_CRASHES_IN_WINDOW times within CRASH_WINDOW_MS and is left dead.
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
    this.handle(SHELL_CHANNELS.togglePane, () => this.actions.togglePane());
    this.handle(SHELL_CHANNELS.chatsList, (key) => this.actions.listChats(this.id(key)));
    this.handle(SHELL_CHANNELS.chatsSearch, (key, query) => {
      if (typeof query !== 'string' || query.length > MAX_SEARCH_LENGTH) throw new Error('Malformed search from the shell');
      return this.actions.searchChats(this.id(key), query);
    });
    this.handle(SHELL_CHANNELS.chatsSelect, (id) => this.actions.selectChat(this.id(id)));
    this.handle(SHELL_CHANNELS.chatsNew, (key) => this.actions.newChat(key === undefined ? undefined : this.id(key)));
    this.handle(SHELL_CHANNELS.chatsRename, (id, raw) => {
      const name = chatName(raw);
      if (name === undefined) throw new Error('Malformed chat name from the shell');
      return this.actions.renameChat(this.id(id), name);
    });
    this.handle(SHELL_CHANNELS.chatsTag, (id, raw) => {
      const tag = chatTag(raw);
      if (tag === undefined) throw new Error('Malformed tag from the shell');
      return this.actions.tagChat(this.id(id), tag);
    });
    this.handle(SHELL_CHANNELS.chatsDelete, (id) => this.actions.deleteChat(this.id(id)));
    this.handle(SHELL_CHANNELS.overlayRequest, (raw) => {
      const request = parseOverlayRequest(raw);
      if (!request) throw new Error('Malformed overlay request from the shell');
      return this.actions.requestOverlay(request, this.window.webContents);
    });
    this.handle(SHELL_CHANNELS.appMenu, (raw) => {
      const anchor = shellPoint(raw);
      if (!anchor) throw new Error('Malformed menu anchor from the shell');
      const zoom = this.window.webContents.getZoomFactor();
      this.actions.openAppMenu({ x: Math.round(anchor.x * zoom), y: Math.round(anchor.y * zoom) });
    });
    this.handle(SHELL_CHANNELS.toggleTheme, () => this.actions.toggleTheme());
    this.handle(SHELL_CHANNELS.toggleSidebar, () => this.actions.toggleSidebar());
    this.handle(SHELL_CHANNELS.openSettings, (section) => {
      if (section !== undefined && !isSettingsSectionId(section)) throw new Error('Unknown settings section from the shell');
      this.actions.openSettings(section);
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
    this.on(SHELL_CHANNELS.layout, (raw) => {
      const layout = parseShellLayout(raw);
      if (!layout) {
        this.log('[shell] ignoring a malformed layout');
        return;
      }
      this.actions.setLayout(layout);
    });
    this.on(SHELL_CHANNELS.focusedPart, (part) => {
      if (part !== 'sidebar' && part !== null) {
        this.log('[shell] ignoring a malformed focused part');
        return;
      }
      this.actions.setFocusedPart(part);
    });

    const contents = window.webContents;
    contents.on('did-finish-load', () => {
      this.loaded = true;
      this.sendState();
    });
    contents.on('render-process-gone', (_event, details) => {
      this.loaded = false;
      this.log(`[shell] renderer gone (${details.reason})`);
      this.actions.setFocusedPart(null);
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

  // Coalesces bursts (an activity event per chat) into one snapshot per turn of the event loop.
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

  chatsChanged(projectKey: string): void {
    this.send(SHELL_CHANNELS.chatsChanged, projectKey);
  }

  // Keyboard focus moves to the window's own page; the shell then focuses the sidebar's current row.
  focusSidebar(): void {
    if (this.disposed || this.window.isDestroyed()) return;
    this.window.webContents.focus();
    this.send(SHELL_CHANNELS.focusPart, 'sidebar');
  }

  get focused(): boolean {
    return !this.disposed && !this.window.isDestroyed() && this.window.webContents.isFocused();
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
