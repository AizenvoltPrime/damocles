import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { ProfileManager } from '../managers/profile-manager';
import { runConsolidation, CANDIDATE_TOKEN_BUDGET, type ConsolidationCtx } from '../consolidation';
import type { ConsolidationExtractedMemory } from '@shared/types/consolidation';

const BUDGET_CHARS = CANDIDATE_TOKEN_BUDGET * 4;

const WORKSPACE = '/tmp/workspace';
const SESSION_ID = 'session-esbuild';

interface CountRow {
  count: number;
}

function seedCandidate(db: DatabaseInstance, sessionId: string, userText: string, assistantText: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, salient, consumed, reprocessed, created_at)
     VALUES (?, ?, ?, ?, ?, '[]', 0, 0, 0, ?)`,
  ).run(id, sessionId, 0, userText, assistantText, Date.now());
  return id;
}

function countLiveMemories(db: DatabaseInstance, scope: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM memories WHERE is_latest = 1 AND forgotten = 0 AND scope = ?")
    .get(scope) as CountRow;
  return row.count;
}

function countConsumedCandidates(db: DatabaseInstance): number {
  const row = db.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 1').get() as CountRow;
  return row.count;
}

/**
 * Stub runner that answers each sub-call purpose with a benign value: `extract` returns a fixed
 * single fact, `merge`/conflict judgements report no merge/contradiction, `profile` returns empty
 * sections. Records every call so tests can assert it was (or was not) invoked.
 */
function makeRunner(extractValue: unknown): { runner: MemorySubCallRunner; run: ReturnType<typeof vi.fn> } {
  const run = vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
    if (req.purpose === 'extract') return { value: extractValue as T };
    if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } as T };
    return { value: { contradicts: false, merged_ids: [], content: '' } as T };
  });
  return { runner: { run }, run };
}

function makeCtx(
  db: DatabaseInstance,
  runner: MemorySubCallRunner,
  overrides: Partial<ConsolidationCtx> = {},
): ConsolidationCtx {
  const writeQueue = new MemoryWriteQueue();
  return {
    db,
    writeQueue,
    runner,
    factGraph: new FactGraphManager(db, writeQueue, runner),
    profileManager: new ProfileManager(db, writeQueue, runner),
    reason: 'switch',
    sessionId: SESSION_ID,
    workspace: WORKSPACE,
    autoExtractEnabled: true,
    onNoModel: () => {},
    ...overrides,
  };
}

const ESBUILD_EXTRACTION = {
  memories: [
    {
      kind: 'fact',
      content: 'The project chose esbuild for bundling the extension.',
      scope: 'project',
      tags: ['build'],
    },
  ],
};

describe('runConsolidation', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('extracts one project memory from candidates and marks them consumed', async () => {
    seedCandidate(db, SESSION_ID, 'Which bundler did we pick?', 'We picked esbuild for the extension.');
    seedCandidate(db, SESSION_ID, 'Why esbuild?', 'It is fast and bundles the extension cleanly.');
    seedCandidate(db, SESSION_ID, 'Confirm the bundler.', 'esbuild is the chosen bundler.');

    const { runner, run } = makeRunner(ESBUILD_EXTRACTION);
    await runConsolidation(makeCtx(db, runner));

    expect(countLiveMemories(db, 'project')).toBe(1);
    expect(countConsumedCandidates(db)).toBe(3);

    const committed = db
      .prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 1 AND reprocessed = 1')
      .get() as CountRow;
    expect(committed.count).toBe(3);

    const extractCalls = run.mock.calls.filter(([req]) => (req as MemorySubCallRequest).purpose === 'extract');
    expect(extractCalls).toHaveLength(1);
  });

  it('does nothing and issues zero runner calls when auto-extraction is disabled (D6)', async () => {
    seedCandidate(db, SESSION_ID, 'Which bundler did we pick?', 'We picked esbuild for the extension.');

    const { runner, run } = makeRunner(ESBUILD_EXTRACTION);
    await runConsolidation(makeCtx(db, runner, { autoExtractEnabled: false }));

    expect(countLiveMemories(db, 'project')).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(countConsumedCandidates(db)).toBe(0);
  });

  it('releases the claimed batch (consumed=0) on a transient extraction failure — no candidate loss (H1)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');
    seedCandidate(db, SESSION_ID, 'q2', 'a2');

    const run = vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') return { value: null, failure: 'transient' };
      if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } as T };
      return { value: { contradicts: false, merged_ids: [], content: '' } as T };
    });

    await runConsolidation(makeCtx(db, { run }));

    expect(countConsumedCandidates(db)).toBe(0);
    expect(countLiveMemories(db, 'project')).toBe(0);
  });

  it('releases the batch and signals onNoModel when no extraction model is available (H1)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');

    const onNoModel = vi.fn();
    const run = vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') return { value: null, failure: 'no-model' };
      return { value: { static: '', dynamic: '' } as T };
    });

    await runConsolidation(makeCtx(db, { run }, { onNoModel }));

    expect(countConsumedCandidates(db)).toBe(0);
    expect(onNoModel).toHaveBeenCalledTimes(1);
  });

  it('releases the batch if the extractor throws (H1)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');

    const run = vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') throw new Error('proxy start failed');
      return { value: { static: '', dynamic: '' } as T };
    });

    await runConsolidation(makeCtx(db, { run }));

    expect(countConsumedCandidates(db)).toBe(0);
  });

  it('isolates one failing persist so the rest of the batch persists and the pass completes (H2)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');

    const extraction = {
      memories: [
        { kind: 'fact', content: 'BOOM this memory fails to persist', scope: 'project' },
        { kind: 'fact', content: 'this good memory must survive the failure', scope: 'project' },
      ],
    };
    const { runner } = makeRunner(extraction);

    const resolveConflict = vi.fn(async (row: MemoryRow) => {
      if (row.content.includes('BOOM')) throw new Error('conflict resolution failed');
      return { superseded: [] as string[] };
    });
    const factGraph = { resolveConflict } as unknown as ConsolidationCtx['factGraph'];

    await runConsolidation(makeCtx(db, runner, { factGraph }));

    expect(resolveConflict).toHaveBeenCalledTimes(2);

    const good = db
      .prepare("SELECT COUNT(*) AS count FROM memories WHERE content LIKE '%good memory%' AND forgotten = 0")
      .get() as CountRow;
    expect(good.count).toBe(1);

    expect(countConsumedCandidates(db)).toBe(1);
  });

  it('tells the extractor about existing memories so it does not re-extract them', async () => {
    const id = crypto.randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, workspace, created_at, updated_at)
       VALUES (?, 'fact', 'project', ?, '', ?, ?, ?, ?)`,
    ).run(id, 'The bundler is Vite, not esbuild', id, WORKSPACE, now, now);
    seedCandidate(db, SESSION_ID, 'How is it built?', 'Vite bundles it.');

    const { runner, run } = makeRunner({ memories: [] });
    await runConsolidation(makeCtx(db, runner));

    const extractCall = run.mock.calls.find(([req]) => (req as MemorySubCallRequest).purpose === 'extract');
    expect(extractCall).toBeDefined();
    const prompt = (extractCall![0] as MemorySubCallRequest).prompt;
    expect(prompt).toContain('Already-stored memories');
    expect(prompt).toContain('The bundler is Vite, not esbuild');
  });

  it('stops claiming once the token budget is hit, leaving older-fitting turns for the next pass', async () => {
    const fortyPercent = 'x'.repeat(Math.floor(BUDGET_CHARS * 0.4));
    seedCandidate(db, SESSION_ID, 'q1', fortyPercent);
    seedCandidate(db, SESSION_ID, 'q2', fortyPercent);
    seedCandidate(db, SESSION_ID, 'q3', fortyPercent);

    const { runner } = makeRunner({ memories: [] });
    await runConsolidation(makeCtx(db, runner));

    expect(countConsumedCandidates(db)).toBe(2);
    const remaining = db
      .prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 0')
      .get() as CountRow;
    expect(remaining.count).toBe(1);
  });

  it('always claims one over-budget turn and clips its text so the prompt stays bounded', async () => {
    const huge = 'x'.repeat(BUDGET_CHARS * 2);
    seedCandidate(db, SESSION_ID, 'q', huge);

    const { runner, run } = makeRunner({ memories: [] });
    await runConsolidation(makeCtx(db, runner));

    expect(countConsumedCandidates(db)).toBe(1);

    const extractCall = run.mock.calls.find(([req]) => (req as MemorySubCallRequest).purpose === 'extract');
    const prompt = (extractCall![0] as MemorySubCallRequest).prompt;
    expect(prompt).toContain('[truncated]');
    expect(prompt.length).toBeLessThan(BUDGET_CHARS + 50_000);
  });

  it('reports the extracted memories with outcomes through onResult', async () => {
    seedCandidate(db, SESSION_ID, 'Which bundler?', 'esbuild.');

    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const results: ConsolidationExtractedMemory[][] = [];
    await runConsolidation(makeCtx(db, runner, { onResult: (r) => results.push(r) }));

    expect(results).toHaveLength(1);
    const out = results[0];
    expect(out).toHaveLength(1);
    expect(out?.[0]?.outcome).toBe('inserted');
    expect(out?.[0]?.content).toContain('esbuild');
  });
});
