import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startIdentity, windowsIdentity } from '../process-identity';
import { createProcessKills, processKills, windowsTreeKill, type ProcessKillDeps, type Reproof } from '../process-kill';
import { win32Processes, type SystemProcess, type Win32Processes } from '../win32-processes';

const esrch = (): Error => Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
const enoent = (file: string): Error => Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: 'ENOENT' });
const LINUX_START = 'linux1:boot:42';

// signals as a POSIX process.kill takes them, recorded; a pid in gone answers ESRCH
function recorded(gone: Set<number> = new Set()): { sent: string[]; signal: (pid: number, signal: NodeJS.Signals | 0) => void } {
  const sent: string[] = [];
  return {
    sent,
    signal: (pid, signal) => {
      if (gone.has(Math.abs(pid))) throw esrch();
      if (signal !== 0) sent.push(`${pid} ${signal}`);
    },
  };
}

// each process a test started with its start identity, so a failing test leaves no descendant running
const started: Array<{ readonly pid: number; readonly start: string | undefined }> = [];

afterEach(() => {
  for (const { pid, start } of started.splice(0)) {
    if (start === undefined) continue;
    if (process.platform === 'win32') {
      windowsTreeKill(pid, start);
      continue;
    }
    // a POSIX test process leads its own group, which holds what it started
    try {
      process.kill(-pid, 'SIGKILL');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
    }
  }
});

const track = async (pid: number): Promise<number> => {
  started.push({ pid, start: await startIdentity(pid) });
  return pid;
};

// a Linux process's kills with no /proc entry: signal 0 alone tells whether it runs
const deps = (overrides: Partial<ProcessKillDeps>): ProcessKillDeps => ({
  platform: 'linux',
  signal: () => undefined,
  readFile: (file) => Promise.reject(enoent(file)),
  treeKill: () => {
    throw new Error('no tree kill on POSIX');
  },
  graceMs: 50,
  ...overrides,
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw err;
  }
};

