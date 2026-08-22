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
  reclaimExpiredClaims,
  mergePendingConsolidation,
  isExtractionResult,
  EXTRACTION_SCHEMA,
  EXTRACTION_SYSTEM_PROMPT,
  CANDIDATE_TOKEN_BUDGET,
  LEASE_TTL_MS,
  type ConsolidationCtx,
} from '../consolidation';
import { maybeVacuum, VACUUM_FREELIST_RATIO, VACUUM_MIN_PAGES } from '../dedup-decay';
import type { ConsolidationPhaseEvent } from '@shared/types/consolidation';
import { subCallSpy, type SubCallSpy } from './subcall-spy';

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

/** Stub runner: extract returns the supplied value, merge/conflict report none, profile is empty. */
function makeRunner(extractValue: unknown): { runner: MemorySubCallRunner; run: SubCallSpy } {
  const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
    if (req.purpose === 'extract') return { value: extractValue as T };
    if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } as T };
    return { value: { contradicts: false, merged_ids: [], content: '' } as T };
  });
  return { runner: { run }, run };
}

/** A nested object in a JSON-schema literal, failing loudly rather than widening to `undefined`. */
function schemaNode(node: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = node[key];
  if (typeof child !== 'object' || child === null) throw new Error(`schema has no object at '${key}'`);
  return child as Record<string, unknown>;
}

