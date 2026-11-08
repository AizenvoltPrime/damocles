import { randomBytes } from 'node:crypto';
import { promises as fs, type BigIntStats } from 'node:fs';
import * as path from 'node:path';
import { renameWithRetry } from '../../core/config/json-config-write';
import { folderKey } from '../../core/workspace-folders/folder-key';
import { confineEntry, confineExisting, isInsideRealRoot, type ConfineFailure, type Project } from '../local-services/confine';
import { isValidFileName } from '../preload/file-names';
import type { EntryIdentity } from './file-system';

// Copies in and out of Files (docs/invariants.md "File transfers"): every file lands under a `.part` name beside its final
// name and is renamed over it, so a cancelled or failed copy never leaves a partly written file.

export type TransferKind = 'file' | 'dir' | 'link' | 'other';

export interface TransferEntry {
  // '' is the walked item itself, then '/'-separated below it
  readonly relativePath: string;
  // a socket, FIFO or device is 'other'; a link is never followed
  readonly kind: TransferKind;
  readonly size: number;
  // the permission bits, setuid, setgid and sticky included; a receiver keeps only mode & 0o777
  readonly mode: number;
  readonly mtimeMs: number;
  readonly linkTarget?: string;
  readonly identity: EntryIdentity;
  // a folder whose entries could not be read, with its errno code; its children are not listed
  readonly unreadable?: string;
  // an entry that could not be read itself, listed as 'other' with its errno code
  readonly error?: string;
}

export type TransferFailure = ConfineFailure | 'exists' | 'invalidName' | 'incomplete' | 'unsupported' | 'notFolder' | 'notAFile' | 'intoItself' | 'notEmpty' | 'changed';

export type TransferResult = { readonly ok: true } | { readonly ok: false; readonly reason: TransferFailure; readonly code?: string; readonly message?: string };

// left: paths under the moved item a move across file systems could not carry (a link on a Windows host, a special file), at
// most MOVE_LEFT_LISTED of them; leftMore: how many more there were
export type MoveResult = { readonly ok: true; readonly left: readonly string[]; readonly leftMore?: number } | Exclude<TransferResult, { readonly ok: true }>;

export interface ReceiveOptions {
  // mode & 0o777 is the mode a POSIX host creates the file with, under its umask
  readonly mode: number;
  readonly mtimeMs: number;
  // false: the final name is claimed with an exclusive create first, so a file another process made meanwhile is never replaced
  readonly replace: boolean;
  // the byte count the source must yield; any other count leaves no file
  readonly size: number;
}

export interface Clash {
  readonly name: string;
  readonly kind: TransferKind;
}

export type ClashesResult =
  | { readonly ok: true; readonly clashes: ReadonlyArray<Clash | null> }
  | { readonly ok: false; readonly reason: ConfineFailure | 'notFolder'; readonly code?: string; readonly message?: string };

export type ReadResult =
  | { readonly ok: true; readonly size: number; readonly chunks: AsyncIterable<Uint8Array> }
  | { readonly ok: false; readonly reason: ConfineFailure | 'notAFile'; readonly code?: string };

// size: the whole file's; chunks: the length bytes from offset, both already clamped to the file; resolvedPath: confineEntry's;
// folder: the entry that is not a file is a folder
export type ReadRangeResult =
  | { readonly ok: true; readonly size: number; readonly offset: number; readonly length: number; readonly resolvedPath: string; readonly chunks: AsyncIterable<Uint8Array> }
  | { readonly ok: false; readonly reason: 'notAFile'; readonly folder: boolean }
  | { readonly ok: false; readonly reason: ConfineFailure; readonly code?: string };

export const WALK_PAGE_ENTRIES = 500;
export const READ_CHUNK_BYTES: number = 64 * 1024;
export const MAX_LINK_TARGET_CHARS = 4096;
export const MOVE_LEFT_LISTED = 1000;
const STALE_PART_MS: number = 24 * 60 * 60 * 1000;
// a folder's stale parts are looked for again after this long
const STALE_SWEEP_MS: number = 60 * 60 * 1000;
// the final name's share of a part name, in UTF-8 bytes: the part stays within NAME_MAX (255 bytes)
const PART_NAME_BYTES = 200;

// `.<name>.damocles-<8 hex>.part`; tree listings hide these names and a transfer removes them once a day old
export const PART_NAME_PATTERN: RegExp = /^\..+\.damocles-[0-9a-f]{8}\.part$/;

export function isPartName(name: string): boolean {
  return PART_NAME_PATTERN.test(name);
}

