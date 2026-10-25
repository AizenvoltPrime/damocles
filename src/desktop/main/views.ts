import { randomBytes, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WebContentsView, type BrowserWindow, type IpcMainEvent, type Rectangle, type WebContents } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { PanelHost, PanelOptions } from '../../platform/window-service';
import { restoredWorkspaceFolderKey } from '../../shared/restored-folder-key';
import { browserPageHtml, type BrowserPageStrings } from '../../shared/browser-page-html';
import { chatPageHtml, errorPageHtml, type ErrorPageStrings, type PageSpec } from '../../shared/panel-html';
import { CHAT_WORKER_SRC } from '../app-urls';
import { PAGE_STATE_TYPES } from '../core-protocol';
import { PANEL_CHANNELS, type PanelHostLabel, type PanelInit, type PanelTheme } from '../preload/panel-channels';
import { onWindowActivated, onWindowDeactivated } from './activation-focus';
import type { PanelStateStore } from './panel-state-store';
import { APP_ORIGIN, isPanelId, panelPageUrl } from './protocol';
import { loadAppPage, loggableUrl, registerPanelContents } from './security';
import { currentTheme, currentThemeKind, THEME_BACKGROUND } from './theme';

export interface SenderEvent {
  readonly sender: unknown;
  readonly senderFrame: { readonly url: string; readonly parent: unknown } | null;
}

/** An IPC message is accepted only from the panel's own view, from its main frame, on its own app:// page. */
export function isPanelSender(event: SenderEvent, contents: unknown, pageUrl: string): boolean {
  const frame = event.senderFrame;
  return event.sender === contents && frame !== null && frame.parent === null && frame.url === pageUrl;
}

// Messages carry pasted images as base64; the state is a few ids and is rewritten to panels.json on every change.
export const MAX_MESSAGE_JSON_CHARS: number = 64 * 1024 * 1024;
export const MAX_STATE_JSON_CHARS: number = 64 * 1024;

/**
 * IPC delivers structured clones (BigInt, Map, cycles …); a JSON round trip gives core exactly the JSON-shaped
 * value the VS Code webview delivers. Undefined when the payload has no JSON form or exceeds maxChars.
 */
export function asJsonValue(payload: unknown, maxChars: number): { readonly value: unknown } | undefined {
  let json: string | undefined;
  try {
    json = JSON.stringify(payload);
  } catch {
    return undefined;
  }
  if (json === undefined) return { value: undefined };
  if (json.length > maxChars) return undefined;
  return { value: JSON.parse(json) as unknown };
}

// Every webview→host message in the contract is an object with a string `type`.
export function isWebviewMessage(value: unknown): value is { readonly type: string } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && typeof (value as { type?: unknown }).type === 'string';
}

// The webview persists a plain object (session id, folder key) or clears it.
export function isWebviewState(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'object' && !Array.isArray(value));
}

// A page that kills its renderer on every load is left dead rather than reloaded in a loop.
const MAX_CRASHES_IN_WINDOW = 3;
const CRASH_WINDOW_MS = 60_000;

export { CHAT_WORKER_SRC };

// A favicon larger than this is not inlined into the editor state that is resent on every change.
export const MAX_ICON_BYTES: number = 32 * 1024;

const ICON_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/**
 * The data: URL of an icon file, or undefined for an unknown type or a file over MAX_ICON_BYTES. Reads through original-fs, so
 * a file packed in app.asar needs resource-fs.ts instead.
 */
export async function iconDataUrl(iconPath: string): Promise<string | undefined> {
  const mime = ICON_MIME_TYPES[path.extname(iconPath).toLowerCase()];
  if (mime === undefined) return undefined;
  const stat = await fs.stat(iconPath);
  if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return undefined;
  return `data:${mime};base64,${(await fs.readFile(iconPath)).toString('base64')}`;
}

class Listeners<A extends unknown[]> {
  private readonly set = new Set<(...args: A) => void>();

  add(listener: (...args: A) => void): Disposable {
    this.set.add(listener);
    return { dispose: () => { this.set.delete(listener); } };
  }