function makeCtx(
  db: DatabaseInstance,
  runner: MemorySubCallRunner,
  overrides: Omit<Partial<ConsolidationCtx>, 'sessionId'> & { sessionId?: string | undefined } = {},
): ConsolidationCtx {
  const writeQueue = new MemoryWriteQueue();
  // An explicit `sessionId: undefined` override must CLEAR the default, so the key is only set when
  // it resolves to a real id (exactOptionalPropertyTypes forbids writing undefined into it).
  const { sessionId: sessionOverride, ...rest } = overrides;
  const sessionId = 'sessionId' in overrides ? sessionOverride : SESSION_ID;
  return {
    db,
    writeQueue,
    runner,
    factGraph: new FactGraphManager(db, writeQueue, runner),
    profileManager: new ProfileManager(db, writeQueue, runner),
    instanceId: 'test-instance',
    reason: 'switch',
    workspace: WORKSPACE,
    autoExtractEnabled: true,
    trigger: 'auto',
    onNoModel: () => {},
    isDisposed: () => false,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...rest,
  };
}

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

    const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
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
    const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') return { value: null, failure: 'no-model' };
      return { value: { static: '', dynamic: '' } as T };
    });

    await runConsolidation(makeCtx(db, { run }, { onNoModel }));

    expect(countConsumedCandidates(db)).toBe(0);
    expect(onNoModel).toHaveBeenCalledTimes(1);
  });

  it('releases the batch if the extractor throws (H1)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');

    const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
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
    // runMaintenance calls sweepConflictChecks, so the stub must provide it.
    const factGraph = {
      resolveConflict,
      sweepConflictChecks: vi.fn(async () => 0),
    } as unknown as ConsolidationCtx['factGraph'];

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
    const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') throw new Error('proxy start failed');
      return { value: { static: '', dynamic: '' } as T };
    });
    const { onPhase, events } = makePhaseCollector();

    const result = await runConsolidation(makeCtx(db, { run }, { onPhase }));

    expect(result.status).toBe('failed');
    expect(result.failure?.kind).toBe('error');
    expect(result.failure?.phase).toBe('extract');
    // Maintain runs even on the failure path (pure SQL, model-independent).
    expect(sequence(events)).toContain('maintain:done');
    expect(countConsumedCandidates(db)).toBe(0);
  });

  it('returns failed/no-model when no extraction model is available — and still runs maintenance', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const onNoModel = vi.fn();
    const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
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

    // Memories already persisted → the pass stays 'extracted' despite the failed profile step.
    expect(result.status).toBe('extracted');
    expect(result.extracted).toHaveLength(1);
    expect(sequence(events)).toContain('profiles:failed');
  });

  it('never lets a thrown error escape: a poisoned claim resolves to a terminal failed/error result', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const ctx = makeCtx(db, runner);
    // Poison the write queue so claimCandidates throws before any phase completes — the function is
    // total, so it must return a terminal result, not reject.
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
    // claim < extract < persist < maintain < profiles.
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

interface LeaseRow {
  consumed: number;
  reprocessed: number;
  claimed_by: string | null;
  claimed_at: number | null;
}

function leaseRow(db: DatabaseInstance, id: string): LeaseRow {
  return db
    .prepare('SELECT consumed, reprocessed, claimed_by, claimed_at FROM memory_candidates WHERE id = ?')
    .get(id) as LeaseRow;
}

/**
 * Stamp a lease onto a candidate directly (simulates a claim held by another window) so tests
 * control claimed_by/claimed_at exactly. Absolute Date.now()-relative timestamps — reclaim reads
 * Date.now() itself, so no clock injection or fake timers.
 */
function stampClaim(db: DatabaseInstance, id: string, claimedBy: string, claimedAt: number | null): void {
  db.prepare('UPDATE memory_candidates SET consumed = 1, claimed_by = ?, claimed_at = ? WHERE id = ?').run(
    claimedBy,
    claimedAt,
    id,
  );
}

describe('consolidation leases — cross-window claim stamping + expiry reclaim (Slice 2)', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('claimCandidates stamps claimed_by = ctx.instanceId and a recent claimed_at on claimed rows', async () => {
    const id = seedCandidate(db, SESSION_ID, 'Which bundler?', 'esbuild.');
    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const before = Date.now();

    await runConsolidation(makeCtx(db, runner, { instanceId: 'window-A' }));

    const after = Date.now();
    const row = leaseRow(db, id);
    expect(row.consumed).toBe(1);
    expect(row.claimed_by).toBe('window-A');
    expect(row.claimed_at).not.toBeNull();
    // claimed_at is a real wall-clock stamp taken within the pass window.
    expect(row.claimed_at!).toBeGreaterThanOrEqual(before);
    expect(row.claimed_at!).toBeLessThanOrEqual(after);
  });

  it('releaseCandidates clears the lease (claimed_by/claimed_at NULL) and restores consumed=0 on a transient failure', async () => {
    const id = seedCandidate(db, SESSION_ID, 'q', 'a');
    // Transient extraction failure after the claim stamped a lease → the batch is released.
    const run = subCallSpy(async <T,>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> => {
      if (req.purpose === 'extract') return { value: null, failure: 'transient' };
      if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } as T };
      return { value: { contradicts: false, merged_ids: [], content: '' } as T };
    });

    await runConsolidation(makeCtx(db, { run }, { instanceId: 'window-A' }));

    const row = leaseRow(db, id);
    // Release undoes the reservation and wipes the lease so the row is fully re-claimable.
    expect(row.consumed).toBe(0);
    expect(row.reprocessed).toBe(0);
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it('reclaimExpiredClaims reclaims a legacy strand (consumed=1, reprocessed=0, claimed_at IS NULL)', async () => {
    const id = seedCandidate(db, SESSION_ID, 'q', 'a');
    // Legacy strand from a pre-lease build: consumed but no claimed_by/claimed_at stamp.
    db.prepare('UPDATE memory_candidates SET consumed = 1, reprocessed = 0, claimed_by = NULL, claimed_at = NULL WHERE id = ?').run(id);

    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const n = await reclaimExpiredClaims(makeCtx(db, runner, { instanceId: 'window-B' }));

    expect(n).toBe(1);
    const row = leaseRow(db, id);
    expect(row.consumed).toBe(0);
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
    expect(row.reprocessed).toBe(0);
  });

  it('reclaimExpiredClaims reclaims an EXPIRED claim (claimed_at = now - LEASE_TTL_MS - 1)', async () => {
    const id = seedCandidate(db, SESSION_ID, 'q', 'a');
    stampClaim(db, id, 'instance-A', Date.now() - LEASE_TTL_MS - 1);

    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const n = await reclaimExpiredClaims(makeCtx(db, runner, { instanceId: 'window-B' }));

    expect(n).toBe(1);
    const row = leaseRow(db, id);
    expect(row.consumed).toBe(0);
    expect(row.claimed_by).toBeNull();
    expect(row.claimed_at).toBeNull();
  });

  it('reclaimExpiredClaims does NOT disturb a FRESH claim (claimed_at = now) — count 0, row untouched', async () => {
    const id = seedCandidate(db, SESSION_ID, 'q', 'a');
    const claimedAt = Date.now();
    stampClaim(db, id, 'instance-A', claimedAt);

    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const n = await reclaimExpiredClaims(makeCtx(db, runner, { instanceId: 'window-B' }));

    expect(n).toBe(0);
    const row = leaseRow(db, id);
    // A live claim within TTL survives untouched — the core anti-double-extraction guarantee.
    expect(row.consumed).toBe(1);
    expect(row.claimed_by).toBe('instance-A');
    expect(row.claimed_at).toBe(claimedAt);
  });

  it('reclaimExpiredClaims does NOT touch a COMMITTED row (reprocessed=1) even with an ancient claimed_at', async () => {
    const id = seedCandidate(db, SESSION_ID, 'q', 'a');
    // reprocessed=1 is terminal, so an ancient claimed_at must not matter.
    stampClaim(db, id, 'instance-A', Date.now() - LEASE_TTL_MS - 10_000);
    db.prepare('UPDATE memory_candidates SET reprocessed = 1 WHERE id = ?').run(id);

    const { runner } = makeRunner(ESBUILD_EXTRACTION);
    const n = await reclaimExpiredClaims(makeCtx(db, runner, { instanceId: 'window-B' }));

    expect(n).toBe(0);
    const row = leaseRow(db, id);
    expect(row.consumed).toBe(1);
    expect(row.reprocessed).toBe(1);
    expect(row.claimed_by).toBe('instance-A');
  });

  it('cross-window exactly-once: instance-B reclaims instance-A\'s expired claim, then processes it once', async () => {
    const id = seedCandidate(db, SESSION_ID, 'Which bundler?', 'esbuild.');
    // instance-A claimed this batch then crashed mid-extraction; its lease is now expired.
    stampClaim(db, id, 'instance-A', Date.now() - LEASE_TTL_MS - 1);

    const { runner, run } = makeRunner(ESBUILD_EXTRACTION);
    // instance-B's pass reclaims A's expired batch first, then claims + extracts it once.
    const result = await runConsolidation(makeCtx(db, runner, { instanceId: 'instance-B' }));

    const extractCalls = run.mock.calls.filter(([req]) => (req as MemorySubCallRequest).purpose === 'extract');
    expect(extractCalls).toHaveLength(1);
    expect(result.status).toBe('extracted');
    expect(countLiveMemories(db, 'project')).toBe(1);

    const row = leaseRow(db, id);
    // Committed under B's ownership; A's stale lease is gone.
    expect(row.consumed).toBe(1);
    expect(row.reprocessed).toBe(1);
    expect(row.claimed_by).toBe('instance-B');
    expect(row.claimed_at).not.toBeNull();
    expect(row.claimed_at!).toBeGreaterThan(Date.now() - LEASE_TTL_MS);
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
      { reason: 'manual', forceExtract: true },
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

// Builds a store that genuinely exceeds BOTH gates (freelist/page ratio > 0.25 AND page_count >
// 2500), asserts the precondition, then proves maybeVacuum runs a real VACUUM that shrinks the free
// list — never a mocked condition.
describe('maybeVacuum', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  function freelist(db: DatabaseInstance): number {
    return Number(db.pragma('freelist_count'));
  }
  function pageCount(db: DatabaseInstance): number {
    return Number(db.pragma('page_count'));
  }

  it('runs VACUUM and shrinks the free list once BOTH thresholds are genuinely met', async () => {
    // ~4000 rows of ~4KB each grow the file well past VACUUM_MIN_PAGES; deleting ~90% piles freed
    // pages onto the free list. One transaction keeps setup fast and avoids per-statement WAL churn.
    const bigContent = 'x'.repeat(4096);
    const ids: string[] = [];
    db.transaction(() => {
      const insert = db.prepare(
        `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, created_at, updated_at)
         VALUES (?, 'fact', 'project', ?, ?, ?, ?, ?)`,
      );
      const now = Date.now();
      for (let i = 0; i < 4000; i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        // Unique content per row so content_hash differs; the suffix keeps each row ~4KB.
        insert.run(id, `${i}-${bigContent}`, `hash-${i}`, id, now, now);
      }
    });

    db.transaction(() => {
      const del = db.prepare('DELETE FROM memories WHERE id = ?');
      for (let i = 0; i < ids.length; i++) {
        if (i % 10 !== 0) del.run(ids[i]); // keep every 10th row
      }
    });

    // Assert BOTH thresholds are met first, so the VACUUM below fires under the genuine gate.
    const freelistBefore = freelist(db);
    const pagesBefore = pageCount(db);
    expect(pagesBefore).toBeGreaterThan(VACUUM_MIN_PAGES);
    expect(freelistBefore / pagesBefore).toBeGreaterThan(VACUUM_FREELIST_RATIO);

    // A queue without a db serializes + calls fn (db.exec('VACUUM')) outside any transaction.
    const writeQueue = new MemoryWriteQueue();
    await maybeVacuum(db, writeQueue);

    // VACUUM ran: free list reclaimed to ~0 and the file shrinks.
    const freelistAfter = freelist(db);
    const pagesAfter = pageCount(db);
    expect(freelistAfter).toBeLessThan(freelistBefore);
    expect(freelistAfter).toBe(0);
    expect(pagesAfter).toBeLessThan(pagesBefore);
  });

  it('does NOT run VACUUM when the page-count floor is not met (small DB with high ratio)', async () => {
    const ids: string[] = [];
    db.transaction(() => {
      const insert = db.prepare(
        `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, created_at, updated_at)
         VALUES (?, 'fact', 'project', ?, ?, ?, ?, ?)`,
      );
      const now = Date.now();
      for (let i = 0; i < 200; i++) {
        const id = crypto.randomUUID();
        ids.push(id);
        insert.run(id, `${i}-${'y'.repeat(200)}`, `h-${i}`, id, now, now);
      }
    });
    db.transaction(() => {
      const del = db.prepare('DELETE FROM memories WHERE id = ?');
      for (const id of ids) del.run(id);
    });

    const pagesBefore = pageCount(db);
    expect(pagesBefore).toBeLessThanOrEqual(VACUUM_MIN_PAGES); // floor not met
    const freelistBefore = freelist(db);

    const writeQueue = new MemoryWriteQueue();
    await maybeVacuum(db, writeQueue);

    // maybeVacuum returned early: free list not compacted to 0.
    expect(freelist(db)).toBe(freelistBefore);
    expect(pageCount(db)).toBe(pagesBefore);
  });
});

// No extraction shape can leave a batch stuck at consumed=1/reprocessed=0. Every claimed batch ends
// either COMMITTED (consumed=1, reprocessed=1) or RELEASED (consumed=0); a malformed shape never
// throws past releaseCandidates and never inserts a row.

function candidateCounts(db: DatabaseInstance): { total: number; consumed: number; committed: number; stranded: number } {
  const total = (db.prepare('SELECT COUNT(*) AS count FROM memory_candidates').get() as CountRow).count;
  const consumed = (db.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 1').get() as CountRow).count;
  const committed = (db.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 1 AND reprocessed = 1').get() as CountRow).count;
  // Stranded = the forbidden state: claimed but not committed.
  const stranded = (db.prepare('SELECT COUNT(*) AS count FROM memory_candidates WHERE consumed = 1 AND reprocessed = 0').get() as CountRow).count;
  return { total, consumed, committed, stranded };
}

function countAllLiveMemories(db: DatabaseInstance): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM memories WHERE is_latest = 1 AND forgotten = 0').get() as CountRow).count;
}

describe('runConsolidation — C2 hostile extraction shapes never strand a batch', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  // Each shape that fails the isExtractionResult guard routes down release-and-fail: consumed=0,
  // status 'failed', zero rows inserted, no strand.
  const invalidShapes: Array<{ name: string; value: unknown }> = [
    { name: 'memories is a string, not an array', value: { memories: 'x' } },
    { name: 'memories key missing entirely', value: {} },
    { name: 'an item is missing content and scope', value: { memories: [{ kind: 'fact' }] } },
    { name: 'the whole value is null-ish object', value: { not: 'memories' } },
  ];

  for (const shape of invalidShapes) {
    it(`releases (never strands) on an invalid shape: ${shape.name}`, async () => {
      seedCandidate(db, SESSION_ID, 'q1', 'a1');
      seedCandidate(db, SESSION_ID, 'q2', 'a2');

      const { runner } = makeRunner(shape.value);
      const result = await runConsolidation(makeCtx(db, runner));

      // Ends 'failed' (the release path), never silently 'empty'.
      expect(result.status).toBe('failed');

      const counts = candidateCounts(db);
      expect(counts.stranded).toBe(0);
      expect(counts.consumed).toBe(0);
      expect(counts.committed).toBe(0);
      expect(countAllLiveMemories(db)).toBe(0);
    });
  }

  it('a 25-item over-cap array is a VALID shape: it commits without stranding (maxItems is schema-side)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');

    // 25 well-formed items pass isExtractionResult (maxItems is schema-enforced at the model
    // boundary, not by the runtime guard), so the pass persists + commits without stranding.
    const memories = Array.from({ length: 25 }, (_v, i) => ({
      kind: 'fact',
      content: `hostile-cap fact number ${i} about the build pipeline`,
      scope: 'project',
    }));
    const { runner } = makeRunner({ memories });

    const result = await runConsolidation(makeCtx(db, runner));

    expect(result.status).toBe('extracted');
    const counts = candidateCounts(db);
    expect(counts.stranded).toBe(0);
    expect(counts.committed).toBe(1);
    expect(result.extracted.length).toBe(25);
  });

  it('a valid-shape observation is a per-item invalid outcome but the batch STILL commits (two rejection layers)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');

    // Valid shape → passes isExtractionResult and enters persist, where toNewMemoryFields rejects
    // kind==='observation' → outcome 'invalid'. The batch still commits.
    const { runner } = makeRunner({
      memories: [{ kind: 'observation', content: 'the extractor tried to smuggle an observation', scope: 'global' }],
    });

    const result = await runConsolidation(makeCtx(db, runner));

    // The batch ran the persist loop (one item reviewed), but the item's outcome is 'invalid'.
    expect(result.status).toBe('extracted');
    expect(result.extracted).toHaveLength(1);
    expect(result.extracted[0]?.outcome).toBe('invalid');
    const counts = candidateCounts(db);
    expect(counts.stranded).toBe(0);
    expect(counts.committed).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS count FROM memories WHERE kind = 'observation'").get() as CountRow).count).toBe(0);
  });

  it('the isExtractionResult guard itself: accepts a well-formed shape, rejects the hostile ones', () => {
    expect(isExtractionResult({ memories: [{ kind: 'fact', content: 'c', scope: 'project' }] })).toBe(true);
    expect(isExtractionResult({ memories: [] })).toBe(true);
    expect(isExtractionResult({ memories: 'x' })).toBe(false);
    expect(isExtractionResult({})).toBe(false);
    expect(isExtractionResult({ memories: [{ kind: 'fact' }] })).toBe(false);
    expect(isExtractionResult(null)).toBe(false);
  });
});