function partName(name: string): string {
  let kept = name;
  while (Buffer.byteLength(kept) > PART_NAME_BYTES) kept = [...kept].slice(0, -1).join('');
  return `.${kept}.damocles-${randomBytes(4).toString('hex')}.part`;
}

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function failure(err: unknown): Exclude<TransferResult, { readonly ok: true }> {
  const code = errnoCode(err);
  return { ok: false, reason: 'failed', ...(code !== undefined ? { code } : {}), message: errorText(err) };
}

// a request the host cannot store: a size, mode or time out of range, or a link target it cannot hold
const INVALID: Exclude<TransferResult, { readonly ok: true }> = { ok: false, reason: 'failed', code: 'EINVAL' };

function kindOf(stat: BigIntStats): TransferKind {
  if (stat.isSymbolicLink()) return 'link';
  if (stat.isDirectory()) return 'dir';
  return stat.isFile() ? 'file' : 'other';
}

const mtimeMsOf = (stat: BigIntStats): number => Number(stat.mtimeNs) / 1e6;
const identityOf = (stat: BigIntStats): EntryIdentity => ({ dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs });
// Linux reuses a freed inode number at once, so a file made again in its place differs only in its birth time
const sameEntry = (a: BigIntStats, b: EntryIdentity): boolean => a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
const NO_IDENTITY: EntryIdentity = { dev: 0n, ino: 0n, birthtimeNs: 0n };

