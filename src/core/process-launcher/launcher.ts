// The caller's side of a process the launcher started: its events arrive as messages, and its requests leave as messages.
import type { LauncherEvent, LauncherRequest, OutputStream, SpawnErrorInfo, SpawnSpec } from './protocol';

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface KillOptions {
  // the process and everything it started: its job (Windows) or its process group (POSIX, a detached start only)
  readonly tree?: boolean;
  // Node's default SIGTERM when left out; a POSIX tree kill sends it to the group (SIGKILL when left out), a Windows one ignores it
  readonly signal?: NodeJS.Signals;
  // the worker refuses the kill once it saw the process exit, however soon after the exit it arrives
  readonly whileRunning?: boolean;
}

export interface LaunchedProcess {
  // rejects with Node's spawn error when the process could not start
  readonly pid: Promise<number>;
  onData(stream: OutputStream, listener: (chunk: Buffer) => void): void;
  // resolves once the chunk reached the process's stdin; rejects with the write error, or when the process closes or fails first
  write(chunk: string | Uint8Array): Promise<void>;
  end(chunk?: string | Uint8Array): void;
  // Both reject when the process could not start or its worker died first.
  readonly exited: Promise<ProcessExit>;
  // after exited and every output stream closed
  readonly closed: Promise<void>;
  kill(options?: KillOptions): void;
}

/** A Windows job object with kill-on-close, or a POSIX sentinel: closing it kills every process started in it. */
export interface SessionJob {
  readonly id: number;
  dispose(): void;
}

export interface LaunchOptions {
  // aborting kills the process tree
  readonly signal?: AbortSignal;
}

export interface Launcher {
  launch(spec: SpawnSpec, options?: LaunchOptions): LaunchedProcess;
  createSessionJob(): SessionJob;
  dispose(): Promise<void>;
}

// Installed by the host before its first process start; tests install the in-process launcher.
let installed: Launcher | undefined;

/** Installs the process-wide launcher and returns the one it replaces. */
export function installProcessLauncher(launcher: Launcher): Launcher | undefined {
  const previous = installed;
  installed = launcher;
  return previous;
}

export function processLauncher(): Launcher {
  if (!installed) throw new Error('No process launcher installed: the host must call installProcessLauncher() before it starts a process');
  return installed;
}

/** What an aborted start or run rejects with. */
export function abortError(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}

export class LauncherWorkerDiedError extends Error {
  readonly code = 'ELAUNCHERDIED';

  constructor() {
    super('The process launcher worker that ran this process stopped');
    this.name = 'LauncherWorkerDiedError';
  }
}

export function spawnError(info: SpawnErrorInfo): Error {
  const { message, ...fields } = info;
  return Object.assign(new Error(message), fields);
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

// A rejection nobody awaits is expected (a caller reads one of the three promises), so none is reported as unhandled.
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => undefined);
  return { promise, resolve, reject };
}

export interface RemoteProcess {
  readonly process: LaunchedProcess;
  readonly id: number;
  deliver(event: Exclude<LauncherEvent, { type: 'sessionJob' } | { type: 'log' } | { type: 'reaped' }>): void;
  // the worker is gone: every promise still pending rejects
  fail(error: Error): void;
  readonly settled: boolean;
}

/** A process as its caller sees it; `send` carries its requests to the thread that started it. */
export function createRemoteProcess(id: number, send: (request: LauncherRequest, transfer?: ArrayBuffer[]) => void, options: LaunchOptions = {}): RemoteProcess {
  const pid = deferred<number>();
  const exited = deferred<ProcessExit>();
  const closed = deferred<void>();
  const listeners: Record<OutputStream, Array<(chunk: Buffer) => void>> = { stdout: [], stderr: [] };
  // one per write sent and not yet answered, in order
  const writes: Array<Deferred<void>> = [];
  let started = false;
  let exitedDone = false;
  let settled = false;
  const onAbort = (): void => send({ type: 'kill', id, tree: true });
  const finish = (writeError: Error): void => {
    settled = true;
    options.signal?.removeEventListener('abort', onAbort);
    for (const write of writes.splice(0)) write.reject(writeError);
  };
  const fail = (error: Error): void => {
    if (settled) return;
    finish(error);
    if (!started) pid.reject(error);
    if (!exitedDone) exited.reject(error);
    closed.reject(error);
  };
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const bytes = (chunk: string | Uint8Array): Uint8Array => {
    const source = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy;
  };
  const handle: LaunchedProcess = {
    pid: pid.promise,
    exited: exited.promise,
    closed: closed.promise,
    onData: (stream, listener) => void listeners[stream].push(listener),
    write: (chunk) => {
      const written = deferred<void>();
      if (settled) {
        written.reject(new Error('The process has closed'));
        return written.promise;
      }
      writes.push(written);
      const copy = bytes(chunk);
      send({ type: 'write', id, chunk: copy }, [copy.buffer as ArrayBuffer]);
      return written.promise;
    },
    end: (chunk) => {
      if (chunk !== undefined && (typeof chunk === 'string' ? chunk.length > 0 : chunk.byteLength > 0)) void handle.write(chunk);
      send({ type: 'end', id });
    },
    kill: (opts = {}) => {
      if (settled) return;
      send({ type: 'kill', id, tree: opts.tree ?? false, ...(opts.signal !== undefined ? { signal: opts.signal } : {}), ...(opts.whileRunning ? { whileRunning: true } : {}) });
    },
  };
  return {
    id,
    process: handle,
    get settled() {
      return settled;
    },
    fail,
    deliver: (event) => {
      if (settled) return;
      switch (event.type) {
        case 'spawned':
          started = true;
          pid.resolve(event.pid);
          return;
        case 'error':
          fail(spawnError(event.error));
          return;
        case 'data': {
          const chunk = Buffer.from(event.chunk);
          try {
            for (const listener of listeners[event.stream]) listener(chunk);
          } finally {
            // an unacknowledged chunk would hold the process's output paused for good
            send({ type: 'ack', id, bytes: chunk.byteLength });
          }
          return;
        }
        case 'written': {
          const written = writes.shift();
          if (event.error) written?.reject(spawnError(event.error));
          else written?.resolve();
          return;
        }
        case 'exit':
          exitedDone = true;
          exited.resolve({ code: event.code, signal: event.signal });
          return;
        case 'close':
          finish(new Error('The process closed before the write reached it'));
          closed.resolve();
          return;
      }
    },
  };
}
