import { promises as fs } from 'node:fs';
import { EDITOR_MAX_DOCUMENT_BYTES } from '../../shared/types/messages';

// Read size once a file outgrows its stat.
const READ_CHUNK_BYTES = 64 * 1024;

export type FileBytes =
  | { readonly kind: 'bytes'; readonly bytes: Buffer; readonly mtimeMs: number; readonly dev: number; readonly ino: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'tooLarge'; readonly bytes: number }
  | { readonly kind: 'unreadable'; readonly error: string; readonly code?: string };

function errnoCode(err: unknown): string | undefined {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function unreadable(err: unknown): FileBytes {
  const code = errnoCode(err);
  return { kind: 'unreadable', error: err instanceof Error ? err.message : String(err), ...(code !== undefined ? { code } : {}) };
}

function notAFile(filePath: string, stat: { isDirectory(): boolean }): FileBytes {
  return { kind: 'unreadable', error: `${filePath} is not a file`, ...(stat.isDirectory() ? { code: 'EISDIR' } : {}) };
}

/** A regular file's bytes up to the document limit; a file over it is refused from its size before any content is read. */
export async function readFileBytes(filePath: string, limitBytes: number = EDITOR_MAX_DOCUMENT_BYTES): Promise<FileBytes> {
  try {
    // Stat before open: opening a FIFO blocks a libuv thread until a writer appears.
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return notAFile(filePath, stat);
    if (stat.size > limitBytes) return { kind: 'tooLarge', bytes: stat.size };
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'missing' } : unreadable(err);
  }
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(filePath, 'r');
  } catch (err) {
    return errnoCode(err) === 'ENOENT' ? { kind: 'missing' } : unreadable(err);
  }
  try {
    // The path may have been replaced or grown since the stat; the read stops one byte past the limit.
    const stat = await handle.stat();
    if (!stat.isFile()) return notAFile(filePath, stat);
    if (stat.size > limitBytes) return { kind: 'tooLarge', bytes: stat.size };
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(limitBytes + 1 - total, Math.max(stat.size + 1 - total, READ_CHUNK_BYTES)));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
      if (total > limitBytes) return { kind: 'tooLarge', bytes: (await handle.stat()).size };
    }
    return { kind: 'bytes', bytes: Buffer.concat(chunks, total), mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  } catch (err) {
    return unreadable(err);
  } finally {
    await handle.close();
  }
}
