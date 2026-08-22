import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { ProfileManager } from '../managers/profile-manager';
import { InjectionManager } from '../managers/injection-manager';
import { runConsolidation, type ConsolidationCtx } from '../consolidation';
import { subCallSpy } from './subcall-spy';

/**
 * DatabaseInstance proxy counting `.transaction(...)` calls. The write queue wraps each `run()`
 * callback in exactly one `db.transaction(fn)`, so the count is how many transactions a queued op
 * costs — the unit for the "one transaction, not N+1" batching assertions.
 */
function countingDbProxy(db: DatabaseInstance): { db: DatabaseInstance; count: () => number } {
  let transactions = 0;
  const proxy: DatabaseInstance = {
    prepare: (sql) => db.prepare(sql),
    exec: (sql) => db.exec(sql),
    pragma: (value) => db.pragma(value),
    transaction: <T,>(fn: () => T): T => {
      transactions++;
      return db.transaction(fn);
    },
    close: () => db.close(),
  };
  return { db: proxy, count: () => transactions };
}

const WORKSPACE = '/repo/damocles';
const SESSION_ID = 'session-concurrency';
const SHARED_CONTENT = 'The project bundles the extension with esbuild.';

interface CountRow {
  count: number;
}

interface ExtractedMemorySeed {
  kind: string;
  content: string;
  scope: string;
  tags?: string[];
}

function seedCandidate(db: DatabaseInstance, sessionId: string, userText: string, assistantText: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, salient, consumed, reprocessed, created_at)
     VALUES (?, ?, ?, ?, ?, '[]', 0, 0, 0, ?)`,
  ).run(id, sessionId, 0, userText, assistantText, Date.now());
  return id;
}

function seedMemory(
  db: DatabaseInstance,
  fields: { id: string; content: string; createdAt: number },
): MemoryRow {
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, content_hash, version, is_latest, root_id, workspace, created_at, updated_at)
     VALUES (?, 'fact', 'project', ?, ?, 1, 1, ?, ?, ?, ?)`,
  ).run(fields.id, fields.content, fields.id, fields.id, WORKSPACE, fields.createdAt, fields.createdAt);
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(fields.id) as MemoryRow;
}

/** Mock runner: extracts one fixed fact, judges no contradiction/merge. */
function makeRunner(extractMemories: ExtractedMemorySeed[]): MemorySubCallRunner {
  return {
    run: subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') return { value: { memories: extractMemories } as T };
      if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } as T };
      return { value: { contradicts: false, merged_ids: [], content: '' } as T };
    }),
  };
}

function makeCtx(
  db: DatabaseInstance,
  writeQueue: MemoryWriteQueue,
  factGraph: FactGraphManager,
  profileManager: ProfileManager,
  runner: MemorySubCallRunner,
): ConsolidationCtx {
  return {
    db,
    writeQueue,
    runner,
    factGraph,
    profileManager,
    instanceId: 'test-instance',
    reason: 'switch',
    sessionId: SESSION_ID,
    workspace: WORKSPACE,
    autoExtractEnabled: true,
    trigger: 'auto',
    onNoModel: () => {},
    isDisposed: () => false,
  };
}

function countRowsForContent(db: DatabaseInstance, content: string): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM memories WHERE content = ?').get(content) as CountRow;
  return row.count;
}

function countDistinctRoots(db: DatabaseInstance, content: string): number {
  const row = db
    .prepare('SELECT COUNT(DISTINCT root_id) AS count FROM memories WHERE content = ?')
    .get(content) as CountRow;
  return row.count;
}

