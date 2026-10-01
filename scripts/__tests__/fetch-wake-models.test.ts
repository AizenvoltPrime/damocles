import { describe, it, expect, vi } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no types
import { downloadWithRetry, DOWNLOAD_ATTEMPTS } from '../fetch-wake-models.mjs';

type Reply = Response | Error;

/** A fetch that answers each call with the next scripted reply, recording the options it got. */
function scriptedFetch(replies: Reply[]) {
  const calls: RequestInit[] = [];
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init);
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error('unexpected extra request');
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { fetchImpl, calls };
}

function run(replies: Reply[]) {
  const { fetchImpl, calls } = scriptedFetch(replies);
  const sleep = vi.fn(async (_ms: number) => undefined);
  const result = downloadWithRetry('https://example.test/model.onnx', {
    fetchImpl,
    sleep,
    random: () => 0,
    now: () => Date.parse('2026-10-01T00:00:00Z'),
    log: () => undefined,
  }) as Promise<Buffer>;
  return { result, calls, sleep };
}

const ok = (): Response => new Response('onnx-bytes');
const STATUS_TEXT: Record<number, string> = { 404: 'Not Found', 500: 'Internal Server Error' };
const status = (code: number, headers?: Record<string, string>): Response =>
  new Response('error page', { status: code, statusText: STATUS_TEXT[code] ?? '', headers });

describe('downloadWithRetry', () => {
  it('returns the body of the first good response without waiting', async () => {
    const { result, calls, sleep } = run([ok()]);
    expect((await result).toString()).toBe('onnx-bytes');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a server error with growing backoff until the download succeeds', async () => {
    const { result, sleep } = run([status(500), status(502), status(503), ok()]);
    expect((await result).toString()).toBe('onnx-bytes');
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000]);
  });

  it('retries a network error, a timeout, 408 and 429', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const { result, calls } = run([new TypeError('fetch failed'), timeout, status(408), status(429), ok()]);
    expect((await result).toString()).toBe('onnx-bytes');
    expect(calls).toHaveLength(5);
  });

  it('waits at least as long as Retry-After asks, in seconds or as a date', async () => {
    const { result, sleep } = run([status(503, { 'retry-after': '7' }), status(429, { 'retry-after': 'Thu, 01 Oct 2026 00:00:12 GMT' }), ok()]);
    await result;
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([7_000, 12_000]);
  });

  it('fails at once on a 404, which no retry can fix', async () => {
    const { result, calls, sleep } = run([status(404)]);
    await expect(result).rejects.toThrow('Download failed (404 Not Found): https://example.test/model.onnx');
    expect(calls).toHaveLength(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('gives up after the last attempt and names the last failure', async () => {
    const { result, calls } = run(Array.from({ length: DOWNLOAD_ATTEMPTS }, () => status(500)));
    await expect(result).rejects.toThrow(`Download failed after ${DOWNLOAD_ATTEMPTS} attempts (500 Internal Server Error)`);
    expect(calls).toHaveLength(DOWNLOAD_ATTEMPTS);
  });

  it('names a status without status text by its code', async () => {
    const { result } = run([status(403)]);
    await expect(result).rejects.toThrow('Download failed (403): https://example.test/model.onnx');
  });
});
