import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { ProfileManager } from '../managers/profile-manager';
import {
  runConsolidation,
  mergePendingConsolidation,
  CANDIDATE_TOKEN_BUDGET,
  type ConsolidationCtx,
} from '../consolidation';
import type { ConsolidationPhaseEvent } from '@shared/types/consolidation';

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
    trigger: 'auto',
    onNoModel: () => {},
    ...overrides,
  };
}

/** Collect the ordered phase-event stream a pass emits, for sequence assertions. */
function makePhaseCollector(): { onPhase: (e: ConsolidationPhaseEvent) => void; events: ConsolidationPhaseEvent[] } {
  const events: ConsolidationPhaseEvent[] = [];
  return { onPhase: (e) => events.push(e), events };
}

/** The ordered `phase:status` pairs, e.g. ['claim:done', 'extract:active', …]. */
function sequence(events: ConsolidationPhaseEvent[]): string[] {
  return events.map((e) => `${e.phase}:${e.status}`);
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

  it('returns a terminal extracted result with outcomes and the manual trigger', async () => {
    seedCandidate(db, SESSION_ID, 'Which bundler?', 'esbuild.');

    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const result = await runConsolidation(makeCtx(db, runner, { trigger: 'manual' }));

    expect(result.status).toBe('extracted');
    expect(result.trigger).toBe('manual');
    expect(result.candidatesReviewed).toBe(1);
    expect(result.extracted).toHaveLength(1);
    expect(result.extracted[0]?.outcome).toBe('inserted');
    expect(result.extracted[0]?.content).toContain('esbuild');
    expect(result.failure).toBeUndefined();
  });
});

