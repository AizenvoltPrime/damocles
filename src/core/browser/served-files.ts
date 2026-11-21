// Which of a chat's roots a file page names (docs/invariants.md "Ports and the remote browser", "Browser"). The check is lexical:
// the server that serves the root re-checks the real path, and desktop main serves only roots it lists itself for the asking view.
import * as os from 'node:os';
import { folderIndexPath, hasUnsafeWindowsSegment, isRelativeFilePath, isUnsafeWindowsName } from '../../shared/relative-path';
import { fileUrlPath, MAX_SERVED_FOLDERS_PER_CHAT, servedToFile, withAddressParts, type RelayedServedFile, type ServedFile, type ServedFileAnswer } from '../../shared/served-file-url';
import { dataStoreOf, dataStoresOf, storeHeldBy, wslDriveAlias, type DataStores, type StoreHost } from '../served-pages/data-stores';
import { hostDataStoresSync, warmHostDataStores } from '../served-pages/host-data-stores';
import { loadedFileUrl, UNPARSED_FILE_URL } from './loaded-file-url';

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

/** Why a chat's browser does not open a file page outside its roots and the folders the user allowed, naming the roots. */
export function outsideRootsRefusal(roots: ServedFileRoots, path: string): string {
  const folders = roots.designs.map((design) => design.folder).join(', ');
  const project = roots.project;
  const asked = 'Opening a page outside them asks the user to allow its folder for this chat; this one was not allowed.';
  if (project !== undefined && folders !== '') return `This chat's browser opens files from its project (${project}), its design folder (${folders}) and folders the user allowed; ${path} is outside them. ${asked}`;
  if (project !== undefined) return `This chat's browser opens files from its project (${project}) and folders the user allowed; ${path} is outside them. ${asked}`;
  if (folders !== '') return `This chat's browser opens files from its design folder (${folders}) and folders the user allowed; ${path} is outside them. ${asked}`;
  return `This chat's browser opens files from a project, a design folder or a folder the user allowed; ${path} is outside them. ${asked}`;
}

export const SERVED_FILES_CLIENT_TOO_OLD = 'Update the Damocles app on the user\'s computer to open project and design files in this chat\'s browser.';

export const SERVED_FOLDERS_CLIENT_TOO_OLD = 'Update the Damocles app on the user\'s computer to open files outside this chat\'s project and design folders in its browser.';

export const NO_SERVED_FILES_SERVER = 'No server serves this chat\'s project and design files here, so the browser opens none of them.';

const SHORT_NAME = /~\d/;

// '/' separators, no trailing one; a drive root keeps its 'C:'
const slashed = (path: string): string => path.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');

// whether `inner` is `outer` or lies below it, both slashed, case-blind for a Windows path
function within(inner: string, outer: string, windows: boolean): boolean {
  const [a, b] = windows ? [inner.toLowerCase(), outer.toLowerCase()] : [inner, outer];
  return a === b || a.startsWith(b.endsWith('/') ? b : `${b}/`);
}

/**
 * Why `folder` is never granted to a chat's browser, or undefined: a page there could read every file below it, so a root, the
 * home folder and any folder holding it, a folder inside or holding one of `stores` (dataStoreOf, storeHeldBy), a folder
 * Windows reads as another one, and a hidden folder (settings and keys: ~/.ssh, ~/.aws, ~/.damocles) are refused, telling the
 * agent to move the page. `allowShortNames`: the path is canonical, so an 8.3 segment is a real name; otherwise, and always on a
 * Windows drive WSL mounts (on WSL or through `\\wsl$`), whose realpath keeps a short name as spelled, any 8.3 segment is
 * refused, since it may alias a hidden folder. A Windows host judges a path into a WSL drive mount as that drive's path too.
 */
