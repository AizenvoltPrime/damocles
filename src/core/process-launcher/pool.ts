// A pool of launcher workers; the sizing comes from docs/perf.md "Process launcher (S2 measurements)".
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { log } from '../logger';
import { abortError, createRemoteProcess, LauncherWorkerDiedError, type Launcher, type LaunchOptions, type RemoteProcess, type SessionJob } from './launcher';
import { LAUNCHER_WORKER_MARKER, type LauncherEvent, type LauncherRequest, type LauncherWorkerData, type ReapTarget, type SpawnSpec, type WireSessionJob } from './protocol';
import { releaseSpawnLockOnExit, spawnLock } from './spawn-lock';

// Workers started as starts need them and kept; past POOL_SIZE, more start only while every one is inside a start.
export const POOL_SIZE = 4;
export const MAX_WORKERS = 8;

export interface LauncherPoolOptions {
  readonly workerPath: string;
  readonly sentinelPath: string;
  // tests start workers that inject a spawn
  readonly startWorker?: () => Worker;
}

interface Slot {
  readonly worker: Worker;
  // spawns sent and not yet answered: the worker is inside a start
  starting: number;
  // processes sent to it that have not closed or failed
  readonly live: Set<number>;
  // retired, terminated or dead: it takes nothing more
  gone: boolean;
}

interface Proc {
  readonly remote: RemoteProcess;
  readonly spec: SpawnSpec;
  readonly signal: AbortSignal | undefined;
  slot: Slot | undefined;
  // requests made before the start was sent to a worker
  readonly early: Array<readonly [LauncherRequest, ArrayBuffer[] | undefined]>;
  answered: boolean;
  pid?: number;
  callJob?: bigint;
  // its pid may name another process once the worker that started it is gone
  exited: boolean;
  sessionJob?: Job | undefined;
}

interface Job {
  readonly id: number;
  owner: Slot | undefined;
  // pending: created on its owner, answer not in; shared: a Windows handle any worker may use; owned: lives on its owner
  // (a POSIX sentinel); none: could not be created, so its starts run without one
  state: 'pending' | 'shared' | 'owned' | 'none';
  handle?: bigint;
  // starts sent with it and not yet answered: its handle is not closed under them
  users: number;
  closing: boolean;
}

