// HTML preview tabs' views (docs/invariants.md "Desktop host", HTML previews): the editor pane owns the tabs, this owns each
// tab's view, its project root's token, its grant of the root's loopback server (ServedRoots), the reload on save and the
// rebuild on a trust change.
import { randomBytes } from 'node:crypto';
import { WebContentsView, type Rectangle, type WebContents } from 'electron';
import type { Disposable } from '../../../platform/disposable';
import { authorityKeyOfProject, pathFor } from '../../../shared/project-location';
import type { Project } from '../../local-services/confine';
import type { WorkspaceFileSystem } from '../../workspace/file-system';
import type { FileRef, HtmlPreviewActionRequest, HtmlPreviewStatus, ShellHtmlPreview } from '../../preload/shell-channels';
import { GestureGrant, isActivationKey, isPrimaryClick } from '../clipboard-gestures';
import type { Location } from '../documents/document-service';
import type { HtmlPreviewSource } from '../editor-pane';
import { leavePageOnPartKeys, type PartStep } from '../page-focus';
import { PREVIEW_SCHEME } from '../protocol';
import { mainFrameLoadFailed, registerLockedContents } from '../security';
import { NotConnectedError } from '../workspace/workspaces';
import { answerPreview, type PreviewFileReads } from './preview-reader';
import type { ServedGrant, ServedRoots } from './served-roots';
import { HTML_PREVIEW_PARTITION, previewResponse, type PreviewSessionDeps } from './preview-session';
import { previewHeaders, previewRequestPath, previewUrlPath } from './serve-policy';

export const RELOAD_DEBOUNCE_MS = 200;
// Beyond this many live views the least recently shown other one is destroyed, and rebuilt when its tab shows again.
export const MAX_LIVE_PREVIEW_VIEWS = 4;

export interface HtmlPreviewsWindow {
  isDestroyed(): boolean;
  getContentBounds(): Rectangle;
  readonly contentView: { addChildView(view: WebContentsView): void; removeChildView(view: WebContentsView): void };
}

export interface HtmlPreviewsDeps {
  // every root a tab may name a file in: the open projects and their chat worktrees
  readonly projects: () => readonly Project[];
  // the root's workspace files (workspaces.forProject); throws NotConnectedError while its host is not connected
  readonly files: (rootKey: string) => Pick<WorkspaceFileSystem, 'readFileRange' | 'watch'>;
  readonly authorityOs: (authority: string) => NodeJS.Platform;
  // FormatService's trust: TrustStore locally, the host store remotely
  readonly isTrusted: (project: Project) => boolean;
  // resolves once the user answered
  readonly requestTrust: (project: Project) => Promise<unknown>;
  // DocumentService.onDidSave
  readonly onDidSave: (listener: (location: Location) => void) => Disposable;
  readonly hostName: (authority: string) => string;
  // ShellService.openExternal
  readonly openExternal: (url: string) => Promise<boolean>;
  // one toast: the preview could not be opened in the browser
  readonly openInBrowserFailed: () => void;
  // EditorPane.htmlPreviewsChanged: a tab's published state changed
  readonly changed: () => void;
  // builds the html-preview session once (createPreviewSession) and resolves once its proxy is set
  readonly createSession: (deps: PreviewSessionDeps) => Promise<void>;
  // Open in Browser's loopback server of the tab's root, held per root until the root's last preview tab goes
  readonly served: Pick<ServedRoots, 'grantPreview' | 'releasePreview'>;
  // a preview view that held keyboard focus hid or closed; a hidden view keeps focus, so the owner moves it
  readonly focusAway: () => void;
  // Focus Next or Previous Part, from the editor part a focused preview view belongs to
  readonly focusPart: (step: PartStep) => void;
  readonly log: (line: string) => void;
  readonly platform?: NodeJS.Platform;
}

// A project root with a preview open: one origin, damocles-preview://<token>.
interface Root {
  readonly key: string;
  // 128 bits of lowercase hex, since Chromium lower-cases a standard scheme's host
  readonly token: string;
  // the trust its views and responses were built with
  trusted: boolean;
}

