import { spawn } from 'child_process';
import { log } from '../../logger';
import { withSpawnLock } from '../../process-launcher/spawn-lock';
import { windowsSystemTool } from '../../system-tools';
import { startShellSentinel, type ShellSentinel } from './shell-sentinel-client';

/** `JobObjectExtendedLimitInformation`. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** The layout of `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` for the running arch; the call rejects any other length. */
const EXTENDED_LIMIT_INFORMATION_BYTES = process.arch === 'ia32' ? 112 : 144;
/** Byte offset of `BasicLimitInformation.LimitFlags` within that structure. */
const LIMIT_FLAGS_OFFSET = 16;
/** `JobObjectBasicAccountingInformation`: four LARGE_INTEGER times, then four DWORD counts, the same on every arch. */
const JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION = 1;
const BASIC_ACCOUNTING_INFORMATION_BYTES = 48;
const ACTIVE_PROCESSES_OFFSET = 40;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const STILL_ACTIVE = 259;
/** What `OpenProcess` answers for a pid that no longer names a process. */
const ERROR_INVALID_PARAMETER = 87;

/** A Windows job object holding one spawned shell and, by inheritance, everything it starts. */
export interface ShellJob {
  /** Kill every process in the job, now. */
  terminate(): void;
  /** Release the kernel handle. No kill-on-close here, so anything still running outlives the call. */
  dispose(): void;
}

/**
 * The outer job every shell call of one panel nests inside.
 *
 * Its lifetime is the panel, not the conversation: it is held for as long as the session object lives and
 * a conversation reset must not close it, or a process the user deliberately backgrounded earlier dies.
 */
export interface ShellSessionJob {
  /** Release the kernel handle. Kill-on-close means anything still running in the session dies here. */
  dispose(): void;
}

/** Assignment stays off the exported handle: its only failure mode is being called out of order. */
interface SessionJobInternals extends ShellSessionJob {
  /** 'exited' when the process had exited before it could join, so no other job is tried for it. */
  assign(pid: number): 'exited' | undefined;
}

/** The POSIX session handle. The win32 job has no use for the exit record, so it stays off that arm. */
interface SentinelSessionJob extends SessionJobInternals {
  shellExited(pid: number): void;
}

/** The win32 arm; its handle is process-wide, so a launcher worker may hand it to another. */
interface WindowsSessionJob extends SessionJobInternals {
  readonly handle: Handle;
}

// koffi 3 represents a pointer, and so a HANDLE, as a BigInt.
type Handle = bigint;

/** Win32 `BOOL` is a 4-byte int, so these are bound as `int` and compared against zero, never as `bool`. */
interface JobObjectApi {
  createJobObject: (attributes: null, name: null) => Handle;
  setInformationJobObject: (job: Handle, infoClass: number, info: Buffer, length: number) => number;
  queryInformationJobObject: (job: Handle, infoClass: number, info: Buffer, length: number, returnLength: null) => number;
  openProcess: (access: number, inheritHandle: boolean, pid: number) => Handle;
  assignProcessToJobObject: (job: Handle, target: Handle) => number;
  terminateJobObject: (job: Handle, exitCode: number) => number;
  closeHandle: (handle: Handle) => number;
  /** Writes the code into `exitCode[0]`. */
  getExitCodeProcess: (process: Handle, exitCode: number[]) => number;
  getLastError: () => number;
}

interface KoffiModule {
  load: (library: string) => {
    func: (convention: string, name: string, result: string, parameters: unknown[]) => unknown;
  };
  out: (type: unknown) => unknown;
  pointer: (type: string) => unknown;
}

/** `undefined` until the first win32 shell call, then the bound API or `null` when koffi is unusable. */
let jobObjectApi: JobObjectApi | null | undefined;

/**
 * Bind the kernel32 entry points the job object needs.
 *
 * koffi is the project's only native dependency and is required lazily from here, so no POSIX code path
 * ever loads it. A failure here is reported once and leaves Windows on the degraded `taskkill /T` sweep,
 * which cannot reach a descendant whose parent link has been severed.
 */
