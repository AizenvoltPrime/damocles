// One queue of diff jobs served by one worker thread, one job at a time (docs/perf.md "Diff worker"). Core keeps the queue,
// so a crash or a watchdog stop is blamed on exactly the running job, and the jobs behind it run on a fresh worker.
import { Worker } from 'node:worker_threads';
import { log } from '../logger';
import { DIFF_WORKER_MARKER, overBudget, type DiffAnswer, type DiffJob, type DiffRequest, type DiffResult, type DiffWorkerData } from './protocol';

/** The service's start-failure switch, shared by its lanes. */
export interface LaneHealth {
  // switched off: every job answers over budget
  readonly off: () => boolean;
  readonly started: () => void;
  readonly startFailed: (detail: string) => void;
}

export interface DiffLaneOptions {
  readonly name: string;
  readonly entry: string;
  // how long past a job's own budget the watchdog waits before it stops the worker
  readonly graceMs: number;
  readonly idleMs: number;
  readonly heapMb: number;
  readonly health: LaneHealth;
}

interface Queued {
  readonly job: DiffJob;
  readonly resolve: (result: DiffResult<DiffJob>) => void;
  readonly reject: (err: Error) => void;
  readonly signal: AbortSignal | undefined;
}

// One listener per signal, however many queued jobs share it: a chat review passes one signal to all its jobs.
interface AbortWatch {
  readonly queued: Set<Queued>;
  readonly onAbort: () => void;
}

interface Running {
  readonly id: number;
  readonly queued: Queued;
  readonly watchdog: ReturnType<typeof setTimeout>;
  readonly postedAt: number;
}

export class DiffLane {
  private readonly options: DiffLaneOptions;
  private readonly queue: Queued[] = [];
  private readonly aborts = new Map<AbortSignal, AbortWatch>();
  private running: Running | undefined;
  private worker: Worker | undefined;
  // the worker posted ready; a worker that exits before it failed to start
  private ready = false;
  private startError = '';
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private nextId = 1;
  private closed = false;

  constructor(options: DiffLaneOptions) {
    this.options = options;
  }

  /** Runs the job after those queued before it; an abort while it is queued answers it over budget and it never runs. */
  run<J extends DiffJob>(job: J, signal?: AbortSignal): Promise<DiffResult<J>> {
    if (this.closed || this.options.health.off() || signal?.aborted) return Promise.resolve(overBudget(job));
    return new Promise<DiffResult<J>>((resolve, reject) => {
      const queued: Queued = { job, resolve: resolve as (result: DiffResult<DiffJob>) => void, reject, signal };
      if (signal) this.watch(queued, signal);
      this.queue.push(queued);
      this.pump();
    });
  }

