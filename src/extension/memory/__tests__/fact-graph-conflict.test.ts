import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTestMemoryDb } from './test-helpers';
import { createDatabaseWrapper, runMigrations } from '../database';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { MemoryWriteQueue } from '../write-queue';
import { normalizedContentHash } from '../types';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';

/**
 * Fact-graph conflict correctness. Core invariant: a judge outage must NOT leave contradicting facts
 * co-latest permanently. When the judge is unavailable (returns null) the system DEFERS (flags the new
 * row `needs_conflict_check=1`) and re-decides in a maintenance sweep — it never coerces "unknown" into
 * "no contradiction". Verdicts are forced by injecting a runner, so no test depends on real LLM output
 * or wall-clock timing.
 */

/** Judge outage: run() resolves { value: null } → judgeContradiction must return null, not false. */
const outageRunner: MemorySubCallRunner = {
  async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
    return { value: null, failure: 'transient' };
  },
};

/** Definite "contradicts" verdict. */
const contradictRunner: MemorySubCallRunner = {
  async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
    return { value: { contradicts: true } as T };
  },
};

/** Definite "does NOT contradict" verdict. */
const agreeRunner: MemorySubCallRunner = {
  async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
    return { value: { contradicts: false } as T };
  },
};

interface SeedOpts {
  id?: string;
  content: string;
  scope?: string;
  kind?: string;
  createdAt: number;
  sessionId?: string | null;
  workspace?: string | null;
  needsConflictCheck?: number;
  version?: number;
}