interface Live {
  readonly view: WebContentsView;
  readonly grant: GestureGrant<true>;
  // the main-frame navigation the grant was spent on, which will-navigate may open outside
  navigation: string | undefined;
  // the files the view was served, by project-relative folder ('' for the root), and each folder's watch while its host is connected
  readonly served: Map<string, { readonly names: Set<string>; watch: Disposable | undefined }>;
  // the main frame's last response code; did-finish-load follows a 404 page too
  code: number;
  loadFailed: boolean;
  reload: NodeJS.Timeout | undefined;
}

interface Preview {
  readonly tabId: string;
  file: FileRef;
  root: Root;
  status: HtmlPreviewStatus;
  live: Live | undefined;
  lastShown: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const folderOf = (relativePath: string): string => {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? '' : relativePath.slice(0, slash);
};
const nameOf = (relativePath: string): string => relativePath.slice(relativePath.lastIndexOf('/') + 1);

export class HtmlPreviews implements HtmlPreviewSource, Disposable {
  private readonly deps: HtmlPreviewsDeps;
  private readonly previews = new Map<string, Preview>();
  private readonly roots = new Map<string, Root>();
  private readonly byContents = new Map<number, Preview>();
  private readonly saves: Disposable;
  private window: { readonly window: HtmlPreviewsWindow; readonly restack: () => void } | undefined;
  private activeId: string | null = null;
  // the shell's page card of the active preview tab, in window DIPs; undefined while none shows
  private frame: { readonly tabId: string; readonly bounds: Rectangle; readonly radius: number } | undefined;
  private session: Promise<void> | undefined;
  private shownCount = 0;
  // the tab layout last showed, so lastShown counts each time a tab is shown, not each layout
  private lastShownId: string | undefined;
  private disposed = false;

  constructor(deps: HtmlPreviewsDeps) {
    this.deps = deps;
    this.saves = deps.onDidSave((location) => this.saved(location));
  }

  state(tabId: string): ShellHtmlPreview {
    const preview = this.previews.get(tabId);
    if (!preview) throw new Error('Unknown HTML preview tab');
    const authority = authorityKeyOfProject(preview.root.key);
    return { status: preview.status, trusted: preview.root.trusted, ...(authority !== 'local' ? { hostName: this.deps.hostName(authority) } : {}) };
  }

  tabsChanged(tabs: ReadonlyArray<{ readonly tabId: string; readonly file: FileRef }>, activeTabId: string | null): void {
    const listed = new Set(tabs.map((tab) => tab.tabId));
    for (const preview of [...this.previews.values()]) if (!listed.has(preview.tabId)) this.close(preview);
    for (const { tabId, file } of tabs) {
      const preview = this.previews.get(tabId);
      if (!preview) {
        this.previews.set(tabId, { tabId, file, root: this.rootOf(file.projectKey), status: 'loading', live: undefined, lastShown: 0 });
        continue;
      }
      if (preview.file.projectKey === file.projectKey && preview.file.relativePath === file.relativePath) continue;
      // a Files rename moved the file: the tab shows it from its new path
      this.destroyView(preview);
      const previous = preview.root;
      preview.file = file;
      preview.root = this.rootOf(file.projectKey);
      this.releaseRoot(previous);
      this.setStatus(preview, 'loading');
    }
    this.activeId = activeTabId;
    this.layout();
  }

  /** The window the views show in; restack moves the overlay above a view just added. */
  attach(window: HtmlPreviewsWindow, restack: () => void): void {
    this.window = { window, restack };
    this.layout();
  }

  /** The window closed: every view goes, the tabs stay and rebuild in the next window. */
  detach(): void {
    for (const preview of this.previews.values()) {
      if (!preview.live) continue;
      this.destroyView(preview);
      if (preview.status === 'ready') preview.status = 'loading';
    }
    this.window = undefined;
    this.frame = undefined;
    this.lastShownId = undefined;
  }

  /** The shell's page card of the active preview tab, in window DIPs; undefined while none shows. */
  setBounds(frame: { readonly tabId: string; readonly bounds: Rectangle; readonly radius: number } | undefined): void {
    this.frame = frame;
    this.layout();
  }