  /** Answers every queued and running job over budget and stops the worker; later jobs answer over budget at once. */
  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.idleTimer);
    const worker = this.detach();
    this.endRunning();
    this.drain();
    await worker?.terminate();
  }

  private pump(): void {
    if (this.running || this.closed) return;
    if (this.options.health.off()) {
      this.drain();
      return;
    }
    const next = this.queue[0];
    if (!next) {
      this.armIdle();
      return;
    }
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
    const worker = this.worker ?? this.start();
    if (!worker) {
      // the head job could not run; the start-failure switch ends this loop
      this.queue.shift();
      this.unwatch(next);
      next.resolve(overBudget(next.job));
      this.pump();
      return;
    }
    if (!this.ready) return;
    this.queue.shift();
    this.unwatch(next);
    const id = this.nextId++;
    const watchdog = setTimeout(() => this.stall(), next.job.timeoutMs + this.options.graceMs);
    watchdog.unref();
    this.running = { id, queued: next, watchdog, postedAt: performance.now() };
    worker.postMessage({ id, job: next.job } satisfies DiffRequest);
  }

  // A constructor that throws (ERR_WORKER_INIT_FAILED) is a start failure, as an exit before ready is.
  private start(): Worker | undefined {
    let worker: Worker;
    try {
      worker = new Worker(this.options.entry, {
        workerData: { marker: DIFF_WORKER_MARKER } satisfies DiffWorkerData,
        resourceLimits: { maxOldGenerationSizeMb: this.options.heapMb },
      });
    } catch (err) {
      this.options.health.startFailed(err instanceof Error ? err.message : String(err));
      return undefined;
    }
    this.worker = worker;
    this.ready = false;
    this.startError = '';
    worker.on('message', (answer: DiffAnswer) => {
      if (this.worker === worker) this.answer(answer);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      if (this.ready) log('[diff] the %s worker failed: %O', this.options.name, err);
      else this.startError = err.message;
    });
    worker.on('exit', (code) => {
      if (this.worker === worker) this.exited(code);
    });
    // a core that is shutting down is never held open by an idle diff worker
    worker.unref();
    return worker;
  }

  private answer(answer: DiffAnswer): void {
    if (answer.type === 'ready') {
      this.ready = true;
      this.options.health.started();
      this.pump();
      return;
    }
    const running = this.running;
    if (running?.id !== answer.id) return;
    clearTimeout(running.watchdog);
    this.running = undefined;
    // a job that ran to its budget leaves its worker slower for every later job (docs/perf.md "Diff worker"), so the next gets a fresh one
    if (performance.now() - running.postedAt >= running.queued.job.timeoutMs) void this.detach()?.terminate();
    if (answer.type === 'done') running.queued.resolve(answer.result);
    else running.queued.reject(new Error(`the ${running.queued.job.kind} diff job failed: ${answer.message}`));
    this.pump();
  }

  private exited(code: number): void {
    const wasReady = this.ready;
    this.detach();
    if (!wasReady) this.options.health.startFailed(`exit code ${code}${this.startError ? `, ${this.startError}` : ''}`);
    else if (this.running) log('[diff] the %s worker stopped during a %s job (exit code %d); the job answered too large', this.options.name, this.running.queued.job.kind, code);
    this.endRunning();
    this.pump();
  }

  private stall(): void {
    const running = this.running;
    if (!running) return;
    log('[diff] a %s job on the %s worker ran past %d ms; the worker was stopped', running.queued.job.kind, this.options.name, running.queued.job.timeoutMs + this.options.graceMs);
    void this.detach()?.terminate();
    this.endRunning();
    this.pump();
  }

  private armIdle(): void {
    if (!this.worker || this.idleTimer) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.running || this.queue.length > 0) return;
      void this.detach()?.terminate();
    }, this.options.idleMs);
    this.idleTimer.unref();
  }

  // Forgets the worker, so its later messages and exit are ignored.
  private detach(): Worker | undefined {
    const worker = this.worker;
    this.worker = undefined;
    this.ready = false;
    return worker;
  }

  private endRunning(): void {
    const running = this.running;
    if (!running) return;
    clearTimeout(running.watchdog);
    this.running = undefined;
    running.queued.resolve(overBudget(running.queued.job));
  }

  private drain(): void {
    for (const queued of this.queue.splice(0)) {
      this.unwatch(queued);
      queued.resolve(overBudget(queued.job));
    }
  }

  private watch(queued: Queued, signal: AbortSignal): void {
    const watching = this.aborts.get(signal);
    if (watching) {
      watching.queued.add(queued);
      return;
    }
    const watch: AbortWatch = {
      queued: new Set([queued]),
      onAbort: () => {
        this.aborts.delete(signal);
        for (const aborted of watch.queued) {
          const at = this.queue.indexOf(aborted);
          if (at >= 0) this.queue.splice(at, 1);
          aborted.resolve(overBudget(aborted.job));
        }
      },
    };
    signal.addEventListener('abort', watch.onAbort, { once: true });
    this.aborts.set(signal, watch);
  }

  // A job leaving the queue other than by its signal's abort; the signal's listener goes with its last queued job.
  private unwatch(queued: Queued): void {
    const signal = queued.signal;
    const watch = signal && this.aborts.get(signal);
    if (!signal || !watch?.queued.delete(queued) || watch.queued.size > 0) return;
    signal.removeEventListener('abort', watch.onAbort);
    this.aborts.delete(signal);
  }
}
