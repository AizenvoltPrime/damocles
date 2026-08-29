import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import { createRequire } from 'node:module';
import { createShellJob, createShellSessionJob, killProcessTree } from '../process-tree';
import { startShellSentinel } from '../shell-sentinel-client';

// Passthrough, so the real shells below still run while every spawn stays countable.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const sentinelState = vi.hoisted(() => ({ started: 0, registered: [] as number[], exited: [] as number[], disposed: 0 }));

// Faked, because the real one launches a process; the real launch is covered in shell-sentinel.test.ts.
vi.mock('../shell-sentinel-client', () => ({
  startShellSentinel: vi.fn(() => {
    sentinelState.started += 1;
    return {
      register: (pgid: number): void => {
        sentinelState.registered.push(pgid);
      },
      shellExited: (pgid: number): void => {
        sentinelState.exited.push(pgid);
      },
      dispose: (): void => {
        sentinelState.disposed += 1;
      },
    };
  }),
}));

// The spy lives in hoisted state, not in the factory, so it survives `vi.resetModules()` and the koffi
// case below can still read what a freshly imported process-tree logged.
const logState = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('../../../logger', () => ({ log: logState.fn }));

const spawnMock = vi.mocked(spawn);
const realPlatform = process.platform;
// koffi is reached through `require`, which vi.mock does not intercept, so the load is observed on the cache.
const nodeRequire = createRequire(import.meta.url);

/** Every `log` call naming koffi, which is how the loader announces that it ran and failed. */
function koffiLogs(): unknown[][] {
  return logState.fn.mock.calls.filter((call) => typeof call[0] === 'string' && call[0].includes('koffi'));
}

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

const isWindows = realPlatform === 'win32';
const GIT_BASH = 'C:/Program Files/Git/bin/bash.exe';

/** Count only this case's own `sleep.exe`, by its unique duration: suites run in parallel. */
function countSleeps(marker: string): number {
  const out = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-CimInstance -Query \"SELECT CommandLine FROM Win32_Process WHERE Name='sleep.exe'\" | " +
        `Where-Object { $_.CommandLine -like '* ${marker}' } | Measure-Object).Count`,
    ],
    { encoding: 'utf8', windowsHide: true },
  ).stdout;
  return Number(out.trim());
}

const settle = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  spawnMock.mockClear();
  vi.mocked(startShellSentinel).mockClear();
  logState.fn.mockClear();
  sentinelState.started = 0;
  sentinelState.registered.length = 0;
  sentinelState.exited.length = 0;
  sentinelState.disposed = 0;
});

afterEach(() => {
  setPlatform(realPlatform);
  vi.restoreAllMocks();
});

