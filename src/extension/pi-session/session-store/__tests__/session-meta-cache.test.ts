import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

vi.mock('../../../logger', () => ({ log: vi.fn() }));

import * as os from 'node:os';
import { log } from '../../../logger';
import { SESSION_META_CACHE_DIR } from '../../../paths';
import { ensurePiSessionDir } from '../session-dir';
import { currentCachedRow, listPiSessions } from '../reading';
import {
  evictSessionMetaExcept,
  flushSessionMetaCache,
  forgetSessionMeta,
  getSessionMeta,
  metaCacheKey,
  resetSessionMetaCacheMemory,
  setSessionMeta,
  setSessionMetaCacheVersion,
  type SessionMetaEntry,
} from '../session-meta-cache';

const SESSION_DIR = path.join(SESSION_META_CACHE_DIR, '..', '..', 'meta-cache-test', '--work-alpha--');
const fileA = path.join(SESSION_DIR, '0_a.jsonl');
const fileB = path.join(SESSION_DIR, '0_b.jsonl');
const cacheFile = path.join(SESSION_META_CACHE_DIR, `${path.basename(metaCacheKey(SESSION_DIR))}.json`);

const entry = (size: number, mtimeMs: number, extra: Partial<SessionMetaEntry> = {}): SessionMetaEntry => ({
  size,
  mtimeMs,
  stored: { id: 'a', timestamp: mtimeMs, preview: 'hello' },
  prompts: ['hello'],
  ...extra,
});

const CWD = path.join(os.homedir(), 'meta-cache-workspace');
const SESSION_ID = '01a0e000-0000-7000-8000-0000000000aa';

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const userLine = (id: string, parentId: string | null, text: string): string =>
  line({ type: 'message', id, parentId, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 0 } });

function writeSessionFile(text: string): string {
  const file = path.join(ensurePiSessionDir(CWD), `2026-01-01T00-00-00-000Z_${SESSION_ID}.jsonl`);
  fs.writeFileSync(file, line({ type: 'session', version: 3, id: SESSION_ID, timestamp: '2026-01-01T00:00:00.000Z', cwd: CWD }) + userLine('u1', null, text));
  return file;
}

const isCurrent = async (file: string): Promise<boolean> => (await currentCachedRow(file)) !== undefined;
/** A whole-millisecond mtime, which `utimesSync` round-trips exactly. */
const PINNED_MTIME = new Date(1_767_225_600_000);

/** A fresh window: whatever it knows comes from the disk file. */
function newWindow(): void {
  flushSessionMetaCache();
  resetSessionMetaCacheMemory();
}

beforeEach(() => {
  resetSessionMetaCacheMemory();
  fs.rmSync(SESSION_META_CACHE_DIR, { recursive: true, force: true });
  setSessionMetaCacheVersion('1.0.0');
  vi.mocked(log).mockClear();
});

