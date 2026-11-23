import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
// The REAL pi operations, because the point of these cases is parity with the implementation replaced.
import { createBashToolDefinition, createLocalBashOperations, getShellConfig, type BashOperations, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createBashTool, createTrackedBashOperations } from '../bash-tool';
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
 * `createTrackedBashOperations` replaces pi's local bash backend so the shell starts on the process
 * launcher, where the process-lifetime code runs. Everything else about it must stay pi's, because pi's `bash.ts` matches on
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
 * The shell's own OS pid. Under Git Bash `$$` is an MSYS pid the OS cannot signal and which can name an
 * unrelated live Windows process, so win32 reads the Windows pid from /proc and has no fallback: an
 * unreadable winpid must leave the shell alive and fail the case, never signal a guessed number.
 */
const PRINT_SHELL_PID = process.platform === 'win32' ? 'cat /proc/$$/winpid' : 'echo $$';

interface KillResult extends RunResult {
  /** The pid signalled, so a case can prove the shell reported one instead of nothing being killed. */
  killedPid: number | undefined;
}

/** Kill the shell from outside the operations, so neither the abort nor the timeout branch is involved. */
async function runUntilKilledFromOutside(ops: BashOperations): Promise<KillResult> {
  let output = '';
  let killedPid: number | undefined;
  try {
    const result = await ops.exec(`${PRINT_SHELL_PID}; sleep 5`, CWD, {
      onData: (data) => {
        output += data.toString();
        // The pid line is only complete once its newline has arrived.
        if (killedPid !== undefined || !output.includes('\n')) return;
        const pid = Number(output.split('\n')[0]!.trim());
        if (!Number.isInteger(pid) || pid <= 0) return;
        killedPid = pid;
        process.kill(pid, 'SIGKILL');
      },
      env: process.env,
    });
    return { exitCode: result.exitCode, output, error: undefined, killedPid };
  } catch (error) {
    return { exitCode: null, output, error: error instanceof Error ? error.message : String(error), killedPid };
  }
}

/**
 * A shell killed from outside reports what the platform gives it: POSIX reports the 128+SIGKILL
 * convention, win32 reports the terminating exit code 1. Parity with pi is the primary assertion, and
 * the absolute pins the number itself, which parity alone would let drift. pi's bash tool now rejects a
 * null exit code, so neither may return one.
 */
