import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { WebContentsView, type BrowserWindow, type IpcMainEvent, type Rectangle, type WebContents } from 'electron';
import type { Disposable } from '../../platform/disposable';
import type { PanelHost, PanelOptions } from '../../platform/window-service';
import { PANEL_CHANNELS, type PanelInit, type PanelTheme } from '../preload/panel-channels';
import { MAX_PANE_URL_LENGTH, type PaneLocale, type PanePage, type PanePlatform, type PaneState } from '../preload/pane-channels';
import { DEFAULT_PANE_WIDTH, paneLayout, type PaneLayout } from './pane-layout';
import { PaneHost, type PaneActions } from './pane';
import type { PanelStateStore, PersistedPane } from './panel-state-store';
import { APP_ORIGIN, panelPageUrl } from './protocol';
import { isHttpUrl, loadAppPage, loggableUrl, registerPanelContents } from './security';
import { currentTheme, currentThemeKind } from './theme';
import { ChatTabTitle } from './tab-title';

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

export const THEME_BACKGROUND = { dark: '#1f1f1f', light: '#ffffff' } as const;

// CSP worker-src of a chat tab: the directory the app:// handler serves the built webview assets from (protocol.ts SERVED_ROOTS).
export const CHAT_WORKER_SRC: string = `${APP_ORIGIN}/webview/assets/`;

// A favicon larger than this is not inlined into the pane state that is resent on every change.
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

/** The data: URL of an icon file, or undefined for an unknown type or a file over MAX_ICON_BYTES. */
export async function iconDataUrl(iconPath: string): Promise<string | undefined> {
  const mime = ICON_MIME_TYPES[path.extname(iconPath).toLowerCase()];
  if (mime === undefined) return undefined;
  const stat = await fs.stat(iconPath);
  if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return undefined;
  return `data:${mime};base64,${(await fs.readFile(iconPath)).toString('base64')}`;
}

