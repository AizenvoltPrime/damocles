import type { Disposable } from '../../../platform/disposable';
import { LocalizedError } from '../../../shared/localized-text';
import { isRelativeFilePath } from '../../../shared/relative-path';
import { visibleText } from '../../../shared/visible-text';
import { pathFor } from '../../../shared/project-location';
import { isValidFileName } from '../../preload/file-names';
import type {
  FileEntry,
  FilesChanged,
  FilesDeleteResult,
  FilesListResult,
  FilesMutationResult,
} from '../../preload/shell-channels';
import type { AskMessage } from '../message-dialog';
import { isRelativeOrRoot, type LinkRoot, type Project } from '../../local-services/confine';
import { WriteRefusedError, type EntryIdentity, type EntryResult, type WorkspaceFileSystem } from '../../workspace/file-system';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { linuxToWslUnc } from '../remote/wsl/wsl-paths';
import { literalGlob } from '../../../core/watch-root';
import { excludeTest, type ExcludeTest, type FolderListing } from '../../workspace/tree-listing';
import { NotConnectedError, type Workspaces } from '../workspace/workspaces';

// Bursts of watcher events (a checkout, a build) reach the shell as one change per this window.
const CHANGE_BATCH_MS = 100;

export interface FileTreeDeps {
  readonly projects: () => readonly Project[];
  // damocles.desktop.files.exclude: glob to true (hidden) or false
  readonly exclude: () => Readonly<Record<string, unknown>>;
  readonly workspaces: Workspaces;
  readonly ask: AskMessage;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  readonly reveal: (absolutePath: string) => Promise<void>;
  readonly copy: (text: string) => Promise<void>;
  readonly changed: (change: FilesChanged) => void;
  // the listed entries git ignores (source control's check-ignore); none, and no git, in an untrusted project
  readonly ignored: (projectKey: string, relativeDir: string, entries: readonly FileEntry[]) => Promise<ReadonlySet<string>>;
  // the OS a project's files are on, and for a project on another authority the host's name
  readonly target: (projectKey: string) => FilesTarget;
}

export interface FilesTarget {
  readonly os: NodeJS.Platform;
  readonly host?: string;
  // a WSL distro's project, whose folders this computer reaches under \\wsl.localhost\<distro>
  readonly wslDistro?: string;
}

// Copy path and Reveal: a cancel never happens, every other failure is reported as a delete's is.
export type FilesActionResult = FilesDeleteResult;

const fileNameCollator = new Intl.Collator(undefined, { numeric: true });

// VS Code's default explorer order (explorer.sortOrder "default", compareFileNamesDefault): folders first, then a numeric
// collation, the shorter name first among names it ranks equal.
export function compareEntries(a: Pick<FileEntry, 'kind' | 'name'>, b: Pick<FileEntry, 'kind' | 'name'>): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const result = fileNameCollator.compare(a.name, b.name);
  if (result !== 0) return result;
  return a.name.length - b.name.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A failure the workspace reported, as the shell reports it: a failed fs call names its error, a confinement its refusal.
function failed(result: Exclude<EntryResult, { readonly ok: true }>, log: (line: string) => void, action: string): FilesMutationResult & { ok: false } {
  if (result.reason !== 'failed' || result.message === undefined) {
    return { ok: false, reason: result.reason, ...(result.refusal !== undefined ? { refusal: result.refusal } : {}), ...(result.error !== undefined ? { error: result.error } : {}) };
  }
  log(`[files] ${action} failed: ${result.message}`);
  return { ok: false, reason: 'failed', message: result.message };
}

function joinRelative(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? '' : relativePath.slice(0, slash);
}

// A folder with a listing in flight or a link watch; one with neither has no record, so records stay within the folders
// shown expanded plus those being listed.
interface FolderRecord {
  // listings asked and not yet answered
  inFlight: number;
  // the number of the newest listing asked
  asked: number;
  // an answer to a listing numbered at most this watches nothing: an older one applied, or the folder collapsed after it was asked
  settled: number;
  // the link root the folder's applied listing went through, and the folder's own non-recursive watch there
  linked: { readonly via: LinkRoot; watch: Disposable } | undefined;
}

interface Watched {
  // a remote workspace's watch ends with its connection, so the next connection's workspace watches again
  workspace: ProjectWorkspace;
  watcher: Disposable;
  readonly pending: Set<string>;
  timer: NodeJS.Timeout | undefined;
  readonly folders: Map<string, FolderRecord>;
}

