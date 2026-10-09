import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import picomatch from 'picomatch';
import type { BigIntStats, Dirent } from 'node:fs';
import type { Disposable } from '../../../platform/disposable';
import type { FileWatcher, FileWatcherFactory } from '../../../platform/file-watcher';
import { isRelativeFilePath } from '../../../shared/relative-path';
import { isValidFileName } from '../../preload/file-names';
import {
  type FileEntry,
  type FilesChanged,
  type FilesDeleteResult,
  type FilesListResult,
  type FilesMutationResult,
} from '../../preload/shell-channels';
import type { AskMessage } from '../message-dialog';
import { confineEntry, confineExisting, followsLocalLinksOnly, isRelativeOrRoot, type Project } from '../documents/confine';

// Bursts of watcher events (a checkout, a build) reach the shell as one change per this window.
const CHANGE_BATCH_MS = 100;

export interface FileTreeDeps {
  readonly projects: () => readonly Project[];
  // damocles.desktop.files.exclude: glob to true (hidden) or false
  readonly exclude: () => Readonly<Record<string, unknown>>;
  readonly watchers: FileWatcherFactory;
  readonly ask: AskMessage;
  readonly t: (message: string, ...args: Array<string | number>) => string;
  readonly log: (line: string) => void;
  // Electron's shell.trashItem
  readonly trash: (absolutePath: string) => Promise<void>;
  // deletes the entry for good, a folder with its contents and a link as itself (fs.rm, recursive)
  readonly remove: (absolutePath: string) => Promise<void>;
  readonly reveal: (absolutePath: string) => Promise<void>;
  readonly copy: (text: string) => Promise<void>;
  readonly changed: (change: FilesChanged) => void;
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

function joinRelative(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`;
}

function parentOf(relativePath: string): string {
  const slash = relativePath.lastIndexOf('/');
  return slash < 0 ? '' : relativePath.slice(0, slash);
}

/** The Files section's data: lazy listings and confined operations, every path resolved inside its project in main. */
export class FileTree implements Disposable {
  private readonly deps: FileTreeDeps;
  private readonly watched = new Map<string, { readonly watcher: FileWatcher; readonly pending: Set<string>; timer: NodeJS.Timeout | undefined }>();
  private readonly structureListeners = new Set<(projectKey: string) => void>();
  private excludeKey = '';
  private excludeMatcher: (relativePath: string) => boolean = () => false;

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
    const matcher = this.matcher();
    const segments = relativePath.split('/');
    for (let index = 1; index <= segments.length; index++) {
      if (matcher(segments.slice(0, index).join('/'))) return true;
    }
    return false;
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
    const confined = await confineExisting(project, relativeDir);
    if (!confined.ok) return confined;
    this.watch(project);
    let dirents: Dirent[];
    try {
      dirents = await fs.readdir(confined.path, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed' };
    }
    const entries: FileEntry[] = [];
    for (const dirent of dirents) {
      if (this.isExcluded(joinRelative(relativeDir, dirent.name))) continue;
      entries.push({ name: dirent.name, kind: await this.kindOf(confined.path, dirent) });
    }
    return { ok: true, entries: entries.sort(compareEntries) };
  }

  async create(projectKey: string, relativeDir: string, name: unknown, kind: 'file' | 'dir'): Promise<FilesMutationResult> {
    const project = this.project(projectKey);
    if (!project || !isRelativeOrRoot(relativeDir)) return { ok: false, reason: 'outside' };
    if (!isValidFileName(name, process.platform)) return { ok: false, reason: 'invalidName' };
    const parent = await confineExisting(project, relativeDir);
    if (!parent.ok) return parent;
    const target = path.join(parent.path, name);
    try {
      if (kind === 'dir') {
        await fs.mkdir(target);
      } else {
        const handle = await fs.open(target, 'wx');
        await handle.close();
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: 'exists' };
      this.deps.log(`[files] creating ${name} failed: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: errorText(err) };
    }
    return { ok: true, relativePath: joinRelative(relativeDir, name) };
  }

  async rename(projectKey: string, relativePath: string, newName: unknown): Promise<FilesMutationResult> {
    const project = this.project(projectKey);
    if (!project || !isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
    if (!isValidFileName(newName, process.platform)) return { ok: false, reason: 'invalidName' };
    const entry = await confineEntry(project, relativePath);
    if (!entry.ok) return entry;
    const target = path.join(path.dirname(entry.path), newName);
    if (target === entry.path) return { ok: true, relativePath };
    // fs.rename replaces an existing file on Windows (MoveFileEx with REPLACE_EXISTING); only a case-only rename on a
    // case-insensitive file system may find the entry itself under the new name.
    if (await this.isAnotherEntry(target, entry.path)) return { ok: false, reason: 'exists' };
    try {
      await fs.rename(entry.path, target);
    } catch (err) {
      this.deps.log(`[files] renaming ${relativePath} failed: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: errorText(err) };
    }
    return { ok: true, relativePath: joinRelative(parentOf(relativePath), newName) };
  }

  /**
   * Asks first, then moves the entry itself (a link, never what it points to) to the OS trash. When the trash fails, the
   * user may delete it permanently instead, after a second confirmation (fileActions.ts deleteFiles).
   */
  async delete(projectKey: string, relativePath: string): Promise<FilesDeleteResult> {
    const project = this.project(projectKey);
    if (!project || !isRelativeFilePath(relativePath)) return { ok: false, reason: 'outside' };
    const entry = await confineEntry(project, relativePath);
    if (!entry.ok) return entry;
    const identity = await fs.lstat(entry.path, { bigint: true });
    const name = path.basename(entry.path);
    const folder = entry.stat?.isDirectory() === true;
    const choice = await this.deps.ask({
      severity: 'danger',
      message: folder ? this.deps.t('Are you sure you want to delete the folder \'{0}\' and its contents?', name) : this.deps.t('Are you sure you want to delete \'{0}\'?', name),
      detail: this.deps.t('You can restore it from the trash.'),
      actions: [this.deps.t('Move to Trash')],
      cancelLabel: this.deps.t('Cancel'),
    });
    if (choice !== 0) return { ok: false, reason: 'cancelled' };
    try {
      await this.deps.trash(entry.path);
      return { ok: true };
    } catch (err) {
      this.deps.log(`[files] moving ${relativePath} to the trash failed: ${errorText(err)}`);
      const permanently = await this.deps.ask({
        severity: 'danger',
        message: this.deps.t('\'{0}\' could not be moved to the trash. Do you want to delete it permanently instead?', name),
        detail: `${errorText(err)}\n\n${this.deps.t('This action is irreversible.')}`,
        actions: [this.deps.t('Delete Permanently')],
        cancelLabel: this.deps.t('Cancel'),
      });
      if (permanently !== 0) return { ok: false, reason: 'cancelled' };
    }
    return this.deletePermanently(project, relativePath, identity);
  }

  // Only the entry the user confirmed: one that another replaced while the questions showed is left alone.
  // Linux reuses a freed inode number at once, so a deleted and recreated file differs only in its birth time.
  private async deletePermanently(project: Project, relativePath: string, confirmed: BigIntStats): Promise<FilesDeleteResult> {
    const entry = await confineEntry(project, relativePath);
    if (!entry.ok) return entry;
    try {
      const now = await fs.lstat(entry.path, { bigint: true });
      if (now.dev !== confirmed.dev || now.ino !== confirmed.ino || now.birthtimeNs !== confirmed.birthtimeNs) return { ok: false, reason: 'failed', message: this.deps.t('It changed while Damocles was asking.') };
      await this.deps.remove(entry.path);
    } catch (err) {
      this.deps.log(`[files] deleting ${relativePath} failed: ${errorText(err)}`);
      return { ok: false, reason: 'failed', message: errorText(err) };
    }
    return { ok: true };
  }

  async copyPath(projectKey: string, relativePath: string, relative: boolean): Promise<FilesActionResult> {
    const project = this.project(projectKey);
    if (!project) return { ok: false, reason: 'missing' };
    if (!isRelativeOrRoot(relativePath)) return { ok: false, reason: 'outside' };
    const segments = relativePath === '' ? [] : relativePath.split('/');
    return this.attempt('copying the path of', relativePath, () => this.deps.copy(relative ? segments.join(path.sep) : path.join(project.fsPath, ...segments)));
  }

  async reveal(projectKey: string, relativePath: string): Promise<FilesActionResult> {
    const project = this.project(projectKey);
    if (!project) return { ok: false, reason: 'missing' };
    if (relativePath === '') return this.attempt('revealing', relativePath, () => this.deps.reveal(project.fsPath));
    const entry = await confineEntry(project, relativePath);
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

  /** Starts watching a project for Files and Quick Open; a project that left the list stops. */
  watch(project: Project): void {
    if (this.watched.has(project.key)) return;
    const watcher = this.deps.watchers.watch(project.fsPath, '**');
    const state = { watcher, pending: new Set<string>(), timer: undefined as NodeJS.Timeout | undefined };
    const structural = (fsPath: string): void => this.record(project, state, fsPath);
    watcher.onDidCreate(structural);
    watcher.onDidDelete(structural);
    this.watched.set(project.key, state);
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

  private record(project: Project, state: { pending: Set<string>; timer: NodeJS.Timeout | undefined }, fsPath: string): void {
    const relative = path.relative(project.fsPath, fsPath).split(path.sep).join('/');
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

  // A link is listed as what it points to (a dangling one as a file); listing a folder link that leads outside the project
  // is refused by confinement, so it is never followed there.
  private async kindOf(dir: string, dirent: Dirent): Promise<'file' | 'dir'> {
    if (dirent.isDirectory()) return 'dir';
    if (!dirent.isSymbolicLink()) return 'file';
    try {
      if (!(await followsLocalLinksOnly(dir, [dirent.name]))) return 'file';
      const stat = await fs.stat(path.join(dir, dirent.name));
      return stat.isDirectory() ? 'dir' : 'file';
    } catch (err) {
      this.deps.log(`[files] cannot follow the link ${dirent.name}: ${errorText(err)}`);
      return 'file';
    }
  }

  private async isAnotherEntry(target: string, entry: string): Promise<boolean> {
    let found: BigIntStats;
    try {
      found = await fs.lstat(target, { bigint: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
    const own = await fs.lstat(entry, { bigint: true });
    return found.dev !== own.dev || found.ino !== own.ino;
  }

  private matcher(): (relativePath: string) => boolean {
    const patterns = this.excludePatterns();
    const key = JSON.stringify(patterns);
    if (key !== this.excludeKey) {
      this.excludeKey = key;
      this.excludeMatcher = patterns.length === 0 ? () => false : picomatch(patterns, { dot: true });
    }
    return this.excludeMatcher;
  }

  private project(projectKey: string): Project | undefined {
    return this.deps.projects().find((candidate) => candidate.key === projectKey);
  }

}
