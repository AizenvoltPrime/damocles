// The build's downloads: retried while a failure may pass, and kept in a cache file accepted only when `valid` holds for its
// bytes, so a pinned hash covers the cached copy too.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DOWNLOAD_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;
// the window an attempt's transfer rate is judged over, as curl's --speed-time
export const DOWNLOAD_STALL_MS = 60_000;
// a source with another after it that sends slower than this over a window gives way to the next, as curl's --speed-limit
export const FALLBACK_MIN_BYTES_PER_SECOND = 256 * 1024;

export interface DownloadOptions {
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly attempts?: number;
  readonly stallMs?: number;
  // an attempt that receives less than this over a stallMs window is retried; by default only one that receives nothing
  readonly minBytesPerSecond?: number;
  // a body longer than this fails the source at once, before it is all held in memory
  readonly maxBytes?: number;
}

class PermanentFailure extends Error {}

/** Statuses a later identical request can succeed after; any other failure is permanent. */
function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** `Retry-After` as seconds or an HTTP date, in milliseconds, or undefined when absent or unreadable. */
function retryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** Exponential backoff with equal jitter: half the step is fixed, half random. */
function backoffMs(attempt: number, random: () => number): number {
  const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return step / 2 + random() * (step / 2);
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * The body at `url`, retrying network errors, transfers under the rate floor, 408, 429 and 5xx with backoff. A 404, any other
 * 4xx and a body past maxBytes fail at once. Retrying is safe because every caller verifies the bytes against a pinned hash.
 */
export async function downloadWithRetry(url: string, {
  fetchImpl = fetch,
  sleep = delay,
  random = Math.random,
  now = Date.now,
  log = console.log,
  attempts = DOWNLOAD_ATTEMPTS,
  stallMs = DOWNLOAD_STALL_MS,
  minBytesPerSecond = 0,
  maxBytes = Infinity,
}: DownloadOptions = {}): Promise<Buffer> {
  log(`Downloading ${url}`);
  const floor = Math.max(1, Math.ceil((minBytesPerSecond * stallMs) / 1000));
  for (let attempt = 1; ; attempt++) {
    let failure: string | undefined;
    let serverWaitMs = 0;
    const controller = new AbortController();
    let windowBytes = 0;
    const slow = setInterval(() => {
      if (windowBytes < floor) {
        const seconds = stallMs / 1000;
        controller.abort(new Error(windowBytes === 0 ? `no bytes for ${seconds} s` : `${windowBytes} bytes in ${seconds} s, under ${minBytesPerSecond} a second`));
      }
      windowBytes = 0;
    }, stallMs);
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
      if (res.ok) {
        const declared = Number(res.headers.get('content-length') ?? 0);
        if (declared > maxBytes) {
          await res.body?.cancel();
          throw new PermanentFailure(`Download failed (${declared} bytes, more than the ${maxBytes} expected): ${url}`);
        }
        if (!res.body) return Buffer.alloc(0);
        const chunks: Uint8Array[] = [];
        let received = 0;
        const reader = res.body.getReader();
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          received += read.value.byteLength;
          if (received > maxBytes) {
            await reader.cancel();
            throw new PermanentFailure(`Download failed (more than the ${maxBytes} bytes expected): ${url}`);
          }
          windowBytes += read.value.byteLength;
          chunks.push(read.value);
        }
        return Buffer.concat(chunks);
      }
      await res.body?.cancel();
      // HTTP/2 responses carry no status text.
      failure = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
      if (!isTransientStatus(res.status)) throw new PermanentFailure(`Download failed (${failure}): ${url}`);
      serverWaitMs = Math.min(RETRY_AFTER_CAP_MS, retryAfterMs(res.headers.get('retry-after'), now()) ?? 0);
    } catch (error) {
      if (error instanceof PermanentFailure) throw error;
      failure = message(error);
    } finally {
      clearInterval(slow);
    }
    if (attempt >= attempts) throw new Error(`Download failed after ${attempts === 1 ? '1 attempt' : `${attempts} attempts`} (${failure}): ${url}`);
    const waitMs = Math.max(serverWaitMs, backoffMs(attempt, random));
    log(`  ${failure}; retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1} of ${attempts})`);
    await sleep(waitMs);
  }
}

const validCopy = (cached: string, valid: (data: Buffer) => boolean): Buffer | undefined => {
  if (!existsSync(cached)) return undefined;
  const data = readFileSync(cached);
  return valid(data) ? data : undefined;
};

/**
 * Writes `data`, which passes `valid`, to `cached` by a rename, so a reader never sees part of a file. Windows refuses a rename
 * onto a file another process has open; that file then holds the valid copy the other process published, which is kept.
 */
export function writeCacheFile(cached: string, data: Buffer, valid: (data: Buffer) => boolean): void {
  mkdirSync(dirname(cached), { recursive: true });
  const part = `${cached}.${randomBytes(6).toString('hex')}.part`;
  try {
    writeFileSync(part, data);
    renameSync(part, cached);
  } catch (err) {
    rmSync(part, { force: true });
    if (!validCopy(cached, valid)) throw err;
  }
}

/** The bytes from `cached` when they pass `valid`, else from the first of `urls` whose bytes pass, then cached (writeCacheFile). */
export async function cachedDownload(urls: readonly string[], cached: string, valid: (data: Buffer) => boolean, options: DownloadOptions = {}): Promise<Buffer> {
  mkdirSync(dirname(cached), { recursive: true });
  const kept = validCopy(cached, valid);
  if (kept) return kept;
  const log = options.log ?? console.log;
  const failures: string[] = [];
  const failed = (why: string): void => {
    log(why);
    failures.push(why);
  };
  for (const [index, url] of urls.entries()) {
    let data: Buffer;
    try {
      // a source with another after it is asked once and must keep a rate, since the next source is the better retry
      data = await downloadWithRetry(url, index < urls.length - 1 ? { minBytesPerSecond: FALLBACK_MIN_BYTES_PER_SECOND, ...options, attempts: 1 } : options);
    } catch (err) {
      failed(message(err));
      continue;
    }
    if (!valid(data)) {
      failed(`${url} does not match its pinned hash`);
      continue;
    }
    writeCacheFile(cached, data, valid);
    return data;
  }
  throw new Error(`No source gave ${basename(cached)}: ${failures.join('; ')}`);
}
