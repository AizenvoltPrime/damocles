import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { once } from 'events';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'worker_threads';
import { openUsageDatabase } from '../database';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempDbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-db-'));
  roots.push(root);
  return path.join(root, 'nested', 'usage.db');
}

describe('openUsageDatabase', () => {
  it('creates the index in WAL mode at schema v1', () => {
    const dbPath = tempDbPath();
    const db = openUsageDatabase(dbPath, () => {});
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    expect(db.prepare('PRAGMA secure_delete').get()).toEqual({ secure_delete: 1 });
    db.close();
  });

  it('keeps existing rows when reopened', () => {
    const dbPath = tempDbPath();
    const first = openUsageDatabase(dbPath, () => {});
    first.prepare("INSERT INTO meta (key, value) VALUES ('indexed_at_ms', '7')").run();
    first.close();
    const second = openUsageDatabase(dbPath, () => {});
    expect(second.prepare('SELECT value FROM meta').get()).toEqual({ value: '7' });
    second.close();
  });

  it('moves a corrupt file aside, logs the loss, keeps only the newest aside copy and opens a fresh index', () => {
    const dbPath = tempDbPath();
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ['usage.db.corrupt-1', 'usage.db.corrupt-1-wal', 'usage.db.corrupt-2']) fs.writeFileSync(path.join(dir, name), 'old titles');
    fs.writeFileSync(dbPath, 'this is not a sqlite database, just some bytes that fill the header page'.repeat(20));
    const logs: string[] = [];
    const db = openUsageDatabase(dbPath, (m) => logs.push(m));
    expect(db.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 0 });
    db.close();
    const aside = fs.readdirSync(dir).filter((name) => name.startsWith('usage.db.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/^usage\.db\.corrupt-\d{13}$/);
    expect(logs.join('\n')).toMatch(/corrupt.*deleted is lost/s);
  });

  it.runIf(process.platform === 'win32')('says the corrupt index is in use when another window holds it open', () => {
    const dbPath = tempDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.writeFileSync(dbPath, 'this is not a sqlite database, just some bytes that fill the header page'.repeat(20));
    // Another window's worker: SQLite on Windows opens without FILE_SHARE_DELETE, which blocks the rename.
    const holder = new DatabaseSync(dbPath);
    try {
      const logs: string[] = [];
      expect(() => openUsageDatabase(dbPath, (m) => logs.push(m))).toThrow(/corrupt, and another VS Code window has it open/);
      expect(logs.join('\n')).toMatch(/is corrupt/);
    } finally {
      holder.close();
    }
  });

  it('reads a newer schema as is instead of rebuilding it', () => {
    const dbPath = tempDbPath();
    const db = openUsageDatabase(dbPath, () => {});
    db.exec('PRAGMA user_version = 99');
    db.close();
    const logs: string[] = [];
    const reopened = openUsageDatabase(dbPath, (m) => logs.push(m));
    expect(reopened.prepare('PRAGMA user_version').get()).toEqual({ user_version: 99 });
    reopened.close();
    expect(logs.join('\n')).toMatch(/newer/);
  });

  it('skips a migration that another connection committed while this one waited for the write lock', async () => {
    const reference = openUsageDatabase(tempDbPath(), () => {});
    const schema = (reference.prepare('SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid').all() as Array<{ sql: string }>)
      .map((r) => `${r.sql};`).join('\n');
    const { user_version: version } = reference.prepare('PRAGMA user_version').get() as { user_version: number };
    reference.close();

    const dbPath = tempDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const signal = new Int32Array(new SharedArrayBuffer(4));
    // A second window: it migrates under the write lock, signals, then holds the lock briefly before committing.
    const other = new Worker(`
      const { workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const signal = new Int32Array(workerData.signal);
      const db = new DatabaseSync(workerData.dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('BEGIN IMMEDIATE');
      db.exec(workerData.schema);
      db.exec('PRAGMA user_version = ' + workerData.version);
      Atomics.store(signal, 0, 1);
      Atomics.notify(signal, 0);
      Atomics.wait(signal, 0, 1, 300);
      db.exec('COMMIT');
      db.close();
    `, { eval: true, workerData: { dbPath, schema, version, signal: signal.buffer } });
    const exited = once(other, 'exit');
    expect(Atomics.wait(signal, 0, 0, 10_000)).not.toBe('timed-out');

    // Reads v0 from the committed snapshot, then waits in the busy handler until the other connection commits.
    const db = openUsageDatabase(dbPath, () => {});
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: version });
    expect(db.prepare('SELECT count(*) AS n FROM entries').get()).toEqual({ n: 0 });
    db.close();
    await exited;
  });
});
