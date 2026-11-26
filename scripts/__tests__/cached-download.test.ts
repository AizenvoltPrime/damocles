import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { cachedDownload, DOWNLOAD_ATTEMPTS, downloadWithRetry } from '../cached-download.ts';

const GOOD = Buffer.from('the pinned bytes');
const hashOf = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const valid = (data: Buffer): boolean => hashOf(data) === hashOf(GOOD);

describe('cachedDownload', () => {
  let server: Server;
  let base: string;
  let dir: string;
  const requests: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      requests.push(req.url ?? '');
      if (req.url === '/good') res.end(GOOD);
      else if (req.url === '/other') res.end('other bytes');
      // headers, then nothing: a connection that stalls mid-download
      else if (req.url === '/stall') res.writeHead(200).flushHeaders();
      // GitHub's archive answered a release build 503 once
      else if (req.url === '/flaky' && requests.filter((url) => url === '/flaky').length > 1) res.end(GOOD);
      else res.writeHead(503).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = mkdtempSync(join(tmpdir(), 'damocles-cached-download-'));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it('moves past a failing, a stalled and a mismatching source to one whose bytes pass, and caches them with no partial file left', async () => {
    const cached = join(dir, 'fallback.bin');
    requests.length = 0;
    const data = await cachedDownload([`${base}/down`, `${base}/stall`, `${base}/other`, `${base}/good`], cached, valid, { stallMs: 300 });
    expect(data).toEqual(GOOD);
    expect(readFileSync(cached)).toEqual(GOOD);
    expect(readdirSync(dir).filter((name) => name.endsWith('.part'))).toEqual([]);
    // each source with another after it is asked once
    expect(requests).toEqual(['/down', '/stall', '/other', '/good']);
  });

  it('retries the last source while its failure may pass', async () => {
    requests.length = 0;
    expect(await cachedDownload([`${base}/flaky`], join(dir, 'flaky.bin'), valid, { sleep: async () => undefined, log: () => undefined })).toEqual(GOOD);
    expect(requests).toEqual(['/flaky', '/flaky']);
  });

  it('retries an attempt that stops sending bytes', async () => {
    await expect(downloadWithRetry(`${base}/stall`, { stallMs: 200, attempts: 2, sleep: async () => undefined, log: () => undefined })).rejects.toThrow(`Download failed after 2 attempts (no bytes for 0.2 s): ${base}/stall`);
  });

  it('names every source\'s failure when none passes, and writes no cache file', async () => {
    const cached = join(dir, 'none.bin');
    await expect(cachedDownload([`${base}/down`, `${base}/other`], cached, valid)).rejects.toThrow(`No source gave none.bin: Download failed after 1 attempts (503 Service Unavailable): ${base}/down; ${base}/other does not match its pinned hash`);
    expect(existsSync(cached)).toBe(false);
  });

  it('reads a cached copy that passes without a request, and downloads again over one that does not', async () => {
    const cached = join(dir, 'kept.bin');
    writeFileSync(cached, GOOD);
    requests.length = 0;
    expect(await cachedDownload([`${base}/good`], cached, valid)).toEqual(GOOD);
    expect(requests).toEqual([]);
    writeFileSync(cached, 'corrupt');
    expect(await cachedDownload([`${base}/good`], cached, valid)).toEqual(GOOD);
    expect(requests).toEqual(['/good']);
  });
});

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
  });
  return { result, calls, sleep };
}

const ok = (): Response => new Response('onnx-bytes');
const STATUS_TEXT: Record<number, string> = { 404: 'Not Found', 500: 'Internal Server Error' };
const status = (code: number, headers: Record<string, string> = {}): Response =>
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
