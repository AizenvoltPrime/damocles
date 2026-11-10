// The loopback servers that serve a root's files to a browser (docs/invariants.md "Ports and the remote browser", "Desktop
// host"): one per (authority, root), granted to chat views (the agent's browser) and HTML preview tabs (Open in Browser),
// closed with its last grant. Every server keeps PreviewHttpServer's checks; a root is never a path a core names.
import { servedContentType, servedHeaders } from '../../../core/design/serve-policy';
import type { Disposable } from '../../../platform/disposable';
import { isDesignId } from '../../../shared/design-paths';
import { listeners } from '../../../remote/listeners';
import { authorityKeyOfProject } from '../../../shared/project-location';
import type { DesignPreviewFile } from '../../../shared/types/design';
import type { Project } from '../../local-services/confine';
import type { WorkspaceFileSystem } from '../../workspace/file-system';
import { loggableUrl } from '../security';
import { NotConnectedError } from '../workspace/workspaces';
import { answerPreview, type PreviewAnswer, type PreviewFileReads, type PreviewRequest } from './preview-reader';
import { PreviewHttpServer } from './preview-http-server';
import { isServablePreviewPath, previewRequestPath } from './serve-policy';

export type ServedRoot = { readonly kind: 'project' } | { readonly kind: 'design'; readonly designId: string };

export interface ServedGrant {
  // http://127.0.0.1:<port>
  readonly origin: string;
  // a one-time URL that opens relPath, which must pass servedPathRefusal first
  open(relPath: string): string;
}

export interface ServedRootsDeps {
  // the project root a chat view of the authority works in, from main's own roots; undefined when it has none main lists
  readonly projectOfView: (authority: string, viewId: string) => Project | undefined;
  // every root main lists (the open projects and their live chat worktrees), read at each request
  readonly projects: () => readonly Project[];
  // the root's workspace files (workspaces.forProject): this computer's disk, or the authority's workspace; throws
  // NotConnectedError while its host is away
  readonly files: (rootKey: string) => Pick<WorkspaceFileSystem, 'readFileRange'>;
  readonly isTrusted: (project: Project) => boolean;
  // design.read on the authority's own core, which reads only a design one of its chats holds
  readonly designRead: (authority: string, designId: string, relPath: string) => Promise<DesignPreviewFile | 'tooLarge' | undefined>;
  // "Open this preview from Damocles.", in main's language
  readonly refusalText: () => string;
  readonly log: (line: string) => void;
}

type EntryRoot = { readonly kind: 'project'; readonly projectKey: string } | { readonly kind: 'design'; readonly designId: string };

interface Entry {
  readonly key: string;
  readonly authority: string;
  readonly root: EntryRoot;
  // view:<viewId> and preview:<rootKey>
  readonly holders: Set<string>;
  server: Promise<PreviewHttpServer> | undefined;
  port: number | undefined;
  // the trust its server was started with; a project only
  trusted: boolean;
  // the root's path on its machine as a remote core named it, for its answers' text only
  displayRoot: string | undefined;
}

// a chat sees its own design and its linked one; the rest of the room absorbs a role change during the view's life
export const MAX_DESIGN_ROOTS_PER_VIEW = 4;

const VIEW = 'view:';
const designKey = (authority: string, designId: string): string => `design\0${authority}\0${designId}`;
const viewHolder = (viewId: string): string => `${VIEW}${viewId}`;
const previewHolder = (rootKey: string): string => `preview:${rootKey}`;
const originOf = (port: number): string => `http://127.0.0.1:${port}`;

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Why a root's file is never served, as the agent reads it; undefined when it is served. */
export function servedPathRefusal(root: ServedRoot, relPath: string): string | undefined {
  if (!isServablePreviewPath(relPath)) return `${relPath} is not opened: files and folders whose names start with a dot, keys, certificates and 8.3 short names are never served.`;
  if (root.kind === 'design' && servedContentType(relPath) === undefined) return `${relPath} is not opened: a design folder serves only pages, styles, scripts, JSON, images, fonts and text.`;
  return undefined;
}

