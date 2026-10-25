import { promises as fs, type Dirent } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcherFactory } from '../../platform/file-watcher';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { confineEntry, confineExisting, confineMissing, confineOrCreateFolder, followsLocalLinksOnly, projectOfPath, type ConfineFailure, type Confined, type Project } from '../local-services/confine';
import { readFileBytes, type FileBytes } from '../local-services/file-bytes';
import type { ProjectFileLocation } from './search/types';

export interface WatchEvent {
  readonly kind: 'create' | 'change' | 'delete';
  readonly path: string;
}

// bigint dev and ino, which NTFS ids need; birthtimeNs tells a file Linux recreated under a reused inode number apart
export interface EntryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly birthtimeNs: bigint;
}

export type EntryResult = { readonly ok: true } | { readonly ok: false; readonly reason: ConfineFailure | 'exists'; readonly message?: string };

export type ConfinedEntry =
  | { readonly ok: true; readonly path: string; readonly folder: boolean; readonly identity: EntryIdentity }
  | { readonly ok: false; readonly reason: ConfineFailure };

export type DeleteResult = { readonly ok: true } | { readonly ok: false; readonly reason: ConfineFailure | 'changed'; readonly message?: string };

// A folder of the folder browser: its subfolders by name.
export type BrowseResult = { readonly ok: true; readonly path: string; readonly folders: readonly string[] } | { readonly ok: false; readonly reason: 'missing' | 'failed' };

// Why a write Damocles refuses itself was refused; the caller words it for the user.
export type WriteRefusal = 'outsideProject' | 'outsideFile' | 'replaced' | 'notAFile' | 'diskFull';

export class WriteRefusedError extends Error {
  override readonly name = 'WriteRefusedError';
  readonly refusal: WriteRefusal;

  constructor(message: string, refusal: WriteRefusal) {
    super(message);
    this.refusal = refusal;
  }
}

// The host's own settings file as its settings store names it; the one file outside every project a client may write.
export const HOST_SETTINGS_FILE = 'settings.json';

export interface HostSettingsRead {
  // the file's path in the real ~/.damocles of the host
  readonly path: string;
  readonly read: FileBytes | { readonly kind: 'outside' };
}

// Project paths are confined on the host that holds them (docs/invariants.md "Desktop host", Confinement).
export interface WorkspaceFileSystem {
  confineExisting(project: Project, relativePath: string): Promise<Confined>;
  confineMissing(project: Project, relativePath: string): Promise<Confined>;
  // the entry itself, never followed, with what a delete compares against after its questions
  entry(project: Project, relativePath: string): Promise<ConfinedEntry>;
  projectOfPath(projects: readonly Project[], target: string): Promise<{ project: Project; relativePath: string; path: string } | undefined>;
  // undefined: missing
  realpath(target: string): Promise<string | undefined>;
  read(filePath: string, limitBytes?: number): Promise<FileBytes>;
  // undefined: missing
  readText(filePath: string): Promise<string | undefined>;
  // resolves the written file's mtime; throws WriteRefusedError for a write Damocles refuses itself
  writeInPlace(project: Project, location: ProjectFileLocation, bytes: Buffer): Promise<number>;
  // the host's ~/.damocles/settings.json and nothing else: a link that leads anywhere but that file reads as outside
  readHostSettings(): Promise<HostSettingsRead>;
  // writeInPlace confined to that one file
  writeHostSettings(bytes: Buffer): Promise<number>;
  createEntry(project: Project, relativeDir: string, name: string, kind: 'file' | 'dir'): Promise<EntryResult>;
  // relativePath is the entry itself; a link is renamed, never its target
  renameEntry(project: Project, relativePath: string, newName: string): Promise<EntryResult>;
  // deletes for good only while the entry is still the one confirmed
  deleteEntry(project: Project, relativePath: string, confirmed: EntryIdentity): Promise<DeleteResult>;
  trash(entryPath: string): Promise<void>;
  isDirectory(target: string): Promise<boolean>;
  // each '/'-separated relative path's mtime under folder, joined on this host; undefined when it cannot be read for any reason
  mtimes(folder: string, relativePaths: readonly string[]): Promise<ReadonlyArray<number | undefined>>;
  browse(folder: string): Promise<BrowseResult>;
  watch(base: string, glob: string, listener: (event: WatchEvent) => void): Disposable;
}