describe('an externally killed shell', () => {
  it('reports the exit code pi reports for the same kill', async () => {
    const piRun = await runUntilKilledFromOutside(createLocalBashOperations());
    const damoclesRun = await runUntilKilledFromOutside(createTrackedBashOperations(pi, () => ({}), undefined));

    expect(piRun.error).toBeUndefined();
    expect(damoclesRun.error).toBeUndefined();
    expect(piRun.killedPid).toBeGreaterThan(0);
    expect(damoclesRun.killedPid).toBeGreaterThan(0);
    expect(damoclesRun.exitCode).toBe(piRun.exitCode);
    expect(damoclesRun.exitCode).toBe(process.platform === 'win32' ? 1 : 137);
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

/**
 * pi #11613 (pi 1.5.2 `test/suite/regressions/11613-bash-timeout-after-shell-exit.test.ts:16`): a background process that keeps writing to the shell's
 * pipes holds the call past the shell's exit, and a timeout that passes then names the shell's own exit, as pi's tool does.
 */
describe('a timeout after the shell exited', () => {
  const tool = createBashTool({ getShellConfig, createBashToolDefinition } as unknown as PiCodingAgentModule, CWD, { getShellOptions: () => ({}), shellJob: undefined });
  const pis = createBashToolDefinition(CWD);
  // A background loop writes about every 10 ms, more often than the exit's output grace, for as long as `mark` exists, while
  // the shell waits 0.2 s and exits. Every wait reads bash's own clock (`EPOCHREALTIME`), so nothing starts a process.
  // The loop also ends on its own after TICKER_MAX_S, for a test abandoned before it removes `mark`.
  const TICKER_MAX_S = 30;
  const ticker = (mark: string): string => {
    const quoted = `'${mark.replace(/\\/g, '/')}'`;
    return `stop=$(( \${EPOCHREALTIME/./} + ${TICKER_MAX_S * 1_000_000} )); (while [ -e ${quoted} ] && (( \${EPOCHREALTIME/./} < stop )); do echo tick; next=$(( \${EPOCHREALTIME/./} + 10000 )); while (( \${EPOCHREALTIME/./} < next )); do :; done; done) & end=$(( \${EPOCHREALTIME/./} + 200000 )); while (( \${EPOCHREALTIME/./} < end )); do :; done; echo boom >&2; exit 3`;
  };
  const AFTER_EXIT = /Command timed out after 1 seconds\. The shell exited with code 3 after \d+(\.\d)? seconds, but background processes it started kept writing output until the timeout\.$/;
  // What a test that timed out left behind: its `finally` never ran.
  const marks: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    for (const mark of marks.splice(0)) rmSync(mark, { force: true });
  });

  /**
   * Holds every timer of `delayMs`, the calls' deadlines, until the shell's first output arrives, and runs each its full delay
   * from there, so the deadline excludes shell start-up, which a loaded machine stretches. Once every held deadline ran,
   * `mark` goes, which ends the ticker's loop.
   */
  async function withDeadlineFromFirstOutput(delayMs: number, mark: string | undefined, calls: (onUpdate: () => void) => Promise<string[]>): Promise<string[]> {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    interface Held { readonly run: () => void; timer?: NodeJS.Timeout; done: boolean }
    const held = new Map<object, Held>();
    let started = false;
    const removeMark = (): void => {
      if (mark !== undefined) rmSync(mark, { force: true });
    };
    const schedule = (entry: Held): void => {
      entry.timer = realSetTimeout(() => {
        entry.done = true;
        entry.run();
        if ([...held.values()].every((each) => each.done)) removeMark();
      }, delayMs);
    };
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
      if (ms !== delayMs) return realSetTimeout(callback, ms, ...args);
      const handle = {};
      const entry: Held = { run: () => callback(...args), done: false };
      held.set(handle, entry);
      if (started) schedule(entry);
      return handle;
    }) as unknown as typeof setTimeout);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      const entry = typeof handle === 'object' && handle !== null ? held.get(handle) : undefined;
      if (!entry) return realClearTimeout(handle);
      entry.done = true;
      if (entry.timer) realClearTimeout(entry.timer);
    });
    const firstOutput = (): void => {
      if (started) return;
      started = true;
      for (const entry of held.values()) if (!entry.done && !entry.timer) schedule(entry);
    };
    spies.push(setSpy, clearSpy);
    if (mark !== undefined) {
      marks.push(mark);
      writeFileSync(mark, '');
    }
    try {
      return await calls(firstOutput);
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
      removeMark();
    }
  }

  const messageOf = (definition: Pick<ToolDefinition, 'execute'>, command: string, timeout: number, onOutput: () => void = () => undefined): Promise<string> => {
    const onUpdate = (update: { content: { type: string; text?: string }[] }): void => {
      if (update.content.some((part) => part.type === 'text' && (part.text ?? '') !== '')) onOutput();
    };
    return (definition.execute('t', { command, timeout } as never, undefined, onUpdate as never, undefined as never) as Promise<unknown>).then(
      () => 'resolved',
      (error: unknown) => (error as Error).message,
    );
  };
  const markPath = (): string => join(tmpdir(), `damocles-ticker-${process.pid}-${Math.random().toString(36).slice(2)}`);

  it('reports the exit code and time of a shell whose background processes kept writing until the timeout, as pi does', async () => {
    const messages: string[] = [];
    for (const definition of [tool, pis as unknown as ToolDefinition]) {
      const mark = markPath();
      messages.push(...await withDeadlineFromFirstOutput(1000, mark, async (onOutput) => [await messageOf(definition, ticker(mark), 1, onOutput)]));
    }

    for (const message of messages) {
      expect(message).toContain('boom');
      expect(message).toMatch(AFTER_EXIT);
    }
  }, 60_000);

  it('keeps the plain timeout message when the shell was still running at the deadline', async () => {
    const [message] = await withDeadlineFromFirstOutput(300, undefined, async (onOutput) => [await messageOf(tool, 'echo started; sleep 30', 0.3, onOutput)]);
    expect(message).toMatch(/started\s+Command timed out after 0\.3 seconds$/);
  }, 30_000);

  it('keeps each call\'s exit to that call', async () => {
    const mark = markPath();
    // both deadlines count from the ticker's first output; the other shell is still in its 30 s sleep then
    const [timedOut, plain] = await withDeadlineFromFirstOutput(1000, mark, (onOutput) => Promise.all([messageOf(tool, ticker(mark), 1, onOutput), messageOf(tool, 'sleep 30', 1)]));

    expect(timedOut).toMatch(AFTER_EXIT);
    expect(plain).toMatch(/Command timed out after 1 seconds$/);
  }, 60_000);
});
