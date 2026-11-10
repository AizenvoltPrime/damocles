// The one read path of a served design file (docs/invariants.md "Design mode"): confined to the design folder, through no link.
import { createHash } from 'node:crypto';
import { constants, promises as fs, type BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import type { DesignFidelity } from '../../shared/types/design';
import { hasUnsafeWindowsSegment, isRelativeFilePath } from '../../shared/relative-path';
import { log } from '../logger';
import { readManifest } from './design-files';
import type { DesignServeRead } from './design-http-server';

/** The largest design file the server sends. */
export const MAX_SERVED_DESIGN_BYTES: number = 16 * 1024 * 1024;

const READ_CHUNK_BYTES = 1024 * 1024;

export type DesignFileRead = { readonly kind: 'file'; readonly bytes: Buffer } | { readonly kind: 'missing' | 'outside' | 'tooLarge' };

const MISSING = { kind: 'missing' } as const;
const OUTSIDE = { kind: 'outside' } as const;
const TOO_LARGE = { kind: 'tooLarge' } as const;

function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isBelow(parent: string, target: string): boolean {
  const relative = path.relative(parent, target);
  return relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`);
}

/**
 * `relPath`, a '/' separated path below design folder `folder`, opened: no segment below the folder may be a link (a junction
 * reads as one), the file's real path must lie below the folder's, and it must be a regular file with one hard link and at
 * most `maxBytes` bytes. A refusal is a result, never a throw; an unexpected IO error throws. The caller closes the handle.
 */
async function openDesignFile(folder: string, relPath: string, maxBytes: number): Promise<{ readonly kind: 'open'; readonly handle: FileHandle; readonly size: number } | Exclude<DesignFileRead, { kind: 'file' }>> {
  if (!isRelativeFilePath(relPath) || hasUnsafeWindowsSegment(relPath)) return OUTSIDE;
  let folderReal: string;
  try {
    folderReal = await fs.realpath(folder);
  } catch (err) {
    if (isMissing(err)) return MISSING;
    throw err;
  }
  const segments = relPath.split('/');
  let target = path.resolve(folder);
  let linked: BigIntStats | undefined;
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment);
    try {
      linked = await fs.lstat(target, { bigint: true });
    } catch (err) {
      if (isMissing(err)) return MISSING;
      throw err;
    }
    if (linked.isSymbolicLink()) return OUTSIDE;
    if (index < segments.length - 1 && !linked.isDirectory()) return MISSING;
  }
  if (!linked?.isFile()) return MISSING;
  let real: string;
  try {
    real = await fs.realpath(target);
  } catch (err) {
    if (isMissing(err)) return MISSING;
    throw err;
  }
  // The real path expands 8.3 names and takes the stored case, as the folder's does, so both compare canonically.
  if (!isBelow(folderReal, real)) return OUTSIDE;
  // An 8.3 alias keeps only 3 characters of the extension (`LONGFI~1.SVG` names `longfilename.svgz`), so the served type must be the real name's.
  if (path.extname(real).toLowerCase() !== path.extname(target).toLowerCase()) return MISSING;
  let handle: FileHandle;
  try {
    // O_NOFOLLOW is POSIX only; on win32 the identity check below catches a link swapped in after the walk. O_NONBLOCK keeps a
    // FIFO swapped in after the walk from holding the open until a writer comes.
    handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (isMissing(err)) return MISSING;
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') return OUTSIDE;
    throw err;
  }
  let opened: BigIntStats;
  try {
    opened = await handle.stat({ bigint: true });
  } catch (err) {
    await handle.close();
    throw err;
  }
  // A hard link shares its bytes with a name outside the folder, which no path comparison sees.
  const refusal = !opened.isFile() || opened.dev !== linked.dev || opened.ino !== linked.ino || opened.nlink !== 1n ? OUTSIDE
    : opened.size > BigInt(maxBytes) ? TOO_LARGE
      : undefined;
  if (refusal) {
    await handle.close();
    return refusal;
  }
  return { kind: 'open', handle, size: Number(opened.size) };
}

/** Whether `relPath` is a design file `readDesignFile` would read, by the same checks, without reading it. */
export async function statDesignFile(folder: string, relPath: string, maxBytes: number): Promise<{ readonly kind: 'file'; readonly size: number } | Exclude<DesignFileRead, { kind: 'file' }>> {
  const opened = await openDesignFile(folder, relPath, maxBytes);
  if (opened.kind !== 'open') return opened;
  await opened.handle.close();
  return { kind: 'file', size: opened.size };
}

/** The bytes of `relPath`, a '/' separated path below design folder `folder`, under `openDesignFile`'s checks. */
export async function readDesignFile(folder: string, relPath: string, maxBytes: number): Promise<DesignFileRead> {
  const opened = await openDesignFile(folder, relPath, maxBytes);
  if (opened.kind !== 'open') return opened;
  const { handle } = opened;
  try {
    // Read at most one byte past the cap, so a file that grew after the stat is refused, never read whole.
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return TOO_LARGE;
    }
    return { kind: 'file', bytes: Buffer.concat(chunks, total) };
  } finally {
    await handle.close();
  }
}

/** The SHA-256 of `relPath`'s bytes under `openDesignFile`'s checks, streamed in chunks, so no file is held whole. */
export async function hashDesignFile(folder: string, relPath: string, maxBytes: number): Promise<{ readonly kind: 'file'; readonly hash: string } | Exclude<DesignFileRead, { kind: 'file' }>> {
  const opened = await openDesignFile(folder, relPath, maxBytes);
  if (opened.kind !== 'open') return opened;
  const { handle } = opened;
  try {
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total), total);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > maxBytes) return TOO_LARGE;
    }
    return { kind: 'file', hash: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

/** The fidelity the design is served with: the manifest's, or null (served as static) when the manifest cannot be read. */
async function servedFidelity(folder: string, designId: string): Promise<DesignFidelity | null> {
  try {
    return (await readManifest(folder, designId)).fidelity;
  } catch (err) {
    log('[DesignFileRead] the manifest of design %s cannot be read, so it is served as static: %O', designId, err);
    return null;
  }
}

/** A design file as the design server sends it: its bytes, and the fidelity read now, so a changed decision applies at once (PD-30). */
export async function readServedDesignFile(folder: string, designId: string, relPath: string): Promise<DesignServeRead> {
  const file = await readDesignFile(folder, relPath, MAX_SERVED_DESIGN_BYTES);
  if (file.kind !== 'file') return file;
  return { kind: 'file', bytes: file.bytes, fidelity: await servedFidelity(folder, designId) };
}
