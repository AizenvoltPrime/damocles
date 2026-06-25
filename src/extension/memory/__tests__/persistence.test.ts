import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';

// Count full-file flushes by intercepting fs.renameSync — writeToDisk() is the ONLY caller
// (atomic temp -> db rename). vi.mock also rewrites the `fs` that database.ts imports, so this sees
// the production flushes. The counter lives in vi.hoisted so the (hoisted) mock factory can close
// over it. Default behavior delegates to the real renameSync.
const flushCounter = vi.hoisted(() => ({ n: 0 }));
vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>): void => {
      flushCounter.n++;
      return actual.renameSync(...args);
    },
  };
});
import { initSqlEngineAsync, getSqlEngine, createDatabaseWrapper, runMigrations } from '../database';
import type { DatabaseInstance } from '../types';

/**
 * Persistence + cross-process consistency tests for the WASM-SQLite memory store. The DB file is
 * GLOBAL (shared by every Damocles window). sql.js holds the whole DB in memory; the wrapper makes
 * DISK the source of truth via reload-before-write + synchronous write-through, so one window cannot
 * resurrect a row another window committed-deleted. These open a REAL file and reopen it to assert
 * what actually landed.
 */

function openAt(filePath: string): DatabaseInstance {
  const engine = getSqlEngine();
  if (!engine) throw new Error('SQL engine not initialized');
  let data: Buffer | undefined;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    data = undefined;
  }
  const sqlDb = data ? new engine.Database(data) : new engine.Database();
  const db = createDatabaseWrapper(sqlDb, filePath);
  db.pragma('foreign_keys = ON');
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