describe('session metadata cache', () => {
  it('serves an unchanged file from disk in a new window, and misses on a size or an mtime change', async () => {
    const file = writeSessionFile('first');
    fs.utimesSync(file, PINNED_MTIME, PINNED_MTIME);
    await listPiSessions(CWD);
    newWindow();

    expect(await isCurrent(file)).toBe(true);

    fs.appendFileSync(file, userLine('u2', 'u1', 'second'));
    fs.utimesSync(file, PINNED_MTIME, PINNED_MTIME);
    expect(fs.statSync(file).mtimeMs).toBe(PINNED_MTIME.getTime());
    expect(await isCurrent(file)).toBe(false);

    await listPiSessions(CWD);
    newWindow();
    expect(await isCurrent(file)).toBe(true);
    fs.utimesSync(file, PINNED_MTIME, new Date(PINNED_MTIME.getTime() + 5000));
    expect(await isCurrent(file)).toBe(false);
  });

  it('keeps a negative result across a reload from disk', () => {
    setSessionMeta(fileB, entry(7, 7, { stored: null, prompts: [] }));
    newWindow();

    expect(getSessionMeta(fileB)).toEqual({ size: 7, mtimeMs: 7, stored: null, prompts: [] });
  });

  it('rebuilds when the extension version changed', () => {
    setSessionMeta(fileA, entry(100, 5000));
    newWindow();
    setSessionMetaCacheVersion('1.0.1');

    expect(getSessionMeta(fileA)).toBeUndefined();
    expect(vi.mocked(log).mock.calls.some(([msg]) => String(msg).includes('rebuilding'))).toBe(true);
  });

  it('evicts files no longer in the dir, on disk too', () => {
    setSessionMeta(fileA, entry(1, 1));
    setSessionMeta(fileB, entry(2, 2));
    evictSessionMetaExcept(SESSION_DIR, new Set([metaCacheKey(fileA)]));
    newWindow();

    expect(getSessionMeta(fileA)).toBeDefined();
    expect(getSessionMeta(fileB)).toBeUndefined();
  });

  it('writes a forget with the next flush', () => {
    setSessionMeta(fileA, entry(1, 1));
    setSessionMeta(fileB, entry(2, 2));
    flushSessionMetaCache();

    forgetSessionMeta(fileA);
    newWindow();

    expect(getSessionMeta(fileA)).toBeUndefined();
    expect(getSessionMeta(fileB)).toBeDefined();
  });

  it('writes on the debounce without blocking the caller, and leaves an unscheduled update to the next flush', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      setSessionMeta(fileA, entry(1, 1), { schedule: false });
      expect(vi.getTimerCount()).toBe(0);

      setSessionMeta(fileB, entry(2, 2));
      vi.advanceTimersByTime(2000);
      expect(fs.existsSync(cacheFile)).toBe(false);
      await vi.waitFor(() => expect(fs.existsSync(cacheFile)).toBe(true));
    } finally {
      vi.useRealTimers();
    }
    expect(fs.readdirSync(SESSION_META_CACHE_DIR)).toEqual([path.basename(cacheFile)]);
    resetSessionMetaCacheMemory();
    expect(getSessionMeta(fileA)).toEqual(entry(1, 1));
    expect(getSessionMeta(fileB)).toEqual(entry(2, 2));
  });

  it('rebuilds when the schema changed', () => {
    setSessionMeta(fileA, entry(1, 1));
    flushSessionMetaCache();
    const doc = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { schema: number };
    fs.writeFileSync(cacheFile, JSON.stringify({ ...doc, schema: doc.schema - 1 }));
    resetSessionMetaCacheMemory();

    expect(getSessionMeta(fileA)).toBeUndefined();
    expect(vi.mocked(log).mock.calls.some(([msg]) => String(msg).includes('rebuilding'))).toBe(true);
  });

  it('a dir loads and writes only its own entries from a cache file a same-named dir shares', () => {
    const otherFile = path.join(SESSION_META_CACHE_DIR, '..', '..', 'meta-cache-test-other', '--work-alpha--', '0_c.jsonl');
    setSessionMeta(otherFile, entry(3, 3));
    flushSessionMetaCache();
    resetSessionMetaCacheMemory();

    setSessionMeta(fileA, entry(1, 1));
    flushSessionMetaCache();

    const written = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as { entries: Record<string, unknown> };
    expect(Object.keys(written.entries)).toEqual([metaCacheKey(fileA)]);
  });

  it('rebuilds and logs when the file is corrupt', () => {
    fs.mkdirSync(SESSION_META_CACHE_DIR, { recursive: true });
    fs.writeFileSync(cacheFile, '{"schema": 1, "extensionVersion": "1.0.0", "entries": {');

    expect(getSessionMeta(fileA)).toBeUndefined();
    expect(vi.mocked(log).mock.calls.some(([msg]) => String(msg).includes('corrupt'))).toBe(true);

    setSessionMeta(fileA, entry(1, 1));
    newWindow();
    expect(getSessionMeta(fileA)).toEqual(entry(1, 1));
  });

  it('rebuilds when an entry has the wrong shape', () => {
    setSessionMeta(fileA, entry(1, 1));
    flushSessionMetaCache();
    const doc = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as object;
    fs.writeFileSync(cacheFile, JSON.stringify({ ...doc, entries: { [metaCacheKey(fileA)]: { size: 1 } } }));
    resetSessionMetaCacheMemory();

    expect(getSessionMeta(fileA)).toBeUndefined();
    expect(vi.mocked(log).mock.calls.some(([msg]) => String(msg).includes('corrupt'))).toBe(true);
  });

  it('keeps the entries dirty when the write fails, so the next flush retries', () => {
    setSessionMeta(fileA, entry(1, 1));
    // A directory in the file's place makes the rename fail, as a file held open by another window does.
    fs.mkdirSync(cacheFile, { recursive: true });
    flushSessionMetaCache();
    expect(vi.mocked(log).mock.calls.some(([msg]) => String(msg).includes('write to'))).toBe(true);
    expect(fs.readdirSync(SESSION_META_CACHE_DIR)).toEqual([path.basename(cacheFile)]);

    fs.rmSync(cacheFile, { recursive: true });
    newWindow();
    expect(getSessionMeta(fileA)).toEqual(entry(1, 1));
  });
});