// eslint-disable-next-line damocles/no-sync -- the permission gate decides a page's folder synchronously; hostDataStoresSync resolves nothing on this call
export function folderGrantRefusal(folder: string, allowShortNames = false, home: string = os.homedir(), stores: DataStores = hostDataStoresSync()): string | undefined {
  const path = slashed(folder);
  const unc = /^\/\/([^/]+)(?:\/([^/]+))?(\/.*)?$/.exec(path);
  const drive = /^([A-Za-z]:)(\/.*)?$/.exec(path);
  const windows = unc !== null || drive !== null || folder.includes('\\');
  const move = 'Move the page into a subfolder and open it there.';
  if (unc && (unc[1] === '?' || unc[1] === '.')) return `${folder} is a device path, which Damocles never serves.`;
  const rest = unc ? (unc[2] === undefined ? undefined : unc[3]) : drive ? drive[2] : path;
  const segments = (rest ?? '').split('/').filter((segment) => segment !== '');
  const wslDrive = stores.platform === 'win32' ? wslDriveAlias(folder) : undefined;
  if (segments.length === 0 || (wslDrive !== undefined && slashed(wslDrive).length === 2)) return `${folder} is the root of a drive, share or file system, and a page there could read every file on it. ${move}`;
  if (windows) {
    const unsafe = segments.find(isUnsafeWindowsName);
    if (unsafe !== undefined) return `${folder} has a name Windows reads as another folder (${unsafe}), so it is not served. Move the page into a folder with plain names and open it there.`;
  }
  const onDrive = wslDrive !== undefined || (!windows && stores.drives.some((mount) => within(path, slashed(mount.mountPoint), false)));
  const hidden = segments.find((segment) => (segment.startsWith('.') && segment.toLowerCase() !== '.well-known') || ((!allowShortNames || onDrive) && SHORT_NAME.test(segment)));
  if (hidden !== undefined) return `${folder} is or lies inside a hidden folder (${hidden}), where settings and keys are kept, so it is not served. Move the page into another folder and open it there.`;
  if ([path, wslDrive].some((spelled) => spelled !== undefined && within(slashed(home), slashed(spelled), windows))) return `${folder} is the user's home folder or holds it, and a page there could read every file in it. ${move}`;
  const inside = dataStoreOf(folder, stores);
  if (inside !== undefined) return `${folder} is or lies inside ${inside}, where applications or the system keep their data, so it is not served. Move the page into a folder outside it and open it there.`;
  const held = storeHeldBy(folder, stores);
  if (held === undefined) return undefined;
  const kept = stores.stores.includes(held) ? 'where applications or the system keep their data' : 'a folder where Windows keeps application or system data';
  return `${folder} holds ${held}, ${kept}, and a page there could read every file in it. ${move}`;
}