describe('memory database write-through persistence', () => {
  let filePath: string;

  beforeEach(async () => {
    await initSqlEngineAsync(process.cwd());
    filePath = path.join(os.tmpdir(), `damocles-persist-test-${crypto.randomUUID()}.db`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone */
    }
  });

  it('persists a hard delete immediately, surviving a reopen', () => {
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

  it('persists an insert without an explicit flush (write-through on each mutation)', () => {
    const id = crypto.randomUUID();

    const db1 = openAt(filePath);
    insertMemory(db1, id, 'fact persisted by write-through');
    db1.close();

    const db2 = openAt(filePath);
    expect(countById(db2, id)).toBe(1);
    db2.close();
  });
});

describe('memory database cross-process consistency (shared global file)', () => {
  let filePath: string;

  beforeEach(async () => {
    await initSqlEngineAsync(process.cwd());
    filePath = path.join(os.tmpdir(), `damocles-xproc-test-${crypto.randomUUID()}.db`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone */
    }
  });

  it("does not clobber another process's committed delete (the F5-reopen bug)", () => {
    const id = crypto.randomUUID();

    // Process A opens, inserts a row (write-through persists it).
    const a = openAt(filePath);
    insertMemory(a, id, 'shared fact');
    expect(countById(a, id)).toBe(1);

    // Process B opens the same file (sees the row), deletes it, persists.
    const b = openAt(filePath);
    expect(countById(b, id)).toBe(1);
    expect(b.prepare('DELETE FROM memories WHERE id = ?').run(id).changes).toBe(1);

    // Process A now writes an UNRELATED row. A naive whole-snapshot writer would resurrect `id` from
    // A's stale in-memory snapshot; reload-before-write makes A see B's delete first.
    const other = crypto.randomUUID();
    insertMemory(a, other, 'unrelated fact');

    expect(countById(a, id)).toBe(0);

    const verify = openAt(filePath);
    expect(countById(verify, id)).toBe(0);
    expect(countById(verify, other)).toBe(1);

    a.close();
    b.close();
    verify.close();
  });

  it('a read in process A reflects a row inserted by process B without reopening', () => {
    const id = crypto.randomUUID();
    const a = openAt(filePath);
    insertMemory(a, crypto.randomUUID(), 'seed'); // baseline so A has a sync signature

    const b = openAt(filePath);
    insertMemory(b, id, 'inserted by B');

    // A re-reads — reload-before-read picks up B's committed write.
    expect(countById(a, id)).toBe(1);

    a.close();
    b.close();
  });

  it("does not resurrect B's same-size delete when A and B share an mtime tick (C1)", () => {
    // Regression for FINDING C1: a row DELETE leaves the SQLite file byte size UNCHANGED
    // (empirically 139264 -> 139264), so an `mtimeMs:size`-only signature relies on mtime alone.
    // On coarse-granularity filesystems (FAT/exFAT 2s, some network FS 1s) B's delete and A's next
    // write can share an mtime tick; the reload is then skipped and A's export resurrects B's row.
    // We force that worst case deterministically: pin the file's mtime to a fixed value around each
    // write so size AND mtime are identical across B's delete and A's write. Only the in-header
    // SQLite change counter (bytes 24-27) distinguishes them — this test fails on the old signature
    // and passes once the change counter is folded in.
    const id = crypto.randomUUID();
    // Integer-ms tick that utimesSync round-trips EXACTLY (fractional ms would not), shared by every
    // pin below so the on-disk mtime is byte-identical across B's delete and A's write.
    const FIXED_MTIME = new Date(1_700_000_000_000);
    const pin = (): void => fs.utimesSync(filePath, FIXED_MTIME, FIXED_MTIME);

    // Process A inserts a row and an equal-shaped sibling, so the later same-size delete keeps bytes
    // identical.
    const a = openAt(filePath);
    insertMemory(a, id, 'C'.repeat(64));
    const sibling = crypto.randomUUID();
    insertMemory(a, sibling, 'D'.repeat(64));

    // Pin the mtime, then force A to ADOPT it: a read runs reload-before-read, so A's internal
    // signature now records FIXED_MTIME (not the fractional mtime its own write-through stamped).
    // This is what makes the mtime component collide with B's pinned write below — isolating the
    // change counter as the only distinguishing field.
    pin();
    expect(countById(a, sibling)).toBe(1);
    const sizeBefore = fs.statSync(filePath).size;

    // Process B opens (sees both rows), deletes one. The delete does not change the byte size.
    const b = openAt(filePath);
    expect(countById(b, id)).toBe(1);
    expect(b.prepare('DELETE FROM memories WHERE id = ?').run(id).changes).toBe(1);
    pin(); // same mtime tick A recorded
    const sizeAfter = fs.statSync(filePath).size;
    expect(sizeAfter).toBe(sizeBefore); // prove the size is unchanged — mtime+size cannot detect this
    b.close();

    // Process A now performs an UNRELATED write. A's recorded signature and the on-disk file now share
    // mtime AND size; only the in-header change counter differs. The old `mtimeMs:size` signature
    // compares equal here, skips the reload, and A's stale snapshot resurrects `id`. The change-counter
    // signature forces the reload that sees B's delete.
    const other = crypto.randomUUID();
    insertMemory(a, other, 'unrelated');

    expect(countById(a, id)).toBe(0);

    const verify = openAt(filePath);
    expect(countById(verify, id)).toBe(0);
    expect(countById(verify, other)).toBe(1);

    a.close();
    verify.close();
  });
});

describe('memory database transaction batching (B-H1: one disk write per sequence)', () => {
  let filePath: string;

  beforeEach(async () => {
    await initSqlEngineAsync(process.cwd());
    filePath = path.join(os.tmpdir(), `damocles-tx-test-${crypto.randomUUID()}.db`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone */
    }
  });

  it('does not persist mid-transaction state — a second process sees nothing until commit', () => {
    const ids = Array.from({ length: 5 }, () => crypto.randomUUID());
    const writer = openAt(filePath);
    insertMemory(writer, 'seed', 'baseline'); // a committed baseline on disk

    writer.transaction(() => {
      for (const id of ids) insertMemory(writer, id, 'tx row');
      // Mid-transaction: a separate reader opening the file must NOT see any of the in-flight rows,
      // proving the sequence is buffered and flushed once at COMMIT (not once per statement).
      const reader = openAt(filePath);
      for (const id of ids) expect(countById(reader, id)).toBe(0);
      expect(countById(reader, 'seed')).toBe(1);
      reader.close();
    });

    // After COMMIT, all rows are durable together.
    const after = openAt(filePath);
    for (const id of ids) expect(countById(after, id)).toBe(1);
    after.close();
    writer.close();
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

    // The row inserted before the throw must NOT survive the rollback.
    expect(countById(db, goodId)).toBe(0);
    db.close();

    const reopened = openAt(filePath);
    expect(countById(reopened, goodId)).toBe(0);
    reopened.close();
  });
});

describe('memory database write-through batching (FINDING M: skip flush when nothing changed)', () => {
  let filePath: string;

  beforeEach(async () => {
    await initSqlEngineAsync(process.cwd());
    filePath = path.join(os.tmpdir(), `damocles-flush-test-${crypto.randomUUID()}.db`);
  });

  afterEach(() => {
    try {
      fs.unlinkSync(filePath);
    } catch {
      /* already gone */
    }
  });

  // Counts full-file flushes performed during `fn` via the hoisted fs.renameSync mock above. Proves
  // the batching goal: per-item write-queue loops must not pay one multi-MB export per read-only item.
  function countFlushes(fn: () => void): number {
    const before = flushCounter.n;
    fn();
    return flushCounter.n - before;
  }

  it('a read-only transaction performs NO disk write', () => {
    const db = openAt(filePath);
    insertMemory(db, crypto.randomUUID(), 'seed'); // committed baseline

    const flushes = countFlushes(() => {
      db.transaction(() => {
        // pure reads — no mutation
        countById(db, 'nope');
        db.prepare('SELECT COUNT(*) AS n FROM memories').get();
      });
    });

    expect(flushes).toBe(0);
    db.close();
  });

  it('an empty transaction performs NO disk write', () => {
    const db = openAt(filePath);
    insertMemory(db, crypto.randomUUID(), 'seed');

    const flushes = countFlushes(() => {
      db.transaction(() => {
        /* nothing */
      });
    });

    expect(flushes).toBe(0);
    db.close();
  });

  it('a mutating transaction performs EXACTLY ONE disk write (batched, not per-statement)', () => {
    const db = openAt(filePath);

    const flushes = countFlushes(() => {
      db.transaction(() => {
        for (let i = 0; i < 5; i++) insertMemory(db, crypto.randomUUID(), `row ${i}`);
      });
    });

    // Five inserts, one commit-time flush — not five.
    expect(flushes).toBe(1);
    db.close();

    // ...and the mutation really persisted (correctness must not regress).
    const reopened = openAt(filePath);
    const row = reopened.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number };
    expect(row.n).toBe(5);
    reopened.close();
  });

  it('per-item write-queue loop (one tx per item) flushes only for items that mutate', () => {
    // Mirrors the search-term backfill / near-dup merge shape: each item runs in its own transaction.
    // Read-only items must cost zero exports; only genuine mutations flush.
    const db = openAt(filePath);
    const ids = Array.from({ length: 4 }, () => crypto.randomUUID());
    for (const id of ids) insertMemory(db, id, 'orig');

    const flushes = countFlushes(() => {
      for (const id of ids) {
        db.transaction(() => {
          const n = countById(db, id);
          if (n === 0) return; // read-only branch for a (hypothetically) absent row — no write
          // mutate only half of them
          if (ids.indexOf(id) % 2 === 0) {
            db.prepare('UPDATE memories SET content = ? WHERE id = ?').run('changed', id);
          }
        });
      }
    });

    // Two of four items mutate -> exactly two flushes.
    expect(flushes).toBe(2);
    db.close();
  });

  it('a read-only exec() performs NO disk write; a DDL exec() does', () => {
    const db = openAt(filePath);

    const readOnly = countFlushes(() => {
      db.exec('SELECT 1');
    });
    expect(readOnly).toBe(0);

    const ddl = countFlushes(() => {
      db.exec('CREATE TABLE IF NOT EXISTS _scratch (x INTEGER)');
    });
    expect(ddl).toBe(1);

    db.close();
  });

  it('rejects an async transaction callback and rolls back (transactions must be synchronous)', () => {
    const db = openAt(filePath);
    const id = crypto.randomUUID();

    expect(() =>
      db.transaction((): unknown => {
        insertMemory(db, id, 'should roll back');
        return Promise.resolve(); // thenable — illegal
      }),
    ).toThrow(/synchronous/i);

    // The mutation made before returning the thenable must be rolled back, not committed.
    expect(countById(db, id)).toBe(0);
    db.close();

    const reopened = openAt(filePath);
    expect(countById(reopened, id)).toBe(0);
    reopened.close();
  });
});
