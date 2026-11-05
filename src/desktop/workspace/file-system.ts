import { isUtf8 } from 'node:buffer';
import { promises as fs, type BigIntStats, type Stats } from 'node:fs';
import * as path from 'node:path';
import type { Disposable } from '../../platform/disposable';
import type { FileWatcherFactory } from '../../platform/file-watcher';
import { requireRootAnswers } from '../../core/local-links';
import { piAgentDirIn, sessionFileAt, sessionsRootIn } from '../../core/pi-session/session-store/session-file-path';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { confineEntry, confineExisting, confineMissing, confineOrCreateFolder, followsLocalLinksOnly, projectOfPath, type ConfineFailure, type Confined, type Project } from '../local-services/confine';
import { isUncOrDevicePath } from '../../shared/project-location';
import { isUnsafeWindowsName } from '../../shared/relative-path';
import { readFileBytes, readOpenedFile, type FileBytes } from '../local-services/file-bytes';
import type { ProjectFileLocation } from './search/types';
import { namePrefixMatches } from './outside-listing';
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

// kind: FileEntry's words; link: the entry is a link, listed as what it leads to; target: a link to a file's native realpath
export interface OutsideListingEntry {
  readonly name: string;
  readonly kind: 'dir' | 'file';
  readonly link: boolean;
  readonly target?: string;
}

// path: the folder's native realpath; entries in no set order (main sorts); docs/invariants.md "Desktop host", Confinement.
export type OutsideListing =
  | { readonly kind: 'folder'; readonly path: string; readonly entries: readonly OutsideListingEntry[]; readonly truncated: boolean }
  | { readonly kind: 'missing' | 'outside' | 'notAFolder' | 'denied' };

// The bounds of one outside listing (docs/invariants.md "Desktop host", Confinement): entries kept, names examined, and
// milliseconds from the request.
export const OUTSIDE_LISTING_MAX_ENTRIES = 1000;
const OUTSIDE_LISTING_MAX_SCANNED = 50_000;
const OUTSIDE_LISTING_DEADLINE_MS = 2000;

// Why a write Damocles refuses itself was refused; the caller words it for the user. sessionFile: a session file of this
// machine's engine, which only that engine writes (feature sessionFiles).
export type WriteRefusal = 'outsideProject' | 'outsideFile' | 'replaced' | 'notAFile' | 'diskFull' | 'sessionFile';

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

// D27: share, a UNC or device path or one a link or realpath leads to; name, a path part the system reads differently than written.
export type OutsideRefusal = 'share' | 'name';

// path: the native realpath, which readOutside and writeOutside take; other, an entry that is neither a file nor a folder.
// share: a path written locally whose realpath is a share or device path (a mapped drive), which only a project holding that
// realpath opens; everything else refuses it as 'share'.
export type OutsideEntryKind = 'file' | 'folder' | 'other';
export type OutsideResolution =
  | { readonly kind: OutsideEntryKind; readonly path: string }
  | { readonly kind: 'share'; readonly path: string; readonly entry: OutsideEntryKind }
  | { readonly kind: 'missing' }
  | { readonly kind: 'outside'; readonly reason: OutsideRefusal };

