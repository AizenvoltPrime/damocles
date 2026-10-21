// One lock per process around every process creation on Windows, taken by each thread that starts processes; why and
// what it covers: docs/perf.md "Concurrent starts on Windows".
import { tracingChannel } from 'node:diagnostics_channel';
import { threadId, type Worker } from 'node:worker_threads';

// 0 while free, else the holder's threadId + 1
let word: Int32Array | undefined;

const lock = (): Int32Array => (word ??= new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)));

/** The process's lock, made by the first thread that asks; every worker that starts processes adopts it before its first start. */
export function spawnLock(): SharedArrayBuffer {
  return lock().buffer as SharedArrayBuffer;
}

export function adoptSpawnLock(buffer: SharedArrayBuffer): void {
  word = new Int32Array(buffer);
}

// This thread's nested holds: a start under withSpawnLock on a thread whose spawns lockThreadSpawns also locks.
let depth = 0;

function acquire(): void {
  if (depth > 0) {
    depth++;
    return;
  }
  const held = lock();
  for (;;) {
    const holder = Atomics.compareExchange(held, 0, 0, threadId + 1);
    if (holder === 0) break;
    Atomics.wait(held, 0, holder);
  }
  depth = 1;
}

function release(): void {
  if (--depth > 0) return;
  Atomics.store(lock(), 0, 0);
  Atomics.notify(lock(), 0, 1);
}

/**
 * Runs a synchronous start under the lock on Windows. An async spawn returns once uv_spawn closed the child's pipe ends;
 * a spawnSync holds the lock for its whole run.
 */
export function withSpawnLock<T>(start: () => T): T {
  if (process.platform !== 'win32') return start();
  acquire();
  try {
    return start();
  } finally {
    release();
  }
}

/** A worker terminated inside a start skips its finally, so its exit frees a lock it still holds. */
export function releaseSpawnLockOnExit(worker: Worker): Worker {
  const owner = worker.threadId + 1;
  const held = lock();
  worker.on('exit', () => {
    if (Atomics.compareExchange(held, 0, owner, 0) === owner) Atomics.notify(held, 0, 1);
  });
  return worker;
}

/**
 * Takes the lock around every async child_process start on the calling thread, which covers code that starts processes
 * on a host thread without the launcher. Node publishes these events from 24.15; spawnSync publishes none. Returns the
 * unsubscribe.
 */
export function lockThreadSpawns(): () => void {
  if (process.platform !== 'win32') return () => undefined;
  const channel = tracingChannel('child_process.spawn');
  channel.start.subscribe(acquire);
  channel.end.subscribe(release);
  channel.error.subscribe(release);
  return () => {
    channel.start.unsubscribe(acquire);
    channel.end.unsubscribe(release);
    channel.error.unsubscribe(release);
  };
}
