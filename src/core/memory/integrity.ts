import { Worker } from 'node:worker_threads';
import { log } from '../logger';
import {
  MEMORY_INTEGRITY_TIMEOUT_MS,
  MEMORY_INTEGRITY_WORKER_MARKER,
  type IntegrityEvent,
  type IntegrityRequest,
  type IntegrityResults,
  type IntegrityVerdict,
  type MemoryIntegrityWorkerData,
  type RepairOutcome,
} from './integrity-protocol';

export type { IntegrityVerdict, RepairOutcome } from './integrity-protocol';

/** How long the startup check holds memory writes; a slower check finishes while they go ahead (docs/invariants.md "Memory store"). */
export const MEMORY_WRITE_HOLD_MS = 5_000;

/**
 * How long dispose lets a running repair finish before it stops the worker. Desktop main kills core 3 s after asking it
 * to shut down and VS Code gives deactivate 5 s; a stopped repair resumes at the next start.
 */
const REPAIR_DISPOSE_GRACE_MS = 2_000;

/** The memory store's integrity check and repairs, each on its own worker thread (docs/invariants.md "Memory store"). */
export interface MemoryIntegrity {
  check(dbPath: string): Promise<IntegrityVerdict>;
  rebuildFts(dbPath: string): Promise<IntegrityVerdict>;
  repair(dbPath: string): Promise<RepairOutcome>;
  /** Stops every running check and rebuild at once and a repair after the grace; each rejects, as does any later request. */
  dispose(): Promise<void>;
}

interface Running {
  readonly type: IntegrityRequest['type'];
  readonly settled: Promise<void>;
  fail(err: Error): void;
}

export function createMemoryIntegrity(workerPath: string, timeoutMs: number = MEMORY_INTEGRITY_TIMEOUT_MS): MemoryIntegrity {
  const running = new Map<Worker, Running>();
  let disposed = false;

  function run<T extends IntegrityRequest>(request: T): Promise<IntegrityResults[T['type']]> {
    if (disposed) return Promise.reject(new Error('memory integrity was disposed'));
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerPath, { workerData: { marker: MEMORY_INTEGRITY_WORKER_MARKER, request } satisfies MemoryIntegrityWorkerData });
      const settle = (err: Error | null, result?: IntegrityResults[T['type']]): void => {
        if (!running.delete(worker)) return;
        clearTimeout(timer);
        if (err) {
          void worker.terminate();
          reject(err);
        } else {
          resolve(result!);
        }
      };
      const timer = setTimeout(() => settle(new Error(`memory integrity ${request.type} had no answer in ${timeoutMs} ms`)), timeoutMs);
      running.set(worker, { type: request.type, settled: settledOf(worker), fail: (err) => settle(err) });
      worker.on('message', (event: IntegrityEvent) => {
        if (event.type === 'log') log(event.message);
        else if (event.type === 'result') settle(null, event.result as IntegrityResults[T['type']]);
        else settle(new Error(event.message));
      });
      worker.on('error', (err) => settle(err));
      worker.on('exit', (code) => settle(new Error(`memory integrity worker exited with code ${code} before answering`)));
    });
  }

  return {
    check: (dbPath) => run({ type: 'check', dbPath }),
    rebuildFts: (dbPath) => run({ type: 'rebuildFts', dbPath }),
    repair: (dbPath) => run({ type: 'repair', dbPath }),
    async dispose() {
      disposed = true;
      const repairs = [...running.values()].filter((entry) => entry.type === 'repair').map((entry) => entry.settled);
      if (repairs.length > 0) await settledWithin(Promise.all(repairs), REPAIR_DISPOSE_GRACE_MS);
      const workers = [...running.keys()];
      for (const entry of [...running.values()]) entry.fail(new Error('memory integrity was disposed'));
      await Promise.all(workers.map((worker) => worker.terminate()));
    },
  };
}

function settledOf(worker: Worker): Promise<void> {
  return new Promise((resolve) => worker.once('exit', () => resolve()));
}

function settledWithin(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  return Promise.race([work, late]).then(() => clearTimeout(timer));
}
