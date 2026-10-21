import { Worker } from 'node:worker_threads';
import type { StoredSession } from '@shared/types/session';
import { log } from '../../../logger';
import {
  SESSION_META_INDEX_WORKER_MARKER,
  type MetaIndexEvent,
  type MetaIndexRequest,
  type SessionMetaEntry,
  type SessionMetaIndexWorkerData,
} from './protocol';

export interface MetaIndexWorkerLike {
  on(event: 'message', listener: (msg: MetaIndexEvent) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  postMessage(message: MetaIndexRequest): void;
  terminate(): Promise<number> | void;
  /** Held only while a request is in flight or the worker is closing, so an idle index never keeps its host alive. */
  ref(): void;
  unref(): void;
}

export type MetaIndexWorkerFactory = (workerPath: string, workerData: SessionMetaIndexWorkerData) => MetaIndexWorkerLike;

const defaultWorkerFactory: MetaIndexWorkerFactory = (workerPath, workerData) => new Worker(workerPath, { workerData });

// The index's own timers never keep the host alive; a worker held for a request does.
const unref = (timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> => {
  timer.unref();
  return timer;
};

/** A request fails after this long without an event for it; each list batch restarts the clock. */
export const META_INDEX_REQUEST_TIMEOUT_MS = 60_000;
/** A worker silent this long with a request in flight is wedged: it is terminated and replaced. */
export const META_INDEX_STALL_TIMEOUT_MS = 120_000;
export const META_INDEX_IDLE_TIMEOUT_MS: number = 5 * 60_000;
export const META_INDEX_CLOSE_TIMEOUT_MS = 2_000;

export interface SessionMetaIndexOptions {
  workerPath: string;
  cacheDir: string;
  piPackageDir: string;
  workerFactory?: MetaIndexWorkerFactory;
  requestTimeoutMs?: number;
  stallTimeoutMs?: number;
  idleTimeoutMs?: number;
  closeTimeoutMs?: number;
}

/** A list's first answer: the rows still valid and every session file it found. */
export interface ListedSessions {
  sessions: StoredSession[];
  files: string[];
  /** Files being parsed; their rows arrive through `ListProgress.batch`. */
  parsing: number;
}

export interface ListProgress {
  batch(sessions: StoredSession[]): void;
  /** No batch follows; `complete` is false when the list failed after its first answer or a file it found yielded no row, both logged. */
  end(complete: boolean): void;
}

export interface PromptHistory {
  prompts: string[];
  /** Files parsed to answer. */
  opened: number;
}

type BodyOf<R> = R extends { id: number } ? Omit<R, 'id'> : never;
type RequestBody = BodyOf<MetaIndexRequest>;
type RequestEvent = Exclude<MetaIndexEvent, { type: 'log' } | { type: 'error' }>;

interface InFlight {
  readonly id: number;
  readonly body: RequestBody;
  /** True once the caller has its answer or its failure; the entry stays until the worker finishes the request. */
  settled: boolean;
  retried: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** Returns true when the request is finished. */
  onEvent(event: RequestEvent): boolean;
  fail(err: Error): void;
}

/**
 * Session list metadata, single-file lookups and prompt history from a worker thread that owns the session
 * metadata index (docs/invariants.md "Session store"). The worker starts on first use and closes after
 * `idleTimeoutMs` with nothing in flight. A request whose worker crashed, exited or wedged runs once more
 * on a new worker. Puts and forgets go to the current worker in order, so a later request sees them.
 */
export class SessionMetaIndex {
  private readonly workerPath: string;
  private readonly workerData: SessionMetaIndexWorkerData;
  private readonly workerFactory: MetaIndexWorkerFactory;
  private readonly requestTimeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly closeTimeoutMs: number;
  private worker: MetaIndexWorkerLike | null = null;
  private readonly inFlight = new Map<number, InFlight>();
  private nextId = 1;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private closed: Promise<void> | null = null;
  /** Workers sent `close` and not yet exited or terminated. */
  private readonly stopping = new Set<Promise<void>>();

  constructor(options: SessionMetaIndexOptions) {
    this.workerPath = options.workerPath;
    this.workerData = { marker: SESSION_META_INDEX_WORKER_MARKER, cacheDir: options.cacheDir, piPackageDir: options.piPackageDir };
    this.workerFactory = options.workerFactory ?? defaultWorkerFactory;
    this.requestTimeoutMs = options.requestTimeoutMs ?? META_INDEX_REQUEST_TIMEOUT_MS;
    this.stallTimeoutMs = options.stallTimeoutMs ?? META_INDEX_STALL_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? META_INDEX_IDLE_TIMEOUT_MS;
    this.closeTimeoutMs = options.closeTimeoutMs ?? META_INDEX_CLOSE_TIMEOUT_MS;
  }

  /** Resolves with the rows still valid; rows of the files it parses arrive in batches through `progress`. */
  list(dir: string, progress: ListProgress): Promise<ListedSessions> {
    return new Promise((resolve, reject) => {
      let listed = false;
      this.request({ type: 'list', dir }, (event) => {
        if (event.type === 'listed') {
          // A replacement worker lists again; rows it finds valid were parsed by the worker it replaced.
          if (listed) progress.batch(event.sessions);
          else resolve({ sessions: event.sessions, files: event.files, parsing: event.parsing });
          listed = true;
          return false;
        }
        if (event.type === 'listBatch') {
          if (event.sessions.length > 0) progress.batch(event.sessions);
          return false;
        }
        if (event.type !== 'listDone') throw new Error(`unexpected ${event.type} answer to a list`);
        progress.end(event.complete);
        return true;
      }, (err) => {
        if (!listed) {
          reject(err);
          return;
        }
        log('[session-meta-index] list of %s ended before every file was parsed: %s', dir, err.message);
        progress.end(false);
      });
    });
  }

  /** The file's row, from the index when its size and mtime match, else parsed; null when it yields none. */
  meta(file: string): Promise<StoredSession | null> {
    return new Promise((resolve, reject) => {
      this.request({ type: 'meta', file }, (event) => {
        if (event.type !== 'meta') throw new Error(`unexpected ${event.type} answer to meta`);
        resolve(event.stored);
        return true;
      }, reject);
    });
  }

  /** The row cached for the file as it is now (null: the file yields no row), or undefined; never reads the file. */
  cachedRow(file: string): Promise<StoredSession | null | undefined> {
    return new Promise((resolve, reject) => {
      this.request({ type: 'cachedRow', file }, (event) => {
        if (event.type !== 'cachedRow') throw new Error(`unexpected ${event.type} answer to cachedRow`);
        resolve(event.found ? event.stored : undefined);
        return true;
      }, reject);
    });
  }

  /** Unique prompts of `sessionIds`' files in `dirs`, in that order, each file's newest first. */
  promptHistory(dirs: string[], sessionIds: string[]): Promise<PromptHistory> {
    return new Promise((resolve, reject) => {
      this.request({ type: 'promptHistory', dirs, sessionIds }, (event) => {
        if (event.type !== 'promptHistory') throw new Error(`unexpected ${event.type} answer to promptHistory`);
        resolve({ prompts: event.prompts, opened: event.opened });
        return true;
      }, reject);
    });
  }

  /** A live session's snapshot of its file; committed within 2 s, and seen by every later request. */
  put(file: string, entry: SessionMetaEntry): void {
    this.post({ type: 'put', file, entry });
  }

  forget(file: string): void {
    this.post({ type: 'forget', file });
  }

  /** Commits pending puts and stops the worker, and one an idle close is still stopping, waiting at most `closeTimeoutMs` each. Requests still in flight reject. */
  close(): Promise<void> {
    if (this.closed) return this.closed;
    this.clearIdleTimer();
    this.clearStallTimer();
    const err = new Error('the session metadata index is closed');
    for (const entry of this.inFlight.values()) this.settle(entry, err);
    this.inFlight.clear();
    const worker = this.worker;
    this.worker = null;
    this.closed = Promise.all([...this.stopping, ...(worker ? [this.stop(worker)] : [])]).then(() => undefined);
    return this.closed;
  }

  /** Held until the worker exits, so its commit finishes; terminated if that takes longer than `closeTimeoutMs`. */
  private stop(worker: MetaIndexWorkerLike): Promise<void> {
    worker.ref();
    const stopped = new Promise<void>((resolve) => {
      const timer = unref(setTimeout(() => {
        log('[session-meta-index] worker did not close within %dms; terminating it', this.closeTimeoutMs);
        void worker.terminate();
        resolve();
      }, this.closeTimeoutMs));
      worker.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      worker.postMessage({ type: 'close' });
    }).finally(() => this.stopping.delete(stopped));
    this.stopping.add(stopped);
    return stopped;
  }

  private post(message: MetaIndexRequest): void {
    if (this.closed) return;
    this.ensureWorker().postMessage(message);
    if (this.inFlight.size === 0) this.armIdleTimer();
  }

  private request(body: RequestBody, onEvent: InFlight['onEvent'], fail: InFlight['fail']): void {
    if (this.closed) {
      fail(new Error('the session metadata index is closed'));
      return;
    }
    this.clearIdleTimer();
    const entry: InFlight = { id: this.nextId++, body, settled: false, retried: false, timer: null, onEvent, fail };
    this.dispatch(entry);
  }

  private dispatch(entry: InFlight): void {
    const worker = this.ensureWorker();
    if (this.inFlight.size === 0) worker.ref();
    this.inFlight.set(entry.id, entry);
    this.armTimeout(entry);
    // A new request never restarts the stall clock, or retries would keep a wedged worker alive.
    if (!this.stallTimer) this.armStallTimer();
    worker.postMessage({ ...entry.body, id: entry.id } as MetaIndexRequest);
  }

  private ensureWorker(): MetaIndexWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.workerFactory(this.workerPath, this.workerData);
    this.worker = worker;
    worker.unref();
    worker.on('message', (msg) => {
      // A worker already detached by idle close may still log while it commits.
      if (msg.type === 'log') {
        log(msg.message);
        return;
      }
      if (this.worker !== worker) return;
      this.armStallTimer();
      this.onMessage(msg);
    });
    worker.on('error', (err) => {
      if (this.worker !== worker) return;
      log('[session-meta-index] worker error: %O', err);
      this.replace(err);
    });
    worker.on('exit', (code) => {
      if (this.worker !== worker) return;
      log('[session-meta-index] worker exited with code %d', code);
      this.replace(new Error(`the session metadata worker exited with code ${code}`));
    });
    return worker;
  }

  private onMessage(msg: Exclude<MetaIndexEvent, { type: 'log' }>): void {
    const entry = this.inFlight.get(msg.id);
    if (!entry) return;
    if (msg.type === 'error') {
      this.finish(entry);
      this.settle(entry, new Error(msg.message));
      return;
    }
    if (entry.settled) {
      if (msg.type !== 'listed' && msg.type !== 'listBatch') this.finish(entry);
      return;
    }
    let done: boolean;
    try {
      done = entry.onEvent(msg);
    } catch (err) {
      this.finish(entry);
      this.settle(entry, err instanceof Error ? err : new Error(String(err)));
      return;
    }
    if (done) {
      entry.settled = true;
      this.finish(entry);
    } else {
      this.armTimeout(entry);
    }
  }

  /** The worker is gone: each unsettled request runs once more on a new worker, or fails if it already did. */
  private replace(err: Error): void {
    this.worker = null;
    this.clearStallTimer();
    const entries = [...this.inFlight.values()];
    this.inFlight.clear();
    for (const entry of entries) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = null;
      if (entry.settled) continue;
      if (entry.retried) {
        this.settle(entry, err);
        continue;
      }
      entry.retried = true;
      this.dispatch(entry);
    }
    if (this.inFlight.size === 0) this.armIdleTimer();
  }

