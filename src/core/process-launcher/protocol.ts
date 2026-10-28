// Messages between a launcher client and the thread that starts its processes; no electron or vscode import.

export const LAUNCHER_WORKER_MARKER = 'damocles-process-launcher';

/** A worker pauses a child's output once this much is unacknowledged by the client. */
export const MAX_UNACKED_BYTES: number = 1024 * 1024;

// 'overlapped' is 'pipe' whose child end has FILE_FLAG_OVERLAPPED on Windows, as Win32-OpenSSH gives a session's command
export type StdioMode = 'pipe' | 'overlapped' | 'ignore' | 'inherit';
export type OutputStream = 'stdout' | 'stderr';

/** Every option a process start takes; `job` names a session job from the same launcher. */
export interface SpawnSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly shell?: boolean | string;
  readonly detached?: boolean;
  readonly windowsHide?: boolean;
  readonly windowsVerbatimArguments?: boolean;
  // as cross-spawn starts it: on Windows the file is found through PATH and PATHEXT, and a .cmd or .bat runs through cmd.exe
  readonly crossSpawn?: boolean;
  // stdin, stdout, stderr; each is 'pipe' when left out
  readonly stdio?: readonly [StdioMode, StdioMode, StdioMode];
  // after the process exits, its output closes once no chunk has arrived for this long, though a descendant still holds it
  readonly exitOutputIdleMs?: number;
  readonly job?: number;
}

/**
 * A session job as a start names it: its id, and on Windows the job object's raw handle value, which any thread of the
 * process may use. Without a handle the job lives only on the worker that created it (a POSIX sentinel, or a job whose
 * creation has not answered yet), so the start runs there.
 */
export interface WireSessionJob {
  readonly id: number;
  readonly handle?: bigint;
}

export interface ReapTarget {
  readonly pid: number;
  // spawned detached on POSIX: the pid is also its process group
  readonly group: boolean;
  // the process's own job object (Windows)
  readonly job?: bigint;
}

export type LauncherRequest =
  | { readonly type: 'spawn'; readonly id: number; readonly spec: Omit<SpawnSpec, 'job'>; readonly job?: WireSessionJob }
  // answered by one `written` per write, in order
  | { readonly type: 'write'; readonly id: number; readonly chunk: Uint8Array }
  | { readonly type: 'end'; readonly id: number }
  // `whileRunning`: refused once the worker saw the process exit
  | { readonly type: 'kill'; readonly id: number; readonly tree: boolean; readonly signal?: NodeJS.Signals; readonly whileRunning?: boolean }
  | { readonly type: 'ack'; readonly id: number; readonly bytes: number }
  | { readonly type: 'createSessionJob'; readonly job: number }
  | { readonly type: 'closeSessionJob'; readonly job: number; readonly handle?: bigint }
  // kill what a dead worker left running
  | { readonly type: 'reap'; readonly targets: readonly ReapTarget[] };

/** Node's spawn or stdin write error, as far as callers read it. */
export interface SpawnErrorInfo {
  readonly message: string;
  readonly code?: string;
  readonly errno?: number;
  readonly syscall?: string;
  readonly path?: string;
}

export type LauncherEvent =
  // the start returned with a pid; `job` is the process's own job object (Windows)
  | { readonly type: 'spawned'; readonly id: number; readonly pid: number; readonly job?: bigint }
  | { readonly type: 'error'; readonly id: number; readonly error: SpawnErrorInfo }
  | { readonly type: 'data'; readonly id: number; readonly stream: OutputStream; readonly chunk: ArrayBuffer }
  | { readonly type: 'exit'; readonly id: number; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  | { readonly type: 'close'; readonly id: number }
  // a write reached the process's stdin, or failed with `error`
  | { readonly type: 'written'; readonly id: number; readonly error?: SpawnErrorInfo }
  // every target of a `reap` request was killed
  | { readonly type: 'reaped' }
  // `handle` on Windows; `owned` when the job lives only on this worker (POSIX); neither when it could not be created
  | { readonly type: 'sessionJob'; readonly job: number; readonly handle?: bigint; readonly owned: boolean }
  | { readonly type: 'log'; readonly message: string };

export interface LauncherWorkerData {
  readonly marker: typeof LAUNCHER_WORKER_MARKER;
  // dist/sentinel.js, which a POSIX session job starts
  readonly sentinelPath: string;
  // the host process's spawn lock (spawn-lock.ts)
  readonly spawnLock: SharedArrayBuffer;
}