export interface FileSystemDeps {
  readonly watchers: FileWatcherFactory;
  // the OS trash; Electron's shell.trashItem in main
  readonly trash: (absolutePath: string) => Promise<void>;
  // deletes for good, a folder with its contents and a link as itself
  readonly remove?: (absolutePath: string) => Promise<void>;
  // the host's ~/.damocles, which holds HOST_SETTINGS_FILE
  readonly damoclesHome: string;
  readonly log: (line: string) => void;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isMissing(err: unknown): boolean {
  return errnoCode(err) === 'ENOENT';
}

// A pwrite may take fewer bytes than asked (a nearly full disk); the rest follows from where it stopped.
async function writeAll(handle: fs.FileHandle, filePath: string, bytes: Buffer): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten === 0) throw new WriteRefusedError(`${filePath} was not written in full`, 'diskFull');
    offset += bytesWritten;
  }
}

// A missing segment ends the walk with nothing left to follow, as for a file a save creates.
async function followsLocalLinks(project: Project, relativePath: string): Promise<boolean> {
  try {
    return await followsLocalLinksOnly(project.fsPath, relativePath.split('/'));
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
    throw err;
  }
}

async function identityOf(filePath: string): Promise<{ readonly dev: bigint; readonly ino: bigint } | undefined> {
  try {
    const stat = await fs.stat(filePath, { bigint: true });
    if (!stat.isFile()) throw new WriteRefusedError(`${filePath} is not a file`, 'notAFile');
    return { dev: stat.dev, ino: stat.ino };
  } catch (err) {
    if (isMissing(err)) return undefined;
    throw err;
  }
}

// A project file is written only while its path still resolves inside that project; every write names one. Resolves the
// existing file's identity, or undefined when the file is to be created in its confined parent.
async function reconfine(project: Project, location: ProjectFileLocation): Promise<{ readonly dev: bigint; readonly ino: bigint } | undefined> {
  // The walk comes first, so the stat never follows a link to a share. The identity is taken before the realpath check, so
  // one swap at any point fails: before the stat or between the stat and the realpath, the realpath leaves the file; after
  // it, the opened handle differs.
  if (!(await followsLocalLinks(project, location.relativePath))) throw new WriteRefusedError(`${location.relativePath} is outside the project`, 'outsideProject');
  const identity = await identityOf(location.path);
  const existing = await confineExisting(project, location.relativePath);
  if (existing.ok) {
    if (folderKey(existing.path) !== folderKey(location.path)) throw new WriteRefusedError(`${location.relativePath} now resolves outside the file the editor opened`, 'outsideFile');
    if (!identity) throw new WriteRefusedError(`${location.relativePath} changed while it was being saved`, 'replaced');
    return identity;
  }
  if (existing.reason !== 'missing') throw new WriteRefusedError(`${location.relativePath} is outside the project`, 'outsideProject');
  const parent = path.posix.dirname(location.relativePath);
  // A file whose folder was deleted too is written back with its folders (fileService.ts writeFile's mkdirp).
  const confinedParent = await confineOrCreateFolder(project, parent === '.' ? '' : parent);
  if (!confinedParent.ok || folderKey(path.join(confinedParent.path, path.basename(location.path))) !== folderKey(location.path)) {
    throw new WriteRefusedError(`${location.relativePath} is outside the project`, 'outsideProject');
  }
  return undefined;
}

// The exclusive create landed somewhere confinement never approved: the empty file is removed, but only while the path
// still names that same file, so a swapped-in link never deletes a file the editor did not create.
async function removeCreated(filePath: string, made: { readonly dev: bigint; readonly ino: bigint }, log: (line: string) => void): Promise<void> {
  const now = await fs.stat(filePath, { bigint: true });
  if (now.dev === made.dev && now.ino === made.ino) await fs.rm(filePath);
  else log(`[documents] left ${filePath} alone: it is no longer the file a refused save created`);
}