describe('memory concurrency — two panels share one db + one write queue', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('two concurrent consolidations: no double-claim, no double-extraction, one root', async () => {
    const candidateIds = [
      seedCandidate(db, SESSION_ID, 'Bundler?', 'esbuild.'),
      seedCandidate(db, SESSION_ID, 'Why?', 'Fast.'),
      seedCandidate(db, SESSION_ID, 'Confirm?', 'esbuild bundles the extension.'),
      seedCandidate(db, SESSION_ID, 'Anything else?', 'No.'),
    ];

    const writeQueue = new MemoryWriteQueue();
    const runnerA = makeRunner([{ kind: 'fact', content: SHARED_CONTENT, scope: 'project', tags: ['build'] }]);
    const runnerB = makeRunner([{ kind: 'fact', content: SHARED_CONTENT, scope: 'project', tags: ['build'] }]);
    const factGraph = new FactGraphManager(db, writeQueue, runnerA);
    const profileManager = new ProfileManager(db, writeQueue, runnerA);

    const ctxA = makeCtx(db, writeQueue, factGraph, profileManager, runnerA);
    const ctxB = makeCtx(db, writeQueue, factGraph, profileManager, runnerB);

    await Promise.all([runConsolidation(ctxA), runConsolidation(ctxB)]);

    for (const id of candidateIds) {
      const candidate = db.prepare('SELECT consumed FROM memory_candidates WHERE id = ?').get(id) as { consumed: number };
      expect(candidate.consumed).toBe(1);
    }

    const unconsumed = db.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 0').get() as CountRow;
    expect(unconsumed.count).toBe(0);

    const extractCallsA = (runnerA.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([req]) => (req as MemorySubCallRequest).purpose === 'extract',
    );
    const extractCallsB = (runnerB.run as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([req]) => (req as MemorySubCallRequest).purpose === 'extract',
    );
    expect(extractCallsA.length + extractCallsB.length).toBeLessThanOrEqual(1);

    expect(countRowsForContent(db, SHARED_CONTENT)).toBe(1);
    expect(countDistinctRoots(db, SHARED_CONTENT)).toBe(1);

    const stored = db.prepare('SELECT * FROM memories WHERE content = ?').get(SHARED_CONTENT) as MemoryRow;
    expect(stored.is_latest).toBe(1);
    expect(stored.source_count).toBeGreaterThanOrEqual(1);
  });

  it('one root, one is_latest=1 even if both passes extract the same content', async () => {
    seedCandidate(db, SESSION_ID, 'A', 'a');
    seedCandidate(db, SESSION_ID, 'B', 'b');

    const writeQueue = new MemoryWriteQueue();
    const factGraph = new FactGraphManager(db, writeQueue, makeRunner([]));
    const profileManager = new ProfileManager(db, writeQueue, makeRunner([]));

    const runnerA = makeRunner([{ kind: 'fact', content: SHARED_CONTENT, scope: 'project' }]);
    const runnerB = makeRunner([{ kind: 'fact', content: SHARED_CONTENT, scope: 'project' }]);

    const ctxA = makeCtx(db, writeQueue, factGraph, profileManager, runnerA);
    const ctxB = makeCtx(db, writeQueue, factGraph, profileManager, runnerB);

    await Promise.all([runConsolidation(ctxA), runConsolidation(ctxB)]);

    expect(countRowsForContent(db, SHARED_CONTENT)).toBe(1);
    expect(countDistinctRoots(db, SHARED_CONTENT)).toBe(1);

    const latestForRoot = db
      .prepare(
        `SELECT root_id, SUM(is_latest) AS count FROM memories WHERE content = ? GROUP BY root_id`,
      )
      .all(SHARED_CONTENT) as Array<{ root_id: string; count: number }>;
    for (const group of latestForRoot) {
      expect(group.count).toBe(1);
    }
  });

  it('concurrent resolveConflict of the same newer row is idempotent — one UPDATES edge, one version bump', async () => {
    const older = seedMemory(db, { id: 'older-fact', content: 'The build command is npm run build', createdAt: 1000 });
    const newer = seedMemory(db, { id: 'newer-fact', content: 'The build command is npm run compile', createdAt: 2000 });

    const writeQueue = new MemoryWriteQueue();
    const contradictingRunner: MemorySubCallRunner = {
      run: async <T,>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => ({ value: { contradicts: true } as T }),
    };
    const factGraph = new FactGraphManager(db, writeQueue, contradictingRunner);

    const freshNewerA = db.prepare('SELECT * FROM memories WHERE id = ?').get(newer.id) as MemoryRow;
    const freshNewerB = db.prepare('SELECT * FROM memories WHERE id = ?').get(newer.id) as MemoryRow;

    const [resA, resB] = await Promise.all([
      factGraph.resolveConflict(freshNewerA),
      factGraph.resolveConflict(freshNewerB),
    ]);

    const supersededCount = resA.superseded.length + resB.superseded.length;
    expect(supersededCount).toBe(1);

    const edge = db
      .prepare("SELECT COUNT(*) AS count FROM memory_edges WHERE kind = 'UPDATES' AND source_id = ? AND target_id = ?")
      .get(newer.id, older.id) as CountRow;
    expect(edge.count).toBe(1);

    const newerAfter = db.prepare('SELECT * FROM memories WHERE id = ?').get(newer.id) as MemoryRow;
    const olderAfter = db.prepare('SELECT * FROM memories WHERE id = ?').get(older.id) as MemoryRow;
    expect(newerAfter.version).toBe(2);
    expect(newerAfter.is_latest).toBe(1);
    expect(olderAfter.is_latest).toBe(0);

    const latestInChain = db
      .prepare('SELECT COUNT(*) AS count FROM memories WHERE root_id = ? AND is_latest = 1')
      .get(olderAfter.root_id ?? older.id) as CountRow;
    expect(latestInChain.count).toBe(1);
  });
});

