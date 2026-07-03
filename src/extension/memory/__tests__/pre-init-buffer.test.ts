import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import type { DatabaseInstance } from '../types';

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

// The sub-call runner reaches PiRuntime; stub it so init never touches the model layer.
vi.mock('../subcall-runner', () => ({
  createMemorySubCallRunner: () => ({ run: vi.fn(async () => ({ value: null, failure: 'no-model' as const })) }),
}));

import { MemoryService } from '../index';

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
} {
  return {
    sessionId: 'sess-buffer',
    promptIndex,
    userText: `user ${promptIndex}`,
    assistantText: `assistant ${promptIndex}`,
    files: [],
  };
}

describe('MemoryService pre-init turn-candidate buffering', () => {
  let service: MemoryService;

  beforeEach(() => {
    dbHolder.path = path.join(os.tmpdir(), `damocles-preinit-${crypto.randomUUID()}.db`);
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
    service.enqueueTurnCandidate(makeTurn(100));
    await new Promise((r) => setTimeout(r, 50));

    const db = service.database!;
    expect(countCandidates(db)).toBe(1);
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
    dbHolder.path = path.join(os.tmpdir(), `damocles-backoff-${crypto.randomUUID()}.db`);
    service = new MemoryService('/ext');
    scheduledDelays = [];
    // Spy the real timer (no fake clock) to read the delays armIdleTimer requests; callbacks never
    // fire in-window and dispose() clears the idle/jitter timers.
    setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: (...a: unknown[]) => void, delay?: number) => {
      scheduledDelays.push(delay ?? 0);
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
    service.dispose();
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbHolder.path + suffix);
      } catch {
        /* already gone */
      }
    }
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