async function lstatOrUndefined(target: string): Promise<BigIntStats | undefined> {
  try {
    return await fs.lstat(target, { bigint: true });
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/**
 * Whether the file an exclusive create made at target is somewhere else: Windows' CREATE_NEW follows a link at target,
 * dangling or not. Such a file is removed where it landed, only while it is still the file made, and the link stays.
 */
export async function createdThroughLink(target: string, made: EntryIdentity): Promise<boolean> {
  const at = await lstatOrUndefined(target);
  if (!at?.isSymbolicLink()) return false;
  let landed: string;
  try {
    landed = await fs.realpath(target);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return true;
    throw err;
  }
  const stat = await lstatOrUndefined(landed);
  if (stat?.isFile() && sameEntry(stat, made)) await fs.rm(landed);
  return true;
}

// an empty file made by an exclusive create at target, open for writing; refused as EEXIST when the create went through a link
async function createExclusive(target: string, mode?: number): Promise<{ readonly handle: fs.FileHandle; readonly made: BigIntStats }> {
  const handle = await fs.open(target, 'wx', mode);
  let made: BigIntStats;
  try {
    made = await handle.stat({ bigint: true });
    if (!(await lstatOrUndefined(target))?.isSymbolicLink()) return { handle, made };
  } catch (err) {
    await handle.close();
    throw err;
  }
  await handle.close();
  await createdThroughLink(target, made);
  throw Object.assign(new Error(`${target} is a link`), { code: 'EEXIST' });
}

async function entryOf(absolute: string, relativePath: string, stat: BigIntStats): Promise<TransferEntry> {
  const kind = kindOf(stat);
  return {
    relativePath,
    kind,
    size: kind === 'file' ? Number(stat.size) : 0,
    mode: Number(stat.mode) & 0o7777,
    mtimeMs: mtimeMsOf(stat),
    identity: identityOf(stat),
    ...(kind === 'link' ? { linkTarget: await fs.readlink(absolute) } : {}),
  };
}

// an entry below the walked item: undefined once it is gone, else 'other' with its errno code when it cannot be read
async function childEntry(absolute: string, relativePath: string): Promise<TransferEntry | undefined> {
  try {
    return await entryOf(absolute, relativePath, await fs.lstat(absolute, { bigint: true }));
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'ENOENT') return undefined;
    return { relativePath, kind: 'other', size: 0, mode: 0, mtimeMs: 0, identity: NO_IDENTITY, error: code ?? 'EIO' };
  }
}

/**
 * An lstat walk of absolute that never follows a link, the item itself first and each folder before its entries, in pages. An
 * entry gone since its folder was read is left out, and one that cannot be read is listed with its error.
 */
export async function* walkPath(absolute: string): AsyncGenerator<readonly TransferEntry[]> {
  let page: TransferEntry[] = [];
  const stack: Array<{ readonly absolute: string; readonly relativePath: string }> = [{ absolute, relativePath: '' }];
  while (stack.length > 0) {
    const next = stack.pop()!;
    let entry = next.relativePath === '' ? await entryOf(next.absolute, '', await fs.lstat(next.absolute, { bigint: true })) : await childEntry(next.absolute, next.relativePath);
    if (!entry) continue;
    if (entry.kind === 'dir') {
      try {
        const names = (await fs.readdir(next.absolute)).sort().reverse();
        for (const name of names) stack.push({ absolute: path.join(next.absolute, name), relativePath: next.relativePath === '' ? name : `${next.relativePath}/${name}` });
      } catch (err) {
        entry = { ...entry, unreadable: errnoCode(err) ?? 'EIO' };
      }
    }
    page.push(entry);
    if (page.length >= WALK_PAGE_ENTRIES) {
      yield page;
      page = [];
    }
  }
  if (page.length > 0) yield page;
}

// the file at absolute opened for reading, which must still be the file stat found, never a link swapped in after it
async function openSame(absolute: string, stat: BigIntStats): Promise<{ readonly handle: fs.FileHandle; readonly size: number }> {
  const handle = await fs.open(absolute, 'r');
  try {
    const opened = await handle.stat({ bigint: true });
    if (opened.isFile() && sameEntry(opened, stat)) return { handle, size: Number(opened.size) };
  } catch (err) {
    await handle.close();
    throw err;
  }
  await handle.close();
  throw Object.assign(new Error(`${absolute} changed before it was read`), { code: 'ECHANGED' });
}

// Links followed on the way before a target counts as a loop.
const MAX_LINK_HOPS = 40;

/**
 * Whether target, read from a link in folder, resolves inside root on this file system: each segment is looked up with lstat
 * and every link on the way is followed by its own target, so case folding, normalization and links already there count as
 * the file system counts them. A missing segment ends the walk, inside only when no '..' follows it, so the link cannot lead
 * out once that name is made; a segment that is neither a link nor a folder ends it outside when more segments follow, since
 * a later Replace can make that name a link. root and folder are real paths.
 */
export async function resolvesWithin(root: string, folder: string, target: string): Promise<boolean> {
  // a link this file system made or found reads back in its own separators and absolute form
  const segmentsOf = (text: string): string[] => text.split(path.sep === '/' ? '/' : /[\\/]/).filter((segment) => segment !== '' && segment !== '.');
  const absolute = (text: string): boolean => path.posix.isAbsolute(text) || path.isAbsolute(text);
  if (absolute(target) || !isInsideRealRoot(root, folder)) return false;
  let current = folder;
  const pending = segmentsOf(target);
  for (let hops = 0; pending.length > 0;) {
    const segment = pending.shift()!;
    if (segment === '..') {
      current = path.dirname(current);
      if (!isInsideRealRoot(root, current)) return false;
      continue;
    }
    const next = path.join(current, segment);
    const stat = await lstatOrUndefined(next);
    if (!stat) return !pending.includes('..');
    if (stat.isSymbolicLink()) {
      if (++hops > MAX_LINK_HOPS) return false;
      const linked = await fs.readlink(next);
      if (absolute(linked)) return false;
      pending.unshift(...segmentsOf(linked));
      continue;
    }
    if (!stat.isDirectory() && pending.length > 0) return false;
    current = next;
    if (!isInsideRealRoot(root, current)) return false;
  }
  return true;
}

class IncompleteSource extends Error {
  override readonly name = 'IncompleteSource';
}

// The target a rename would replace is no longer the one allowed: another process took the name meanwhile.
class TargetTaken extends Error {
  override readonly name = 'TargetTaken';
}

// An error the source itself threw (a cancel), passed on unchanged once the part is gone.
class SourceFailed extends Error {
  override readonly name = 'SourceFailed';
  readonly error: unknown;

  constructor(error: unknown) {
    super(errorText(error));
    this.error = error;
  }
}

async function writeAll(handle: fs.FileHandle, bytes: Uint8Array, position: number): Promise<void> {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position + offset);
    if (bytesWritten === 0) throw Object.assign(new Error('The disk took no more bytes'), { code: 'ENOSPC' });
    offset += bytesWritten;
  }
}