function loadJobObjectApi(): JobObjectApi | null {
  if (jobObjectApi !== undefined) return jobObjectApi;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi') as KoffiModule;
    const kernel32 = koffi.load('kernel32.dll');
    jobObjectApi = {
      createJobObject: kernel32.func('__stdcall', 'CreateJobObjectW', 'void*', ['void*', 'void*']) as JobObjectApi['createJobObject'],
      setInformationJobObject: kernel32.func('__stdcall', 'SetInformationJobObject', 'int', [
        'void*',
        'int',
        'void*',
        'uint32',
      ]) as JobObjectApi['setInformationJobObject'],
      queryInformationJobObject: kernel32.func('__stdcall', 'QueryInformationJobObject', 'int', [
        'void*',
        'int',
        'void*',
        'uint32',
        'void*',
      ]) as JobObjectApi['queryInformationJobObject'],
      openProcess: kernel32.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'bool', 'uint32']) as JobObjectApi['openProcess'],
      assignProcessToJobObject: kernel32.func('__stdcall', 'AssignProcessToJobObject', 'int', [
        'void*',
        'void*',
      ]) as JobObjectApi['assignProcessToJobObject'],
      terminateJobObject: kernel32.func('__stdcall', 'TerminateJobObject', 'int', ['void*', 'uint32']) as JobObjectApi['terminateJobObject'],
      closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['void*']) as JobObjectApi['closeHandle'],
      getExitCodeProcess: kernel32.func('__stdcall', 'GetExitCodeProcess', 'int', [
        'void*',
        koffi.out(koffi.pointer('uint32')),
      ]) as JobObjectApi['getExitCodeProcess'],
      // koffi keeps the thread's last error from Node and V8 between its calls.
      getLastError: kernel32.func('__stdcall', 'GetLastError', 'uint32', []) as JobObjectApi['getLastError'],
    };
  } catch (error) {
    log(
      '[ProcessTree] ERROR: koffi failed to load, so shell commands cannot be given a job object. Stopping a command will not kill background jobs it started. %O',
      error,
    );
    jobObjectApi = null;
  }
  return jobObjectApi;
}

type JoinOutcome = 'joined' | 'exited' | { readonly call: 'OpenProcess' | 'AssignProcessToJobObject'; readonly code: number };

/**
 * Put a spawned process in a job. Node cannot start a process suspended, so it may have exited before this
 * runs; that answers `'exited'`, and only a live process's failure answers its Win32 code.
 */
function joinJob(api: JobObjectApi, job: Handle, pid: number): JoinOutcome {
  const target = api.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
  if (!target) {
    const code = api.getLastError();
    return code === ERROR_INVALID_PARAMETER ? 'exited' : { call: 'OpenProcess', code };
  }
  try {
    if (api.assignProcessToJobObject(job, target) !== 0) return 'joined';
    const code = api.getLastError();
    const exitCode = [0];
    if (api.getExitCodeProcess(target, exitCode) !== 0 && exitCode[0] !== STILL_ACTIVE) return 'exited';
    return { call: 'AssignProcessToJobObject', code };
  } finally {
    // Membership outlives this handle; only the job handle has to be kept.
    api.closeHandle(target);
  }
}

function reportJoinFailure(outcome: Exclude<JoinOutcome, 'joined'>, pid: number, consequence: string): void {
  if (outcome === 'exited') {
    log('[ProcessTree] pid %d had exited before it could join a job; anything it started runs outside the job', pid);
    return;
  }
  log('[ProcessTree] ERROR: %s failed for pid %d with Win32 error %d; %s', outcome.call, pid, outcome.code, consequence);
}

/**
 * The POSIX stand-in for the session job: a sentinel process holding the read end of one pipe.
 *
 * POSIX has no job object, so the same guarantee comes from the other kernel behaviour that needs no
 * cooperation from a dying process: closing the last write end of a pipe gives its reader EOF. Registration
 * and liveness share that one pipe, so panel close and a killed host are indistinguishable to the sentinel.
 */
function createSentinelSessionJob(sentinelPath: string | undefined): SentinelSessionJob {
  // Nothing needs cleaning up before the first command, so the helper process is not started until then.
  let sentinel: ShellSentinel | undefined;
  return {
    // The shell is spawned detached, so its pid is also the id of the group the sentinel must kill.
    assign: (pid: number): undefined => {
      sentinel ??= startShellSentinel(sentinelPath);
      sentinel.register(pid);
      return undefined;
    },
    shellExited: (pid: number): void => sentinel?.shellExited(pid),
    dispose: (): void => sentinel?.dispose(),
  };
}

