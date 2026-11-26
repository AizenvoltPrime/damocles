// Kills of a process tree whose start identity was proved first, each only on a user's action (docs/invariants.md "Remote
// terminals outlive their clients and their daemon"): start is the identity proved, and nothing here proves a pid by itself.
import { promises as fs } from 'node:fs';
import { compareIdentity, linuxZombie, windowsIdentity } from './process-identity';
import { KILL_GRACE_MS } from './lock-timing';
import { win32Processes, type OpenedProcess, type SystemProcess, type Win32Processes } from './win32-processes';

const GONE_POLL_MS = 100;

/** The caller's proof of the process read again: still the one proved, ended (its pid is free or another's), or unproved. */
export type Reproof = () => Promise<'same' | 'ended' | 'unproved'>;

export interface ProcessKills {
  // POSIX: SIGHUP to the process group pid leads, then after the grace SIGKILL only while the group exists and reproof answers
  // same, so a member that outlived its leader is left. Only that group: when the shell, its session's leader, ends, the kernel
  // hangs up its foreground job, and what was detached on purpose (nohup, disown, setsid) runs on, as under node-pty, VS Code
  // and tmux. Windows: the tree kill. Settles once the last signal was sent.
  group(pid: number, start: string, reproof: Reproof): Promise<void>;
  // POSIX: SIGTERM to pid, then SIGKILL once the grace passed with it still running and reproof answers same; Windows: the tree
  // kill. Answers whether pid is gone within the grace after the last signal, true too when it was found ended.
  process(pid: number, start: string, reproof: Reproof): Promise<boolean>;
  // POSIX: SIGKILL to pid at once; Windows: the tree kill. Answers whether pid is gone within the grace after it, true too when
  // the tree kill found it ended.
  force(pid: number, start: string): Promise<boolean>;
}

export interface ProcessKillDeps {
  readonly platform: NodeJS.Platform;
  // process.kill: a negative pid names a process group, signal 0 only checks that the process exists
  readonly signal: (pid: number, signal: NodeJS.Signals | 0) => void;
  // Linux: /proc/<pid>/stat, whose state tells a zombie, which signal 0 still finds, from a running process
  readonly readFile: (file: string) => Promise<string>;
  // Windows: windowsTreeKill
  readonly treeKill: (pid: number, start: string) => 'killed' | 'ended';
  readonly graceMs: number;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Kills pid, once its creation time proves it the process of start, and each process the system process list names as the
 * child of one in the tree and records as created no earlier than that parent, as psutil's children() judges: a process keeps
 * its parent's pid after that parent ended, so an older process may name a pid a later process got. The list needs no access
 * to a process, as psutil's create_time falls back to it, so another account's process is judged without opening it. Each
 * descendant is opened only to end it, and only while its creation time is still the listed one, then held open to its
 * kill, so its pid names it throughout. One that is already ending counts as ended. Answers ended, killing nothing, when pid names no running process or
 * another one; throws, after killing the rest, when a descendant could not be opened or killed.
 */
export function windowsTreeKill(pid: number, start: string, processes: Win32Processes = win32Processes()): 'killed' | 'ended' {
  const root = processes.open(pid, true);
  if (!root) return 'ended';
  const held: OpenedProcess[] = [root];
  try {
    const match = compareIdentity(start, windowsIdentity(root.created));
    if (match === 'incomparable') throw new Error(`the recorded start identity of ${pid} is of another scheme`);
    if (match === 'other') return 'ended';
    const children = new Map<number, SystemProcess[]>();
    for (const listed of processes.list()) {
      if (listed.pid !== listed.ppid) children.set(listed.ppid, [...(children.get(listed.ppid) ?? []), listed]);
    }
    const failures: string[] = [];
    const tree: Array<Pick<SystemProcess, 'pid' | 'created'>> = [{ pid, created: root.created }];
    for (let at = 0; at < tree.length; at++) {
      const parent = tree[at]!;
      for (const child of children.get(parent.pid) ?? []) {
        if (child.created < parent.created || tree.some((node) => node.pid === child.pid)) continue;
        tree.push(child);
        try {
          const opened = processes.open(child.pid, true);
          if (opened?.created === child.created) held.push(opened);
          else opened?.close();
        } catch (err) {
          failures.push(`process ${child.pid}, started by ${parent.pid}, could not be opened: ${message(err)}`);
        }
      }
    }
    for (const node of held) {
      try {
        node.terminate();
      } catch (err) {
        failures.push(message(err));
      }
    }
    if (failures.length > 0) throw new Error(`the tree kill of ${pid} left processes running: ${failures.join('; ')}`);
    return 'killed';
  } finally {
    for (const node of held) node.close();
  }
}

export function createProcessKills(deps: ProcessKillDeps): ProcessKills {
  // as a group, 0 is this process's own and -1 every process of the user; 1 is init
  const checked = (pid: number): number => {
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error(`refusing to kill pid ${pid}`);
    return pid;
  };
  // a process that is already gone needs no signal
  const send = (pid: number, signal: NodeJS.Signals): void => {
    try {
      deps.signal(pid, signal);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  };
  const gone = async (pid: number): Promise<boolean> => {
    try {
      deps.signal(pid, 0);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ESRCH') return true;
      throw err;
    }
    // signal 0 finds a group while any member is left, and the reproof judges a zombie leader
    if (deps.platform !== 'linux' || pid < 0) return false;
    try {
      return linuxZombie(await deps.readFile(`/proc/${pid}/stat`));
    } catch (err) {
      // a process that ended since the signal is found gone at the next poll
      if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ESRCH') return false;
      throw err;
    }
  };
  const goneWithin = async (pid: number): Promise<boolean> => {
    const deadline = Date.now() + deps.graceMs;
    while (!(await gone(pid))) {
      if (Date.now() >= deadline) return false;
      await sleep(GONE_POLL_MS);
    }
    return true;
  };
  return {
    group: async (pid, start, reproof) => {
      checked(pid);
      if (deps.platform === 'win32') {
        deps.treeKill(pid, start);
        return;
      }
      send(-pid, 'SIGHUP');
      await sleep(deps.graceMs);
      // a group that ended may since be led by another process of the pid
      if ((await gone(-pid)) || (await reproof()) !== 'same') return;
      send(-pid, 'SIGKILL');
    },
    process: async (pid, start, reproof) => {
      checked(pid);
      if (deps.platform === 'win32') return deps.treeKill(pid, start) === 'ended' || goneWithin(pid);
      send(pid, 'SIGTERM');
      if (await goneWithin(pid)) return true;
      const again = await reproof();
      if (again !== 'same') return again === 'ended';
      send(pid, 'SIGKILL');
      return goneWithin(pid);
    },
    force: async (pid, start) => {
      checked(pid);
      if (deps.platform !== 'win32') send(pid, 'SIGKILL');
      else if (deps.treeKill(pid, start) === 'ended') return true;
      return goneWithin(pid);
    },
  };
}

export const processKills = (): ProcessKills => createProcessKills({
  platform: process.platform,
  signal: (pid, signal) => process.kill(pid, signal),
  readFile: (file) => fs.readFile(file, 'utf8'),
  treeKill: (pid, start) => windowsTreeKill(pid, start),
  graceMs: KILL_GRACE_MS,
});