/** The Files section's data: lazy listings and confined operations, every path resolved inside its project in main. */
export class FileTree implements Disposable {
  private readonly deps: FileTreeDeps;
  private readonly watched = new Map<string, Watched>();
  private readonly structureListeners = new Set<(projectKey: string) => void>();
  private excludeKey = '';
  private excludeMatcher: ExcludeTest = () => false;

  constructor(deps: FileTreeDeps) {
    this.deps = deps;
  }

  /** Fires when an entry of the project is created or deleted (not when a file's content changes). */
  onDidChangeStructure(listener: (projectKey: string) => void): Disposable {
    this.structureListeners.add(listener);
    return { dispose: () => this.structureListeners.delete(listener) };
  }

  /** Whether files.exclude hides relativePath or a folder above it. */
  isExcluded(relativePath: string): boolean {
    return this.matcher()(relativePath);
  }

  /** The exclude patterns hidden now, for Quick Open's ripgrep globs. */
  excludePatterns(): string[] {
    return Object.entries(this.deps.exclude()).filter(([, hidden]) => hidden === true).map(([glob]) => glob);
  }

  /** files.exclude changed: every listing of every watched project may have changed. */
  excludeChanged(): void {
    for (const projectKey of this.watched.keys()) this.deps.changed({ projectKey, relativeDirs: [] });
  }

  async list(projectKey: string, relativeDir: string): Promise<FilesListResult> {
    const project = this.project(projectKey);
    if (!project || !isRelativeOrRoot(relativeDir)) return { ok: false, reason: 'outside' };
    const answered = relativeDir !== '' && this.watch(project) ? this.asking(project.key, relativeDir) : undefined;
    // a host that is not connected, or whose connection ends during the call, fails this listing only
    const listing = await Promise.resolve()
      .then(() => this.deps.workspaces.forProject(projectKey).tree.list(project, relativeDir, this.excludePatterns()))
      .catch((err: unknown): FolderListing => {
        this.deps.log(`[files] listing ${relativeDir || '.'} of ${project.name} failed: ${errorText(err)}`);
        return { ok: false, reason: 'failed' };
      });
    answered?.(listing);
    if (!listing.ok) return listing;
    if (relativeDir === '') this.watch(project);
    const { entries } = listing;
    const ignored = await this.deps.ignored(projectKey, relativeDir, entries).catch((err: unknown) => {
      this.deps.log(`[files] the ignored-file query failed: ${errorText(err)}`);
      return new Set<string>();
    });
    return { ok: true, entries: entries.map((entry) => (ignored.has(entry.name) ? { ...entry, ignored: true as const } : entry)).sort(compareEntries) };
  }

  async create(projectKey: string, relativeDir: string, name: unknown, kind: 'file' | 'dir'): Promise<FilesMutationResult> {
    const project = this.project(projectKey);
    if (!project || !isRelativeOrRoot(relativeDir)) return { ok: false, reason: 'outside' };
    if (!isValidFileName(name, this.deps.target(projectKey).os)) return { ok: false, reason: 'invalidName' };
    const created = await this.files(projectKey).createEntry(project, relativeDir, name, kind);
    if (!created.ok) return failed(created, this.deps.log, `creating ${name}`);
    return { ok: true, relativePath: joinRelative(relativeDir, name) };
  }

