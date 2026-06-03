import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { ProfileManager } from '../managers/profile-manager';
import { runConsolidation, type ConsolidationCtx } from '../consolidation';

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

/** Independent mock runner that extracts the SAME single fact each time and judges no contradiction/merge. */
function makeRunner(extractMemories: ExtractedMemorySeed[]): MemorySubCallRunner {
  return {
    run: vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
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
    reason: 'switch',
    sessionId: SESSION_ID,
    workspace: WORKSPACE,
    autoExtractEnabled: true,
    onNoModel: () => {},
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
