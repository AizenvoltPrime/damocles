import { promises as fs, type BigIntStats, type Dirent, type Stats } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcherFactory } from '../../platform/file-watcher';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { confineEntry, confineExisting, confineMissing, confineOrCreateFolder, followsLocalLinksOnly, isInsideRealRoot, projectOfPath, type ConfineFailure, type Confined, type Project } from '../local-services/confine';
import { isUnsafeWindowsName } from '../../shared/relative-path';
import { readFileBytes, readOpenedFile, type FileBytes } from '../local-services/file-bytes';
import type { ProjectFileLocation } from './search/types';
import { createdThroughLink, createTransferOps, type TransferOps } from './transfer-ops';

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

// The host's own settings file as its settings store names it; a client names it by no path.
export const HOST_SETTINGS_FILE = 'settings.json';

export interface HostSettingsRead {
  // the file's path in the real ~/.damocles of the host
  readonly path: string;
  readonly read: FileBytes | { readonly kind: 'outside' };
}

// within 'plans': the plans rule as well, a .md file below the realpath of <damoclesHome>/plans with no other hard link
export interface OutsideRule {
  readonly within?: 'plans';
}

// path: the native realpath, which readOutside and writeOutside take
export type OutsideResolution = { readonly kind: 'file' | 'folder'; readonly path: string } | { readonly kind: 'missing' | 'outside' };

// Project paths are confined on the host that holds them (docs/invariants.md "Desktop host", Confinement).
export interface WorkspaceFileSystem extends TransferOps {
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
  // a file or folder outside every project by this host's rules (docs/invariants.md "Desktop host", Confinement)
  resolveOutside(target: string, rule: OutsideRule): Promise<OutsideResolution>;
  // only while filePath is still its own realpath and meets the rule, else outside
  readOutside(filePath: string, rule: OutsideRule): Promise<FileBytes | { readonly kind: 'outside' }>;
  // resolves the written file's mtime; throws WriteRefusedError (outsideFile, replaced, notAFile, diskFull) for a write Damocles refuses itself
  writeOutside(filePath: string, bytes: Buffer, rule: OutsideRule): Promise<number>;
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
  // ready: FileWatcher.ready's contract (src/platform/file-watcher.ts)
  watch(base: string, glob: string, listener: (event: WatchEvent) => void): Disposable & { readonly ready: Promise<void> };
}

export interface FileSystemDeps {
  readonly watchers: FileWatcherFactory;
  // the OS trash; Electron's shell.trashItem in main
  readonly trash: (absolutePath: string) => Promise<void>;
  // deletes for good, a folder with its contents and a link as itself
  readonly remove?: (absolutePath: string) => Promise<void>;
  // the host's ~/.damocles, which holds HOST_SETTINGS_FILE and the plans folder
  readonly damoclesHome: string;
  readonly log: (line: string) => void;
  // the host's OS, which transfers check names for; process.platform unless a test names another
  readonly platform?: NodeJS.Platform;
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

// The exclusive create landed somewhere confinement never approved: the empty file is removed where it is, through a link
// Windows' create followed included, but only while it is still that same file, so a swapped-in link never deletes a file the
// editor did not create.
async function removeCreated(filePath: string, made: EntryIdentity, log: (line: string) => void): Promise<void> {
  if (await createdThroughLink(filePath, made)) return;
  const now = await fs.stat(filePath, { bigint: true });
  if (now.dev === made.dev && now.ino === made.ino) await fs.rm(filePath);
  else log(`[documents] left ${filePath} alone: it is no longer the file a refused save created`);
}

/**
 * In place, so the file keeps its mode, hardlinks and ACLs. The handle must be the file the caller's checks resolved: an
 * existing file's identity (bigint dev and ino, which NTFS ids need) is taken before the realpath check and compared with
 * the opened handle, which accepted may check further; a new file's realpath is checked after its exclusive create. A junction or
 * link swapped in between the check and the open fails either way. Resolves the written file's mtime.
 */
async function writeChecked(
  filePath: string,
  identity: { readonly dev: bigint; readonly ino: bigint } | undefined,
  bytes: Buffer,
  log: (line: string) => void,
  accepted: (opened: BigIntStats) => Promise<void> = async () => undefined,
): Promise<number> {
  if (identity) {
    const handle = await fs.open(filePath, 'r+');
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== identity.dev || opened.ino !== identity.ino) throw new WriteRefusedError(`${filePath} changed while it was being saved`, 'replaced');
      await accepted(opened);
      await writeAll(handle, filePath, bytes);
      await handle.truncate(bytes.length);
      await handle.sync();
      return Number((await handle.stat({ bigint: true })).mtimeMs);
    } finally {
      await handle.close();
    }
  }
  const handle = await fs.open(filePath, 'wx');
  const made = await handle.stat({ bigint: true });
  let misplaced = true;
  try {
    if (folderKey(await fs.realpath(filePath)) !== folderKey(filePath)) throw new WriteRefusedError(`${filePath} changed while it was being saved`, 'replaced');
    misplaced = false;
    await writeAll(handle, filePath, bytes);
    await handle.sync();
    return Number((await handle.stat({ bigint: true })).mtimeMs);
  } finally {
    await handle.close();
    if (misplaced) await removeCreated(filePath, made, log);
  }
}