/**
 * In place, so the file keeps its mode, hardlinks and ACLs. The handle must be the file confinement resolved: an existing
 * file's identity (bigint dev and ino, which NTFS ids need) is taken from the confined realpath before the open and
 * compared with the opened handle; a new file's realpath is checked after its exclusive create. A junction or link swapped
 * in between the check and the open fails either way. Resolves the written file's mtime.
 */
export async function writeInPlace(project: Project, location: ProjectFileLocation, bytes: Buffer, log: (line: string) => void): Promise<number> {
  const identity = await reconfine(project, location);
  if (identity) {
    const handle = await fs.open(location.path, 'r+');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw new WriteRefusedError(`${location.path} changed while it was being saved`, 'replaced');
      await writeAll(handle, location.path, bytes);
      await handle.truncate(bytes.length);
      await handle.sync();
      return Number((await handle.stat({ bigint: true })).mtimeMs);
    } finally {
      await handle.close();
    }
  }
  const handle = await fs.open(location.path, 'wx');
  const made = await handle.stat({ bigint: true });
  let misplaced = true;
  try {
    if (folderKey(await fs.realpath(location.path)) !== folderKey(location.path)) throw new WriteRefusedError(`${location.path} changed while it was being saved`, 'replaced');
    misplaced = false;
    await writeAll(handle, location.path, bytes);
    await handle.sync();
    return Number((await handle.stat({ bigint: true })).mtimeMs);
  } finally {
    await handle.close();
    if (misplaced) await removeCreated(location.path, made, log);
  }
}

// ~/.damocles at its realpath as the project HOST_SETTINGS_FILE is confined to; the file must be that very path, so a link to
// any other file, inside ~/.damocles or not, is refused.
async function hostSettingsLocation(damoclesHome: string): Promise<{ readonly project: Project; readonly location: ProjectFileLocation }> {
  const real = await fs.realpath(damoclesHome);
  const key = folderKey(real);
  return { project: { key, fsPath: real, name: path.basename(real) }, location: { path: path.join(real, HOST_SETTINGS_FILE), projectKey: key, relativePath: HOST_SETTINGS_FILE } };
}

async function readHostSettings(damoclesHome: string): Promise<HostSettingsRead> {
  let place: Awaited<ReturnType<typeof hostSettingsLocation>>;
  try {
    place = await hostSettingsLocation(damoclesHome);
  } catch (err) {
    if (isMissing(err)) return { path: path.join(damoclesHome, HOST_SETTINGS_FILE), read: { kind: 'missing' } };
    throw err;
  }
  const { project, location } = place;
  const confined = await confineExisting(project, HOST_SETTINGS_FILE);
  if (!confined.ok) {
    const read = confined.reason === 'missing' ? { kind: 'missing' as const } : confined.reason === 'outside' ? { kind: 'outside' as const } : { kind: 'unreadable' as const, error: `${location.path} cannot be read` };
    return { path: location.path, read };
  }
  if (folderKey(confined.path) !== folderKey(location.path)) return { path: location.path, read: { kind: 'outside' } };
  return { path: location.path, read: await readFileBytes(confined.path) };
}

// A folder, or a link that leads to one: the link is followed only after the walk finds no share or device on its way.
async function isFolderEntry(folder: string, dirent: Dirent): Promise<boolean> {
  if (!dirent.isSymbolicLink()) return dirent.isDirectory();
  try {
    return (await followsLocalLinksOnly(folder, [dirent.name])) && (await fs.stat(path.join(folder, dirent.name))).isDirectory();
  } catch {
    return false;
  }
}

