import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { createTestMemoryDb } from './test-helpers';
import { createDatabaseWrapper, runMigrations } from '../database';
import { subCallSpy, type SubCallImpl, type SubCallSpy } from './subcall-spy';
import { MemoryWriteQueue } from '../write-queue';
import { ProfileManager, PROFILE_SYSTEM_PROMPT } from '../managers/profile-manager';
import { normalizedContentHash } from '../types';
import type { DatabaseInstance, MemoryRow } from '../types';
import type { MemorySubCallRequest } from '../subcall-runner';
import { EPISODE_TTL_MS, applyDecaySweep, promoteEpisodes, purgeForgottenRows } from '../dedup-decay';
import { RUBRIC_VERSION } from '../rubric';
import {
  AUDIT_BATCH_MAX_MEMORIES,
  AUDIT_BATCH_MAX_TOKENS,
  AUDIT_LEASE_MS,
  AUDIT_OUTPUT_TOKENS_PER_BATCH,
  AUDIT_OUTPUT_TOKENS_PER_MEMORY,
  AUDIT_PROFILE_OUTPUT_TOKENS,
  applyAuditDecisions,
  beginAuditRun,
  buildAuditBatches,
  estimateAudit,
  estimateCallInputTokens,
  getAuditState,
  getAuditSummary,
  gradesToProposals,
  renderAuditMemory,
  retireSessionReverts,
  revertAuditRun,
  runAudit,
  type AuditFileTracker,
  type AuditRunDeps,
} from '../audit';
import { QUALITY_AUDIT_FORGET_REASON, type MemoryAuditModel, type MemoryAuditProgress } from '@shared/types/memory-audit';

const WS_A = '/ws/alpha';
const WS_B = '/ws/beta';
const HOLDER = 'window-1';

interface SeedOpts {
  id?: string;
  kind?: string;
  scope?: string;
  content?: string;
  title?: string | null;
  workspace?: string | null;
  sessionId?: string | null;
  rootId?: string | null;
  parentId?: string | null;
  isLatest?: number;
  forgotten?: number;
  forgetReason?: string | null;
  forgetAfter?: number | null;
  pinned?: number;
  sourceCount?: number;
  accessCount?: number;
  filesRead?: string[];
  createdAt?: number;
}