/** A project file in place, only while its path still resolves to that file inside the project (reconfine, writeChecked). */
export async function writeInPlace(project: Project, location: ProjectFileLocation, bytes: Buffer, log: (line: string) => void): Promise<number> {
  return writeChecked(location.path, await reconfine(project, location), bytes, log);
}

// A path outside every project as this host spells one, split at its root: absolute, without NUL, and on win32 a drive path
// whose every segment Windows opens as written, so no UNC, device (\\?\, \\.\), drive-relative or root-relative path, no
// '.' or '..', no stream or device name; undefined for any other, before any file system call.
function outsideSegments(target: string): { readonly root: string; readonly segments: readonly string[] } | undefined {
  if (target.includes('\0')) return undefined;
  if (process.platform === 'win32') {
    if (!/^[A-Za-z]:[\\/]/.test(target)) return undefined;
    const segments = target.slice(3).split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.some(isUnsafeWindowsName) ? undefined : { root: `${target.slice(0, 2)}\\`, segments };
  }
  if (!target.startsWith('/')) return undefined;
  const segments = target.split('/').filter((segment) => segment.length > 0);
  return segments.some((segment) => segment === '.' || segment === '..') ? undefined : { root: '/', segments };
}

function isGone(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// The walk from the path's own root: no link on the way leads to a share or device. A missing segment leaves nothing to follow.
async function walksLocally(lexical: { readonly root: string; readonly segments: readonly string[] }): Promise<boolean> {
  try {
    return await followsLocalLinksOnly(lexical.root, lexical.segments);
  } catch (err) {
    if (isGone(err)) return true;
    throw err;
  }
}

// The realpath of <damoclesHome>/plans, walked first like any other path; undefined while there is none.
async function plansFolder(damoclesHome: string): Promise<string | undefined> {
  const plans = path.join(damoclesHome, 'plans');
  const lexical = outsideSegments(plans);
  if (!lexical || !(await walksLocally(lexical))) return undefined;
  try {
    return await fs.realpath(plans);
  } catch (err) {
    if (isGone(err)) return undefined;
    throw err;
  }
}

// The name and place half of the plans rule, on a realpath (isPlanFilePath folds case on win32 alone, and so does this).
async function isPlanPlace(realPath: string, damoclesHome: string): Promise<boolean> {
  const named = process.platform === 'win32' ? realPath.toLowerCase().endsWith('.md') : realPath.endsWith('.md');
  if (!named) return false;
  const plans = await plansFolder(damoclesHome);
  return plans !== undefined && isInsideRealRoot(plans, realPath) && folderKey(plans) !== folderKey(realPath);
}

// A hard link shares the plan's bytes with a name outside the plans folder, which no path comparison sees.
function isSingleFile(stat: { isFile(): boolean; readonly nlink: number | bigint }): boolean {
  return stat.isFile() && Number(stat.nlink) === 1;
}

async function resolveOutside(target: string, rule: OutsideRule, damoclesHome: string): Promise<OutsideResolution> {
  const lexical = outsideSegments(target);
  if (!lexical) return { kind: 'outside' };
  let real: string;
  let stat: Stats;
  try {
    if (!(await followsLocalLinksOnly(lexical.root, lexical.segments))) return { kind: 'outside' };
    real = await fs.realpath(target);
    stat = await fs.stat(real);
  } catch (err) {
    if (isGone(err)) return { kind: 'missing' };
    throw err;
  }
  if (!outsideSegments(real)) return { kind: 'outside' };
  if (rule.within === 'plans') return isSingleFile(stat) && (await isPlanPlace(real, damoclesHome)) ? { kind: 'file', path: real } : { kind: 'outside' };
  if (stat.isFile()) return { kind: 'file', path: real };
  return stat.isDirectory() ? { kind: 'folder', path: real } : { kind: 'outside' };
}

function unreadableOf(err: unknown): FileBytes {
  const code = errnoCode(err);
  return { kind: 'unreadable', error: errorText(err), ...(code !== undefined ? { code } : {}) };
}

// After the open, the path walked and resolved again must still be its own realpath and its entry the opened file, so a path
// swapped away and back around the checks is refused: 'outside' when it now resolves elsewhere, 'replaced' when its entry is
// gone or another file.
async function leadsToHandle(filePath: string, lexical: { readonly root: string; readonly segments: readonly string[] }, opened: BigIntStats): Promise<'same' | 'outside' | 'replaced'> {
  if (!(await walksLocally(lexical))) return 'outside';
  let now: BigIntStats;
  try {
    if (folderKey(await fs.realpath(filePath)) !== folderKey(filePath)) return 'outside';
    // the entry itself: a link swapped in after the realpath has its own identity, never the handle's
    now = await fs.lstat(filePath, { bigint: true });
  } catch (err) {
    if (isGone(err)) return 'replaced';
    throw err;
  }
  return now.dev === opened.dev && now.ino === opened.ino ? 'same' : 'replaced';
}

// Read from the one handle the checks lead to: its bigint dev and ino, taken before the realpath check as a write takes them,
// must match the opened handle, which leadsToHandle checks again.
async function readOutside(filePath: string, rule: OutsideRule, damoclesHome: string): Promise<FileBytes | { readonly kind: 'outside' }> {
  const lexical = outsideSegments(filePath);
  if (!lexical) return { kind: 'outside' };
  let checked: BigIntStats;
  let real: string;
  try {
    // the walk comes first, so no stat follows a link to a share
    if (!(await followsLocalLinksOnly(lexical.root, lexical.segments))) return { kind: 'outside' };
    checked = await fs.stat(filePath, { bigint: true });
    real = await fs.realpath(filePath);
  } catch (err) {
    return isGone(err) ? { kind: 'missing' } : unreadableOf(err);
  }
  if (folderKey(real) !== folderKey(filePath)) return { kind: 'outside' };
  if (rule.within === 'plans' && !(isSingleFile(checked) && (await isPlanPlace(real, damoclesHome)))) return { kind: 'outside' };
  // opening a FIFO blocks a libuv thread until a writer appears
  if (!checked.isFile()) return { kind: 'notAFile', folder: checked.isDirectory() };
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    return isGone(err) ? { kind: 'missing' } : unreadableOf(err);
  }
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== checked.dev || opened.ino !== checked.ino) return { kind: 'outside' };
    if (rule.within === 'plans' && !isSingleFile(opened)) return { kind: 'outside' };
    if ((await leadsToHandle(filePath, lexical, opened)) !== 'same') return { kind: 'outside' };
    return await readOpenedFile(handle);
  } catch (err) {
    return unreadableOf(err);
  } finally {
    await handle.close();
  }
}