  fire(...args: A): void {
    for (const listener of [...this.set]) listener(...args);
  }

  clear(): void {
    this.set.clear();
  }
}

// The page state its editor tab shows, read from the host messages core posts to the page (urlChanged, navigationState,
// pickingStateChanged); the page renderer is never asked.
export interface ObservedPage {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  picking: boolean;
}

/** Folds one host→page message into the observed page state; true when it changed. */
export function observePageMessage(page: ObservedPage, message: unknown): boolean {
  const data = message as { type?: unknown; url?: unknown; loading?: unknown; canGoBack?: unknown; canGoForward?: unknown; picking?: unknown } | null;
  if (typeof data !== 'object' || data === null) return false;
  if (data.type === 'urlChanged' && typeof data.url === 'string') {
    if (data.url === page.url) return false;
    page.url = data.url;
    return true;
  }
  if (data.type === 'navigationState' && typeof data.loading === 'boolean' && typeof data.canGoBack === 'boolean' && typeof data.canGoForward === 'boolean') {
    if (data.loading === page.loading && data.canGoBack === page.canGoBack && data.canGoForward === page.canGoForward) return false;
    page.loading = data.loading;
    page.canGoBack = data.canGoBack;
    page.canGoForward = data.canGoForward;
    return true;
  }
  if (data.type === 'pickingStateChanged' && typeof data.picking === 'boolean') {
    if (data.picking === page.picking) return false;
    page.picking = data.picking;
    return true;
  }
  return false;
}

// Where a chat's browser pages show: the editor's browser tabs (browser-tabs.ts), which own every page view's placement.
export interface PagesHost {
  pageAdded(page: DesktopPanel): void;
  pageRemoved(page: DesktopPanel): void;
  pageChanged(page: DesktopPanel): void;
  pageRevealed(page: DesktopPanel): void;
  chatSelected(chat: DesktopPanel | undefined): void;
  chatClosed(chat: DesktopPanel): void;
}

// The localized text main builds the error and browser pages with.
export interface PageStrings {
  readonly error: ErrorPageStrings;
  readonly browser: BrowserPageStrings;
}

interface PanelViewsDeps {
  readonly window: BrowserWindow;
  // the root holding dist/webview and resources, which a chat page loads its bundle and logo from
  readonly resourceRoot: string;
  readonly pageStrings: () => PageStrings;
  // the host of a remote chat's authority as this computer's host store names it, never as its core does; undefined for a local chat
  readonly hostLabel: (authority: string) => PanelHostLabel | undefined;
  readonly preloadPath: string;
  readonly states: PanelStateStore;
  readonly pages: PagesHost;
  readonly log: (line: string) => void;
  // A chat was added, removed or selected, its project may have changed, or a page was added or removed.
  readonly onChange: () => void;
  // A view was added; the overlay restacks above it.
  readonly onRestack: () => void;
  // core revealed a chat (a host dialog, a file shown to it); the owner selects it
  readonly onReveal: (chat: DesktopPanel) => void;
  // The chat's page crashed more than MAX_CRASHES_IN_WINDOW times within CRASH_WINDOW_MS and is left dead.
  readonly onRendererGaveUp: (panel: DesktopPanel) => void;
  // The stored session a chat's saved state names changed.
  readonly onSavedSessionChange: (chat: DesktopPanel) => void;
  // An overlay popup is open, and so holds keyboard focus.
  readonly popupOpen: () => boolean;
}

// true moves keyboard focus into the chat's page now (once it commits); 'whenReady' once, when its page is ready in the focused
// window, unless the user's input comes first; false leaves focus where it is.
export type ShowFocus = boolean | 'whenReady';

export interface CreatePanelRequest {
  readonly options: PanelOptions;
  // present when restoring a persisted panel
  readonly restore?: { readonly panelId: string; readonly state: unknown };
  // the id core issued for a panel it created
  readonly panelId?: string;
  // the authority whose core serves the panel; absent for the local core
  readonly authority?: string;
}

