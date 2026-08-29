import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The REAL pi truncation helper: a stub would make the truncated/tail assertions below vacuous.
// Test files may value-import the ESM pi package (mission F1); extension source may not.
import { truncateTail, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, defineTool } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createShellOutputBuffer, createPowerShellTool, POWERSHELL_UPDATE_THROTTLE_MS } from '../powershell-tool';
import { createShellJob, killProcessTree } from '../process-tree';

const jobState = vi.hoisted(() => ({ created: 0, terminated: 0, disposed: 0 }));

/** Set only by the cases that drive a fake shell; a null hook leaves the real `spawn` in place for the Windows cases. */
const spawnControl = vi.hoisted(() => ({ fake: null as ((exe: string, options: unknown) => unknown) | null, calls: [] as string[] }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: import('child_process').SpawnOptions) => {
      if (!spawnControl.fake) return actual.spawn(command, args, options);
      spawnControl.calls.push(command);
      return spawnControl.fake(command, options);
    },
  };
});

// `killProcessTree` calls through, so the abort case below still really kills its shell.
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
 * `createShellOutputBuffer` mirrors pi's rolling tail from `bash-executor.ts:50-105`. It is exported
 * precisely so its bounding can be proven without spawning PowerShell: the defect it fixes is an
 * unbounded `output +=` that grows the extension host heap for as long as a command keeps printing.
 */
describe('createShellOutputBuffer', () => {
  const build = (maxLines = DEFAULT_MAX_LINES, maxBytes = DEFAULT_MAX_BYTES) =>
    createShellOutputBuffer(truncateTail, maxLines, maxBytes);

  it('caps the retained buffer at 2 * maxBytes and drops the OLDEST chunks', () => {
    const maxBytes = 1_000;
    const buffer = createShellOutputBuffer(truncateTail, DEFAULT_MAX_LINES, maxBytes);
    // 200 chunks of ~100 bytes = ~20KB appended against a 2KB cap.
    const chunk = (i: number): string => `#${i} ${'x'.repeat(90)}\n`;
    for (let i = 0; i < 200; i++) buffer.append(chunk(i));

    // `totalBytes` is the size of what the buffer still holds, i.e. what it handed to truncateTail.
    const { content, truncation } = buffer.snapshot();
    expect(truncation.totalBytes).toBeLessThanOrEqual(2 * maxBytes);
    // Not vacuous: the cap must be near-full, not an empty or single-chunk buffer.
    expect(truncation.totalBytes).toBeGreaterThan(maxBytes);
    // A buffer that evicted the NEWEST chunk instead would satisfy the cap while losing what matters.
    expect(content).toContain('#199 ');
    expect(content).not.toContain('#0 ');
  });

  it('never drops a single oversized chunk, so the buffer can exceed the cap by one chunk', () => {
    // pi's `while (outputBytes > max && outputChunks.length > 1)` guard keeps the last chunk whatever
    // its size. Damocles mirrors that rather than "fixing" it, so assert the real behaviour.
    const maxBytes = 1_000;
    const buffer = createShellOutputBuffer(truncateTail, DEFAULT_MAX_LINES, maxBytes);
    buffer.append('a'.repeat(5_000));

    expect(buffer.snapshot().truncation.totalBytes).toBe(5_000);
  });

  it('reports truncated past maxLines and not at the limit', () => {
    // pi pops the trailing empty line when counting, so exactly maxLines newline-terminated lines fit.
    const atLimit = build();
    for (let i = 0; i < DEFAULT_MAX_LINES; i++) atLimit.append(`line ${i}\n`);
    const fits = atLimit.snapshot();
    expect(fits.truncation.totalLines).toBe(DEFAULT_MAX_LINES);
    expect(fits.truncation.truncated).toBe(false);

    const over = build();
    for (let i = 0; i <= DEFAULT_MAX_LINES; i++) over.append(`line ${i}\n`);
    const spilled = over.snapshot();
    expect(spilled.truncation.totalLines).toBe(DEFAULT_MAX_LINES + 1);
    expect(spilled.truncation.truncated).toBe(true);
    expect(spilled.truncation.truncatedBy).toBe('lines');
  });

  it('keeps the tail and drops the head once past maxLines', () => {
    const buffer = build();
    const total = DEFAULT_MAX_LINES + 500;
    for (let i = 0; i < total; i++) buffer.append(`line ${i}\n`);

    const { content } = buffer.snapshot();
    // The newest line survives AND an early one is gone: head-keeping truncation fails both halves.
    expect(content).toContain(`line ${total - 1}`);
    expect(content).not.toContain('line 0\n');
    expect(content.split('\n')[0]).toBe(`line ${total - DEFAULT_MAX_LINES}`);
  });

  it('interleaves appends in call order, since stdout and stderr share one buffer', () => {
    const buffer = build();
    buffer.append('out-1\n');
    buffer.append('err-1\n');
    buffer.append('out-2\n');

    expect(buffer.snapshot().content).toBe('out-1\nerr-1\nout-2\n');
  });
});

