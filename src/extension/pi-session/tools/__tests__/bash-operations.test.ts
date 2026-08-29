import { describe, it, expect, vi, beforeEach } from 'vitest';
// The REAL pi operations, because the point of these cases is parity with the implementation replaced.
import { createLocalBashOperations, getShellConfig, type BashOperations } from '@earendil-works/pi-coding-agent';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createTrackedBashOperations } from '../bash-tool';
import { createShellJob, killProcessTree } from '../process-tree';
import { spawn } from 'child_process';
import { setInterval as timersSetInterval } from 'node:timers';
import { setInterval as timersPromisesSetInterval } from 'node:timers/promises';

// Passthrough, so the shells below really run while every spawn stays countable.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

// A timer taken from the module rather than the global would not show up on a `globalThis` spy.
vi.mock('node:timers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers')>();
  return { ...actual, setInterval: vi.fn(actual.setInterval) };
});
vi.mock('node:timers/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return { ...actual, setInterval: vi.fn(actual.setInterval) };
});

const jobState = vi.hoisted(() => ({ created: 0, terminated: 0, disposed: 0 }));

// `killProcessTree` calls through, so the abort cases below still really kill their shell.
vi.mock('../process-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../process-tree')>();
  return {
    ...actual,
    killProcessTree: vi.fn(actual.killProcessTree),
    createShellJob: vi.fn((pid: number, session: import("../process-tree").ShellSessionJob | undefined) => {
      jobState.created += 1;
      const real = actual.createShellJob(pid, session);
      return {
        terminate: () => {
          jobState.terminated += 1;
          real?.terminate();
        },
        dispose: () => {
          jobState.disposed += 1;
          real?.dispose();
        },
      };
    }),
  };
});

/**
 * `createTrackedBashOperations` replaces pi's local bash backend so the spawned shell's pid is visible
 * to the process-lifetime code. Everything else about it must stay pi's, because pi's `bash.ts` matches on
 * the thrown messages and renders whatever streams through `onData`. Every case below runs both
 * implementations against the same command and compares.
 */
const pi = { getShellConfig } as unknown as PiCodingAgentModule;

const CWD = process.cwd();

interface RunResult {
  exitCode: number | null;
  output: string;
  error: string | undefined;
}

async function run(
  ops: BashOperations,
  command: string,
  options: { cwd?: string; timeout?: number; signal?: AbortSignal; abortAfterMs?: number; abortOnFirstOutput?: boolean } = {},
): Promise<RunResult> {
  let output = '';
  const controller = new AbortController();
  const wantsController = options.abortAfterMs !== undefined || options.abortOnFirstOutput === true;
  const signal = options.signal ?? (wantsController ? controller.signal : undefined);
  if (options.abortAfterMs !== undefined) setTimeout(() => controller.abort(), options.abortAfterMs);
  try {
    const result = await ops.exec(command, options.cwd ?? CWD, {
      onData: (data) => {
        output += data.toString();
        // Aborting on the output itself, not on a wall clock, keeps the partial assertion off the CPU load.
        if (options.abortOnFirstOutput === true) controller.abort();
      },
      ...(signal ? { signal } : {}),
      ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      env: process.env,
    });
    return { exitCode: result.exitCode, output, error: undefined };
  } catch (error) {
    return { exitCode: null, output, error: error instanceof Error ? error.message : String(error) };
  }
}

const implementations: Array<[string, BashOperations]> = [
  ['pi local', createLocalBashOperations()],
  ['damocles tracked', createTrackedBashOperations(pi, () => ({}), undefined)],
];

