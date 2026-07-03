import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTestMemoryDb, assertContentHashInvariant } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import { normalizedContentHash } from '../types';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import {
  insertWithDedup,
  findNearDuplicates,
  mergeNearDuplicates,
  applyDecaySweep,
  promoteEpisodes,
  pruneConsumedCandidates,
  purgeForgottenRows,
  isMergeResult,
  EPISODE_TTL_MS,
  FORGOTTEN_PURGE_AGE_MS,
} from '../dedup-decay';

// Drive a real MemoryService against a per-test temp DB instead of the global ~/.damocles file, and
// stub the sub-call runner + term expansion so init never reaches PiRuntime/the model layer.
const dbHolder = vi.hoisted(() => ({ path: '' }));

vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      raw.exec('PRAGMA journal_mode = WAL');
      raw.exec('PRAGMA synchronous = NORMAL');
      raw.exec('PRAGMA foreign_keys = ON');
      const db = actual.createDatabaseWrapper(raw);
      actual.runMigrations(db);
      return { db };
    }),
  };
});

vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
}));

// Stub term expansion (reaches PiRuntime) so updateMemory's fire-and-forget re-expand never touches
// the model layer or races our assertions.
vi.mock('../query-expansion', () => ({
  expandMemoryTerms: vi.fn(async () => []),
  expandQuery: vi.fn(async () => []),
  clearExpansionCache: vi.fn(() => {}),
}));

import { MemoryService } from '../index';

const DAY_MS = 24 * 60 * 60 * 1000;

function getRow(db: DatabaseInstance, id: string): MemoryRow {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
}

interface SeedOpts {
  id?: string;
  kind: string;
  scope?: string;
  content: string;
  forgetAfter?: number | null;
  pinned?: number;
  sourceCount?: number;
  accessCount?: number;
  createdAt?: number;
  updatedAt?: number;
  forgotten?: number;
  forgetReason?: string | null;
}