  async rename(projectKey: string, relativePath: string, newName: unknown): Promise<FilesMutationResult> {
    const project = this.project(projectKey);
    if (!project || !isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
    if (!isValidFileName(newName, this.deps.target(projectKey).os)) return { ok: false, reason: 'invalidName' };
    const renamed = await this.files(projectKey).renameEntry(project, relativePath, newName);
    if (!renamed.ok) return failed(renamed, this.deps.log, `renaming ${relativePath}`);
    return { ok: true, relativePath: joinRelative(parentOf(relativePath), newName) };
  }

  /**
   * Asks first, then moves the entry itself (a link, never what it points to) to the OS trash. When the trash fails, the
   * user may delete it permanently instead, after a second confirmation (fileActions.ts deleteFiles).
   */
  async delete(projectKey: string, relativePath: string): Promise<FilesDeleteResult> {
    const project = this.project(projectKey);
    if (!project || !isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
    const files = this.files(projectKey);
    const entry = await files.entry(project, relativePath);
    if (!entry.ok) return entry;
    // refused before the question; trash and deleteEntry refuse again when they run
    if (entry.sessionStore) return { ok: false, reason: 'sessionFile' };
    const { identity, folder } = entry;
    const target = this.deps.target(projectKey);
    const name = visibleText(pathFor(target).basename(entry.path));
    const question = folder ? this.deps.t('Are you sure you want to delete the folder \'{0}\' and its contents?', name) : this.deps.t('Are you sure you want to delete \'{0}\'?', name);
    // a remote host has no trash Damocles can reach, so its delete is permanent and says so
    if (target.host !== undefined) {
      const permanently = await this.deps.ask({
        severity: 'danger',
        message: question,
        detail: this.deps.t('It is deleted permanently on {0}, which has no trash. This action is irreversible.', target.host),
        actions: [this.deps.t('Delete Permanently')],
        cancelLabel: this.deps.t('Cancel'),
      });
      return permanently === 0 ? this.deletePermanently(project, relativePath, identity) : { ok: false, reason: 'cancelled' };
    }
    const choice = await this.deps.ask({
      severity: 'danger',
      message: question,
      detail: this.deps.t('You can restore it from the trash.'),
      actions: [this.deps.t('Move to Trash')],
      cancelLabel: this.deps.t('Cancel'),
    });
    if (choice !== 0) return { ok: false, reason: 'cancelled' };
    try {
      await files.trash(entry.path);
      return { ok: true };
    } catch (err) {
      // a permanent delete would be refused too, so none is offered
      if (err instanceof WriteRefusedError && err.refusal === 'sessionFile') {
        this.deps.log(`[files] refused to move ${relativePath} to the trash: ${errorText(err)}`);
        return { ok: false, reason: 'sessionFile' };
      }
      this.deps.log(`[files] moving ${relativePath} to the trash failed: ${errorText(err)}`);
      const permanently = await this.deps.ask({
        severity: 'danger',
        message: this.deps.t('\'{0}\' could not be moved to the trash. Do you want to delete it permanently instead?', name),
        detail: `${visibleText(errorText(err))}\n\n${this.deps.t('This action is irreversible.')}`,
        actions: [this.deps.t('Delete Permanently')],
        cancelLabel: this.deps.t('Cancel'),
      });
      if (permanently !== 0) return { ok: false, reason: 'cancelled' };
    }
    return this.deletePermanently(project, relativePath, identity);
  }

  // Only the entry the user confirmed: one that another replaced while the questions showed is left alone.
  private async deletePermanently(project: Project, relativePath: string, confirmed: EntryIdentity): Promise<FilesDeleteResult> {
    const deleted = await this.files(project.key).deleteEntry(project, relativePath, confirmed);
    if (deleted.ok) return deleted;
    if (deleted.reason === 'changed') return { ok: false, reason: 'failed', message: this.deps.t('It changed while Damocles was asking.') };
    if (deleted.reason === 'failed' && deleted.message !== undefined) this.deps.log(`[files] deleting ${relativePath} failed: ${deleted.message}`);
    return {
      ok: false,
      reason: deleted.reason,
      ...(deleted.message !== undefined ? { message: deleted.message } : {}),
      ...(deleted.refusal !== undefined ? { refusal: deleted.refusal } : {}),
      ...(deleted.error !== undefined ? { error: deleted.error } : {}),
    };
  }

  async copyPath(projectKey: string, relativePath: string, relative: boolean): Promise<FilesActionResult> {
    const project = this.project(projectKey);
    if (!project) return { ok: false, reason: 'missing' };
    if (!isRelativeOrRoot(relativePath)) return { ok: false, reason: 'outside' };
    const segments = relativePath === '' ? [] : relativePath.split('/');
    const flavor = pathFor(this.deps.target(projectKey));
    return this.attempt('copying the path of', relativePath, () => this.deps.copy(relative ? segments.join(flavor.sep) : flavor.join(project.fsPath, ...segments)));
  }

  async reveal(projectKey: string, relativePath: string): Promise<FilesActionResult> {
    const project = this.project(projectKey);
    if (!project) return { ok: false, reason: 'missing' };
    // a path a daemon names is never handed to this computer's file manager, except a WSL distro's through \\wsl.localhost
    const target = this.deps.target(projectKey);
    const notHere: FilesActionResult = { ok: false, reason: 'failed', message: this.deps.t('The folder is not on this computer.') };
    if (target.host !== undefined && target.wslDistro === undefined) return notHere;
    const shown = (targetPath: string): string | undefined => (target.wslDistro === undefined ? targetPath : linuxToWslUnc(target.wslDistro, targetPath));
    if (relativePath === '') {
      const root = shown(project.fsPath);
      return root === undefined ? notHere : this.attempt('revealing', relativePath, () => this.deps.reveal(root));
    }
    const entry = await this.files(projectKey).entry(project, relativePath).catch((): { ok: false; reason: 'failed' } => ({ ok: false, reason: 'failed' }));
    if (!entry.ok) return entry;
    const at = shown(entry.path);
    return at === undefined ? notHere : this.attempt('revealing', relativePath, () => this.deps.reveal(at));
  }

  private async attempt(action: string, relativePath: string, run: () => Promise<void>): Promise<FilesActionResult> {
    try {
      await run();
      return { ok: true };
    } catch (err) {
      // thrown on whole, so its text renders in the user's language, which a message string here would not
      if (err instanceof LocalizedError) throw err;
      this.deps.log(`[files] ${action} ${relativePath} failed: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: errorText(err) };
    }
  }

  /**
   * Starts watching a project for Files and Quick Open, and says whether it is watched; a project whose host is not connected
   * is not, and a later call tries again. A project that left the list stops.
   */
  watch(project: Project): boolean {
    let workspace: ProjectWorkspace;
    try {
      workspace = this.deps.workspaces.forProject(project.key);
    } catch (err) {
      if (err instanceof NotConnectedError) return false;
      throw err;
    }
    const known = this.watched.get(project.key);
    if (known?.workspace === workspace) return true;
    known?.watcher.dispose();
    const state: Watched = known ?? { workspace, watcher: { dispose: () => undefined }, pending: new Set(), timer: undefined, folders: new Map() };
    state.workspace = workspace;
    const watcher = workspace.files.watch(project.fsPath, '**', (event) => {
      if (event.kind !== 'change') this.record(project, state, event.path);
    });
    state.watcher = watcher;
    this.watched.set(project.key, state);
    this.deps.log(`[files] watching ${project.fsPath}`);
    for (const [dir, record] of state.folders) {
      if (!record.linked) continue;
      record.linked.watch.dispose();
      record.linked.watch = this.watchLinked(project.key, state, dir, record.linked.via);
    }
    // what changed before the watch was ready, while the host was away included, was never reported
    void watcher.ready.then(() => {
      if (this.watched.get(project.key) !== state || state.watcher !== watcher) return;
      this.deps.log(`[files] the watch of ${project.fsPath} is live`);
      this.refetch(project.key);
    });
    return true;
  }

  /** A host connected or went away: each watched project whose host now serves a new connection is watched over it. */
  connectionsChanged(): void {
    for (const project of this.deps.projects()) if (this.watched.has(project.key)) this.watch(project);
  }

  /** Stops watching projects that are no longer in the list. */
  projectsChanged(): void {
    const keys = new Set(this.deps.projects().map((project) => project.key));
    for (const [key, state] of this.watched) {
      if (keys.has(key)) continue;
      state.watcher.dispose();
      this.unwatchFolders(state);
      if (state.timer) clearTimeout(state.timer);
      this.watched.delete(key);
    }
  }

  /** The tree stopped showing a folder expanded: neither it nor any folder under it is watched through a link any more. */
  collapsed(projectKey: string, relativeDir: string): void {
    const state = this.watched.get(projectKey);
    if (!state) return;
    for (const [dir, record] of state.folders) {
      if (dir !== relativeDir && !dir.startsWith(`${relativeDir}/`)) continue;
      this.unlink(dir, record);
      if (record.inFlight > 0) record.settled = record.asked;
      else state.folders.delete(dir);
    }
  }

  dispose(): void {
    for (const state of this.watched.values()) {
      state.watcher.dispose();
      this.unwatchFolders(state);
      if (state.timer) clearTimeout(state.timer);
    }
    this.watched.clear();
    this.structureListeners.clear();
  }

  // Counts a listing of a folder of a watched project from its ask; the answer applies its link root only when it is the newest
  // answer so far and the folder did not collapse after the ask, as the shell shows only the newest listing.
  private asking(projectKey: string, relativeDir: string): (listing: FolderListing) => void {
    const state = this.watched.get(projectKey)!;
    const record = state.folders.get(relativeDir) ?? { inFlight: 0, asked: 0, settled: 0, linked: undefined };
    state.folders.set(relativeDir, record);
    record.inFlight++;
    const number = ++record.asked;
    return (listing) => {
      record.inFlight--;
      if (this.watched.get(projectKey) !== state) return;
      if (listing.ok && number > record.settled) {
        record.settled = number;
        this.link(projectKey, state, relativeDir, record, listing.via);
      }
      if (record.inFlight === 0 && !record.linked) state.folders.delete(relativeDir);
    };
  }

  // A folder whose listing went through a link out of the project is watched there; one inside it is the project watch's.
  private link(projectKey: string, state: Watched, dir: string, record: FolderRecord, via: LinkRoot | undefined): void {
    const known = record.linked?.via;
    if (known?.link === via?.link && known?.realRoot === via?.realRoot) return;
    this.unlink(dir, record);
    if (!via) return;
    if (dir !== via.link && !dir.startsWith(`${via.link}/`)) {
      this.deps.log(`[files] not watching ${dir}: its listing names the link ${via.link}, which is not on its path`);
      return;
    }
    record.linked = { via, watch: this.watchLinked(projectKey, state, dir, via) };
  }

  // The folder's direct children at its place under the link root, judged from that root (literalGlob keeps the watch shallow).
  private watchLinked(projectKey: string, state: Watched, dir: string, via: LinkRoot): Disposable {
    const rest = dir === via.link ? '' : dir.slice(via.link.length + 1);
    const watcher = state.workspace.files.watch(via.realRoot, rest === '' ? '*' : `${literalGlob(rest)}/*`, (event) => {
      if (event.kind !== 'change') this.recordLinked(projectKey, state, via, event.path);
    });
    this.deps.log(`[files] watching ${dir} under the link root ${via.realRoot}`);
    // what changed in the folder before its watch was ready was never reported
    void watcher.ready.then(() => {
      if (this.watched.get(projectKey) === state && state.folders.get(dir)?.linked?.watch === watcher) this.deps.changed({ projectKey, relativeDirs: [dir] });
    });
    return watcher;
  }

  private unlink(dir: string, record: FolderRecord): void {
    if (!record.linked) return;
    record.linked.watch.dispose();
    record.linked = undefined;
    this.deps.log(`[files] stopped watching ${dir} under its link root`);
  }

  private unwatchFolders(state: Watched): void {
    for (const record of state.folders.values()) record.linked?.watch.dispose();
    state.folders.clear();
  }

  // every listing of the project and its Quick Open list may be stale
  private refetch(projectKey: string): void {
    this.deps.changed({ projectKey, relativeDirs: [] });
    for (const listener of [...this.structureListeners]) listener(projectKey);
  }

  private record(project: Project, state: Watched, fsPath: string): void {
    this.recordRelative(project.key, state, this.relativeTo(project.key, project.fsPath, fsPath));
  }

  // An event under a link root, named by its path through the link.
  private recordLinked(projectKey: string, state: Watched, via: LinkRoot, fsPath: string): void {
    const below = this.relativeTo(projectKey, via.realRoot, fsPath);
    if (isRelativeFilePath(below)) this.recordRelative(projectKey, state, `${via.link}/${below}`);
  }

  private relativeTo(projectKey: string, base: string, fsPath: string): string {
    const flavor = pathFor(this.deps.target(projectKey));
    return flavor.relative(base, fsPath).split(flavor.sep).join('/');
  }

  private recordRelative(projectKey: string, state: Watched, relative: string): void {
    if (relative === '' || !isRelativeFilePath(relative) || this.isExcluded(relative)) return;
    state.pending.add(parentOf(relative));
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const relativeDirs = [...state.pending];
      state.pending.clear();
      this.deps.changed({ projectKey, relativeDirs });
      for (const listener of [...this.structureListeners]) listener(projectKey);
    }, CHANGE_BATCH_MS);
  }

  private matcher(): ExcludeTest {
    const patterns = this.excludePatterns();
    const key = JSON.stringify(patterns);
    if (key !== this.excludeKey) {
      this.excludeKey = key;
      this.excludeMatcher = excludeTest(patterns);
    }
    return this.excludeMatcher;
  }

  private files(projectKey: string): WorkspaceFileSystem {
    return this.deps.workspaces.forProject(projectKey).files;
  }

  private project(projectKey: string): Project | undefined {
    return this.deps.projects().find((candidate) => candidate.key === projectKey);
  }

}
