import { Worker } from 'node:worker_threads';
import type { UsageStatsQuery, UsageStatsReport } from '../../shared/types/usage-stats';
import { log } from '../logger';
import {
  USAGE_STATS_WORKER_MARKER,
  type UsageStatsModel,
  type UsageStatsPaths,
  type UsageStatsProgress,
  type UsageStatsWorkerData,
  type WorkerEvent,
  type WorkerRequest,
} from './worker-protocol';

export type { UsageStatsModel, UsageStatsPaths, UsageStatsProgress } from './worker-protocol';

export interface UsageStatsWorkerLike {
  on(event: 'message', listener: (msg: WorkerEvent) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  postMessage(message: WorkerRequest): void;
  terminate(): Promise<number> | void;
}

export type UsageStatsWorkerFactory = (workerPath: string, workerData: UsageStatsWorkerData) => UsageStatsWorkerLike;

const defaultWorkerFactory: UsageStatsWorkerFactory = (workerPath, workerData) => new Worker(workerPath, { workerData });

/** A request fails after this long without any event from the worker; progress restarts the clock. */
export const USAGE_STATS_REQUEST_TIMEOUT_MS = 60_000;
export const USAGE_STATS_IDLE_TIMEOUT_MS = 120_000;
/** A worker silent this long with a request in flight is wedged, not slow: it is terminated and replaced. */
export const USAGE_STATS_STALL_TIMEOUT_MS = 300_000;

/** What arrives before the final report: indexing progress, or the cached report while a scan runs. */
export type UsageStatsUpdate = ({ type: 'progress' } & UsageStatsProgress) | { type: 'result'; report: UsageStatsReport };

export interface UsageStatsServiceOptions {
  workerPath: string;
  paths: UsageStatsPaths;
  workerFactory?: UsageStatsWorkerFactory;
  requestTimeoutMs?: number;
  idleTimeoutMs?: number;
  stallTimeoutMs?: number;
}

interface InFlight {
  /** True once the caller has its answer or its timeout; the entry stays until the worker finishes the request. */
  settled: boolean;
  resolve: (report: UsageStatsReport) => void;
  reject: (err: Error) => void;
  onUpdate: (update: UsageStatsUpdate) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Answers `/stats` queries from a worker thread that owns the usage index. The worker starts on first
 * use and is closed after `idleTimeoutMs` with nothing in flight, so it never stops while it makes progress.
 * A worker that sends nothing for `stallTimeoutMs` with a request in flight is terminated instead.
 * One service exists per extension host, so it decides when the index has been integrity-checked.
 */
export class UsageStatsService {
  private readonly workerPath: string;
  private readonly paths: UsageStatsPaths;
  private readonly workerFactory: UsageStatsWorkerFactory;
  private readonly requestTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private worker: UsageStatsWorkerLike | null = null;
  private readonly inFlight = new Map<number, InFlight>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once a worker in this process opened the index, which ran `quick_check`. */
  private indexVerified = false;
  private disposed = false;

  constructor(options: UsageStatsServiceOptions) {
    this.workerPath = options.workerPath;
    this.paths = options.paths;
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? USAGE_STATS_REQUEST_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? USAGE_STATS_IDLE_TIMEOUT_MS;
    this.stallTimeoutMs = options.stallTimeoutMs ?? USAGE_STATS_STALL_TIMEOUT_MS;
  }

  /** Resolves with the final report. `onUpdate` sees progress and an early cached report first, never after settling. */
  query(query: UsageStatsQuery, models: UsageStatsModel[], onUpdate: (update: UsageStatsUpdate) => void): Promise<UsageStatsReport> {
    if (this.disposed) return Promise.reject(new Error('UsageStatsService is disposed'));
    this.clearIdleTimer();
    const worker = this.ensureWorker();
    const id = this.nextId++;
    return new Promise<UsageStatsReport>((resolve, reject) => {
      const entry: InFlight = { settled: false, resolve, reject, onUpdate, timer: null };
      this.inFlight.set(id, entry);
      this.armTimeout(id, entry);
      // A new request never restarts the stall clock, or retries would keep a wedged worker alive.
      if (!this.stallTimer) this.armStallTimer();
      worker.postMessage({ type: 'query', id, paths: this.paths, models, query });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clearIdleTimer();
    const worker = this.worker;
    this.worker = null;
    this.failAll(new Error('UsageStatsService is disposed'));
    // Each file commits in its own transaction, so a scan cut short loses at most the file in progress.
    if (worker) void worker.terminate();
  }

  private ensureWorker(): UsageStatsWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory(this.workerPath, { marker: USAGE_STATS_WORKER_MARKER, quickCheck: !this.indexVerified });
    this.worker = worker;
    worker.on('message', (msg) => {
      // A worker already detached by idle close or a stall may still report why it failed.
      if (msg.type === 'log') log(msg.message);
      if (this.worker !== worker) return;
      this.armStallTimer();
      if (msg.type !== 'log') this.onMessage(msg);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      log('[UsageStats] Worker error: %O', err);
      this.worker = null;
      this.failAll(err);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      log('[UsageStats] Worker exited with code %d', code);
      this.worker = null;
      this.failAll(new Error(`usage stats worker exited with code ${code}`));
    });
    return worker;
  }

  private onMessage(msg: Exclude<WorkerEvent, { type: 'log' }>): void {
    // Any result means the worker opened the index, quick_check included.
    if (msg.type === 'result') this.indexVerified = true;
    const entry = this.inFlight.get(msg.id);
    if (!entry) return;
    if (msg.type === 'progress' || (msg.type === 'result' && !msg.final)) {
      if (entry.settled) return;
      this.armTimeout(msg.id, entry);
      entry.onUpdate(msg.type === 'progress'
        ? { type: 'progress', filesDone: msg.filesDone, filesTotal: msg.filesTotal }
        : { type: 'result', report: msg.report });
      return;
    }
    this.finish(msg.id, entry);
    if (entry.settled) return;
    entry.settled = true;
    if (msg.type === 'result') entry.resolve(msg.report);
    else entry.reject(new Error(msg.message));
  }

  private armTimeout(id: number, entry: InFlight): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => {
      entry.timer = null;
      if (entry.settled) return;
      entry.settled = true;
      log('[UsageStats] Request %d had no answer from the worker for %dms', id, this.requestTimeoutMs);
      entry.reject(new Error(`usage stats request timed out after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs);
  }

  private finish(id: number, entry: InFlight): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.inFlight.delete(id);
    if (this.inFlight.size === 0) {
      this.clearStallTimer();
      this.armIdleTimer();
    }
  }

  private failAll(err: Error): void {
    this.clearStallTimer();
    const entries = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      if (entry.settled) continue;
      entry.settled = true;
      entry.reject(err);
    }
  }

  /** Restarts the stall clock while a request is in flight. */
  private armStallTimer(): void {
    this.clearStallTimer();
    const worker = this.worker;
    if (!worker || this.inFlight.size === 0) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      if (this.worker !== worker) return;
      log('[UsageStats] Worker sent nothing for %dms with %d requests in flight; terminating it', this.stallTimeoutMs, this.inFlight.size);
      this.worker = null;
      this.failAll(new Error(`usage stats worker stopped responding for ${this.stallTimeoutMs}ms and was stopped; the next request starts a new one`));
      // Each file commits in its own transaction, so at most the file in progress is lost.
      void worker.terminate();
    }, this.stallTimeoutMs);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.disposed || !this.worker) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      const worker = this.worker;
      if (!worker || this.inFlight.size > 0) return;
      this.worker = null;
      worker.postMessage({ type: 'close' });
    }, this.idleTimeoutMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