  /** The toolbar's, the banner's and the tab menu's actions, a user's click. */
  async action(request: HtmlPreviewActionRequest): Promise<void> {
    const preview = this.previews.get(request.tabId);
    if (!preview) throw new Error('Unknown HTML preview tab');
    if (request.action === 'reload') this.reload(preview);
    else if (request.action === 'trustFolder') {
      const project = this.projectOf(preview.root.key);
      if (!project) throw new Error('The preview\'s project is no longer open');
      await this.deps.requestTrust(project);
    } else await this.openInBrowser(preview);
  }

  focused(): boolean {
    const preview = this.activeId === null ? undefined : this.previews.get(this.activeId);
    return preview?.live?.view.webContents.isFocused() ?? false;
  }

  /** Keyboard focus into the tab's page; false while its view is not shown (inactive, not ready, no card reported). */
  focusPage(tabId: string): boolean {
    const view = this.previews.get(tabId)?.live?.view;
    if (!view?.getVisible()) return false;
    view.webContents.focus();
    return true;
  }

  /** The authority of a remote project's preview view, whose links open through that host's link checks; else undefined. */
  remoteAuthority(contents: WebContents): string | undefined {
    const preview = this.byContents.get(contents.id);
    const authority = preview ? authorityKeyOfProject(preview.root.key) : undefined;
    return authority === 'local' ? undefined : authority;
  }

  /** Trust may have changed (a local grant, a host record): a root whose trust flipped rebuilds its views with the new scripts and CSP. */
  trustChanged(): void {
    let flipped = false;
    for (const root of this.roots.values()) {
      const project = this.projectOf(root.key);
      const trusted = project !== undefined && this.deps.isTrusted(project);
      if (trusted === root.trusted) continue;
      root.trusted = trusted;
      flipped = true;
      for (const preview of this.previews.values()) {
        if (preview.root !== root) continue;
        this.destroyView(preview);
        if (preview.status !== 'offline') preview.status = 'loading';
      }
    }
    if (!flipped) return;
    this.deps.changed();
    this.layout();
  }

  /** A host connected or went away: an offline preview shows so, a reconnected one watches its folders again and reloads. */
  connectionsChanged(): void {
    for (const preview of this.previews.values()) {
      const connected = this.connected(preview.root.key);
      if (!connected && preview.status !== 'offline') {
        for (const folder of preview.live?.served.values() ?? []) {
          folder.watch?.dispose();
          folder.watch = undefined;
        }
        this.setStatus(preview, 'offline');
      } else if (connected && preview.status === 'offline') {
        const live = preview.live;
        if (live) for (const folder of live.served.keys()) this.watchFolder(preview, live, folder);
        this.setStatus(preview, 'loading');
        this.reload(preview);
      }
    }
    this.layout();
  }

  /** The handler of the damocles-preview scheme: a live root's files, as its views load them. */
  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const root = [...this.roots.values()].find((candidate) => candidate.token === url.host);
    if (!root) return previewResponse({ status: 404, headers: previewHeaders(false, 'view') });
    const range = request.headers.get('range') ?? undefined;
    const ifRange = request.headers.get('if-range') ?? undefined;
    return previewResponse(await answerPreview({ method: request.method, pathname: url.pathname, trusted: root.trusted, target: 'view', range, ifRange }, this.reads(root), this.deps.log));
  }

  dispose(): void {
    this.disposed = true;
    this.saves.dispose();
    for (const preview of [...this.previews.values()]) this.close(preview);
    this.window = undefined;
  }

  private rootOf(rootKey: string): Root {
    let root = this.roots.get(rootKey);
    if (!root) {
      const project = this.projectOf(rootKey);
      root = { key: rootKey, token: randomBytes(16).toString('hex'), trusted: project !== undefined && this.deps.isTrusted(project) };
      this.roots.set(rootKey, root);
    }
    return root;
  }

  // The root's last preview went: its token stops resolving, and its Open in Browser server goes unless a chat view holds it.
  private releaseRoot(root: Root): void {
    if ([...this.previews.values()].some((preview) => preview.root === root)) return;
    this.roots.delete(root.key);
    this.deps.served.releasePreview(root.key);
  }

  private close(preview: Preview): void {
    this.destroyView(preview);
    this.previews.delete(preview.tabId);
    if (this.activeId === preview.tabId) this.activeId = null;
    this.releaseRoot(preview.root);
  }

