import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import type { UsageStatsQuery, UsageStatsReport } from '../../../shared/types/usage-stats';

vi.mock('../../logger', () => ({ log: vi.fn() }));

import { log } from '../../logger';
import { UsageStatsService, type UsageStatsUpdate, type UsageStatsWorkerLike } from '../index';
import type { UsageStatsWorkerData, WorkerEvent, WorkerRequest } from '../worker-protocol';

class FakeWorker implements UsageStatsWorkerLike {
  readonly posted: WorkerRequest[] = [];
  terminated = false;
  private readonly listeners: { message: Array<(m: WorkerEvent) => void>; error: Array<(e: Error) => void>; exit: Array<(c: number) => void> } = {
    message: [], error: [], exit: [],
  };

  on(event: 'message', listener: (msg: WorkerEvent) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void {
    (this.listeners[event] as Array<(arg: never) => void>).push(listener);
  }

  postMessage(message: WorkerRequest): void {
    this.posted.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(msg: WorkerEvent): void {
    for (const l of this.listeners.message) l(msg);
  }

  crash(err: Error): void {
    for (const l of this.listeners.error) l(err);
  }

  exit(code: number): void {
    for (const l of this.listeners.exit) l(code);
  }

  lastQueryId(): number {
    const last = [...this.posted].reverse().find((m) => m.type === 'query');
    if (!last || last.type !== 'query') throw new Error('no query posted');
    return last.id;
  }
}

const QUERY: UsageStatsQuery = { startMs: 0, endMs: 1000, previous: null, modelKeys: [], projectKeys: [], bucket: 'day', timeZone: 'UTC', scan: true };
const TOTALS = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, netCacheSavings: 0, requests: 0, sessions: 0, activeDays: 0 };
const report = (indexedAtMs: number | null): UsageStatsReport => ({
  range: { startMs: 0, endMs: 1000 }, totals: TOTALS, previousTotals: null, filterOptions: { models: [], projects: [] }, indexedAtMs,
});

const REQUEST_TIMEOUT = 1_000;
const IDLE_TIMEOUT = 5_000;
const STALL_TIMEOUT = 30_000;

function setup() {
  const workers: FakeWorker[] = [];
  const workerData: UsageStatsWorkerData[] = [];
  const service = new UsageStatsService({
    workerPath: '/ext/dist/usage-stats-worker.js',
    paths: { sessionsDir: '/s', ledgerPath: '/l', dbPath: '/d' },
    workerFactory: (_path, data) => {
      const worker = new FakeWorker();
      workers.push(worker);
      workerData.push(data);
      return worker;
    },
    requestTimeoutMs: REQUEST_TIMEOUT,
    idleTimeoutMs: IDLE_TIMEOUT,
    stallTimeoutMs: STALL_TIMEOUT,
  });
  return { service, workers, workerData };
}

describe('UsageStatsService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts the worker lazily and sends paths, models and the query', async () => {
    const { service, workers } = setup();
    expect(workers).toHaveLength(0);
    const models = [{ key: 'anthropic/m', label: 'M', inputRatePerToken: 0.000003 }];
    const pending = service.query(QUERY, models, () => {});
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted[0]).toEqual({ type: 'query', id: 1, paths: { sessionsDir: '/s', ledgerPath: '/l', dbPath: '/d' }, models, query: QUERY });
    workers[0]!.emit({ type: 'result', id: 1, report: report(5), final: true });
    await expect(pending).resolves.toEqual(report(5));
  });

  it('forwards progress and the early report, then resolves with the final one', async () => {
    const { service, workers } = setup();
    const updates: UsageStatsUpdate[] = [];
    const pending = service.query(QUERY, [], (u) => updates.push(u));
    const w = workers[0]!;
    w.emit({ type: 'result', id: 1, report: report(1), final: false });
    w.emit({ type: 'progress', id: 1, filesDone: 1, filesTotal: 3 });
    w.emit({ type: 'result', id: 1, report: report(2), final: true });
    await expect(pending).resolves.toEqual(report(2));
    expect(updates).toEqual([{ type: 'result', report: report(1) }, { type: 'progress', filesDone: 1, filesTotal: 3 }]);
  });

  it('rejects with the worker error message', async () => {
    const { service, workers } = setup();
    const pending = service.query(QUERY, [], () => {});
    workers[0]!.emit({ type: 'error', id: 1, message: 'disk on fire' });
    await expect(pending).rejects.toThrow('disk on fire');
  });

  it('times out a request that hears nothing from the worker', async () => {
    const { service } = setup();
    const pending = service.query(QUERY, [], () => {});
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT);
    await assertion;
  });

  it('does not time out while a scan keeps emitting progress', async () => {
    const { service, workers } = setup();
    let settled = false;
    const pending = service.query(QUERY, [], () => {}).finally(() => { settled = true; });
    for (let i = 1; i <= 10; i++) {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT - 1);
      workers[0]!.emit({ type: 'progress', id: 1, filesDone: i, filesTotal: 10 });
    }
    expect(settled).toBe(false);
    workers[0]!.emit({ type: 'result', id: 1, report: report(9), final: true });
    await expect(pending).resolves.toEqual(report(9));
  });

  it('drops worker events for a request that already timed out', async () => {
    const { service, workers } = setup();
    const updates: UsageStatsUpdate[] = [];
    const pending = service.query(QUERY, [], (u) => updates.push(u));
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT);
    await assertion;
    workers[0]!.emit({ type: 'progress', id: 1, filesDone: 1, filesTotal: 2 });
    workers[0]!.emit({ type: 'result', id: 1, report: report(1), final: true });
    expect(updates).toEqual([]);
  });

  it('closes the worker after the idle period and starts a new one on the next query', async () => {
    const { service, workers } = setup();
    const first = service.query(QUERY, [], () => {});
    workers[0]!.emit({ type: 'result', id: 1, report: report(1), final: true });
    await first;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT - 1);
    expect(workers[0]!.posted.some((m) => m.type === 'close')).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'close' });

    const second = service.query(QUERY, [], () => {});
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: 'result', id: 2, report: report(2), final: true });
    await expect(second).resolves.toEqual(report(2));
  });

  it('never closes the worker mid-scan, even after the caller timed out', async () => {
    const { service, workers } = setup();
    const pending = service.query(QUERY, [], () => {});
    const assertion = expect(pending).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT);
    await assertion;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT * 3);
    expect(workers[0]!.posted.some((m) => m.type === 'close')).toBe(false);

    // The scan finally finishes; only then does the idle clock start.
    workers[0]!.emit({ type: 'result', id: 1, report: report(1), final: true });
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT);
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'close' });
  });

  it('a new query cancels the pending idle close', async () => {
    const { service, workers } = setup();
    const first = service.query(QUERY, [], () => {});
    workers[0]!.emit({ type: 'result', id: 1, report: report(1), final: true });
    await first;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT - 1);
    const second = service.query(QUERY, [], () => {});
    await vi.advanceTimersByTimeAsync(2);
    expect(workers[0]!.posted.some((m) => m.type === 'close')).toBe(false);
    workers[0]!.emit({ type: 'result', id: 2, report: report(2), final: true });
    await expect(second).resolves.toEqual(report(2));
    expect(workers).toHaveLength(1);
  });

  it('keeps overlapping scan requests apart: each gets its own progress, timer and final', async () => {
    const { service, workers } = setup();
    const aUpdates: UsageStatsUpdate[] = [];
    const bUpdates: UsageStatsUpdate[] = [];
    const a = service.query(QUERY, [], (u) => aUpdates.push(u));
    const b = service.query({ ...QUERY, modelKeys: ['p/m'] }, [], (u) => bUpdates.push(u));
    const w = workers[0]!;
    for (let i = 1; i <= 3; i++) {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT - 1);
      w.emit({ type: 'progress', id: 1, filesDone: i, filesTotal: 3 });
      w.emit({ type: 'progress', id: 2, filesDone: i, filesTotal: 3 });
    }
    w.emit({ type: 'result', id: 1, report: report(1), final: true });
    w.emit({ type: 'result', id: 2, report: report(2), final: true });
    await expect(a).resolves.toEqual(report(1));
    await expect(b).resolves.toEqual(report(2));
    expect(aUpdates).toHaveLength(3);
    expect(bUpdates).toHaveLength(3);
    expect(workers).toHaveLength(1);
  });

  it('rejects every in-flight request when the worker crashes, then recovers with a fresh worker', async () => {
    const { service, workers } = setup();
    const a = service.query(QUERY, [], () => {});
    const b = service.query({ ...QUERY, scan: false }, [], () => {});
    workers[0]!.crash(new Error('segfault'));
    await expect(a).rejects.toThrow('segfault');
    await expect(b).rejects.toThrow('segfault');
    const c = service.query(QUERY, [], () => {});
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: 'result', id: workers[1]!.lastQueryId(), report: report(3), final: true });
    await expect(c).resolves.toEqual(report(3));
  });

  it('rejects every in-flight request when the worker exits, then recovers with a fresh worker', async () => {
    const { service, workers } = setup();
    const a = service.query(QUERY, [], () => {});
    workers[0]!.exit(1);
    await expect(a).rejects.toThrow('usage stats worker exited with code 1');
    const b = service.query(QUERY, [], () => {});
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: 'result', id: workers[1]!.lastQueryId(), report: report(4), final: true });
    await expect(b).resolves.toEqual(report(4));
  });

  it('terminates a worker that stays silent with requests in flight, rejects them and starts a fresh one', async () => {
    const { service, workers } = setup();
    const first = service.query(QUERY, [], () => {});
    const timedOut = expect(first).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT);
    await timedOut;
    // A retry does not restart the stall clock.
    await vi.advanceTimersByTimeAsync(STALL_TIMEOUT - REQUEST_TIMEOUT - 500);
    const retry = service.query({ ...QUERY, scan: false }, [], () => {});
    const stalled = expect(retry).rejects.toThrow(/stopped responding/);
    await vi.advanceTimersByTimeAsync(500);
    await stalled;
    expect(workers[0]!.terminated).toBe(true);

    const next = service.query(QUERY, [], () => {});
    expect(workers).toHaveLength(2);
    workers[1]!.emit({ type: 'result', id: workers[1]!.lastQueryId(), report: report(5), final: true });
    await expect(next).resolves.toEqual(report(5));
  });

  it('keeps a worker that is still sending events, however long the scan runs', async () => {
    const { service, workers } = setup();
    const pending = service.query(QUERY, [], () => {});
    for (let i = 1; i <= 3 * (STALL_TIMEOUT / REQUEST_TIMEOUT); i++) {
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT - 1);
      workers[0]!.emit({ type: 'progress', id: 1, filesDone: i, filesTotal: 1_000 });
    }
    expect(workers[0]!.terminated).toBe(false);
    workers[0]!.emit({ type: 'result', id: 1, report: report(6), final: true });
    await expect(pending).resolves.toEqual(report(6));
  });

  it('still logs what a detached worker reports', async () => {
    const { service, workers } = setup();
    const first = service.query(QUERY, [], () => {});
    workers[0]!.emit({ type: 'result', id: 1, report: report(1), final: true });
    await first;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT);
    expect(workers[0]!.posted.at(-1)).toEqual({ type: 'close' });
    workers[0]!.emit({ type: 'log', message: '[UsageStats] close failed' });
    expect(log).toHaveBeenCalledWith('[UsageStats] close failed');
  });

  it('asks for quick_check until a worker has opened the index', async () => {
    const { service, workers, workerData } = setup();
    const crashed = service.query(QUERY, [], () => {});
    workers[0]!.crash(new Error('open failed'));
    await expect(crashed).rejects.toThrow('open failed');
    const opened = service.query(QUERY, [], () => {});
    workers[1]!.emit({ type: 'result', id: workers[1]!.lastQueryId(), report: report(1), final: true });
    await opened;
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT);
    const later = service.query(QUERY, [], () => {});
    workers[2]!.emit({ type: 'result', id: workers[2]!.lastQueryId(), report: report(2), final: true });
    await later;
    expect(workerData.map((d) => d.quickCheck)).toEqual([true, true, false]);
  });

  it('dispose terminates the worker, rejects in-flight requests and refuses new ones', async () => {
    const { service, workers } = setup();
    const pending = service.query(QUERY, [], () => {});
    service.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
    expect(workers[0]!.terminated).toBe(true);
    await expect(service.query(QUERY, [], () => {})).rejects.toThrow(/disposed/);
    expect(workers).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT + REQUEST_TIMEOUT);
    expect(vi.getTimerCount()).toBe(0);
  });
});