export class DesktopPanel implements PanelHost {
  readonly panelId: string;
  readonly kind: PanelOptions['kind'];
  // 'local', or the authority key of the remote core serving the panel; only a local chat persists to panels.json
  readonly authority: string;
  readonly pageUrl: string;
  // Monaco's workers load from the built webview assets; only a chat renders editors.
  readonly workerSrc?: string;
  readonly view: WebContentsView;
  html: string | undefined;
  title: string;
  // browser pages only: the chat that owns the page, and what its editor tab shows about it
  readonly chat: DesktopPanel | undefined;
  readonly page: ObservedPage | undefined;
  iconDataUrl: string | undefined;
  private iconRequest = 0;
  private state: unknown;
  private disposed = false;
  private crashes: number[] = [];
  private readonly messages = new Listeners<[unknown]>();
  private readonly disposes = new Listeners<[]>();
  private readonly viewStates = new Listeners<[]>();
  private readonly ipcHandlers: Array<[string, (event: IpcMainEvent, ...args: unknown[]) => void]> = [];
  private readonly owner: PanelViews;
  private readonly deps: PanelViewsDeps;

  constructor(owner: PanelViews, deps: PanelViewsDeps, request: CreatePanelRequest, chat: DesktopPanel | undefined) {
    this.owner = owner;
    this.deps = deps;
    this.panelId = request.restore?.panelId ?? request.panelId ?? randomUUID();
    this.kind = request.options.kind;
    this.authority = request.authority ?? chat?.authority ?? 'local';
    this.title = request.options.title;
    this.state = request.restore?.state ?? null;
    this.chat = chat;
    this.page = this.kind === 'browser' ? { url: '', loading: false, canGoBack: false, canGoForward: false, picking: false } : undefined;
    this.pageUrl = panelPageUrl(this.panelId);
    if (this.kind === 'chat') this.workerSrc = CHAT_WORKER_SRC;
    this.view = new WebContentsView({
      webPreferences: {
        preload: deps.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        // Electron focuses a WebContents when it navigates; a chat or page loading must leave focus where it is.
        focusOnNavigation: false,
      },
    });
    registerPanelContents(this.view.webContents);
    this.view.setBackgroundColor(THEME_BACKGROUND[currentThemeKind()]);
    this.view.setVisible(false);

    this.onIpc(PANEL_CHANNELS.init, (event) => {
      const host = this.authority === 'local' ? undefined : deps.hostLabel(this.authority);
      const init: PanelInit = { state: this.state, theme: currentTheme(), ...(host ? { host } : {}) };
      event.returnValue = init;
    }, (event) => { event.returnValue = null; });
    this.onIpc(PANEL_CHANNELS.post, (_event, payload) => {
      const message = asJsonValue(payload, MAX_MESSAGE_JSON_CHARS)?.value;
      if (!isWebviewMessage(message)) {
        deps.log(`[views] panel ${this.panelId}: dropped a malformed webview message`);
        return;
      }
      this.messages.fire(message);
    });
    this.onIpc(PANEL_CHANNELS.setState, (_event, payload) => {
      const normalized = asJsonValue(payload, MAX_STATE_JSON_CHARS);
      const state = normalized?.value;
      if (!normalized || !isWebviewState(state)) {
        deps.log(`[views] panel ${this.panelId}: dropped a malformed webview state`);
        return;
      }
      const savedSession = this.savedSessionId;
      this.state = state ?? null;
      // A page's address persists from what core reports (observePageMessage), never from the page renderer.
      if (this.kind !== 'chat') return;
      if (this.persists) deps.states.set({ panelId: this.panelId, state: this.state });
      if (this.savedSessionId !== savedSession) deps.onSavedSessionChange(this);
    });

    const contents = this.view.webContents;
    contents.on('did-navigate', () => owner.committed(this));
    contents.on('dom-ready', () => owner.domReady(this));
    contents.on('render-process-gone', (_event, details) => {
      deps.log(`[views] panel ${this.panelId} renderer gone (${details.reason})`);
      if (this.disposed || details.reason === 'clean-exit') return;
      const now = Date.now();
      this.crashes = [...this.crashes.filter((at) => now - at < CRASH_WINDOW_MS), now];
      if (this.crashes.length > MAX_CRASHES_IN_WINDOW) {
        deps.log(`[views] panel ${this.panelId} crashed ${this.crashes.length} times within ${CRASH_WINDOW_MS / 1000} s; not recreating it`);
        deps.onRendererGaveUp(this);
        return;
      }
      this.load();
    });
    if (this.persists) deps.states.set({ panelId: this.panelId, state: this.state });
  }

