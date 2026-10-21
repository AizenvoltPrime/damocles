import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('../store', async (importOriginal) => {
  const real = await importOriginal<typeof import('../store')>();
  return { ...real, openMetaStore: vi.fn(real.openMetaStore) };
});

import { openMetaStore, type MetaStore } from '../store';
import { createMetaIndexRuntime, type MetaIndexRuntime } from '../worker';
import { metaCacheKey, type MetaIndexEvent } from '../protocol';
import { PI_PACKAGE_DIR } from './in-process';

const ROOT = path.join(os.homedir(), 'meta-index-corruption-test');
const CACHE_DIR = path.join(ROOT, 'cache');
const PI_VERSION = (JSON.parse(fs.readFileSync(path.join(PI_PACKAGE_DIR, 'package.json'), 'utf8')) as { version: string }).version;
const corruption = (): Error => Object.assign(new Error('database disk image is malformed'), { errcode: 11 });

/** The real store, except that its first write throws a corruption error. */
function corruptOnFirstWrite(real: MetaStore): MetaStore {
  let thrown = false;
  return {
    ...real,
    file: real.file,
    write(rows) {
      if (!thrown) {
        thrown = true;
        throw corruption();
      }
      real.write(rows);
    },
  };
}

let runtime: MetaIndexRuntime | null = null;

afterEach(async () => {
  await runtime?.close();
  runtime = null;
  vi.mocked(openMetaStore).mockClear();
});

describe('session metadata worker on an index that turns out corrupt mid-run', () => {
  it('deletes and rebuilds the index and runs the write again, so committed puts are not lost', async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    const real = vi.mocked(openMetaStore).getMockImplementation()!;
    vi.mocked(openMetaStore).mockImplementationOnce((dir, version, options) => corruptOnFirstWrite(real(dir, version, options)));
    const file = path.join(ROOT, 'sessions', '2026-01-01T00-00-00-000Z_a.jsonl');
    const events: MetaIndexEvent[] = [];
    runtime = createMetaIndexRuntime((event) => events.push(event), { cacheDir: CACHE_DIR, piPackageDir: PI_PACKAGE_DIR, putCommitMs: 60_000 });
    runtime.handle({ type: 'put', file, entry: { size: 1, mtimeMs: 2, stored: null, prompts: ['kept'] } });

    await runtime.close();
    runtime = null;

    expect(vi.mocked(openMetaStore).mock.calls.map(([, , options]) => options)).toEqual([undefined, { discard: true }]);
    const reader = real(CACHE_DIR, PI_VERSION);
    try {
      expect(reader.entry(metaCacheKey(file))).toEqual({ size: 1, mtimeMs: 2, stored: null, prompts: ['kept'] });
    } finally {
      reader.close();
    }
    expect(events).toEqual([]);
  });
});

const diskFull = (): Error => Object.assign(new Error('database or disk is full'), { errcode: 13 });

/** The real store, except that every write and delete throws SQLITE_FULL. */
function refusingWrites(real: MetaStore): MetaStore {
  return {
    ...real,
    file: real.file,
    write(rows) {
      if (rows.length > 0) throw diskFull();
    },
    delete(keys) {
      if (keys.length > 0) throw diskFull();
    },
  };
}

describe('session metadata worker on an index that refuses writes', () => {
  it('still answers lists, lookups and the prompt history with what it parsed, and closes', async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    const sessions = path.join(ROOT, 'sessions');
    fs.mkdirSync(sessions, { recursive: true });
    const id = '01a0e000-0000-7000-8000-000000000001';
    const file = path.join(sessions, `2026-01-01T00-00-01-000Z_${id}.jsonl`);
    const write = (text: string): void => {
      const header = { type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:01.000Z', cwd: ROOT };
      const message = { type: 'message', id: 'u1', parentId: null, timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 1_700_000_000_001 } };
      fs.writeFileSync(file, `${JSON.stringify(header)}\n${JSON.stringify(message)}\n`);
    };
    write('first');
    const real = vi.mocked(openMetaStore).getMockImplementation()!;
    // An earlier run indexed a file since removed, so the list has a row to evict.
    const earlier = real(CACHE_DIR, PI_VERSION);
    earlier.write([{ key: metaCacheKey(path.join(sessions, 'gone.jsonl')), dirKey: metaCacheKey(sessions), size: 1, mtimeMs: 1, stored: null, prompts: [] }]);
    earlier.close();
    vi.mocked(openMetaStore).mockImplementationOnce((dir, version, options) => refusingWrites(real(dir, version, options)));
    const events: MetaIndexEvent[] = [];
    const until = async (match: (event: MetaIndexEvent) => boolean): Promise<MetaIndexEvent> => {
      for (;;) {
        const found = events.find(match);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    };
    runtime = createMetaIndexRuntime((event) => events.push(event), { cacheDir: CACHE_DIR, piPackageDir: PI_PACKAGE_DIR, putCommitMs: 10 });

    runtime.handle({ type: 'list', id: 1, dir: sessions });
    expect(await until((e) => e.type === 'listDone' && e.id === 1)).toMatchObject({ complete: true });
    const batches = events.filter((e): e is Extract<MetaIndexEvent, { type: 'listBatch' }> => e.type === 'listBatch' && e.id === 1);
    expect(batches.flatMap((b) => b.sessions.map((s) => s.preview))).toEqual(['first']);

    write('second');
    runtime.handle({ type: 'meta', id: 2, file });
    expect(await until((e) => e.type === 'meta' && e.id === 2)).toMatchObject({ stored: { preview: 'second' } });

    runtime.handle({ type: 'promptHistory', id: 3, dirs: [sessions], sessionIds: [id] });
    expect(await until((e) => e.type === 'promptHistory' && e.id === 3)).toMatchObject({ prompts: ['second'] });

    // A live snapshot whose commit fails is still served from memory.
    const { size, mtimeMs } = fs.statSync(file);
    const live = { id, timestamp: 1, createdAt: 1, preview: 'live', messageCount: 1 };
    runtime.handle({ type: 'put', file, entry: { size, mtimeMs, stored: live, prompts: [] } });
    await new Promise((resolve) => setTimeout(resolve, 30));
    runtime.handle({ type: 'cachedRow', id: 4, file });
    expect(await until((e) => e.type === 'cachedRow' && e.id === 4)).toMatchObject({ found: true, stored: live });

    expect(events.filter((e) => e.type === 'error')).toEqual([]);
    await runtime.close();
    runtime = null;
  }, 30_000);
});