describe('runConsolidation — terminal-result guarantees (no silent failure)', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('returns status:empty when there are zero candidates, still running maintenance', async () => {
    const { runner } = makeRunner({ memories: [] });
    const { onPhase, events } = makePhaseCollector();
    const result = await runConsolidation(makeCtx(db, runner, { onPhase }));

    expect(result.status).toBe('empty');
    expect(result.candidatesReviewed).toBe(0);
    expect(result.extracted).toEqual([]);
    expect(sequence(events)).toContain('claim:done');
    expect(sequence(events)).toContain('maintain:done');
  });

  it('returns status:empty with skipped extract/persist/profiles when auto-extract is off', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const { runner, run } = makeRunner(ESBUILD_EXTRACTION);
    const { onPhase, events } = makePhaseCollector();

    const result = await runConsolidation(makeCtx(db, runner, { autoExtractEnabled: false, onPhase }));

    expect(result.status).toBe('empty');
    expect(run).not.toHaveBeenCalled();
    const seq = sequence(events);
    expect(seq).toContain('extract:skipped');
    expect(seq).toContain('persist:skipped');
    expect(seq).toContain('maintain:done');
    expect(seq).toContain('profiles:skipped');
  });

  it('returns failed/error with phase:extract when the extractor throws — and still runs maintenance', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const run = vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') throw new Error('proxy start failed');
      return { value: { static: '', dynamic: '' } as T };
    });
    const { onPhase, events } = makePhaseCollector();

    const result = await runConsolidation(makeCtx(db, { run }, { onPhase }));

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('error');
    expect(result.failure?.phase).toBe('extract');
    expect(result.failure?.detail).toContain('proxy start failed');
    // MAINTAIN must still run on the failure path (pure SQL, model-independent).
    expect(sequence(events)).toContain('maintain:done');
    expect(countConsumedCandidates(db)).toBe(0);
  });

  it('returns failed/no-model when no extraction model is available — and still runs maintenance', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const onNoModel = vi.fn();
    const run = vi.fn(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') return { value: null, failure: 'no-model' };
      return { value: { static: '', dynamic: '' } as T };
    });
    const { onPhase, events } = makePhaseCollector();

    const result = await runConsolidation(makeCtx(db, { run }, { onNoModel, onPhase }));

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('no-model');
    expect(result.failure?.phase).toBe('extract');
    expect(onNoModel).toHaveBeenCalledTimes(1);
    expect(sequence(events)).toContain('maintain:done');
    expect(countConsumedCandidates(db)).toBe(0);
  });

  it('keeps status:extracted (not failed) when only profile regeneration fails after a good persist', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const ctx = makeCtx(db, runner);
    const brokenProfile = {
      updateProfile: vi.fn(async () => {
        throw new Error('profiles boom');
      }),
    } as unknown as ConsolidationCtx['profileManager'];
    const { onPhase, events } = makePhaseCollector();

    const result = await runConsolidation({ ...ctx, profileManager: brokenProfile, onPhase });

    // Memories are already persisted, so the pass stays `extracted` with only a failed Profiles row.
    expect(result.status).toBe('extracted');
    expect(result.extracted).toHaveLength(1);
    expect(sequence(events)).toContain('profiles:failed');
  });

  it('never lets a thrown error escape: a poisoned claim resolves to a terminal failed/error result', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const ctx = makeCtx(db, runner);
    // Poison the write queue so claimCandidates throws before any phase completes — exercises the
    // top-level catch. The function is total: it must return a terminal result, not reject.
    const brokenQueue = {
      run: vi.fn(() => {
        throw new Error('write queue down');
      }),
    } as unknown as ConsolidationCtx['writeQueue'];

    const result = await runConsolidation({ ...ctx, writeQueue: brokenQueue });

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('error');
    expect(result.failure?.detail).toContain('write queue down');
  });

  it('emits the ordered phase sequence on a full successful pass', async () => {
    seedCandidate(db, SESSION_ID, 'Which bundler?', 'esbuild.');
    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const { onPhase, events } = makePhaseCollector();

    await runConsolidation(makeCtx(db, runner, { onPhase }));

    const seq = sequence(events);
    expect(seq[0]).toBe('claim:done');
    expect(seq).toContain('extract:active');
    expect(seq).toContain('extract:done');
    expect(seq).toContain('persist:active');
    expect(seq).toContain('persist:done');
    expect(seq).toContain('maintain:active');
    expect(seq).toContain('maintain:done');
    expect(seq).toContain('profiles:active');
    expect(seq).toContain('profiles:done');
    // Order invariant: claim before extract before persist before maintain before profiles.
    expect(seq.indexOf('extract:active')).toBeGreaterThan(seq.indexOf('claim:done'));
    expect(seq.indexOf('persist:active')).toBeGreaterThan(seq.indexOf('extract:done'));
    expect(seq.indexOf('maintain:active')).toBeGreaterThan(seq.indexOf('persist:done'));
    expect(seq.indexOf('profiles:active')).toBeGreaterThan(seq.indexOf('maintain:done'));
  });

  it('streams persist done/total as each extracted memory resolves', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const extraction = {
      memories: [
        { kind: 'fact', content: 'first durable fact about the build', scope: 'project' },
        { kind: 'fact', content: 'second durable fact about the runtime', scope: 'project' },
      ],
    };
    const { runner } = makeRunner(extraction);
    const { onPhase, events } = makePhaseCollector();

    await runConsolidation(makeCtx(db, runner, { onPhase }));

    const persistDone = events
      .filter((e) => e.phase === 'persist' && e.meta?.done !== undefined)
      .map((e) => e.meta?.done);
    expect(persistDone).toContain(1);
    expect(persistDone).toContain(2);
    const persistEvents = events.filter((e) => e.phase === 'persist');
    const last = persistEvents[persistEvents.length - 1];
    expect(last?.meta?.total).toBe(2);
  });
});

describe('mergePendingConsolidation — forceExtract survival (flag-loss fix)', () => {
  it('passes the incoming request through when nothing is pending', () => {
    const merged = mergePendingConsolidation(null, { reason: 'manual', forceExtract: true });
    expect(merged.reason).toBe('manual');
    expect(merged.forceExtract).toBe(true);
  });

  it('OR-keeps forceExtract when a manual run folds into an in-flight auto pass', () => {
    const merged = mergePendingConsolidation(
      { reason: 'idle' },
      { reason: 'manual', sessionId: undefined, forceExtract: true },
    );
    expect(merged.forceExtract).toBe(true);
  });

  it('keeps forceExtract when the existing pending slot already had it and the incoming did not', () => {
    const merged = mergePendingConsolidation(
      { reason: 'idle', forceExtract: true },
      { reason: 'idle' },
    );
    expect(merged.forceExtract).toBe(true);
  });

  it('broadens to a global idle pass for mismatched sessions while preserving forceExtract', () => {
    const merged = mergePendingConsolidation(
      { reason: 'switch', sessionId: 'a' },
      { reason: 'switch', sessionId: 'b', forceExtract: true },
    );
    expect(merged.reason).toBe('idle');
    expect(merged.sessionId).toBeUndefined();
    expect(merged.forceExtract).toBe(true);
  });

  it('omits forceExtract entirely when neither request forces it', () => {
    const merged = mergePendingConsolidation({ reason: 'idle' }, { reason: 'switch', sessionId: 'x' });
    expect(merged.forceExtract).toBeUndefined();
  });
});
