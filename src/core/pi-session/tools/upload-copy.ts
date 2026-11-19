import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { walkTree, type TreeEntry } from '../../search-walk';
import { checkDiskSpace } from '../../disk-space';
import { log } from '../../logger';
import { MIB, UPLOAD_FOLDER_MAX_ENTRIES_SETTING, UPLOAD_FOLDER_MAX_SIZE_SETTING } from '../../../shared/types/constants';

const COPY_CHUNK_BYTES = MIB;
const KIB = 1024;
const OVER_ENTRIES = `the most a folder upload may copy, counting its files, folders and links; the setting ${UPLOAD_FOLDER_MAX_ENTRIES_SETTING} raises that limit.`;
const OVER_BYTES = `the most a folder upload may copy; the setting ${UPLOAD_FOLDER_MAX_SIZE_SETTING} raises that limit.`;

/** A folder upload's snapshot: the copy handed to the browser, how many files it holds, and the entries left out of it. */
export interface UploadCopy {
  readonly copy: string;
  readonly files: number;
  // entries below the folder that are no regular file (links included), with the platform's separators
  readonly leftOut: readonly string[];
}

/** The most a folder upload copies: entries of any kind below the folder, and its regular files' bytes together. */
export interface UploadCaps {
  readonly maxEntries: number;
  readonly maxBytes: number;
}

/** Where a folder upload's copy goes. */
export interface UploadTarget {
  // an existing folder on the volume the copy lands on, for the free-space check
  readonly volume: string;
  // makes the empty folder the copy goes into; called only once the folder passed the caps and the free-space check
  readonly create: () => Promise<string>;
}

/**
 * Copies the regular files `walkTree` lists below folder into `<into.create()>/<folder's name>`, keeping their layout, so the
 * browser reads a snapshot no link reaches into (docs/invariants.md "On win32, a file tool's path that may reach a network host
 * asks"). A count pass first refuses a folder over caps, or one whose size the volume has no room for at 1.5 times, before
 * anything is created; the copy pass holds the caps again. A link is never opened. Each file is opened and must still be the
 * entry its folder listed (file id and type), else the copy rejects. Rejects, with what it copied removed, on signal or any failure.
 */
export async function copyFolderForUpload(folder: string, into: UploadTarget, signal: AbortSignal | undefined, caps: UploadCaps): Promise<UploadCopy> {
  const bytes = await countedBytes(folder, signal, caps);
  const space = await checkDiskSpace(into.volume, bytes).catch((err: unknown) => {
    throw new Error(`Could not read the free space of the browser profile's folder: ${err instanceof Error ? err.message : String(err)}`);
  });
  if (!space.ok) {
    throw new Error(`The folder ${folder} holds ${size(bytes, 'up')}; copying it for the upload needs ${size(space.requiredBytes, 'up')} free in the browser profile's folder, which has ${size(space.freeBytes, 'down')} free.`);
  }
  const copy = path.join(await into.create(), path.basename(folder) || 'folder');
  const leftOut: string[] = [];
  let entries = 0;
  let files = 0;
  let copied = 0;
  // the folder may have changed since the count pass
  const charge = (read: number): void => {
    copied += read;
    if (copied > caps.maxBytes) throw new Error(`The folder ${folder} grew past ${size(caps.maxBytes, 'down')} while it was copied for the upload, ${OVER_BYTES}`);
  };
  try {
    await fs.mkdir(copy);
    for await (const entry of listedEntries(folder, signal)) {
      throwIfAborted(signal);
      if (++entries > caps.maxEntries) throw new Error(`The folder ${folder} grew past ${entryCount(caps.maxEntries)} while it was copied for the upload, ${OVER_ENTRIES}`);
      if (entry.kind === 'folder') await fs.mkdir(path.join(copy, entry.rel));
      else if (entry.kind === 'file') {
        files++;
        await copyListedFile(path.join(folder, entry.rel), path.join(copy, entry.rel), signal, charge);
      } else leftOut.push(entry.rel);
    }
  } catch (err) {
    // what stays is removed with the tab's other copies
    await fs.rm(copy, { recursive: true, force: true }).catch((removal: unknown) =>
      log(`[Browser] A folder-upload copy could not be removed (${copy}) — ${removal instanceof Error ? removal.message : String(removal)}`));
    throw err;
  }
  return { copy, files, leftOut };
}