describe('memory database concurrency — two DatabaseSync connections, one file (real SQLite locking)', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = path.join(os.tmpdir(), `damocles-2conn-test-${crypto.randomUUID()}.db`);
  });

  afterEach(() => {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(filePath + suffix);
      } catch {
        /* already gone */
      }
    }
  });

  it('interleaved read-modify-write increments across two connections lose no update', () => {
    // BEGIN IMMEDIATE takes the RESERVED lock up front, so the two connections serialize (the second
    // blocks up to busy_timeout rather than reading stale) and no increment is lost — honest SQLite
    // locking, no app-level write queue.
    const open = (): DatabaseSync => {
      const raw = new DatabaseSync(filePath, { timeout: 5000 });
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA synchronous = NORMAL');
      raw.exec('PRAGMA busy_timeout = 5000');
      return raw;
    };

    const setup = open();
    setup.exec('CREATE TABLE counter (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)');
    setup.exec('INSERT INTO counter (id, value) VALUES (1, 0)');
    setup.close();

    const connA = open();
    const connB = open();

    const incrementOnce = (conn: DatabaseSync): void => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const row = conn.prepare('SELECT value FROM counter WHERE id = 1').get() as { value: number };
        conn.prepare('UPDATE counter SET value = ? WHERE id = 1').run(row.value + 1);
        conn.exec('COMMIT');
      } catch (err) {
        conn.exec('ROLLBACK');
        throw err;
      }
    };

    const PER_CONN = 50;
    // Alternate connections so a read on one straddles a write on the other — the update-losing case.
    for (let i = 0; i < PER_CONN; i++) {
      incrementOnce(connA);
      incrementOnce(connB);
    }

    const finalA = connA.prepare('SELECT value FROM counter WHERE id = 1').get() as { value: number };
    expect(finalA.value).toBe(PER_CONN * 2);

    connA.close();

    const verify = open();
    const finalV = verify.prepare('SELECT value FROM counter WHERE id = 1').get() as { value: number };
    expect(finalV.value).toBe(PER_CONN * 2);
    verify.close();
    connB.close();
  });
});