describe('runConsolidation — C2 committed flag: a throw between claim and commit releases the batch', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('a persist pipeline throw for EVERY item still commits (per-item isolation) — no strand', async () => {
    // Persist-level throws are isolated per item (outcome 'invalid') and the batch commits; the
    // committed-flag outer catch (next test) covers a throw OUTSIDE that loop.
    seedCandidate(db, SESSION_ID, 'q1', 'a1');
    const { runner } = makeRunner({ memories: [{ kind: 'fact', content: 'will boom in conflict resolution', scope: 'project' }] });
    const factGraph = {
      resolveConflict: vi.fn(async () => {
        throw new Error('conflict resolution failed');
      }),
      sweepConflictChecks: vi.fn(async () => 0),
    } as unknown as ConsolidationCtx['factGraph'];

    const result = await runConsolidation(makeCtx(db, runner, { factGraph }));

    expect(candidateCounts(db).stranded).toBe(0);
    // The persist threw but was isolated as outcome 'invalid'; the batch still commits.
    expect(result.status).toBe('extracted');
    expect(result.extracted[0]?.outcome).toBe('invalid');
    expect(candidateCounts(db).committed).toBe(1);
  });

  it('a throw AFTER claim but BEFORE commit (in commitCandidates) is released by the outer catch (consumed=0)', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');
    seedCandidate(db, SESSION_ID, 'q2', 'a2');
    const { runner } = makeRunner(ESBUILD_EXTRACTION);

    // Runs normally until commitCandidates fires the UPDATE ... SET reprocessed = 1, then throws —
    // a crash after the batch was claimed + persisted but before the commit marker lands. The batch
    // must be RELEASED to consumed=0, not stranded.
    const realQueue = new MemoryWriteQueue();
    let committedThrown = false;
    const brokenQueue = {
      run: vi.fn(<T>(fn: () => T | Promise<T>): Promise<T> => {
        const src = fn.toString();
        if (!committedThrown && src.includes('reprocessed = 1')) {
          committedThrown = true;
          return Promise.reject(new Error('crash during commit marker'));
        }
        return realQueue.run(fn);
      }),
    } as unknown as ConsolidationCtx['writeQueue'];

    const result = await runConsolidation(makeCtx(db, runner, { writeQueue: brokenQueue }));

    // Outer catch fired: status failed, batch fully released (consumed=0), not stranded.
    expect(result.status).toBe('failed');
    const counts = candidateCounts(db);
    expect(counts.stranded).toBe(0);
    expect(counts.consumed).toBe(0);
    expect(counts.committed).toBe(0);
    expect(committedThrown).toBe(true);
  });
});