function seedMemory(db: DatabaseInstance, opts: SeedOpts): MemoryRow {
  const id = opts.id ?? crypto.randomUUID();
  const createdAt = opts.createdAt ?? Date.now();
  const updatedAt = opts.updatedAt ?? createdAt;
  db.prepare(
    `INSERT INTO memories (
       id, kind, scope, content, content_hash, root_id,
       forget_after, pinned, source_count, access_count, forgotten, forget_reason, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.kind,
    opts.scope ?? 'project',
    opts.content,
    normalizedContentHash(opts.content),
    id,
    opts.forgetAfter ?? null,
    opts.pinned ?? 0,
    opts.sourceCount ?? 1,
    opts.accessCount ?? 0,
    opts.forgotten ?? 0,
    opts.forgetReason ?? null,
    createdAt,
    updatedAt,
  );
  return getRow(db, id);
}

function seedCandidate(db: DatabaseInstance, consumed: number, createdAt: number, reprocessed = 0): string {
  const id = crypto.randomUUID();
  db.prepare(
    'INSERT INTO memory_candidates (id, consumed, reprocessed, created_at) VALUES (?, ?, ?, ?)',
  ).run(id, consumed, reprocessed, createdAt);
  return id;
}

describe('dedup-decay', () => {
  let db: DatabaseInstance;
  let queue: MemoryWriteQueue;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    queue = new MemoryWriteQueue();
  });

  it('exact-dedups identical content into one row, bumping source_count', async () => {
    const first = await insertWithDedup(db, queue, {
      kind: 'fact',
      scope: 'project',
      content: 'The build command is npm run build',
    });
    expect(first.deduped).toBe(false);

    const second = await insertWithDedup(db, queue, {
      kind: 'fact',
      scope: 'project',
      content: '  The   Build   Command   is   NPM run build  ',
    });
    expect(second.deduped).toBe(true);
    expect(second.id).toBe(first.id);

    const rows = db.prepare("SELECT * FROM memories WHERE kind = 'fact'").all() as MemoryRow[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.source_count).toBe(2);
  });

  it('sets episode TTL on insert and leaves facts durable', async () => {
    const createdAt = 1_700_000_000_000;

    const episode = await insertWithDedup(db, queue, {
      kind: 'episode',
      scope: 'session',
      content: 'Worked on the dedup module today',
      createdAt,
    });
    expect(getRow(db, episode.id).forget_after).toBe(createdAt + EPISODE_TTL_MS);

    const fact = await insertWithDedup(db, queue, {
      kind: 'fact',
      scope: 'project',
      content: 'The deploy target is production',
      createdAt,
    });
    expect(getRow(db, fact.id).forget_after).toBeNull();
  });

  it('decays an expired unpinned episode but never a fact, and skips pinned episodes', async () => {
    const past = Date.now() - DAY_MS;

    const episode = seedMemory(db, { kind: 'episode', content: 'an old episode', forgetAfter: past });
    const fact = seedMemory(db, { kind: 'fact', content: 'a durable fact', forgetAfter: past });
    const pinnedEpisode = seedMemory(db, {
      kind: 'episode',
      content: 'a pinned episode',
      forgetAfter: past,
      pinned: 1,
    });

    const result = await applyDecaySweep(db, queue);
    expect(result.forgotten).toBe(1);

    const decayed = getRow(db, episode.id);
    expect(decayed.forgotten).toBe(1);
    expect(decayed.forget_reason).toBe('episode_decay');

    expect(getRow(db, fact.id).forgotten).toBe(0);
    expect(getRow(db, pinnedEpisode.id).forgotten).toBe(0);
  });

  it('promotes episodes that cross the access_count threshold or the day-spread source_count gate', async () => {
    const now = Date.now();
    const future = now + EPISODE_TTL_MS;

    // source_count>=2 AND restatements spread over >1 day → promotes (genuinely recurring).
    const bySourceSpread = seedMemory(db, {
      kind: 'episode', content: 'restated across days', forgetAfter: future,
      sourceCount: 2, createdAt: now - 2 * DAY_MS, updatedAt: now,
    });
    const byAccess = seedMemory(db, { kind: 'episode', content: 'accessed thrice', forgetAfter: future, accessCount: 3 });
    const untouched = seedMemory(db, { kind: 'episode', content: 'fresh episode', forgetAfter: future });

    const result = await promoteEpisodes(db, queue);
    expect(result.promoted).toBe(2);

    expect(getRow(db, bySourceSpread.id).forget_after).toBeNull();
    expect(getRow(db, byAccess.id).forget_after).toBeNull();
    expect(getRow(db, untouched.id).forget_after).toBe(future);
  });

  it('does NOT promote an episode restated twice within a day (C13: adjacent-turn repeat still decays)', async () => {
    const now = Date.now();
    const future = now + EPISODE_TTL_MS;

    // source_count>=2 but spread ≈ 1 hour (< 1 day) → must NOT promote.
    const adjacent = seedMemory(db, {
      kind: 'episode', content: 'restated twice in an hour', forgetAfter: future,
      sourceCount: 2, createdAt: now - 60 * 60 * 1000, updatedAt: now,
    });

    const result = await promoteEpisodes(db, queue);
    expect(result.promoted).toBe(0);
    expect(getRow(db, adjacent.id).forget_after).toBe(future);
  });

  it('prunes old processed candidates but keeps unconsumed and crash-stranded ones', async () => {
    const now = Date.now();
    const oldProcessed = seedCandidate(db, 1, now - 8 * DAY_MS, 1);
    const oldStranded = seedCandidate(db, 1, now - 8 * DAY_MS, 0);
    const recentUnconsumed = seedCandidate(db, 0, now);

    const result = await pruneConsumedCandidates(db, queue);
    expect(result.pruned).toBe(1);

    expect(db.prepare('SELECT id FROM memory_candidates WHERE id = ?').get(oldProcessed)).toBeUndefined();
    expect(db.prepare('SELECT id FROM memory_candidates WHERE id = ?').get(oldStranded)).toBeDefined();
    expect(db.prepare('SELECT id FROM memory_candidates WHERE id = ?').get(recentUnconsumed)).toBeDefined();
  });

  it('hard-purges aged decayed/merged forgotten rows with edge+retrieval hygiene, sparing user_forget and recent rows', async () => {
    const now = Date.now();
    const oldTs = now - FORGOTTEN_PURGE_AGE_MS - DAY_MS;

    const decayed = seedMemory(db, {
      kind: 'episode', content: 'aged decayed episode',
      forgotten: 1, forgetReason: 'episode_decay', createdAt: oldTs, updatedAt: oldTs,
    });
    const merged = seedMemory(db, {
      kind: 'fact', content: 'aged merged fact',
      forgotten: 1, forgetReason: 'merged', createdAt: oldTs, updatedAt: oldTs,
    });
    const userForget = seedMemory(db, {
      kind: 'fact', content: 'aged user-forgotten fact (must survive — user can unforget)',
      forgotten: 1, forgetReason: 'user_forget', createdAt: oldTs, updatedAt: oldTs,
    });
    const recentDecayed = seedMemory(db, {
      kind: 'episode', content: 'recently decayed episode',
      forgotten: 1, forgetReason: 'episode_decay', createdAt: now, updatedAt: now,
    });

    // Incident edge + retrieval on the decayed row, to prove hygiene beyond the row delete.
    db.prepare(
      "INSERT INTO memory_edges (id, kind, source_id, target_id, extra, created_at) VALUES (?, 'SUPERSEDES', ?, ?, '{}', ?)",
    ).run(crypto.randomUUID(), decayed.id, merged.id, oldTs);
    db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)').run(decayed.id, '/ws', oldTs);

    const result = await purgeForgottenRows(db, queue);
    expect(result.purged).toBe(2);

    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(decayed.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(merged.id)).toBeUndefined();
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(userForget.id)).toBeDefined();
    expect(db.prepare('SELECT id FROM memories WHERE id = ?').get(recentDecayed.id)).toBeDefined();

    // Incident edges + retrievals of the purged rows are gone.
    const edgeCount = db
      .prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE source_id = ? OR target_id = ?')
      .get(decayed.id, decayed.id) as { c: number };
    expect(edgeCount.c).toBe(0);
    const retrievalCount = db
      .prepare('SELECT COUNT(*) AS c FROM memory_retrievals WHERE memory_id = ?')
      .get(decayed.id) as { c: number };
    expect(retrievalCount.c).toBe(0);
  });

  it('does not dedup identical session-scoped content across different sessions', async () => {
    const a = await insertWithDedup(db, queue, { kind: 'episode', scope: 'session', content: 'working on the parser', sessionId: 'sess-A' });
    const b = await insertWithDedup(db, queue, { kind: 'episode', scope: 'session', content: 'working on the parser', sessionId: 'sess-B' });
    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(false);
    expect(a.id).not.toBe(b.id);

    const again = await insertWithDedup(db, queue, { kind: 'episode', scope: 'session', content: 'working on the parser', sessionId: 'sess-A' });
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(a.id);
  });

  it('finds near-duplicates by FTS score and merges them via the runner', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The API timeout is 30 seconds for requests' });
    const dup = seedMemory(db, { kind: 'fact', content: 'The API timeout is 30 seconds for all requests' });
    seedMemory(db, { kind: 'fact', content: 'Unrelated content about colors and shapes' });

    const near = findNearDuplicates(db, primary, 0.5);
    expect(near.map(r => r.id)).toContain(dup.id);

    const mergeRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        return {
          value: {
            content: 'The API timeout is 30 seconds for all requests',
            tags: ['api', 'timeout'],
            merged_ids: [dup.id],
          } as T,
        };
      },
    };

    const result = await mergeNearDuplicates(db, queue, mergeRunner, primary, [dup]);
    expect(result.merged).toBe(1);

    const mergedRow = getRow(db, dup.id);
    expect(mergedRow.forgotten).toBe(1);
    expect(mergedRow.forget_reason).toBe('merged');

    const primaryRow = getRow(db, primary.id);
    expect(primaryRow.source_count).toBe(2);
    expect(JSON.parse(primaryRow.tags)).toEqual(['api', 'timeout']);
  });

  it('unions the merged tags onto the primary rather than replacing them', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The retry budget is three attempts' });
    const dup = seedMemory(db, { kind: 'fact', content: 'The retry budget is 3 attempts total' });
    db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run(JSON.stringify(['existing']), primary.id);

    const mergeRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        return { value: { content: 'The retry budget is 3 attempts', tags: ['retry'], merged_ids: [dup.id] } as T };
      },
    };

    await mergeNearDuplicates(db, queue, mergeRunner, primary, [dup]);

    expect(JSON.parse(getRow(db, primary.id).tags)).toEqual(['existing', 'retry']);
  });

  it('preserves the primary tags when the merge returns an empty tag array', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The log level defaults to warn' });
    const dup = seedMemory(db, { kind: 'fact', content: 'Default log level is warn' });
    db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run(JSON.stringify(['keep']), primary.id);

    const mergeRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        return { value: { content: 'Default log level is warn', tags: [], merged_ids: [dup.id] } as T };
      },
    };

    await mergeNearDuplicates(db, queue, mergeRunner, primary, [dup]);

    expect(JSON.parse(getRow(db, primary.id).tags)).toEqual(['keep']);
  });

  it('does not flag a same-content session memory from a different session as a near-dup', () => {
    const a = seedMemory(db, { kind: 'episode', scope: 'session', content: 'debugging the websocket reconnect logic' });
    db.prepare('UPDATE memories SET session_id = ? WHERE id = ?').run('sess-A', a.id);
    const b = seedMemory(db, { kind: 'episode', scope: 'session', content: 'debugging the websocket reconnect path' });
    db.prepare('UPDATE memories SET session_id = ? WHERE id = ?').run('sess-B', b.id);
    const c = seedMemory(db, { kind: 'episode', scope: 'session', content: 'debugging the websocket reconnect handler' });
    db.prepare('UPDATE memories SET session_id = ? WHERE id = ?').run('sess-A', c.id);

    const aRow = getRow(db, a.id);
    const ids = findNearDuplicates(db, aRow, 0.4).map(r => r.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(b.id);
  });

  it('does not blank the primary when the merge returns empty content', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The build output goes to dist' });
    const dup = seedMemory(db, { kind: 'fact', content: 'Build output is written to the dist folder' });

    const emptyRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        return { value: { content: '   ', merged_ids: [dup.id] } as T };
      },
    };

    const result = await mergeNearDuplicates(db, queue, emptyRunner, primary, [dup]);
    expect(result.merged).toBe(0);
    expect(getRow(db, primary.id).content).toBe('The build output goes to dist');
    expect(getRow(db, dup.id).forgotten).toBe(0);
  });

  it('is a no-op when the merge runner degrades to null', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The cache size is 512 megabytes' });
    const dup = seedMemory(db, { kind: 'fact', content: 'The cache size is 512 mb total' });

    const nullRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        return { value: null, failure: 'transient' };
      },
    };

    const result = await mergeNearDuplicates(db, queue, nullRunner, primary, [dup]);
    expect(result.merged).toBe(0);
    expect(getRow(db, dup.id).forgotten).toBe(0);
  });

  it('bails without clobbering when the primary content drifts during the merge window (deep nit)', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The cache size is 512 megabytes' });
    const dup = seedMemory(db, { kind: 'fact', content: 'The cache size is 512 mb total' });

    // A racing edit to the primary lands during the (async) merge call — the exact drift window.
    const driftRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        const edited = 'The cache size is now 1024 megabytes';
        db.prepare('UPDATE memories SET content = ?, content_hash = ? WHERE id = ?').run(
          edited, normalizedContentHash(edited), primary.id,
        );
        return { value: { content: 'The cache size is 512 mb', merged_ids: [dup.id] } as T };
      },
    };

    const result = await mergeNearDuplicates(db, queue, driftRunner, primary, [dup]);
    expect(result.merged).toBe(0);
    // The racing edit survives; the dup is not forgotten by a stale merge.
    expect(getRow(db, primary.id).content).toBe('The cache size is now 1024 megabytes');
    expect(getRow(db, dup.id).forgotten).toBe(0);
  });

  // A hostile merge shape (missing content, non-array merged_ids, non-string ids) must never throw
  // or mutate a row: mergeNearDuplicates degrades to {merged:0} and the dup stays live.
  it('isMergeResult accepts a well-formed shape and rejects hostile ones', () => {
    expect(isMergeResult({ content: 'merged', merged_ids: ['a', 'b'] })).toBe(true);
    expect(isMergeResult({ content: 'merged', merged_ids: [], tags: ['t'] })).toBe(true);
    expect(isMergeResult(null)).toBe(false);
    expect(isMergeResult({})).toBe(false); // missing content + merged_ids
    expect(isMergeResult({ content: 'x' })).toBe(false); // missing merged_ids
    expect(isMergeResult({ content: 42, merged_ids: [] })).toBe(false); // content not a string
    expect(isMergeResult({ content: 'x', merged_ids: 'a' })).toBe(false); // merged_ids not an array
    expect(isMergeResult({ content: 'x', merged_ids: [1, 2] })).toBe(false); // ids not strings
    expect(isMergeResult({ content: 'x', merged_ids: [], tags: [1] })).toBe(false); // tags not strings
  });

  const hostileMergeShapes: Array<{ name: string; value: unknown }> = [
    { name: 'missing content', value: { merged_ids: [] } },
    { name: 'missing merged_ids', value: { content: 'x' } },
    { name: 'merged_ids is a string, not an array', value: { content: 'x', merged_ids: 'nope' } },
    { name: 'merged_ids holds non-string ids', value: { content: 'x', merged_ids: [1, 2, 3] } },
    { name: 'content is a number', value: { content: 99, merged_ids: [] } },
  ];

  for (const shape of hostileMergeShapes) {
    it(`mergeNearDuplicates is a logged no-op (no throw, no write) on an invalid shape: ${shape.name}`, async () => {
      const primary = seedMemory(db, { kind: 'fact', content: 'The worker pool size is eight threads' });
      const dup = seedMemory(db, { kind: 'fact', content: 'The worker pool size is 8 threads total' });

      const hostileRunner: MemorySubCallRunner = {
        async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
          return { value: shape.value as T };
        },
      };

      // Resolves (never rejects) to a no-op.
      const result = await mergeNearDuplicates(db, queue, hostileRunner, primary, [dup]);
      expect(result.merged).toBe(0);
      // No row mutated: dup still live, primary content unchanged.
      expect(getRow(db, dup.id).forgotten).toBe(0);
      expect(getRow(db, primary.id).content).toBe('The worker pool size is eight threads');
    });
  }

  it('recomputes content_hash to match the merged content — with-tags branch', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The API timeout is 30 seconds for requests' });
    const dup = seedMemory(db, { kind: 'fact', content: 'The API timeout is 30 seconds for all requests' });

    const mergedContent = 'The API timeout is 30 seconds for all requests';
    const mergeRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        return { value: { content: mergedContent, tags: ['api', 'timeout'], merged_ids: [dup.id] } as T };
      },
    };

    const result = await mergeNearDuplicates(db, queue, mergeRunner, primary, [dup]);
    expect(result.merged).toBe(1);

    const primaryRow = getRow(db, primary.id);
    // Content rewritten and its hash tracks the new content (no stale key).
    expect(primaryRow.content).toBe(mergedContent);
    expect(primaryRow.content_hash).toBe(normalizedContentHash(mergedContent));
    expect(JSON.parse(primaryRow.tags)).toEqual(['api', 'timeout']);

    expect(assertContentHashInvariant(db)).toEqual([]);
  });

  it('recomputes content_hash to match the merged content — without-tags branch', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The retry budget is three attempts' });
    const dup = seedMemory(db, { kind: 'fact', content: 'The retry budget is 3 attempts total' });
    db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run(JSON.stringify(['keep']), primary.id);

    const mergedContent = 'The retry budget is 3 attempts';
    const mergeRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        // No tags (empty) → the without-tags UPDATE branch runs; tags stay as-is.
        return { value: { content: mergedContent, tags: [], merged_ids: [dup.id] } as T };
      },
    };

    const result = await mergeNearDuplicates(db, queue, mergeRunner, primary, [dup]);
    expect(result.merged).toBe(1);

    const primaryRow = getRow(db, primary.id);
    expect(primaryRow.content).toBe(mergedContent);
    expect(primaryRow.content_hash).toBe(normalizedContentHash(mergedContent));
    expect(JSON.parse(primaryRow.tags)).toEqual(['keep']); // untouched by the without-tags branch

    expect(assertContentHashInvariant(db)).toEqual([]);
  });

  it('lets a later exact-dedup insert of the MERGED wording dedup onto the primary (hash matches)', async () => {
    const primary = seedMemory(db, { kind: 'fact', content: 'The build output goes to the dist directory' });
    const dup = seedMemory(db, { kind: 'fact', content: 'Build output is written to the dist folder' });

    const mergedContent = 'The build output is written to the dist directory';
    const mergeRunner: MemorySubCallRunner = {
      async run<T>(_req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
        return { value: { content: mergedContent, merged_ids: [dup.id] } as T };
      },
    };
    await mergeNearDuplicates(db, queue, mergeRunner, primary, [dup]);

    const before = getRow(db, primary.id);
    expect(before.source_count).toBe(2); // primary(1) + one merged dup

    // A later extraction of the merged wording (whitespace/case variant) exact-dedups onto the
    // primary — only possible because the hash was refreshed to the merged content.
    const reinsert = await insertWithDedup(db, queue, {
      kind: 'fact',
      scope: 'project',
      content: '  The   Build   Output   is written to the DIST directory  ',
    });
    expect(reinsert.deduped).toBe(true);
    expect(reinsert.id).toBe(primary.id);

    expect(getRow(db, primary.id).source_count).toBe(3);
    const factRows = db.prepare("SELECT COUNT(*) AS c FROM memories WHERE kind = 'fact' AND forgotten = 0").get() as { c: number };
    expect(factRows.c).toBe(1); // still just the primary — no duplicate created

    expect(assertContentHashInvariant(db)).toEqual([]);
  });
});

// note/episode/observation edits update the SAME row in place (no new version), recompute
// content_hash, and preserve tags when omitted.
describe('MemoryService.updateMemory — in-place edit for note/episode/observation (Slice 5)', () => {
  let service: MemoryService;

  beforeEach(() => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-updatemem-${crypto.randomUUID()}.db`);
    service = new MemoryService('/ext');
  });

  afterEach(() => {
    service.dispose();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbHolder.path + suffix);
      } catch {
        /* already gone */
      }
    }
  });

  /** Insert a live in-place-kind row directly (bypasses extraction) with a valid content_hash. */
  function seedRow(db: DatabaseInstance, kind: string, scope: string, content: string, tags: string[]): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, tags, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, kind, scope, content, normalizedContentHash(content), id, JSON.stringify(tags), now, now);
    return id;
  }

  async function drainExpansion(): Promise<void> {
    // Let updateMemory's fire-and-forget _expandSearchTerms settle.
    await new Promise((r) => setTimeout(r, 20));
  }

  for (const kind of ['note', 'episode', 'observation'] as const) {
    it(`updates a ${kind} in place: same id, recomputed hash, no new version row`, async () => {
      await service.ensureInitialized();
      const db = service.database!;
      const scope = kind === 'observation' ? 'project' : kind === 'note' ? 'global' : 'session';
      const id = seedRow(db, kind, scope, `original ${kind} content`, ['t1', 't2']);
      const before = getRow(db, id);

      const updated = await service.updateMemory(id, `revised ${kind} content`);
      await drainExpansion();

      expect(updated).not.toBeNull();
      expect(updated!.id).toBe(id);

      const after = getRow(db, id);
      expect(after.content).toBe(`revised ${kind} content`);
      expect(after.version).toBe(before.version); // no version bump for in-place kinds
      expect(after.is_latest).toBe(1);
      expect(after.content_hash).toBe(normalizedContentHash(`revised ${kind} content`));

      // One row for this root — no new version inserted.
      const rowCount = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE root_id = ?').get(id) as { c: number };
      expect(rowCount.c).toBe(1);

      // Tags preserved when omitted.
      expect(JSON.parse(after.tags)).toEqual(['t1', 't2']);

      expect(assertContentHashInvariant(db)).toEqual([]);
    });
  }

  it('replaces tags when provided on an in-place edit and still recomputes the hash', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    const id = seedRow(db, 'note', 'global', 'a note about caching', ['old']);

    await service.updateMemory(id, 'a note about caching layers', ['new', 'tags']);
    await drainExpansion();

    const after = getRow(db, id);
    expect(after.content).toBe('a note about caching layers');
    expect(after.content_hash).toBe(normalizedContentHash('a note about caching layers'));
    expect(JSON.parse(after.tags)).toEqual(['new', 'tags']);
    expect(assertContentHashInvariant(db)).toEqual([]);
  });

  it('routes a fact edit to a NEW version row (not in place) and keeps the hash invariant', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    const id = seedRow(db, 'fact', 'project', 'the queue depth is 100', ['q']);

    const updated = await service.updateMemory(id, 'the queue depth is 250');
    await drainExpansion();

    // Facts version: the live row is a new id, old row demoted, two rows share the root.
    expect(updated).not.toBeNull();
    expect(updated!.id).not.toBe(id);
    expect(getRow(db, id).is_latest).toBe(0);

    const newRow = getRow(db, updated!.id);
    expect(newRow.parent_id).toBe(id);
    expect(newRow.version).toBe(2);
    expect(newRow.content_hash).toBe(normalizedContentHash('the queue depth is 250'));
    expect(JSON.parse(newRow.tags)).toEqual(['q']); // carried when omitted

    const rowCount = db.prepare('SELECT COUNT(*) AS c FROM memories WHERE root_id = ?').get(id) as { c: number };
    expect(rowCount.c).toBe(2);

    expect(assertContentHashInvariant(db)).toEqual([]);
  });
});

