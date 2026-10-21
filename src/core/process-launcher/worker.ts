// The launcher's worker thread: it starts processes and owns their pipes, so a slow start never blocks the host thread.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';
import { isMainThread, parentPort, workerData, type MessagePort } from 'node:worker_threads';
import crossSpawn from 'cross-spawn';
import { installWorkerLogRelay, log } from '../logger';
import {
  adoptShellSessionJob,
  createShellJob,
  createShellSessionJob,
  killProcessTree,
  sessionJobHandle,
  shellJobHandle,
  terminateJobHandle,
  type ShellJob,
  type ShellSessionJob,
} from '../pi-session/tools/process-tree';
import { LAUNCHER_WORKER_MARKER, MAX_UNACKED_BYTES, type LauncherEvent, type LauncherRequest, type LauncherWorkerData, type ReapTarget, type SpawnErrorInfo } from './protocol';
import { adoptSpawnLock, withSpawnLock } from './spawn-lock';

export type SpawnFunction = (file: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface LauncherHostDeps {
  readonly post: (event: LauncherEvent, transfer?: ArrayBuffer[]) => void;
  readonly sentinelPath?: string;
  // injectable so a test can make one start block
  readonly spawn?: SpawnFunction;
}

interface Running {
  readonly child: ChildProcess;
  readonly job: ShellJob | undefined;
  readonly detached: boolean;
  exited: boolean;
  unacked: number;
  paused: boolean;
  // restarts the exit output grace, which waits while output is paused
  armIdle(): void;
}

function errorInfo(err: unknown): SpawnErrorInfo {
  if (!(err instanceof Error)) return { message: String(err) };
  const { code, errno, syscall, path } = err as NodeJS.ErrnoException;
  return {
    message: err.message,
    ...(typeof code === 'string' ? { code } : {}),
    ...(typeof errno === 'number' ? { errno } : {}),
    ...(syscall !== undefined ? { syscall } : {}),
    ...(path !== undefined ? { path } : {}),
  };
}

// A transferable copy: a stream chunk may be a view into a pooled buffer.
function ownedCopy(chunk: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(chunk.byteLength);
  new Uint8Array(copy).set(chunk);
  return copy;
}

function reap(target: ReapTarget): void {
  if (target.job !== undefined) {
    terminateJobHandle(target.job);
    return;
  }
  if (process.platform === 'win32') {
    killProcessTree(target.pid);
    return;
  }
  try {
    process.kill(target.group ? -target.pid : target.pid, 'SIGKILL');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') log('[ProcessLauncher] could not kill pid %d left by a dead worker: %O', target.pid, err);
  }
}

/** Serves launcher requests on the calling thread; the worker runs one, and the in-process launcher for tests another. */
export function createLauncherHost(deps: LauncherHostDeps): (request: LauncherRequest) => void {
  const spawn: SpawnFunction = deps.spawn ?? ((file, args, options) => nodeSpawn(file, args, options));
  const running = new Map<number, Running>();
  const sessions = new Map<number, ShellSessionJob>();

  const start = (request: Extract<LauncherRequest, { type: 'spawn' }>): void => {
    const { id, spec } = request;
    const session = request.job === undefined ? undefined : (sessions.get(request.job.id) ?? (request.job.handle !== undefined ? adoptShellSessionJob(request.job.handle) : undefined));
    let child: ChildProcess;
    let job: ShellJob | undefined;
    // cmd.exe exits 1 for a file cross-spawn did not find, which cross-spawn reports as ENOENT
    let notFound: NodeJS.ErrnoException | undefined;
    try {
      const options: SpawnOptions = {
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.env !== undefined ? { env: spec.env } : {}),
        ...(spec.shell !== undefined ? { shell: spec.shell } : {}),
        detached: spec.detached ?? false,
        windowsHide: spec.windowsHide ?? true,
        ...(spec.windowsVerbatimArguments !== undefined ? { windowsVerbatimArguments: spec.windowsVerbatimArguments } : {}),
        stdio: [...(spec.stdio ?? ['pipe', 'pipe', 'pipe'])],
      };
      let start = { command: spec.file, args: [...spec.args], options };
      if (spec.crossSpawn) {
        // A worker thread cannot chdir, so cross-spawn would look up a relative path against the process's folder.
        const file = spec.cwd !== undefined && /[\\/]/.test(spec.file) && !path.isAbsolute(spec.file) ? path.resolve(spec.cwd, spec.file) : spec.file;
        const parsed = crossSpawn._parse(file, spec.args, options);
        if (process.platform === 'win32' && !parsed.file) notFound = crossSpawn._enoent.notFoundError(parsed.original, 'spawn');
        start = parsed;
      }
      child = withSpawnLock(() => spawn(start.command, start.args, start.options));
    } catch (err) {
      deps.post({ type: 'error', id, error: errorInfo(err) });
      return;
    }
    // The first statement after spawn: a process the child starts before the assignment stays outside the job for good.
    // A throw still leaves a started process, which stays tracked and killable without its job.
    try {
      job = child.pid !== undefined ? createShellJob(child.pid, session) : undefined;
    } catch (err) {
      log('[ProcessLauncher] process %d runs without its job, so a tree kill reaches only its pid or group: %O', child.pid, err);
    }
    let idle: NodeJS.Timeout | undefined;
    const entry: Running = {
      child,
      job,
      detached: spec.detached ?? false,
      exited: false,
      unacked: 0,
      paused: false,
      armIdle: () => {
        clearTimeout(idle);
        if (spec.exitOutputIdleMs === undefined || !entry.exited || entry.paused) return;
        // Runs beside the reads, so a worker held inside another start delays both alike.
        idle = setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, spec.exitOutputIdleMs);
      },
    };
    child.on('error', (err) => {
      // after a start, only a failed kill reports here, and the process still ends with exit and close
      if (child.pid !== undefined) {
        log('[ProcessLauncher] process %d reported an error: %s', child.pid, err.message);
        return;
      }
      deps.post({ type: 'error', id, error: errorInfo(err) });
    });
    if (child.pid === undefined) return;
    running.set(id, entry);
    const callJob = shellJobHandle(job);
    deps.post({ type: 'spawned', id, pid: child.pid, ...(callJob !== undefined ? { job: callJob } : {}) });
    const forward = (stream: 'stdout' | 'stderr') => (chunk: Buffer): void => {
      entry.unacked += chunk.byteLength;
      if (entry.unacked > MAX_UNACKED_BYTES && !entry.paused) {
        entry.paused = true;
        child.stdout?.pause();
        child.stderr?.pause();
      }
      const copy = ownedCopy(chunk);
      deps.post({ type: 'data', id, stream, chunk: copy }, [copy]);
      entry.armIdle();
    };
    child.stdout?.on('data', forward('stdout'));
    child.stderr?.on('data', forward('stderr'));
    // a write failure (EPIPE from a child that exited first) reaches its writer through the write's callback
    child.stdin?.on('error', () => undefined);
    child.on('exit', (code, signal) => {
      entry.exited = true;
      // POSIX: the sentinel's x record anchors the group's survivors, so it goes out as the process exits.
      if (process.platform !== 'win32') job?.dispose();
      if (notFound !== undefined && code === 1) deps.post({ type: 'error', id, error: errorInfo(notFound) });
      else deps.post({ type: 'exit', id, code, signal });
      entry.armIdle();
    });
    child.on('close', () => {
      clearTimeout(idle);
      // Windows: the call job outlives the exit, so a tree kill still reaches what the process left holding its output.
      if (process.platform === 'win32') job?.dispose();
      running.delete(id);
      deps.post({ type: 'close', id });
    });
  };

  return (request) => {
    switch (request.type) {
      case 'spawn':
        start(request);
        return;
      case 'write': {
        // a process already closed answers nothing: its client failed the write at the close
        const entry = running.get(request.id);
        if (!entry) return;
        const { id } = request;
        if (!entry.child.stdin) {
          deps.post({ type: 'written', id, error: { message: 'The process was started without a stdin pipe' } });
          return;
        }
        entry.child.stdin.write(request.chunk, (err) => deps.post({ type: 'written', id, ...(err ? { error: errorInfo(err) } : {}) }));
        return;
      }
      case 'end':
        running.get(request.id)?.child.stdin?.end();
        return;
      case 'kill': {
        const entry = running.get(request.id);
        // Once exited, only its job or its POSIX process group still names the tree; its pid may name another process.
        if (!entry || (entry.exited && (request.whileRunning || !(request.tree && (entry.job || (process.platform !== 'win32' && entry.detached)))))) return;
        if (!(request.tree && (process.platform === 'win32' || entry.detached))) {
          entry.child.kill(request.signal ?? 'SIGTERM');
          return;
        }
        // After the leader exits, the group may hold only processes this user cannot signal (EPERM); the worker serves on.
        try {
          if (process.platform !== 'win32' && request.signal !== undefined) process.kill(-entry.child.pid!, request.signal);
          else killProcessTree(entry.child.pid!, entry.job);
        } catch (err) {
          // ESRCH: the group is already empty
          if ((err as NodeJS.ErrnoException).code !== 'ESRCH') log('[ProcessLauncher] could not kill the process tree of %d: %O', entry.child.pid, err);
        }
        return;
      }
      case 'ack': {
        const entry = running.get(request.id);
        if (!entry) return;
        entry.unacked -= request.bytes;
        if (entry.paused && entry.unacked <= MAX_UNACKED_BYTES) {
          entry.paused = false;
          entry.child.stdout?.resume();
          entry.child.stderr?.resume();
          entry.armIdle();
        }
        return;
      }
      case 'createSessionJob': {
        const job = createShellSessionJob(deps.sentinelPath);
        if (job) sessions.set(request.job, job);
        const handle = sessionJobHandle(job);
        deps.post({ type: 'sessionJob', job: request.job, ...(handle !== undefined ? { handle } : {}), owned: job !== undefined && handle === undefined });
        return;
      }
      case 'closeSessionJob': {
        const owned = sessions.get(request.job);
        sessions.delete(request.job);
        (owned ?? (request.handle !== undefined ? adoptShellSessionJob(request.handle) : undefined))?.dispose();
        return;
      }
      case 'reap':
        for (const target of request.targets) reap(target);
        deps.post({ type: 'reaped' });
        return;
    }
  };
}

/** Wires a host to a worker's port; logs from shared modules go to the host thread's log. */
export function serveLauncher(port: MessagePort, deps: Omit<LauncherHostDeps, 'post'> = {}): void {
  installWorkerLogRelay((message) => port.postMessage({ type: 'log', message } satisfies LauncherEvent));
  const handle = createLauncherHost({ ...deps, post: (event, transfer) => port.postMessage(event, transfer ?? []) });
  port.on('message', (request: LauncherRequest) => handle(request));
}

const data = workerData as Partial<LauncherWorkerData> | undefined;
if (!isMainThread && parentPort && data?.marker === LAUNCHER_WORKER_MARKER) {
  adoptSpawnLock(data.spawnLock!);
  serveLauncher(parentPort, { sentinelPath: data.sentinelPath! });
}