/**
 * Create the job that outlives individual shell calls and holds everything the panel started.
 *
 * This is the only one of the two jobs that may carry `KILL_ON_JOB_CLOSE`, and Windows must never also get
 * a sentinel beside a kernel-owned job. There must be no module-level instance: one panel is one session
 * object, so a host-wide job would kill another panel's commands on dispose.
 */
export function createShellSessionJob(sentinelPath?: string): ShellSessionJob | undefined {
  if (process.platform !== 'win32') return createSentinelSessionJob(sentinelPath);
  const api = loadJobObjectApi();
  if (api === null) return undefined;

  const job = api.createJobObject(null, null);
  if (!job) {
    log('[ProcessTree] ERROR: CreateJobObject failed for the session with Win32 error %d; commands left running will not be cleaned up', api.getLastError());
    return undefined;
  }
  const limits = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_BYTES);
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
  if (api.setInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length) === 0) {
    const code = api.getLastError();
    api.closeHandle(job);
    log('[ProcessTree] ERROR: SetInformationJobObject failed for the session with Win32 error %d; commands left running will not be cleaned up', code);
    return undefined;
  }

  return windowsSessionJob(api, job);
}

function windowsSessionJob(api: JobObjectApi, job: Handle): WindowsSessionJob {
  let open = true;
  return {
    handle: job,
    assign: (pid: number): 'exited' | undefined => {
      if (!open) return undefined;
      const outcome = joinJob(api, job, pid);
      if (outcome !== 'joined') reportJoinFailure(outcome, pid, 'it will outlive the session');
      return outcome === 'exited' ? 'exited' : undefined;
    },
    dispose: (): void => {
      if (!open) return;
      open = false;
      api.closeHandle(job);
    },
  };
}

/** A Windows session job's raw handle value, which any thread of this process may use; undefined on POSIX. */
export function sessionJobHandle(session: ShellSessionJob | undefined): bigint | undefined {
  return (session as Partial<WindowsSessionJob> | undefined)?.handle;
}

/**
 * The session job behind a raw handle value another thread created. Its dispose closes that handle, so only the job's one
 * closer may call it.
 */
export function adoptShellSessionJob(handle: bigint): ShellSessionJob | undefined {
  const api = loadJobObjectApi();
  return api === null ? undefined : windowsSessionJob(api, handle);
}

/** A call job's raw handle value (Windows). */
export function shellJobHandle(job: ShellJob | undefined): bigint | undefined {
  return (job as { readonly handle?: bigint } | undefined)?.handle;
}

/** Kill every process in the job behind a raw handle value, and close the handle. */
export function terminateJobHandle(handle: bigint): void {
  const api = loadJobObjectApi();
  if (api === null) return;
  if (api.terminateJobObject(handle, 1) === 0) log('[ProcessTree] ERROR: TerminateJobObject failed with Win32 error %d for a job left by a dead launcher worker', api.getLastError());
  api.closeHandle(handle);
}

/**
 * Put a spawned shell in its own job object, so stopping it reaches every process it started.
 *
 * `BREAKAWAY_OK` must stay unset, because a child that could leave the job would defeat this entirely.
 * This job must never carry `KILL_ON_JOB_CLOSE`: releasing it at the end of a call has to leave a
 * backgrounded process running, exactly as a process group does on POSIX.
 *
 * The session assignment must stay above the win32 return, because it is also how the POSIX sentinel
 * learns the process group, and moving it below would silently disable cleanup there. The POSIX handle
 * exists only to report the shell's exit, which is the moment every process left in the group is provably
 * ours and can be anchored against a later pid reuse.
 */
