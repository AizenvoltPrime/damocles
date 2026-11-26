// A marker file of a few hundred bytes that a link, a FIFO or a huge file in its place must never hang or exhaust.
import { constants, promises as fs } from 'node:fs';

// O_NOFOLLOW and O_NONBLOCK are POSIX only; on Windows the handle's own stat refuses anything but a file
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export type SmallFile = { readonly text: string } | { readonly refused: string };

/**
 * The file's text, or why it is refused: anything but a regular file (a link included) or one of more than maxBytes.
 * Undefined when there is none; any other failure to read it throws.
 */
export async function readSmallFile(file: string, maxBytes: number): Promise<SmallFile | undefined> {
  const notFile: SmallFile = { refused: 'it is not a regular file' };
  const tooLarge: SmallFile = { refused: `it holds more than ${maxBytes} bytes` };
  let handle: fs.FileHandle;
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return notFile;
    if (stat.size > maxBytes) return tooLarge;
    handle = await fs.open(file, READ_FLAGS);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return undefined;
    // a link swapped in after the lstat
    if (code === 'ELOOP') return notFile;
    throw err;
  }
  try {
    if (!(await handle.stat()).isFile()) return notFile;
    // one byte past the bound, so a file that grew after the lstat is refused, never read whole
    const bytes = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < bytes.length) {
      const { bytesRead } = await handle.read(bytes, filled, bytes.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return filled > maxBytes ? tooLarge : { text: bytes.subarray(0, filled).toString('utf8') };
  } finally {
    await handle.close();
  }
}
