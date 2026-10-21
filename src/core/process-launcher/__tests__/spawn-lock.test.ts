import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import { lockThreadSpawns, releaseSpawnLockOnExit, spawnLock, withSpawnLock } from '../spawn-lock';

describe('the spawn lock', () => {
  // A nested hold on one thread waits on itself in Atomics.wait, which no test timeout can interrupt.
  it.skipIf(process.platform !== 'win32')('lets a thread that holds it start a process its own spawn hook also locks, and frees it after', async () => {
    const unsubscribe = lockThreadSpawns();
    try {
      const child = withSpawnLock(() => withSpawnLock(() => spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' })));
      await once(child, 'exit');
    } finally {
      unsubscribe();
    }
    expect(Atomics.load(new Int32Array(spawnLock()), 0)).toBe(0);
  });

  it('is freed when a worker holding it is terminated, which skips its finally', async () => {
    // Takes the lock as withSpawnLock does, then waits forever.
    const holder = "const { parentPort, threadId, workerData } = require('node:worker_threads'); const lock = new Int32Array(workerData); Atomics.store(lock, 0, threadId + 1); parentPort.postMessage('held'); Atomics.wait(lock, 0, threadId + 1);";
    const worker = releaseSpawnLockOnExit(new Worker(holder, { eval: true, workerData: spawnLock() }));
    await once(worker, 'message');
    const lock = new Int32Array(spawnLock());
    expect(Atomics.load(lock, 0)).toBe(worker.threadId + 1);

    await worker.terminate();

    expect(Atomics.load(lock, 0)).toBe(0);
  });
});