export function createLauncherPool(options: LauncherPoolOptions): Launcher {
  const slots: Slot[] = [];
  const procs = new Map<number, Proc>();
  const jobs = new Map<number, Job>();
  const queue: Proc[] = [];
  let nextId = 1;
  let nextJobId = 1;
  let disposed = false;

  const refresh = (slot: Slot): void => {
    // a worker keeps the host process alive only while it has work
    if (slot.starting > 0 || slot.live.size > 0) slot.worker.ref();
    else slot.worker.unref();
  };

  const owns = (slot: Slot): boolean => [...jobs.values()].some((job) => job.owner === slot && job.state !== 'shared' && job.state !== 'none');

  const maybeRetire = (slot: Slot): void => {
    if (slot.gone || slots.length <= POOL_SIZE || slot.starting > 0 || slot.live.size > 0 || owns(slot)) return;
    slot.gone = true;
    slots.splice(slots.indexOf(slot), 1);
    void slot.worker.terminate();
  };

  const startWorker = (): Worker => {
    const data: LauncherWorkerData = { marker: LAUNCHER_WORKER_MARKER, sentinelPath: options.sentinelPath, spawnLock: spawnLock() };
    return options.startWorker?.() ?? releaseSpawnLockOnExit(new Worker(options.workerPath, { env: SHARE_ENV, workerData: data }));
  };

  const addSlot = (): Slot => {
    const worker = startWorker();
    const slot: Slot = { worker, starting: 0, live: new Set(), gone: false };
    worker.on('message', (event: LauncherEvent) => onEvent(slot, event));
    worker.on('error', (err) => log('[ProcessLauncher] a launcher worker failed: %O', err));
    worker.on('exit', () => {
      if (!slot.gone) died(slot);
    });
    worker.unref();
    slots.push(slot);
    return slot;
  };

  // Up to POOL_SIZE, a start gets a worker of its own rather than share one, so a slow start delays no other output.
  const freeSlot = (): Slot | undefined => {
    let best: Slot | undefined;
    for (const slot of slots) if (slot.starting === 0 && (!best || slot.live.size < best.live.size)) best = slot;
    if (best && (best.live.size === 0 || slots.length >= POOL_SIZE)) return best;
    if (slots.length < MAX_WORKERS) return addSlot();
    return best;
  };

  // A job without a shared handle lives on one worker, so its starts run there even while it is inside a start.
  const slotFor = (proc: Proc): Slot | undefined => {
    const job = proc.sessionJob;
    if (!job || job.closing || job.state === 'shared' || job.state === 'none') return freeSlot();
    if (job.owner) return job.owner;
    const slot = freeSlot();
    if (slot) {
      job.owner = slot;
      job.state = 'pending';
      slot.worker.postMessage({ type: 'createSessionJob', job: job.id } satisfies LauncherRequest);
    }
    return slot;
  };

  const dispatch = (proc: Proc, slot: Slot): void => {
    proc.slot = slot;
    slot.starting++;
    slot.live.add(proc.remote.id);
    refresh(slot);
    const job = proc.sessionJob;
    let wire: WireSessionJob | undefined;
    if (job && !job.closing && job.state !== 'none') {
      wire = { id: job.id, ...(job.state === 'shared' && job.handle !== undefined ? { handle: job.handle } : {}) };
      job.users++;
    } else if (proc.spec.job !== undefined) {
      proc.sessionJob = undefined;
      if (!job || job.closing) log('[ProcessLauncher] a start named a closed session job, so it runs outside any session job');
    }
    const { job: _job, ...spec } = proc.spec;
    slot.worker.postMessage({ type: 'spawn', id: proc.remote.id, spec, ...(wire ? { job: wire } : {}) } satisfies LauncherRequest);
    for (const [request, transfer] of proc.early.splice(0)) slot.worker.postMessage(request, transfer ?? []);
  };

  const drain = (): void => {
    for (let index = 0; index < queue.length; ) {
      const proc = queue[index]!;
      // aborted while it waited for a worker: it never starts
      if (proc.signal?.aborted) {
        queue.splice(index, 1);
        procs.delete(proc.remote.id);
        proc.remote.fail(abortError(proc.signal));
        continue;
      }
      const slot = slotFor(proc);
      if (!slot) {
        index++;
        continue;
      }
      queue.splice(index, 1);
      dispatch(proc, slot);
    }
  };

  const closeJob = (job: Job): void => {
    if (disposed || !job.closing || job.users > 0 || (job.state === 'pending' && job.owner !== undefined)) return;
    jobs.delete(job.id);
    const owner = job.owner;
    if (!owner || job.state === 'none' || job.state === 'pending') return;
    // a Windows handle is process-wide, so another worker closes it once its creator is gone
    const closer = !owner.gone ? owner : job.state === 'shared' ? (slots[0] ?? addSlot()) : undefined;
    closer?.worker.postMessage({ type: 'closeSessionJob', job: job.id, ...(job.handle !== undefined ? { handle: job.handle } : {}) } satisfies LauncherRequest);
    if (!owner.gone) maybeRetire(owner);
  };

  const answer = (proc: Proc): void => {
    if (proc.answered) return;
    proc.answered = true;
    proc.slot!.starting--;
    const job = proc.sessionJob;
    if (job) {
      job.users--;
      closeJob(job);
    }
  };

  const release = (proc: Proc): void => {
    procs.delete(proc.remote.id);
    proc.slot!.live.delete(proc.remote.id);
    refresh(proc.slot!);
    maybeRetire(proc.slot!);
  };

  const onEvent = (slot: Slot, event: LauncherEvent): void => {
    if (event.type === 'log') {
      log(event.message);
      return;
    }
    if (event.type === 'reaped') return;
    if (event.type === 'sessionJob') {
      const job = jobs.get(event.job);
      if (!job || job.owner !== slot) return;
      job.state = event.handle !== undefined ? 'shared' : event.owned ? 'owned' : 'none';
      if (event.handle !== undefined) job.handle = event.handle;
      closeJob(job);
      return;
    }
    const proc = procs.get(event.id);
    if (!proc) return;
    if (event.type === 'spawned') {
      proc.pid = event.pid;
      if (event.job !== undefined) proc.callJob = event.job;
    }
    if (event.type === 'exit') proc.exited = true;
    proc.remote.deliver(event);
    if (event.type === 'spawned' || event.type === 'error') answer(proc);
    if (event.type === 'error' || event.type === 'close') release(proc);
    if (event.type === 'spawned' || event.type === 'error' || event.type === 'close') drain();
  };

  // A worker's end does not end its children. An exited process is reached only through its job or POSIX group: once its
  // worker is gone, its pid may name another process.
  const reapTarget = (proc: Proc): ReapTarget | undefined => {
    if (proc.pid === undefined) return undefined;
    const group = process.platform !== 'win32' && proc.spec.detached === true;
    if (proc.exited && !group && proc.callJob === undefined) return undefined;
    return { pid: proc.pid, group, ...(proc.callJob !== undefined ? { job: proc.callJob } : {}) };
  };

  const died = (slot: Slot): void => {
    slot.gone = true;
    slots.splice(slots.indexOf(slot), 1);
    const targets: ReapTarget[] = [];
    for (const id of slot.live) {
      const proc = procs.get(id);
      if (!proc) continue;
      procs.delete(id);
      const target = reapTarget(proc);
      if (target) targets.push(target);
      proc.remote.fail(new LauncherWorkerDiedError());
      if (!proc.answered && proc.sessionJob) {
        proc.sessionJob.users--;
        closeJob(proc.sessionJob);
      }
    }
    slot.live.clear();
    // a POSIX sentinel saw its pipe close and killed its groups; the job's next start makes a new one
    for (const job of jobs.values()) {
      if (job.owner !== slot || job.state === 'shared') continue;
      job.owner = undefined;
      job.state = 'pending';
      closeJob(job);
    }
    log('[ProcessLauncher] a launcher worker stopped; %d of its processes are reaped', targets.length);
    if (disposed) return;
    if (targets.length > 0) addSlot().worker.postMessage({ type: 'reap', targets } satisfies LauncherRequest);
    drain();
  };

  return {
    launch(spec, launchOptions: LaunchOptions = {}) {
      const id = nextId++;
      const remote = createRemoteProcess(
        id,
        (request, transfer) => {
          // nothing goes out for a process that failed or closed
          const proc = procs.get(id);
          if (!proc) return;
          if (proc.slot) proc.slot.worker.postMessage(request, transfer ?? []);
          else proc.early.push([request, transfer]);
        },
        launchOptions,
      );
      if (disposed || launchOptions.signal?.aborted) {
        remote.fail(disposed ? new Error('The process launcher was disposed') : abortError(launchOptions.signal!));
        return remote.process;
      }
      const sessionJob = spec.job !== undefined ? jobs.get(spec.job) : undefined;
      const proc: Proc = { remote, spec, signal: launchOptions.signal, slot: undefined, early: [], answered: false, exited: false, ...(sessionJob ? { sessionJob } : {}) };
      procs.set(id, proc);
      queue.push(proc);
      drain();
      return remote.process;
    },
    createSessionJob(): SessionJob {
      const job: Job = { id: nextJobId++, owner: undefined, state: 'pending', users: 0, closing: false };
      jobs.set(job.id, job);
      return {
        id: job.id,
        dispose: () => {
          if (job.closing) return;
          job.closing = true;
          closeJob(job);
        },
      };
    },
    // Kills every process still running and closes every shared session job, as the host's exit would.
    async dispose() {
      if (disposed) return;
      disposed = true;
      const error = new Error('The process launcher was disposed');
      const targets: ReapTarget[] = [];
      for (const proc of procs.values()) {
        const target = reapTarget(proc);
        if (target) targets.push(target);
        proc.remote.fail(error);
      }
      procs.clear();
      queue.length = 0;
      const sharedJobs = [...jobs.values()].filter((job) => job.state === 'shared' && job.handle !== undefined);
      jobs.clear();
      // a POSIX sentinel sees its pipe close as its worker ends, and kills its groups
      await Promise.all(slots.splice(0).map((slot) => {
        slot.gone = true;
        return slot.worker.terminate();
      }));
      if (targets.length === 0 && sharedJobs.length === 0) return;
      const reaper = startWorker();
      await new Promise<void>((resolve) => {
        reaper.on('message', (event: LauncherEvent) => {
          if (event.type === 'log') log(event.message);
          if (event.type === 'reaped') resolve();
        });
        reaper.on('error', (err) => log('[ProcessLauncher] the worker reaping a disposed launcher\'s processes failed: %O', err));
        reaper.on('exit', () => resolve());
        for (const job of sharedJobs) reaper.postMessage({ type: 'closeSessionJob', job: job.id, handle: job.handle! } satisfies LauncherRequest);
        reaper.postMessage({ type: 'reap', targets } satisfies LauncherRequest);
      });
      await reaper.terminate();
    },
  };
}