// Project paths are confined on the host that holds them (docs/invariants.md "Desktop host", Confinement).
export interface WorkspaceFileSystem extends TransferOps {
  confineExisting(project: Project, relativePath: string): Promise<Confined>;
  confineMissing(project: Project, relativePath: string): Promise<Confined>;
  // the entry itself, never followed, with what a delete compares against after its questions
  entry(project: Project, relativePath: string): Promise<ConfinedEntry>;
  projectOfPath(projects: readonly Project[], target: string): Promise<{ project: Project; relativePath: string; path: string } | undefined>;
  // undefined: missing
  realpath(target: string): Promise<string | undefined>;
  // sessionFile on an existing file of this host's session store, by its canonical path
  read(filePath: string, limitBytes?: number): Promise<FileBytes>;
  // undefined: missing
  readText(filePath: string): Promise<string | undefined>;
  // resolves the written file's mtime; throws WriteRefusedError for a write Damocles refuses itself, a session file included
  writeInPlace(project: Project, location: ProjectFileLocation, bytes: Buffer): Promise<number>;
  // the host's ~/.damocles/settings.json and nothing else: a link that leads anywhere but that file reads as outside
  readHostSettings(): Promise<HostSettingsRead>;
  // writeInPlace confined to that one file
  writeHostSettings(bytes: Buffer): Promise<number>;
  // a file or folder outside every project by this host's rules (docs/invariants.md "Desktop host", Confinement)
  resolveOutside(target: string): Promise<OutsideResolution>;
  // only while filePath is still its own realpath, else outside; sessionFile as read reports it
  readOutside(filePath: string, limitBytes?: number): Promise<FileBytes | { readonly kind: 'outside' }>;
  // resolves the written file's mtime; throws WriteRefusedError (outsideFile, replaced, notAFile, diskFull, sessionFile) for a write Damocles refuses itself
  writeOutside(filePath: string, bytes: Buffer): Promise<number>;
  // the entries of a folder outside every project whose name starts with prefix, within the listing's bounds
  listOutside(folder: string, prefix: string): Promise<OutsideListing>;
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
  // the host's ~/.damocles, which holds HOST_SETTINGS_FILE and its engine's session store
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
export async function writeInPlace(project: Project, location: ProjectFileLocation, bytes: Buffer, log: (line: string) => void, sessionsRoot: string): Promise<number> {
  const identity = await reconfine(project, location);
  if (await isSessionFile(location.path, sessionsRoot)) throw sessionFileRefusal(location.path);
  return writeChecked(location.path, identity, bytes, log);
}

// The realpath of target, or of its deepest existing folder with the missing names below it.
async function canonicalOf(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    const parent = path.dirname(target);
    if (!isGone(err) || parent === target) throw err;
    return path.join(await canonicalOf(parent), path.basename(target));
  }
}

// By canonical paths, so a link into the session folder or another spelling of it is one too (docs/invariants.md "Session store").
async function isSessionFile(filePath: string, sessionsRoot: string): Promise<boolean> {
  return sessionFileAt(await canonicalOf(filePath), await canonicalOf(sessionsRoot)) !== undefined;
}

// A path the check cannot resolve reads as no session file; every write checks again before its first byte.
async function withSessionFlag<R extends FileBytes | { readonly kind: 'outside' }>(read: R, filePath: string, sessionsRoot: string): Promise<R> {
  if (read.kind !== 'bytes' && read.kind !== 'missing') return read;
  const sessionFile = await isSessionFile(filePath, sessionsRoot).catch(() => false);
  return sessionFile ? { ...read, sessionFile: true as const } : read;
}

function sessionFileRefusal(filePath: string): WriteRefusedError {
  return new WriteRefusedError(`${filePath} is a session file, which only its engine writes`, 'sessionFile');
}

interface OutsideSegments {
  readonly root: string;
  readonly segments: readonly string[];
}

// A path outside every project as this host spells one, split at its root: absolute, without NUL, and on win32 a drive path
// whose every segment Windows opens as written, so no UNC, device (\\?\, \\.\), drive-relative or root-relative path, no
// '.' or '..', no stream or device name; the refusal's reason for any other, before any file system call.
export function outsideSegments(target: string): OutsideSegments | OutsideRefusal {
  if (target.includes('\0')) return 'name';
  if (process.platform === 'win32') {
    if (isUncOrDevicePath(target)) return 'share';
    if (!/^[A-Za-z]:[\\/]/.test(target)) return 'name';
    const segments = target.slice(3).split(/[\\/]/).filter((segment) => segment.length > 0);
    return segments.some(isUnsafeWindowsName) ? 'name' : { root: `${target.slice(0, 2)}\\`, segments };
  }
  if (!target.startsWith('/')) return 'name';
  const segments = target.split('/').filter((segment) => segment.length > 0);
  return segments.some((segment) => segment === '.' || segment === '..') ? 'name' : { root: '/', segments };
}

function isGone(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'ENOENT' || code === 'ENOTDIR';
}

