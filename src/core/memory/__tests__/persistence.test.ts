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

  it('quarantines a corrupt file aside and returns a fresh working DB', async () => {
    // Garbage bytes (not a valid SQLite header) → open+migrate fails as a parse error → quarantine.
    fs.writeFileSync(filePath, Buffer.from('this is not a sqlite database file — pure garbage bytes'));

    const opened = await openMemoryDatabaseAt(filePath);
    expect(opened).not.toBeNull();
    expect(opened!.quarantinedFrom).toBeTruthy();

    // The corrupt original was renamed to a `.corrupt-*` sibling.
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const siblings = fs.readdirSync(dir).filter((e) => e.startsWith(base + '.corrupt-'));
    expect(siblings.length).toBeGreaterThanOrEqual(1);

    // A fresh, empty, migrated, writable DB was returned in its place.
    const db = opened!.db;
    const row = db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    expect(row.n).toBe(0);
    const id = crypto.randomUUID();
    insertMemory(db, id, 'fresh store works');
    expect(countById(db, id)).toBe(1);
    db.close();
  });

  it('creates a fresh store for a first-run missing file, with NO quarantine', async () => {
    // DatabaseSync creates the file on open, so a missing path is a normal fresh-store creation, not
    // corruption: no `quarantinedFrom`, no `.corrupt-*` sibling. (null is reserved for an open THROW.)
    expect(fs.existsSync(filePath)).toBe(false);

    const opened = await openMemoryDatabaseAt(filePath);
    expect(opened).not.toBeNull();
    expect(opened!.quarantinedFrom).toBeUndefined();

    // Fresh, empty, migrated, writable store.
    const db = opened!.db;
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

describe('desynced FTS index self-heal (not quarantine)', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `damocles-fts-heal-${crypto.randomUUID()}.memory.v2.db`);
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it('rebuilds a desynced index on open — data preserved, writes and search work, no quarantine', async () => {
    // Byte-corrupt the FTS index's leaf pages (index spans several pages at this row count): the index
    // reads inconsistently — every write trigger throws SQLITE_CORRUPT — while the base table stays
    // intact. Corrupting leaves (not the b-tree root) keeps it rebuild-recoverable, matching the field case.
    const ROWS = 400;
    let pageSize: number;
    let leafPages: number[];
    {
      const raw = new DatabaseSync(filePath, { timeout: 5000 });
      const db = createDatabaseWrapper(raw);
      runMigrations(db);
      for (let i = 0; i < ROWS; i++) {
        insertMemory(db, crypto.randomUUID(), `searchable term unique${i} ${'filler '.repeat(20)}`);
      }
      pageSize = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      const root = (raw.prepare("SELECT rootpage FROM sqlite_master WHERE name = 'memories_fts_data'").get() as { rootpage: number }).rootpage;
      const pages = (raw.prepare("SELECT pageno FROM dbstat WHERE name = 'memories_fts_data' ORDER BY pageno").all() as Array<{ pageno: number }>).map((r) => r.pageno);
      leafPages = pages.filter((pg) => pg !== root);
      raw.close(); // rollback-journal mode (no WAL) so the pages live in the main file
    }
    const fd = fs.openSync(filePath, 'r+');
    for (const pg of leafPages) {
      fs.writeSync(fd, Buffer.alloc(pageSize - 50, 0x00), 0, pageSize - 50, (pg - 1) * pageSize + 40);
    }
    fs.closeSync(fd);

    // Before the heal, a raw open sees a broken index (an FTS op throws) but the base table is fine.
    {
      const raw = new DatabaseSync(filePath, { timeout: 5000 });
      expect((raw.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(ROWS);
      expect(() => raw.prepare("INSERT INTO memories_fts(memories_fts) VALUES('integrity-check')").run()).toThrow();
      raw.close();
    }

    // Production open heals in place — no quarantine, data intact.
    const opened = await openMemoryDatabaseAt(filePath);
    expect(opened).not.toBeNull();
    expect(opened!.quarantinedFrom).toBeUndefined();
    const db = opened!.db;

    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(ROWS);

    // Writes (which fire the FTS triggers — the thing that failed with "cannot rollback") now work.
    const id = crypto.randomUUID();
    insertMemory(db, id, 'delta searchable needle');
    expect(countById(db, id)).toBe(1);

    // The rebuilt index actually searches, including the just-written row.
    const hits = db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'needle'").get() as { n: number };
    expect(hits.n).toBe(1);
    db.close();

    // No `.corrupt-*` sibling: a recoverable index desync must never quarantine the store.
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    expect(fs.readdirSync(dir).filter((e) => e.startsWith(base + '.corrupt-')).length).toBe(0);
  }, 30_000);
});

describe('corrupt-table salvage rebuild', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `damocles-salvage-${crypto.randomUUID()}.memory.v3.db`);
  });

  afterEach(() => {
    cleanup(filePath);
  });

  it('recovers durable rows into a rebuilt store when a transient table is corrupt (field case)', async () => {
    // Reproduce the field failure: byte-corrupt memory_candidates' pages. The table cannot even be
    // DROPped in place, yet memories/edges/retrievals/profile all read cleanly — salvage must carry
    // them into the fresh store instead of losing everything to a bare quarantine.
    const ROWS = 40;
    let pageSize: number;
    let candidatePages: number[];
    {
      const raw = new DatabaseSync(filePath, { timeout: 5000 });
      const db = createDatabaseWrapper(raw);
      runMigrations(db);
      for (let i = 0; i < ROWS; i++) insertMemory(db, `mem-${i}`, `durable fact number ${i}`);
      const insertCandidate = raw.prepare(
        "INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, salient, consumed, reprocessed, created_at) VALUES (?, 's', 0, ?, ?, '[]', 0, 0, 0, ?)",
      );
      for (let i = 0; i < 200; i++) insertCandidate.run(`cand-${i}`, `user turn ${i} ${'pad '.repeat(40)}`, `assistant ${i}`, Date.now());
      pageSize = (raw.prepare('PRAGMA page_size').get() as { page_size: number }).page_size;
      candidatePages = (raw.prepare("SELECT pageno FROM dbstat WHERE name = 'memory_candidates' ORDER BY pageno").all() as Array<{ pageno: number }>).map((r) => r.pageno);
      raw.close();
    }
    const fd = fs.openSync(filePath, 'r+');
    for (const pg of candidatePages) {
      fs.writeSync(fd, Buffer.alloc(pageSize - 50, 0xee), 0, pageSize - 50, (pg - 1) * pageSize + 40);
    }
    fs.closeSync(fd);

    const opened = await openMemoryDatabaseAt(filePath);
    expect(opened).not.toBeNull();
    expect(opened!.quarantinedFrom).toBeTruthy();
    expect(opened!.salvagedMemories).toBe(ROWS);
    const db = opened!.db;

    // Durable rows recovered; the corrupt transient buffer is dropped, not carried over.
    expect((db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n).toBe(ROWS);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_candidates').get() as { n: number }).n).toBe(0);
    expect(countById(db, 'mem-7')).toBe(1);

    // The rebuilt FTS searches the salvaged rows, and consolidation-style writes work again.
    const hits = db.prepare("SELECT COUNT(*) AS n FROM memories_fts WHERE memories_fts MATCH 'durable'").get() as { n: number };
    expect(hits.n).toBe(ROWS);
    db.prepare(
      "INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, salient, consumed, reprocessed, created_at) VALUES ('c-new', 's', 0, 'u', 'a', '[]', 0, 0, 0, ?)",
    ).run(Date.now());
    db.close();
  }, 30_000);
});