describe.each(implementations)('BashOperations parity: %s', (_name, ops) => {
  it('returns exit code 0 and streams stdout through onData', async () => {
    const result = await run(ops, 'echo hello-parity');
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('hello-parity');
  });

  it('returns the command exit code and streams stderr through the same callback', async () => {
    const result = await run(ops, 'echo to-stderr >&2; exit 7');
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(7);
    expect(result.output).toContain('to-stderr');
  });

  it('feeds both streams to the single onData callback', async () => {
    // Neither implementation orders across the two pipes, so only the merge is asserted.
    const result = await run(ops, 'echo one; echo two >&2; echo three');
    expect(result.output.replace(/\r/g, '').trim().split('\n').sort()).toEqual(['one', 'three', 'two']);
  });

  it('throws "aborted" for a signal that is already aborted, without spawning', async () => {
    const result = await run(ops, 'echo never', { signal: AbortSignal.abort() });
    expect(result.error).toBe('aborted');
    expect(result.output).toBe('');
  });

  it('throws "aborted" when the signal fires mid-command, keeping the partial output', async () => {
    const result = await run(ops, 'echo partial-line; sleep 30', { abortOnFirstOutput: true });
    expect(result.error).toBe('aborted');
    expect(result.output).toContain('partial-line');
  }, 15_000);

  it('throws "timeout:<seconds>" when the timeout elapses', async () => {
    const result = await run(ops, 'sleep 30', { timeout: 0.5 });
    expect(result.error).toBe('timeout:0.5');
  }, 15_000);

  it('rejects a non-finite or non-positive timeout before spawning', async () => {
    expect((await run(ops, 'echo x', { timeout: 0 })).error).toBe('Invalid timeout: must be a finite number of seconds');
    expect((await run(ops, 'echo x', { timeout: Number.POSITIVE_INFINITY })).error).toBe(
      'Invalid timeout: must be a finite number of seconds',
    );
  });

  it('rejects a timeout past the maximum', async () => {
    const result = await run(ops, 'echo x', { timeout: 2_147_484 });
    expect(result.error).toBe('Invalid timeout: maximum is 2147483.647 seconds');
  });

  it('reports a missing working directory instead of spawning into it', async () => {
    const missing = join(tmpdir(), 'damocles-no-such-dir-9d3f1a');
    const result = await run(ops, 'echo x', { cwd: missing });
    expect(result.error).toContain('Working directory does not exist');
    expect(result.error).toContain('Cannot execute bash commands.');
  });

  it('does not wait on a backgrounded job that inherited the shell stdout pipe', async () => {
    // `close` never fires while the descendant holds the pipe, so the wait has to end on an idle pipe.
    const startedAt = Date.now();
    const result = await run(ops, 'sleep 20 & echo released');
    expect(result.output).toContain('released');
    expect(result.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);
});

/**
 * pi's bash tool always supplies the environment, so an absent one means a caller reached past it. The
 * extension host's own environment holds the provider credentials, which is what `spawn` would inherit.
 */
describe('the environment is never inherited from the extension host', () => {
  const ops = createTrackedBashOperations(pi, () => ({}), undefined);

  it('refuses to spawn a shell when no environment was supplied', async () => {
    vi.mocked(spawn).mockClear();

    await expect(ops.exec('echo leak', CWD, { onData: () => undefined })).rejects.toThrow('bash exec requires an explicit environment');

    expect(vi.mocked(spawn)).not.toHaveBeenCalled();
  });
});

describe('process lifetime wiring', () => {
  const ops = createTrackedBashOperations(pi, () => ({}), undefined);

  beforeEach(() => {
    jobState.created = 0;
    jobState.terminated = 0;
    jobState.disposed = 0;
    vi.mocked(killProcessTree).mockClear();
    vi.mocked(createShellJob).mockClear();
  });

  it('gives every shell call its own job and terminates it on abort', async () => {
    // Spied without an implementation, so the signal still reaches the shell and the abort still works.
    const kill = vi.spyOn(process, 'kill');
    const result = await run(ops, 'echo started; sleep 30', { abortAfterMs: 400 });

    expect(result.error).toBe('aborted');
    expect(jobState.created).toBe(1);
    expect(vi.mocked(createShellJob).mock.calls[0]?.[0]).toEqual(expect.any(Number));
    expect(killProcessTree).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ terminate: expect.any(Function) }));
    if (process.platform === 'win32') {
      expect(jobState.terminated).toBe(1);
    } else {
      // POSIX has no job to terminate, so the group signal is the same step and is what gets pinned here.
      expect(kill.mock.calls).toEqual([[-(vi.mocked(createShellJob).mock.calls[0]![0]), 'SIGKILL']]);
    }
    expect(jobState.disposed).toBe(1);
    kill.mockRestore();
  }, 15_000);

  it('releases the job on the normal exit path', async () => {
    await run(ops, 'echo done');

    expect(jobState.created).toBe(1);
    expect(jobState.disposed).toBe(1);
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('releases the job on the timeout path too', async () => {
    const kill = vi.spyOn(process, 'kill');
    const result = await run(ops, 'sleep 30', { timeout: 0.5 });

    expect(result.error).toBe('timeout:0.5');
    if (process.platform === 'win32') {
      expect(jobState.terminated).toBe(1);
    } else {
      expect(kill.mock.calls).toEqual([[-(vi.mocked(createShellJob).mock.calls[0]![0]), 'SIGKILL']]);
    }
    expect(jobState.disposed).toBe(1);
    kill.mockRestore();
  }, 15_000);
});

/**
 * Acceptance criterion 6, restated: no background timer, interval or process-table poll exists in the
 * shell process-lifetime path on any platform. Both assertions run on whichever platform the suite runs
 * on, so the Windows job arm and the POSIX process-group arm are each covered where they execute.
 */
describe('no running cost in the process-lifetime path', () => {
  const ops = createTrackedBashOperations(pi, () => ({}), undefined);

  it('arms no interval across a full call, including the abort', async () => {
    const globalSetInterval = vi.spyOn(globalThis, 'setInterval');
    vi.mocked(timersSetInterval).mockClear();
    vi.mocked(timersPromisesSetInterval).mockClear();

    await run(ops, 'echo one; sleep 30', { abortAfterMs: 400 });

    // All three, because a poller could reach for any of them and only one is visible on the global.
    expect(globalSetInterval).not.toHaveBeenCalled();
    expect(vi.mocked(timersSetInterval)).not.toHaveBeenCalled();
    expect(vi.mocked(timersPromisesSetInterval)).not.toHaveBeenCalled();
  }, 15_000);

  it('spawns nothing but the shell itself, so no process table is ever read', async () => {
    vi.mocked(spawn).mockClear();

    await run(ops, 'echo only-the-shell');

    expect(vi.mocked(spawn)).toHaveBeenCalledTimes(1);
  }, 15_000);
});

/** The check the user repeats by hand: the exact command from the defect report, stopped mid-run. */
describe.runIf(process.platform === 'win32')("the reported repro, end to end", () => {
  const ops = createTrackedBashOperations(pi, () => ({}), undefined);

  /** Counts only this case's own `sleep.exe`, by its unique duration: suites run in parallel. */
  const countSleeps = async (): Promise<number> => {
    const { spawnSync } = await import('node:child_process');
    const out = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "(Get-CimInstance -Query \"SELECT CommandLine FROM Win32_Process WHERE Name='sleep.exe'\" | " +
          "Where-Object { $_.CommandLine -like '* 605' } | Measure-Object).Count",
      ],
      { encoding: 'utf8', windowsHide: true },
    ).stdout;
    return Number(out.trim());
  };

  it('leaves no sleep.exe behind after stopping backgrounded jobs', async () => {
    const result = await run(ops, 'for i in 1 2 3; do sleep 605 & done; wait', { abortAfterMs: 1_500 });

    expect(result.error).toBe('aborted');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    // Three backgrounded jobs whose parent link was severed within milliseconds of starting.
    expect(await countSleeps()).toBe(0);
  }, 60_000);
});