// a native spelling of a slashed path on the machine whose files it names
function native(path: string): string {
  const windows = /^[A-Za-z]:/.test(path) || (path.startsWith('//') && process.platform === 'win32');
  if (!windows) return path === '' ? '/' : path;
  return /^[A-Za-z]:$/.test(path) ? `${path}\\` : path.replace(/\//g, '\\');
}

/** A file page the permission gate asks about: the file and its folder, natively spelled; or why that folder is never granted. */
export type FolderAsk = { readonly file: string; readonly folder: string } | { readonly refused: string };

// a folder the gate granted: matched by the spelling the card named, served from its canonical root
interface FolderGrant {
  readonly spelled: string;
  readonly root: string;
}

function displayRootOf(file: ServedFile, roots: ServedFileRoots): string {
  if (file.kind === 'project') return roots.project!;
  if (file.kind === 'folder') return file.folder;
  return roots.designs.find((design) => design.designId === file.designId)!.folder;
}

// A file page resolved against the roots: the root file with its root's path and the file: URL Chrome would load, or why not.
type ResolvedFilePage = { readonly file: ServedFile; readonly displayRoot: string; readonly address: string } | { readonly refused: string };

export interface ChatServedFilesDeps {
  // read at each call, so a design started or linked later counts
  readonly roots: () => ServedFileRoots;
  // a chat whose browser runs beside its core (Platform.browserServedFiles): the server of the file's root, whose path is root;
  // absent for a remote chat, whose client serves its roots (relayed)
  readonly serve?: (file: ServedFile, root: string) => Promise<ServedFileAnswer>;
  // a remote chat, whose BrowserOpen and BrowserNavigate the client showing it serves (relayed)
  readonly relayed?: true;
  // the machine whose home folder and data stores a grant is judged against; this core's own (hostDataStoresSync) when absent
  readonly host?: StoreHost;
}

/** A chat's roots, the folders the user allowed, and the served origins its pages were given, kept for the chat's life. */
export class ChatServedFiles {
  private readonly deps: ChatServedFilesDeps;
  // by root: the origin its server last answered, so a server that restarted on another port replaces the old one
  private readonly origins = new Map<string, { readonly origin: string; readonly displayRoot: string }>();
  // the folders the permission gate granted this chat, never saved
  private readonly folders: FolderGrant[] = [];

  constructor(deps: ChatServedFilesDeps) {
    this.deps = deps;
    // a grant judged before this core's data stores resolve compares them only as spelled
    if (deps.host === undefined) warmHostDataStores();
  }

  /**
   * The address a chat's BrowserOpen, BrowserNavigate or BrowserTabs loads: for a file page (every spelling the permission gate
   * reads as one, `loadedFileUrl`) the root file's one-time served URL carrying the address's query and fragment, or why it is
   * not opened; any other address as given. No file page ever opens from disk.
   */
  async localTarget(url: string): Promise<{ readonly url: string } | { readonly refused: string }> {
    const page = this.resolve(url, true);
    if (page === undefined) return { url };
    return 'refused' in page ? page : this.served(page);
  }

  /**
   * The address a saved page's file:// address reopens at after a restart: the root file's one-time served URL carrying its
   * query and fragment, or why it does not reopen. Saved addresses are page-controlled and grants are never saved, so only the
   * project and design roots resolve, and nothing here ever opens from disk.
   */
  async restoreTarget(url: string): Promise<{ readonly url: string } | { readonly refused: string }> {
    const page = this.resolve(url, false);
    if (page === undefined || 'refused' in page) return { refused: 'its address is outside the chat\'s project and design folders' };
    return this.served(page);
  }

  /** A remote chat's file page: the root file the relay names, why it is not opened, or undefined for any other URL. */
  relayed(url: string): RelayedServedFile | { readonly refused: string } | undefined {
    const page = this.resolve(url, true);
    if (page === undefined || 'refused' in page) return page;
    return { ...page.file, displayRoot: page.displayRoot };
  }

  /**
   * What the permission gate asks for a BrowserOpen, BrowserNavigate or BrowserTabs new tab of url: a file page outside the roots
   * and every granted folder, which this chat's browser can serve, names its file and folder, or why that folder is never
   * granted; undefined for anything else, which the tool opens or refuses unasked.
   */
  folderAsk(tool: string, url: string): FolderAsk | undefined {
    if (!this.deps.serve && !this.deps.relayed) return undefined;
    // a remote chat's new tab opens no file (REMOTE_TAB_FILE_REFUSAL)
    if (this.deps.relayed && tool === 'BrowserTabs') return undefined;
    const loaded = loadedFileUrl(url);
    if (loaded === undefined || loaded === UNPARSED_FILE_URL) return undefined;
    const path = fileUrlPath(loaded.href);
    if (path === undefined || resolveServedFile(loaded.href, this.deps.roots()) !== 'outside' || this.grantOf(path) !== undefined) return undefined;
    const cut = path.lastIndexOf('/');
    const folder = path.slice(0, cut);
    const name = folderIndexPath(path.slice(cut + 1));
    if (!isRelativeFilePath(name) || hasUnsafeWindowsSegment(name)) return undefined;
    // short names pass here: the gate checks the canonical folder, or this spelling with them refused where it cannot resolve it
    const refusal = this.grantRefusal(native(folder), true);
    if (refusal !== undefined) return { refused: refusal };
    if (this.folders.length >= MAX_SERVED_FOLDERS_PER_CHAT) return { refused: `This chat's browser already serves ${MAX_SERVED_FOLDERS_PER_CHAT} folders outside its project, the most one chat may open.` };
    return { file: native(`${folder}/${name}`), folder: native(folder) };
  }

  /** The file a file page of url names under a folder this chat was granted, natively spelled; undefined for any other url. */
  grantedFile(url: string): string | undefined {
    const loaded = loadedFileUrl(url);
    if (loaded === undefined || loaded === UNPARSED_FILE_URL) return undefined;
    const path = fileUrlPath(loaded.href);
    if (path === undefined || resolveServedFile(loaded.href, this.deps.roots()) !== 'outside') return undefined;
    const held = this.grantOf(path);
    return held === undefined ? undefined : native(`${slashed(held.grant.root)}/${held.relPath}`);
  }

  /** Why `folder` is never granted to this chat (`folderGrantRefusal` against the host's home folder and data stores). */
  grantRefusal(folder: string, allowShortNames: boolean): string | undefined {
    const { host } = this.deps;
    return host === undefined ? folderGrantRefusal(folder, allowShortNames) : folderGrantRefusal(folder, allowShortNames, host.home, dataStoresOf(host));
  }

  /** The permission gate let a call run whose page lies in `spelled`, the folder its card named: `root`, its canonical path, is served to this chat. */
  grant(spelled: string, root: string = spelled): void {
    if (!this.folders.some((held) => held.spelled === spelled && held.root === root)) this.folders.push({ spelled, root });
  }

  /** `text` with every served URL the chat's pages were given in file:// form. */
  toFile(text: string): string {
    return servedToFile(text, [...this.origins.values()]);
  }

  /** Whether `origin` is the live origin of a root or granted folder this chat's pages were served from. */
  ownsOrigin(origin: string): boolean {
    for (const held of this.origins.values()) if (held.origin === origin) return true;
    return false;
  }

  private grantOf(path: string): { readonly grant: FolderGrant; readonly relPath: string } | undefined {
    for (const grant of this.folders) {
      const relPath = relativeTo(grant.spelled, path) ?? relativeTo(grant.root, path);
      if (relPath !== undefined) return { grant, relPath };
    }
    return undefined;
  }

  // A file page outside the roots and, when `granted`, every granted folder, or one no root can hold (a file: text the parser
  // rejects, an encoded separator, a bad escape), is refused naming the roots.
  private resolve(url: string, granted: boolean): ResolvedFilePage | undefined {
    const loaded = loadedFileUrl(url);
    if (loaded === undefined) return undefined;
    const roots = this.deps.roots();
    const address = loaded === UNPARSED_FILE_URL ? undefined : loaded.href;
    const path = address === undefined ? undefined : fileUrlPath(address);
    if (address === undefined || path === undefined) return { refused: outsideRootsRefusal(roots, url) };
    const file = resolveServedFile(address, roots);
    if (file !== 'outside') return { file, displayRoot: displayRootOf(file, roots), address };
    const held = granted ? this.grantOf(path) : undefined;
    if (held === undefined) return { refused: outsideRootsRefusal(roots, path) };
    return { file: { kind: 'folder', folder: held.grant.root, relPath: held.relPath }, displayRoot: held.grant.root, address };
  }

  private async served(page: Extract<ResolvedFilePage, { file: ServedFile }>): Promise<{ readonly url: string } | { readonly refused: string }> {
    const serve = this.deps.serve;
    if (!serve) return { refused: NO_SERVED_FILES_SERVER };
    const answer = await serve(page.file, page.displayRoot);
    if ('refused' in answer) return { refused: answer.refused };
    const key = page.file.kind === 'project' ? 'project' : page.file.kind === 'design' ? `design:${page.file.designId}` : `folder:${page.file.folder}`;
    this.origins.set(key, { origin: answer.origin, displayRoot: page.displayRoot });
    return { url: withAddressParts(answer.url, page.address) };
  }
}