// The handle's bytes from start up to end, fewer when the file ends sooner, so a file still growing yields a consistent prefix;
// the handle closes at the end, on a failed read and on return, read or not.
function handleChunks(handle: fs.FileHandle, end: number, start = 0): AsyncIterable<Uint8Array> {
  let position = start;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await handle.close();
  };
  const iterator: AsyncIterator<Uint8Array> = {
    next: async () => {
      const wanted = Math.min(READ_CHUNK_BYTES, end - position);
      if (closed || wanted <= 0) {
        await close();
        return { done: true, value: undefined };
      }
      const buffer = Buffer.allocUnsafe(wanted);
      let bytesRead: number;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, wanted, position));
      } catch (err) {
        await close();
        throw err;
      }
      if (bytesRead === 0) {
        await close();
        return { done: true, value: undefined };
      }
      position += bytesRead;
      return { done: false, value: buffer.subarray(0, bytesRead) };
    },
    return: async () => {
      await close();
      return { done: true, value: undefined };
    },
  };
  return { [Symbol.asyncIterator]: () => iterator };
}

export interface TransferOpsDeps {
  // the OS of the host that holds the files: names are checked for it, and a win32 host neither makes links nor sets modes
  readonly platform: NodeJS.Platform;
  readonly log: (line: string) => void;
  readonly now?: () => number;
}

export interface TransferOps {
  walk(project: Project, relativePath: string): AsyncIterable<readonly TransferEntry[]>;
  // for each name, the entry of relativeDir it clashes with (ignoring case on win32 and darwin hosts), else null
  clashes(project: Project, relativeDir: string, names: readonly string[]): Promise<ClashesResult>;
  // the source is returned however this ends; signal: a cancel, which removes the part and rejects
  receiveFile(project: Project, relativeDir: string, name: string, source: AsyncIterable<Uint8Array>, options: ReceiveOptions, signal?: AbortSignal): Promise<TransferResult>;
  copy(from: Project, relativePath: string, to: Project, toDir: string, name: string, replace: boolean, signal?: AbortSignal): Promise<TransferResult>;
  move(from: Project, relativePath: string, to: Project, toDir: string, name: string, replace: boolean, signal?: AbortSignal): Promise<MoveResult>;
  // mode: the source folder's, which a POSIX host creates the folder with under its umask, the owner's rwx always kept
  makeFolder(project: Project, relativeDir: string, name: string, mode?: number): Promise<TransferResult>;
  // within: a folder of the project the link must resolve inside, followed on disk through every link; one that leads out is
  // removed and refused as outside
  makeLink(project: Project, relativeDir: string, name: string, target: string, replace: boolean, within?: string): Promise<TransferResult>;
  // the link at relativePath, made with within, checked again once every link landed; one that now leads out is removed and
  // refused as outside, and one no longer there passes
  verifyLink(project: Project, relativePath: string, within: string): Promise<TransferResult>;
  // a folder, never a link, and only while it is empty
  removeFolder(project: Project, relativePath: string, confirmed: EntryIdentity): Promise<TransferResult>;
  readFile(project: Project, relativePath: string): Promise<ReadResult>;
  // at most length bytes from offset, a negative offset counting back from the end; confined as readFile is
  readFileRange(project: Project, relativePath: string, offset: number, length: number): Promise<ReadRangeResult>;
}

