import type { ReadRangeResult } from '../../../workspace/transfer-ops';
import type { PreviewFileReads } from '../preview-reader';

export const SYNTHETIC_CHUNK_BYTES: number = 64 * 1024;

export interface SyntheticFile {
  readonly reads: PreviewFileReads;
  // the [offset, length] of each ranged read, as asked
  readonly calls: Array<[number, number]>;
  readonly stats: { produced: number; producedBytes: number; returned: number };
}

/**
 * A file of size zero bytes that is never held whole: each read yields views of one shared chunk, produced only when its
 * consumer pulls, and counts what it produced and each read released.
 */
export function syntheticFile(size: number): SyntheticFile {
  const chunk = new Uint8Array(SYNTHETIC_CHUNK_BYTES);
  const calls: Array<[number, number]> = [];
  const stats = { produced: 0, producedBytes: 0, returned: 0 };
  const chunks = (count: number): AsyncIterable<Uint8Array> => {
    let left = count;
    let released = false;
    const iterator: AsyncIterator<Uint8Array> = {
      next: async () => {
        if (released || left === 0) return { done: true, value: undefined };
        const value = chunk.subarray(0, Math.min(left, SYNTHETIC_CHUNK_BYTES));
        left -= value.byteLength;
        stats.produced++;
        stats.producedBytes += value.byteLength;
        return { done: false, value };
      },
      return: async () => {
        if (!released) {
          released = true;
          stats.returned++;
        }
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  };
  const reads: PreviewFileReads = {
    range: async (relativePath, offset, length): Promise<ReadRangeResult> => {
      calls.push([offset, length]);
      const start = offset < 0 ? Math.max(0, size + offset) : Math.min(offset, size);
      const count = Math.min(length, size - start);
      return { ok: true, size, offset: start, length: count, resolvedPath: relativePath, chunks: chunks(count) };
    },
  };
  return { reads, calls, stats };
}