/** GET or HEAD of one design file: core's bytes with the design's fidelity CSP, 404 with no bytes for anything refused. */
export async function answerDesign(request: Pick<PreviewRequest, 'method' | 'pathname'>, read: (relPath: string) => Promise<DesignPreviewFile | 'tooLarge' | undefined>, log: (line: string) => void): Promise<PreviewAnswer> {
  const empty = (status: number, extra: Record<string, string> = {}): PreviewAnswer => ({ status, headers: { ...servedHeaders(null), ...extra } });
  if (request.method !== 'GET' && request.method !== 'HEAD') return empty(405, { Allow: 'GET, HEAD' });
  const path = previewRequestPath(request.pathname);
  const type = path === undefined ? undefined : servedContentType(path.relativePath);
  if (!path || type === undefined) return empty(404);
  let file: DesignPreviewFile | 'tooLarge' | undefined;
  try {
    file = await read(path.relativePath);
  } catch (err) {
    if (err instanceof NotConnectedError) return { status: 503, headers: { ...servedHeaders(null), 'Content-Type': 'text/plain; charset=utf-8' }, body: err.message };
    log(`[served-roots] reading the design file ${loggableUrl(path.relativePath)} failed: ${errorText(err)}`);
    return empty(500);
  }
  if (file === undefined || file === 'tooLarge') return empty(404);
  const bytes = file.bytes;
  const headers = { ...servedHeaders(file.fidelity), 'Content-Type': type, 'Content-Length': String(bytes.byteLength) };
  return request.method === 'HEAD' ? { status: 200, headers } : { status: 200, headers, body: (async function* () { yield bytes; })() };
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
  async grant(request: { readonly authority: string; readonly root: ServedRoot; readonly viewId: string; readonly displayRoot?: string }): Promise<ServedGrant | { readonly refused: string; readonly unavailable?: boolean }> {
    let entry: Entry;
    if (request.root.kind === 'project') {
      const project = this.deps.projectOfView(request.authority, request.viewId);
      if (!project || authorityKeyOfProject(project.key) !== request.authority) return { refused: 'This chat\'s project is not open in Damocles on this computer, so its files are not served.', unavailable: true };
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

  /** origin -> displayRoot of the authority's granted roots whose remote core named their path. */
  mappings(authority: string): Array<{ readonly origin: string; readonly displayRoot: string }> {
    return this.viewEntries(authority).flatMap((entry) => (entry.displayRoot === undefined ? [] : [{ origin: originOf(entry.port!), displayRoot: entry.displayRoot }]));
  }

  /** Trust may have changed: a project root that lost it closes its server, so its pages stop running scripts and reading it. */
  trustChanged(): void {
    for (const entry of this.entries.values()) {
      if (entry.root.kind !== 'project') continue;
      const trusted = this.trustedNow(entry.root.projectKey);
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

  private projectEntry(project: Project): Entry {
    const key = `project\0${project.key}`;
    return this.entries.get(key) ?? this.added({ key, authority: authorityKeyOfProject(project.key), root: { kind: 'project', projectKey: project.key }, holders: new Set(), server: undefined, port: undefined, trusted: this.deps.isTrusted(project), displayRoot: undefined });
  }

  private designEntry(authority: string, designId: string): Entry {
    const key = designKey(authority, designId);
    return this.entries.get(key) ?? this.added({ key, authority, root: { kind: 'design', designId }, holders: new Set(), server: undefined, port: undefined, trusted: false, displayRoot: undefined });
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
    if (entry.port !== server.port) {
      entry.port = server.port;
      this.changed.fire(entry.authority);
    } else if (holder.startsWith(VIEW)) {
      this.changed.fire(entry.authority);
    }
    const root: ServedRoot = entry.root.kind === 'project' ? { kind: 'project' } : entry.root;
    return {
      origin: originOf(server.port),
      open: (relPath) => {
        if (servedPathRefusal(root, relPath) !== undefined) throw new Error('A served root opens only a path servedPathRefusal passed');
        return server.openUrl(relPath);
      },
    };
  }

  private start(entry: Entry): Promise<PreviewHttpServer> {
    if (entry.server) return entry.server;
    const { root } = entry;
    const serve = root.kind === 'project'
      ? (request: Pick<PreviewRequest, 'method' | 'pathname' | 'range' | 'ifRange'>): Promise<PreviewAnswer> => answerPreview({ ...request, trusted: this.trustedNow(root.projectKey), target: 'browser' }, this.reads(root.projectKey), this.deps.log)
      : (request: Pick<PreviewRequest, 'method' | 'pathname'>): Promise<PreviewAnswer> => answerDesign(request, (relPath) => this.deps.designRead(entry.authority, root.designId, relPath), this.deps.log);
    entry.server = PreviewHttpServer.start({
      serve,
      // a design server's own refusals are text and run nothing, so they carry the untrusted policy
      trusted: () => root.kind === 'project' && this.trustedNow(root.projectKey),
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

  private releaseHolder(holder: string): void {
    for (const entry of [...this.entries.values()]) {
      if (!entry.holders.delete(holder)) continue;
      if (entry.holders.size === 0) {
        this.entries.delete(entry.key);
        this.closeServer(entry);
      } else if (holder.startsWith(VIEW)) {
        this.changed.fire(entry.authority);
      }
    }
  }

  private closeServer(entry: Entry): void {
    const server = entry.server;
    const hadPort = entry.port !== undefined;
    entry.server = undefined;
    entry.port = undefined;
    // a start that failed is reported by the grant that awaited it
    server?.then((started) => started.close().catch((err: unknown) => this.deps.log(`[served-roots] closing a served root's port failed: ${errorText(err)}`)), () => undefined);
    if (hadPort) this.changed.fire(entry.authority);
  }
}