// The regular files' bytes below folder, by their lstat sizes; rejects as soon as a cap is passed.
async function countedBytes(folder: string, signal: AbortSignal | undefined, caps: UploadCaps): Promise<number> {
  let entries = 0;
  let bytes = 0;
  for await (const entry of listedEntries(folder, signal)) {
    throwIfAborted(signal);
    if (++entries > caps.maxEntries) throw new Error(`The folder ${folder} holds more than ${entryCount(caps.maxEntries)}, ${OVER_ENTRIES}`);
    if (entry.kind !== 'file') continue;
    const file = path.join(folder, entry.rel);
    bytes += (await changedIfGone(file, fs.lstat(file))).size;
    if (bytes > caps.maxBytes) throw new Error(`The folder ${folder} holds more than ${size(caps.maxBytes, 'down')}, ${OVER_BYTES}`);
  }
  return bytes;
}

// The error walkTree aborts with.
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('Operation aborted');
}

function entryCount(count: number): string {
  return count === 1 ? '1 entry' : `${count} entries`;
}

// An amount needed rounds up and one available rounds down, so a shortfall never prints as enough.
function size(bytes: number, round: 'up' | 'down'): string {
  const to = round === 'up' ? Math.ceil : Math.floor;
  if (bytes * 10 >= MIB) {
    const tenths = to((bytes * 10) / MIB);
    return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)} MiB`;
  }
  if (bytes >= KIB) return `${to(bytes / KIB)} KiB`;
  return bytes === 1 ? '1 byte' : `${bytes} bytes`;
}

// Opens source, a file its folder's listing typed as a regular file, and copies it to target with its modification time.
async function copyListedFile(source: string, target: string, signal: AbortSignal | undefined, charge: (bytes: number) => void): Promise<void> {
  const listed = await changedIfGone(source, fs.lstat(source, { bigint: true }));
  if (!listed.isFile()) throw changedError(source);
  // O_NOFOLLOW is POSIX only; on win32 the identity check below catches a link swapped in after the lstat, once the open
  // has followed it. O_NONBLOCK keeps a FIFO swapped in from holding the open until a writer comes.
  const handle = await changedIfGone(source, fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino) throw changedError(source);
    const out = await fs.open(target, 'wx');
    try {
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (let read = await handle.read(chunk, 0, chunk.length, null); read.bytesRead > 0; read = await handle.read(chunk, 0, chunk.length, null)) {
        throwIfAborted(signal);
        charge(read.bytesRead);
        await out.write(chunk, 0, read.bytesRead);
      }
      const modified = new Date(Number(opened.mtimeMs));
      await out.utimes(modified, modified);
    } finally {
      await out.close();
    }
  } finally {
    await handle.close();
  }
}

function changedError(file: string): Error {
  return new Error(`${file} changed while the folder was copied for the upload; try again`);
}

// walkTree's entries, a listed folder gone (or replaced by a file) by its own listing counting as changed, as a gone file does.
async function* listedEntries(folder: string, signal: AbortSignal | undefined): AsyncGenerator<TreeEntry, void, undefined> {
  try {
    yield* walkTree(folder, signal);
  } catch (err) {
    const { code, path: gone } = err as NodeJS.ErrnoException;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw changedError(gone ?? folder);
    throw err;
  }
}

// A listed file that is gone by its lstat or open was removed while the folder was read.
async function changedIfGone<T>(file: string, read: Promise<T>): Promise<T> {
  try {
    return await read;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw changedError(file);
    throw err;
  }
}
