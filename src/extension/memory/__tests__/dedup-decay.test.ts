import { describe, it, expect, beforeEach } from 'vitest';
import * as crypto from 'crypto';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import {
  insertWithDedup,
  findNearDuplicates,
  mergeNearDuplicates,
  applyDecaySweep,
  promoteEpisodes,
  pruneConsumedCandidates,
  EPISODE_TTL_MS,
} from '../dedup-decay';

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
}

function seedMemory(db: DatabaseInstance, opts: SeedOpts): MemoryRow {
  const id = opts.id ?? crypto.randomUUID();
  const createdAt = opts.createdAt ?? Date.now();
  db.prepare(
    `INSERT INTO memories (
       id, kind, scope, content, content_hash, root_id,
       forget_after, pinned, source_count, access_count, created_at, updated_at
     ) VALUES (?, ?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.kind,
    opts.scope ?? 'project',
    opts.content,
    id,
    opts.forgetAfter ?? null,
    opts.pinned ?? 0,
    opts.sourceCount ?? 1,
    opts.accessCount ?? 0,
    createdAt,
    createdAt,
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

  it('promotes episodes that cross the source_count or access_count threshold', async () => {
    const future = Date.now() + EPISODE_TTL_MS;

    const bySource = seedMemory(db, { kind: 'episode', content: 'merged twice', forgetAfter: future, sourceCount: 2 });
    const byAccess = seedMemory(db, { kind: 'episode', content: 'accessed thrice', forgetAfter: future, accessCount: 3 });
    const untouched = seedMemory(db, { kind: 'episode', content: 'fresh episode', forgetAfter: future });

    const result = await promoteEpisodes(db, queue);
    expect(result.promoted).toBe(2);

    expect(getRow(db, bySource.id).forget_after).toBeNull();
    expect(getRow(db, byAccess.id).forget_after).toBeNull();
    expect(getRow(db, untouched.id).forget_after).toBe(future);
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
});
