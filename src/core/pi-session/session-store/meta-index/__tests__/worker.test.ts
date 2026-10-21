import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createMetaIndexRuntime, pruneCacheDir, PRUNE_AFTER_MS, type MetaIndexRuntime, type MetaIndexRuntimeOptions } from '../worker';
import type { ParsedMeta, SessionFileParser } from '../parser';
import { indexFileName, openMetaStore } from '../store';
import { metaCacheKey, type MetaIndexEvent } from '../protocol';
import { inProcessIndex, PI_PACKAGE_DIR, workerPi } from './in-process';

const ROOT = path.join(os.homedir(), 'meta-index-worker-test');
const CACHE_DIR = path.join(ROOT, 'cache');
const SESSIONS = path.join(ROOT, 'sessions');
const PI_VERSION = (JSON.parse(fs.readFileSync(path.join(PI_PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;

const pi = await workerPi();

function writeSession(n: number, text = `prompt ${n}`): string {
  const id = `01a0e000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const file = path.join(SESSIONS, `2026-01-01T00-00-0${n % 10}-000Z_${id}.jsonl`);
  const header = { type: 'session', version: 3, id, timestamp: `2026-01-01T00:00:0${n % 10}.000Z`, cwd: ROOT };
  const message = { type: 'message', id: `u${n}`, parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1_700_000_000_000 + n } };
  fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
  return file;
}

interface Harness {
  runtime: MetaIndexRuntime;
  events: MetaIndexEvent[];
  /** Resolves with the first event, from the start, that `match` accepts. */
  until(match: (event: MetaIndexEvent) => boolean): Promise<MetaIndexEvent>;
}

const runtimes: MetaIndexRuntime[] = [];

function harness(options: Partial<Omit<MetaIndexRuntimeOptions, 'cacheDir' | 'piPackageDir'>> = {}): Harness {
  const events: MetaIndexEvent[] = [];
  const waiters: Array<() => void> = [];
  const runtime = createMetaIndexRuntime((event) => {
    events.push(event);
    for (const wake of waiters.splice(0)) wake();
  }, { cacheDir: CACHE_DIR, piPackageDir: PI_PACKAGE_DIR, ...options });
  runtimes.push(runtime);
  const until = async (match: (event: MetaIndexEvent) => boolean): Promise<MetaIndexEvent> => {
    for (;;) {
      const found = events.find(match);
      if (found) return found;
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  };
  return { runtime, events, until };
}

let nextId = 1;

async function list(h: Harness): Promise<{ id: number; events: MetaIndexEvent[] }> {
  const id = nextId++;
  h.runtime.handle({ type: 'list', id, dir: SESSIONS });
  await h.until((e) => e.type === 'listDone' && e.id === id);
  return { id, events: h.events.filter((e) => 'id' in e && e.id === id) };
}

async function cachedRow(h: Harness, file: string): Promise<Extract<MetaIndexEvent, { type: 'cachedRow' }>> {
  const id = nextId++;
  h.runtime.handle({ type: 'cachedRow', id, file });
  return (await h.until((e) => e.type === 'cachedRow' && e.id === id)) as Extract<MetaIndexEvent, { type: 'cachedRow' }>;
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(SESSIONS, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(runtimes.splice(0).map((r) => r.close()));
});

describe('session metadata worker', () => {
  it('serves a row only while both the size and the mtime of its file match', async () => {
    const file = writeSession(1);
    const h = harness();
    await list(h);
    expect((await cachedRow(h, file)).found).toBe(true);

    const mtime = new Date(1_767_225_600_000);
    fs.utimesSync(file, mtime, mtime);
    expect((await cachedRow(h, file)).found).toBe(false);
    await list(h);
    expect((await cachedRow(h, file)).found).toBe(true);

    // Same mtime, longer file: pi appends, so the size catches a write within the mtime's resolution.
    fs.appendFileSync(file, '\n');
    fs.utimesSync(file, mtime, mtime);
    expect((await cachedRow(h, file)).found).toBe(false);
  });

  it('evicts the rows of files gone from the dir', async () => {
    const kept = writeSession(1);
    const gone = writeSession(2);
    const h = harness();
    await list(h);
    fs.rmSync(gone);
    await list(h);

    const reader = openMetaStore(CACHE_DIR, PI_VERSION);
    try {
      expect(reader.entry(metaCacheKey(gone))).toBeUndefined();
      expect(reader.entry(metaCacheKey(kept))).toBeDefined();
    } finally {
      reader.close();
    }
  });

  it('a cold list answers with its valid rows first, then delivers the parsed rows in batches', async () => {
    writeSession(1);
    writeSession(2);
    const h = harness({ listBatchSize: 2, listBatchMs: 60_000 });
    await list(h);
    writeSession(3);
    writeSession(4);
    writeSession(5);

    const { events } = await list(h);

    expect(events.map((e) => e.type)).toEqual(['listed', 'listBatch', 'listBatch', 'listDone']);
    const [listed, first, second] = events as [Extract<MetaIndexEvent, { type: 'listed' }>, Extract<MetaIndexEvent, { type: 'listBatch' }>, Extract<MetaIndexEvent, { type: 'listBatch' }>];
    expect(listed.sessions.map((s) => s.preview).sort()).toEqual(['prompt 1', 'prompt 2']);
    expect(listed.files).toHaveLength(5);
    expect(listed.parsing).toBe(3);
    expect(first.sessions).toHaveLength(2);
    expect([...first.sessions, ...second.sessions].map((s) => s.preview).sort()).toEqual(['prompt 3', 'prompt 4', 'prompt 5']);
  });

  it('answers other requests from the index while a parse is still running', async () => {
    const parsed = writeSession(1);
    const releases: Array<() => void> = [];
    const parser: SessionFileParser = {
      parse: () => new Promise<ParsedMeta | undefined>((resolve) => releases.push(() => resolve({ stored: null, prompts: [] }))),
      close: async () => undefined,
    };
    const h = harness({ parser });
    const id = nextId++;
    h.runtime.handle({ type: 'list', id, dir: SESSIONS });
    await h.until((e) => e.type === 'listed' && e.id === id);
    await vi.waitFor(() => expect(releases).toHaveLength(1));

    const empty = path.join(ROOT, 'empty');
    fs.mkdirSync(empty);
    const other = nextId++;
    h.runtime.handle({ type: 'list', id: other, dir: empty });
    await h.until((e) => e.type === 'listDone' && e.id === other);
    expect((await cachedRow(h, parsed)).found).toBe(false);
    expect(h.events.some((e) => e.type === 'listDone' && e.id === id)).toBe(false);

    releases[0]!();
    await h.until((e) => e.type === 'listDone' && e.id === id);
  });

  it('a list whose parses are slow sends what it parsed at least every listBatchMs, before its batch fills', async () => {
    for (const n of [1, 2, 3, 4]) writeSession(n);
    const parser: SessionFileParser = {
      parse: () => new Promise<ParsedMeta | undefined>((resolve) => setTimeout(() => resolve({ stored: null, prompts: [] }), 60)),
      close: async () => undefined,
    };
    const h = harness({ parser, listBatchSize: 16, listBatchMs: 100 });

    const { events } = await list(h);

    const batches = events.filter((e) => e.type === 'listBatch');
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)?.type).toBe('listDone');
  });

  it('keeps sending while one parse runs longer than listBatchMs, so the client sees the list alive', async () => {
    writeSession(1);
    let release!: () => void;
    const parser: SessionFileParser = {
      parse: () => new Promise<ParsedMeta | undefined>((resolve) => { release = () => resolve({ stored: null, prompts: [] }); }),
      close: async () => undefined,
    };
    const h = harness({ parser, listBatchMs: 20 });
    const id = nextId++;
    h.runtime.handle({ type: 'list', id, dir: SESSIONS });
    await vi.waitFor(() => expect(h.events.filter((e) => e.type === 'listBatch' && e.id === id).length).toBeGreaterThanOrEqual(2));

    expect(h.events.some((e) => e.type === 'listDone' && e.id === id)).toBe(false);
    release();
    await h.until((e) => e.type === 'listDone' && e.id === id);
  });

  it('ends a list incomplete when a parse could not finish, and complete when every file yielded its row', async () => {
    writeSession(1);
    writeSession(2);
    let yields = 0;
    const parser: SessionFileParser = {
      parse: async () => (yields++ === 0 ? undefined : { stored: null, prompts: [] }),
      close: async () => undefined,
    };
    const h = harness({ parser });

    expect((await list(h)).events.at(-1)).toMatchObject({ type: 'listDone', complete: false });
    expect((await list(h)).events.at(-1)).toMatchObject({ type: 'listDone', complete: true });
  });

  it('a missing dir lists complete and empty; one that cannot be read lists incomplete', async () => {
    const h = harness();
    const missing = nextId++;
    h.runtime.handle({ type: 'list', id: missing, dir: path.join(ROOT, 'no-such-dir') });
    expect(await h.until((e) => e.type === 'listDone' && e.id === missing)).toMatchObject({ complete: true });

    const notADir = path.join(ROOT, 'a-file');
    fs.writeFileSync(notADir, 'x');
    const unreadable = nextId++;
    h.runtime.handle({ type: 'list', id: unreadable, dir: notADir });
    expect(await h.until((e) => e.type === 'listDone' && e.id === unreadable)).toMatchObject({ complete: false });
  });

  it('a parse that read the file before a live put keeps the newer put, and one that read it after drops it', async () => {
    const file = writeSession(1);
    const { size, mtimeMs } = fs.statSync(file);
    const live = { id: 'live', timestamp: 1, createdAt: 1, preview: 'live snapshot', messageCount: 2 };
    // The parse saw the file one append earlier than the put did.
    const olderStat = { size: size - 1, mtimeMs: mtimeMs - 1 };
    const parser: SessionFileParser = { parse: async () => ({ stored: null, prompts: [] }), close: async () => undefined };
    const h = harness({ parser, putCommitMs: 60_000 });
    h.runtime.handle({ type: 'put', file, entry: { size, mtimeMs, stored: live, prompts: [] } });
    vi.spyOn(fs.promises, 'stat').mockResolvedValueOnce(olderStat as fs.Stats);
    const stale = nextId++;
    h.runtime.handle({ type: 'meta', id: stale, file });
    await h.until((e) => e.type === 'meta' && e.id === stale);

    expect(await cachedRow(h, file)).toMatchObject({ found: true, stored: live });

    fs.appendFileSync(file, '\n');
    const fresh = nextId++;
    h.runtime.handle({ type: 'meta', id: fresh, file });
    await h.until((e) => e.type === 'meta' && e.id === fresh);
    expect(await cachedRow(h, file)).toMatchObject({ found: true, stored: null });
  });

  it('closes its parser when it closes', async () => {
    const close = vi.fn(async () => undefined);
    const runtime = createMetaIndexRuntime(() => undefined, { cacheDir: CACHE_DIR, piPackageDir: PI_PACKAGE_DIR, parser: { parse: async () => undefined, close } });
    await runtime.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a warm list and cachedRow on an unchanged file never call SessionManager.open', async () => {
    const file = writeSession(1);
    const fresh = writeSession(2);
    await list(harness());
    const open = vi.spyOn(pi.SessionManager, 'open');
    const h = harness();

    const { events } = await list(h);
    expect(events[0]).toMatchObject({ type: 'listed', parsing: 0 });
    expect(await cachedRow(h, file)).toMatchObject({ found: true, stored: { preview: 'prompt 1' } });
    fs.appendFileSync(fresh, '\n');
    expect((await cachedRow(h, fresh)).found).toBe(false);

    expect(open).not.toHaveBeenCalled();
  });

  it('serves a put from memory at once and commits it after the debounce', async () => {
    const file = writeSession(1);
    const { size, mtimeMs } = fs.statSync(file);
    const h = harness({ putCommitMs: 20 });
    const stored = { id: 'live', timestamp: 1, createdAt: 1, preview: 'live snapshot', messageCount: 9 };
    h.runtime.handle({ type: 'put', file, entry: { size, mtimeMs, stored, prompts: ['live'] } });

    expect(await cachedRow(h, file)).toMatchObject({ found: true, stored });
    const reader = openMetaStore(CACHE_DIR, PI_VERSION);
    try {
      await vi.waitFor(() => expect(reader.entry(metaCacheKey(file))).toMatchObject({ stored }));
    } finally {
      reader.close();
    }
  });

  it('a pending put decides alone: the stored row of the file is not served while the put disagrees with the file', async () => {
    const file = writeSession(1);
    const { size, mtimeMs } = fs.statSync(file);
    const h = harness({ putCommitMs: 60_000 });
    await list(h);
    h.runtime.handle({ type: 'put', file, entry: { size: size + 1, mtimeMs, stored: null, prompts: [] } });

    expect((await cachedRow(h, file)).found).toBe(false);
  });

  it('close commits pending puts', async () => {
    const file = writeSession(1);
    const { size, mtimeMs } = fs.statSync(file);
    const h = harness({ putCommitMs: 60_000 });
    h.runtime.handle({ type: 'put', file, entry: { size, mtimeMs, stored: null, prompts: [] } });
    await h.runtime.close();
    runtimes.splice(runtimes.indexOf(h.runtime), 1);

    const reader = openMetaStore(CACHE_DIR, PI_VERSION);
    try {
      expect(reader.entry(metaCacheKey(file))).toEqual({ size, mtimeMs, stored: null, prompts: [] });
    } finally {
      reader.close();
    }
  });

  it('forget drops a pending put and the stored row', async () => {
    const file = writeSession(1);
    const h = harness();
    await list(h);
    h.runtime.handle({ type: 'forget', file });
    expect((await cachedRow(h, file)).found).toBe(false);
  });

  it('meta of a missing file yields no row and never creates it', async () => {
    const h = harness();
    const file = path.join(SESSIONS, '2026-01-01T00-00-00-000Z_missing.jsonl');
    h.runtime.handle({ type: 'meta', id: 999, file });
    expect(await h.until((e) => e.type === 'meta' && e.id === 999)).toMatchObject({ stored: null });
    expect(fs.existsSync(file)).toBe(false);
  });

  it('prompt history walks the sessions in order, newest prompt first, each prompt once', async () => {
    const a = writeSession(1, 'shared');
    writeSession(2, 'only b');
    const h = harness();
    const id = nextId++;
    h.runtime.handle({ type: 'promptHistory', id, dirs: [SESSIONS], sessionIds: [path.basename(a, '.jsonl').split('_')[1]!, '01a0e000-0000-7000-8000-000000000002', 'no-such-session'] });
    expect(await h.until((e) => e.type === 'promptHistory' && e.id === id)).toMatchObject({ prompts: ['shared', 'only b'], opened: 2 });
  });

  it('a client put is seen by the cachedRow posted right after it', async () => {
    const file = writeSession(1);
    const { size, mtimeMs } = fs.statSync(file);
    const { index } = inProcessIndex({ cacheDir: CACHE_DIR });
    try {
      const stored = { id: 'live', timestamp: 1, createdAt: 1, preview: 'live', messageCount: 1 };
      index.put(file, { size, mtimeMs, stored, prompts: [] });
      expect(await index.cachedRow(file)).toEqual(stored);
    } finally {
      await index.close();
    }
  });
});

describe('cache dir pruning', () => {
  it('deletes legacy JSON caches and other index files unwritten for 30 days, never its own', async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const own = indexFileName(PI_VERSION);
    const old = new Date(Date.now() - PRUNE_AFTER_MS - 60_000);
    const files = {
      ownDb: own,
      ownWal: `${own}-wal`,
      oldLegacy: '--work-alpha--.1.0.0.json',
      oldLegacyTmp: '--work-alpha--.1.0.0.json.123.0f6a-11.tmp',
      recentLegacy: '--work-beta--.1.2.0.json',
      oldIndex: 'index.s4.pi-1.2.0.db',
      oldIndexWal: 'index.s4.pi-1.2.0.db-wal',
      recentIndex: 'index.s5.pi-1.4.0.db',
      unrelated: 'notes.txt',
    };
    for (const name of Object.values(files)) fs.writeFileSync(path.join(CACHE_DIR, name), 'x');
    for (const name of [files.ownDb, files.ownWal, files.oldLegacy, files.oldLegacyTmp, files.oldIndex, files.oldIndexWal, files.unrelated]) {
      fs.utimesSync(path.join(CACHE_DIR, name), old, old);
    }

    await pruneCacheDir(CACHE_DIR, own);

    expect(fs.readdirSync(CACHE_DIR).sort()).toEqual([files.ownDb, files.ownWal, files.recentIndex, files.recentLegacy, files.unrelated].sort());
  });

  it('keeps an old index whose WAL another app still writes', async () => {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const old = new Date(Date.now() - PRUNE_AFTER_MS - 60_000);
    fs.writeFileSync(path.join(CACHE_DIR, 'index.s5.pi-1.2.0.db'), 'x');
    fs.writeFileSync(path.join(CACHE_DIR, 'index.s5.pi-1.2.0.db-wal'), 'x');
    fs.utimesSync(path.join(CACHE_DIR, 'index.s5.pi-1.2.0.db'), old, old);

    await pruneCacheDir(CACHE_DIR, indexFileName(PI_VERSION));

    expect(fs.readdirSync(CACHE_DIR).sort()).toEqual(['index.s5.pi-1.2.0.db', 'index.s5.pi-1.2.0.db-wal']);
  });
});
