import * as fs from 'node:fs';
import type { FsWatchTreeHost, Log, RawListener } from '../../watch-worker/fs-watch-tree';
import { parseWatchReply, type WatchRequest } from '../../watch-worker/protocol';
import { settlePending } from '../../../shared/settle-pending';

/** What the host needs of a worker thread; node:worker_threads' Worker is one. */
export interface WatchWorker {
  postMessage(request: WatchRequest): void;
  on(event: 'message', listener: (message: unknown) => void): unknown;
  on(event: 'messageerror' | 'error', listener: (err: Error) => void): unknown;
  on(event: 'exit', listener: (code: number) => void): unknown;
  terminate(): Promise<number>;
}

// A worker that has failed this many times is restarted no more, as VS Code's watcher gives up after 5 restarts.
export const MAX_WORKER_RESTARTS = 5;

interface Watch {
  readonly dir: string;
  readonly emit: RawListener;
  readonly lost: () => void;
}

interface Running {
  readonly worker: WatchWorker;
}

/**
 * Runs the Windows recursive watches on dist/watch-worker.js, started by the first watch; docs/invariants.md "Windows watches
 * recursively". A worker that fails is replaced at once by a fresh one that watches every live root again without reporting
 * what it holds, up to MAX_WORKER_RESTARTS times; after that every watch fires nothing.
 */
export function createWorkerTreeHost(startWorker: () => WatchWorker, log: Log): FsWatchTreeHost {
  let running: Running | undefined;
  let closed = false;
  let nextId = 0;
  let failures = 0;
  // Every live watch, by id; ids are never reused, so a restarted worker keeps each watch's id.
  const watches = new Map<number, Watch>();
  const exits = new Set<Promise<void>>();

  const stopWorker = (run: Running): void => {
    run.worker.terminate().catch((err: unknown) => log(`[watcher] stopping the watch worker failed: ${err instanceof Error ? err.message : String(err)}`));
  };

  // The snapshot each watch diffed against died with the worker, so the fresh one only records what it finds (report: false).
  const fail = (run: Running, reason: string): void => {
    if (running !== run) return;
    running = undefined;
    failures++;
    log(`[watcher] the watch worker ${reason}`);
    stopWorker(run);
    if (failures > MAX_WORKER_RESTARTS) {
      log(`[watcher] the watch worker failed ${failures} times; Windows folders are not watched until Damocles restarts`);
      watches.clear();
      return;
    }
    if (closed || watches.size === 0) return;
    const restarted = (running = spawn());
    for (const [id, watch] of watches) restarted.worker.postMessage({ kind: 'watch', id, dir: watch.dir, report: false });
    log(`[watcher] the watch worker restarted; ${watches.size} watches re-established`);
  };

  const receive = (run: Running, message: unknown): void => {
    if (running !== run) return;
    const reply = parseWatchReply(message);
    if (!reply) {
      fail(run, 'sent a malformed reply');
      return;
    }
    if (reply.kind === 'log') {
      log(reply.line);
      return;
    }
    if (reply.kind === 'closed') {
      if (!closed) {
        fail(run, 'closed unasked');
        return;
      }
      running = undefined;
      stopWorker(run);
      return;
    }
    // A watch main disposed has no entry, so whatever the worker sent before the unwatch reached it is dropped.
    const watch = watches.get(reply.id);
    if (!watch) return;
    if (reply.kind === 'events') {
      for (const [type, fsPath] of reply.events) {
        if (watches.get(reply.id) !== watch) return;
        watch.emit(type, fsPath);
      }
      return;
    }
    watches.delete(reply.id);
    if (reply.kind === 'failed') {
      log(`[watcher] could not watch ${watch.dir}: ${reply.message}`);
      // As when the watch fails on main: only a directory that vanished meanwhile is waited for again.
      if (fs.existsSync(watch.dir)) return;
    }
    watch.lost();
  };

  const spawn = (): Running => {
    const worker = startWorker();
    const run: Running = { worker };
    const exited = new Promise<void>((resolve) => {
      worker.on('exit', (code) => {
        exits.delete(exited);
        resolve();
        fail(run, `exited with ${code}`);
      });
    });
    exits.add(exited);
    worker.on('message', (message) => receive(run, message));
    worker.on('error', (err) => fail(run, `failed: ${err.message}`));
    worker.on('messageerror', (err) => fail(run, `sent a message that could not be read: ${err.message}`));
    return run;
  };

  return {
    start: (dir, report, emit, lost) => {
      if (closed || failures > MAX_WORKER_RESTARTS) return { dispose: () => undefined };
      const run = (running ??= spawn());
      const id = nextId++;
      watches.set(id, { dir, emit, lost });
      run.worker.postMessage({ kind: 'watch', id, dir, report });
      return {
        dispose: () => {
          if (watches.delete(id)) running?.worker.postMessage({ kind: 'unwatch', id });
        },
      };
    },
    // The worker stops its watches and answers once its scans settle; only then is it terminated, and this settles on its exit.
    close: async () => {
      closed = true;
      watches.clear();
      running?.worker.postMessage({ kind: 'close' });
      await settlePending(() => exits);
    },
  };
}
