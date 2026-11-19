// The loopback servers that serve a root's files to a browser (docs/invariants.md "Ports and the remote browser", "Desktop
// host"): one per (authority, root), granted to chat views (the agent's browser, each view on a host of its own) and HTML
// preview tabs (Open in Browser, on 127.0.0.1), closed with its last grant. Every server keeps PreviewHttpServer's checks; a
// project or design root is never a path a core names, and a folder the permission gate granted a chat is read only through its
// own authority's workspace.
import { PreviewHttpServer } from '../../../core/served-pages/preview-http-server';
import { answerPreview, type PreviewAnswer, type PreviewFileReads, type PreviewRequest } from '../../../core/served-pages/preview-reader';
import { answerDesign, servedPathRefusal, type ServedRoot } from '../../../core/served-pages/root-files';
import type { Disposable } from '../../../platform/disposable';
import { isDesignId } from '../../../shared/design-paths';
import { MAX_SERVED_FOLDERS_PER_CHAT } from '../../../shared/served-file-url';
import { folderKey } from '../../../core/workspace-folders/folder-key';
import { listeners } from '../../../remote/listeners';
import { authorityKeyOfProject } from '../../../shared/project-location';
import type { DesignPreviewFile } from '../../../shared/types/design';
import type { Project } from '../../local-services/confine';
import type { WorkspaceFileSystem } from '../../workspace/file-system';

export interface ServedGrant {
  // http://<label>.localhost:<port> for a chat view, http://127.0.0.1:<port> for Open in Browser
  readonly origin: string;
  // a one-time URL that opens relPath, which must pass servedPathRefusal first
  open(relPath: string): string;
}

export interface ServedRootsDeps {
  // the project root a chat view of the authority works in, from main's own roots; undefined when it has none main lists
  readonly projectOfView: (authority: string, viewId: string) => Project | undefined;
  // whether viewId is a live chat view of the authority
  readonly chatView: (authority: string, viewId: string) => boolean;
  // every root main lists (the open projects and their live chat worktrees), read at each request
  readonly projects: () => readonly Project[];
  // the root's workspace files (workspaces.forProject): this computer's disk, or the authority's workspace; throws
  // NotConnectedError while its host is away
  readonly files: (rootKey: string) => Pick<WorkspaceFileSystem, 'readFileRange' | 'confineExisting'>;
  readonly isTrusted: (project: Project) => boolean;
  // this computer's folder of a design, the displayRoot of a local design grant
  readonly localDesignFolder: (designId: string) => string;
  // design.read on the authority's own core, which reads only a design one of its chats holds
  readonly designRead: (authority: string, designId: string, relPath: string) => Promise<DesignPreviewFile | 'tooLarge' | undefined>;
  // "Open this preview from Damocles.", in main's language
  readonly refusalText: () => string;
  readonly log: (line: string) => void;
}

// a granted folder's project is the folder on its authority, read through that authority's workspace
type EntryRoot = { readonly kind: 'project'; readonly projectKey: string } | { readonly kind: 'design'; readonly designId: string } | { readonly kind: 'folder'; readonly project: Project };

/** A root of a chat view's grant: its project, a design by id, or a folder its core's permission gate granted, by its path there. */
export type GrantedRoot = Exclude<ServedRoot, { readonly kind: 'folder' }> | { readonly kind: 'folder'; readonly folder: string };

const MAX_FOLDER_CHARS = 4096;

// The folder a core granted, as a project of its authority: an absolute path in the host's own form (a drive or share path, or a
// POSIX one), no '.' or '..' segment, no NUL and below a root; read with no path rules of this computer's.
function grantedFolderProject(authority: string, folder: string): Project | undefined {
  if (folder.length > MAX_FOLDER_CHARS || folder.includes('\0')) return undefined;
  const drive = /^[A-Za-z]:[\\/]/.test(folder);
  const share = /^[\\/]{2}[^\\/?.][^\\/]*[\\/][^\\/]+/.exec(folder);
  const windows = drive || share !== null;
  if (!windows && !folder.startsWith('/')) return undefined;
  const rest = drive ? folder.slice(2) : share ? folder.slice(share[0].length) : folder;
  const segments = rest.split(windows ? /[\\/]/ : '/').filter((segment) => segment !== '');
  if (segments.length === 0 || segments.some((segment) => segment === '.' || segment === '..')) return undefined;
  const name = segments[segments.length - 1]!;
  if (authority === LOCAL) return { key: folderKey(folder), fsPath: folder, name };
  return { key: `${authority}|${windows ? folder.toLowerCase() : folder}`, fsPath: folder, name };
}

