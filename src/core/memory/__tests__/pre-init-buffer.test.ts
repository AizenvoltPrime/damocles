import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseInstance } from '../types';
import type { ConsolidationResult } from '@shared/types/consolidation';

// Drive MemoryService init against a per-test temp DB instead of the global ~/.damocles file, and
// stub the sub-call runner so no PiRuntime/LLM path is touched.
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

// The sub-call runner reaches PiRuntime; stub it so init never touches the model layer. A test may
// swap `runnerHolder.run` to make extraction succeed.
const runnerHolder = vi.hoisted(() => ({
  run: null as null | ((req: { purpose: string }, lifetime: AbortSignal) => Promise<{ value: unknown; failure?: string }>),
}));
vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: (lifetime: AbortSignal) => ({
    run: vi.fn(async (req: { purpose: string }) =>
      runnerHolder.run ? runnerHolder.run(req, lifetime) : { value: null, failure: 'no-model' as const }),
  }),
}));

import { MemoryService } from '../index';
import { openDatabaseAsync } from '../database';
import { createFakePlatform } from '../../../__mocks__/fake-platform';
import { createTestDbPath } from './test-helpers';

/** A Windows fsPath with a drive letter and backslashes, which must reach the DB unchanged. */
const RAW_FS_PATH = String.raw`C:\Repos\App`;

function countCandidates(db: DatabaseInstance): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM memory_candidates').get() as { n: number };
  return row.n;
}

function makeTurn(promptIndex: number): {
  sessionId: string;
  promptIndex: number;
  userText: string;
  assistantText: string;
  files: string[];
  workspace: string;
} {
  return {
    sessionId: 'sess-buffer',
    promptIndex,
    userText: `user ${promptIndex}`,
    assistantText: `assistant ${promptIndex}`,
    files: [],
    workspace: '/ws/buffered',
  };
}

