// A font file the user picked for a theme, read in main because the editor dock also takes a font's bytes from its page.
import { promises as fs } from 'node:fs';

/**
 * The file's bytes through one handle, so the size checked is the size read: 'tooLarge' for a file past `maxBytes`, one that
 * grew past it meanwhile included. Refuses anything but a regular file.
 */
export async function readPickedFont(file: string, maxBytes: number): Promise<Uint8Array | 'tooLarge'> {
  const handle = await fs.open(file, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('The font is not a regular file');
    if (stat.size > maxBytes) return 'tooLarge';
    // one byte more than the cap, so a file that grew after the stat is seen
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    return length > maxBytes ? 'tooLarge' : new Uint8Array(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}