// The identity writeChecked compares the handle with, or undefined for a file to create exclusively in its folder, which
// must still resolve to itself and is never created.
async function checkOutsideWrite(
  filePath: string,
  lexical: { readonly root: string; readonly segments: readonly string[] },
  rule: OutsideRule,
  damoclesHome: string,
): Promise<{ readonly dev: bigint; readonly ino: bigint } | undefined> {
  // The walk comes first, so no stat follows a link to a share; the identity is taken before the realpath, as reconfine takes it.
  if (!(await walksLocally(lexical))) throw outsideFileRefusal(filePath);
  const identity = await identityOf(filePath);
  let real: string | undefined;
  try {
    real = await fs.realpath(filePath);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }
  if (real !== undefined) {
    if (folderKey(real) !== folderKey(filePath)) throw outsideFileRefusal(filePath);
    if (!identity) throw replacedRefusal(filePath);
    if (rule.within === 'plans') {
      let stat: Stats;
      try {
        stat = await fs.stat(real);
      } catch (err) {
        if (isGone(err)) throw replacedRefusal(filePath);
        throw err;
      }
      if (!(isSingleFile(stat) && (await isPlanPlace(real, damoclesHome)))) throw outsideFileRefusal(filePath);
    }
    return identity;
  }
  // An entry whose realpath is missing is a dangling link, which Windows' exclusive create would follow to its target.
  if (await fs.lstat(filePath).then(() => true, (err: unknown) => (isMissing(err) ? false : Promise.reject(err)))) throw outsideFileRefusal(filePath);
  const folder = path.dirname(filePath);
  if (folderKey(await fs.realpath(folder)) !== folderKey(folder)) throw outsideFileRefusal(filePath);
  if (rule.within === 'plans' && !(await isPlanPlace(filePath, damoclesHome))) throw outsideFileRefusal(filePath);
  return undefined;
}