// a node child that starts a grandchild and prints its pid; detached on POSIX, so it leads its own process group
async function parentAndChild(): Promise<{ parent: number; child: number }> {
  const grandchild = `require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).once('spawn', function () { console.log(this.pid); }); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['-e', grandchild], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32', windowsHide: true });
  const pid = await new Promise<number>((resolve) => child.stdout!.once('data', (chunk: Buffer) => resolve(Number(chunk.toString('utf8').trim()))));
  return { parent: await track(child.pid!), child: await track(pid) };
}

const same: Reproof = () => Promise.resolve('same');

describe('killing a process tree the daemon cannot reach through its terminal host', () => {
  it('sends a POSIX process group SIGHUP, then SIGKILL once the grace passed and its leader is proved again', async () => {
    const { sent, signal } = recorded();
    const kills = createProcessKills(deps({ signal }));
    const reproof = vi.fn(same);
    const killing = kills.group(4242, LINUX_START, reproof);
    expect(sent).toEqual(['-4242 SIGHUP']);
    expect(reproof).not.toHaveBeenCalled();
    await killing;
    expect(sent).toEqual(['-4242 SIGHUP', '-4242 SIGKILL']);
    expect(reproof).toHaveBeenCalledOnce();
  });

  // during the grace the group may end and its pid lead another process's group
  it('sends no SIGKILL to a group that is gone after the grace, or whose leader is not proved again', async () => {
    for (const answer of ['ended', 'unproved'] as const) {
      const { sent, signal } = recorded();
      const kills = createProcessKills(deps({ signal, graceMs: 20 }));
      await kills.group(4242, LINUX_START, () => Promise.resolve(answer));
      expect(sent).toEqual(['-4242 SIGHUP']);
    }
    const gone = new Set<number>();
    const { sent, signal } = recorded(gone);
    const kills = createProcessKills(deps({ platform: 'darwin', signal: (pid, sig) => { signal(pid, sig); if (sig === 'SIGHUP') gone.add(4243); }, graceMs: 20 }));
    const reproof = vi.fn(same);
    await kills.group(4243, 'darwin1:Mon Jun 3 09:04:05 2024', reproof);
    expect(sent).toEqual(['-4243 SIGHUP']);
    expect(reproof).not.toHaveBeenCalled();
  });

  it('ends a POSIX process with SIGTERM, and with SIGKILL only when it outlived the grace and is proved again', async () => {
    const gone = new Set<number>();
    const { sent, signal } = recorded(gone);
    const kills = createProcessKills(deps({ platform: 'darwin', signal: (pid, sig) => { signal(pid, sig); if (sig === 'SIGTERM' && pid === 7000) gone.add(7000); } }));
    expect(await kills.process(7000, LINUX_START, same)).toBe(true);
    expect(sent).toEqual(['7000 SIGTERM']);
    sent.length = 0;
    expect(await kills.process(7001, LINUX_START, same)).toBe(false);
    expect(sent).toEqual(['7001 SIGTERM', '7001 SIGKILL']);
    sent.length = 0;
    // its pid names another process now, so the one signalled has ended
    expect(await kills.process(7002, LINUX_START, () => Promise.resolve('ended'))).toBe(true);
    expect(await kills.process(7003, LINUX_START, () => Promise.resolve('unproved'))).toBe(false);
    expect(sent).toEqual(['7002 SIGTERM', '7003 SIGTERM']);
  });

  // a killed process whose parent does not reap it (a container whose PID 1 does not) stays a zombie, which signal 0 still finds
  it('counts a Linux zombie as gone', async () => {
    const { sent, signal } = recorded();
    const zombie = '7000 (a) Z (b) Z 1 7000 7000 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 4242 0 0\n';
    const live = '7001 (sh) S 1 7001 7001 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 4242 1000 200\n';
    const stats = new Map([['/proc/7000/stat', zombie], ['/proc/7001/stat', live]]);
    const kills = createProcessKills(deps({ signal, readFile: (file) => (stats.has(file) ? Promise.resolve(stats.get(file)!) : Promise.reject(enoent(file))) }));
    expect(await kills.process(7000, LINUX_START, same)).toBe(true);
    expect(await kills.force(7000, LINUX_START)).toBe(true);
    expect(await kills.force(7001, LINUX_START)).toBe(false);
    expect(sent).toEqual(['7000 SIGTERM', '7000 SIGKILL', '7001 SIGKILL']);
  });

  it('kills a Windows tree through the tree kill of the process proved, and answers whether it is gone', async () => {
    const gone = new Set<number>();
    const { sent, signal } = recorded(gone);
    const trees: string[] = [];
    const kills = createProcessKills(deps({ platform: 'win32', signal, treeKill: (pid, start) => { trees.push(`${pid} ${start}`); gone.add(pid); return 'killed'; } }));
    await kills.group(300, 'win1:3', same);
    expect(await kills.process(400, 'win1:4', same)).toBe(true);
    expect(trees).toEqual(['300 win1:3', '400 win1:4']);
    expect(sent).toEqual([]);
  });

  // the tree kill found the pid another process's, or none, so the process proved has ended and nothing was killed
  it('answers a Windows process gone when the tree kill found it ended', async () => {
    const { signal } = recorded();
    const kills = createProcessKills(deps({ platform: 'win32', signal, treeKill: () => 'ended' }));
    expect(await kills.process(400, 'win1:4', same)).toBe(true);
    expect(await kills.force(500, 'win1:5')).toBe(true);
  });

  // a removal's kill: an attached host had the frozen shutdown as its graceful step, and an unreachable or stopped one handles neither that nor SIGTERM
  it('forces a process at once, SIGKILL on POSIX and the tree kill on Windows, and answers whether it is gone', async () => {
    const gone = new Set<number>();
    const { sent, signal } = recorded(gone);
    const posix = createProcessKills(deps({ signal: (pid, sig) => { signal(pid, sig); if (sig === 'SIGKILL' && pid === 7000) gone.add(7000); } }));
    expect(await posix.force(7000, LINUX_START)).toBe(true);
    expect(await posix.force(7001, LINUX_START)).toBe(false);
    expect(sent).toEqual(['7000 SIGKILL', '7001 SIGKILL']);
    const trees: number[] = [];
    const windows = createProcessKills(deps({ platform: 'win32', signal, treeKill: (pid) => { trees.push(pid); gone.add(pid); return 'killed'; } }));
    expect(await windows.force(500, 'win1:5')).toBe(true);
    expect(trees).toEqual([500]);
    await expect(posix.force(1, LINUX_START)).rejects.toThrow('refusing to kill pid 1');
  });

  // -0 is this process's own group, -1 every process of the user
  it('refuses a pid that would name this process\'s group, init or every process, and signals nothing', async () => {
    const { sent, signal } = recorded();
    const treeKill = vi.fn((): 'killed' => 'killed');
    for (const platform of ['linux', 'win32'] as const) {
      const kills = createProcessKills(deps({ platform, signal, treeKill }));
      for (const pid of [0, 1, -5, Number.NaN, 2.5]) {
        await expect(kills.group(pid, LINUX_START, same)).rejects.toThrow(`refusing to kill pid ${pid}`);
        await expect(kills.process(pid, LINUX_START, same)).rejects.toThrow(`refusing to kill pid ${pid}`);
        await expect(kills.force(pid, LINUX_START)).rejects.toThrow(`refusing to kill pid ${pid}`);
      }
    }
    expect(sent).toEqual([]);
    expect(treeKill).not.toHaveBeenCalled();
  });

  it('ends a child it owns and the process that child started', { timeout: 20_000 }, async () => {
    const { parent, child } = await parentAndChild();
    await processKills().group(parent, (await startIdentity(parent))!, same);
    await vi.waitFor(() => expect([alive(parent), alive(child)]).toEqual([false, false]), { timeout: 5000 });
  });

  // A process whose parent ended keeps that parent's pid as its parent pid, so a later process given the pid looks like its
  // parent. The process list is faked to say so of a process started before the root.
  it.runIf(process.platform === 'win32')('kills on Windows only the processes created after the parent the process list names', { timeout: 30_000 }, async () => {
    const idle = ['-e', 'setInterval(() => {}, 1000)'];
    const older = await track(spawn(process.execPath, idle, { stdio: 'ignore', windowsHide: true }).pid!);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { parent, child } = await parentAndChild();
    const real = win32Processes();
    const claimed = { ...real, list: () => real.list().map((entry) => (entry.pid === older ? { ...entry, ppid: parent } : entry)) };
    expect(windowsTreeKill(parent, (await startIdentity(parent))!, claimed)).toBe('killed');
    await vi.waitFor(() => expect([alive(parent), alive(child)]).toEqual([false, false]), { timeout: 5000 });
    expect(alive(older)).toBe(true);
  });

  // the pid may name another process by the time of the kill, which the handle held from the check to the kill keeps it naming
  it.runIf(process.platform === 'win32')('kills nothing on Windows when the pid\'s creation time is not the one proved', { timeout: 30_000 }, async () => {
    const { parent, child } = await parentAndChild();
    expect(windowsTreeKill(parent, 'win1:1')).toBe('ended');
    expect(() => windowsTreeKill(parent, LINUX_START)).toThrow(`the recorded start identity of ${parent} is of another scheme`);
    // above Linux's PID_MAX_LIMIT (2^22), and not a multiple of 4, as every Windows process id is
    expect(windowsTreeKill(4_194_305, 'win1:1')).toBe('ended');
    expect([alive(parent), alive(child)]).toEqual([true, true]);
  });
});

// Windows processes over a fixed system process list; open throws for a pid in denied, as OpenProcess does for a process of
// another account
function fakeWindows(list: SystemProcess[], denied: ReadonlySet<number> = new Set(), reopened: ReadonlyMap<number, bigint> = new Map()) {
  const opened: number[] = [];
  const ended: number[] = [];
  const processes: Win32Processes = {
    open: (pid) => {
      opened.push(pid);
      if (denied.has(pid)) throw new Error(`OpenProcess(${pid}) failed with Win32 error 5`);
      const entry = list.find((candidate) => candidate.pid === pid);
      return entry && { pid, created: reopened.get(pid) ?? entry.created, terminate: () => void ended.push(pid), close: () => undefined };
    },
    list: () => list,
  };
  return { processes, opened, ended };
}

describe('the Windows tree kill judges the tree from the system process list', () => {
  const ROOT = { pid: 100, ppid: 4, created: 1000n };

  it('skips, without opening it, a process of another account created before the parent whose reused pid it names', () => {
    const windows = fakeWindows([ROOT, { pid: 200, ppid: 100, created: 2000n }, { pid: 300, ppid: 100, created: 500n }], new Set([300]));
    expect(windowsTreeKill(100, windowsIdentity(1000n), windows.processes)).toBe('killed');
    expect(windows.opened).not.toContain(300);
    expect(windows.ended).toEqual([100, 200]);
  });

  it('ends the rest, then names a descendant it could not open and the process that started it', () => {
    const windows = fakeWindows([ROOT, { pid: 200, ppid: 100, created: 2000n }, { pid: 300, ppid: 200, created: 3000n }, { pid: 400, ppid: 300, created: 4000n }], new Set([300]));
    expect(() => windowsTreeKill(100, windowsIdentity(1000n), windows.processes)).toThrow('the tree kill of 100 left processes running: process 300, started by 200, could not be opened: OpenProcess(300) failed with Win32 error 5');
    expect(windows.ended).toEqual([100, 200, 400]);
  });

  it('leaves a pid that names a newer process than the list recorded, since the one listed ended', () => {
    const windows = fakeWindows([ROOT, { pid: 200, ppid: 100, created: 2000n }], new Set(), new Map([[200, 9000n]]));
    expect(windowsTreeKill(100, windowsIdentity(1000n), windows.processes)).toBe('killed');
    expect(windows.ended).toEqual([100]);
  });
});