/** Live memory row (is_latest=1, forgotten=0) so it is a conflict candidate. */
function seedMemory(db: DatabaseInstance, opts: SeedOpts): MemoryRow {
  const id = opts.id ?? crypto.randomUUID();
  const scope = opts.scope ?? 'project';
  const kind = opts.kind ?? 'fact';
  db.prepare(
    `INSERT INTO memories (
       id, kind, scope, content, content_hash, version, is_latest,
       root_id, session_id, workspace, needs_conflict_check, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    kind,
    scope,
    opts.content,
    normalizedContentHash(opts.content),
    opts.version ?? 1,
    id,
    opts.sessionId ?? null,
    opts.workspace ?? null,
    opts.needsConflictCheck ?? 0,
    opts.createdAt,
    opts.createdAt,
  );
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
}

function getRow(db: DatabaseInstance, id: string): MemoryRow {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
}

function edgeCount(db: DatabaseInstance, kind: string, sourceId: string, targetId: string): number {
  return (
    db.prepare(
      'SELECT COUNT(*) AS c FROM memory_edges WHERE kind = ? AND source_id = ? AND target_id = ?',
    ).get(kind, sourceId, targetId) as { c: number }
  ).c;
}

function flag(db: DatabaseInstance, id: string): number {
  return getRow(db, id).needs_conflict_check;
}

describe('Slice 8 C4 — judge outage flags for deferral instead of silently dropping a contradiction', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('a null verdict leaves BOTH facts co-latest AND flags the new row needs_conflict_check=1 (no wrong supersede)', async () => {
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), outageRunner);
    const a = seedMemory(db, { content: 'The deploy target is staging', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The deploy target is production', createdAt: 1001 });

    const result = await manager.resolveConflict(b);

    // An outage must not supersede anything and must not coerce null → false.
    expect(result.superseded).toEqual([]);
    expect(getRow(db, a.id).is_latest).toBe(1);
    expect(getRow(db, b.id).is_latest).toBe(1);
    // No lineage edge fabricated on an unknown verdict.
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(0);
    expect(edgeCount(db, 'SUPERSEDES', b.id, a.id)).toBe(0);
    // Deferred, not lost: the new row is flagged for a later re-check.
    expect(flag(db, b.id)).toBe(1);
  });

  it('re-running with the same outage runner is idempotent — the flag stays 1, still nothing superseded', async () => {
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), outageRunner);
    const a = seedMemory(db, { content: 'The cache TTL is 30 seconds', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The cache TTL is 120 seconds', createdAt: 1001 });

    await manager.resolveConflict(b);
    expect(flag(db, b.id)).toBe(1);

    // A second outage pass over the flagged row must not resolve it or churn edges.
    await manager.resolveConflict(getRow(db, b.id));
    expect(flag(db, b.id)).toBe(1);
    expect(getRow(db, a.id).is_latest).toBe(1);
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(0);
  });
});

describe('resolveConflict — newRow liveness re-check inside the write lock (H1)', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('bails without superseding when a racing forget demotes newRow during the judging window', async () => {
    const a = seedMemory(db, { content: 'The region is us-east-1', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The region is eu-west-1', createdAt: 1001 });

    // Runner returns a definite "contradicts", but during the (async, unlocked) judge call a racing
    // forget demotes b — the exact window the in-lock re-check guards. Verdict is still contradicts.
    const racingForgetRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        db.prepare('UPDATE memories SET is_latest = 0, forgotten = 1 WHERE id = ?').run(b.id);
        return { value: { contradicts: true } as T };
      },
    };
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), racingForgetRunner);

    const result = await manager.resolveConflict(b);

    // No supersede, and a is never demoted — so no co-latest resurrection of the forgotten b.
    expect(result.superseded).toEqual([]);
    expect(getRow(db, a.id).is_latest).toBe(1);
    expect(getRow(db, b.id).is_latest).toBe(0);
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(0);
    const latest = (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE is_latest = 1').get() as { c: number }).c;
    expect(latest).toBe(1);
  });
});

describe('Slice 8 C4 — sweepConflictChecks re-decides flagged rows (the outage cannot linger forever)', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('a definite "contradicts" re-check CLEARS the flag AND supersedes the older fact', async () => {
    // An outage flags b while leaving a & b co-latest.
    const outageMgr = new FactGraphManager(db, new MemoryWriteQueue(db), outageRunner);
    const a = seedMemory(db, { content: 'The primary database is Postgres', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The primary database is MySQL', createdAt: 1001 });
    await outageMgr.resolveConflict(b);
    expect(flag(db, b.id)).toBe(1);
    expect(getRow(db, a.id).is_latest).toBe(1);

    // The judge is back with a definite verdict — the sweep resolves the deferral.
    const sweepMgr = new FactGraphManager(db, new MemoryWriteQueue(db), contradictRunner);
    const processed = await sweepMgr.sweepConflictChecks();

    expect(processed).toBe(1);
    // Older fact superseded, newer is sole survivor, flag cleared.
    expect(getRow(db, a.id).is_latest).toBe(0);
    expect(getRow(db, b.id).is_latest).toBe(1);
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(1);
    expect(flag(db, b.id)).toBe(0);
  });

  it('a definite "does NOT contradict" re-check CLEARS the flag and supersedes nothing (clean clear)', async () => {
    const a = seedMemory(db, { content: 'The log level defaults to warn', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The log level defaults to info', createdAt: 1001, needsConflictCheck: 1 });

    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), agreeRunner);
    const processed = await manager.sweepConflictChecks();

    expect(processed).toBe(1);
    // A definite "no" resolves the deferral: flag cleared, both rows remain latest.
    expect(flag(db, b.id)).toBe(0);
    expect(getRow(db, a.id).is_latest).toBe(1);
    expect(getRow(db, b.id).is_latest).toBe(1);
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(0);
  });

  it('a STILL-null re-check leaves the flag set (=1) for the next pass — nothing superseded', async () => {
    const a = seedMemory(db, { content: 'The API timeout is 30 seconds', createdAt: 1000 });
    const b = seedMemory(db, { content: 'The API timeout is 45 seconds', createdAt: 1001, needsConflictCheck: 1 });

    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), outageRunner);
    const processed = await manager.sweepConflictChecks();

    expect(processed).toBe(1);
    // Outage persists → the flag survives so a future sweep retries; no premature supersede.
    expect(flag(db, b.id)).toBe(1);
    expect(getRow(db, a.id).is_latest).toBe(1);
    expect(getRow(db, b.id).is_latest).toBe(1);
  });

  it('caps each pass at limit=5 flagged rows (partial-index-served), draining the backlog over passes', async () => {
    // Unique content so none are conflict candidates of another, isolating the cap from supersession.
    for (let i = 0; i < 7; i++) {
      seedMemory(db, { content: `unique flagged fact number ${i} about subsystem ${i}`, createdAt: 1000 + i, needsConflictCheck: 1 });
    }
    const flaggedCount = (): number =>
      (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE needs_conflict_check = 1').get() as { c: number }).c;
    expect(flaggedCount()).toBe(7);

    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), agreeRunner);

    // First pass processes exactly the cap (5), never all 7.
    const first = await manager.sweepConflictChecks();
    expect(first).toBe(5);
    expect(flaggedCount()).toBe(2);

    // Second pass drains the remaining 2.
    const second = await manager.sweepConflictChecks();
    expect(second).toBe(2);
    expect(flaggedCount()).toBe(0);
  });

  it('an explicit limit argument bounds the batch below the default', async () => {
    for (let i = 0; i < 4; i++) {
      seedMemory(db, { content: `distinct deferred item ${i} on module ${i}`, createdAt: 1000 + i, needsConflictCheck: 1 });
    }
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), agreeRunner);
    const processed = await manager.sweepConflictChecks(2);
    expect(processed).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS c FROM memories WHERE needs_conflict_check = 1').get() as { c: number }).c).toBe(2);
  });
});

describe('Slice 8 C5 — session isolation: a fact in one session cannot supersede another session', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('cross-session contradicting facts do NOT supersede — both stay latest', async () => {
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), contradictRunner);
    const a = seedMemory(db, {
      content: 'The current task is refactoring the parser',
      scope: 'session',
      sessionId: 'sess-A',
      createdAt: 1000,
    });
    const b = seedMemory(db, {
      content: 'The current task is refactoring the parser differently',
      scope: 'session',
      sessionId: 'sess-B',
      createdAt: 1001,
    });

    const result = await manager.resolveConflict(b);

    // The judge says they contradict, but the session gate excludes A as a candidate for B.
    expect(result.superseded).toEqual([]);
    expect(getRow(db, a.id).is_latest).toBe(1);
    expect(getRow(db, b.id).is_latest).toBe(1);
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(0);
  });

  it('SAME-session contradicting facts DO supersede (proves the gate is not over-blocking)', async () => {
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), contradictRunner);
    const a = seedMemory(db, {
      content: 'The current task is refactoring the parser',
      scope: 'session',
      sessionId: 'sess-A',
      createdAt: 1000,
    });
    const b = seedMemory(db, {
      content: 'The current task is refactoring the parser again',
      scope: 'session',
      sessionId: 'sess-A',
      createdAt: 1001,
    });

    const result = await manager.resolveConflict(b);

    expect(result.superseded).toEqual([a.id]);
    expect(getRow(db, a.id).is_latest).toBe(0);
    expect(getRow(db, b.id).is_latest).toBe(1);
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(1);
  });

  it('the session gate uses null-safe IS: two NULL-session rows still match, a NULL vs non-null does not', async () => {
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), contradictRunner);

    // Both session_id NULL → `IS NULL` matches → same domain → supersede.
    const nullA = seedMemory(db, {
      content: 'The active branch is main for this run',
      scope: 'session',
      sessionId: null,
      createdAt: 1000,
    });
    const nullB = seedMemory(db, {
      content: 'The active branch is develop for this run',
      scope: 'session',
      sessionId: null,
      createdAt: 1001,
    });

    const nullResult = await manager.resolveConflict(nullB);
    expect(nullResult.superseded).toEqual([nullA.id]);
    expect(getRow(db, nullA.id).is_latest).toBe(0);

    // A non-null-session row must NOT match a NULL-session row.
    const named = seedMemory(db, {
      content: 'The active branch is release for this run',
      scope: 'session',
      sessionId: 'sess-named',
      createdAt: 1002,
    });
    const namedResult = await manager.resolveConflict(named);
    // Its only same-scope candidate is the NULL-session survivor nullB, which the gate excludes.
    expect(namedResult.superseded).toEqual([]);
    expect(getRow(db, named.id).is_latest).toBe(1);
    expect(getRow(db, nullB.id).is_latest).toBe(1);
  });
});

describe('Slice 8 C14 — identical created_at contradictions tiebreak by higher rowid (later insertion)', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('the later-inserted (higher rowid) fact supersedes the earlier one at the SAME created_at ms', async () => {
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), contradictRunner);
    // Identical created_at; A inserted first (lower rowid), B second (higher rowid).
    const a = seedMemory(db, { content: 'The feature flag beta is enabled', createdAt: 5000 });
    const b = seedMemory(db, { content: 'The feature flag beta is disabled', createdAt: 5000 });
    expect(a.created_at).toBe(b.created_at);

    const result = await manager.resolveConflict(b);

    // B (later insertion) wins, exactly one is_latest survivor.
    expect(result.superseded).toEqual([a.id]);
    expect(getRow(db, a.id).is_latest).toBe(0);
    expect(getRow(db, b.id).is_latest).toBe(1);
    expect(edgeCount(db, 'UPDATES', b.id, a.id)).toBe(1);
    const survivors = (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE is_latest = 1').get() as { c: number }).c;
    expect(survivors).toBe(1);
  });

  it('the earlier-inserted (lower rowid) fact does NOT supersede the later one at the same ms (reverse control)', async () => {
    const manager = new FactGraphManager(db, new MemoryWriteQueue(db), contradictRunner);
    const a = seedMemory(db, { content: 'The feature flag gamma is enabled', createdAt: 6000 });
    seedMemory(db, { content: 'The feature flag gamma is disabled', createdAt: 6000 }); // higher rowid, same ms

    // Resolving from A (lower rowid, equal created_at) must NOT supersede the newer-rowid row.
    const result = await manager.resolveConflict(a);

    expect(result.superseded).toEqual([]);
    // Both remain latest — the earlier insertion never wins the equal-ms tiebreak.
    const survivors = (db.prepare('SELECT COUNT(*) AS c FROM memories WHERE is_latest = 1').get() as { c: number }).c;
    expect(survivors).toBe(2);
    expect(getRow(db, a.id).is_latest).toBe(1);
  });
});

describe('Slice 8 — migration v3 schema (needs_conflict_check column, partial index, version bump)', () => {
  it('a fresh fully-migrated DB has the NOT NULL DEFAULT 0 column, the partial index, and schema version 3', async () => {
    const db = await createTestMemoryDb();

    const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const col = cols.find((c) => c.name === 'needs_conflict_check');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(1);
    expect(Number(col!.dflt_value)).toBe(0);

    // The partial index is genuinely partial (WHERE needs_conflict_check = 1).
    const idx = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_needs_conflict_check'",
    ).get() as { sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/WHERE\s+needs_conflict_check\s*=\s*1/i);

    const version = (db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v;
    expect(version).toBe(3);

    // A row inserted without the column defaults to 0 (what migrating rows inherit).
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, created_at, updated_at)
       VALUES (?, 'fact', 'project', 'defaulting row', '', ?, ?, ?)`,
    ).run(id, id, now, now);
    expect((db.prepare('SELECT needs_conflict_check AS n FROM memories WHERE id = ?').get(id) as { n: number }).n).toBe(0);
  });

  it('applies cleanly onto a pre-existing v2 database, back-filling existing rows to 0', async () => {
    // A minimal v2 DB (no needs_conflict_check, schema_version=2, one row). runMigrations must apply
    // MIGRATION_V3 (ALTER ADD COLUMN + partial index) and back-fill the row's new column to 0.
    const raw = new DatabaseSync(':memory:');
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec('CREATE TABLE schema_version (version INTEGER NOT NULL)');
    raw.exec('CREATE TABLE memories (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL)');
    raw.exec("INSERT INTO memories (id, created_at) VALUES ('legacy-row', 1)");
    raw.exec('INSERT INTO schema_version (version) VALUES (1)');
    raw.exec('INSERT INTO schema_version (version) VALUES (2)');

    const db = createDatabaseWrapper(raw);
    const before = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(before).not.toContain('needs_conflict_check');

    runMigrations(db);

    // v3 applied: column present, legacy row back-filled to 0, version 3, index created.
    const after = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>).map((c) => c.name);
    expect(after).toContain('needs_conflict_check');
    expect(
      (db.prepare("SELECT needs_conflict_check AS n FROM memories WHERE id = 'legacy-row'").get() as { n: number }).n,
    ).toBe(0);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(3);
    const idx = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_memories_needs_conflict_check'",
    ).get() as { sql: string } | undefined;
    expect(idx).toBeDefined();
    expect(idx!.sql).toMatch(/WHERE\s+needs_conflict_check\s*=\s*1/i);

    // Idempotent: a second runMigrations does not throw or bump past 3.
    expect(() => runMigrations(db)).not.toThrow();
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(3);

    db.close();
  });
});
