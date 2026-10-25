import * as fs from 'node:fs';
import * as path from 'node:path';
import { sqliteJournalMode } from '../../../network-fs';
import { DatabaseSync } from 'node:sqlite';
import type { StoredSession } from '@shared/types/session';
import { log } from '../../../logger';
import { isCorruption } from '../../../usage-stats/database';
import type { SessionMetaEntry } from './protocol';

/** Bump on any change to what `sessionFileMeta` returns (`__tests__/schema.test.ts` pins it) or to the table below: a new value names a new file. */
export const SESSION_META_SCHEMA = 5;
const BUSY_TIMEOUT_MS = 5000;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  key TEXT PRIMARY KEY,
  dir_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ms REAL NOT NULL,
  stored TEXT,
  prompts TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_dir ON files(dir_key);
`;

/** Apps with the same schema and pi version share one file; a pi upgrade can change what `sessionFileMeta` derives. */
export function indexFileName(piVersion: string): string {
  return `index.s${SESSION_META_SCHEMA}.pi-${piVersion.replace(/[^A-Za-z0-9._-]/g, '_')}.db`;
}

export interface IndexRow extends SessionMetaEntry {
  key: string;
  dirKey: string;
}

export type ListedRow = Pick<IndexRow, 'key' | 'size' | 'mtimeMs' | 'stored'>;

export interface MetaStore {
  /** `:memory:` when the file could not be opened. */
  readonly file: string;
  dirRows(dirKey: string): ListedRow[];
  entry(key: string): SessionMetaEntry | undefined;
  /** One transaction. */
  write(rows: readonly IndexRow[]): void;
  /** One transaction. */
  delete(keys: readonly string[]): void;
  close(): void;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function openDatabase(file: string): DatabaseSync {
  const db = new DatabaseSync(file, { timeout: BUSY_TIMEOUT_MS });
  try {
    db.exec(`PRAGMA journal_mode = ${sqliteJournalMode(file)}`);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    db.exec(SCHEMA_SQL);
    const check = db.prepare('PRAGMA quick_check').all() as Array<{ quick_check: string }>;
    if (check.length !== 1 || check[0]!.quick_check !== 'ok') {
      throw Object.assign(new Error(`quick_check failed: ${check.map((r) => r.quick_check).join('; ').slice(0, 200)}`), { errcode: 11 });
    }
    return db;
  } catch (err) {
    // A corrupt file still opens and holds a Windows file lock until closed, which blocks its deletion.
    db.close();
    throw err;
  }
}

function storeOn(db: DatabaseSync, file: string): MetaStore {
  const selectDir = db.prepare('SELECT key, size, mtime_ms, stored FROM files WHERE dir_key = ?');
  const selectEntry = db.prepare('SELECT size, mtime_ms, stored, prompts FROM files WHERE key = ?');
  const upsert = db.prepare('INSERT OR REPLACE INTO files (key, dir_key, size, mtime_ms, stored, prompts) VALUES (?, ?, ?, ?, ?, ?)');
  const remove = db.prepare('DELETE FROM files WHERE key = ?');
  const parseStored = (value: unknown): StoredSession | null => (typeof value === 'string' ? (JSON.parse(value) as StoredSession) : null);

  function transaction(fn: () => void): void {
    // IMMEDIATE takes the write lock up front, so a second writer waits on busy_timeout instead of failing its upgrade.
    db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      db.exec('COMMIT');
    } catch (err) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw err;
    }
  }

  return {
    file,
    dirRows(dirKey) {
      return (selectDir.all(dirKey) as Array<{ key: string; size: number; mtime_ms: number; stored: unknown }>).map((r) => ({
        key: r.key,
        size: r.size,
        mtimeMs: r.mtime_ms,
        stored: parseStored(r.stored),
      }));
    },
    entry(key) {
      const r = selectEntry.get(key) as { size: number; mtime_ms: number; stored: unknown; prompts: string } | undefined;
      return r ? { size: r.size, mtimeMs: r.mtime_ms, stored: parseStored(r.stored), prompts: JSON.parse(r.prompts) as string[] } : undefined;
    },
    write(rows) {
      if (rows.length === 0) return;
      transaction(() => {
        for (const r of rows) upsert.run(r.key, r.dirKey, r.size, r.mtimeMs, r.stored === null ? null : JSON.stringify(r.stored), JSON.stringify(r.prompts));
      });
    },
    delete(keys) {
      if (keys.length === 0) return;
      transaction(() => {
        for (const key of keys) remove.run(key);
      });
    },
    close() {
      db.close();
    },
  };
}

function inMemory(): MetaStore {
  return storeOn(openDatabase(':memory:'), ':memory:');
}

/** WAL first: a WAL left beside a fresh index would be replayed into it. */
function deleteIndexFiles(file: string): void {
  for (const suffix of ['-wal', '-shm', '']) fs.rmSync(`${file}${suffix}`, { force: true });
}

/**
 * Open the index for `piVersion` in `cacheDir`. A corrupt file, or with `discard` the file as it is, is
 * deleted and rebuilt. When the file cannot be opened or deleted (another process holds it), this process
 * runs on an in-memory index, logged; every row is checked against its file, so either costs only re-reads.
 */
export function openMetaStore(cacheDir: string, piVersion: string, options?: { discard?: boolean }): MetaStore {
  const file = path.join(cacheDir, indexFileName(piVersion));
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    if (options?.discard) deleteIndexFiles(file);
    return storeOn(openDatabase(file), file);
  } catch (err) {
    if (!isCorruption(err)) {
      log('[session-meta-index] cannot open %s (%s); using an in-memory index for this process', file, messageOf(err));
      return inMemory();
    }
    log('[session-meta-index] %s is corrupt (%s); deleting and rebuilding it', file, messageOf(err));
  }
  try {
    deleteIndexFiles(file);
    return storeOn(openDatabase(file), file);
  } catch (err) {
    log('[session-meta-index] cannot rebuild %s (%s); using an in-memory index for this process', file, messageOf(err));
    return inMemory();
  }
}