  private projectOf(rootKey: string): Project | undefined {
    return this.deps.projects().find((project) => project.key === rootKey);
  }

  private connected(rootKey: string): boolean {
    try {
      this.deps.files(rootKey);
      return true;
    } catch (err) {
      if (err instanceof NotConnectedError) return false;
      throw err;
    }
  }

  // The root's files, read only through its workspace's confinement.
  private reads(root: Root): PreviewFileReads {
    return {
      range: async (relativePath, offset, length) => {
        const project = this.projectOf(root.key);
        if (!project) return { ok: false, reason: 'missing' };
        return this.deps.files(root.key).readFileRange(project, relativePath, offset, length);
      },
    };
  }

  private async openInBrowser(preview: Preview): Promise<void> {
    const root = preview.root;
    const project = this.projectOf(root.key);
    if (!project) throw new Error('The preview\'s project is no longer open');
    let grant: ServedGrant;
    try {
      grant = await this.deps.served.grantPreview(project);
    } catch (err) {
      // the root's last preview tab closed while the port opened, which released it
      if (this.roots.get(root.key) !== root) return;
      this.deps.log(`[html-preview] the preview's browser port could not open: ${errorText(err)}`);
      this.deps.openInBrowserFailed();
      return;
    }
    // the tab closed or moved to another root meanwhile: nothing of its own is left to open
    if (this.previews.get(preview.tabId) !== preview || preview.root !== root) return;
    const url = grant.open(preview.file.relativePath);
    const opened = await this.deps.openExternal(url).catch((err: unknown) => {
      this.deps.log(`[html-preview] opening a preview in the browser failed: ${errorText(err)}`);
      return false;
    });
    if (!opened) this.deps.openInBrowserFailed();
  }

  private reload(preview: Preview): void {
    if (!preview.live) {
      this.setStatus(preview, 'loading');
      this.layout();
      return;
    }
    clearTimeout(preview.live.reload);
    preview.live.reload = undefined;
    preview.live.view.webContents.reload();
  }

  private scheduleReload(preview: Preview, live: Live): void {
    clearTimeout(live.reload);
    live.reload = setTimeout(() => {
      live.reload = undefined;
      if (preview.live === live) live.view.webContents.reload();
    }, RELOAD_DEBOUNCE_MS);
  }

  private saved(location: Location): void {
    if (location.projectKey === undefined || location.relativePath === undefined) return;
    const folder = folderOf(location.relativePath);
    const name = nameOf(location.relativePath);
    for (const preview of this.previews.values()) {
      const live = preview.live;
      if (live && preview.root.key === location.projectKey && live.served.get(folder)?.names.has(name)) this.scheduleReload(preview, live);
    }
  }

  // A preview URL the view was served: a change to its file reloads the view, so its folder is watched.
  private served(webContentsId: number, pathname: string): void {
    const preview = this.byContents.get(webContentsId);
    const live = preview?.live;
    const path = previewRequestPath(pathname);
    if (!preview || !live || !path) return;
    const folder = folderOf(path.relativePath);
    const served = live.served.get(folder);
    if (served) {
      served.names.add(nameOf(path.relativePath));
      return;
    }
    live.served.set(folder, { names: new Set([nameOf(path.relativePath)]), watch: undefined });
    this.watchFolder(preview, live, folder);
  }