  // A remote chat is kept in remote-state.json instead, which an older version never misreads.
  private get persists(): boolean {
    return this.kind === 'chat' && this.authority === 'local';
  }

  // The token the chat's page keeps in its state (its `ready.panelToken`), which a rejoin names it by.
  get panelToken(): string | undefined {
    const state = this.state;
    if (typeof state !== 'object' || state === null || !Object.hasOwn(state, 'panelToken')) return undefined;
    const token = (state as { panelToken: unknown }).panelToken;
    return typeof token === 'string' && token !== '' ? token : undefined;
  }

  get closeReason(): 'user' | 'detach' {
    return this.owner.retaining(this) ? 'detach' : 'user';
  }

  get webContents(): WebContents {
    return this.view.webContents;
  }

  get visible(): boolean {
    return !this.disposed && this.view.getVisible();
  }

  get active(): boolean {
    return this.visible && this.deps.window.isFocused();
  }

  // A hidden view keeps its page running.
  get retainsContextWhenHidden(): boolean {
    return true;
  }

  get column(): number | undefined {
    return undefined;
  }

  get cspSource(): string {
    return APP_ORIGIN;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  // The stored session the chat's saved state names, which its webview's `ready` asks core to restore.
  get savedSessionId(): string | undefined {
    const state = this.state;
    if (this.kind !== 'chat' || typeof state !== 'object' || state === null || !Object.hasOwn(state, 'sessionId')) return undefined;
    const sessionId = (state as { sessionId: unknown }).sessionId;
    return typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined;
  }

  // A restore its lease refused waits to retry (ChatEntry.restoring) while the page shows an empty chat: the saved state names
  // that session again, so the next core restores it if this one ends first.
  keepRestoreTarget(sessionId: string): void {
    if (this.kind !== 'chat' || this.disposed || this.savedSessionId === sessionId) return;
    const base = typeof this.state === 'object' && this.state !== null && !Array.isArray(this.state) ? this.state : {};
    this.state = { ...base, sessionId };
    if (this.persists) this.deps.states.set({ panelId: this.panelId, state: this.state });
  }

  // The folder key the chat's saved state names, which core restores it into.
  get savedFolderKey(): string | undefined {
    return restoredWorkspaceFolderKey(this.state);
  }

  themeCssSource(): string {
    return currentTheme().css;
  }

  // PanelHost's, which only the VS Code host serves: no HTML a core produced is loaded here.
  setHtml(): void {
    throw new Error('A desktop page is built by main (showPage)');
  }

  showPage(page: PageSpec): void {
    this.html = this.owner.pageHtml(this, page);
    this.load();
  }

  // A message holding binary (a browser page's frame), sent as a structured clone.
  postMessage(message: unknown): Promise<boolean> {
    return Promise.resolve(this.send(message));
  }

  // A core message as JSON text, forwarded unparsed: the panel preload parses it.
  postJson(type: string, json: string): void {
    // A folder update may move the chat to another project.
    if (this.kind === 'chat' && type === 'workspaceFolderUpdate') this.owner.changed();
    if (this.page && PAGE_STATE_TYPES.has(type) && observePageMessage(this.page, JSON.parse(json))) this.owner.pageChanged(this);
    this.send(json);
  }

  // A crashed renderer has no frame to receive it; the reload's ready replays what the page needs.
  private send(payload: unknown): boolean {
    if (this.disposed || this.webContents.isDestroyed() || this.webContents.isCrashed()) return false;
    this.webContents.send(PANEL_CHANNELS.message, payload);
    return true;
  }

  // A browser tab action on this page, delivered to core as the webview message its own toolbar would post.
  deliver(message: { readonly type: string; readonly url?: string }): void {
    if (!this.disposed) this.messages.fire(message);
  }

  sendTheme(theme: PanelTheme): void {
    this.view.setBackgroundColor(THEME_BACKGROUND[theme.kind]);
    if (!this.webContents.isDestroyed() && !this.webContents.isCrashed()) this.webContents.send(PANEL_CHANNELS.theme, theme);
  }

  onMessage(listener: (message: unknown) => void): Disposable {
    return this.messages.add(listener);
  }

  onDispose(listener: () => void): Disposable {
    return this.disposes.add(listener);
  }

  onDidChangeViewState(listener: () => void): Disposable {
    return this.viewStates.add(listener);
  }

  fireViewState(): void {
    this.viewStates.fire();
  }

  asResourceUri(absolutePath: string): string {
    return this.owner.resourceUri(absolutePath);
  }

  // Only a browser page shows an icon (its favicon, on its editor tab).
  setIcon(iconPath: string | undefined): void {
    if (this.kind !== 'browser') return;
    const request = ++this.iconRequest;
    const apply = (url: string | undefined): void => {
      if (request !== this.iconRequest || this.disposed || url === this.iconDataUrl) return;
      this.iconDataUrl = url;
      this.owner.pageChanged(this);
    };
    if (iconPath === undefined) {
      apply(undefined);
      return;
    }
    iconDataUrl(iconPath).then(apply, (err: unknown) => {
      this.deps.log(`[views] panel ${this.panelId}: could not read its icon: ${err instanceof Error ? err.message : String(err)}`);
      apply(undefined);
    });
  }

  setTitle(title: string): void {
    if (title === this.title) return;
    this.title = title;
    if (this.page) this.owner.pageChanged(this);
    else this.owner.changed();
  }

  // The shell shows every chat under its project, so the folder label adds nothing here.
  setFolderLabel(): void {}

  // A chat is selected and focused; a browser page becomes its chat's active tab and takes no focus.
  reveal(): void {
    if (this.disposed) return;
    if (this.chat) this.owner.revealPage(this);
    else this.owner.reveal(this);
  }

  // After the page gave up crashing, at the user's request: a fresh crash budget and a new load.
  restart(): void {
    if (this.disposed) return;
    this.crashes = [];
    this.load();
  }

  close(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (!this.webContents.isDestroyed()) for (const [channel, handler] of this.ipcHandlers) this.webContents.ipc.removeListener(channel, handler);
    this.owner.removed(this);
    if (!this.webContents.isDestroyed()) this.webContents.close();
    this.disposes.fire();
    this.messages.clear();
    this.disposes.clear();
    this.viewStates.clear();
  }

  private load(): void {
    if (this.html === undefined || this.webContents.isDestroyed()) return;
    loadAppPage(this.webContents, this.pageUrl).catch((err: unknown) => {
      this.deps.log(`[views] panel ${this.panelId} failed to load: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private onIpc(
    channel: string,
    handler: (event: IpcMainEvent, payload: unknown) => void,
    onRejected?: (event: IpcMainEvent) => void,
  ): void {
    // webContents.ipc receives only this view's messages; the sender check still pins them to its main frame and page.
    const guarded = (event: IpcMainEvent, ...args: unknown[]): void => {
      if (!isPanelSender(event, this.webContents, this.pageUrl)) {
        this.deps.log(`[views] panel ${this.panelId}: rejected ${channel} from ${event.senderFrame ? loggableUrl(event.senderFrame.url) : 'a destroyed frame'} (webContents ${event.sender.id})`);
        onRejected?.(event);
        return;
      }
      handler(event, args[0]);
    };
    this.webContents.ipc.on(channel, guarded);
    this.ipcHandlers.push([channel, guarded]);
  }
}

/**
 * One WebContentsView per loaded chat, placed on the chat slot rectangle the shell reports; only the selected chat is
 * visible. A chat's browser pages are views it owns, which its editor tabs place (PagesHost). A page view never takes
 * keyboard focus from main.
 */
export class PanelViews {
  private readonly panels = new Map<string, DesktopPanel>();
  // loaded chats in load order; browser pages belong to their chat
  private order: string[] = [];
  private selectedId: string | undefined;
  // A chat asked to take keyboard focus before its page committed, whose renderer would drop it: it takes focus once committed
  // in a focused window, unless focus went anywhere else first; the window's own page taking focus as the window activates
  // does not count.
  private focusOnCommit: { readonly panel: DesktopPanel; committed: boolean } | undefined;
  private windowActive = false;
  // The chat a launch shows, which takes keyboard focus once. Only the user's input, another selection or focus main gives
  // drops it, never a focus change: the window's activation focuses the window's own page.
  private launchFocus: { readonly panel: DesktopPanel; ready: boolean } | undefined;
  private retainStates = false;
  // remote authorities whose chats close with their states kept while their core is replaced
  private readonly retainedAuthorities = new Set<string>();
  // DIP rectangle of the chat slot; undefined until the shell first reports it
  private contentBounds: Rectangle | undefined;
  // The editor's focus overlay covers the window, so the chat view hides under the shell's scrim.
  private focusOverlay = false;
  private readonly deps: PanelViewsDeps;
  private readonly resourceUriFor: (absolutePath: string) => string;

  constructor(deps: PanelViewsDeps, resourceUri: (absolutePath: string) => string) {
    this.deps = deps;
    this.resourceUriFor = resourceUri;
    const window = deps.window;
    window.on('resize', () => this.layout());
    onWindowActivated(window, () => {
      this.windowActive = true;
      this.takeLaunchFocus();
      this.takeCommitFocus();
    });
    onWindowDeactivated(window, () => {
      this.windowActive = false;
    });
    window.on('focus', () => this.selected()?.fireViewState());
    window.on('blur', () => this.selected()?.fireViewState());
  }

  // A browser page must name its loaded chat as owner. A chat is created hidden; the caller selects it. A restored
  // chat lays out when first shown: Chromium sends a view's size to its page only once the view has been visible.
  create(request: CreatePanelRequest): DesktopPanel {
    // A closing window, a quit or a core reload closes every chat with its state kept; nothing may open in between.
    if (this.retainStates || this.retainedAuthorities.has(request.authority ?? 'local')) throw new Error('The chats are closing');
    // A restored id comes from panels.json, an issued one from core; either names the page URL and the panels map.
    const named = request.restore?.panelId ?? request.panelId;
    if (named !== undefined && !isPanelId(named)) throw new Error(`Panel id ${JSON.stringify(named.slice(0, 64))} has characters a page URL cannot carry`);
    if (named !== undefined && this.panels.has(named)) throw new Error(`Panel ${named} is already open`);
    if (request.options.kind === 'browser') return this.createPage(request);
    const panel = new DesktopPanel(this, this.deps, request, undefined);
    this.panels.set(panel.panelId, panel);
    this.order.push(panel.panelId);
    this.deps.window.contentView.addChildView(panel.view);
    this.deps.onRestack();
    this.deps.onChange();
    return panel;
  }

  htmlFor(panelId: string): string | undefined {
    return this.panels.get(panelId)?.html;
  }

  panel(panelId: string): DesktopPanel | undefined {
    return this.panels.get(panelId);
  }

  // loaded chats in load order
  panelIds(): readonly string[] {
    return [...this.order];
  }

  // In load order.
  chats(): readonly DesktopPanel[] {
    return this.order.flatMap((panelId) => this.panels.get(panelId) ?? []);
  }

  selected(): DesktopPanel | undefined {
    return this.selectedId === undefined ? undefined : this.panels.get(this.selectedId);
  }

  show(panelId: string, options: { readonly focus: ShowFocus }): void {
    const next = this.panels.get(panelId);
    if (!next || next.chat) return;
    this.launchFocus = undefined;
    const previous = this.selected();
    this.selectedId = panelId;
    if (previous && previous !== next) {
      previous.view.setVisible(false);
      previous.fireViewState();
    }
    next.view.setVisible(true);
    this.layout();
    this.deps.pages.chatSelected(next);
    if (options.focus === true) this.focus(next);
    else if (options.focus === 'whenReady') this.launchFocus = { panel: next, ready: false };
    next.fireViewState();
    this.deps.onChange();
  }

  // A chat core reveals is selected through the owner, which tracks the selected project.
  reveal(chat: DesktopPanel): void {
    this.deps.onReveal(chat);
  }

  setContentBounds(bounds: Rectangle): void {
    this.contentBounds = bounds;
    this.layout();
  }

  setFocusOverlay(open: boolean): void {
    if (this.focusOverlay === open) return;
    this.focusOverlay = open;
    this.layout();
  }

  broadcastTheme(theme: PanelTheme): void {
    this.deps.window.setBackgroundColor(THEME_BACKGROUND[theme.kind]);
    for (const panel of this.panels.values()) panel.sendTheme(theme);
  }

  // Chats closed while the host tears down keep their persisted state, so the next start restores them.
  retainStatesOnClose(retain: boolean): void {
    this.retainStates = retain;
  }

  get retainingStates(): boolean {
    return this.retainStates;
  }

  // A remote authority's chats close with their states kept while its core is replaced; the local ones are unaffected.
  retainAuthorityOnClose(authority: string, retain: boolean): void {
    if (retain) this.retainedAuthorities.add(authority);
    else this.retainedAuthorities.delete(authority);
  }

  retaining(panel: DesktopPanel): boolean {
    return this.retainingAuthority(panel.authority);
  }

  retainingAuthority(authority: string): boolean {
    return this.retainStates || this.retainedAuthorities.has(authority);
  }

  // The kind is checked against the panel's own: a chat shows the chat or error page, a browser page its toolbar or none.
  pageHtml(panel: DesktopPanel, page: PageSpec): string {
    const uri = (...parts: string[]): string => this.resourceUriFor(path.join(this.deps.resourceRoot, ...parts));
    const themeCss = currentTheme().css;
    if (panel.kind === 'chat' && page.kind === 'chat') {
      return chatPageHtml({
        cspSource: APP_ORIGIN,
        workerSrc: CHAT_WORKER_SRC,
        nonce: randomBytes(16).toString('base64'),
        scriptUri: uri('dist', 'webview', 'assets', 'index.js'),
        styleUri: uri('dist', 'webview', 'assets', 'index.css'),
        logoUri: uri('resources', 'icon.png'),
        themeCss,
      });
    }
    if (panel.kind === 'chat' && page.kind === 'error') {
      return errorPageHtml({ cspSource: APP_ORIGIN, logoUri: uri('resources', 'icon.png'), themeCss, strings: this.deps.pageStrings().error });
    }
    if (panel.kind === 'browser' && page.kind === 'browser' && typeof page.toolbar === 'boolean') {
      return browserPageHtml({ nonce: randomBytes(16).toString('base64'), strings: this.deps.pageStrings().browser, toolbar: page.toolbar, themeCss });
    }
    throw new Error(`A ${panel.kind} panel cannot show a ${String((page as { kind?: unknown }).kind)} page`);
  }

  resourceUri(absolutePath: string): string {
    return this.resourceUriFor(absolutePath);
  }

  changed(): void {
    this.deps.onChange();
  }

  chatFocused(): boolean {
    return this.selected()?.webContents.isFocused() ?? false;
  }

  focusChat(): void {
    const selected = this.selected();
    if (selected) this.focus(selected);
  }

  // Electron focuses the window's own page before it reports the window's 'focus' (activation-focus.ts).
  focused(contents: WebContents): void {
    if (!this.focusOnCommit || this.focusOnCommit.panel.webContents === contents) return;
    if (contents === this.deps.window.webContents && !this.windowActive) return;
    this.focusOnCommit = undefined;
  }

  // A key pressed or a button pressed in any of the app's pages, as main observed it.
  userInput(): void {
    this.launchFocus = undefined;
  }

  domReady(panel: DesktopPanel): void {
    if (this.launchFocus?.panel !== panel) return;
    this.launchFocus.ready = true;
    this.takeLaunchFocus();
  }

  committed(panel: DesktopPanel): void {
    if (this.focusOnCommit?.panel !== panel) return;
    this.focusOnCommit.committed = true;
    this.takeCommitFocus();
  }

  // X11 activates a window only after the focus that asked for it, and the activation focuses the window's own page.
  private takeCommitFocus(): void {
    const pending = this.focusOnCommit;
    if (!pending?.committed || !this.deps.window.isFocused() || this.deps.window.isMinimized()) return;
    this.focusOnCommit = undefined;
    if (this.selected() === pending.panel) pending.panel.webContents.focus();
  }

  // A popup open meanwhile keeps focus, and returns it where it was when it closes.
  private takeLaunchFocus(): void {
    const launch = this.launchFocus;
    if (!launch?.ready || !this.deps.window.isFocused() || this.deps.window.isMinimized()) return;
    this.launchFocus = undefined;
    if (this.selected() === launch.panel && !this.deps.popupOpen()) launch.panel.webContents.focus();
  }

  private focus(panel: DesktopPanel): void {
    this.launchFocus = undefined;
    this.focusOnCommit = undefined;
    if (panel.webContents.getURL() === '') this.focusOnCommit = { panel, committed: false };
    else panel.webContents.focus();
  }

  revealPage(page: DesktopPanel): void {
    this.deps.pages.pageRevealed(page);
  }

  pageChanged(page: DesktopPanel): void {
    this.deps.pages.pageChanged(page);
  }

  removed(panel: DesktopPanel): void {
    this.panels.delete(panel.panelId);
    if (!this.deps.window.isDestroyed()) this.deps.window.contentView.removeChildView(panel.view);
    if (panel.chat) {
      this.deps.pages.pageRemoved(panel);
      this.deps.onChange();
      return;
    }
    const index = this.order.indexOf(panel.panelId);
    if (index >= 0) this.order.splice(index, 1);
    if (!this.retaining(panel) && panel.authority === 'local') this.deps.states.delete(panel.panelId);
    if (this.selectedId === panel.panelId) this.selectedId = undefined;
    this.deps.pages.chatClosed(panel);
    this.deps.onChange();
  }

  private createPage(request: CreatePanelRequest): DesktopPanel {
    const owner = request.options.owner;
    const chat = [...this.panels.values()].find((panel) => panel === owner && panel.kind === 'chat');
    if (!chat) throw new Error('A browser page opens only in a loaded chat');
    const page = new DesktopPanel(this, this.deps, request, chat);
    this.panels.set(page.panelId, page);
    this.deps.window.contentView.addChildView(page.view);
    this.deps.onRestack();
    this.deps.pages.pageAdded(page);
    this.deps.onChange();
    return page;
  }

  private area(): Rectangle | undefined {
    if (this.deps.window.isDestroyed()) return undefined;
    const { width, height } = this.deps.window.getContentBounds();
    const reported = this.contentBounds ?? { x: 0, y: 0, width, height };
    // The shell's report can lag a resize by a frame, so a view never extends past the window.
    const x = Math.min(reported.x, width);
    const y = Math.min(reported.y, height);
    return { x, y, width: Math.min(reported.width, width - x), height: Math.min(reported.height, height - y) };
  }

  // An empty chat slot (a maximized editor fills the grid) or the focus overlay hides the chat view, so neither the eye nor
  // a screen reader finds it under them.
  private layout(): void {
    const chat = this.selected();
    if (!chat) return;
    const area = this.area();
    const shown = !this.focusOverlay && area !== undefined && area.width > 0 && area.height > 0;
    if (shown) chat.view.setBounds(area);
    if (chat.view.getVisible() === shown) return;
    chat.view.setVisible(shown);
    chat.fireViewState();
  }
}
