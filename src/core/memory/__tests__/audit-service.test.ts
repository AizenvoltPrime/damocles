import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseInstance } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult } from '../subcall-runner';
import type { MemoryAuditModel } from '@shared/types/memory-audit';
import type { ExtensionToWebviewMessage } from '@shared/types/messages';

const dbHolder = vi.hoisted(() => ({ path: '' }));
vi.mock('../database', async (importActual) => {
  const actual = await importActual<typeof import('../database')>();
  return {
    ...actual,
    openDatabaseAsync: vi.fn(async () => {
      const raw = new DatabaseSync(dbHolder.path, { timeout: 5000, enableForeignKeyConstraints: true });
      raw.exec('PRAGMA journal_mode = WAL');
      const db = actual.createDatabaseWrapper(raw);
      actual.runMigrations(db);
      return { db };
    }),
  };
});

const MODEL: MemoryAuditModel = { provider: 'anthropic', id: 'haiku', inputPerMTok: 1, outputPerMTok: 5, dollarBilled: true };
const subcall = vi.hoisted(() => ({
  describe: (): unknown => null,
  run: null as null | ((req: MemorySubCallRequest) => Promise<MemorySubCallResult<unknown>>),
}));
vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({
    run: (req: MemorySubCallRequest) => (subcall.run ? subcall.run(req) : Promise.resolve({ value: null, failure: 'no-model' as const })),
  }),
  describeMemorySubCallModel: () => subcall.describe(),
}));
vi.mock('../query-expansion', () => ({
  expandQuery: vi.fn(async () => [] as string[]),
  expandMemoryTerms: vi.fn(async () => [] as string[]),
  expandMemoryTermsWithStatus: vi.fn(async () => ({ terms: [] as string[], failed: false })),
  clearExpansionCache: vi.fn(() => {}),
}));

import { MemoryService } from '../index';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createTestDbPath } from './test-helpers';

const WS = '/ws/panel';

