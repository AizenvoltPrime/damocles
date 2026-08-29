import { spawn } from 'child_process';
import { log } from '../../logger';
import { startShellSentinel, type ShellSentinel } from './shell-sentinel-client';

/** `JobObjectExtendedLimitInformation`. */
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
/** The layout of `JOBOBJECT_EXTENDED_LIMIT_INFORMATION` for the running arch; the call rejects any other length. */
const EXTENDED_LIMIT_INFORMATION_BYTES = process.arch === 'ia32' ? 112 : 144;
/** Byte offset of `BasicLimitInformation.LimitFlags` within that structure. */
const LIMIT_FLAGS_OFFSET = 16;
const PROCESS_TERMINATE = 0x0001;
const PROCESS_SET_QUOTA = 0x0100;

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
  assign(pid: number): void;
}

/** The POSIX session handle. The win32 job has no use for the exit record, so it stays off that arm. */
interface SentinelSessionJob extends SessionJobInternals {
  shellExited(pid: number): void;
}

type Handle = unknown;

/** Win32 `BOOL` is a 4-byte int, so these are bound as `int` and compared against zero, never as `bool`. */
interface JobObjectApi {
  createJobObject: (attributes: null, name: null) => Handle;
  setInformationJobObject: (job: Handle, infoClass: number, info: Buffer, length: number) => number;
  openProcess: (access: number, inheritHandle: boolean, pid: number) => Handle;
  assignProcessToJobObject: (job: Handle, target: Handle) => number;
  terminateJobObject: (job: Handle, exitCode: number) => number;
  closeHandle: (handle: Handle) => number;
}

interface KoffiModule {
  load: (library: string) => {
    func: (convention: string, name: string, result: string, parameters: string[]) => unknown;
  };
}

/** `undefined` until the first win32 shell call, then the bound API or `null` when koffi is unusable. */
let jobObjectApi: JobObjectApi | null | undefined;

/**
 * Bind the six kernel32 entry points the job object needs.
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
      openProcess: kernel32.func('__stdcall', 'OpenProcess', 'void*', ['uint32', 'bool', 'uint32']) as JobObjectApi['openProcess'],
      assignProcessToJobObject: kernel32.func('__stdcall', 'AssignProcessToJobObject', 'int', [
        'void*',
        'void*',
      ]) as JobObjectApi['assignProcessToJobObject'],
      terminateJobObject: kernel32.func('__stdcall', 'TerminateJobObject', 'int', ['void*', 'uint32']) as JobObjectApi['terminateJobObject'],
      closeHandle: kernel32.func('__stdcall', 'CloseHandle', 'int', ['void*']) as JobObjectApi['closeHandle'],
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

/** Open the spawned shell for the two operations a job assignment needs. */
function openShell(api: JobObjectApi, pid: number): Handle | null {
  const target = api.openProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, false, pid);
  if (!target) {
    log('[ProcessTree] ERROR: OpenProcess failed for pid %d; stopping this command will not kill what it started', pid);
    return null;
  }
  return target;
}

/**
 * The POSIX stand-in for the session job: a sentinel process holding the read end of one pipe.
 *
 * POSIX has no job object, so the same guarantee comes from the other kernel behaviour that needs no
 * cooperation from a dying process: closing the last write end of a pipe gives its reader EOF. Registration
 * and liveness share that one pipe, so panel close and a killed host are indistinguishable to the sentinel.
 */
function createSentinelSessionJob(): SentinelSessionJob {
  // Nothing needs cleaning up before the first command, so the helper process is not started until then.
  let sentinel: ShellSentinel | undefined;
  return {
    // The shell is spawned detached, so its pid is also the id of the group the sentinel must kill.
    assign: (pid: number): void => {
      sentinel ??= startShellSentinel();
      sentinel.register(pid);
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
export function createShellSessionJob(): ShellSessionJob | undefined {
  if (process.platform !== 'win32') return createSentinelSessionJob();
  const api = loadJobObjectApi();
  if (api === null) return undefined;

  const job = api.createJobObject(null, null);
  if (!job) {
    log('[ProcessTree] ERROR: CreateJobObject failed for the session; commands left running will not be cleaned up');
    return undefined;
  }
  const limits = Buffer.alloc(EXTENDED_LIMIT_INFORMATION_BYTES);
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, LIMIT_FLAGS_OFFSET);
  if (api.setInformationJobObject(job, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, limits, limits.length) === 0) {
    api.closeHandle(job);
    log('[ProcessTree] ERROR: SetInformationJobObject failed for the session; commands left running will not be cleaned up');
    return undefined;
  }

  let open = true;
  const handle: SessionJobInternals = {
    assign: (pid: number): void => {
      if (!open) return;
      const target = openShell(api, pid);
      if (!target) return;
      const assigned = api.assignProcessToJobObject(job, target) !== 0;
      api.closeHandle(target);
      if (!assigned) log('[ProcessTree] ERROR: could not put pid %d in the session job; it will outlive the session', pid);
    },
    dispose: (): void => {
      if (!open) return;
      open = false;
      api.closeHandle(job);
    },
  };
  return handle;
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
  internals?.assign(pid);

  if (process.platform !== 'win32') {
    // No session means no sentinel, so there is nobody to report the exit to.
    if (internals === undefined) return undefined;
    const sentinelSession = internals as SentinelSessionJob;
    let reported = false;
    return {
      // `killProcessTree` signals the process group directly on POSIX and never consults this handle.
      terminate: (): void => {},
      // The PowerShell tool's cleanup runs from both 'error' and 'close', so one call has to be idempotent.
      dispose: (): void => {
        if (reported) return;
        reported = true;
        sentinelSession.shellExited(pid);
      },
    };
  }
  const api = loadJobObjectApi();
  if (api === null) return undefined;

  const job = api.createJobObject(null, null);
  if (!job) {
    log('[ProcessTree] ERROR: CreateJobObject failed for pid %d; stopping this command will not kill what it started', pid);
    return undefined;
  }

  const target = openShell(api, pid);
  if (!target) {
    api.closeHandle(job);
    return undefined;
  }
  const assigned = api.assignProcessToJobObject(job, target) !== 0;
  // Membership outlives this handle; only the job handle has to be kept.
  api.closeHandle(target);
  if (!assigned) {
    api.closeHandle(job);
    log('[ProcessTree] ERROR: AssignProcessToJobObject failed for pid %d; stopping this command will not kill what it started', pid);
    return undefined;
  }

  let open = true;
  return {
    terminate: (): void => {
      if (open) api.terminateJobObject(job, 1);
    },
    dispose: (): void => {
      if (!open) return;
      open = false;
      api.closeHandle(job);
    },
  };
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
    const killer = spawn('taskkill', ['/F', '/T', '/PID', String(pid)], { stdio: 'ignore', detached: true, windowsHide: true });
    // An unhandled 'error' event on a ChildProcess takes the extension host down with it.
    killer.on('error', (error) => log('[ProcessTree] taskkill failed: %O', error));
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch (error) {
    // ESRCH means the group leader is gone too, so there is nothing left that a per-pid kill could reach.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