async function isAnotherEntry(target: string, entry: string): Promise<boolean> {
  let found: { dev: bigint; ino: bigint };
  try {
    found = await fs.lstat(target, { bigint: true });
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
  const own = await fs.lstat(entry, { bigint: true });
  return found.dev !== own.dev || found.ino !== own.ino;
}

export function createFileSystem(deps: FileSystemDeps): WorkspaceFileSystem {
  const remove = deps.remove ?? ((target: string) => fs.rm(target, { recursive: true }));
  return {
    confineExisting,
    confineMissing,
    projectOfPath,
    async entry(project, relativePath) {
      const entry = await confineEntry(project, relativePath);
      if (!entry.ok) return entry;
      const { stat } = entry;
      return { ok: true, path: entry.path, folder: stat.isDirectory(), identity: { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs } };
    },
    async realpath(target) {
      try {
        return await fs.realpath(target);
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    read: readFileBytes,
    async readText(filePath) {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    writeInPlace: (project, location, bytes) => writeInPlace(project, location, bytes, deps.log),
    readHostSettings: () => readHostSettings(deps.damoclesHome),
    async writeHostSettings(bytes) {
      const { project, location } = await hostSettingsLocation(deps.damoclesHome);
      return writeInPlace(project, location, bytes, deps.log);
    },
    async createEntry(project, relativeDir, name, kind) {
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
        if (errnoCode(err) === 'EEXIST') return { ok: false, reason: 'exists' };
        return { ok: false, reason: 'failed', message: errorText(err) };
      }
      return { ok: true };
    },
    async renameEntry(project, relativePath, newName) {
      const entry = await confineEntry(project, relativePath);
      if (!entry.ok) return entry;
      const target = path.join(path.dirname(entry.path), newName);
      if (target === entry.path) return { ok: true };
      // fs.rename replaces an existing file on Windows (MoveFileEx with REPLACE_EXISTING); only a case-only rename on a
      // case-insensitive file system may find the entry itself under the new name.
      if (await isAnotherEntry(target, entry.path)) return { ok: false, reason: 'exists' };
      try {
        await fs.rename(entry.path, target);
      } catch (err) {
        return { ok: false, reason: 'failed', message: errorText(err) };
      }
      return { ok: true };
    },
    // Linux reuses a freed inode number at once, so a deleted and recreated file differs only in its birth time.
    async deleteEntry(project, relativePath, confirmed) {
      const entry = await confineEntry(project, relativePath);
      if (!entry.ok) return entry;
      try {
        const now = await fs.lstat(entry.path, { bigint: true });
        if (now.dev !== confirmed.dev || now.ino !== confirmed.ino || now.birthtimeNs !== confirmed.birthtimeNs) return { ok: false, reason: 'changed' };
        await remove(entry.path);
      } catch (err) {
        return { ok: false, reason: 'failed', message: errorText(err) };
      }
      return { ok: true };
    },
    trash: (entryPath) => deps.trash(entryPath),
    isDirectory: (target) => fs.stat(target).then((stat) => stat.isDirectory(), (err: unknown) => {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw err;
    }),
    mtimes: (folder, relativePaths) => Promise.all(relativePaths.map((relativePath) => fs.lstat(path.join(folder, ...relativePath.split('/'))).then((stat) => stat.mtimeMs, () => undefined))),
    async browse(folder) {
      let dirents: Dirent[];
      let real: string;
      try {
        real = await fs.realpath(folder);
        dirents = await fs.readdir(real, { withFileTypes: true });
      } catch (err) {
        const code = errnoCode(err);
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed' };
      }
      return { ok: true, path: real, folders: (await Promise.all(dirents.map(async (dirent) => ((await isFolderEntry(real, dirent)) ? [dirent.name] : [])))).flat() };
    },
    watch(base, glob, listener) {
      const watcher = deps.watchers.watch(base, glob);
      watcher.onDidCreate((fsPath) => listener({ kind: 'create', path: fsPath }));
      watcher.onDidChange((fsPath) => listener({ kind: 'change', path: fsPath }));
      watcher.onDidDelete((fsPath) => listener({ kind: 'delete', path: fsPath }));
      return watcher;
    },
  };
}
