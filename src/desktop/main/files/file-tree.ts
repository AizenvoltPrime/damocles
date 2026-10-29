import type { Disposable } from '../../../platform/disposable';
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
import { isRelativeOrRoot, type Project } from '../../local-services/confine';
import type { EntryIdentity, WorkspaceFileSystem } from '../../workspace/file-system';
import type { ProjectWorkspace } from '../../workspace/project-workspace';
import { excludeTest, type ExcludeTest } from '../../workspace/tree-listing';
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
}

// Copy path and Reveal: a cancel never happens, every other failure is reported as a delete's is.
export type FilesActionResult = FilesDeleteResult;

const fileNameCollator = new Intl.Collator(undefined, { numeric: true });

// VS Code's default explorer order (explorer.sortOrder "default", compareFileNamesDefault): folders first, then a numeric
// collation, the shorter name first among names it ranks equal.
export function compareEntries(a: FileEntry, b: FileEntry): number {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  const result = fileNameCollator.compare(a.name, b.name);
  if (result !== 0) return result;
  return a.name.length - b.name.length;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A failure the workspace reported, as the shell reports it: a failed fs call names its error, a confinement does not.
function failed(result: { readonly reason: string; readonly message?: string }, log: (line: string) => void, action: string): FilesMutationResult & { ok: false } {
  if (result.reason !== 'failed' || result.message === undefined) return { ok: false, reason: result.reason as 'outside' | 'missing' | 'failed' | 'exists' };
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

interface Watched {
  // a remote workspace's watch ends with its connection, so the next connection's workspace watches again
  workspace: ProjectWorkspace;
  watcher: Disposable;
  readonly pending: Set<string>;
  timer: NodeJS.Timeout | undefined;
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
    // a host that is not connected, or whose connection ends during the call, fails this listing only
    const listing = await Promise.resolve()
      .then(() => this.deps.workspaces.forProject(projectKey).tree.list(project, relativeDir, this.excludePatterns()))
      .catch((err: unknown): FilesListResult => {
        this.deps.log(`[files] listing ${relativeDir || '.'} of ${project.name} failed: ${errorText(err)}`);
        return { ok: false, reason: 'failed' };
      });
    if (!listing.ok) return listing;
    this.watch(project);
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
    return deleted.message !== undefined ? { ok: false, reason: deleted.reason, message: deleted.message } : { ok: false, reason: deleted.reason };
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
    // a path a daemon names is never handed to this computer's file manager
    if (this.deps.target(projectKey).host !== undefined) return { ok: false, reason: 'failed', message: this.deps.t('The folder is not on this computer.') };
    if (relativePath === '') return this.attempt('revealing', relativePath, () => this.deps.reveal(project.fsPath));
    const entry = await this.files(projectKey).entry(project, relativePath).catch((): { ok: false; reason: 'failed' } => ({ ok: false, reason: 'failed' }));
    if (!entry.ok) return entry;
    return this.attempt('revealing', relativePath, () => this.deps.reveal(entry.path));
  }

  private async attempt(action: string, relativePath: string, run: () => Promise<void>): Promise<FilesActionResult> {
    try {
      await run();
      return { ok: true };
    } catch (err) {
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
    const state: Watched = known ?? { workspace, watcher: { dispose: () => undefined }, pending: new Set(), timer: undefined };
    state.workspace = workspace;
    const watcher = workspace.files.watch(project.fsPath, '**', (event) => {
      if (event.kind !== 'change') this.record(project, state, event.path);
    });
    state.watcher = watcher;
    this.watched.set(project.key, state);
    this.deps.log(`[files] watching ${project.fsPath}`);
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
      if (state.timer) clearTimeout(state.timer);
      this.watched.delete(key);
    }
  }

  dispose(): void {
    for (const state of this.watched.values()) {
      state.watcher.dispose();
      if (state.timer) clearTimeout(state.timer);
    }
    this.watched.clear();
    this.structureListeners.clear();
  }

  // every listing of the project and its Quick Open list may be stale
  private refetch(projectKey: string): void {
    this.deps.changed({ projectKey, relativeDirs: [] });
    for (const listener of [...this.structureListeners]) listener(projectKey);
  }

  private record(project: Project, state: Watched, fsPath: string): void {
    const flavor = pathFor(this.deps.target(project.key));
    const relative = flavor.relative(project.fsPath, fsPath).split(flavor.sep).join('/');
    if (relative === '' || !isRelativeFilePath(relative) || this.isExcluded(relative)) return;
    state.pending.add(parentOf(relative));
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const relativeDirs = [...state.pending];
      state.pending.clear();
      this.deps.changed({ projectKey: project.key, relativeDirs });
      for (const listener of [...this.structureListeners]) listener(project.key);
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