describe('memory write queue — Slice 3 serialization + one-transaction batching', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('a panel deleteMemory queued after an in-flight multi-step consolidation persist never observes a half-applied op', async () => {
    // Persist and delete route through ONE write queue → they serialize: the delete runs only after
    // the persist's whole transaction commits, so it never sees a half-written intermediate state.
    const writeQueue = new MemoryWriteQueue(db);

    const rootId = 'consolidation-root';
    const childId = 'consolidation-child';

    const persist = writeQueue.run(() => {
      const now = Date.now();
      db.prepare(
        `INSERT INTO memories (id, kind, scope, content, content_hash, version, is_latest, root_id, workspace, created_at, updated_at)
         VALUES (?, 'fact', 'project', ?, ?, 1, 1, ?, ?, ?, ?)`,
      ).run(rootId, 'root fact', rootId, rootId, WORKSPACE, now, now);
      db.prepare(
        `INSERT INTO memories (id, kind, scope, content, content_hash, version, is_latest, parent_id, root_id, workspace, created_at, updated_at)
         VALUES (?, 'fact', 'project', ?, ?, 2, 1, ?, ?, ?, ?, ?)`,
      ).run(childId, 'child fact', childId, rootId, rootId, WORKSPACE, now, now);
      db.prepare(
        `INSERT INTO memory_edges (id, source_id, target_id, kind, created_at) VALUES (?, ?, ?, 'UPDATES', ?)`,
      ).run(crypto.randomUUID(), childId, rootId, now);
      db.prepare(
        `INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)`,
      ).run(childId, WORKSPACE, now);
    });

    // Enqueue the delete WHILE the persist is still in flight (not yet awaited).
    let observedRowsBeforeDelete = -1;
    const del = writeQueue.run(() => {
      // Serialized after the persist, so both rows already exist here (never a half-applied state).
      observedRowsBeforeDelete = (
        db.prepare('SELECT COUNT(*) AS count FROM memories WHERE root_id = ?').get(rootId) as CountRow
      ).count;
      const result = db.prepare('DELETE FROM memories WHERE id = ?').run(childId);
      if (result.changes > 0) {
        db.prepare('DELETE FROM memory_retrievals WHERE memory_id = ?').run(childId);
      }
      return result.changes > 0;
    });

    await persist;
    const deleted = await del;

    expect(observedRowsBeforeDelete).toBe(2);
    expect(deleted).toBe(true);

    // Final state: child + its retrieval gone, root + edge intact.
    expect((db.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(childId) as CountRow).count).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM memories WHERE id = ?').get(rootId) as CountRow).count).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS count FROM memory_retrievals WHERE memory_id = ?').get(childId) as CountRow).count,
    ).toBe(0);
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM memory_edges WHERE source_id = ? AND kind = 'UPDATES'").get(childId) as CountRow).count,
    ).toBe(1);
  });

  it('a 5-id getMemoryDetails fetch executes EXACTLY ONE transaction (batched bump+select, not N+1)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `detail-mem-${i}`;
      seedMemory(db, { id, content: `fact number ${i}`, createdAt: 1000 + i });
      ids.push(id);
    }

    const { db: proxy, count } = countingDbProxy(db);
    const writeQueue = new MemoryWriteQueue(proxy);

    // Mirror getMemoryDetails: one queued callback doing the batched IN-clause bump then the SELECT.
    const entries = await writeQueue.run(() => {
      const ph = ids.map(() => '?').join(',');
      proxy
        .prepare(`UPDATE memories SET access_count = access_count + 1 WHERE id IN (${ph}) AND forgotten = 0`)
        .run(...ids);
      return proxy
        .prepare(`SELECT * FROM memories WHERE id IN (${ph}) AND forgotten = 0`)
        .all(...ids) as MemoryRow[];
    });

    expect(entries.length).toBe(5);
    // One transaction for all 5 ids, not one per id.
    expect(count()).toBe(1);
    for (const id of ids) {
      const row = db.prepare('SELECT access_count FROM memories WHERE id = ?').get(id) as { access_count: number };
      expect(row.access_count).toBe(1);
    }
  });

  it('a recordRetrievals call executes EXACTLY ONE transaction (select+insert-loop+prune batched)', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const id = `retr-mem-${i}`;
      seedMemory(db, { id, content: `retrieval fact ${i}`, createdAt: 2000 + i });
      ids.push(id);
    }

    const { db: proxy, count } = countingDbProxy(db);
    const writeQueue = new MemoryWriteQueue(proxy);
    const runner = makeRunner([]);
    const profileManager = new ProfileManager(proxy, writeQueue, runner);
    const injectionManager = new InjectionManager(proxy, profileManager, runner);

    // Mirror recordRetrievals: select-scopes + insert-loop + prune-delete in one writeQueue.run.
    await writeQueue.run(() => injectionManager.recordRetrievals(ids, WORKSPACE));

    expect(count()).toBe(1);
    const inserted = db.prepare('SELECT COUNT(*) AS count FROM memory_retrievals').get() as CountRow;
    expect(inserted.count).toBe(5);
  });
});