function outsideFileRefusal(filePath: string): WriteRefusedError {
  return new WriteRefusedError(`${filePath} now resolves outside the file the editor opened`, 'outsideFile');
}

function replacedRefusal(filePath: string): WriteRefusedError {
  return new WriteRefusedError(`${filePath} changed while it was being saved`, 'replaced');
}

async function writeOutside(filePath: string, bytes: Buffer, rule: OutsideRule, damoclesHome: string, log: (line: string) => void): Promise<number> {
  const lexical = outsideSegments(filePath);
  if (!lexical) throw outsideFileRefusal(filePath);
  const identity = await checkOutsideWrite(filePath, lexical, rule, damoclesHome);
  // The checks ran before the open, so a path swapped away and back between them is checked again against the handle.
  const accepted = async (opened: BigIntStats): Promise<void> => {
    if (rule.within === 'plans' && !isSingleFile(opened)) throw new WriteRefusedError(`${filePath} gained another hard link`, 'outsideFile');
    const leads = await leadsToHandle(filePath, lexical, opened);
    if (leads === 'outside') throw outsideFileRefusal(filePath);
    if (leads === 'replaced') throw replacedRefusal(filePath);
  };
  return writeChecked(filePath, identity, bytes, log, accepted);
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
    ...createTransferOps({ platform: deps.platform ?? process.platform, log: deps.log }),
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
    resolveOutside: (target, rule) => resolveOutside(target, rule, deps.damoclesHome),
    readOutside: (filePath, rule) => readOutside(filePath, rule, deps.damoclesHome),
    writeOutside: (filePath, bytes, rule) => writeOutside(filePath, bytes, rule, deps.damoclesHome, deps.log),
    async createEntry(project, relativeDir, name, kind) {
      const parent = await confineExisting(project, relativeDir);
      if (!parent.ok) return parent;
      const target = path.join(parent.path, name);
      try {
        if (kind === 'dir') {
          await fs.mkdir(target);
        } else {
          const handle = await fs.open(target, 'wx');
          let made: EntryIdentity;
          try {
            made = await handle.stat({ bigint: true });
          } finally {
            await handle.close();
          }
          if (await createdThroughLink(target, made)) return { ok: false, reason: 'exists' };
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