  // A direct-children watch of the folder on the root's host; a change to a file the view served reloads it.
  private watchFolder(preview: Preview, live: Live, folder: string): void {
    const served = live.served.get(folder);
    const project = this.projectOf(preview.root.key);
    if (!served || !project) return;
    served.watch?.dispose();
    served.watch = undefined;
    let files: Pick<WorkspaceFileSystem, 'watch'>;
    try {
      files = this.deps.files(preview.root.key);
    } catch (err) {
      if (err instanceof NotConnectedError) return;
      throw err;
    }
    const os = this.deps.authorityOs(authorityKeyOfProject(preview.root.key));
    const flavor = pathFor({ os });
    const base = folder === '' ? project.fsPath : flavor.join(project.fsPath, ...folder.split('/'));
    const same = (a: string, b: string): boolean => (os === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const watch = files.watch(base, '*', (event) => {
      const name = flavor.basename(event.path);
      if (preview.live === live && [...served.names].some((servedName) => same(servedName, name))) this.scheduleReload(preview, live);
    });
    served.watch = watch;
    watch.ready.catch((err: unknown) => this.deps.log(`[html-preview] watching a preview's folder failed: ${errorText(err)}`));
  }

  private setStatus(preview: Preview, status: HtmlPreviewStatus): void {
    if (preview.status === status) return;
    preview.status = status;
    this.deps.changed();
  }

  private sessionReady(): Promise<void> {
    if (!this.session) {
      this.session = this.deps.createSession({
        tokenOf: (webContentsId) => this.byContents.get(webContentsId)?.root.token,
        trustedOf: (webContentsId) => this.byContents.get(webContentsId)?.root.trusted === true,
        served: (webContentsId, pathname) => this.served(webContentsId, pathname),
        handle: (request) => this.handle(request),
        log: this.deps.log,
      });
      this.session.catch((err: unknown) => this.deps.log(`[html-preview] the preview session's proxy could not be set: ${errorText(err)}`));
    }
    return this.session;
  }

  private buildView(preview: Preview, window: NonNullable<HtmlPreviews['window']>): Live {
    const root = preview.root;
    const view = new WebContentsView({
      webPreferences: {
        partition: HTML_PREVIEW_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        nodeIntegrationInSubFrames: false,
        webSecurity: true,
        javascript: root.trusted,
        disableDialogs: true,
        devTools: false,
        spellcheck: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        // Electron focuses a WebContents when it navigates; a preview loading must leave focus where it is.
        focusOnNavigation: false,
      },
    });
    const contents = view.webContents;
    const grant = new GestureGrant<true>();
    const live: Live = { view, grant, navigation: undefined, served: new Map(), code: 0, loadFailed: false, reload: undefined };
    // Before the first load, so the navigation lock applies to it.
    registerLockedContents(contents, `${PREVIEW_SCHEME}://${root.token}`, (url, kind) => {
      if (kind === 'popup') return grant.take() === true;
      const bound = live.navigation;
      live.navigation = undefined;
      return bound === url;
    });
    contents.setWebRTCIPHandlingPolicy('default_public_interface_only');
    view.setBackgroundColor('#ffffff');
    view.setVisible(false);
    this.byContents.set(contents.id, preview);
    const platform = this.deps.platform ?? process.platform;
    contents.on('before-mouse-event', (_event, mouse) => {
      if (isPrimaryClick(mouse, platform)) grant.grant(true);
    });
    contents.on('before-input-event', (_event, input) => {
      if (isActivationKey(input)) grant.grant(true);
    });
    leavePageOnPartKeys(contents, this.deps.focusPart);
    contents.on('blur', () => {
      grant.clear();
      live.navigation = undefined;
    });
    // Electron emits it before will-navigate, so a click is spent on the next navigation alone, the only one will-navigate opens
    contents.on('did-start-navigation', (details) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      live.navigation = grant.take() === true ? details.url : undefined;
      if (preview.live !== live) return;
      live.loadFailed = false;
      live.code = 0;
    });
    contents.on('did-navigate', (_event, _url, httpResponseCode) => {
      if (preview.live === live) live.code = httpResponseCode;
    });
    contents.on('did-finish-load', () => {
      if (preview.live !== live || live.loadFailed || preview.status === 'offline') return;
      this.setStatus(preview, live.code === 503 ? 'offline' : live.code >= 400 ? 'failed' : 'ready');
      this.layout();
    });
    contents.on('did-fail-load', (_event, errorCode, errorDescription, _url, isMainFrame) => {
      if (preview.live !== live || !mainFrameLoadFailed(errorCode, isMainFrame)) return;
      this.deps.log(`[html-preview] a preview failed to load: ${errorDescription}`);
      live.loadFailed = true;
      this.setStatus(preview, 'failed');
      this.layout();
    });
    // A page's cancelling beforeunload would hold the reload on save.
    contents.on('will-prevent-unload', (event) => event.preventDefault());
    contents.on('render-process-gone', (_event, details) => {
      if (preview.live !== live) return;
      this.deps.log(`[html-preview] a preview's page ended: ${details.reason}`);
      this.destroyView(preview);
      this.setStatus(preview, 'failed');
      this.layout();
    });
    window.window.contentView.addChildView(view);
    window.restack();
    const url = `${PREVIEW_SCHEME}://${root.token}${previewUrlPath(preview.file.relativePath)}`;
    this.sessionReady().then(() => {
      if (preview.live !== live) return;
      contents.loadURL(url).catch((err: unknown) => {
        // a reload or a navigation that replaced this load rejects it too; did-fail-load reports a real failure. The message
        // names the URL, whose host is the root's token, so only the code is logged.
        this.deps.log(`[html-preview] loading a preview failed (${String((err as { code?: unknown } | undefined)?.code ?? 'no code')})`);
      });
    }, () => {
      if (preview.live === live) this.setStatus(preview, 'failed');
    });
    return live;
  }