// The walk from the path's own root: no link on the way leads to a share or device. A missing segment leaves nothing to follow.
async function walksLocally(lexical: OutsideSegments): Promise<boolean> {
  try {
    return await followsLocalLinksOnly(lexical.root, lexical.segments);
  } catch (err) {
    if (isGone(err)) return true;
    throw err;
  }
}

async function resolveOutside(target: string): Promise<OutsideResolution> {
  const lexical = outsideSegments(target);
  if (typeof lexical === 'string') return { kind: 'outside', reason: lexical };
  let real: string;
  let stat: Stats;
  try {
    await requireRootAnswers(target);
    if (!(await followsLocalLinksOnly(lexical.root, lexical.segments))) return { kind: 'outside', reason: 'share' };
    real = await fs.realpath(target);
    // the path the walk checked, never a share realpath
    stat = await fs.stat(target);
  } catch (err) {
    if (isGone(err)) return { kind: 'missing' };
    throw err;
  }
  const entry: OutsideEntryKind = stat.isFile() ? 'file' : stat.isDirectory() ? 'folder' : 'other';
  const resolved = outsideSegments(real);
  if (resolved === 'share') return { kind: 'share', path: real, entry };
  if (typeof resolved === 'string') return { kind: 'outside', reason: resolved };
  return { kind: entry, path: real };
}

function unreadableOf(err: unknown): FileBytes {
  const code = errnoCode(err);
  return { kind: 'unreadable', error: errorText(err), ...(code !== undefined ? { code } : {}) };
}

// After the open, the path walked and resolved again must still be its own realpath and its entry the opened file, so a path
// swapped away and back around the checks is refused: 'outside' when it now resolves elsewhere, 'replaced' when its entry is
// gone or another file.
async function leadsToHandle(filePath: string, lexical: OutsideSegments, opened: BigIntStats): Promise<'same' | 'outside' | 'replaced'> {
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
async function readOutside(filePath: string, limitBytes?: number): Promise<FileBytes | { readonly kind: 'outside' }> {
  const lexical = outsideSegments(filePath);
  if (typeof lexical === 'string') return { kind: 'outside' };
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
    if ((await leadsToHandle(filePath, lexical, opened)) !== 'same') return { kind: 'outside' };
    return await readOpenedFile(handle, limitBytes);
  } catch (err) {
    return unreadableOf(err);
  } finally {
    await handle.close();
  }
}

// The identity writeChecked compares the handle with, or undefined for a file to create exclusively in its folder, which
// must still resolve to itself and is never created.
async function checkOutsideWrite(filePath: string, lexical: OutsideSegments): Promise<{ readonly dev: bigint; readonly ino: bigint } | undefined> {
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
    return identity;
  }
  // An entry whose realpath is missing is a dangling link, which Windows' exclusive create would follow to its target.
  if (await fs.lstat(filePath).then(() => true, (err: unknown) => (isMissing(err) ? false : Promise.reject(err)))) throw outsideFileRefusal(filePath);
  const folder = path.dirname(filePath);
  if (folderKey(await fs.realpath(folder)) !== folderKey(folder)) throw outsideFileRefusal(filePath);
  return undefined;
}

function outsideFileRefusal(filePath: string): WriteRefusedError {
  return new WriteRefusedError(`${filePath} now resolves outside the file the editor opened`, 'outsideFile');
}

function replacedRefusal(filePath: string): WriteRefusedError {
  return new WriteRefusedError(`${filePath} changed while it was being saved`, 'replaced');
}

