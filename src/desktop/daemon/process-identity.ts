// A process's start identity: what a kill compares with the identity recorded when the process started, so a pid another
// process took since is never killed (docs/invariants.md "Remote terminals outlive their clients and their daemon"). A recorded
// identity and the one read before its kill must both come from this module, so both read alike.
import { promises as fs } from 'node:fs';
import { runProcess } from '../../core/process-launcher';
import { posixToolAsync } from '../../core/system-tools';
import { IDENTITY_READ_TIMEOUT_MS } from './lock-timing';
import { win32Processes } from './win32-processes';

const BOOT_ID_FILE = '/proc/sys/kernel/random/boot_id';
// /proc/<pid>/stat after the command name, the only field that may hold spaces or ')': state is field 3, the 1st after it, and
// starttime field 22, the 20th
const LINUX_STATE_FIELD = 0;
const LINUX_STARTTIME_FIELD = 19;
// Each identity is `<scheme>:<value>`, frozen with the terminals file (token.ts): a reader that changes its source or its form
// takes a new scheme, since only identities of one scheme compare.
const LINUX_SCHEME = 'linux1';
const DARWIN_SCHEME = 'darwin1';
const WINDOWS_SCHEME = 'win1';

/** A tool's run to its close; code and signal both null when it did not finish in time. */
export interface ToolOutput {
  readonly code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface IdentityReads {
  readonly platform: NodeJS.Platform;
  readonly readFile: (file: string) => Promise<string>;
  // kill(pid, 0): whether a process has the pid, EPERM counting as one
  readonly exists: (pid: number) => boolean;
  // an absolute tool path, with env added to the process's own
  readonly run: (file: string, args: readonly string[], env?: Readonly<Record<string, string>>) => Promise<ToolOutput>;
  // ps as an absolute path; undefined when none is installed
  readonly ps: () => Promise<string | undefined>;
  // Windows: the creation time in FILETIME ticks; undefined when no process has the pid or it has exited
  readonly windowsCreated: (pid: number) => bigint | undefined;
}

/** Resolves the identity, or undefined when no live process has the pid (a zombie has ended); rejects when it cannot be read. */
export type StartIdentity = (pid: number) => Promise<string | undefined>;

const errnoCode = (err: unknown): string | undefined => (err as NodeJS.ErrnoException).code;

/** The fields of a /proc/<pid>/stat after the command name, read after its last ')'. */
export const linuxStatFields = (stat: string): string[] => stat.slice(stat.lastIndexOf(')') + 2).split(' ');

/** Whether a /proc/<pid>/stat names a zombie: a process that has ended and waits for its parent's reap. */
export const linuxZombie = (stat: string): boolean => linuxStatFields(stat)[LINUX_STATE_FIELD] === 'Z';

/** A Windows creation time as an identity. */
export const windowsIdentity = (created: bigint): string => `${WINDOWS_SCHEME}:${created}`;

export type IdentityMatch = 'same' | 'other' | 'incomparable';

/** How a recorded identity compares with the one read now: one of an unknown or another scheme proves nothing either way. */
export function compareIdentity(recorded: string, now: string): IdentityMatch {
  const colon = now.indexOf(':');
  if (colon <= 0 || !recorded.startsWith(now.slice(0, colon + 1))) return 'incomparable';
  return recorded === now ? 'same' : 'other';
}

export function createStartIdentity(reads: IdentityReads): StartIdentity {
  const finished = (tool: string, output: ToolOutput): ToolOutput & { readonly code: number } => {
    if (output.code !== null) return { ...output, code: output.code };
    throw new Error(output.signal === null ? `${tool} did not finish within ${IDENTITY_READ_TIMEOUT_MS} ms` : `${tool} ended by ${output.signal}`);
  };

  // the boot id keeps a record from an earlier boot from matching a process that got its pid and tick count
  const linux = async (pid: number): Promise<string | undefined> => {
    let stat: string;
    try {
      stat = await reads.readFile(`/proc/${pid}/stat`);
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT' && errnoCode(err) !== 'ESRCH') throw err;
      // a /proc that hides a running process (hidepid, another pid namespace) proves nothing ended
      if (reads.exists(pid)) throw new Error(`/proc/${pid}/stat is missing while the pid ${pid} runs`);
      return undefined;
    }
    if (linuxZombie(stat)) return undefined;
    const start = linuxStatFields(stat)[LINUX_STARTTIME_FIELD];
    if (start === undefined || !/^\d+$/.test(start)) throw new Error(`/proc/${pid}/stat does not parse`);
    const boot = (await reads.readFile(BOOT_ID_FILE)).trim();
    if (boot === '') throw new Error(`${BOOT_ID_FILE} is empty`);
    return `${LINUX_SCHEME}:${boot}:${start}`;
  };

  // lstart is local time in the locale's form, so both are fixed, and it pads a single-digit day, so runs of spaces are
  // collapsed (shell-sentinel.ts darwinProbe). lstart has 1 s resolution, so a pid reused within the same second passes; a finer
  // source takes a new scheme. stat comes first, a word with no spaces, and Z marks a zombie.
  const ps = async (pid: number): Promise<string | undefined> => {
    const file = await reads.ps();
    if (file === undefined) throw new Error('no ps is installed');
    const { code, stdout, stderr } = finished('ps', await reads.run(file, ['-o', 'stat=,lstart=', '-p', String(pid)], { LC_ALL: 'C', TZ: 'UTC0' }));
    const [state = '', ...started] = stdout.trim().split(/\s+/);
    const stamp = started.join(' ');
    if (code === 0 && state.startsWith('Z')) return undefined;
    if (code === 0 && stamp !== '') return `${DARWIN_SCHEME}:${stamp}`;
    // ps exits 1 and prints nothing when it lists no process
    if (code !== 0 && state === '' && stderr.trim() === '') return undefined;
    throw new Error(`ps exited with ${code}: ${stderr.trim()}`);
  };

  const windows = async (pid: number): Promise<string | undefined> => {
    const created = reads.windowsCreated(pid);
    return created === undefined ? undefined : windowsIdentity(created);
  };

  return (pid) => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error(`pid ${pid} names no single process`));
    if (reads.platform === 'linux') return linux(pid);
    return reads.platform === 'win32' ? windows(pid) : ps(pid);
  };
}

export const startIdentity: StartIdentity = createStartIdentity({
  platform: process.platform,
  readFile: (file) => fs.readFile(file, 'utf8'),
  exists: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return errnoCode(err) !== 'ESRCH';
    }
  },
  run: async (file, args, env) => {
    const { exit, stdout, stderr } = await runProcess({ file, args: [...args], ...(env ? { env: { ...process.env, ...env } } : {}), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }, { timeoutMs: IDENTITY_READ_TIMEOUT_MS });
    return { code: exit?.code ?? null, signal: exit?.signal ?? null, stdout: stdout.toString('utf8'), stderr: stderr.toString('utf8') };
  },
  // only the system's own ps, whose lstart every reader of a record formats alike
  ps: () => posixToolAsync('ps', {}),
  windowsCreated: (pid) => {
    const opened = win32Processes().open(pid, false);
    if (!opened) return undefined;
    opened.close();
    return opened.created;
  },
});