describe('MemoryService pre-init turn-candidate buffering', () => {
  let service: MemoryService;

  beforeEach(() => {
    dbHolder.path = createTestDbPath();
    service = new MemoryService(createFakePlatform());
  });

  afterEach(async () => {
    await service.dispose();
  });

  it('replays candidates enqueued before init into memory_candidates after init completes', async () => {
    // Enqueue three turns before the DB is ready — they must be buffered, not dropped.
    service.enqueueTurnCandidate(makeTurn(0));
    service.enqueueTurnCandidate(makeTurn(1));
    service.enqueueTurnCandidate(makeTurn(2));

    // Let init (kicked off by the first enqueue) complete, then drain the replays.
    await service.ensureInitialized();
    await new Promise((r) => setTimeout(r, 50));

    const db = service.database!;
    expect(countCandidates(db)).toBe(3);
    expect(service.getPendingCount()).toBe(3);
    const workspaces = db.prepare('SELECT DISTINCT workspace FROM memory_candidates').all() as { workspace: string | null }[];
    expect(workspaces).toEqual([{ workspace: '/ws/buffered' }]);
  });

  it('drops the oldest beyond the 50-candidate cap but never throws', async () => {
    for (let i = 0; i < 60; i++) service.enqueueTurnCandidate(makeTurn(i));

    await service.ensureInitialized();
    await new Promise((r) => setTimeout(r, 50));

    const db = service.database!;
    // Cap 50: the 10 oldest (promptIndex 0..9) dropped, 50 survive.
    expect(countCandidates(db)).toBe(50);
    const oldest = db
      .prepare('SELECT MIN(prompt_index) AS lo, MAX(prompt_index) AS hi FROM memory_candidates')
      .get() as { lo: number; hi: number };
    expect(oldest.lo).toBe(10);
    expect(oldest.hi).toBe(59);
  });

  it('a turn enqueued after init lands directly without buffering', async () => {
    await service.ensureInitialized();
    service.enqueueTurnCandidate({ ...makeTurn(100), workspace: RAW_FS_PATH });
    await new Promise((r) => setTimeout(r, 50));

    const db = service.database!;
    expect(countCandidates(db)).toBe(1);
    // The folder's raw fsPath is stored verbatim, so memory workspace strings stay byte-identical.
    const row = db.prepare('SELECT workspace FROM memory_candidates').get() as { workspace: string };
    expect(row.workspace).toBe(RAW_FS_PATH);
  });

  it('chain forget/unforget works for a legacy row with NULL root_id (deep nit)', async () => {
    service.enqueueTurnCandidate(makeTurn(0));
    await service.ensureInitialized();
    await new Promise((r) => setTimeout(r, 50));

    const db = service.database!;
    // Legacy v1-era row: root_id was never back-filled, so it is NULL.
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, created_at, updated_at)
       VALUES ('legacy', 'fact', 'project', 'a legacy fact', '', NULL, ?, ?)`,
    ).run(Date.now(), Date.now());

    const { forgotten } = await service.forgetMemory('legacy', 'chain');
    expect(forgotten).toBe(1);
    expect((db.prepare("SELECT forgotten FROM memories WHERE id = 'legacy'").get() as { forgotten: number }).forgotten).toBe(1);

    const { restored } = await service.unforgetMemory('legacy', 'chain');
    expect(restored).toBe(1);
    expect((db.prepare("SELECT forgotten FROM memories WHERE id = 'legacy'").get() as { forgotten: number }).forgotten).toBe(0);
  });

  it('deleteSessionMemories also purges the raw candidate buffer for that session (M2)', async () => {
    service.enqueueTurnCandidate(makeTurn(0));
    await service.ensureInitialized();
    await new Promise((r) => setTimeout(r, 50));

    const db = service.database!;
    db.prepare(
      `INSERT INTO memories (id, kind, scope, content, content_hash, root_id, session_id, created_at, updated_at)
       VALUES ('m-sess', 'fact', 'session', 'a session fact', '', 'm-sess', 'sess-buffer', ?, ?)`,
    ).run(Date.now(), Date.now());
    expect(countCandidates(db)).toBe(1);

    await service.deleteSessionMemories('sess-buffer');

    // Both the session memory row AND its raw turn text are gone — no dead-session re-extraction.
    expect(countCandidates(db)).toBe(0);
    const memRow = db.prepare("SELECT COUNT(*) AS n FROM memories WHERE session_id = 'sess-buffer'").get() as { n: number };
    expect(memRow.n).toBe(0);
  });

  it('dispose during init closes the database that opens afterwards and starts nothing on it', async () => {
    const init = service.ensureInitialized();
    const disposed = service.dispose();
    await init;
    await disposed;

    const { db } = (await vi.mocked(openDatabaseAsync).mock.results.at(-1)!.value) as { db: DatabaseInstance };
    expect(() => db.prepare('SELECT 1').get()).toThrow();
    expect(service as unknown as Record<string, unknown>).toMatchObject({ db: null, fileChangeTracker: null, startJitterTimer: null });
  });
});

// The mocked subcall-runner always returns no-model, so every forced pass fails (extract → no-model
// → release) — the "released batch" condition. Asserts the failure counter grows, the idle timer is
// re-armed with a strictly longer delay each failure, and a non-failed (empty) pass resets it to 0.
describe('MemoryService C9 — consolidation failure backoff', () => {
  let service: MemoryService;
  /** Every setTimeout delay scheduled in the window, for re-arm inspection. */
  let scheduledDelays: number[];
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  /** Read the private failure counter via a narrow cast. */
  function failures(): number {
    return (service as unknown as { consecutiveConsolidationFailures: number }).consecutiveConsolidationFailures;
  }

  beforeEach(() => {
    dbHolder.path = createTestDbPath();
    service = new MemoryService(createFakePlatform());
    scheduledDelays = [];
    // Spy the real timer (no fake clock) to read the delays armIdleTimer requests; callbacks never
    // fire in-window and dispose() clears the idle/jitter timers.
    setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((_fn: (...a: unknown[]) => void, delay?: number) => {
      scheduledDelays.push(delay ?? 0);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  afterEach(async () => {
    setTimeoutSpy.mockRestore();
    await service.dispose();
  });

  it('bumps the failure counter and re-arms the idle timer with a strictly longer delay on each failed pass', async () => {
    await service.ensureInitialized();
    // One candidate so a forced pass has something to claim (then release on no-model).
    const db = service.database!;
    db.prepare(
      `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, salient, consumed, reprocessed, created_at)
       VALUES (?, 'sess-backoff', 0, 'q', 'a', '[]', 0, 0, 0, ?)`,
    ).run(crypto.randomUUID(), Date.now());

    expect(failures()).toBe(0);

    // Pass 1 — no model → extraction fails, batch RELEASED. Counter → 1, idle timer re-armed base*2^1.
    scheduledDelays = [];
    await service.triggerConsolidation();
    expect(failures()).toBe(1);
    // Released, not stranded — claimable again next pass.
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM memory_candidates WHERE consumed = 1 AND reprocessed = 0').get() as { n: number }).n,
    ).toBe(0);
    const armAfter1 = Math.max(...scheduledDelays);

    // Pass 2 — still failing. Counter → 2, idle timer re-armed base*2^2 (strictly longer).
    scheduledDelays = [];
    await service.triggerConsolidation();
    expect(failures()).toBe(2);
    const armAfter2 = Math.max(...scheduledDelays);

    // The re-armed delay grows with consecutive failures (1h cap elsewhere), so persistent failures
    // back off instead of busy-looping.
    expect(armAfter2).toBeGreaterThan(armAfter1);

    // Pass 3 — empty queue → status 'empty' (non-failed) → counter resets to 0, base delay restored.
    db.prepare('DELETE FROM memory_candidates').run();
    await service.triggerConsolidation();
    expect(failures()).toBe(0);
  });
});

describe('MemoryService — consolidation files memories under the folder its conversation ran in', () => {
  let service: MemoryService;
  let scheduledDelays: number[];
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  function seed(db: DatabaseInstance, workspace: string | null, createdAt: number): void {
    db.prepare(
      `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, workspace, salient, consumed, reprocessed, created_at)
       VALUES (?, 'sess-folder', 0, 'which bundler?', 'esbuild', '[]', ?, 0, 0, 0, ?)`,
    ).run(crypto.randomUUID(), workspace, createdAt);
  }

  function projectMemoryWorkspaces(db: DatabaseInstance): (string | null)[] {
    return (db.prepare("SELECT workspace FROM memories WHERE scope = 'project' ORDER BY created_at, rowid").all() as {
      workspace: string | null;
    }[]).map((r) => r.workspace);
  }

  beforeEach(() => {
    dbHolder.path = createTestDbPath();
    let n = 0;
    runnerHolder.run = async (req) => {
      if (req.purpose === 'extract') {
        n += 1;
        return { value: { memories: [{ kind: 'fact', scope: 'project', content: `bundler fact number ${n}` }] } };
      }
      if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } };
      return { value: { contradicts: false, merged_ids: [], content: '' } };
    };
    service = new MemoryService(createFakePlatform());
    scheduledDelays = [];
    setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((_fn: (...a: unknown[]) => void, delay?: number) => {
      scheduledDelays.push(delay ?? 0);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  afterEach(async () => {
    setTimeoutSpy.mockRestore();
    runnerHolder.run = null;
    await service.dispose();
  });

  it('files every turn under its own folder, and a manual run takes every folder in one go', async () => {
    service.setFallbackWorkspace(() => '/ws/default');
    await service.ensureInitialized();
    const db = service.database!;
    seed(db, '/ws/b', 1);
    seed(db, '/ws/c', 2);

    scheduledDelays = [];
    await service.triggerConsolidation();
    expect(projectMemoryWorkspaces(db)).toEqual(['/ws/b', '/ws/c']);
    expect(service.getPendingCount()).toBe(0);
    expect(scheduledDelays).not.toContain(180_000);
  });

  it('takes one folder per background pass, re-arming the idle timer while others remain', async () => {
    service.setFallbackWorkspace(() => '/ws/default');
    await service.ensureInitialized();
    const db = service.database!;
    seed(db, '/ws/b', 1);
    seed(db, '/ws/c', 2);
    const runPass = (): Promise<void> =>
      (service as unknown as { runConsolidation: (o: { reason: 'idle' }) => Promise<void> }).runConsolidation({ reason: 'idle' });

    scheduledDelays = [];
    await runPass();
    expect(projectMemoryWorkspaces(db)).toEqual(['/ws/b']);
    expect(service.getPendingCount()).toBe(1);
    expect(scheduledDelays).toContain(180_000);

    scheduledDelays = [];
    await runPass();
    expect(projectMemoryWorkspaces(db)).toEqual(['/ws/b', '/ws/c']);
    expect(service.getPendingCount()).toBe(0);
    expect(scheduledDelays).not.toContain(180_000);
  });

  it('files a legacy candidate without a folder under the window fallback, e.g. home in a no-folder window', async () => {
    service.setFallbackWorkspace(() => '/home/user');
    await service.ensureInitialized();
    const db = service.database!;
    seed(db, null, 1);

    await service.triggerConsolidation();
    expect(projectMemoryWorkspaces(db)).toEqual(['/home/user']);
    expect(service.getPanelMemories(null, '/home/user').map((m) => m.content)).toEqual(['bundler fact number 1']);
  });

  it('dispose cancels an in-flight extraction, releases its batch, then closes the database', async () => {
    service.setFallbackWorkspace(() => '/ws/default');
    await service.ensureInitialized();
    seed(service.database!, '/ws/b', 1);
    let extractStarted!: () => void;
    const extracting = new Promise<void>((resolve) => { extractStarted = resolve; });
    // Settles only on abort, as the real runner's model call does once its signal fires.
    runnerHolder.run = (req, lifetime) => {
      if (req.purpose !== 'extract') return Promise.resolve({ value: null, failure: 'unreachable' });
      extractStarted();
      return new Promise((resolve) => lifetime.addEventListener('abort', () => resolve({ value: null, failure: 'unreachable' }), { once: true }));
    };

    const pass = service.triggerConsolidation();
    await extracting;
    await service.dispose();
    await pass;

    expect(service.database).toBeNull();
    expect(service.getLastConsolidationResult()).toMatchObject({ status: 'failed' });
    const raw = new DatabaseSync(dbHolder.path, { readOnly: true });
    try {
      expect(raw.prepare('SELECT consumed FROM memory_candidates').all()).toEqual([{ consumed: 0 }]);
    } finally {
      raw.close();
    }
  });
});

describe('MemoryService: set-aside turns and Retry', () => {
  let service: MemoryService;
  let scheduledDelays: number[];
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let broadcasts: Array<{ type: string; count?: number; setAside?: number }>;

  function seed(db: DatabaseInstance, user: string, setAside: boolean): void {
    db.prepare(
      `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, workspace, salient, consumed, reprocessed, created_at, failed_attempts, set_aside_at)
       VALUES (?, 'sess-aside', 0, ?, 'a', '[]', '/ws/aside', 0, 0, 0, ?, ?, ?)`,
    ).run(crypto.randomUUID(), user, Date.now(), setAside ? 3 : 0, setAside ? Date.now() : null);
  }

  /** The last `consolidationPendingCount` published, the pill's and the set-aside notice's only source. */
  function lastCounts(): { count?: number; setAside?: number } | undefined {
    return broadcasts.filter((m) => m.type === 'consolidationPendingCount').at(-1);
  }

  beforeEach(async () => {
    dbHolder.path = createTestDbPath();
    service = new MemoryService(createFakePlatform());
    broadcasts = [];
    service.setConsolidationBroadcast((msg) => broadcasts.push(msg as never));
    scheduledDelays = [];
    setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((_fn: (...a: unknown[]) => void, delay?: number) => {
      scheduledDelays.push(delay ?? 0);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
    await service.ensureInitialized();
  });

  afterEach(async () => {
    setTimeoutSpy.mockRestore();
    runnerHolder.run = null;
    await service.dispose();
  });

  it('Retry returns the set-aside turns, publishes both counts and arms the idle timer', async () => {
    const db = service.database!;
    seed(db, 'aside one', true);
    seed(db, 'aside two', true);
    expect(service.getSetAsideCount()).toBe(2);
    expect(service.getPendingCount()).toBe(0);

    scheduledDelays = [];
    await service.retrySetAsideTurns();

    expect(service.getSetAsideCount()).toBe(0);
    expect(lastCounts()).toEqual({ type: 'consolidationPendingCount', count: 2, setAside: 0 });
    expect(scheduledDelays).toContain(180_000);
    expect(broadcasts.some((m) => m.type === 'consolidationResult')).toBe(false);
  });

  it('Retry with nothing set aside arms no timer', async () => {
    scheduledDelays = [];
    await service.retrySetAsideTurns();
    expect(scheduledDelays).toEqual([]);
    expect(lastCounts()).toEqual({ type: 'consolidationPendingCount', count: 0, setAside: 0 });
  });

  it('a pass that ends after a Retry made while it ran publishes the fresh count', async () => {
    const db = service.database!;
    seed(db, 'aside', true);
    seed(db, 'queued', false);
    let extractStarted!: () => void;
    const started = new Promise<void>((resolve) => { extractStarted = resolve; });
    let finishExtract!: () => void;
    const held = new Promise<void>((resolve) => { finishExtract = resolve; });
    runnerHolder.run = async (req) => {
      if (req.purpose === 'extract') {
        extractStarted();
        await held;
        return { value: { memories: [] } };
      }
      if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } };
      return { value: { contradicts: false, merged_ids: [], content: '' } };
    };

    const pass = service.triggerConsolidation();
    await started;
    await service.retrySetAsideTurns();
    finishExtract();
    await pass;

    expect(service.getSetAsideCount()).toBe(0);
    expect(lastCounts()?.setAside).toBe(0);
  });

  it('a failed pass still publishes the turns set aside before it', async () => {
    const db = service.database!;
    seed(db, 'aside', true);
    seed(db, 'queued', false);

    await service.triggerConsolidation();

    expect(service.getLastConsolidationResult()).toMatchObject({ status: 'failed' });
    expect(lastCounts()).toEqual({ type: 'consolidationPendingCount', count: 1, setAside: 1 });
  });
});

describe('MemoryService: a run counts a turn the model declines at most once', () => {
  let service: MemoryService;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  /** The users of every extraction prompt, in call order. */
  let prompts: string[][];

  function seed(db: DatabaseInstance, user: string, workspace: string, order: number): string {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, workspace, salient, consumed, reprocessed, created_at)
       VALUES (?, 'sess-count', 0, ?, 'a', '[]', ?, 0, 0, 0, ?)`,
    ).run(id, user, workspace, Date.now() + order);
    return id;
  }

  function turn(id: string): { consumed: number; reprocessed: number; failed_attempts: number; set_aside_at: number | null } {
    return service.database!.prepare('SELECT consumed, reprocessed, failed_attempts, set_aside_at FROM memory_candidates WHERE id = ?').get(id) as never;
  }

  const idleRun = (): Promise<void> =>
    (service as unknown as { runConsolidation: (o: { reason: 'idle' }) => Promise<void> }).runConsolidation({ reason: 'idle' });

  beforeEach(async () => {
    dbHolder.path = createTestDbPath();
    prompts = [];
    runnerHolder.run = async (req) => {
      if (req.purpose === 'extract') {
        const users = [...(req as unknown as { prompt: string }).prompt.matchAll(/User: (\S+)/g)].map((m) => m[1]!);
        prompts.push(users);
        if (users.includes('poison')) return { value: null, failure: 'unanswered' };
        return { value: { memories: users.map((u) => ({ kind: 'fact', scope: 'project', content: `The user asked about ${u}.` })) } };
      }
      if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } };
      return { value: { contradicts: false, merged_ids: [], content: '' } };
    };
    service = new MemoryService(createFakePlatform());
    setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((() => 0) as unknown as typeof setTimeout);
    await service.ensureInitialized();
  });

  afterEach(async () => {
    setTimeoutSpy.mockRestore();
    runnerHolder.run = null;
    await service.dispose();
  });

  it('counts a declined turn once in a manual run whose follow-up pass takes the remaining turns, and never re-sends it', async () => {
    const db = service.database!;
    seed(db, 'q1', '/ws/a', 1);
    const poison = seed(db, 'poison', '/ws/a', 2);
    const other = seed(db, 'q2', '/ws/b', 3);

    await service.triggerConsolidation();

    expect(turn(poison)).toMatchObject({ consumed: 0, failed_attempts: 1, set_aside_at: null });
    expect(turn(other)).toMatchObject({ consumed: 1, reprocessed: 1 });
    expect(prompts.filter((users) => users.length === 1 && users[0] === 'poison')).toHaveLength(1);
    expect(service.getPendingCount()).toBe(1);
  });

  it('sets a declined turn aside after three separate manual runs', async () => {
    const db = service.database!;
    seed(db, 'q1', '/ws/a', 1);
    const poison = seed(db, 'poison', '/ws/a', 2);

    await service.triggerConsolidation();
    expect(turn(poison)).toMatchObject({ failed_attempts: 1, set_aside_at: null });
    await service.triggerConsolidation();
    expect(turn(poison)).toMatchObject({ failed_attempts: 2, set_aside_at: null });
    await service.triggerConsolidation();
    expect(turn(poison).failed_attempts).toBe(3);
    expect(turn(poison).set_aside_at).not.toBeNull();
    expect(service.getSetAsideCount()).toBe(1);
  });

  it('counts a declined turn once in each automatic run', async () => {
    const db = service.database!;
    seed(db, 'q1', '/ws/a', 1);
    const poison = seed(db, 'poison', '/ws/a', 2);
    seed(db, 'q2', '/ws/b', 3);

    await idleRun();
    expect(turn(poison)).toMatchObject({ failed_attempts: 1, set_aside_at: null });
    await idleRun();
    expect(turn(poison)).toMatchObject({ failed_attempts: 2, set_aside_at: null });
    await idleRun();
    expect(turn(poison).failed_attempts).toBe(3);
    expect(turn(poison).set_aside_at).not.toBeNull();
  });
});