export function createShellJob(pid: number, session: ShellSessionJob | undefined): ShellJob | undefined {
  // This module is the only producer of the handle, so the internal shape is always present.
  const internals = session as SessionJobInternals | undefined;
  const sessionOutcome = internals?.assign(pid);

  if (process.platform !== 'win32') {
    // No session means no sentinel, so there is nobody to report the exit to.
    if (internals === undefined) return undefined;
    const sentinelSession = internals as SentinelSessionJob;
    let reported = false;
    return {
      // `killProcessTree` signals the process group directly on POSIX and never consults this handle.
      terminate: (): void => {},
      // One x record per shell exit, however often the owner disposes.
      dispose: (): void => {
        if (reported) return;
        reported = true;
        sentinelSession.shellExited(pid);
      },
    };
  }
  // the session's join already reported the exit, and a process that has exited has nothing for a call job to stop
  if (sessionOutcome === 'exited') return undefined;
  const api = loadJobObjectApi();
  if (api === null) return undefined;

  const job = api.createJobObject(null, null);
  if (!job) {
    log('[ProcessTree] ERROR: CreateJobObject failed for pid %d with Win32 error %d; stopping this command will not kill what it started', pid, api.getLastError());
    return undefined;
  }

  const outcome = joinJob(api, job, pid);
  if (outcome !== 'joined') {
    api.closeHandle(job);
    reportJoinFailure(outcome, pid, 'stopping this command will not kill what it started');
    return undefined;
  }

  let open = true;
  const callJob: ShellJob & { readonly handle: Handle } = {
    handle: job,
    terminate: (): void => {
      if (open && api.terminateJobObject(job, 1) === 0) log('[ProcessTree] ERROR: TerminateJobObject failed for pid %d with Win32 error %d; what it started keeps running', pid, api.getLastError());
    },
    dispose: (): void => {
      if (!open) return;
      open = false;
      api.closeHandle(job);
    },
  };
  return callJob;
}

/**
 * Whether a closed process left a descendant running, read once at its close and never polled: its call job's active
 * processes (Windows, before the job is released), or a signal-0 probe of its detached group (POSIX), whose id no new
 * process can take while a member holds it. False without a call job or group.
 */
export function leftRunning(job: ShellJob | undefined, pid: number, group: boolean): boolean {
  if (process.platform !== 'win32') {
    if (!group) return false;
    try {
      process.kill(-pid, 0);
      return true;
    } catch (err) {
      // EPERM: another user's group took the id, so none of ours is left
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH' && code !== 'EPERM') log('[ProcessTree] could not tell whether process group %d still runs, so it counts as ended: %O', pid, err);
      return false;
    }
  }
  const handle = shellJobHandle(job);
  const api = handle === undefined ? null : loadJobObjectApi();
  if (handle === undefined || api === null) return false;
  const info = Buffer.alloc(BASIC_ACCOUNTING_INFORMATION_BYTES);
  if (api.queryInformationJobObject(handle, JOB_OBJECT_BASIC_ACCOUNTING_INFORMATION, info, info.length, null) === 0) {
    log('[ProcessTree] ERROR: QueryInformationJobObject failed for pid %d with Win32 error %d, so what it started counts as ended', pid, api.getLastError());
    return false;
  }
  return info.readUInt32LE(ACTIVE_PROCESSES_OFFSET) > 0;
}

/**
 * Kill a spawned shell and everything it started.
 *
 * Windows terminates the job explicitly rather than leaning on kill-on-close, so the kill is ordered
 * rather than tied to when the handle happens to be released. POSIX signals the process group, which
 * reaches backgrounded jobs because a non-interactive bash leaves them in it. The caller must have
 * spawned `pid` detached on POSIX, or the negated pid names the host's own group.
 *
 * Without a job the Windows arm is the bare `/T` sweep, which cannot reach a severed parent link. That is
 * the pre-existing behaviour and is reported at the point the job could not be created, not silently here.
 */
export function killProcessTree(pid: number, job?: ShellJob): void {
  if (process.platform === 'win32') {
    if (job) {
      job.terminate();
      return;
    }
    const killer = withSpawnLock(() => spawn(windowsSystemTool('taskkill'), ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', detached: true, windowsHide: true }));
    // One flag for both listeners, because a spawn failure reports an 'error' and an 'exit'.
    let fellBack = false;
    const killRoot = (): void => {
      if (fellBack) return;
      fellBack = true;
      // The caller passes a pid rather than the handle, so a recycled pid would be signalled instead.
      try {
        process.kill(pid);
        log('[ProcessTree] killed pid %d directly; anything it started is orphaned', pid);
      } catch (error) {
        log('[ProcessTree] pid %d was already gone, so nothing was killed: %O', pid, error);
      }
    };
    // An unhandled 'error' event on a ChildProcess takes the extension host down with it.
    killer.on('error', (error) => {
      log('[ProcessTree] taskkill could not be spawned for pid %d: %O', pid, error);
      killRoot();
    });
    // A taskkill that spawns and then fails, access denied for one, reports only through its exit code.
    killer.on('exit', (code) => {
      if (code === 0) return;
      log('[ProcessTree] taskkill exited with code %s for pid %d', code, pid);
      killRoot();
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    // ESRCH means the group leader is gone too, so there is nothing left that a per-pid kill could reach.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