  private destroyView(preview: Preview): void {
    const live = preview.live;
    if (!live) return;
    preview.live = undefined;
    clearTimeout(live.reload);
    live.grant.clear();
    for (const folder of live.served.values()) folder.watch?.dispose();
    const contents = live.view.webContents;
    this.byContents.delete(contents.id);
    const hadFocus = !contents.isDestroyed() && contents.isFocused();
    if (this.window && !this.window.window.isDestroyed()) this.window.window.contentView.removeChildView(live.view);
    if (!contents.isDestroyed()) contents.close();
    if (hadFocus) this.deps.focusAway();
  }

  // The shell's report can lag a resize by a frame, so a view never extends past the window.
  private area(window: HtmlPreviewsWindow): Rectangle | undefined {
    const reported = this.frame?.bounds;
    if (!reported || window.isDestroyed()) return undefined;
    const { width, height } = window.getContentBounds();
    const x = Math.min(Math.max(0, reported.x), width);
    const y = Math.min(Math.max(0, reported.y), height);
    const area = { x, y, width: Math.min(reported.width, width - x), height: Math.min(reported.height, height - y) };
    return area.width > 0 && area.height > 0 ? area : undefined;
  }

  // Only the active preview tab's view shows, only once its page is ready, and only over the card the shell reports.
  private layout(): void {
    const window = this.window;
    if (this.disposed || !window) return;
    const active = this.activeId === null ? undefined : this.previews.get(this.activeId);
    if (active && !active.live && (active.status === 'loading' || active.status === 'offline')) {
      if (!this.connected(active.root.key)) this.setStatus(active, 'offline');
      else this.goLive(active, window);
    }
    if (active?.live && active.tabId !== this.lastShownId) active.lastShown = ++this.shownCount;
    this.lastShownId = active?.tabId;
    const area = active && this.frame?.tabId === active.tabId ? this.area(window.window) : undefined;
    const shown = area && active?.status === 'ready' ? active : undefined;
    let lostFocus = false;
    for (const preview of this.previews.values()) {
      const live = preview.live;
      if (!live) continue;
      const visible = preview === shown;
      if (visible) {
        live.view.setBounds(area!);
        live.view.setBorderRadius(this.frame!.radius);
      }
      if (live.view.getVisible() === visible) continue;
      lostFocus ||= !visible && live.view.webContents.isFocused();
      if (visible) {
        // a chat view added since stays below the preview it shows beside; the overlay stays above
        window.window.contentView.addChildView(live.view);
        window.restack();
      }
      live.view.setVisible(visible);
    }
    if (lostFocus) this.deps.focusAway();
  }

  // The tab shown gets a view; past the cap the least recently shown other view goes.
  private goLive(preview: Preview, window: NonNullable<HtmlPreviews['window']>): void {
    this.setStatus(preview, 'loading');
    preview.live = this.buildView(preview, window);
    const live = [...this.previews.values()].filter((other) => other.live !== undefined);
    while (live.length > MAX_LIVE_PREVIEW_VIEWS) {
      const oldest = live.filter((other) => other !== preview).reduce((a, b) => (a.lastShown <= b.lastShown ? a : b));
      this.destroyView(oldest);
      this.setStatus(oldest, 'loading');
      live.splice(live.indexOf(oldest), 1);
    }
  }
}