describe('runConsolidation — C6 session-scope stamping (never a NULL-session session row)', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  /** The invariant: no session-scope row may have a NULL session_id. */
  function nullSessionRows(db: DatabaseInstance): number {
    return (db.prepare("SELECT COUNT(*) AS count FROM memories WHERE scope = 'session' AND session_id IS NULL").get() as CountRow).count;
  }

  it('an idle (sessionless) pass with a single-session batch stamps session-scope items with that session id', async () => {
    // Both candidates share a session, so an idle pass (ctx.sessionId undefined) resolves the batch's
    // unambiguous session and stamps scope='session' extractions with it.
    seedCandidate(db, 'sess-solo', 'q1', 'a1');
    seedCandidate(db, 'sess-solo', 'q2', 'a2');

    const { runner } = makeRunner({
      memories: [{ kind: 'episode', content: 'currently wiring the session stamping path', scope: 'session' }],
    });
    const result = await runConsolidation(makeCtx(db, runner, { sessionId: undefined, reason: 'idle' }));

    expect(result.status).toBe('extracted');
    expect(nullSessionRows(db)).toBe(0);
    const row = db.prepare("SELECT session_id FROM memories WHERE scope = 'session' AND is_latest = 1").get() as { session_id: string | null };
    expect(row.session_id).toBe('sess-solo');
  });

  it('a MIXED-session idle batch rejects session-scope items as invalid (no NULL-session row)', async () => {
    // Different sessions → uniqueNonNullSession returns null → the session-scope extraction has no
    // resolvable session → toNewMemoryFields returns null → outcome 'invalid'.
    seedCandidate(db, 'sess-A', 'q1', 'a1');
    seedCandidate(db, 'sess-B', 'q2', 'a2');

    const { runner } = makeRunner({
      memories: [{ kind: 'episode', content: 'ambiguous-session episode that must be rejected', scope: 'session' }],
    });
    const result = await runConsolidation(makeCtx(db, runner, { sessionId: undefined, reason: 'idle' }));

    // Batch commits (valid shape), but the session-scope item is rejected — no row.
    expect(nullSessionRows(db)).toBe(0);
    expect(result.extracted[0]?.outcome).toBe('invalid');
    expect((db.prepare("SELECT COUNT(*) AS count FROM memories WHERE scope = 'session'").get() as CountRow).count).toBe(0);
    expect(candidateCounts(db).stranded).toBe(0);
  });

  it('a session-scoped pass (ctx.sessionId defined) binds session-scope items to ctx.sessionId', async () => {
    seedCandidate(db, SESSION_ID, 'q', 'a');
    const { runner } = makeRunner({
      memories: [{ kind: 'episode', content: 'a session episode for the explicit session pass', scope: 'session' }],
    });

    await runConsolidation(makeCtx(db, runner)); // makeCtx defaults sessionId = SESSION_ID

    expect(nullSessionRows(db)).toBe(0);
    const row = db.prepare("SELECT session_id FROM memories WHERE scope = 'session' AND is_latest = 1").get() as { session_id: string | null };
    expect(row.session_id).toBe(SESSION_ID);
  });
});