async function writeOutside(filePath: string, bytes: Buffer, log: (line: string) => void, sessionsRoot: string): Promise<number> {
  const lexical = outsideSegments(filePath);
  if (typeof lexical === 'string') throw outsideFileRefusal(filePath);
  const identity = await checkOutsideWrite(filePath, lexical);
  if (await isSessionFile(filePath, sessionsRoot)) throw sessionFileRefusal(filePath);
  // The checks ran before the open, so a path swapped away and back between them is checked again against the handle.
  const accepted = async (opened: BigIntStats): Promise<void> => {
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

interface EntryType {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

// A link is followed only after the walk finds no share or device; one that cannot be followed is skipped, never failing its folder.
async function entryKindOf(folder: string, name: string, entry: EntryType): Promise<'dir' | 'file' | undefined> {
  if (entry.isDirectory()) return 'dir';
  if (entry.isFile()) return 'file';
  if (!entry.isSymbolicLink()) return undefined;
  try {
    if (!(await followsLocalLinksOnly(folder, [name], { baseIsReal: true }))) return undefined;
    const stat = await fs.stat(path.join(folder, name));
    return stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : undefined;
  } catch {
    return undefined;
  }
}

// Entries typed at once: each is an lstat where the folder read gave no type, or a link's walk and stat, on the libuv pool.
const TYPE_BATCH = 16;

// A listed name of the folder real as an entry, typed by the folder read when it gave the type, else by an lstat; undefined
// for one gone or unreadable since the read, a FIFO, socket or device, or a link that cannot be followed or whose realpath
// the lexical check refuses.
async function outsideEntry(real: string, name: string, typed: EntryType | undefined): Promise<OutsideListingEntry | undefined> {
  const entryPath = path.join(real, name);
  let entry: EntryType;
  try {
    entry = typed ?? (await fs.lstat(entryPath));
  } catch {
    return undefined;
  }
  const kind = await entryKindOf(real, name, entry);
  if (kind === undefined) return undefined;
  if (!entry.isSymbolicLink()) return { name, kind, link: false };
  let target: string;
  try {
    target = await fs.realpath(entryPath);
  } catch {
    // replaced or broken since its stat: it leads to neither, as entryKindOf decides
    return undefined;
  }
  // a link that leads to a share or device, or to a name the system reads differently than written, is not listed
  if (typeof outsideSegments(target) === 'string') return undefined;
  return kind === 'dir' ? { name, kind, link: true } : { name, kind, link: true, target };
}

// The folder's names, as bytes so a name that is no valid UTF-8 reaches keep as it is on disk, with their types where the read
// gives every one: libuv types each Windows entry from its attributes, so a file that refuses an lstat (pagefile.sys) is
// listed too. Elsewhere names only: Node's Dir types a DT_UNKNOWN entry (some FUSE, NFS or CIFS mounts, XFS without ftype)
// with a synchronous lstat on the calling thread, and withFileTypes lstats every such entry at once.
async function readNames(real: string): Promise<Array<{ readonly name: Buffer; readonly type?: EntryType }>> {
  if (process.platform === 'win32') return (await fs.readdir(real, { withFileTypes: true, encoding: 'buffer' })).map((dirent) => ({ name: dirent.name, type: dirent }));
  return (await fs.readdir(real, { encoding: 'buffer' })).map((name) => ({ name }));
}

async function scanOutside(real: string, keep: (name: Buffer) => string | undefined, deadline: number): Promise<{ readonly entries: OutsideListingEntry[]; readonly truncated: boolean }> {
  const names = await readNames(real);
  const scanned = Math.min(names.length, OUTSIDE_LISTING_MAX_SCANNED);
  const entries: OutsideListingEntry[] = [];
  let index = 0;
  while (index < scanned && entries.length < OUTSIDE_LISTING_MAX_ENTRIES && performance.now() < deadline) {
    const batch: Array<{ readonly name: string; readonly type?: EntryType }> = [];
    while (batch.length < TYPE_BATCH && index < scanned) {
      const read = names[index++]!;
      const name = keep(read.name);
      if (name !== undefined) batch.push({ name, ...(read.type ? { type: read.type } : {}) });
    }
    for (const entry of await Promise.all(batch.map(({ name, type }) => outsideEntry(real, name, type)))) if (entry) entries.push(entry);
  }
  if (entries.length > OUTSIDE_LISTING_MAX_ENTRIES) return { entries: entries.slice(0, OUTSIDE_LISTING_MAX_ENTRIES), truncated: true };
  return { entries, truncated: index < names.length };
}

// C0 and C1 controls, NUL included
const CONTROL = /\p{Cc}/u;

async function listOutside(folder: string, prefix: string): Promise<OutsideListing> {
  const deadline = performance.now() + OUTSIDE_LISTING_DEADLINE_MS;
  const lexical = outsideSegments(folder);
  if (typeof lexical === 'string') return { kind: 'outside' };
  let real: string;
  try {
    await requireRootAnswers(folder);
    if (!(await walksLocally(lexical))) return { kind: 'outside' };
    real = await fs.realpath(folder);
    if (typeof outsideSegments(real) === 'string') return { kind: 'outside' };
    if (!(await fs.stat(real)).isDirectory()) return { kind: 'notAFolder' };
  } catch (err) {
    if (namesNothing(err)) return { kind: 'missing' };
    if (isDenied(err)) return { kind: 'denied' };
    throw err;
  }
  // a name that is no valid UTF-8 or holds a control character could be neither typed nor opened
  const keep = (raw: Buffer): string | undefined => {
    if (!isUtf8(raw)) return undefined;
    const name = raw.toString('utf8');
    if (CONTROL.test(name) || !namePrefixMatches(name, prefix)) return undefined;
    return typeof outsideSegments(path.join(real, name)) === 'string' ? undefined : name;
  };
  let scanned: Awaited<ReturnType<typeof scanOutside>>;
  try {
    scanned = await scanOutside(real, keep, deadline);
  } catch (err) {
    if (namesNothing(err)) return { kind: 'missing' };
    if (isDenied(err)) return { kind: 'denied' };
    throw err;
  }
  return { kind: 'folder', path: real, entries: scanned.entries, truncated: scanned.truncated };
}

// A path that loops, runs past the system's length or leads onto a drive that does not answer within a second lists nothing.
function namesNothing(err: unknown): boolean {
  const code = errnoCode(err);
  return isGone(err) || code === 'ELOOP' || code === 'ENAMETOOLONG' || code === 'ETIMEDOUT';
}

function isDenied(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'EACCES' || code === 'EPERM';
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
  const sessionsRoot = sessionsRootIn(piAgentDirIn(deps.damoclesHome));
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
      // a realpath under an offline drive or share holds a pool thread about 21 s; the shared probe holds at most one per root
      await requireRootAnswers(target);
      try {
        return await fs.realpath(target);
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    async read(filePath, limitBytes) {
      const read = await readFileBytes(filePath, limitBytes);
      // a missing file is not resolved, so no folder of a project on a share is named; its first write refuses a session file
      return read.kind === 'bytes' ? withSessionFlag(read, filePath, sessionsRoot) : read;
    },
    async readText(filePath) {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    writeInPlace: (project, location, bytes) => writeInPlace(project, location, bytes, deps.log, sessionsRoot),
    readHostSettings: () => readHostSettings(deps.damoclesHome),
    async writeHostSettings(bytes) {
      const { project, location } = await hostSettingsLocation(deps.damoclesHome);
      return writeInPlace(project, location, bytes, deps.log, sessionsRoot);
    },
    resolveOutside,
    readOutside: async (filePath, limitBytes) => withSessionFlag(await readOutside(filePath, limitBytes), filePath, sessionsRoot),
    writeOutside: (filePath, bytes) => writeOutside(filePath, bytes, deps.log, sessionsRoot),
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
    listOutside,
    async browse(folder) {
      try {
        const real = await fs.realpath(folder);
        // the promise readdir types a DT_UNKNOWN entry with an lstat on the pool, never on this thread
        const dirents = await fs.readdir(real, { withFileTypes: true });
        const folders: string[] = [];
        for (let index = 0; index < dirents.length; index += TYPE_BATCH) {
          const batch = dirents.slice(index, index + TYPE_BATCH);
          const kinds = await Promise.all(batch.map((dirent) => entryKindOf(real, dirent.name, dirent)));
          batch.forEach((dirent, offset) => {
            if (kinds[offset] === 'dir') folders.push(dirent.name);
          });
        }
        return { ok: true, path: real, folders };
      } catch (err) {
        const code = errnoCode(err);
        return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'failed' };
      }
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
