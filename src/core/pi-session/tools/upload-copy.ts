import { constants, promises as fs } from 'node:fs';
import * as path from 'node:path';
import { walkTree } from './search-walk';
import { log } from '../../logger';

const COPY_CHUNK_BYTES = 1024 * 1024;

/** A folder upload's snapshot: the copy handed to the browser, how many files it holds, and the entries left out of it. */
export interface UploadCopy {
  readonly copy: string;
  readonly files: number;
  // entries below the folder that are no regular file (links included), with the platform's separators
  readonly leftOut: readonly string[];
}

/**
 * Copies the regular files `walkTree` lists below folder into `into/<folder's name>`, keeping their layout, so the browser reads
 * a snapshot no link reaches into (docs/invariants.md "On win32, a file tool's path that may reach a network host asks"). A link
 * is never opened. Each file is opened and must still be the entry its folder listed (file id and type), else the copy rejects.
 * Rejects, with what it copied removed, on signal or any failure.
 */
export async function copyFolderForUpload(folder: string, into: string, signal: AbortSignal | undefined): Promise<UploadCopy> {
  const copy = path.join(into, path.basename(folder) || 'folder');
  const leftOut: string[] = [];
  let files = 0;
  try {
    await fs.mkdir(copy);
    for await (const entry of walkTree(folder, signal)) {
      if (entry.kind === 'folder') await fs.mkdir(path.join(copy, entry.rel));
      else if (entry.kind === 'file') {
        await copyListedFile(path.join(folder, entry.rel), path.join(copy, entry.rel), signal);
        files++;
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

// Opens source, a file its folder's listing typed as a regular file, and copies it to target with its modification time.
async function copyListedFile(source: string, target: string, signal: AbortSignal | undefined): Promise<void> {
  const listed = await fs.lstat(source, { bigint: true });
  if (!listed.isFile()) throw changedError(source);
  // O_NOFOLLOW is POSIX only; on win32 the identity check below catches a link swapped in after the lstat, once the open
  // has followed it. O_NONBLOCK keeps a FIFO swapped in from holding the open until a writer comes.
  const handle = await fs.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== listed.dev || opened.ino !== listed.ino) throw changedError(source);
    const out = await fs.open(target, 'wx');
    try {
      const chunk = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      for (let read = await handle.read(chunk, 0, chunk.length, null); read.bytesRead > 0; read = await handle.read(chunk, 0, chunk.length, null)) {
        signal?.throwIfAborted();
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
