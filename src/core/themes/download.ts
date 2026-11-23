// A download's two time bounds, shared by every theme download (a theme file, an agent's image source): a stall is timed chunk
// by chunk and the whole download has a deadline, so a large file on a slow link finishes and a server that drips bytes does not
// hold its caller for ever.

export const DOWNLOAD_STALL_MS = 30_000;
export const DOWNLOAD_DEADLINE_MS: number = 10 * 60 * 1000;

export interface DownloadClock {
  // aborts when the caller's signal does, when nothing moved for the stall time, or at the deadline
  readonly signal: AbortSignal;
  // a response or a chunk arrived: the stall time starts again
  moved(): void;
  // which bound ended the download, if one did
  ended(): 'stalled' | 'deadline' | undefined;
  dispose(): void;
}

export function downloadClock(outer: AbortSignal, stallMs: number = DOWNLOAD_STALL_MS, deadlineMs: number = DOWNLOAD_DEADLINE_MS): DownloadClock {
  const stall = new AbortController();
  const deadline = new AbortController();
  let timer = setTimeout(() => stall.abort(), stallMs);
  const whole = setTimeout(() => deadline.abort(), deadlineMs);
  return {
    signal: AbortSignal.any([outer, stall.signal, deadline.signal]),
    moved() {
      clearTimeout(timer);
      timer = setTimeout(() => stall.abort(), stallMs);
    },
    ended: () => (stall.signal.aborted ? 'stalled' : deadline.signal.aborted ? 'deadline' : undefined),
    dispose() {
      clearTimeout(timer);
      clearTimeout(whole);
    },
  };
}

/** The body, counted as it streams whatever Content-Length said: `moved` hears each chunk, and past `max` bytes it stops and throws `tooLarge()`. */
export async function readMovingBody(response: Response, max: number, moved: (chunk: Uint8Array) => void, tooLarge: () => Error): Promise<Uint8Array> {
  const body = response.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      moved(value);
      total += value.byteLength;
      if (total > max) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
