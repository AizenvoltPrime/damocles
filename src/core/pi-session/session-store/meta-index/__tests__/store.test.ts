import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { indexFileName, openMetaStore, SESSION_META_SCHEMA, type IndexRow, type MetaStore } from '../store';

const CACHE_DIR = path.join(os.homedir(), 'meta-index-store-test');
const DIR_KEY = path.join(CACHE_DIR, 'sessions');

const row = (name: string, size: number, preview = name): IndexRow => ({
  key: path.join(DIR_KEY, name),
  dirKey: DIR_KEY,
  size,
  mtimeMs: 1_767_225_600_000.25,
  stored: { id: name, timestamp: 1, createdAt: 1, preview, messageCount: 1 },
  prompts: [preview],
});

const open: MetaStore[] = [];
const openStore = (version = '1.3.0'): MetaStore => {
  const store = openMetaStore(CACHE_DIR, version);
  open.push(store);
  return store;
};

beforeEach(() => {
  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
});

afterEach(() => {
  for (const store of open.splice(0)) store.close();
});

describe('session metadata index store', () => {
  it('names its file by the schema and the pi version, so a pi upgrade starts a new file', () => {
    expect(SESSION_META_SCHEMA).toBe(5);
    expect(indexFileName('1.3.0')).toBe('index.s5.pi-1.3.0.db');
    expect(indexFileName('2.0.0-beta/1')).toBe('index.s5.pi-2.0.0-beta_1.db');

    const old = openStore('1.3.0');
    old.write([row('a.jsonl', 10)]);
    const upgraded = openStore('1.4.0');

    expect(upgraded.file).toBe(path.join(CACHE_DIR, 'index.s5.pi-1.4.0.db'));
    expect(upgraded.entry(row('a.jsonl', 10).key)).toBeUndefined();
    expect(old.entry(row('a.jsonl', 10).key)).toMatchObject({ size: 10 });
  });

  it('round-trips the mtime exactly, fractional milliseconds included', () => {
    const store = openStore();
    store.write([row('a.jsonl', 10)]);
    expect(store.entry(row('a.jsonl', 10).key)).toEqual({ size: 10, mtimeMs: 1_767_225_600_000.25, stored: row('a.jsonl', 10).stored, prompts: ['a.jsonl'] });
    expect(store.dirRows(DIR_KEY)).toEqual([{ key: row('a.jsonl', 10).key, size: 10, mtimeMs: 1_767_225_600_000.25, stored: row('a.jsonl', 10).stored }]);
  });

  it('caches a negative as a null row', () => {
    const store = openStore();
    store.write([{ ...row('dead.jsonl', 3), stored: null, prompts: [] }]);
    expect(store.entry(row('dead.jsonl', 3).key)).toEqual({ size: 3, mtimeMs: 1_767_225_600_000.25, stored: null, prompts: [] });
  });

  it('deletes a corrupt file and rebuilds it', () => {
    const file = path.join(CACHE_DIR, indexFileName('1.3.0'));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, 'this is not a database, only text long enough to fill a header'.repeat(100));

    const store = openStore();
    expect(store.file).toBe(file);
    store.write([row('a.jsonl', 10)]);
    expect(store.entry(row('a.jsonl', 10).key)).toMatchObject({ size: 10 });
  });

  it('runs on an in-memory index when the file cannot be opened', () => {
    // A file where the cache dir should be: neither mkdir nor the open can succeed.
    fs.mkdirSync(path.dirname(CACHE_DIR), { recursive: true });
    fs.writeFileSync(CACHE_DIR, 'occupied');
    try {
      const store = openStore();
      expect(store.file).toBe(':memory:');
      store.write([row('a.jsonl', 10)]);
      expect(store.entry(row('a.jsonl', 10).key)).toMatchObject({ size: 10 });
    } finally {
      for (const store of open.splice(0)) store.close();
      fs.rmSync(CACHE_DIR, { force: true });
    }
  });

  it.runIf(process.platform === 'win32')('runs on an in-memory index when a corrupt file is held open by another process', () => {
    const file = path.join(CACHE_DIR, indexFileName('1.3.0'));
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, 'not a database'.repeat(400));
    // Windows refuses to delete a file another handle holds open.
    const holder = new DatabaseSync(file);
    try {
      expect(openStore().file).toBe(':memory:');
    } finally {
      holder.close();
    }
  });

  it('shares one file between two writers, last writer wins per row', () => {
    const a = openStore();
    const b = openStore();
    a.write([row('a.jsonl', 10), row('b.jsonl', 20)]);
    expect(b.entry(row('a.jsonl', 10).key)).toMatchObject({ size: 10 });

    b.write([row('a.jsonl', 11, 'from b')]);
    expect(a.entry(row('a.jsonl', 11).key)).toMatchObject({ size: 11, stored: { preview: 'from b' } });

    a.delete([row('b.jsonl', 20).key]);
    expect(b.dirRows(DIR_KEY).map((r) => r.key)).toEqual([row('a.jsonl', 11).key]);
  });
});