  private settle(entry: InFlight, err: Error): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    if (entry.settled) return;
    entry.settled = true;
    entry.fail(err);
  }

  private armTimeout(entry: InFlight): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = unref(setTimeout(() => {
      entry.timer = null;
      log('[session-meta-index] %s request %d had no answer from the worker for %dms', entry.body.type, entry.id, this.requestTimeoutMs);
      this.settle(entry, new Error(`session metadata ${entry.body.type} timed out after ${this.requestTimeoutMs}ms`));
    }, this.requestTimeoutMs));
  }

  private finish(entry: InFlight): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    this.inFlight.delete(entry.id);
    if (this.inFlight.size === 0) {
      this.worker?.unref();
      this.clearStallTimer();
      this.armIdleTimer();
    }
  }

  /** Restarts the stall clock while a request is in flight. */
  private armStallTimer(): void {
    this.clearStallTimer();
    const worker = this.worker;
    if (!worker || this.inFlight.size === 0) return;
    this.stallTimer = unref(setTimeout(() => {
      this.stallTimer = null;
      if (this.worker !== worker) return;
      log('[session-meta-index] worker sent nothing for %dms with %d requests in flight; replacing it', this.stallTimeoutMs, this.inFlight.size);
      void worker.terminate();
      this.replace(new Error(`the session metadata worker stopped responding for ${this.stallTimeoutMs}ms`));
    }, this.stallTimeoutMs));
  }

  private clearStallTimer(): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    if (this.closed || !this.worker) return;
    this.idleTimer = unref(setTimeout(() => {
      this.idleTimer = null;
      const worker = this.worker;
      if (!worker || this.inFlight.size > 0) return;
      this.worker = null;
      void this.stop(worker);
    }, this.idleTimeoutMs));
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