describe('MemoryService: the terminal result describes the whole run', () => {
  let service: MemoryService;
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
  let broadcasts: Array<{ type: string; running?: boolean; result?: ConsolidationResult; event?: { phase: string; status: string } }>;
  /** Users whose extraction call answers `unreachable`. */
  let unreachableUsers: Set<string>;

  function seed(db: DatabaseInstance, user: string, workspace: string, order: number): void {
    db.prepare(
      `INSERT INTO memory_candidates (id, session_id, prompt_index, user_text, assistant_text, files, workspace, salient, consumed, reprocessed, created_at)
       VALUES (?, 'sess-run', 0, ?, 'a', '[]', ?, 0, 0, 0, ?)`,
    ).run(crypto.randomUUID(), user, workspace, Date.now() + order);
  }

  const results = (): ConsolidationResult[] => broadcasts.filter((m) => m.type === 'consolidationResult').map((m) => m.result!);
  const runningFlags = (): boolean[] => broadcasts.filter((m) => m.type === 'consolidationRunning').map((m) => m.running!);
  const failures = (): number => (service as unknown as { consecutiveConsolidationFailures: number }).consecutiveConsolidationFailures;
  const idleRun = (): Promise<void> =>
    (service as unknown as { runConsolidation: (o: { reason: 'idle' }) => Promise<void> }).runConsolidation({ reason: 'idle' });

  beforeEach(async () => {
    dbHolder.path = createTestDbPath();
    broadcasts = [];
    unreachableUsers = new Set();
    runnerHolder.run = async (req) => {
      if (req.purpose === 'extract') {
        const users = [...(req as unknown as { prompt: string }).prompt.matchAll(/User: (\S+)/g)].map((m) => m[1]!);
        if (users.some((u) => unreachableUsers.has(u))) return { value: null, failure: 'unreachable' };
        return { value: { memories: users.map((u) => ({ kind: 'fact', scope: 'project', content: `The user asked about ${u}.` })) } };
      }
      if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } };
      return { value: { contradicts: false, merged_ids: [], content: '' } };
    };
    service = new MemoryService(createFakePlatform());
    service.setConsolidationBroadcast((msg) => broadcasts.push(msg as never));
    setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation((() => 0) as unknown as typeof setTimeout);
    await service.ensureInitialized();
  });

  afterEach(async () => {
    setTimeoutSpy.mockRestore();
    runnerHolder.run = null;
    await service.dispose();
  });

  it('a manual run with a follow-up pass ends in one result that sums both passes', async () => {
    const db = service.database!;
    seed(db, 'alpha', '/ws/a', 1);
    seed(db, 'beta', '/ws/a', 2);
    seed(db, 'gamma', '/ws/b', 3);

    await service.triggerConsolidation();

    expect(results()).toHaveLength(1);
    const [run] = results();
    expect(run).toMatchObject({ trigger: 'manual', status: 'extracted', candidatesReviewed: 3 });
    expect(run!.failure).toBeUndefined();
    expect(run!.extracted.map((m) => m.content)).toEqual([
      'The user asked about alpha.',
      'The user asked about beta.',
      'The user asked about gamma.',
    ]);
    expect(service.getLastConsolidationResult()).toEqual(run);
    expect(runningFlags()).toEqual([true, false]);
    expect(broadcasts.filter((m) => m.type === 'consolidationProgress' && m.event!.phase === 'claim')).toHaveLength(2);
  });

  it('a manual run whose follow-up pass fails keeps the first pass\'s memories beside the failure', async () => {
    const db = service.database!;
    seed(db, 'alpha', '/ws/a', 1);
    seed(db, 'beta', '/ws/a', 2);
    seed(db, 'gamma', '/ws/b', 3);
    unreachableUsers.add('gamma');

    await service.triggerConsolidation();

    expect(results()).toHaveLength(1);
    const [run] = results();
    expect(run).toMatchObject({
      trigger: 'manual',
      status: 'failed',
      candidatesReviewed: 3,
      failure: { kind: 'error', reason: 'unreachable', phase: 'extract' },
    });
    expect(run!.extracted.map((m) => m.content)).toEqual(['The user asked about alpha.', 'The user asked about beta.']);
    expect(service.getLastConsolidationResult()).toEqual(run);
    expect(runningFlags()).toEqual([true, false]);
    expect(failures()).toBe(1);
    expect(service.getPendingCount()).toBe(1);
  });

  it('a pass that throws mid-run still ends the run with its earlier memories and the error', async () => {
    const db = service.database!;
    seed(db, 'alpha', '/ws/a', 1);
    seed(db, 'gamma', '/ws/b', 2);
    let extractStarts = 0;
    service.setConsolidationBroadcast((msg) => {
      broadcasts.push(msg as never);
      if (msg.type === 'consolidationProgress' && msg.event.phase === 'extract' && msg.event.status === 'active' && msg.event.meta?.done === 0) {
        extractStarts += 1;
        if (extractStarts === 2) throw new Error('boom');
      }
    });

    await service.triggerConsolidation();

    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ status: 'failed', candidatesReviewed: 2, failure: { kind: 'error', detail: 'boom' } });
    expect(results()[0]!.extracted.map((m) => m.content)).toEqual(['The user asked about alpha.']);
    expect(runningFlags()).toEqual([true, false]);
    expect(service.getPendingCount()).toBe(1);
  });

  it('a manual run cut short by memory being turned off still ends with what it extracted', async () => {
    const db = service.database!;
    seed(db, 'alpha', '/ws/a', 1);
    seed(db, 'gamma', '/ws/b', 2);
    let enabled = true;
    vi.spyOn(service, 'isEnabled', 'get').mockImplementation(() => enabled);
    service.setConsolidationBroadcast((msg) => {
      broadcasts.push(msg as never);
      if (msg.type === 'consolidationProgress' && msg.event.phase === 'profiles' && msg.event.status === 'done') enabled = false;
    });

    await service.triggerConsolidation();

    expect(results()).toHaveLength(1);
    expect(results()[0]).toMatchObject({ status: 'extracted', candidatesReviewed: 1 });
    expect(runningFlags()).toEqual([true, false]);
  });

  it('each automatic pass is its own run with its own result', async () => {
    const db = service.database!;
    seed(db, 'alpha', '/ws/a', 1);
    seed(db, 'gamma', '/ws/b', 2);

    await idleRun();
    await idleRun();

    expect(results().map((r) => [r.trigger, r.status, r.extracted.map((m) => m.content)])).toEqual([
      ['auto', 'extracted', ['The user asked about alpha.']],
      ['auto', 'extracted', ['The user asked about gamma.']],
    ]);
    expect(runningFlags()).toEqual([true, false, true, false]);
  });
});
