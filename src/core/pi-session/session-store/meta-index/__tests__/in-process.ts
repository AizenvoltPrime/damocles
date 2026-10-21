import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { StoredSession } from '@shared/types/session';
import { REPO_ROOT } from '../../../../../__mocks__/source-tree';
import { SESSION_META_CACHE_DIR } from '../../../../paths';
import { piSessionDir } from '../../session-dir';
import { SessionMetaIndex, type MetaIndexWorkerFactory, type MetaIndexWorkerLike, type SessionMetaIndexOptions } from '../client';
import type { MetaIndexEvent, MetaIndexRequest, SessionMetaIndexWorkerData } from '../protocol';
import { createMetaIndexRuntime, type MetaIndexRuntime, type MetaIndexRuntimeOptions } from '../worker';

export const PI_PACKAGE_DIR = path.join(REPO_ROOT, 'node_modules', '@earendil-works', 'pi-coding-agent');

/** pi as the worker imports it, the same module instance, so a spy on its `SessionManager.open` sees the worker's parses. */
export async function workerPi(): Promise<typeof import('@earendil-works/pi-coding-agent')> {
  return (await import(pathToFileURL(path.join(PI_PACKAGE_DIR, 'dist', 'index.js')).href)) as typeof import('@earendil-works/pi-coding-agent');
}

/** The worker runtime on this thread, with each message cloned and delivered on its own turn, in order, like a port. */
export class InProcessWorker implements MetaIndexWorkerLike {
  readonly runtime: MetaIndexRuntime;
  readonly posted: MetaIndexRequest[] = [];
  private gone = false;
  private readonly listeners: { message: Array<(m: MetaIndexEvent) => void>; error: Array<(e: Error) => void>; exit: Array<(c: number) => void> } = {
    message: [], error: [], exit: [],
  };

  constructor(data: SessionMetaIndexWorkerData, overrides: Partial<MetaIndexRuntimeOptions> = {}) {
    this.runtime = createMetaIndexRuntime((event) => {
      const copy = structuredClone(event);
      setImmediate(() => {
        if (!this.gone) for (const l of this.listeners.message) l(copy);
      });
    }, { cacheDir: data.cacheDir, piPackageDir: data.piPackageDir, ...overrides });
  }

  on(event: 'message', listener: (msg: MetaIndexEvent) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number) => void): void;
  on(event: 'message' | 'error' | 'exit', listener: (arg: never) => void): void {
    (this.listeners[event] as Array<(arg: never) => void>).push(listener);
  }

  postMessage(message: MetaIndexRequest): void {
    this.posted.push(message);
    const copy = structuredClone(message);
    setImmediate(() => {
      if (this.gone) return;
      if (copy.type !== 'close') {
        this.runtime.handle(copy);
        return;
      }
      void this.runtime.close().finally(() => this.exit(0));
    });
  }

  terminate(): void {
    this.exit(1);
  }

  /** Nothing to hold: the runtime runs on the test's own thread. */
  ref(): void {}

  unref(): void {}

  /** An uncaught exception in the worker: `error`, then `exit`. */
  crash(err: Error): void {
    if (this.gone) return;
    for (const l of this.listeners.error) l(err);
    this.exit(1);
  }

  private exit(code: number): void {
    if (this.gone) return;
    this.gone = true;
    // The runtime keeps running on this thread; closing it releases the index file.
    this.runtime.close().catch(() => undefined);
    for (const l of this.listeners.exit) l(code);
  }
}

export function inProcessIndex(
  options: Partial<SessionMetaIndexOptions> & { runtime?: Partial<MetaIndexRuntimeOptions> } = {},
): { index: SessionMetaIndex; workers: InProcessWorker[] } {
  const { runtime, ...clientOptions } = options;
  const workers: InProcessWorker[] = [];
  const factory: MetaIndexWorkerFactory = (_path, data) => {
    const worker = new InProcessWorker(data, runtime);
    workers.push(worker);
    return worker;
  };
  const index = new SessionMetaIndex({
    workerPath: path.join(REPO_ROOT, 'dist', 'session-meta-index-worker.js'),
    cacheDir: SESSION_META_CACHE_DIR,
    piPackageDir: PI_PACKAGE_DIR,
    ...clientOptions,
    workerFactory: factory,
  });
  return { index, workers };
}

/** Every row of `cwd`'s session dir once the index parsed all of it, newest first. */
export async function listComplete(index: SessionMetaIndex, cwd: string): Promise<StoredSession[]> {
  const parsed: StoredSession[] = [];
  let end!: (complete: boolean) => void;
  const finished = new Promise<void>((resolve, reject) => {
    end = (complete) => (complete ? resolve() : reject(new Error('the list ended before every file was parsed')));
  });
  const listed = await index.list(piSessionDir(cwd), { batch: (rows) => parsed.push(...rows), end });
  await finished;
  return [...listed.sessions, ...parsed].sort((a, b) => b.timestamp - a.timestamp);
}