/** A stand-in for the spawned shell, so the streaming, throttle and abort paths run on every platform. */
interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout: EventEmitter;
  stderr: EventEmitter;
}

function fakeChild(pid: number | undefined = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** The leading text of a tool result or an update frame, asserting it is text rather than reading `undefined`. */
function textOf(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('result did not start with a text block');
  return first.text;
}

/**
 * The streaming path around a fake shell. `emitUpdate`, `scheduleUpdate` and `clearUpdateTimer` decide
 * what the card shows while a command runs, and none of it is reachable through a real PowerShell run
 * on a non-Windows machine.
 */
describe('PowerShell streaming and throttle', () => {
  const pi = { truncateTail, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, defineTool } as unknown as PiCodingAgentModule;
  const realCreateShellJob = vi.mocked(createShellJob).getMockImplementation();
  const realKillProcessTree = vi.mocked(killProcessTree).getMockImplementation();

  beforeEach(() => {
    spawnControl.calls = [];
    // The fake pid names no real process, so neither the job object nor the kill may run for real.
    vi.mocked(createShellJob).mockImplementation(() => undefined);
    vi.mocked(killProcessTree).mockImplementation(() => undefined);
  });

  afterEach(() => {
    spawnControl.fake = null;
    if (realCreateShellJob) vi.mocked(createShellJob).mockImplementation(realCreateShellJob);
    if (realKillProcessTree) vi.mocked(killProcessTree).mockImplementation(realKillProcessTree);
    vi.useRealTimers();
  });

  it('emits an initial empty frame, coalesces bursts into one frame per 100 ms, and forces a final frame with the complete output', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnControl.fake = () => child;
    const tool = createPowerShellTool(pi, process.cwd(), undefined);
    const onUpdate = vi.fn();

    const pending = tool.execute('ps-stream', { command: 'Get-Process' }, undefined, onUpdate, undefined as never);
    // The working-directory check is real I/O, so yield until the shell has actually been spawned.
    await vi.waitFor(() => expect(spawnControl.calls.length).toBe(1));

    // The empty frame is emitted before the spawn, so the card is not blank while the shell starts.
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]).toEqual({ content: [{ type: 'text', text: '' }], details: undefined });

    // `lastUpdateAt` starts at zero, so the first chunk is already past the window and emits at once.
    child.stdout.emit('data', Buffer.from('chunk-0\n'));
    expect(onUpdate).toHaveBeenCalledTimes(2);

    for (let i = 1; i <= 50; i++) child.stdout.emit('data', Buffer.from(`chunk-${i}\n`));
    expect(onUpdate).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(POWERSHELL_UPDATE_THROTTLE_MS);
    expect(onUpdate).toHaveBeenCalledTimes(3);

    for (let i = 51; i <= 100; i++) child.stdout.emit('data', Buffer.from(`chunk-${i}\n`));
    expect(onUpdate).toHaveBeenCalledTimes(3);

    child.emit('close', 0);
    const result = await pending;

    // 101 chunks, four frames: the throttle is what keeps the card off the render path per chunk.
    expect(onUpdate).toHaveBeenCalledTimes(4);
    // The forced last frame carries what the throttle had not flushed yet, not just the output up to it.
    const lastFrame = onUpdate.mock.calls[3]?.[0] as AgentToolResult<unknown>;
    expect(textOf(lastFrame)).toContain('chunk-0\n');
    expect(textOf(lastFrame)).toContain('chunk-100\n');
    expect(textOf(result)).toContain('chunk-100');

    // A timer still armed here would fire a frame after the tool already settled.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onUpdate).toHaveBeenCalledTimes(4);
  });

  it('forces a final frame even when the throttle already flushed everything, so the card never keeps a stale snapshot', async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    spawnControl.fake = () => child;
    const tool = createPowerShellTool(pi, process.cwd(), undefined);
    const onUpdate = vi.fn();

    const pending = tool.execute('ps-final', { command: 'Get-Process' }, undefined, onUpdate, undefined as never);
    await vi.waitFor(() => expect(spawnControl.calls.length).toBe(1));

    child.stdout.emit('data', Buffer.from('only line\n'));
    await vi.advanceTimersByTimeAsync(POWERSHELL_UPDATE_THROTTLE_MS);
    // Nothing is dirty any more, so only a forced frame can follow and a dropped force shows up as a missing call.
    const beforeClose = onUpdate.mock.calls.length;
    expect(beforeClose).toBe(2);

    child.emit('close', 0);
    await pending;

    expect(onUpdate).toHaveBeenCalledTimes(beforeClose + 1);
    expect(textOf(onUpdate.mock.calls[beforeClose]?.[0] as AgentToolResult<unknown>)).toContain('only line');
  });

  it('passes windowsHide so no console window flashes for a command', async () => {
    const child = fakeChild();
    let seen: Record<string, unknown> | undefined;
    spawnControl.fake = (_exe, options) => {
      seen = options as Record<string, unknown>;
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    const tool = createPowerShellTool(pi, process.cwd(), undefined);

    await tool.execute('ps-hide', { command: 'Write-Output ok' }, undefined, undefined, undefined as never);

    expect(seen?.['windowsHide']).toBe(true);
  });

  it('kills nothing once the child has been reaped, since that pid is free to be reused', async () => {
    const child = fakeChild();
    spawnControl.fake = () => child;
    const tool = createPowerShellTool(pi, process.cwd(), undefined);
    const controller = new AbortController();

    const pending = tool.execute('ps-latch', { command: 'Start-Sleep 30' }, controller.signal, undefined, undefined as never);
    await vi.waitFor(() => expect(spawnControl.calls.length).toBe(1));

    // The gap the latch closes: the child is reaped, but 'close' has not landed and the listeners are live.
    child.emit('exit', 0, null);
    controller.abort();
    child.emit('close', 0);
    await pending;

    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('stops the fallback executable from starting once the user has already aborted', async () => {
    const child = fakeChild();
    spawnControl.fake = (exe) => {
      if (exe === 'pwsh') setImmediate(() => child.emit('error', Object.assign(new Error('spawn pwsh ENOENT'), { code: 'ENOENT' })));
      else setImmediate(() => child.emit('close', 0));
      return child;
    };
    const tool = createPowerShellTool(pi, process.cwd(), undefined);

    const result = await tool.execute('ps-aborted', { command: 'Get-Process', timeout: 50 }, AbortSignal.abort(), undefined, undefined as never);

    // Neither executable may be started, and the answer must be the abort rather than "PowerShell not found".
    expect(spawnControl.calls).toEqual([]);
    expect(textOf(result)).toBe('PowerShell command aborted.');
  });

  it('reports a missing working directory instead of blaming a missing PowerShell', async () => {
    const missing = join(tmpdir(), 'damocles-no-such-dir-7c2e40');
    spawnControl.fake = () => fakeChild();
    const tool = createPowerShellTool(pi, missing, undefined);

    await expect(tool.execute('ps-cwd', { command: 'Write-Output ok' }, undefined, undefined, undefined as never)).rejects.toThrow(
      /Working directory does not exist/,
    );
    expect(spawnControl.calls).toEqual([]);
  });
});

/**
 * PowerShell used to carry its own `killTree`, which reached descendants on Windows only, left POSIX with
 * a bare SIGTERM to the direct process, and was never reached on abort at all. It now goes through the
 * shared helper and gets a real job object, the same contract the bash operations meet. Windows-only
 * because a real shell has to be spawned.
 */
describe.runIf(process.platform === 'win32')('PowerShell process lifetime', () => {
  const pi = { truncateTail, DEFAULT_MAX_LINES, DEFAULT_MAX_BYTES, defineTool } as unknown as PiCodingAgentModule;

  beforeEach(() => {
    jobState.created = 0;
    jobState.terminated = 0;
    jobState.disposed = 0;
    vi.mocked(killProcessTree).mockClear();
    vi.mocked(createShellJob).mockClear();
  });

  it('gets its own job object and terminates it when a command is aborted', async () => {
    const tool = createPowerShellTool(pi, process.cwd(), undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);

    const result = await tool.execute('ps-1', { command: 'Start-Sleep -Seconds 30' }, controller.signal, undefined, undefined as never);

    expect(JSON.stringify(result.content)).toContain('aborted');
    expect(jobState.created).toBe(1);
    expect(killProcessTree).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ terminate: expect.any(Function) }));
    expect(jobState.terminated).toBeGreaterThan(0);
    expect(jobState.disposed).toBeGreaterThan(0);
  }, 30_000);

  it('releases the job on the normal exit path', async () => {
    const tool = createPowerShellTool(pi, process.cwd(), undefined);

    await tool.execute('ps-2', { command: 'Write-Output ok' }, undefined, undefined, undefined as never);

    expect(jobState.created).toBe(1);
    expect(jobState.disposed).toBeGreaterThan(0);
    expect(killProcessTree).not.toHaveBeenCalled();
  }, 30_000);
});
