import { open } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';

// The chunk pi's own reader takes, so a read yields to the event loop as often as `SessionManager.openAsync`.
const READ_CHUNK_BYTES = 1024 * 1024;

function parsedLine(line: string): unknown[] {
  if (line.trim() === '') return [];
  try {
    return [JSON.parse(line) as unknown];
  } catch {
    // pi skips a malformed line the same way; a copy read mid-append ends in a torn one
    return [];
  }
}

/**
 * A session file's entries in file order, for a reader that must not write: unlike pi's open, nothing repairs a torn last
 * line or migrates the file. Read in chunks that yield to the event loop, each line parsed once it is whole; a blank or
 * malformed line is skipped. Rejects as a read of the file does, and with the signal's reason once it aborts.
 */
export async function readSessionFileEntries(filePath: string, signal?: AbortSignal): Promise<unknown[]> {
  signal?.throwIfAborted();
  const entries: unknown[] = [];
  const decoder = new StringDecoder('utf8');
  // A line's pieces are joined once its newline arrives, so a line spanning many chunks costs linear time.
  let pieces: string[] = [];
  const take = (text: string): void => {
    let start = 0;
    for (let newline = text.indexOf('\n'); newline !== -1; newline = text.indexOf('\n', start)) {
      pieces.push(text.slice(start, newline));
      entries.push(...parsedLine(pieces.join('')));
      pieces = [];
      start = newline + 1;
    }
    if (start < text.length) pieces.push(text.slice(start));
  };
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      take(decoder.write(buffer.subarray(0, bytesRead)));
    }
  } finally {
    await handle.close();
  }
  take(decoder.end());
  entries.push(...parsedLine(pieces.join('')));
  return entries;
}