describe('platform dispatch', () => {
  it('creates no call job on POSIX, backs the session with the sentinel, and signals the process group', () => {
    setPlatform('linux');
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);

    // A POSIX call job stays undefined, which is the return that keeps koffi off this path.
    expect(createShellJob(4242, undefined)).toBeUndefined();

    // The session handle is no longer undefined here: on POSIX it is the sentinel's write end.
    const session = createShellSessionJob();
    expect(session).toBeDefined();
    // A chat-only panel never runs a command, and the helper process costs tens of MB of resident memory,
    // so constructing the session must not start it.
    expect(sentinelState.started).toBe(0);

    // Registration precedes the win32 return, so it happens on a platform that creates no job object.
    const job = createShellJob(4242, session);
    expect(sentinelState.started).toBe(1);
    expect(sentinelState.registered).toEqual([4242]);
    expect(sentinelState.exited).toEqual([]);

    // The exit record is what anchors the group's members, and it must not be emitted before the shell
    // has gone. Stop signals the group directly, so terminate() has nothing to do on this arm.
    job?.terminate();
    expect(sentinelState.exited).toEqual([]);

    job?.dispose();
    expect(sentinelState.exited).toEqual([4242]);

    // Both shell tools can reach dispose() twice on an error path, and a second snapshot would replace a
    // good anchor set with an empty one after the members had gone.
    job?.dispose();
    expect(sentinelState.exited).toEqual([4242]);

    session?.dispose();
    expect(sentinelState.disposed).toBe(1);

    killProcessTree(4242);

    expect(kill).toHaveBeenCalledWith(-4242, 'SIGKILL');
  });

  it('starts nothing and cleans nothing up for a session that never ran a command', () => {
    setPlatform('linux');

    const session = createShellSessionJob();
    session?.dispose();
    session?.dispose();

    // There is nothing to clean up before the first command, so there is nothing to shut down either.
    expect(sentinelState.started).toBe(0);
    expect(sentinelState.disposed).toBe(0);
  });

  it('reaches the koffi loader on no POSIX path at all', async () => {
    // A fresh module registry, because `loadJobObjectApi` memoises its result. An earlier case that
    // reached the loader leaves that memo populated, and this case would then pass without the branch
    // ever running. Mutation testing found exactly that, so the reset is what keeps the case honest.
    vi.resetModules();
    const fresh = await import('../process-tree');
    const koffiId = nodeRequire.resolve('koffi');
    // An earlier file in this worker may have loaded it, so the absence has to be established first.
    delete nodeRequire.cache[koffiId];
    logState.fn.mockClear();
    vi.spyOn(process, 'kill').mockReturnValue(true);

    setPlatform('linux');
    fresh.createShellJob(4242, undefined);
    fresh.createShellSessionJob()?.dispose();
    fresh.killProcessTree(4242);

    // Both observables are needed. koffi picks its native binary from `process.platform`, so a faked
    // linux throws before reaching the cache even on a run that did enter the loader, and the cache
    // alone would then report success for the wrong reason. The loader's failure log covers that.
    expect(koffiId in nodeRequire.cache).toBe(false);
    expect(koffiLogs()).toEqual([]);
  });

  it.runIf(isWindows)('loads koffi on the win32 arm, which is what makes the probe above mean something', () => {
    // Only a real Windows host can answer this: koffi binds kernel32, so a faked win32 on Linux throws
    // inside the loader and never reaches the cache, which would leave the case above unable to fail.
    const koffiId = nodeRequire.resolve('koffi');
    delete nodeRequire.cache[koffiId];

    setPlatform('win32');
    createShellSessionJob()?.dispose();

    expect(koffiId in nodeRequire.cache).toBe(true);
  });

  it('starts no sentinel on win32, where the job object already gives the guarantee', () => {
    setPlatform('win32');

    const session = createShellSessionJob();
    // A job object needs the real kernel, so only a Windows run can show the arm did its work rather
    // than falling out of the loader, which is what would make the sentinel assertions below vacuous.
    if (isWindows) expect(session).toBeDefined();
    session?.dispose();

    expect(vi.mocked(startShellSentinel)).not.toHaveBeenCalled();
    expect(sentinelState.started).toBe(0);
    // Nothing was spawned at all, so reading this needs no argument about which argv a sentinel would have.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('treats ESRCH as the group already being gone and rethrows anything else', () => {
    setPlatform('darwin');
    const esrch: NodeJS.ErrnoException = new Error('kill ESRCH');
    esrch.code = 'ESRCH';
    const kill = vi.spyOn(process, 'kill').mockImplementationOnce(() => {
      throw esrch;
    });

    expect(() => killProcessTree(77)).not.toThrow();
    expect(kill).toHaveBeenCalledTimes(1);

    const eperm: NodeJS.ErrnoException = new Error('kill EPERM');
    eperm.code = 'EPERM';
    kill.mockImplementationOnce(() => {
      throw eperm;
    });
    expect(() => killProcessTree(77)).toThrow('kill EPERM');
  });

  it('falls back to the tree sweep on Windows when no job could be created', () => {
    setPlatform('win32');

    killProcessTree(999_999, undefined);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[0]).toBe('taskkill');
    expect(spawnMock.mock.calls[0]?.[1]).toEqual(['/F', '/T', '/PID', '999999']);
  });
});

