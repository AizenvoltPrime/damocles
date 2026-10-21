import { EventEmitter } from 'node:events';
import type { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createLauncherPool, MAX_WORKERS, type Launcher } from '../index';
import type { LauncherEvent, LauncherRequest } from '../protocol';

/** A launcher worker the test answers for: it records what the pool posts and emits what the test sends. */
class FakeWorker extends EventEmitter {
  readonly posted: LauncherRequest[] = [];

  postMessage(request: LauncherRequest): void {
    this.posted.push(request);
    if (request.type === 'reap') queueMicrotask(() => this.answer({ type: 'reaped' }));
  }

  ref(): void {}
  unref(): void {}

  terminate(): Promise<number> {
    this.emit('exit', 1);
    return Promise.resolve(1);
  }

  answer(event: LauncherEvent): void {
    this.emit('message', event);
  }

  spawnIds(): number[] {
    return this.posted.flatMap((request) => (request.type === 'spawn' ? [request.id] : []));
  }
}

const pools: Launcher[] = [];

afterEach(async () => {
  await Promise.all(pools.splice(0).map((pool) => pool.dispose()));
});

function fakePool(): { launcher: Launcher; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const launcher = createLauncherPool({
    workerPath: 'unused',
    sentinelPath: 'unused',
    startWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
  });
  pools.push(launcher);
  return { launcher, workers };
}

const spec = { file: '/bin/true', args: [] } as const;
const reaps = (workers: readonly FakeWorker[]) => workers.flatMap((worker) => worker.posted.flatMap((request) => (request.type === 'reap' ? [request.targets] : [])));

describe('the process launcher pool', () => {
  it('queues a start once every one of MAX_WORKERS workers is inside a start, and sends it to the first that answers', () => {
    const { launcher, workers } = fakePool();
    for (let index = 0; index < MAX_WORKERS + 1; index++) launcher.launch(spec);

    expect(workers).toHaveLength(MAX_WORKERS);
    expect(workers.flatMap((worker) => worker.spawnIds())).toHaveLength(MAX_WORKERS);

    const third = workers[2]!;
    third.answer({ type: 'spawned', id: third.spawnIds()[0]!, pid: 4242 });

    expect(workers).toHaveLength(MAX_WORKERS);
    expect(third.spawnIds()).toHaveLength(2);
  });

  it('never starts a queued process whose signal aborted while it waited', async () => {
    const { launcher, workers } = fakePool();
    for (let index = 0; index < MAX_WORKERS; index++) launcher.launch(spec);
    const controller = new AbortController();
    const queued = launcher.launch(spec, { signal: controller.signal });
    const reason = new Error('stopped');
    controller.abort(reason);

    const first = workers[0]!;
    first.answer({ type: 'spawned', id: first.spawnIds()[0]!, pid: 4242 });

    await expect(queued.pid).rejects.toBe(reason);
    expect(workers.flatMap((worker) => worker.spawnIds())).toHaveLength(MAX_WORKERS);
    expect(workers.flatMap((worker) => worker.posted).filter((request) => request.type === 'kill')).toEqual([]);
  });

  it('reaps a dead worker\'s processes, but an exited one only through its job, never by a pid another process may hold', () => {
    const { launcher, workers } = fakePool();
    const run = (pid: number, exited: boolean, job?: bigint): FakeWorker => {
      launcher.launch(spec);
      const worker = workers.at(-1)!;
      const id = worker.spawnIds()[0]!;
      worker.answer({ type: 'spawned', id, pid, ...(job !== undefined ? { job } : {}) });
      if (exited) worker.answer({ type: 'exit', id, code: 0, signal: null });
      worker.emit('exit', 1);
      return worker;
    };

    run(4242, true);
    expect(reaps(workers)).toEqual([]);

    run(4343, true, 7n);
    expect(reaps(workers)).toEqual([[{ pid: 4343, group: false, job: 7n }]]);

    run(4444, false);
    expect(reaps(workers)).toEqual([[{ pid: 4343, group: false, job: 7n }], [{ pid: 4444, group: false }]]);
  });

  it('makes a session job living on one worker again on another once that worker died', () => {
    const { launcher, workers } = fakePool();
    const job = launcher.createSessionJob();
    launcher.launch({ ...spec, job: job.id });
    const owner = workers[0]!;
    expect(owner.posted.map((request) => request.type)).toEqual(['createSessionJob', 'spawn']);
    owner.answer({ type: 'sessionJob', job: job.id, owned: true });
    owner.answer({ type: 'spawned', id: owner.spawnIds()[0]!, pid: 4242 });
    owner.emit('exit', 1);

    launcher.launch({ ...spec, job: job.id });

    const next = workers.at(-1)!;
    expect(next).not.toBe(owner);
    expect(next.posted).toEqual([
      ...next.posted.filter((request) => request.type === 'reap'),
      { type: 'createSessionJob', job: job.id },
      expect.objectContaining({ type: 'spawn', job: { id: job.id } }),
    ]);
  });

  it('closes a shared session job from another worker once the worker that made it died', () => {
    const { launcher, workers } = fakePool();
    const job = launcher.createSessionJob();
    launcher.launch({ ...spec, job: job.id });
    const creator = workers[0]!;
    creator.answer({ type: 'sessionJob', job: job.id, handle: 99n, owned: false });
    creator.answer({ type: 'spawned', id: creator.spawnIds()[0]!, pid: 4242 });
    launcher.launch({ ...spec, job: job.id });
    const other = workers[1]!;
    expect(other.posted).toEqual([expect.objectContaining({ type: 'spawn', job: { id: job.id, handle: 99n } })]);
    other.answer({ type: 'spawned', id: other.spawnIds()[0]!, pid: 4343 });
    creator.emit('exit', 1);

    job.dispose();

    expect(other.posted.at(-1)).toEqual({ type: 'closeSessionJob', job: job.id, handle: 99n });
  });

  it('kills what is still running and closes shared session jobs when disposed, and starts no worker after', async () => {
    const { launcher, workers } = fakePool();
    const job = launcher.createSessionJob();
    const child = launcher.launch({ ...spec, job: job.id });
    const worker = workers[0]!;
    worker.answer({ type: 'sessionJob', job: job.id, handle: 99n, owned: false });
    worker.answer({ type: 'spawned', id: worker.spawnIds()[0]!, pid: 4242, job: 7n });

    await launcher.dispose();

    expect(workers).toHaveLength(2);
    expect(workers[1]!.posted).toEqual([
      { type: 'closeSessionJob', job: job.id, handle: 99n },
      { type: 'reap', targets: [{ pid: 4242, group: false, job: 7n }] },
    ]);
    await expect(child.exited).rejects.toThrow('disposed');
    job.dispose();
    expect(workers).toHaveLength(2);
  });
});