function restoredTitle(state: unknown): { sessionId?: string; sessionName?: string } {
  const raw = (state ?? {}) as { sessionId?: unknown; sessionName?: unknown };
  return {
    ...(typeof raw.sessionId === 'string' ? { sessionId: raw.sessionId } : {}),
    ...(typeof raw.sessionName === 'string' ? { sessionName: raw.sessionName } : {}),
  };
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

// The page state the pane shows, read from the host messages core posts to the page (urlChanged, navigationState,
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

// One chat tab's browser pane.
export interface ChatPane {
  // pane order
  pages: DesktopPanel[];
  activePageId: string | undefined;
  open: boolean;
  maximized: boolean;
  // Pages restored after a restart arrive while this is set and do not open the pane themselves.
  restoring: boolean;
}

// What the pane shows beyond the views: host facts main's entry point owns.
export interface PaneContext {
  readonly locale: PaneLocale;
  readonly platform: PanePlatform;
  readonly toggleShortcutLabel: string;
  browserEnabled(): boolean;
  // opens a blank page beside the chat tab (core refuses it while the browser is disabled)
  newPage(chat: DesktopPanel): Promise<void>;
  // ShellService.openExternal, which opens only canonical http and https
  openExternal(url: string): Promise<boolean>;
}

interface PanelViewsDeps {
  readonly window: BrowserWindow;
  readonly preloadPath: string;
  readonly panePreloadPath: string;
  readonly states: PanelStateStore;
  readonly log: (line: string) => void;
  // A tab was added, removed, moved, selected, its title or busy state changed, or its pane changed.
  readonly onChange: () => void;
  // The tab's page crashed more than MAX_CRASHES_IN_WINDOW times within CRASH_WINDOW_MS and is left dead.
  readonly onRendererGaveUp: (panel: DesktopPanel) => void;
  // The pane page crashed the same way.
  readonly onPaneGaveUp: () => void;
  readonly paneContext: () => PaneContext;
}

export interface CreatePanelRequest {
  readonly options: PanelOptions;
  // present when restoring a persisted panel
  readonly restore?: { readonly panelId: string; readonly state: unknown };
}

export class DesktopPanel implements PanelHost {
  readonly panelId: string;
  readonly kind: PanelOptions['kind'];
  readonly pageUrl: string;
  // Monaco's workers load from the built webview assets; only a chat tab renders editors.
  readonly workerSrc?: string;
  readonly view: WebContentsView;
  html: string | undefined;
  title: string;
  // chat tabs only
  readonly chatTitle: ChatTabTitle | undefined;
  readonly pane: ChatPane | undefined;
  // browser pages only: the chat tab whose pane shows the page, and what the pane shows about it
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

  constructor(owner: PanelViews, deps: PanelViewsDeps, request: CreatePanelRequest, chat: DesktopPanel | undefined, pane: PersistedPane | undefined) {
    this.owner = owner;
    this.deps = deps;
    this.panelId = request.restore?.panelId ?? randomUUID();
    this.kind = request.options.kind;
    this.title = request.options.title;
    this.state = request.restore?.state ?? null;
    this.chatTitle = this.kind === 'chat' ? new ChatTabTitle(restoredTitle(this.state)) : undefined;
    this.pane = this.kind === 'chat'
      ? { pages: [], activePageId: undefined, open: pane?.open ?? false, maximized: pane?.maximized ?? false, restoring: false }
      : undefined;
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
        // Electron focuses a WebContents when it navigates; a page loading in the pane must leave focus in the composer.
        ...(this.kind === 'browser' ? { focusOnNavigation: false } : {}),
      },
    });
    registerPanelContents(this.view.webContents);
    this.view.setBackgroundColor(THEME_BACKGROUND[currentThemeKind()]);
    this.view.setVisible(false);

    this.onIpc(PANEL_CHANNELS.init, (event) => {
      const init: PanelInit = { state: this.state, theme: currentTheme() };
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
      this.state = state ?? null;
      // A page's address persists from what core reports (observePageMessage), never from the page renderer.
      if (this.kind === 'chat') deps.states.set({ panelId: this.panelId, state: this.state });
    });

    const contents = this.view.webContents;
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
    if (this.kind === 'chat') deps.states.set({ panelId: this.panelId, state: this.state });
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

  get column(): number | undefined {
    return undefined;
  }

  get cspSource(): string {
    return APP_ORIGIN;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  themeCssSource(): string {
    return currentTheme().css;
  }

  setHtml(html: string): void {
    this.html = html;
    this.load();
  }

  postMessage(message: unknown): Promise<boolean> {
    // A crashed renderer has no frame to receive it; the reload's ready replays what the page needs.
    // A folder update may move the tab to another project, which the tab strip labels.
    if (this.chatTitle?.observe(message) || (message as { type?: unknown } | null)?.type === 'workspaceFolderUpdate') this.owner.changed();
    if (this.page && observePageMessage(this.page, message)) this.owner.pageChanged(this);
    if (this.disposed || this.webContents.isDestroyed() || this.webContents.isCrashed()) return Promise.resolve(false);
    this.webContents.send(PANEL_CHANNELS.message, message);
    return Promise.resolve(true);
  }

  // A pane action on this page, delivered to core as the webview message its own toolbar would post.
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

  // Only a browser page shows an icon (its favicon, in the pane's page tab); the shell draws the chat tab icon itself.
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

  // The shell labels every tab with its project, so the folder label adds nothing here.
  setFolderLabel(): void {}

  // A chat tab is selected and focused; a browser page is selected in its chat's pane, which opens, and takes no focus.
  reveal(): void {
    if (this.disposed) return;
    if (this.chat) this.owner.revealPage(this);
    else this.owner.show(this.panelId, { focus: true });
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

/** The pane state of one chat tab, bounded for the pane view. */
export function paneSnapshot(chat: DesktopPanel | undefined, layout: PaneLayout, context: PaneContext): PaneState {
  const pages = chat?.pane?.pages.map((page): PanePage => ({
    id: page.panelId,
    title: page.title,
    url: page.page?.url.slice(0, MAX_PANE_URL_LENGTH) ?? '',
    ...(page.iconDataUrl !== undefined ? { iconDataUrl: page.iconDataUrl } : {}),
    loading: page.page?.loading ?? false,
    canGoBack: page.page?.canGoBack ?? false,
    canGoForward: page.page?.canGoForward ?? false,
    picking: page.page?.picking ?? false,
  })) ?? [];
  const activePageId = chat?.pane?.activePageId;
  return {
    locale: context.locale,
    platform: context.platform,
    browserEnabled: context.browserEnabled(),
    toggleShortcutLabel: context.toggleShortcutLabel,
    ...(chat ? { chatTabId: chat.panelId } : {}),
    mode: layout.mode,
    width: layout.width,
    minWidth: layout.minWidth,
    maxWidth: layout.maxWidth,
    pages,
    ...(activePageId !== undefined ? { activePageId } : {}),
  };
}

/**
 * One WebContentsView per chat tab, placed in the content rectangle the shell reports; only the selected tab is visible.
 * Each chat tab has a browser pane: its pages are views owned by the tab, drawn in the one pane view's page rectangle,
 * stacked chat < pane < active page. A page view never takes keyboard focus from main.
 */
export class PanelViews {
  private readonly panels = new Map<string, DesktopPanel>();
  // chat tabs in strip order; browser pages are in their chat's pane
  private order: string[] = [];
  private selectedId: string | undefined;
  private retainStates = false;
  private focusFallbackOnClose = true;
  // DIP rectangle of the content area; undefined until the shell first reports it
  private contentBounds: Rectangle | undefined;
  // Every chat tab's pane width, divider included; the layout clamps it to the window without rewriting it.
  private paneWidth: number;
  // The layout numbers the pane view last got, so a layout that changes them (a resize into overlay) pushes a state.
  private shownLayout = '';
  private readonly paneHost: PaneHost;
  private readonly deps: PanelViewsDeps;
  private readonly resourceUriFor: (absolutePath: string) => string;

  constructor(deps: PanelViewsDeps, resourceUri: (absolutePath: string) => string) {
    this.deps = deps;
    this.resourceUriFor = resourceUri;
    this.paneWidth = deps.states.paneWidth() ?? DEFAULT_PANE_WIDTH;
    this.paneHost = new PaneHost(deps.panePreloadPath, this.paneActions(), deps.log, deps.onPaneGaveUp);
    const window = deps.window;
    window.contentView.addChildView(this.paneHost.view);
    window.on('resize', () => this.layout());
    window.on('focus', () => this.selected()?.fireViewState());
    window.on('blur', () => this.selected()?.fireViewState());
    this.paneHost.load();
  }

  get pane(): PaneHost {
    return this.paneHost;
  }

  // A browser page must name its open chat tab as owner; a chat tab is selected and focused, as a new tab is.
  create(request: CreatePanelRequest): DesktopPanel {
    if (request.restore && this.panels.has(request.restore.panelId)) throw new Error(`Panel ${request.restore.panelId} is already open`);
    if (request.options.kind === 'browser') return this.createPage(request);
    const persisted = request.restore ? this.deps.states.get(request.restore.panelId)?.pane : undefined;
    const panel = new DesktopPanel(this, this.deps, request, undefined, persisted);
    this.panels.set(panel.panelId, panel);
    this.order.push(panel.panelId);
    this.deps.window.contentView.addChildView(panel.view);
    this.show(panel.panelId, { focus: true });
    return panel;
  }

  htmlFor(panelId: string): string | undefined {
    return this.panels.get(panelId)?.html;
  }

  panel(panelId: string): DesktopPanel | undefined {
    return this.panels.get(panelId);
  }

  // chat tabs in strip order
  panelIds(): readonly string[] {
    return [...this.order];
  }

  // In strip order.
  tabs(): readonly DesktopPanel[] {
    return this.order.flatMap((panelId) => this.panels.get(panelId) ?? []);
  }

  selected(): DesktopPanel | undefined {
    return this.selectedId === undefined ? undefined : this.panels.get(this.selectedId);
  }

  // The selected chat tab's active page while its pane is open.
  activePage(): DesktopPanel | undefined {
    const pane = this.selected()?.pane;
    if (!pane?.open || pane.activePageId === undefined) return undefined;
    return this.panels.get(pane.activePageId);
  }

  // focus moves keyboard focus into the tab's page, or into its pane when the pane is maximized over the chat;
  // without it focus stays where it is, as after a close from the tab strip.
  show(panelId: string, options: { readonly focus: boolean }): void {
    const next = this.panels.get(panelId);
    if (!next?.pane) return;
    const previous = this.selected();
    this.selectedId = panelId;
    if (previous && previous !== next) {
      previous.view.setVisible(false);
      previous.fireViewState();
    }
    next.view.setVisible(true);
    this.layout();
    this.restack();
    if (options.focus) {
      if (next.pane.open && next.pane.maximized) this.paneHost.focus();
      else next.webContents.focus();
    }
    next.fireViewState();
    this.deps.states.select(panelId);
    this.paneHost.stateChanged();
    this.deps.onChange();
  }

  // delta 1 selects the next tab, -1 the previous one, wrapping around.
  selectRelative(delta: 1 | -1): void {
    if (this.order.length === 0) return;
    const current = this.selectedId === undefined ? -1 : this.order.indexOf(this.selectedId);
    const target = this.order[(current + delta + this.order.length) % this.order.length];
    if (target !== undefined) this.show(target, { focus: true });
  }

  // A close made in the tab strip leaves keyboard focus there, so a keyboard user can close tab after tab.
  close(panelId: string, options: { readonly focusFallback: boolean }): void {
    const panel = this.panels.get(panelId);
    if (!panel) return;
    this.focusFallbackOnClose = options.focusFallback;
    try {
      panel.close();
    } finally {
      this.focusFallbackOnClose = true;
    }
  }

  move(panelId: string, toIndex: number): void {
    const from = this.order.indexOf(panelId);
    if (from < 0 || toIndex < 0 || toIndex >= this.order.length || from === toIndex) return;
    this.order.splice(from, 1);
    this.order.splice(toIndex, 0, panelId);
    this.deps.states.reorder(this.order);
    this.deps.onChange();
  }

  setContentBounds(bounds: Rectangle): void {
    this.contentBounds = bounds;
    this.layout();
  }

  broadcastTheme(theme: PanelTheme): void {
    this.deps.window.setBackgroundColor(THEME_BACKGROUND[theme.kind]);
    for (const panel of this.panels.values()) panel.sendTheme(theme);
    this.paneHost.sendTheme(theme);
  }

  // Panels closed while the host tears down keep their persisted state, so the next start restores them.
  retainStatesOnClose(retain: boolean): void {
    this.retainStates = retain;
  }

  resourceUri(absolutePath: string): string {
    return this.resourceUriFor(absolutePath);
  }

  changed(): void {
    this.deps.onChange();
  }

  // The browser feature was turned on or off: the pane hides with it.
  browserEnabledChanged(): void {
    this.layout();
    this.paneHost.stateChanged();
    this.deps.onChange();
  }

  // Opens or collapses a chat tab's pane (the top bar button and the menu shortcut); focus stays where it is unless it
  // sat in the pane that closed.
  togglePane(chatId: string): void {
    const chat = this.panels.get(chatId);
    if (!chat?.pane || !this.deps.paneContext().browserEnabled()) return;
    this.setPaneOpen(chat, !chat.pane.open);
  }

  // While set, the chat tab's restored pages keep the pane as it was saved.
  setRestoring(chat: DesktopPanel, restoring: boolean): void {
    if (chat.pane) chat.pane.restoring = restoring;
  }

  // Keyboard focus sits in the selected tab's pane chrome or its active page.
  paneFocused(): boolean {
    return this.paneHost.focused || (this.activePage()?.webContents.isFocused() ?? false);
  }

  chatFocused(): boolean {
    return this.selected()?.webContents.isFocused() ?? false;
  }

  // The pane view is shown for the selected chat tab.
  paneVisible(): boolean {
    const layout = this.currentLayout();
    return layout !== undefined && layout.mode !== 'collapsed';
  }

  focusChat(): void {
    this.selected()?.webContents.focus();
  }

  focusPane(): void {
    if (this.paneVisible()) this.paneHost.focus();
  }

  revealPage(page: DesktopPanel): void {
    const chat = page.chat;
    if (!chat?.pane || !this.panels.has(chat.panelId)) return;
    chat.pane.activePageId = page.panelId;
    if (!chat.pane.restoring) chat.pane.open = true;
    this.paneChanged(chat);
  }

  pageChanged(page: DesktopPanel): void {
    const chat = page.chat;
    if (!chat || !this.panels.has(chat.panelId)) return;
    if (chat === this.selected()) this.paneHost.stateChanged();
    this.persistPane(chat);
    this.deps.onChange();
  }

  removed(panel: DesktopPanel): void {
    this.panels.delete(panel.panelId);
    if (!this.deps.window.isDestroyed()) this.deps.window.contentView.removeChildView(panel.view);
    if (panel.chat) {
      this.pageRemoved(panel, panel.chat);
      return;
    }
    const index = this.order.indexOf(panel.panelId);
    if (index >= 0) this.order.splice(index, 1);
    if (!this.retainStates) this.deps.states.delete(panel.panelId);
    // A page never outlives the chat tab it is shown beside.
    for (const page of [...(panel.pane?.pages ?? [])]) page.close();
    if (this.selectedId === panel.panelId) {
      this.selectedId = undefined;
      this.layout();
      // The neighbour that slid into the closed tab's place, as browsers do. A host teardown closes every tab in core's
      // order and must leave the persisted selection as it was, so it shows none.
      const fallback = this.retainStates ? undefined : this.order[Math.min(Math.max(index, 0), this.order.length - 1)];
      if (fallback !== undefined) {
        this.show(fallback, { focus: this.focusFallbackOnClose });
        return;
      }
    }
    this.paneHost.stateChanged();
    this.deps.onChange();
  }

  // The pane view closes with the window.
  dispose(): void {
    this.paneHost.dispose();
  }

  private createPage(request: CreatePanelRequest): DesktopPanel {
    const owner = request.options.owner;
    const chat = [...this.panels.values()].find((panel) => panel === owner);
    if (!chat?.pane) throw new Error('A browser page opens only beside an open chat tab');
    const page = new DesktopPanel(this, this.deps, request, chat, undefined);
    this.panels.set(page.panelId, page);
    this.deps.window.contentView.addChildView(page.view);
    chat.pane.pages.push(page);
    chat.pane.activePageId = page.panelId;
    if (!chat.pane.restoring) chat.pane.open = true;
    this.paneChanged(chat);
    return page;
  }

  private pageRemoved(page: DesktopPanel, chat: DesktopPanel): void {
    const pane = chat.pane;
    // The chat tab itself is closing, or the page was never added.
    if (!pane || !this.panels.has(chat.panelId)) return;
    const index = pane.pages.indexOf(page);
    if (index < 0) return;
    const hadFocus = this.paneFocused() || page.webContents.isFocused();
    pane.pages.splice(index, 1);
    if (pane.activePageId === page.panelId) pane.activePageId = pane.pages[Math.min(index, pane.pages.length - 1)]?.panelId;
    // A host teardown closes every page and must leave the pane as it was saved.
    if (pane.pages.length === 0 && !this.retainStates) {
      pane.open = false;
      pane.maximized = false;
    }
    this.paneChanged(chat);
    // Focus never stays in a closed page's destroyed WebContents.
    if (!hadFocus || chat !== this.selected()) return;
    if (pane.open) this.paneHost.focus();
    else this.focusChat();
  }

  private setPaneOpen(chat: DesktopPanel, open: boolean): void {
    const pane = chat.pane;
    if (!pane || pane.open === open) return;
    const hadFocus = !open && chat === this.selected() && this.paneFocused();
    pane.open = open;
    if (!open) pane.maximized = false;
    this.paneChanged(chat);
    if (hadFocus) this.focusChat();
  }

  private paneChanged(chat: DesktopPanel): void {
    this.persistPane(chat);
    if (chat === this.selected()) {
      this.layout();
      this.restack();
      this.paneHost.stateChanged();
    }
    this.deps.onChange();
  }

  private persistPane(chat: DesktopPanel): void {
    const pane = chat.pane;
    if (!pane || this.retainStates || !this.panels.has(chat.panelId)) return;
    const active = pane.pages.findIndex((page) => page.panelId === pane.activePageId);
    this.deps.states.setPane(chat.panelId, {
      open: pane.open,
      maximized: pane.maximized,
      pages: pane.pages.map((page) => page.page?.url ?? ''),
      ...(active >= 0 ? { activePage: active } : {}),
    });
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

  private currentLayout(): PaneLayout | undefined {
    const chat = this.selected();
    const area = this.area();
    if (!chat?.pane || !area) return undefined;
    return paneLayout({ area, open: chat.pane.open && this.deps.paneContext().browserEnabled(), maximized: chat.pane.maximized, width: this.paneWidth });
  }

  // Sets every view's bounds and visibility in one synchronous pass, so the chat, pane and page never disagree for a frame.
  private layout(): void {
    const chat = this.selected();
    const result = this.currentLayout();
    const active = this.activePage();
    const numbers = result ? `${result.mode}:${result.width}:${result.minWidth}:${result.maxWidth}` : '';
    if (numbers !== this.shownLayout) {
      this.shownLayout = numbers;
      this.paneHost.stateChanged();
    }
    // A maximized pane hides the chat view, so neither the eye nor a screen reader finds it under the pane.
    if (chat && result) {
      if (result.chat) chat.view.setBounds(result.chat);
      const shown = result.chat !== undefined;
      if (chat.view.getVisible() !== shown) {
        chat.view.setVisible(shown);
        chat.fireViewState();
      }
    }
    this.paneHost.view.setVisible(result?.pane !== undefined);
    if (result?.pane) this.paneHost.view.setBounds(result.pane);
    for (const panel of this.panels.values()) {
      if (!panel.chat) continue;
      const shown = panel === active && result?.page !== undefined;
      if (shown && result?.page) panel.view.setBounds(result.page);
      if (panel.view.getVisible() === shown) continue;
      panel.view.setVisible(shown);
      panel.fireViewState();
    }
  }

  // addChildView of a view already added moves it to the top.
  private restack(): void {
    if (this.deps.window.isDestroyed()) return;
    this.deps.window.contentView.addChildView(this.paneHost.view);
    const active = this.activePage();
    if (active) this.deps.window.contentView.addChildView(active.view);
  }

  private pageOf(id: string): DesktopPanel {
    const page = this.panels.get(id);
    if (!page?.chat || page.chat !== this.selected()) throw new Error('Unknown page');
    return page;
  }

  private selectedChat(): DesktopPanel {
    const chat = this.selected();
    if (!chat) throw new Error('No chat tab is selected');
    return chat;
  }

  private paneActions(): PaneActions {
    return {
      state: () => {
        const area = this.area() ?? { x: 0, y: 0, width: 0, height: 0 };
        const layout = this.currentLayout() ?? paneLayout({ area, open: false, maximized: false, width: this.paneWidth });
        return paneSnapshot(this.selected(), layout, this.deps.paneContext());
      },
      requestWidth: (width, commit) => {
        const area = this.area();
        const chat = this.selected();
        if (!area || !chat?.pane) return;
        this.paneWidth = paneLayout({ area, open: true, maximized: false, width }).width;
        if (commit) this.deps.states.setPaneWidth(this.paneWidth);
        this.layout();
        this.paneHost.sendStateNow();
      },
      selectPage: (id) => {
        const page = this.pageOf(id);
        const chat = this.selectedChat();
        if (!chat.pane || chat.pane.activePageId === page.panelId) return;
        chat.pane.activePageId = page.panelId;
        this.paneChanged(chat);
      },
      closePage: (id) => this.pageOf(id).close(),
      newPage: async () => {
        const context = this.deps.paneContext();
        if (!context.browserEnabled()) throw new Error('The browser is turned off');
        await context.newPage(this.selectedChat());
      },
      navigate: (id, url) => this.pageOf(id).deliver({ type: 'navigate', url }),
      goBack: (id) => this.pageOf(id).deliver({ type: 'goBack' }),
      goForward: (id) => this.pageOf(id).deliver({ type: 'goForward' }),
      reload: (id) => this.pageOf(id).deliver({ type: 'reload' }),
      openExternal: async (id) => {
        const url = this.pageOf(id).page?.url ?? '';
        if (!isHttpUrl(url)) throw new Error('Only http and https pages open in the system browser');
        if (!(await this.deps.paneContext().openExternal(url))) throw new Error('The system browser did not open the page');
      },
      pickElement: (id) => this.pageOf(id).deliver({ type: 'pickElement' }),
      openDevTools: (id) => this.pageOf(id).deliver({ type: 'openDevTools' }),
      setMaximized: (maximized) => {
        const chat = this.selectedChat();
        if (!chat.pane?.open || chat.pane.maximized === maximized) return;
        chat.pane.maximized = maximized;
        this.paneChanged(chat);
      },
      setCollapsed: (collapsed) => this.setPaneOpen(this.selectedChat(), !collapsed),
    };
  }
}
