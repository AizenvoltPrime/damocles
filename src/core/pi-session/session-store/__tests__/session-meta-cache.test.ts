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
  sessionMetaCacheWriteSettled,
  setSessionMeta,
  setSessionMetaCacheVersion,
  type SessionMetaEntry,
} from '../session-meta-cache';

const SESSION_DIR = path.join(SESSION_META_CACHE_DIR, '..', '..', 'meta-cache-test', '--work-alpha--');
const fileA = path.join(SESSION_DIR, '0_a.jsonl');
const fileB = path.join(SESSION_DIR, '0_b.jsonl');
const cacheFileFor = (sessionDir: string, version: string): string =>
  path.join(SESSION_META_CACHE_DIR, `${path.basename(metaCacheKey(sessionDir))}.${version}.json`);
const cacheFile = cacheFileFor(SESSION_DIR, '1.0.0');

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

beforeEach(async () => {
  resetSessionMetaCacheMemory();
  // A debounced write a slow test left running would land in the next test's cache dir.
  await sessionMetaCacheWriteSettled();
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

  it('keeps one valid file per app version, so hosts on two versions never rebuild each other', async () => {
    const file = writeSessionFile('shared');
    fs.utimesSync(file, PINNED_MTIME, PINNED_MTIME);
    await listPiSessions(CWD);
    newWindow();

    setSessionMetaCacheVersion('2.0.0');
    expect(await isCurrent(file)).toBe(false);
    await listPiSessions(CWD);
    newWindow();
    expect(fs.existsSync(cacheFileFor(path.dirname(file), '1.0.0'))).toBe(true);
    expect(fs.existsSync(cacheFileFor(path.dirname(file), '2.0.0'))).toBe(true);

    for (const version of ['1.0.0', '2.0.0', '1.0.0']) {
      setSessionMetaCacheVersion(version);
      resetSessionMetaCacheMemory();
      expect(await isCurrent(file)).toBe(true);
    }
    expect(vi.mocked(log).mock.calls.some(([msg]) => String(msg).includes('rebuilding'))).toBe(false);
  });

  it('prunes only its own dir\'s files of other versions untouched for 30 days', () => {
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const recent = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const base = path.basename(metaCacheKey(SESSION_DIR));
    const otherDirFile = path.join(SESSION_META_CACHE_DIR, `${base.slice(0, -2)}-longer--.0.9.0.json`);
    const aged = {
      oldVersion: path.join(SESSION_META_CACHE_DIR, `${base}.0.9.0.json`),
      legacyUnversioned: path.join(SESSION_META_CACHE_DIR, `${base}.json`),
      otherDir: otherDirFile,
      ownVersion: cacheFile,
    };
    const recentVersion = path.join(SESSION_META_CACHE_DIR, `${base}.0.9.5.json`);
    fs.mkdirSync(SESSION_META_CACHE_DIR, { recursive: true });
    for (const target of [...Object.values(aged), recentVersion]) fs.writeFileSync(target, '{}');
    for (const target of Object.values(aged)) fs.utimesSync(target, old, old);
    fs.utimesSync(recentVersion, recent, recent);

    setSessionMeta(fileA, entry(1, 1));
    flushSessionMetaCache();

    expect(fs.existsSync(aged.oldVersion)).toBe(false);
    expect(fs.existsSync(aged.legacyUnversioned)).toBe(false);
    expect(fs.existsSync(aged.otherDir)).toBe(true);
    expect(fs.existsSync(recentVersion)).toBe(true);
    expect(getSessionMeta(fileA)).toEqual(entry(1, 1));
    expect(fs.existsSync(cacheFile)).toBe(true);
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
      // Awaited rather than polled: under a loaded suite the write can outlast any polling deadline.
      await sessionMetaCacheWriteSettled();
      expect(fs.existsSync(cacheFile)).toBe(true);
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

  // A schema-2 cache holds rows written before `StoredSession.model` existed; serving one would hide the model for good.
  it('does not serve rows a schema-2 cache wrote, so a listed session carries its model', async () => {
    const file = writeSessionFile('first');
    fs.appendFileSync(file, line({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }], provider: 'anthropic', model: 'claude-opus-4-8', timestamp: 0 } }));
    fs.utimesSync(file, PINNED_MTIME, PINNED_MTIME);
    expect((await listPiSessions(CWD))[0]?.model).toEqual({ provider: 'anthropic', id: 'claude-opus-4-8' });
    flushSessionMetaCache();

    const sessionCacheFile = cacheFileFor(ensurePiSessionDir(CWD), '1.0.0');
    const doc = JSON.parse(fs.readFileSync(sessionCacheFile, 'utf8')) as { entries: Record<string, SessionMetaEntry> };
    for (const cached of Object.values(doc.entries)) if (cached.stored) delete cached.stored.model;
    fs.writeFileSync(sessionCacheFile, JSON.stringify({ ...doc, schema: 2 }));
    resetSessionMetaCacheMemory();

    expect((await listPiSessions(CWD))[0]?.model).toEqual({ provider: 'anthropic', id: 'claude-opus-4-8' });
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