function seed(db: DatabaseInstance, o: SeedOpts = {}): string {
  const id = o.id ?? crypto.randomUUID();
  const content = o.content ?? `memory ${id}`;
  const createdAt = o.createdAt ?? 1_700_000_000_000;
  db.prepare(
    `INSERT INTO memories (id, kind, scope, content, title, content_hash, root_id, parent_id, is_latest, forgotten, forget_reason,
       forget_after, pinned, source_count, access_count, session_id, workspace, files_read, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.kind ?? 'fact',
    o.scope ?? 'project',
    content,
    o.title ?? null,
    normalizedContentHash(content),
    o.rootId === undefined ? id : o.rootId,
    o.parentId ?? null,
    o.isLatest ?? 1,
    o.forgotten ?? 0,
    o.forgetReason ?? null,
    o.forgetAfter ?? null,
    o.pinned ?? 0,
    o.sourceCount ?? 1,
    o.accessCount ?? 0,
    o.sessionId ?? null,
    o.workspace === undefined ? WS_A : o.workspace,
    JSON.stringify(o.filesRead ?? []),
    createdAt,
    createdAt,
  );
  return id;
}

function row(db: DatabaseInstance, id: string): MemoryRow {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow;
}

function snapshotStore(db: DatabaseInstance): string {
  return JSON.stringify([
    db.prepare('SELECT * FROM memories ORDER BY id').all(),
    db.prepare('SELECT * FROM memory_profile ORDER BY scope, workspace, section').all(),
  ]);
}

type Grade = { verdict: string; targetScope?: string; targetWorkspace?: string; reason?: string };

/** Ids of the memories rendered into a grading prompt. */
function promptIds(req: MemorySubCallRequest): string[] {
  const lines = req.prompt.split('\nMemories:\n')[1]?.split('\n') ?? [];
  return lines.map(l => (JSON.parse(l) as { id: string }).id);
}

/** A runner that grades each memory from `grades` (missing ids omitted) and rewrites profiles to `profile`. */
function scriptedRunner(grades: Record<string, Grade>, profile?: { static: string; dynamic: string }): SubCallSpy {
  return subCallSpy((async (req: MemorySubCallRequest) => {
    if (req.systemPrompt === PROFILE_SYSTEM_PROMPT) return { value: profile ?? null, ...(profile ? {} : { failure: 'transient' }) };
    const out = promptIds(req)
      .filter(id => grades[id])
      .map(id => ({ id, reason: 'r', ...grades[id] }));
    return { value: { grades: out } };
  }) as SubCallImpl);
}

function fakeTracker() {
  return {
    removeObservation: vi.fn<AuditFileTracker['removeObservation']>(),
    trackObservation: vi.fn<AuditFileTracker['trackObservation']>(),
  };
}

describe('memory quality audit', () => {
  let db: DatabaseInstance;
  let writeQueue: MemoryWriteQueue;
  let profileManager: ProfileManager;

  const deps = (runner: SubCallSpy, holder = HOLDER): AuditRunDeps => ({
    db,
    writeQueue,
    runner: { run: runner },
    profileManager,
    holder,
    knownWorkspaces: [WS_A, WS_B],
  });

  const state = (holder = HOLDER, model: MemoryAuditModel | null = null) => getAuditState({ db, profileManager }, holder, model, [WS_A, WS_B]);

  async function audit(runner: SubCallSpy): Promise<string> {
    const d = deps(runner);
    const plan = await beginAuditRun(d);
    expect(plan).not.toBeNull();
    const outcome = await runAudit(d, plan!, new AbortController().signal, () => {});
    expect(outcome).toEqual({ status: 'completed' });
    return plan!.runId;
  }

  function proposals(runId: string): Array<{ id: string; memory_id: string | null; action: string; status: string; target_workspace: string | null; decided_at: number | null }> {
    return db.prepare('SELECT * FROM memory_audit_proposals WHERE run_id = ? ORDER BY created_at, rowid').all(runId) as never;
  }

  function proposalFor(runId: string, memoryId: string): string {
    const p = proposals(runId).find(x => x.memory_id === memoryId);
    expect(p).toBeDefined();
    return p!.id;
  }

  beforeEach(async () => {
    db = await createTestMemoryDb();
    writeQueue = new MemoryWriteQueue(db);
    profileManager = new ProfileManager(db, writeQueue, { run: scriptedRunner({}) });
  });

  describe('migration v5', () => {
    it('adds the audit tables and the (run_id, status) index onto a v4 database, keeping its rows', () => {
      const v4 = createDatabaseWrapper(new DatabaseSync(':memory:'));
      runMigrations(v4);
      v4.exec('DROP TABLE memory_audit_proposals; DROP TABLE memory_audit_runs; DELETE FROM schema_version WHERE version = 5');
      const kept = seed(v4, { content: 'survives the migration' });
      runMigrations(v4);
      expect(row(v4, kept).content).toBe('survives the migration');
      const tables = (v4.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'memory_audit_%' ORDER BY name").all() as Array<{ name: string }>).map(t => t.name);
      expect(tables).toEqual(['memory_audit_proposals', 'memory_audit_runs']);
      const idx = (v4.prepare("PRAGMA index_info('idx_audit_proposals_run_status')").all() as Array<{ name: string }>).map(c => c.name);
      expect(idx).toEqual(['run_id', 'status']);
      expect((v4.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number }).v).toBe(5);
      v4.close();
    });
  });

  describe('batching', () => {
    it('caps a batch at 20 memories and splits groups by (workspace, scope, kind)', () => {
      for (let i = 0; i < 25; i++) seed(db, { kind: 'fact', content: `fact ${i}` });
      seed(db, { kind: 'preference', content: 'pref' });
      seed(db, { kind: 'fact', content: 'other ws', workspace: WS_B });
      const rows = db.prepare("SELECT * FROM memories ORDER BY COALESCE(workspace, ''), scope, kind, created_at, id").all() as MemoryRow[];
      const batches = buildAuditBatches(rows);
      expect(batches.map(b => b.rows.length)).toEqual([20, 5, 1, 1]);
      for (const b of batches) expect(new Set(b.rows.map(r => `${r.workspace}|${r.scope}|${r.kind}`)).size).toBe(1);
    });

    it('caps a batch at 6k rendered tokens', () => {
      for (let i = 0; i < AUDIT_BATCH_MAX_MEMORIES; i++) seed(db, { content: `${i} ${'x'.repeat(1400)}` });
      const batches = buildAuditBatches(db.prepare('SELECT * FROM memories ORDER BY created_at, id').all() as MemoryRow[]);
      expect(batches.length).toBe(2);
      for (const b of batches) expect(b.tokens).toBeLessThanOrEqual(AUDIT_BATCH_MAX_TOKENS);
      // Content is rendered capped at 1,200 chars.
      expect(JSON.parse(batches[0]!.rendered[0]!).content).toHaveLength(1200);
    });

    it('renders at most five facts and five distinct files per memory', () => {
      const id = seed(db, { filesRead: ['a', 'b', 'c', 'd'] });
      const items = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `f${i}`));
      db.prepare('UPDATE memories SET facts = ?, files_modified = ? WHERE id = ?').run(items(7), JSON.stringify(['a', 'x', 'y', 'z']), id);
      const rendered = JSON.parse(renderAuditMemory(row(db, id))) as { facts: string[]; files: string[] };
      expect(rendered.facts).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
      expect(rendered.files).toEqual(['a', 'b', 'c', 'd', 'x']);
    });
  });

  describe('estimate', () => {
    const model: MemoryAuditModel = { provider: 'anthropic', id: 'haiku', inputPerMTok: 1, outputPerMTok: 5, dollarBilled: false };

    it('prices exactly the calls a run makes, over eligible rows only', async () => {
      seed(db, { kind: 'fact' });
      seed(db, { kind: 'preference', scope: 'global', workspace: null });
      seed(db, { kind: 'episode' });
      seed(db, { kind: 'observation' });
      seed(db, { kind: 'note' });
      seed(db, { kind: 'fact', pinned: 1 });
      seed(db, { kind: 'fact', forgotten: 1, forgetReason: 'user_forget' });
      seed(db, { kind: 'fact', isLatest: 0 });
      await profileManager.setProfileSection('global', '', 'static', 'likes tea');
      const est = estimateAudit({ db, profileManager }, [WS_A, WS_B], model);

      const runner = scriptedRunner({}, { static: 'likes tea', dynamic: '' });
      await audit(runner);
      const calls = runner.mock.calls.map(([req]) => req);
      expect(est).toMatchObject({ memoryCount: 4, profileCount: 1, batchCount: calls.length - 1, unpriced: false });
      expect(est.inputTokens).toBe(calls.reduce((sum, req) => sum + estimateCallInputTokens(req.systemPrompt, req.schema, req.prompt), 0));
      expect(est.outputTokens).toBe(
        AUDIT_OUTPUT_TOKENS_PER_MEMORY * 4 + AUDIT_OUTPUT_TOKENS_PER_BATCH * est.batchCount + AUDIT_PROFILE_OUTPUT_TOKENS,
      );
      expect(est.costUsd).toBeCloseTo((est.inputTokens * 1 + est.outputTokens * 5) / 1_000_000, 12);
      expect(est.model).toEqual(model);
    });

    it('counts the known-workspace list in every grading call', () => {
      seed(db, { kind: 'fact' });
      const one = estimateAudit({ db, profileManager }, [WS_A], model).inputTokens;
      const three = estimateAudit({ db, profileManager }, [WS_A, WS_B, '/ws/gamma/with/a/long/path'], model).inputTokens;
      expect(three).toBeGreaterThan(one);
    });

    it('reports an unpriced model as unpriced rather than $0, and no model as no cost', () => {
      seed(db);
      const free = estimateAudit({ db, profileManager }, [WS_A], { ...model, inputPerMTok: 0, outputPerMTok: 0 });
      expect(free).toMatchObject({ unpriced: true, costUsd: null });
      expect(estimateAudit({ db, profileManager }, [WS_A], null)).toMatchObject({ model: null, unpriced: false, costUsd: null });
    });
  });

  describe('grade validation', () => {
    it('ignores foreign ids, keeps missing ids and verdicts invalid for the kind, and returns the DB spelling', () => {
      const fact = row(db, seed(db, { kind: 'fact' }));
      const pref = row(db, seed(db, { kind: 'preference' }));
      const obs = row(db, seed(db, { kind: 'observation' }));
      const obsGlobal = row(db, seed(db, { kind: 'observation' }));
      const silent = row(db, seed(db, { kind: 'fact' }));
      const noop = row(db, seed(db, { kind: 'fact', workspace: WS_B }));
      const glob = row(db, seed(db, { kind: 'fact', scope: 'global', workspace: null }));
      const bad = row(db, seed(db, { kind: 'fact' }));
      const known = ['C:/Repo/Alpha', WS_B];
      const out = gradesToProposals([fact, pref, obs, obsGlobal, silent, noop, glob, bad], {
        grades: [
          { id: 'not-in-batch', verdict: 'forget', reason: 'x' },
          { id: fact.id, verdict: 'rescope', targetScope: 'project', targetWorkspace: 'C:\\Repo\\Alpha\\', reason: 'y'.repeat(500) },
          { id: fact.id, verdict: 'forget', reason: 'duplicate grade ignored' },
          { id: pref.id, verdict: 'episode', reason: 'episode is facts only' },
          { id: obs.id, verdict: 'episode', reason: 'observations cannot become episodes' },
          { id: obsGlobal.id, verdict: 'rescope', targetScope: 'global', reason: 'observations stay in a workspace' },
          { id: noop.id, verdict: 'rescope', targetScope: 'project', targetWorkspace: WS_B, reason: 'same place' },
          { id: glob.id, verdict: 'rescope', targetScope: 'global', reason: 'already global' },
          { id: bad.id, verdict: 'rescope', targetScope: 'project', targetWorkspace: '/unknown', reason: 'unknown ws' },
          'garbage',
        ],
      }, known)!;
      expect(out.map(p => [p.row.id, p.action, p.targetWorkspace])).toEqual([[fact.id, 'rescope_workspace', 'C:/Repo/Alpha']]);
      expect(out[0]!.reason).toHaveLength(200);
      expect(gradesToProposals([fact], { nope: [] }, known)).toBeNull();
      expect(gradesToProposals([fact], null, known)).toBeNull();
    });
  });

  describe('run', () => {
    it('writes proposals only, never memories or memory_profile, and keeps memory text in data position', async () => {
      const f = seed(db, { kind: 'fact', content: 'Zebra slice shipped today' });
      const g = seed(db, { kind: 'preference', content: 'user prefers tabs', workspace: WS_A });
      seed(db, { kind: 'fact', content: 'keep me' });
      await profileManager.setProfileSection('project', WS_A, 'static', 'old static');
      const before = snapshotStore(db);
      const runner = scriptedRunner(
        { [f]: { verdict: 'forget' }, [g]: { verdict: 'rescope', targetScope: 'global' } },
        { static: 'new static', dynamic: 'focus' },
      );
      const runId = await audit(runner);

      expect(snapshotStore(db)).toBe(before);
      const ps = proposals(runId);
      expect(ps.map(p => p.action).sort()).toEqual(['forget', 'profile_rewrite', 'rescope_global']);
      expect(ps.every(p => p.status === 'pending')).toBe(true);
      const run = db.prepare('SELECT * FROM memory_audit_runs WHERE id = ?').get(runId) as { status: string; total: number; graded: number; failed_batches: number; rubric_version: number };
      expect(run).toMatchObject({ status: 'completed', total: 4, graded: 4, failed_batches: 0, rubric_version: RUBRIC_VERSION });
      for (const [req] of runner.mock.calls) {
        expect(req.purpose).toBe('audit');
        expect(req.systemPrompt).not.toContain('Zebra slice');
      }
      expect(runner.mock.calls.some(([req]) => req.prompt.includes('Zebra slice shipped today'))).toBe(true);
    });

    it('retries a batch once and counts a batch that fails twice', async () => {
      const a = seed(db, { kind: 'fact', content: 'a' });
      seed(db, { kind: 'preference', content: 'b' });
      let factCalls = 0;
      const runner = subCallSpy((async (req: MemorySubCallRequest) => {
        const ids = promptIds(req);
        if (ids.includes(a)) {
          factCalls += 1;
          return factCalls === 1 ? { value: null, failure: 'transient' } : { value: { grades: [{ id: a, verdict: 'forget', reason: 'r' }] } };
        }
        return { value: 'not a grade object' };
      }) as SubCallImpl);
      const runId = await audit(runner);
      const run = db.prepare('SELECT graded, failed_batches FROM memory_audit_runs WHERE id = ?').get(runId);
      expect(run).toEqual({ graded: 1, failed_batches: 1 });
      expect(proposals(runId).map(p => p.memory_id)).toEqual([a]);
      expect(runner).toHaveBeenCalledTimes(4);
    });

    it('fails the run when no sub-call model is available', async () => {
      seed(db);
      const runner = subCallSpy((async () => ({ value: null, failure: 'no-model' })) as SubCallImpl);
      const d = deps(runner);
      const plan = (await beginAuditRun(d))!;
      const outcome = await runAudit(d, plan, new AbortController().signal, () => {});
      expect(outcome).toEqual({ status: 'failed', failure: 'no-model' });
      expect((db.prepare('SELECT status FROM memory_audit_runs WHERE id = ?').get(plan.runId) as { status: string }).status).toBe('failed');
    });

    it('fails a run in which every call failed', async () => {
      seed(db);
      await profileManager.setProfileSection('global', '', 'static', 'likes tea');
      const runner = subCallSpy((async () => ({ value: null, failure: 'transient' })) as SubCallImpl);
      const d = deps(runner);
      const plan = (await beginAuditRun(d))!;
      expect(await runAudit(d, plan, new AbortController().signal, () => {})).toEqual({ status: 'failed', failure: 'all-failed' });
      expect(db.prepare('SELECT status, failed_batches FROM memory_audit_runs WHERE id = ?').get(plan.runId)).toEqual({ status: 'failed', failed_batches: 2 });
    });

    it('cancels on abort and keeps the proposals already written', async () => {
      const first = seed(db, { kind: 'fact', content: 'first' });
      const second = seed(db, { kind: 'preference', content: 'second' });
      const abort = new AbortController();
      let firstWritten!: () => void;
      const written = new Promise<void>(resolve => { firstWritten = resolve; });
      const runner = subCallSpy((async (req: MemorySubCallRequest) => {
        if (promptIds(req).includes(first)) return { value: { grades: [{ id: first, verdict: 'forget', reason: 'r' }] } };
        await written;
        abort.abort();
        return { value: { grades: [{ id: second, verdict: 'forget', reason: 'r' }] } };
      }) as SubCallImpl);
      const d = deps(runner);
      const plan = (await beginAuditRun(d))!;
      const progress: MemoryAuditProgress[] = [];
      const outcome = await runAudit(d, plan, abort.signal, p => { progress.push(p); firstWritten(); });
      expect(outcome.status).toBe('cancelled');
      expect(proposals(plan.runId).map(p => p.memory_id)).toEqual([first]);
      expect(progress.at(-1)?.status).toBe('cancelled');
    });
  });

  describe('lease', () => {
    it('refreshes the heartbeat as batches land', async () => {
      const id = seed(db);
      const d = deps(scriptedRunner({ [id]: { verdict: 'forget' } }));
      const plan = (await beginAuditRun(d))!;
      const old = Date.now() - 10 * 60 * 1000;
      db.prepare('UPDATE memory_audit_runs SET heartbeat_at = ? WHERE id = ?').run(old, plan.runId);
      const beats: number[] = [];
      await runAudit(d, plan, new AbortController().signal, () => {
        beats.push((db.prepare('SELECT heartbeat_at FROM memory_audit_runs WHERE id = ?').get(plan.runId) as { heartbeat_at: number }).heartbeat_at);
      });
      expect(beats[0]).toBeGreaterThan(old + 9 * 60 * 1000);
    });

    it('blocks a second window while the heartbeat is fresh', async () => {
      seed(db);
      const a = await beginAuditRun(deps(scriptedRunner({}), 'window-a'));
      expect(a).not.toBeNull();
      expect(await beginAuditRun(deps(scriptedRunner({}), 'window-b'))).toBeNull();
      expect(state('window-b').run).toMatchObject({ id: a!.runId, status: 'running', ownedByThisWindow: false, leaseActive: true });
    });

    it('takes over a stale lease: the old run is marked failed, its pending proposals turn stale, and it writes nothing more', async () => {
      const m1 = seed(db, { kind: 'fact', content: 'one' });
      const m2 = seed(db, { kind: 'preference', content: 'two' });
      const runnerA = scriptedRunner({ [m1]: { verdict: 'forget' }, [m2]: { verdict: 'forget' } });
      const dA = deps(runnerA, 'window-a');
      const planA = (await beginAuditRun(dA))!;
      // Window A graded one batch, then stalled past the lease.
      await runAudit(dA, { ...planA, batches: planA.batches.slice(0, 1) }, new AbortController().signal, () => {});
      db.prepare("UPDATE memory_audit_runs SET status = 'running', heartbeat_at = ? WHERE id = ?").run(Date.now() - AUDIT_LEASE_MS - 1, planA.runId);

      const planB = await beginAuditRun(deps(scriptedRunner({}), 'window-b'));
      expect(planB).not.toBeNull();
      expect((db.prepare('SELECT status FROM memory_audit_runs WHERE id = ?').get(planA.runId) as { status: string }).status).toBe('failed');
      expect(proposals(planA.runId)).toHaveLength(1);
      expect(proposals(planA.runId)[0]!.status).toBe('stale');

      const late = await runAudit(dA, { ...planA, batches: planA.batches.slice(1) }, new AbortController().signal, () => {});
      expect(late).toEqual({ status: 'failed', failure: 'lease-lost' });
      expect(proposals(planA.runId)).toHaveLength(1);
    });
  });

  describe('apply and revert', () => {
    let tracker: ReturnType<typeof fakeTracker>;
    const applyDeps = () => ({ db, writeQueue, profileManager, tracker });

    beforeEach(() => {
      tracker = fakeTracker();
    });

    it('forget: forgets the live chain as quality_audit, and revert restores only the rows it flipped', async () => {
      const root = seed(db, { id: 'v1', kind: 'fact', content: 'v1', isLatest: 0 });
      seed(db, { id: 'v0', kind: 'fact', content: 'v0', isLatest: 0, rootId: root, forgotten: 1, forgetReason: 'user_forget' });
      const head = seed(db, { id: 'v2', kind: 'fact', content: 'v2', rootId: root, parentId: root });
      const runId = await audit(scriptedRunner({ [head]: { verdict: 'forget' } }));

      const res = await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, head)], []);
      expect(res).toEqual({ applied: 1, stale: 0, rejected: 0 });
      expect([row(db, 'v1'), row(db, 'v2')].map(r => [r.forgotten, r.forget_reason])).toEqual([[1, 'quality_audit'], [1, 'quality_audit']]);
      expect(row(db, 'v0').forget_reason).toBe('user_forget');
      expect(row(db, 'v2').forget_reason).toBe(QUALITY_AUDIT_FORGET_REASON);
      expect(tracker.removeObservation).toHaveBeenCalledWith('v2');

      expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 1, skipped: 0 });
      expect([row(db, 'v1'), row(db, 'v2')].map(r => [r.forgotten, r.forget_reason])).toEqual([[0, null], [0, null]]);
      expect([row(db, 'v0').forgotten, row(db, 'v0').forget_reason]).toEqual([1, 'user_forget']);
      expect(proposals(runId)[0]!.status).toBe('reverted');
    });

    it('rescope_global clears workspace and session_id, and revert restores them exactly', async () => {
      const id = seed(db, { kind: 'fact', scope: 'session', sessionId: 'sess-1', content: 'machine has 64GB RAM' });
      const before = row(db, id);
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'rescope', targetScope: 'global' } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      expect(row(db, id)).toMatchObject({ scope: 'global', workspace: null, session_id: null, forgotten: 0, updated_at: before.updated_at });

      await revertAuditRun(applyDeps(), runId);
      expect(row(db, id)).toEqual(before);
    });

    it('rescope_workspace of a session row clears session_id, and revert restores it', async () => {
      const id = seed(db, { kind: 'fact', scope: 'session', sessionId: 'sess-1', content: 'beta uses make' });
      const before = row(db, id);
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'rescope', targetScope: 'project', targetWorkspace: WS_B } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      expect(row(db, id)).toMatchObject({ scope: 'project', workspace: WS_B, session_id: null });

      await revertAuditRun(applyDeps(), runId);
      expect(row(db, id)).toEqual(before);
    });

    it('skips revert into a session deleted after apply', async () => {
      const id = seed(db, { kind: 'fact', scope: 'session', sessionId: 'sess-1', content: 'machine has 64GB RAM' });
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'rescope', targetScope: 'global' } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      await writeQueue.run(() => retireSessionReverts(db, 'sess-1'));

      expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 0, skipped: 1 });
      expect(row(db, id)).toMatchObject({ scope: 'global', session_id: null });
    });

    it('skips revert of a row pinned or superseded after apply', async () => {
      const pinned = seed(db, { kind: 'fact', content: 'pinned after apply' });
      const superseded = seed(db, { kind: 'fact', content: 'superseded after apply' });
      const runId = await audit(scriptedRunner({ [pinned]: { verdict: 'rescope', targetScope: 'global' }, [superseded]: { verdict: 'rescope', targetScope: 'global' } }));
      await applyAuditDecisions(applyDeps(), runId, proposals(runId).map(p => p.id), []);
      db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(pinned);
      db.prepare('UPDATE memories SET is_latest = 0 WHERE id = ?').run(superseded);

      expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 0, skipped: 2 });
      expect([row(db, pinned).scope, row(db, superseded).scope]).toEqual(['global', 'global']);
    });

    it('rescope_workspace moves an observation and re-tracks its files; revert moves it back', async () => {
      const id = seed(db, { kind: 'observation', content: 'parser gotcha', workspace: WS_A, filesRead: ['src/parser.ts'] });
      const before = row(db, id);
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'rescope', targetScope: 'project', targetWorkspace: WS_B } }));
      expect(proposals(runId)[0]).toMatchObject({ action: 'rescope_workspace', target_workspace: WS_B });

      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      expect(row(db, id)).toMatchObject({ scope: 'project', workspace: WS_B });
      expect(tracker.removeObservation).toHaveBeenCalledWith(id);
      expect(tracker.trackObservation).toHaveBeenLastCalledWith(id, ['src/parser.ts'], [], WS_B);

      await revertAuditRun(applyDeps(), runId);
      expect(row(db, id)).toEqual(before);
      expect(tracker.trackObservation).toHaveBeenLastCalledWith(id, ['src/parser.ts'], [], WS_A);
    });

    it('to_episode sets the episode TTL, and revert restores kind and forget_after even after promotion or decay', async () => {
      const promoted = seed(db, { kind: 'fact', content: 'working on the audit this week' });
      const decayed = seed(db, { kind: 'fact', content: 'temporary workaround for flaky CI', workspace: WS_B });
      const beforeP = row(db, promoted);
      const beforeD = row(db, decayed);
      const runId = await audit(scriptedRunner({ [promoted]: { verdict: 'episode' }, [decayed]: { verdict: 'episode' } }));
      const t0 = Date.now();
      await applyAuditDecisions(applyDeps(), runId, proposals(runId).map(p => p.id), []);
      const applied = row(db, promoted);
      expect(applied.kind).toBe('episode');
      expect(applied.forget_after).toBeGreaterThanOrEqual(t0 + EPISODE_TTL_MS);
      expect(applied.forget_after).toBeLessThanOrEqual(Date.now() + EPISODE_TTL_MS);

      db.prepare('UPDATE memories SET forget_after = NULL WHERE id = ?').run(promoted);
      db.prepare("UPDATE memories SET forgotten = 1, forget_reason = 'episode_decay' WHERE id = ?").run(decayed);

      expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 2, skipped: 0 });
      expect(row(db, promoted)).toEqual(beforeP);
      expect(row(db, decayed)).toEqual(beforeD);
    });

    it('to_episode resets the promotion evidence, so maintenance keeps the TTL, and revert restores it', async () => {
      const id = seed(db, { kind: 'fact', content: 'focus: the audit overlay', sourceCount: 3, accessCount: 7 });
      const before = row(db, id);
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'episode' } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      expect(row(db, id)).toMatchObject({ kind: 'episode', access_count: 0, source_count: 1 });

      expect(await promoteEpisodes(db, writeQueue)).toEqual({ promoted: 0 });
      db.prepare('UPDATE memories SET access_count = access_count + 1 WHERE id = ?').run(id);

      expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 1, skipped: 0 });
      expect(row(db, id)).toEqual({ ...before, access_count: 8 });
    });

    it('keeps an audit episode of an old row through decay and purge, so revert still restores it', async () => {
      const id = seed(db, { kind: 'fact', content: 'old fact last touched in 2023' });
      const before = row(db, id);
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'episode' } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        vi.setSystemTime(Date.now() + EPISODE_TTL_MS + 24 * 60 * 60 * 1000);
        await applyDecaySweep(db, writeQueue);
        await purgeForgottenRows(db, writeQueue);
        expect(row(db, id)).toMatchObject({ kind: 'episode', forgotten: 1, forget_reason: 'episode_decay' });

        expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 1, skipped: 0 });
        expect(row(db, id)).toEqual(before);
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks a proposal stale when the user pinned the row after grading', async () => {
      const id = seed(db, { kind: 'fact', content: 'pinned later' });
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'forget' } }));
      db.prepare('UPDATE memories SET pinned = 1 WHERE id = ?').run(id);
      const pinned = row(db, id);

      expect(await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], [])).toEqual({ applied: 0, stale: 1, rejected: 0 });
      expect(row(db, id)).toEqual(pinned);
    });

    it('rescope_global onto an existing global duplicate bumps it and forgets this row; revert undoes both', async () => {
      const dup = seed(db, { kind: 'fact', scope: 'global', workspace: null, content: 'User is on Windows 11' });
      const id = seed(db, { kind: 'fact', scope: 'project', content: 'user is on   windows 11' });
      const before = row(db, id);
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'rescope', targetScope: 'global' } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      expect(row(db, dup).source_count).toBe(2);
      expect(row(db, id)).toMatchObject({ scope: 'project', workspace: WS_A, forgotten: 1, forget_reason: 'quality_audit' });

      await revertAuditRun(applyDeps(), runId);
      expect(row(db, dup).source_count).toBe(1);
      expect(row(db, id)).toEqual(before);
    });

    it('rescope_workspace onto a duplicate in that workspace bumps it and forgets this row; revert undoes both', async () => {
      const dup = seed(db, { kind: 'fact', workspace: WS_B, content: 'beta builds with make' });
      const id = seed(db, { kind: 'fact', workspace: WS_A, content: 'Beta builds with make' });
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'rescope', targetScope: 'project', targetWorkspace: WS_B } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      expect(row(db, dup).source_count).toBe(2);
      expect(row(db, id)).toMatchObject({ workspace: WS_A, forgotten: 1, forget_reason: 'quality_audit' });

      await revertAuditRun(applyDeps(), runId);
      expect(row(db, dup).source_count).toBe(1);
      expect(row(db, id)).toMatchObject({ workspace: WS_A, forgotten: 0, forget_reason: null });
    });

    it('marks a proposal stale when its row changed after grading, and applies nothing', async () => {
      const id = seed(db, { kind: 'fact', content: 'original' });
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'forget' } }));
      db.prepare('UPDATE memories SET content = ?, content_hash = ?, updated_at = updated_at + 1 WHERE id = ?').run('edited', normalizedContentHash('edited'), id);
      const edited = row(db, id);

      expect(await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], [])).toEqual({ applied: 0, stale: 1, rejected: 0 });
      expect(row(db, id)).toEqual(edited);
      expect(proposals(runId)[0]!.status).toBe('stale');
      expect(proposals(runId)[0]!.decided_at).not.toBeNull();
    });

    it('skips revert of a row the user changed after apply', async () => {
      const id = seed(db, { kind: 'fact', content: 'to forget' });
      const runId = await audit(scriptedRunner({ [id]: { verdict: 'forget' } }));
      await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, id)], []);
      db.prepare("UPDATE memories SET forget_reason = 'user_forget' WHERE id = ?").run(id);

      expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 0, skipped: 1 });
      expect(row(db, id)).toMatchObject({ forgotten: 1, forget_reason: 'user_forget' });
      expect(proposals(runId)[0]!.status).toBe('applied');
    });

    it('rejects ids, refuses an id in both lists, and applies more than one 50-decision chunk', async () => {
      const ids = Array.from({ length: 60 }, (_, i) => seed(db, { kind: 'fact', content: `noise ${i}` }));
      const grades = Object.fromEntries(ids.map(id => [id, { verdict: 'forget' }]));
      const runId = await audit(scriptedRunner(grades));
      const all = proposals(runId).map(p => p.id);
      await expect(applyAuditDecisions(applyDeps(), runId, [all[0]!], [all[0]!])).rejects.toThrow(/both accepted and rejected/);

      const res = await applyAuditDecisions(applyDeps(), runId, all.slice(0, 55), all.slice(55));
      expect(res).toEqual({ applied: 55, stale: 0, rejected: 5 });
      expect(proposals(runId).filter(p => p.status === 'rejected')).toHaveLength(5);
      expect((db.prepare("SELECT COUNT(*) AS n FROM memories WHERE forget_reason = 'quality_audit'").get() as { n: number }).n).toBe(55);
    });

    it('leaves a proposal named in neither list pending and its memory untouched', async () => {
      const decided = seed(db, { kind: 'fact', content: 'decided' });
      const undecided = seed(db, { kind: 'fact', content: 'undecided' });
      const runId = await audit(scriptedRunner({ [decided]: { verdict: 'forget' }, [undecided]: { verdict: 'forget' } }));
      const before = row(db, undecided);

      expect(await applyAuditDecisions(applyDeps(), runId, [proposalFor(runId, decided)], [])).toEqual({ applied: 1, stale: 0, rejected: 0 });
      expect(proposals(runId).find(p => p.memory_id === undecided)).toMatchObject({ status: 'pending', decided_at: null });
      expect(row(db, undecided)).toEqual(before);
    });

    it('profile_rewrite revert removes a section the profile did not have', async () => {
      await profileManager.setProfileSection('global', '', 'static', 'old static');
      const runId = await audit(scriptedRunner({}, { static: 'old static', dynamic: 'new focus' }));
      await applyAuditDecisions(applyDeps(), runId, [proposals(runId)[0]!.id], []);
      expect(profileManager.readSection('global', '', 'dynamic')?.content).toBe('new focus');

      expect(await revertAuditRun(applyDeps(), runId)).toEqual({ reverted: 1, skipped: 0 });
      expect(profileManager.readSection('global', '', 'dynamic')).toBeNull();
      expect(profileManager.readSection('global', '', 'static')?.content).toBe('old static');
    });

    it('profile_rewrite applies per section with CAS and revert restores the prior text', async () => {
      await profileManager.setProfileSection('project', WS_A, 'static', 'old static');
      await profileManager.setProfileSection('project', WS_A, 'dynamic', 'old dynamic');
      const runId = await audit(scriptedRunner({}, { static: 'new static', dynamic: 'new dynamic' }));
      const graded = state();
      expect(graded.proposals[0]).toMatchObject({
        action: 'profile_rewrite',
        profileScope: 'project',
        profileWorkspace: WS_A,
        profileBefore: { static: 'old static', dynamic: 'old dynamic' },
        profileAfter: { static: 'new static', dynamic: 'new dynamic' },
      });
      // The user edits the dynamic section after grading: only static applies.
      await new Promise(r => setTimeout(r, 2));
      await profileManager.setProfileSection('project', WS_A, 'dynamic', 'user dynamic');

      await applyAuditDecisions(applyDeps(), runId, [graded.proposals[0]!.id], []);
      expect(profileManager.getProfile('project', WS_A)).toEqual({ static: 'new static', dynamic: 'user dynamic' });

      await revertAuditRun(applyDeps(), runId);
      expect(profileManager.getProfile('project', WS_A)).toEqual({ static: 'old static', dynamic: 'user dynamic' });
    });

    it('marks a profile_rewrite stale when every section it changes was edited after grading', async () => {
      await profileManager.setProfileSection('global', '', 'static', 'old');
      const runId = await audit(scriptedRunner({}, { static: 'new', dynamic: '' }));
      await new Promise(r => setTimeout(r, 2));
      await profileManager.setProfileSection('global', '', 'static', 'user edit');
      const id = proposals(runId)[0]!.id;
      expect(await applyAuditDecisions(applyDeps(), runId, [id], [])).toEqual({ applied: 0, stale: 1, rejected: 0 });
      expect(profileManager.getProfile('global', '').static).toBe('user edit');
    });
  });

  describe('state', () => {
    it('reports no run, the eligible count and the latest run with its proposals', async () => {
      const id = seed(db, { kind: 'fact', title: 'T', content: 'c' });
      expect(state()).toMatchObject({ run: null, proposals: [], hasAnyRun: false, eligibleCount: 1, startEndsLatestRun: false });

      const runId = await audit(scriptedRunner({ [id]: { verdict: 'forget', reason: 'progress log' } }));
      const after = state();
      expect(after.hasAnyRun).toBe(true);
      expect(after.run).toMatchObject({ id: runId, status: 'completed', ownedByThisWindow: true, leaseActive: false });
      expect(after.proposals).toEqual([
        expect.objectContaining({ memoryId: id, action: 'forget', status: 'pending', reason: 'progress log', kind: 'fact', title: 'T', contentPreview: 'c', currentScope: 'project', currentWorkspace: WS_A }),
      ]);
    });

    it('starting a new run turns the previous run pending proposals stale, which the state announces beforehand', async () => {
      const applied = seed(db, { kind: 'fact', content: 'applied' });
      const pending = seed(db, { kind: 'fact', content: 'pending' });
      const first = await audit(scriptedRunner({ [applied]: { verdict: 'forget' }, [pending]: { verdict: 'forget' } }));
      await applyAuditDecisions({ db, writeQueue, profileManager, tracker: null }, first, [proposalFor(first, applied)], []);
      expect(state().startEndsLatestRun).toBe(true);

      await audit(scriptedRunner({}));
      const byMemory = Object.fromEntries(proposals(first).map(p => [p.memory_id, p.status]));
      expect(byMemory).toEqual({ [applied]: 'applied', [pending]: 'stale' });
      expect(state().startEndsLatestRun).toBe(false);
    });

    it('summarizes the banner and run indicator from counts alone', async () => {
      const a = seed(db, { kind: 'fact', content: 'a' });
      const b = seed(db, { kind: 'fact', content: 'b' });
      seed(db, { kind: 'fact', pinned: 1 });
      expect(getAuditSummary(db, HOLDER)).toEqual({ hasAnyRun: false, eligibleCount: 2, running: false, runningHere: false, pendingCount: 0 });

      const d = deps(scriptedRunner({ [a]: { verdict: 'forget' }, [b]: { verdict: 'forget' } }));
      const plan = (await beginAuditRun(d))!;
      expect(getAuditSummary(db, HOLDER)).toMatchObject({ hasAnyRun: true, running: true, runningHere: true });
      expect(getAuditSummary(db, 'window-b')).toMatchObject({ running: true, runningHere: false });

      await runAudit(d, plan, new AbortController().signal, () => {});
      expect(getAuditSummary(db, HOLDER)).toEqual({ hasAnyRun: true, eligibleCount: 2, running: false, runningHere: false, pendingCount: 2 });
    });
  });
});
