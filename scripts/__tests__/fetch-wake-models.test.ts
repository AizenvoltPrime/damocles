import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
// @ts-expect-error -- plain .mjs helper, no types
import { downloadWithRetry, DOWNLOAD_ATTEMPTS, fetchWakeModel, readWakeModel, systemTarPath } from '../fetch-wake-models.mjs';

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

describe('systemTarPath', () => {
  const only = (...paths: string[]) => (path: string) => paths.includes(path);

  it('uses System32 tar.exe on Windows, never one on PATH', () => {
    const tar = join('C:\\Windows', 'System32', 'tar.exe');
    expect(systemTarPath({ platform: 'win32', env: { SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' }, exists: only(tar) })).toBe(tar);
    expect(() => systemTarPath({ platform: 'win32', env: { SystemRoot: 'C:\\Windows' }, exists: only() })).toThrow('tar.exe not found');
    expect(() => systemTarPath({ platform: 'win32', env: {}, exists: only(tar) })).toThrow('SystemRoot is not set');
  });

  it('uses /usr/bin/tar, else /bin/tar, on Linux and macOS', () => {
    expect(systemTarPath({ platform: 'linux', exists: only('/usr/bin/tar', '/bin/tar') })).toBe('/usr/bin/tar');
    expect(systemTarPath({ platform: 'darwin', exists: only('/bin/tar') })).toBe('/bin/tar');
    expect(() => systemTarPath({ platform: 'linux', exists: only() })).toThrow('No tar at /usr/bin/tar or /bin/tar');
  });
});

describe('fetchWakeModel', () => {
  const sha256 = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
  const ENCODER = 'encoder weights';
  const TOKENS = 'tokens';

  let root: string;
  let wakeDir: string;
  let manifestPath: string;
  let archive: Buffer;

  type WakeFile = { filename: string; archive_path: string; sha256: string; bytes: number };
  const wakeFile = (filename: string, content: string): WakeFile =>
    ({ filename, archive_path: `kws/${filename}`, sha256: sha256(content), bytes: Buffer.byteLength(content) });

  function writeManifest(files: WakeFile[], archiveEntry = { sha256: sha256(archive), bytes: archive.byteLength }): void {
    const wake_model = {
      id: 'kws',
      archive: { url: 'https://example.test/kws.tar.bz2', ...archiveEntry },
      files,
    };
    writeFileSync(manifestPath, JSON.stringify({ wake_model }));
  }

  function fetchWith(download = vi.fn(async (_url: string) => archive)) {
    return { download, result: fetchWakeModel({ manifestPath, wakeDir, download, log: () => undefined }) as Promise<{ fetched: number; present: number; removed: string[] }> };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fetch-wake-test-'));
    const source = join(root, 'source', 'kws');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'encoder.int8.onnx'), ENCODER);
    writeFileSync(join(source, 'tokens.txt'), TOKENS);
    writeFileSync(join(source, 'unlisted.onnx'), 'not in the manifest');
    const archivePath = join(root, 'kws.tar.bz2');
    const made = spawnSync(systemTarPath(), ['-cjf', archivePath, '-C', join(root, 'source'), 'kws'], { encoding: 'utf8' });
    expect(made.status, made.stderr).toBe(0);
    archive = readFileSync(archivePath);
    wakeDir = join(root, 'wake');
    mkdirSync(wakeDir);
    writeFileSync(join(wakeDir, '.gitkeep'), '');
    manifestPath = join(root, 'MODEL_MANIFEST.json');
    writeManifest([wakeFile('encoder.int8.onnx', ENCODER), wakeFile('tokens.txt', TOKENS)]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('extracts exactly the listed files and removes a model the manifest no longer lists', async () => {
    writeFileSync(join(wakeDir, 'hey_jarvis.onnx'), 'old model');
    const { download, result } = fetchWith();
    expect(await result).toEqual({ fetched: 2, present: 0, removed: ['hey_jarvis.onnx'] });
    expect(download).toHaveBeenCalledWith('https://example.test/kws.tar.bz2');
    expect(readdirSync(wakeDir).sort()).toEqual(['.gitkeep', 'encoder.int8.onnx', 'tokens.txt']);
    expect(readFileSync(join(wakeDir, 'encoder.int8.onnx'), 'utf8')).toBe(ENCODER);
  });

  it('downloads nothing when every file is present and valid', async () => {
    await fetchWith().result;
    const { download, result } = fetchWith();
    expect(await result).toEqual({ fetched: 0, present: 2, removed: [] });
    expect(download).not.toHaveBeenCalled();
  });

  it('fetches again when a present file differs from the manifest', async () => {
    await fetchWith().result;
    writeFileSync(join(wakeDir, 'tokens.txt'), 'corrupt');
    const { download, result } = fetchWith();
    expect(await result).toEqual({ fetched: 1, present: 1, removed: [] });
    expect(download).toHaveBeenCalledOnce();
    expect(readFileSync(join(wakeDir, 'tokens.txt'), 'utf8')).toBe(TOKENS);
  });

  it('refuses an archive whose checksum differs, writing nothing', async () => {
    writeManifest([wakeFile('encoder.int8.onnx', ENCODER), wakeFile('tokens.txt', TOKENS)], { sha256: '0'.repeat(64), bytes: archive.byteLength });
    await expect(fetchWith().result).rejects.toThrow(`expected sha256 ${'0'.repeat(64)}`);
    expect(readdirSync(wakeDir)).toEqual(['.gitkeep']);
  });

  it('moves no file in when any extracted file fails its check', async () => {
    writeManifest([wakeFile('encoder.int8.onnx', ENCODER), { ...wakeFile('tokens.txt', TOKENS), bytes: 999 }]);
    await expect(fetchWith().result).rejects.toThrow('kws/tokens.txt: expected 999 bytes');
    expect(readdirSync(wakeDir)).toEqual(['.gitkeep']);
  });

  it('names a listed path the archive lacks', async () => {
    writeManifest([{ ...wakeFile('tokens.txt', TOKENS), archive_path: 'kws/missing.txt' }]);
    await expect(fetchWith().result).rejects.toThrow();
    expect(existsSync(join(wakeDir, 'tokens.txt'))).toBe(false);
  });

  it('accepts only a bare file name, since files land directly in the wake directory', () => {
    for (const filename of ['../escape.onnx', 'sub/tokens.txt', '']) {
      writeManifest([{ ...wakeFile('tokens.txt', TOKENS), filename }]);
      expect(() => readWakeModel(manifestPath), filename).toThrow('must be a bare file name');
    }
  });
});