// whether a confined real path is the folder a grant pinned, compared as its host compares names
function samePath(real: string, folder: string): boolean {
  const windows = /^[A-Za-z]:|^[\\/]{2}/.test(folder);
  const plain = (text: string): string => (windows ? text.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() : text.replace(/\/+$/, ''));
  return plain(real) === plain(folder);
}

interface Entry {
  readonly key: string;
  readonly authority: string;
  readonly root: EntryRoot;
  // view:<viewId> and preview:<rootKey>
  readonly holders: Set<string>;
  server: Promise<PreviewHttpServer> | undefined;
  // the server once a grant awaited it, so a release revokes its holder's host at once
  started: PreviewHttpServer | undefined;
  port: number | undefined;
  // each view holder's grant origin on the started server
  readonly origins: Map<string, string>;
  // the trust its server was started with; a project only
  trusted: boolean;
  // the root's path on its machine, main's own for a local root and as its core named it for a remote one; text only
  displayRoot: string | undefined;
}

// a chat sees its own design and its linked one; the rest of the room absorbs a role change during the view's life
export const MAX_DESIGN_ROOTS_PER_VIEW = 4;

const VIEW = 'view:';
const LOCAL = 'local';
const designKey = (authority: string, designId: string): string => `design\0${authority}\0${designId}`;
const folderEntryKey = (project: Project): string => `folder\0${project.key}`;
const viewHolder = (viewId: string): string => `${VIEW}${viewId}`;
const previewHolder = (rootKey: string): string => `preview:${rootKey}`;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ServedRoots implements Disposable {
  private readonly deps: ServedRootsDeps;
  private readonly entries = new Map<string, Entry>();
  private readonly changed = listeners<[string]>();

  constructor(deps: ServedRootsDeps) {
    this.deps = deps;
  }

  /** An authority's served ports or their grants changed; fired before the grant that changed them resolves. */
  onDidChange(listener: (authority: string) => void): Disposable {
    return this.changed.add(listener);
  }

  /**
   * A root of the chat view for its authority's browser: a project root is the view's own folder as main lists it, a design
   * root reads through the authority's core. The grant lasts until the view closes (release).
   */
  async grant(request: { readonly authority: string; readonly root: GrantedRoot; readonly viewId: string; readonly displayRoot?: string }): Promise<ServedGrant | { readonly refused: string }> {
    let entry: Entry;
    if (request.root.kind === 'folder') {
      const project = grantedFolderProject(request.authority, request.root.folder);
      if (!project || !this.deps.chatView(request.authority, request.viewId)) return { refused: 'That folder is not one this chat may be served, so its files are not served.' };
      const key = folderEntryKey(project);
      const holder = viewHolder(request.viewId);
      // a core names folders itself, so the servers one view may hold are bounded here
      const held = [...this.entries.values()].filter((other) => other.root.kind === 'folder' && other.holders.has(holder));
      if (!held.some((other) => other.key === key) && held.length >= MAX_SERVED_FOLDERS_PER_CHAT) return { refused: `This chat's browser already serves ${MAX_SERVED_FOLDERS_PER_CHAT} folders outside its project, the most one chat may open.` };
      entry = this.entries.get(key) ?? this.added({ key, authority: request.authority, root: { kind: 'folder', project }, holders: new Set(), server: undefined, started: undefined, port: undefined, origins: new Map(), trusted: this.deps.isTrusted(project), displayRoot: project.fsPath });
    } else if (request.root.kind === 'project') {
      const project = this.deps.projectOfView(request.authority, request.viewId);
      if (!project || authorityKeyOfProject(project.key) !== request.authority) return { refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.' };
      entry = this.projectEntry(project);
    } else {
      const { designId } = request.root;
      if (!isDesignId(designId)) return { refused: 'That is not a design of this chat, so its files are not served.' };
      const key = designKey(request.authority, designId);
      const holder = viewHolder(request.viewId);
      // a core names design ids itself, so the servers one view may hold are bounded here
      const held = [...this.entries.values()].filter((other) => other.root.kind === 'design' && other.holders.has(holder));
      if (!held.some((other) => other.key === key) && held.length >= MAX_DESIGN_ROOTS_PER_VIEW) return { refused: `This chat's browser already serves ${MAX_DESIGN_ROOTS_PER_VIEW} design folders, the most one chat may open.` };
      entry = this.designEntry(request.authority, designId);
    }
    if (request.displayRoot !== undefined) entry.displayRoot = request.displayRoot;
    return this.granted(entry, viewHolder(request.viewId));
  }

  /** Open in Browser of an HTML preview's project root, held until the root's last preview tab goes (releasePreview). */
  grantPreview(project: Project): Promise<ServedGrant> {
    return this.granted(this.projectEntry(project), previewHolder(project.key));
  }

  /** The chat view closed: its grants go, and a server with no grant left closes. */
  release(viewId: string): void {
    this.releaseHolder(viewHolder(viewId));
  }

  releasePreview(rootKey: string): void {
    this.releaseHolder(previewHolder(rootKey));
  }

  /** The loopback ports the authority's chat views were granted, which its browser context's proxy lets through. */
  servedPorts(authority: string): number[] {
    return this.viewEntries(authority).map((entry) => entry.port!);
  }

  /**
   * origin -> displayRoot of the chat view's grants of the authority's roots: every local one, and each remote one whose core
   * named its path. Never another view's: its origin maps to nothing, so its address is kept as loaded.
   */
  mappings(authority: string, viewId: string): Array<{ readonly origin: string; readonly displayRoot: string }> {
    const holder = viewHolder(viewId);
    return this.viewEntries(authority).flatMap((entry) => {
      const displayRoot = entry.displayRoot;
      const origin = entry.origins.get(holder);
      return displayRoot === undefined || origin === undefined ? [] : [{ origin, displayRoot }];
    });
  }

  /** The origins of the authority's roots the chat view was granted. */
  viewOrigins(authority: string, viewId: string): string[] {
    const holder = viewHolder(viewId);
    return this.viewEntries(authority).flatMap((entry) => {
      const origin = entry.origins.get(holder);
      return origin === undefined ? [] : [origin];
    });
  }

  /** Trust may have changed: a project root that lost it closes its server, so its pages stop running scripts and reading it. */
  trustChanged(): void {
    for (const entry of this.entries.values()) {
      if (entry.root.kind === 'design') continue;
      const trusted = this.entryTrusted(entry.root);
      if (trusted === entry.trusted) continue;
      entry.trusted = trusted;
      if (!trusted) this.closeServer(entry);
    }
  }

  dispose(): void {
    for (const entry of this.entries.values()) this.closeServer(entry);
    this.entries.clear();
  }

  private viewEntries(authority: string): Entry[] {
    return [...this.entries.values()].filter((entry) => entry.authority === authority && entry.port !== undefined && [...entry.holders].some((holder) => holder.startsWith(VIEW)));
  }

  private projectOf(projectKey: string): Project | undefined {
    return this.deps.projects().find((project) => project.key === projectKey);
  }

  private trustedNow(projectKey: string): boolean {
    const project = this.projectOf(projectKey);
    return project !== undefined && this.deps.isTrusted(project);
  }

  // a granted folder is trusted only when the user trusted that exact folder, never through the chat's project
  private entryTrusted(root: Exclude<EntryRoot, { readonly kind: 'design' }>): boolean {
    return root.kind === 'project' ? this.trustedNow(root.projectKey) : this.deps.isTrusted(root.project);
  }

  private projectEntry(project: Project): Entry {
    const key = `project\0${project.key}`;
    const authority = authorityKeyOfProject(project.key);
    return this.entries.get(key) ?? this.added({ key, authority, root: { kind: 'project', projectKey: project.key }, holders: new Set(), server: undefined, started: undefined, port: undefined, origins: new Map(), trusted: this.deps.isTrusted(project), displayRoot: authority === LOCAL ? project.fsPath : undefined });
  }

  private designEntry(authority: string, designId: string): Entry {
    const key = designKey(authority, designId);
    return this.entries.get(key) ?? this.added({ key, authority, root: { kind: 'design', designId }, holders: new Set(), server: undefined, started: undefined, port: undefined, origins: new Map(), trusted: false, displayRoot: authority === LOCAL ? this.deps.localDesignFolder(designId) : undefined });
  }

  private added(entry: Entry): Entry {
    this.entries.set(entry.key, entry);
    return entry;
  }

  private async granted(entry: Entry, holder: string): Promise<ServedGrant> {
    const added = !entry.holders.has(holder);
    entry.holders.add(holder);
    const starting = this.start(entry);
    let server: PreviewHttpServer;
    try {
      server = await starting;
    } catch (err) {
      // a port that never opened is dropped, so the next grant tries again, and holds no room of the view's design roots
      if (entry.server === starting) entry.server = undefined;
      if (added) entry.holders.delete(holder);
      if (entry.holders.size === 0 && this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      throw err;
    }
    if (entry.server !== starting || !entry.holders.has(holder)) throw new Error('The served root was released while its server started');
    entry.started = server;
    const view = holder.startsWith(VIEW);
    const grant = server.grant(holder, view ? 'own' : 'loopback');
    if (view) entry.origins.set(holder, grant.origin);
    if (entry.port !== server.port) {
      entry.port = server.port;
      this.changed.fire(entry.authority);
    } else if (view) {
      this.changed.fire(entry.authority);
    }
    const root: ServedRoot = entry.root.kind === 'design' ? entry.root : { kind: entry.root.kind };
    return {
      origin: grant.origin,
      open: (relPath) => {
        if (servedPathRefusal(root, relPath) !== undefined) throw new Error('A served root opens only a path servedPathRefusal passed');
        return grant.openUrl(relPath);
      },
    };
  }

  private start(entry: Entry): Promise<PreviewHttpServer> {
    if (entry.server) return entry.server;
    const { root } = entry;
    const serve = root.kind === 'design'
      ? (request: Pick<PreviewRequest, 'method' | 'pathname'>): Promise<PreviewAnswer> => answerDesign(request, (relPath) => this.deps.designRead(entry.authority, root.designId, relPath), this.deps.log)
      : (request: Pick<PreviewRequest, 'method' | 'pathname' | 'range' | 'ifRange'>): Promise<PreviewAnswer> => answerPreview({ ...request, trusted: this.entryTrusted(root), target: 'browser' }, root.kind === 'project' ? this.reads(root.projectKey) : this.folderReads(root.project), this.deps.log);
    entry.server = PreviewHttpServer.start({
      serve,
      // a design server's own refusals are text and run nothing, so they carry the untrusted policy
      trusted: () => root.kind !== 'design' && this.entryTrusted(root),
      refusalText: this.deps.refusalText,
      log: this.deps.log,
    });
    return entry.server;
  }

  // The root's files, read only through its workspace's confinement.
  private reads(projectKey: string): PreviewFileReads {
    return {
      range: async (relativePath, offset, length) => {
        const project = this.projectOf(projectKey);
        if (!project) return { ok: false, reason: 'missing' };
        return this.deps.files(projectKey).readFileRange(project, relativePath, offset, length);
      },
    };
  }

  // A granted folder's files through its authority's workspace, while the folder's real path is still the one its core granted,
  // so a folder swapped for a link serves nothing.
  private folderReads(project: Project): PreviewFileReads {
    return {
      range: async (relativePath, offset, length) => {
        const files = this.deps.files(project.key);
        const root = await files.confineExisting(project, '');
        if (!root.ok || !samePath(root.path, project.fsPath)) return { ok: false, reason: root.ok ? 'outside' : root.reason };
        return files.readFileRange(project, relativePath, offset, length);
      },
    };
  }

  private releaseHolder(holder: string): void {
    for (const entry of [...this.entries.values()]) {
      if (!entry.holders.delete(holder)) continue;
      if (entry.holders.size === 0) {
        this.entries.delete(entry.key);
        this.closeServer(entry);
        continue;
      }
      entry.started?.revoke(holder);
      entry.origins.delete(holder);
      if (holder.startsWith(VIEW)) this.changed.fire(entry.authority);
    }
  }

  private closeServer(entry: Entry): void {
    const server = entry.server;
    const hadPort = entry.port !== undefined;
    entry.server = undefined;
    entry.started = undefined;
    entry.port = undefined;
    entry.origins.clear();
    // a start that failed is reported by the grant that awaited it
    server?.then((started) => started.close().catch((err: unknown) => this.deps.log(`[served-roots] closing a served root's port failed: ${errorText(err)}`)), () => undefined);
    if (hadPort) this.changed.fire(entry.authority);
  }
}