describe('MemoryService quality audit lifecycle', () => {
  let service: MemoryService;
  let sent: ExtensionToWebviewMessage[];

  const internals = () => service as unknown as { db: DatabaseInstance | null };
  const db = (): DatabaseInstance => internals().db!;
  const runs = () => db().prepare('SELECT holder, status FROM memory_audit_runs ORDER BY started_at').all() as Array<{ holder: string; status: string }>;

  function seed(overrides: { id?: string; scope?: string; sessionId?: string | null; rootId?: string | null; content?: string } = {}): string {
    const id = overrides.id ?? crypto.randomUUID();
    const content = overrides.content ?? `memory ${id}`;
    const now = Date.now();
    db().prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, session_id, workspace, is_latest, forgotten, created_at, updated_at)
       VALUES (?, 'fact', ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    ).run(id, overrides.scope ?? 'project', content, id, overrides.rootId ?? null, overrides.sessionId ?? null, WS, now, now);
    return id;
  }

  /** A grading call that holds until the run is aborted, so a test can act while the run is live. */
  function blockingRun(): { called: Promise<void> } {
    let markCalled!: () => void;
    const called = new Promise<void>((resolve) => { markCalled = resolve; });
    subcall.run = (req) => {
      markCalled();
      return new Promise((resolve) => {
        req.abortSignal?.addEventListener('abort', () => resolve({ value: null, failure: 'transient' }), { once: true });
      });
    };
    return { called };
  }

  beforeEach(async () => {
    dbHolder.path = createTestDbPath();
    subcall.describe = () => MODEL;
    subcall.run = null;
    sent = [];
    service = new MemoryService(createFakePlatform());
    service.setWorkspaceRoots([WS]);
    service.setConsolidationBroadcast((msg) => sent.push(msg));
    await service.ensureInitialized();
  });

  afterEach(async () => {
    await service.dispose();
  });

  it('refuses to start without a sub-call model, and records no run', async () => {
    seed();
    subcall.describe = () => null;
    expect(await service.startAudit()).toEqual({ started: false, reason: 'no-model' });
    expect(runs()).toEqual([]);
  });

  it('is busy while its own run is live, and while another window holds the lease', async () => {
    seed();
    const { called } = blockingRun();
    expect(await service.startAudit()).toEqual({ started: true });
    expect(await service.startAudit()).toEqual({ started: false, reason: 'busy' });
    await called;
    expect(await service.cancelAudit()).toBe('cancelled');

    db().prepare("INSERT INTO memory_audit_runs (id, status, holder, heartbeat_at, started_at, total, rubric_version) VALUES ('other', 'running', 'window-b', ?, ?, 1, 1)").run(Date.now(), Date.now() + 1);
    expect(await service.startAudit()).toEqual({ started: false, reason: 'busy' });
  });

  it('cancels a run and resolves only once it has settled as cancelled', async () => {
    seed();
    const { called } = blockingRun();
    await service.startAudit();
    await called;
    expect(await service.cancelAudit()).toBe('cancelled');
    expect(runs()).toEqual([expect.objectContaining({ status: 'cancelled' })]);
    expect(sent).toContainEqual({ type: 'memoryAuditProgress', progress: expect.objectContaining({ status: 'cancelled' }) });
  });

  it('cancels a start that is still taking the lease', async () => {
    seed();
    subcall.run = vi.fn(async () => ({ value: { grades: [] } }));
    const start = service.startAudit();
    expect(await service.cancelAudit()).toBe('cancelled');
    expect(await start).toEqual({ started: true });
    expect(subcall.run).not.toHaveBeenCalled();
    expect(runs()).toEqual([expect.objectContaining({ status: 'cancelled' })]);
  });

  it("answers a cancel aimed at another window's run, or at no run, definitely", async () => {
    expect(await service.cancelAudit()).toBe('not-running');
    db().prepare("INSERT INTO memory_audit_runs (id, status, holder, heartbeat_at, started_at, total, rubric_version) VALUES ('other', 'running', 'window-b', ?, ?, 1, 1)").run(Date.now(), Date.now());
    expect(await service.cancelAudit()).toBe('held-elsewhere');
  });

  it('dispose during the lease lets the run record itself cancelled before the database closes', async () => {
    seed();
    subcall.run = vi.fn(async () => ({ value: { grades: [] } }));
    subcall.describe = () => {
      service.dispose();
      return MODEL;
    };
    expect(await service.startAudit()).toEqual({ started: true });
    await vi.waitFor(() => expect(internals().db).toBeNull());

    const raw = new DatabaseSync(dbHolder.path);
    expect(raw.prepare('SELECT status FROM memory_audit_runs').all()).toEqual([{ status: 'cancelled' }]);
    raw.close();
    expect(subcall.run).not.toHaveBeenCalled();
    expect(sent.some((m) => m.type === 'memoryAuditState')).toBe(false);
  });

  it('reports a run in which every call failed with the all-failed code, then broadcasts the final state', async () => {
    seed();
    subcall.run = async () => ({ value: null, failure: 'transient' });
    await service.startAudit();
    await vi.waitFor(() => expect(sent.some((m) => m.type === 'memoryAuditSummary')).toBe(true));
    expect(sent).toContainEqual(expect.objectContaining({ type: 'memoryError', source: 'audit', code: 'all-failed' }));
    expect(runs()).toEqual([expect.objectContaining({ status: 'failed' })]);
  });

  it('a deleted session ends revert of a rescope out of it', async () => {
    const id = seed({ scope: 'session', sessionId: 'sess-1', content: 'the machine has 64GB of RAM' });
    subcall.run = async () => ({ value: { grades: [{ id, verdict: 'rescope', targetScope: 'global', reason: 'machine fact' }] } });
    await service.startAudit();
    await vi.waitFor(() => expect(runs()[0]?.status).toBe('completed'));
    const state = service.getAuditState()!;
    await service.applyAudit(state.run!.id, [state.proposals[0]!.id], []);

    await service.deleteSessionMemories('sess-1');
    expect(await service.revertAudit(state.run!.id)).toEqual({ reverted: 0, skipped: 1 });
    expect(db().prepare('SELECT scope, session_id FROM memories WHERE id = ?').get(id)).toEqual({ scope: 'global', session_id: null });
  });

  it('forgets and restores a whole version chain, whether the root carries its own id or none', async () => {
    const root = seed({ id: 'root', rootId: null });
    const v2 = seed({ id: 'v2', rootId: root });
    const self = seed({ id: 'self', rootId: 'self' });
    const other = seed({ id: 'other', rootId: null });
    const forgotten = () => (db().prepare('SELECT id FROM memories WHERE forgotten = 1 ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);

    expect((await service.forgetMemory(v2, 'chain', true)).forgotten).toBe(2);
    expect(forgotten()).toEqual(['root', 'v2']);
    expect((await service.forgetMemory(self, 'chain', true)).forgotten).toBe(1);
    expect(await service.unforgetMemory(root, 'chain')).toEqual({ restored: 2 });
    expect(forgotten()).toEqual(['self']);
    expect(forgotten()).not.toContain(other);
  });
});
