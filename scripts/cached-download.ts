// The build's downloads: retried while a failure may pass, and kept in a cache file accepted only when `valid` holds for its
// bytes, so a pinned hash covers the cached copy too.
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const DOWNLOAD_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
const RETRY_AFTER_CAP_MS = 60_000;
// an attempt that receives no bytes for this long is retried; a slow transfer that keeps sending runs on
export const DOWNLOAD_STALL_MS = 60_000;

export interface DownloadOptions {
  readonly fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  readonly sleep?: (ms: number) => Promise<unknown>;
  readonly random?: () => number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
  readonly attempts?: number;
  readonly stallMs?: number;
}

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
 * The body at `url`, retrying network errors, stalls, 408, 429 and 5xx with backoff. A 404 or any other 4xx fails at once.
 * Retrying is safe because every caller verifies the bytes against a pinned hash.
 */
export async function downloadWithRetry(url: string, {
  fetchImpl = fetch,
  sleep = delay,
  random = Math.random,
  now = Date.now,
  log = console.log,
  attempts = DOWNLOAD_ATTEMPTS,
  stallMs = DOWNLOAD_STALL_MS,
}: DownloadOptions = {}): Promise<Buffer> {
  log(`Downloading ${url}`);
  for (let attempt = 1; ; attempt++) {
    let failure: string | undefined;
    let serverWaitMs = 0;
    const controller = new AbortController();
    let stall: NodeJS.Timeout | undefined;
    const arm = (): void => {
      clearTimeout(stall);
      stall = setTimeout(() => controller.abort(new Error(`no bytes for ${stallMs / 1000} s`)), stallMs);
    };
    arm();
    try {
      const res = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
      if (res.ok) {
        if (!res.body) return Buffer.alloc(0);
        const chunks: Uint8Array[] = [];
        const reader = res.body.getReader();
        for (let read = await reader.read(); !read.done; read = await reader.read()) {
          chunks.push(read.value);
          arm();
        }
        return Buffer.concat(chunks);
      }
      await res.body?.cancel();
      // HTTP/2 responses carry no status text.
      failure = res.statusText ? `${res.status} ${res.statusText}` : String(res.status);
      if (!isTransientStatus(res.status)) throw Object.assign(new Error(`Download failed (${failure}): ${url}`), { permanent: true });
      serverWaitMs = Math.min(RETRY_AFTER_CAP_MS, retryAfterMs(res.headers.get('retry-after'), now()) ?? 0);
    } catch (error) {
      if ((error as { permanent?: boolean }).permanent) throw error;
      failure = message(error);
    } finally {
      clearTimeout(stall);
    }
    if (attempt >= attempts) throw new Error(`Download failed after ${attempts} attempts (${failure}): ${url}`);
    const waitMs = Math.max(serverWaitMs, backoffMs(attempt, random));
    log(`  ${failure}; retrying in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1} of ${attempts})`);
    await sleep(waitMs);
  }
}

/**
 * The bytes from `cached` when they pass `valid`, else from the first of `urls` whose bytes pass, written to `cached` by a
 * rename, so another process reading it meanwhile sees the old file or the whole new one.
 */
export async function cachedDownload(urls: readonly string[], cached: string, valid: (data: Buffer) => boolean, options: DownloadOptions = {}): Promise<Buffer> {
  mkdirSync(dirname(cached), { recursive: true });
  if (existsSync(cached)) {
    const data = readFileSync(cached);
    if (valid(data)) return data;
  }
  const failures: string[] = [];
  const failed = (why: string): void => {
    console.log(why);
    failures.push(why);
  };
  for (const [index, url] of urls.entries()) {
    let data: Buffer;
    try {
      // a source with another after it is asked once, since the next source is the better retry
      data = await downloadWithRetry(url, index < urls.length - 1 ? { ...options, attempts: 1 } : options);
    } catch (err) {
      failed(message(err));
      continue;
    }
    if (!valid(data)) {
      failed(`${url} does not match its pinned hash`);
      continue;
    }
    const part = `${cached}.${randomBytes(6).toString('hex')}.part`;
    writeFileSync(part, data);
    renameSync(part, cached);
    return data;
  }
  throw new Error(`No source gave ${basename(cached)}: ${failures.join('; ')}`);
}
