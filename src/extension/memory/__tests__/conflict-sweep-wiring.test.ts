import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestMemoryDb } from './test-helpers';
import { MemoryWriteQueue } from '../write-queue';
import { FactGraphManager } from '../managers/fact-graph-manager';
import { ProfileManager } from '../managers/profile-manager';
import type { DatabaseInstance } from '../types';
import type { MemorySubCallRequest, MemorySubCallResult, MemorySubCallRunner } from '../subcall-runner';

/**
 * `runMaintenance` must call `sweepConflictChecks` before `maybeVacuum` so the deferred-conflict
 * re-check runs before free-list reclamation. Driven through a candidate-free `runConsolidation`
 * (the maintain phase runs even on an empty pass); `maybeVacuum` is wrapped, not stubbed, via a
 * partial module mock so every other step keeps its real behaviour.
 */

const ORDER: string[] = [];

vi.mock('../dedup-decay', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../dedup-decay')>();
  return {
    ...actual,
    maybeVacuum: vi.fn(async (...args: Parameters<typeof actual.maybeVacuum>) => {
      ORDER.push('maybeVacuum');
      return actual.maybeVacuum(...args);
    }),
  };
});

// Imported AFTER the mock so runConsolidation binds to the wrapped maybeVacuum.
import { runConsolidation, type ConsolidationCtx } from '../consolidation';

/** Benign runner; with no candidates extract is never called, but keep the shape valid. */
const benignRunner: MemorySubCallRunner = {
  async run<T>(req: MemorySubCallRequest): Promise<MemorySubCallResult<T>> {
    if (req.purpose === 'profile') return { value: { static: '', dynamic: '' } as T };
    return { value: { contradicts: false, merged_ids: [], content: '' } as T };
  },
};

describe('Slice 8 C4 — runMaintenance wires sweepConflictChecks BEFORE maybeVacuum', () => {
  let db: DatabaseInstance;

  beforeEach(async () => {
    db = await createTestMemoryDb();
    ORDER.length = 0;
  });

  it('calls sweepConflictChecks and then maybeVacuum, in that order, during a maintenance pass', async () => {
    const writeQueue = new MemoryWriteQueue(db);
    const factGraph = new FactGraphManager(db, writeQueue, benignRunner);
    // Records order, then delegates to the real method (returns 0 processed on an empty DB).
    const sweepSpy = vi
      .spyOn(factGraph, 'sweepConflictChecks')
      .mockImplementation(async (limit?: number) => {
        ORDER.push('sweepConflictChecks');
        return FactGraphManager.prototype.sweepConflictChecks.call(factGraph, limit);
      });

    const ctx: ConsolidationCtx = {
      db,
      writeQueue,
      instanceId: 'test-instance',
      runner: benignRunner,
      factGraph,
      profileManager: new ProfileManager(db, writeQueue, benignRunner),
      reason: 'switch',
      sessionId: 'sess-x',
      workspace: '/tmp/ws',
      autoExtractEnabled: true,
      trigger: 'auto',
      onNoModel: () => {},
      isDisposed: () => false,
    };

    // Zero candidates → status 'empty', but the maintain phase still runs.
    const result = await runConsolidation(ctx);
    expect(result.status).toBe('empty');

    expect(sweepSpy).toHaveBeenCalledTimes(1);
    expect(ORDER).toContain('sweepConflictChecks');
    expect(ORDER).toContain('maybeVacuum');
    expect(ORDER.indexOf('sweepConflictChecks')).toBeLessThan(ORDER.indexOf('maybeVacuum'));
  });
});
