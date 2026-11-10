// Which of a chat's roots a file:// address names (docs/invariants.md "Ports and the remote browser", "Browser"). The check
// is lexical: the server main runs re-checks the real path, and serves only roots main itself lists for the asking view.
import { folderIndexPath, hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { fileUrlPath, isFileUrl, servedToFile, withAddressParts, type RelayedServedFile, type ServedFile, type ServedFileAnswer } from '../../shared/served-file-url';

export interface ServedFileRoots {
  // the chat's project folder (a worktree chat's working folder); absent outside a project
  readonly project?: string;
  // the design folders the chat may see: a design chat's own (its agents' too), a main chat's linked one
  readonly designs: readonly { readonly designId: string; readonly folder: string }[];
}

const isWindowsPath = (root: string): boolean => /^[A-Za-z]:/.test(root) || root.includes('\\');

// The '/' separated path of `path` below `root`, when it is a relative file path that names the same entry on every OS; the
// root itself and a folder named with its trailing '/' name that folder's index.html, as the server reads them.
function relativeTo(root: string, path: string): string | undefined {
  const windows = isWindowsPath(root);
  const prefix = `${root.replace(/\\/g, '/').replace(/\/+$/, '')}/`;
  const named = path.length === prefix.length - 1 ? `${path}/` : path;
  const head = named.slice(0, prefix.length);
  if (windows ? head.toLowerCase() !== prefix.toLowerCase() : head !== prefix) return undefined;
  const relPath = folderIndexPath(named.slice(prefix.length));
  return isRelativeFilePath(relPath) && !hasUnsafeWindowsSegment(relPath) ? relPath : undefined;
}

/** The root file a file:// URL names, or 'outside' for a path below no root, a `..` or Windows-unsafe segment included. */
export function resolveServedFile(url: string, roots: ServedFileRoots): ServedFile | 'outside' {
  const path = fileUrlPath(url);
  if (path === undefined) return 'outside';
  // a design folder is checked first, so a project that holds one never serves it as project files
  for (const { designId, folder } of roots.designs) {
    const relPath = relativeTo(folder, path);
    if (relPath !== undefined) return { kind: 'design', designId, relPath };
  }
  const relPath = roots.project === undefined ? undefined : relativeTo(roots.project, path);
  return relPath === undefined ? 'outside' : { kind: 'project', relPath };
}

/** Why a remote chat's browser does not open a file:// path outside its roots, naming them. */
export function outsideRootsRefusal(roots: ServedFileRoots, path: string): string {
  const folders = roots.designs.map((design) => design.folder).join(', ');
  const project = roots.project;
  if (project !== undefined && folders !== '') return `This chat's browser opens files only from its project (${project}) and its design folder (${folders}); ${path} is outside them.`;
  if (project !== undefined) return `This chat's browser opens files only from its project (${project}); ${path} is outside it.`;
  if (folders !== '') return `This chat's browser opens files only from its design folder (${folders}); ${path} is outside it.`;
  return `This chat's browser opens files only from a project or a design folder, and this chat has neither; ${path} is not opened.`;
}

export const SERVED_FILES_CLIENT_TOO_OLD = 'Update the Damocles app on the user\'s computer to open project and design files in this chat\'s browser.';

function displayRootOf(file: ServedFile, roots: ServedFileRoots): string {
  if (file.kind === 'project') return roots.project!;
  return roots.designs.find((design) => design.designId === file.designId)!.folder;
}

export interface ChatServedFilesDeps {
  // read at each call, so a design started or linked later counts
  readonly roots: () => ServedFileRoots;
  // a local desktop chat: main's server for the file (Platform.browserServedFiles); absent elsewhere
  readonly serve?: (file: ServedFile) => Promise<ServedFileAnswer>;
}

/** A chat's roots and the served origins its pages were given, kept for the chat's life so every answer maps them back. */
export class ChatServedFiles {
  private readonly deps: ChatServedFilesDeps;
  // by root: the origin main last answered for it, so a server main restarted on another port replaces the old one
  private readonly origins = new Map<string, { readonly origin: string; readonly displayRoot: string }>();

  constructor(deps: ChatServedFilesDeps) {
    this.deps = deps;
  }

  /**
   * The address a local chat's BrowserOpen or BrowserNavigate loads: a root file's one-time served URL carrying the address's
   * query and fragment, anything else as given; a root file main has no server for (`unavailable`) opens from disk.
   */
  async localTarget(url: string): Promise<{ readonly url: string } | { readonly refused: string }> {
    const serve = this.deps.serve;
    if (!serve || fileUrlPath(url) === undefined) return { url };
    const roots = this.deps.roots();
    const file = resolveServedFile(url, roots);
    if (file === 'outside') return { url };
    const answer = await serve(file);
    if ('refused' in answer) return answer.unavailable === true ? { url } : { refused: answer.refused };
    this.origins.set(file.kind === 'project' ? 'project' : `design:${file.designId}`, { origin: answer.origin, displayRoot: displayRootOf(file, roots) });
    return { url: withAddressParts(answer.url, url) };
  }

  /**
   * A remote chat's file:// address: the root file the relay names, a refusal for one outside the roots or one no root can hold
   * (a UNC host, an encoded separator, a bad escape), undefined for any other URL.
   */
  relayed(url: string): RelayedServedFile | { readonly refused: string } | undefined {
    if (!isFileUrl(url)) return undefined;
    const roots = this.deps.roots();
    const path = fileUrlPath(url);
    if (path === undefined) return { refused: outsideRootsRefusal(roots, url) };
    const file = resolveServedFile(url, roots);
    if (file === 'outside') return { refused: outsideRootsRefusal(roots, path) };
    return { ...file, displayRoot: displayRootOf(file, roots) };
  }

  /** `text` with every served URL the chat's pages were given in file:// form. */
  toFile(text: string): string {
    return servedToFile(text, [...this.origins.values()]);
  }
}