export function createTransferOps(deps: TransferOpsDeps): TransferOps {
  const { platform } = deps;
  const now = deps.now ?? Date.now;
  const foldsCase = platform === 'win32' || platform === 'darwin';
  const fold = (name: string): string => (foldsCase ? name.toLowerCase() : name);
  // folder key to when it was last swept, oldest first
  const swept = new Map<string, number>();
  // open's and mkdir's mode is masked by the host's umask, as scp and rsync without -p create them; a Windows host sets none
  const fileMode = (mode: number): number | undefined => (platform === 'win32' ? undefined : mode & 0o777);
  // the owner keeps rwx, so the folder's own entries can still land in it
  const folderMode = (mode: number): number | undefined => (platform === 'win32' ? undefined : (mode & 0o777) | 0o700);

  // the parts a crash left in folder, a day old or more; only regular files named as parts. Age is the ctime, since a part's
  // mtime is the source's from just before its rename
  const sweepStaleParts = async (folder: string): Promise<void> => {
    const key = folderKey(folder);
    const last = swept.get(key);
    if (last !== undefined && now() - last < STALE_SWEEP_MS) return;
    for (const [sweptKey, at] of swept) {
      if (now() - at < STALE_SWEEP_MS) break;
      swept.delete(sweptKey);
    }
    swept.delete(key);
    swept.set(key, now());
    for (const name of await fs.readdir(folder)) {
      if (!isPartName(name)) continue;
      const part = path.join(folder, name);
      try {
        const stat = await fs.lstat(part);
        if (stat.isFile() && now() - stat.ctimeMs >= STALE_PART_MS) await fs.rm(part);
      } catch (err) {
        deps.log(`[files] could not remove the stale part ${part}: ${errorText(err)}`);
      }
    }
  };

  // the confined folder at relativeDir, which must be a folder
  const folderAt = async (project: Project, relativeDir: string): Promise<{ readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: ConfineFailure | 'notFolder' }> => {
    const confined = await confineExisting(project, relativeDir);
    if (!confined.ok) return confined;
    try {
      return (await fs.stat(confined.path)).isDirectory() ? confined : { ok: false, reason: 'notFolder' };
    } catch (err) {
      return { ok: false, reason: errnoCode(err) === 'ENOENT' ? 'missing' : 'failed' };
    }
  };

  // removes path only while it is still the entry made there
  const removeIfSame = async (target: string, made: EntryIdentity): Promise<void> => {
    const stat = await lstatOrUndefined(target);
    if (stat && sameEntry(stat, made)) await fs.rm(target);
  };

  // the claim goes only while it is still the empty file made: another process may have opened it to write meanwhile
  const removeClaim = async (target: string, claim: EntryIdentity): Promise<void> => {
    const stat = await lstatOrUndefined(target);
    if (stat?.isFile() && stat.size === 0n && sameEntry(stat, claim)) await fs.rm(target);
  };

  /**
   * Fills a part beside name in folder, made with the source's mode (fileMode), or with the replaced file's as scp and rsync
   * keep it, sets the mtime through its handle, and renames it over name. Without replace the name is claimed first by an
   * exclusive create, and the rename replaces only that empty claim, checked again before every attempt.
   */
  const land = async (folder: string, name: string, replace: boolean, meta: { readonly mode: number; readonly mtimeMs: number }, fill: (handle: fs.FileHandle) => Promise<void>): Promise<TransferResult> => {
    const target = path.join(folder, name);
    let claim: BigIntStats | undefined;
    let mode = meta.mode;
    if (replace) {
      const existing = await lstatOrUndefined(target);
      if (existing?.isDirectory()) return { ok: false, reason: 'exists' };
      if (existing?.isFile()) mode = Number(existing.mode);
    } else {
      try {
        const claimed = await createExclusive(target);
        await claimed.handle.close();
        claim = claimed.made;
      } catch (err) {
        return errnoCode(err) === 'EEXIST' ? { ok: false, reason: 'exists' } : failure(err);
      }
    }
    const part = path.join(folder, partName(name));
    let landed = false;
    try {
      if (folderKey(await fs.realpath(folder)) !== folderKey(folder)) return { ok: false, reason: 'outside' };
      const { handle } = await createExclusive(part, fileMode(mode));
      try {
        await fill(handle);
        // Node reads a negative number of seconds as now, and a Date before 1970 as itself; libuv on Windows turns a time
        // before 1970 into one after 2100, so a Windows host keeps the copy's own time instead
        if (meta.mtimeMs >= 0) await handle.utimes(now() / 1000, meta.mtimeMs / 1000);
        else if (platform !== 'win32') await handle.utimes(now() / 1000, new Date(meta.mtimeMs));
        await handle.sync();
      } finally {
        await handle.close();
      }
      const claimHeld = async (): Promise<void> => {
        if (!claim) return;
        const current = await lstatOrUndefined(target);
        if (!current?.isFile() || !sameEntry(current, claim) || current.size !== 0n) throw new TargetTaken();
      };
      await renameWithRetry(part, target, claimHeld);
      landed = true;
      return { ok: true };
    } catch (err) {
      if (err instanceof TargetTaken) return { ok: false, reason: 'exists' };
      if (err instanceof SourceFailed) throw err.error;
      if (err instanceof IncompleteSource) return { ok: false, reason: 'incomplete', message: err.message };
      return failure(err);
    } finally {
      if (!landed) {
        await fs.rm(part, { force: true });
        if (claim) await removeClaim(target, claim);
      }
    }
  };

  const checkedName = (name: string): boolean => isValidFileName(name, platform);

  // the link at at kept only while its target, read now unless given, resolves inside root; one that leads out, or whose check
  // cannot finish, is removed while it is still that link, and refused
  const keepWithin = async (at: string, root: string, folder: string, given: string | undefined): Promise<TransferResult> => {
    let made: BigIntStats;
    try {
      made = await fs.lstat(at, { bigint: true });
    } catch (err) {
      return errnoCode(err) === 'ENOENT' ? { ok: true } : failure(err);
    }
    if (!made.isSymbolicLink()) return { ok: true };
    let refusal: TransferResult;
    try {
      if (await resolvesWithin(root, folder, given ?? await fs.readlink(at))) return { ok: true };
      refusal = { ok: false, reason: 'outside' };
    } catch (err) {
      refusal = failure(err);
    }
    // only the link checked goes: another made at its name meanwhile stays
    await removeIfSame(at, made);
    return refusal;
  };

  // pulls source into the part's handle, refusing a byte count other than size; whoever made source returns it
  const fillFrom = (source: AsyncIterator<Uint8Array>, size: number, signal: AbortSignal | undefined) => async (handle: fs.FileHandle): Promise<void> => {
    let written = 0;
    for (;;) {
      let next: IteratorResult<Uint8Array>;
      try {
        signal?.throwIfAborted();
        next = await source.next();
      } catch (err) {
        throw new SourceFailed(err);
      }
      if (next.done) break;
      if (written + next.value.length > size) throw new IncompleteSource(`The source sent more than ${size} bytes`);
      await writeAll(handle, next.value, written);
      written += next.value.length;
    }
    if (written !== size) throw new IncompleteSource(`The source ended after ${written} of ${size} bytes`);
  };

  // a file of this host copied through a part, read from a handle that must still be the file confinement found
  const copyFile = async (source: string, identity: BigIntStats, folder: string, name: string, replace: boolean, signal: AbortSignal | undefined): Promise<TransferResult> => {
    let opened: { readonly handle: fs.FileHandle; readonly size: number };
    try {
      opened = await openSame(source, identity);
    } catch (err) {
      return failure(err);
    }
    const chunks = handleChunks(opened.handle, opened.size)[Symbol.asyncIterator]();
    try {
      return await land(folder, name, replace, { mode: Number(identity.mode), mtimeMs: mtimeMsOf(identity) }, fillFrom(chunks, opened.size, signal));
    } catch (err) {
      if (signal?.aborted) throw err;
      return failure(err);
    } finally {
      await chunks.return?.();
    }
  };

  // rename across file systems: each item is copied, and each source item deleted only after its copy finished; an item below
  // the top that cannot be carried stays and is listed, a folder that cannot be made with everything under it
  const moveAcross = async (source: string, folder: string, name: string, replace: boolean, signal: AbortSignal | undefined): Promise<MoveResult> => {
    const left: string[] = [];
    let leftMore = 0;
    const leave = (relativePath: string): void => {
      if (left.length < MOVE_LEFT_LISTED) left.push(relativePath);
      else leftMore += 1;
    };
    const folders: Array<{ readonly path: string; readonly relativePath: string; readonly identity: EntryIdentity }> = [];
    // the walk lists a folder's entries right after it, so one skipped folder's entries follow it
    let skipping: string | undefined;
    for await (const page of walkPath(source)) {
      for (const entry of page) {
        signal?.throwIfAborted();
        if (skipping !== undefined && entry.relativePath.startsWith(`${skipping}/`)) continue;
        skipping = undefined;
        const top = entry.relativePath === '';
        const from = top ? source : path.join(source, ...entry.relativePath.split('/'));
        const segments = top ? [] : entry.relativePath.split('/');
        const parent = path.join(folder, ...(top ? [] : [name, ...segments.slice(0, -1)]));
        const leaf = top ? name : segments.at(-1)!;
        try {
          if (entry.kind === 'dir') {
            if (entry.unreadable !== undefined) {
              leave(entry.relativePath);
              continue;
            }
            await fs.mkdir(path.join(parent, leaf), folderMode(entry.mode));
            folders.push({ path: from, relativePath: entry.relativePath, identity: entry.identity });
            continue;
          }
          if (entry.kind === 'file') {
            const stat = await fs.lstat(from, { bigint: true });
            const copied = await copyFile(from, stat, parent, leaf, top && replace, signal);
            if (!copied.ok) {
              if (top) return copied;
              leave(entry.relativePath);
              continue;
            }
            await removeIfSame(from, entry.identity);
            continue;
          }
          if (entry.kind === 'link' && platform !== 'win32') {
            await fs.symlink(entry.linkTarget!, path.join(parent, leaf));
            await removeIfSame(from, entry.identity);
            continue;
          }
          leave(entry.relativePath);
        } catch (err) {
          if (top || signal?.aborted) throw err;
          deps.log(`[files] moving ${from} failed: ${errorText(err)}`);
          if (entry.kind === 'dir') skipping = entry.relativePath;
          leave(entry.relativePath);
        }
      }
    }
    for (const made of folders.reverse()) {
      const stat = await lstatOrUndefined(made.path);
      if (!stat?.isDirectory() || !sameEntry(stat, made.identity)) continue;
      try {
        await fs.rmdir(made.path);
      } catch (err) {
        if (errnoCode(err) === 'ENOTEMPTY' || errnoCode(err) === 'EEXIST') continue;
        deps.log(`[files] the moved folder ${made.path} stays: ${errorText(err)}`);
        leave(made.relativePath);
      }
    }
    return { ok: true, left, ...(leftMore > 0 ? { leftMore } : {}) };
  };

  return {
    async *walk(project, relativePath) {
      const root = relativePath === '' ? await confineExisting(project, '') : await confineEntry(project, relativePath);
      if (!root.ok) throw new Error(`${relativePath || '.'} cannot be walked: ${root.reason}`);
      yield* walkPath(root.path);
    },
    async clashes(project, relativeDir, names) {
      const folder = await folderAt(project, relativeDir);
      if (!folder.ok) return folder;
      let present: string[];
      try {
        present = await fs.readdir(folder.path);
      } catch (err) {
        const { code, message } = failure(err);
        return { ok: false, reason: 'failed', ...(code !== undefined ? { code } : {}), ...(message !== undefined ? { message } : {}) };
      }
      const byName = new Map(present.map((name) => [fold(name), name] as const));
      const clashes: Array<Clash | null> = [];
      for (const name of names) {
        const found = byName.get(fold(name));
        const stat = found === undefined ? undefined : await lstatOrUndefined(path.join(folder.path, found));
        clashes.push(found !== undefined && stat ? { name: found, kind: kindOf(stat) } : null);
      }
      return { ok: true, clashes };
    },
    async receiveFile(project, relativeDir, name, source, options, signal) {
      const chunks = source[Symbol.asyncIterator]();
      try {
        if (!checkedName(name)) return { ok: false, reason: 'invalidName' };
        if (!Number.isFinite(options.mtimeMs) || !Number.isSafeInteger(options.mode) || options.mode < 0 || !Number.isSafeInteger(options.size) || options.size < 0) return INVALID;
        const folder = await folderAt(project, relativeDir);
        if (!folder.ok) return folder;
        await sweepStaleParts(folder.path);
        return await land(folder.path, name, options.replace, options, fillFrom(chunks, options.size, signal));
      } finally {
        await chunks.return?.();
      }
    },
    async copy(from, relativePath, to, toDir, name, replace, signal) {
      if (!checkedName(name)) return { ok: false, reason: 'invalidName' };
      const source = await confineEntry(from, relativePath);
      if (!source.ok) return source;
      if (!source.stat.isFile()) return { ok: false, reason: 'notAFile' };
      const folder = await folderAt(to, toDir);
      if (!folder.ok) return folder;
      await sweepStaleParts(folder.path);
      return copyFile(source.path, source.stat, folder.path, name, replace, signal);
    },
    async move(from, relativePath, to, toDir, name, replace, signal) {
      if (!checkedName(name)) return { ok: false, reason: 'invalidName' };
      const source = await confineEntry(from, relativePath);
      if (!source.ok) return source;
      const folder = await folderAt(to, toDir);
      if (!folder.ok) return folder;
      if (source.stat.isDirectory() && isInsideRealRoot(source.path, folder.path)) return { ok: false, reason: 'intoItself' };
      const target = path.join(folder.path, name);
      if (target === source.path) return { ok: true, left: [] };
      // a case-only rename on a case-insensitive file system finds the entry itself under the new name; checked again before
      // every attempt, since a retry waits while another process may make the name
      const targetAllowed = async (): Promise<void> => {
        const existing = await lstatOrUndefined(target);
        if (existing && !sameEntry(existing, source.stat) && (!replace || existing.isDirectory() || source.stat.isDirectory())) throw new TargetTaken();
      };
      try {
        await renameWithRetry(source.path, target, targetAllowed);
        return { ok: true, left: [] };
      } catch (err) {
        if (err instanceof TargetTaken) return { ok: false, reason: 'exists' };
        if (errnoCode(err) !== 'EXDEV') return failure(err);
      }
      try {
        return await moveAcross(source.path, folder.path, name, replace, signal);
      } catch (err) {
        if (signal?.aborted) throw err;
        return failure(err);
      }
    },
    async makeFolder(project, relativeDir, name, mode) {
      if (!checkedName(name)) return { ok: false, reason: 'invalidName' };
      const folder = await folderAt(project, relativeDir);
      if (!folder.ok) return folder;
      const target = path.join(folder.path, name);
      try {
        await fs.mkdir(target, mode === undefined ? undefined : folderMode(mode));
        return { ok: true };
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST') return failure(err);
      }
      // only a real folder merges: a link to one would carry the merge wherever it leads
      const existing = await lstatOrUndefined(target);
      return existing?.isDirectory() === true ? { ok: true } : { ok: false, reason: 'exists' };
    },
    async makeLink(project, relativeDir, name, target, replace, within) {
      if (platform === 'win32') return { ok: false, reason: 'unsupported' };
      if (!checkedName(name)) return { ok: false, reason: 'invalidName' };
      if (target.length === 0 || target.length > MAX_LINK_TARGET_CHARS || target.includes('\0')) return INVALID;
      const folder = await folderAt(project, relativeDir);
      if (!folder.ok) return folder;
      const root = within === undefined ? undefined : await folderAt(project, within);
      if (root && !root.ok) return root;
      const at = path.join(folder.path, name);
      try {
        if (!replace) {
          await fs.symlink(target, at);
        } else {
          const existing = await lstatOrUndefined(at);
          if (existing?.isDirectory()) return { ok: false, reason: 'exists' };
          const part = path.join(folder.path, partName(name));
          await fs.symlink(target, part);
          try {
            await fs.rename(part, at);
          } catch (err) {
            await fs.rm(part, { force: true });
            throw err;
          }
        }
      } catch (err) {
        return errnoCode(err) === 'EEXIST' ? { ok: false, reason: 'exists' } : failure(err);
      }
      if (!root) return { ok: true };
      return keepWithin(at, root.path, folder.path, target);
    },
    async verifyLink(project, relativePath, within) {
      if (platform === 'win32') return { ok: false, reason: 'unsupported' };
      const root = await folderAt(project, within);
      if (!root.ok) return root;
      const entry = await confineEntry(project, relativePath);
      if (!entry.ok) return entry.reason === 'missing' ? { ok: true } : entry;
      if (!entry.stat.isSymbolicLink()) return { ok: true };
      return keepWithin(entry.path, root.path, path.dirname(entry.path), undefined);
    },
    async removeFolder(project, relativePath, confirmed) {
      const entry = await confineEntry(project, relativePath);
      if (!entry.ok) return entry;
      if (!entry.stat.isDirectory()) return { ok: false, reason: 'notFolder' };
      if (!sameEntry(entry.stat, confirmed)) return { ok: false, reason: 'changed' };
      try {
        await fs.rmdir(entry.path);
        return { ok: true };
      } catch (err) {
        const code = errnoCode(err);
        return code === 'ENOTEMPTY' || code === 'EEXIST' ? { ok: false, reason: 'notEmpty' } : failure(err);
      }
    },
    async readFile(project, relativePath) {
      const opened = await openConfinedFile(project, relativePath);
      if (!opened.ok) return opened.reason === 'notAFile' ? { ok: false, reason: 'notAFile' } : opened;
      return { ok: true, size: opened.size, chunks: handleChunks(opened.handle, opened.size) };
    },
    async readFileRange(project, relativePath, offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || length < 0) return { ok: false, reason: 'failed', code: 'EINVAL' };
      const opened = await openConfinedFile(project, relativePath);
      if (!opened.ok) return opened;
      const { handle, size, resolvedPath } = opened;
      const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
      const count = Math.min(length, size - start);
      return { ok: true, size, offset: start, length: count, resolvedPath, chunks: handleChunks(handle, start + count, start) };
    },
  };
}

// A project's regular file, never a link or a folder, opened for reading as the entry confinement checked.
async function openConfinedFile(project: Project, relativePath: string): Promise<{ readonly ok: true; readonly handle: fs.FileHandle; readonly size: number; readonly resolvedPath: string } | Exclude<ReadRangeResult, { readonly ok: true }>> {
  const entry = await confineEntry(project, relativePath);
  if (!entry.ok) return entry;
  if (!entry.stat.isFile()) return { ok: false, reason: 'notAFile', folder: entry.stat.isDirectory() };
  try {
    return { ok: true, resolvedPath: entry.resolvedPath, ...(await openSame(entry.path, entry.stat)) };
  } catch (err) {
    const code = errnoCode(err);
    return { ok: false, reason: code === 'ENOENT' ? 'missing' : 'failed', ...(code !== undefined ? { code } : {}) };
  }
}