describe('EXTRACTION_SCHEMA + prompt (C10)', () => {
  it('caps memories at maxItems 10, drops forget_after, and removes observation from the kind enum', () => {
    const props = schemaNode(EXTRACTION_SCHEMA.properties as Record<string, unknown>, 'memories');
    expect(props.maxItems).toBe(10);

    const itemProps = schemaNode(schemaNode(props, 'items'), 'properties');
    expect(itemProps.forget_after).toBeUndefined();
    expect((itemProps.kind as { enum: string[] }).enum).toEqual(['fact', 'preference', 'episode']);
    expect((itemProps.kind as { enum: string[] }).enum).not.toContain('observation');
  });

  it('the system prompt drops observation and states the hard cap + provenance rule', () => {
    expect(EXTRACTION_SYSTEM_PROMPT).not.toContain("'observation'");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("'fact'|'preference'|'episode'");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain('at most 10');
    expect(EXTRACTION_SYSTEM_PROMPT.toLowerCase()).toContain('never speculation');
  });
});

describe('loadExistingMemoriesForExtraction — FTS relevance surfaces an OLD row recency would miss (C10)', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  /** Live project fact with an explicit updated_at, to control the recency window. */
  function seedFact(content: string, updatedAt: number): void {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, workspace, is_latest, forgotten, created_at, updated_at)
       VALUES (?, 'fact', 'project', ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(id, content, id, id, WORKSPACE, updatedAt, updatedAt);
  }

  it('primes the prompt with an FTS-relevant OLD fact that the most-recent-40 window would drop', async () => {
    const OLD = 1_000_000_000_000;
    // An OLD fact lexically relevant to the incoming batch.
    seedFact('The event bus uses a kafka broker for streaming', OLD);
    // 45 recent but irrelevant facts overflow the most-recent-40 window, so pure recency would drop
    // the relevant old kafka fact.
    for (let i = 0; i < 45; i++) seedFact(`recent unrelated note about widget color ${i}`, OLD + 1_000_000 + i);

    seedCandidate(db, SESSION_ID, 'How does the kafka broker route events?', 'The kafka broker streams them.');

    const { runner, run } = makeRunner({ memories: [] });
    await runConsolidation(makeCtx(db, runner));

    const extractCall = run.mock.calls.find(([req]) => (req as MemorySubCallRequest).purpose === 'extract');
    const prompt = (extractCall![0] as MemorySubCallRequest).prompt;
    // The old relevant fact is present despite 45 newer rows — FTS relevance, not recency, drives it.
    expect(prompt).toContain('Already-stored memories');
    expect(prompt).toContain('kafka broker for streaming');
  });
});

describe('runConsolidation — C11 disposed guard', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
  });

  it('a post-dispose pass (isDisposed:()=>true) returns immediately without claiming or extracting', async () => {
    seedCandidate(db, SESSION_ID, 'q1', 'a1');
    seedCandidate(db, SESSION_ID, 'q2', 'a2');

    const { runner, run } = makeRunner(ESBUILD_EXTRACTION);
    const result = await runConsolidation(makeCtx(db, runner, { isDisposed: () => true }));

    expect(result.status).toBe('empty');
    // Nothing claimed, extractor never called, no row written — the guard short-circuits early.
    expect(countConsumedCandidates(db)).toBe(0);
    expect(run).not.toHaveBeenCalled();
    expect(countAllLiveMemories(db)).toBe(0);
  });
});