// Deleting a session removes its memory rows, their retrievals, AND their incident edges — zero orphans.
describe('MemoryService.deleteSessionMemories — delete hygiene (Slice 6)', () => {
  let service: MemoryService;

  beforeEach(() => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-delsession-${crypto.randomUUID()}.db`);
    service = new MemoryService('/ext');
  });

  afterEach(() => {
    service.dispose();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbHolder.path + suffix);
      } catch {
        /* already gone */
      }
    }
  });

  function seedSessionRow(db: DatabaseInstance, sessionId: string, content: string): string {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, session_id, created_at, updated_at)
       VALUES (?, 'fact', 'session', ?, ?, ?, ?, ?, ?)`,
    ).run(id, content, normalizedContentHash(content), id, sessionId, now, now);
    return id;
  }

  it('deletes session rows + their retrievals + their incident edges, leaving zero orphans', async () => {
    await service.ensureInitialized();
    const db = service.database!;
    const sessionId = 'sess-delete-me';
    const otherSessionId = 'sess-keep-me';

    const a = seedSessionRow(db, sessionId, 'session fact alpha');
    const b = seedSessionRow(db, sessionId, 'session fact beta');
    // A row in a different session that must survive untouched.
    const keep = seedSessionRow(db, otherSessionId, 'session fact in another session');

    db.prepare(
      'INSERT INTO memory_edges (id, kind, source_id, target_id, extra, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(crypto.randomUUID(), 'EXTENDS', a, b, '{}', Date.now());
    db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)').run(a, '/ws', Date.now());
    db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)').run(b, '/ws', Date.now());
    db.prepare('INSERT INTO memory_retrievals (memory_id, workspace, retrieved_at) VALUES (?, ?, ?)').run(keep, '/ws', Date.now());

    await service.deleteSessionMemories(sessionId);

    expect(
      (db.prepare("SELECT COUNT(*) AS c FROM memories WHERE session_id = ?").get(sessionId) as { c: number }).c,
    ).toBe(0);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM memory_retrievals WHERE memory_id IN (?, ?)').get(a, b) as { c: number }).c,
    ).toBe(0);
    expect(
      (db
        .prepare('SELECT COUNT(*) AS c FROM memory_edges WHERE source_id IN (?, ?) OR target_id IN (?, ?)')
        .get(a, b, a, b) as { c: number }).c,
    ).toBe(0);

    // The other session's row + retrieval are untouched.
    expect((db.prepare('SELECT COUNT(*) AS c FROM memories WHERE id = ?').get(keep) as { c: number }).c).toBe(1);
    expect(
      (db.prepare('SELECT COUNT(*) AS c FROM memory_retrievals WHERE memory_id = ?').get(keep) as { c: number }).c,
    ).toBe(1);
  });
});
