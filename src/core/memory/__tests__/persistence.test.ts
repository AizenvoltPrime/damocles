import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createDatabaseWrapper, runMigrations, openMemoryDatabaseAt } from '../database';
import type { DatabaseInstance } from '../types';

/**
 * Persistence tests for the node:sqlite (WAL) memory store: open a real temp file, mutate, close, and
 * reopen a fresh connection to assert what landed on disk. Durability is owned by SQLite's WAL journal.
 */

/** Open (or create) a memory DB at `filePath` with production's engine/pragmas/migrations. */
function openAt(filePath: string): DatabaseInstance {
  const raw = new DatabaseSync(filePath, { timeout: 5000 });
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec('PRAGMA synchronous = NORMAL');
  raw.exec('PRAGMA foreign_keys = ON');
  const db = createDatabaseWrapper(raw);
  runMigrations(db);
  return db;
}

function insertMemory(db: DatabaseInstance, id: string, content: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, workspace, created_at, updated_at)
     VALUES (?, 'fact', 'project', ?, '', ?, '/ws', ?, ?)`,
  ).run(id, content, id, now, now);
}

function countById(db: DatabaseInstance, id: string): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = ?').get(id) as { n: number };
  return row.n;
}

/** Remove a DB file plus its WAL/SHM sidecars and any quarantine siblings left in the temp dir. */
function cleanup(filePath: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.unlinkSync(filePath + suffix);
    } catch {
      /* already gone */
    }
  }
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  try {
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(base + '.corrupt-')) {
        try {
          fs.unlinkSync(path.join(dir, entry));
        } catch {
          /* best-effort */
        }
      }
    }
  } catch {
    /* dir gone */
  }
}

describe('memory database persistence (node:sqlite WAL)', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `damocles-persist-test-${crypto.randomUUID()}.db`);
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it('round-trips rows through a fresh reopen of the same file (migrations idempotent)', () => {
    const id1 = crypto.randomUUID();
    const id2 = crypto.randomUUID();

    const db1 = openAt(filePath);
    insertMemory(db1, id1, 'first durable fact');
    insertMemory(db1, id2, 'second durable fact');
    expect(countById(db1, id1)).toBe(1);
    expect(countById(db1, id2)).toBe(1);
    db1.close();

    // Reopen the same path fresh: runMigrations must be idempotent and committed rows readable.
    const db2 = openAt(filePath);
    expect(countById(db2, id1)).toBe(1);
    expect(countById(db2, id2)).toBe(1);
    db2.close();
  });

  it('persists a hard delete, surviving a reopen (WAL flush on close)', () => {
    const id = crypto.randomUUID();

    const db1 = openAt(filePath);
    insertMemory(db1, id, 'durable fact to be deleted');
    expect(countById(db1, id)).toBe(1);
    expect(db1.prepare('DELETE FROM memories WHERE id = ?').run(id).changes).toBe(1);
    db1.close();

    const db2 = openAt(filePath);
    expect(countById(db2, id)).toBe(0);
    db2.close();
  });

  it('persists an insert without an explicit flush call', () => {
    const id = crypto.randomUUID();

    const db1 = openAt(filePath);
    insertMemory(db1, id, 'fact persisted by WAL');
    db1.close();

    const db2 = openAt(filePath);
    expect(countById(db2, id)).toBe(1);
    db2.close();
  });

  it('rolls back a failed transaction, leaving no partial writes', () => {
    const db = openAt(filePath);
    const goodId = crypto.randomUUID();

    expect(() =>
      db.transaction(() => {
        insertMemory(db, goodId, 'should be rolled back');
        throw new Error('boom');
      }),
    ).toThrow('boom');

    // The row inserted before the throw must not survive the ROLLBACK.
    expect(countById(db, goodId)).toBe(0);
    db.close();

    const reopenedAfterRollback = openAt(filePath);
    expect(countById(reopenedAfterRollback, goodId)).toBe(0);
    reopenedAfterRollback.close();
  });

  it('propagates the REAL error when a transaction was already auto-aborted (no "cannot rollback" mask)', () => {
    const db = openAt(filePath);

    // SQLITE_CORRUPT auto-aborts the txn before our catch runs; a blind ROLLBACK would then mask the
    // real error with "cannot rollback". Stand in for the auto-abort by ending the txn inside fn.
    expect(() =>
      db.transaction(() => {
        db.exec('ROLLBACK');
        throw new Error('the real fts5 corruption error');
      }),
    ).toThrow('the real fts5 corruption error');

    // The connection is still usable for a subsequent transaction (state not wedged).
    const id = crypto.randomUUID();
    db.transaction(() => insertMemory(db, id, 'works after an auto-aborted txn'));
    expect(countById(db, id)).toBe(1);
    db.close();
  });
});

describe('migration v6', () => {
  it('adds the failed-answer count, the set-aside stamp and the claimable index onto a v5 database, keeping its rows', () => {
    const v5 = createDatabaseWrapper(new DatabaseSync(':memory:'));
    runMigrations(v5);
    v5.exec(
      'DROP INDEX idx_candidates_set_aside; DROP INDEX idx_candidates_claimable; ALTER TABLE memory_candidates DROP COLUMN set_aside_at; ' +
        'ALTER TABLE memory_candidates DROP COLUMN failed_attempts; DELETE FROM schema_version WHERE version >= 6',
    );
    v5.prepare(`INSERT INTO memory_candidates (id, user_text, assistant_text, created_at) VALUES ('kept', 'q', 'a', 1)`).run();

    runMigrations(v5);

    expect(v5.prepare('SELECT user_text, failed_attempts, set_aside_at FROM memory_candidates WHERE id = ?').get('kept')).toEqual({
      user_text: 'q',
      failed_attempts: 0,
      set_aside_at: null,
    });
    const idx = (v5.prepare("PRAGMA index_info('idx_candidates_claimable')").all() as Array<{ name: string }>).map(c => c.name);
    expect(idx).toEqual(['consumed', 'set_aside_at', 'created_at']);
    // The claim's oldest-claimable lookup reads the index in order instead of sorting or scanning set-aside rows.
    const plan = (v5
      .prepare('EXPLAIN QUERY PLAN SELECT workspace FROM memory_candidates WHERE consumed = 0 AND set_aside_at IS NULL ORDER BY created_at LIMIT 1')
      .all() as Array<{ detail: string }>).map(r => r.detail).join('\n');
    expect(plan).toContain('idx_candidates_claimable');
    expect(plan).not.toContain('TEMP B-TREE');
    expect((v5.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7);
    v5.close();
  });
});

describe('migration v7', () => {
  it('adds a partial index the set-aside count reads instead of scanning every candidate', () => {
    const v6 = createDatabaseWrapper(new DatabaseSync(':memory:'));
    runMigrations(v6);
    v6.exec('DROP INDEX idx_candidates_set_aside; DELETE FROM schema_version WHERE version = 7');
    v6.prepare(`INSERT INTO memory_candidates (id, user_text, assistant_text, created_at, set_aside_at) VALUES ('aside', 'q', 'a', 1, 5)`).run();

    runMigrations(v6);

    const plan = (v6
      .prepare('EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM memory_candidates WHERE set_aside_at IS NOT NULL')
      .all() as Array<{ detail: string }>).map(r => r.detail).join('\n');
    expect(plan).toContain('idx_candidates_set_aside');
    expect(plan).not.toMatch(/SCAN memory_candidates(?! USING)/);
    expect((v6.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE set_aside_at IS NOT NULL').get() as { n: number }).n).toBe(1);
    expect((v6.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(7);
    v6.close();
  });
});

describe('cross-process migration race', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `damocles-migrace-${crypto.randomUUID()}.memory.v3.db`);
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it('a second migrator on an already-migrated DB is a no-op, not a "table already exists" failure', () => {
    // Two windows opening a fresh store race runMigrations. The re-check inside each migration's write
    // transaction must skip an already-applied version instead of re-running the DDL and aborting init.
    const first = openAt(filePath);
    const version = () =>
      (first.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    const migrated = version();

    // Simulate the loser: it read currentVersion=0 before the winner committed, so re-run from v1.
    const raw = new DatabaseSync(filePath, { timeout: 5000 });
    const second = createDatabaseWrapper(raw);
    expect(() => runMigrations(second)).not.toThrow();
    expect(version()).toBe(migrated);

    // Both connections still write cleanly — neither corrupted the schema.
    const id = crypto.randomUUID();
    insertMemory(second, id, 'post-race write');
    expect(countById(first, id)).toBe(1);
    first.close();
    second.close();
  });
});

describe('mid-chain version delete', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `damocles-midchain-${crypto.randomUUID()}.memory.v3.db`);
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it('re-links children to the deleted row\'s parent so the chain stays reachable', () => {
    const db = openAt(filePath);
    const now = Date.now();
    // Chain v1 (root) → v2 → v3 (latest). parent_id points at the previous version.
    const insertVersion = (id: string, parent: string | null, version: number, latest: number) =>
      db.prepare(
        `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, parent_id, version, is_latest, workspace, created_at, updated_at)
         VALUES (?, 'fact', 'project', ?, '', 'v1', ?, ?, ?, '/ws', ?, ?)`,
      ).run(id, `content ${version}`, parent, version, latest, now, now);
    insertVersion('v1', null, 1, 0);
    insertVersion('v2', 'v1', 2, 0);
    insertVersion('v3', 'v2', 3, 1);

    // Delete the middle version directly (mirrors deleteMemory's relink step).
    db.transaction(() => {
      const row = db.prepare('SELECT parent_id FROM memories WHERE id = ?').get('v2') as { parent_id: string | null };
      db.prepare('UPDATE memories SET parent_id = ? WHERE parent_id = ?').run(row.parent_id, 'v2');
      db.prepare('DELETE FROM memories WHERE id = ?').run('v2');
    });

    // v3 now points straight at v1 — the chain is intact, no dangling parent_id.
    const v3 = db.prepare('SELECT parent_id FROM memories WHERE id = ?').get('v3') as { parent_id: string | null };
    expect(v3.parent_id).toBe('v1');
    db.close();
  });
});

describe('memory database corrupt-file quarantine', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `damocles-quarantine-test-${crypto.randomUUID()}.memory.v2.db`);
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it('reports a corrupt file and leaves it in place for the repair', async () => {
    // Garbage bytes (not a valid SQLite header) → open+migrate fails as a parse error.
    const garbage = Buffer.from('this is not a sqlite database file — pure garbage bytes');
    fs.writeFileSync(filePath, garbage);

    expect(await openMemoryDatabaseAt(filePath)).toBe('corrupt');

    expect(fs.readFileSync(filePath)).toEqual(garbage);
    const base = path.basename(filePath);
    expect(fs.readdirSync(path.dirname(filePath)).filter((e) => e.startsWith(base + '.corrupt-'))).toEqual([]);
  });

  it('creates a fresh store for a first-run missing file, with NO quarantine', async () => {
    // DatabaseSync creates the file on open, so a missing path is a normal fresh-store creation, not
    // corruption: no `.corrupt-*` sibling. (null is reserved for an open THROW.)
    expect(fs.existsSync(filePath)).toBe(false);

    const opened = await openMemoryDatabaseAt(filePath);
    if (opened === null || opened === 'corrupt') throw new Error(`open failed: ${opened}`);

    // Fresh, empty, migrated, writable store.
    const db = opened.db;
    const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    expect(row.n).toBe(0);
    const id = crypto.randomUUID();
    insertMemory(db, id, 'first-run store works');
    expect(countById(db, id)).toBe(1);
    db.close();

    // No `.corrupt-*` sibling was created.
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const siblings = fs.readdirSync(dir).filter((e) => e.startsWith(base + '.corrupt-'));
    expect(siblings.length).toBe(0);
  });
});