describe.runIf(isWindows)('job object, against real processes', () => {
  it('kills a backgrounded job whose parent link has already been severed', async () => {
    // Git Bash backgrounds through a fork helper that exits within milliseconds, so by the time anything
    // could look, each sleep names a dead parent and no walk of the Windows links can reach it.
    const shell = spawn(GIT_BASH, ['-c', 'for i in 1 2 3; do sleep 601 & done; wait'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const job = createShellJob(shell.pid!, undefined);
    expect(job).toBeDefined();
    await settle(1_200);
    expect(countSleeps('601')).toBe(3);

    killProcessTree(shell.pid!, job);
    await settle(1_000);

    expect(countSleeps('601')).toBe(0);
    job?.dispose();
  }, 40_000);

  it('contains one shell call only, so stopping it cannot reach another', async () => {
    // Isolation is a kernel property here: a job holds what was assigned to it plus what those started.
    // Assign each shell before spawning the next: a shell left unassigned for even one further spawn can
    // fork its background jobs first, and those children are then outside the job for good.
    const callA = spawn(GIT_BASH, ['-c', 'for i in 1 2 3; do sleep 602 & done; wait'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const jobA = createShellJob(callA.pid!, undefined);
    const callB = spawn(GIT_BASH, ['-c', 'for i in 1 2; do sleep 603 & done; wait'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const jobB = createShellJob(callB.pid!, undefined);
    await settle(1_500);
    expect(countSleeps('602')).toBe(3);
    expect(countSleeps('603')).toBe(2);

    killProcessTree(callA.pid!, jobA);
    await settle(1_000);

    // B's two jobs survive; only A's three are gone.
    expect(countSleeps('602')).toBe(0);
    expect(countSleeps('603')).toBe(2);

    killProcessTree(callB.pid!, jobB);
    await settle(1_000);
    expect(countSleeps('603')).toBe(0);
    jobA?.dispose();
    jobB?.dispose();
  }, 60_000);

  it('kills through the job without spawning anything to find the descendants', async () => {
    const shell = spawn(GIT_BASH, ['-c', 'sleep 600 & wait'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const job = createShellJob(shell.pid!, undefined);
    await settle(800);
    spawnMock.mockClear();

    killProcessTree(shell.pid!, job);

    // No taskkill, no process-table query: the kernel already knows the membership.
    expect(spawnMock).not.toHaveBeenCalled();
    await settle(600);
    job?.dispose();
  }, 40_000);

  it('lets a backgrounded process outlive its call, then kills it when the session ends', async () => {
    // The whole point of nesting: the call job has no KILL_ON_JOB_CLOSE, so ending a call leaves a
    // deliberately backgrounded process running, exactly as a process group does on POSIX. Only the
    // session job kills on close, which is what makes panel teardown and a host crash clean up.
    const session = createShellSessionJob();
    expect(session).toBeDefined();
    const shell = spawn(GIT_BASH, ['-c', 'sleep 604 & wait'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const job = createShellJob(shell.pid!, session);
    await settle(1_200);
    expect(countSleeps('604')).toBe(1);

    // End of the call: the call job handle is released and the shell has gone.
    job?.dispose();
    killProcessTree(shell.pid!, job);
    await settle(1_200);
    expect(countSleeps('604')).toBe(1);

    session?.dispose();
    await settle(1_200);

    expect(countSleeps('604')).toBe(0);
  }, 60_000);

  it('still stops a running command through the call job while the session job stays open', async () => {
    const session = createShellSessionJob();
    const shell = spawn(GIT_BASH, ['-c', 'for i in 1 2 3; do sleep 606 & done; wait'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const job = createShellJob(shell.pid!, session);
    await settle(1_200);
    expect(countSleeps('606')).toBe(3);

    killProcessTree(shell.pid!, job);
    await settle(1_200);

    // Nesting must not weaken Stop: the call job still reaches the severed background jobs.
    expect(countSleeps('606')).toBe(0);
    job?.dispose();
    session?.dispose();
  }, 60_000);
});
