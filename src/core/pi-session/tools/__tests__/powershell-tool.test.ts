import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { constants as osConstants, tmpdir } from 'node:os';
import { join } from 'node:path';
// The REAL pi shell definition, because every status string asserted below is pi's and a stub would
// pin nothing but the stub. Test files may value-import the ESM pi package; extension source may not.
import { createPowerShellToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { PiCodingAgentModule } from '../../pi-loader';
import { createPowerShellTool, createTrackedPowerShellOperations } from '../powershell-tool';
import { createShellJob, killProcessTree } from '../process-tree';

const jobState = vi.hoisted(() => ({ created: 0, terminated: 0, disposed: 0 }));

/** Set only by the cases that drive a fake shell; a null hook leaves the real `spawn` in place for the Windows cases. */
const spawnControl = vi.hoisted(() => ({
  fake: null as ((exe: string, args: string[], options: Record<string, unknown>) => unknown) | null,
  calls: [] as Array<{ exe: string; args: string[]; options: Record<string, unknown> }>,
}));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: import('child_process').SpawnOptions) => {
      if (!spawnControl.fake) return actual.spawn(command, args, options);
      spawnControl.calls.push({ exe: command, args, options: options as Record<string, unknown> });
      return spawnControl.fake(command, args, options as Record<string, unknown>);
    },
  };
});

// `killProcessTree` calls through, so the Windows abort case below still really kills its shell.
vi.mock('../process-tree', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../process-tree')>();
  return {
    ...actual,
    killProcessTree: vi.fn(actual.killProcessTree),
    createShellJob: vi.fn((pid: number, session: import('../process-tree').ShellSessionJob | undefined) => {
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

/** pi's own literal, mirrored because `powershell.js` keeps it module-local. */
const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

const CWD = process.cwd();

/** pi's `ExtensionContext`; the shell definition reads only `cwd` off it, which the tool already has. */
const ctx = undefined as never;

const pi = { createPowerShellToolDefinition } as unknown as PiCodingAgentModule;

/** A stand-in for the spawned shell, so the exit, timeout and abort paths run on every platform. */
interface FakeStream extends EventEmitter {
  destroy: () => void;
}

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdout: FakeStream;
  stderr: FakeStream;
}

/** `destroy` is required: the exit wait tears the pipes down itself once the shell has settled. */
function fakeStream(): FakeStream {
  const stream = new EventEmitter() as FakeStream;
  stream.destroy = (): void => undefined;
  return stream;
}

function fakeChild(pid: number | undefined = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdout = fakeStream();
  child.stderr = fakeStream();
  return child;
}

function enoent(exe: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${exe} ENOENT`), { code: 'ENOENT' });
}

/**
 * Install a fake shell and expose the moment the implementation reaches `spawn`. Resolving off the
 * spawn itself, rather than off a timer, is what lets the cases below drive the child with no wait.
 */
function armFakeShell(pid?: number): { child: FakeChild; spawned: Promise<void> } {
  const child = fakeChild(pid);
  let markSpawned!: () => void;
  const spawned = new Promise<void>((resolve) => {
    markSpawned = resolve;
  });
  spawnControl.fake = () => {
    markSpawned();
    return child;
  };
  return { child, spawned };
}

/** The message a rejected tool call carries, failing loudly when the call resolved instead. */
async function messageOf(pending: Promise<unknown>): Promise<string> {
  try {
    await pending;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the tool returned a result where it had to throw');
}

/** The leading text of a tool result, asserting it is text rather than reading `undefined`. */
function textOf(result: AgentToolResult<unknown>): string {
  const first = result.content[0];
  if (first?.type !== 'text') throw new Error('result did not start with a text block');
  return first.text;
}

/** Marking the rejection handled here keeps a pending failure off the unhandled-rejection reporter. */
function start(
  params: { command: string; timeout?: number },
  options: { signal?: AbortSignal; onUpdate?: (partial: AgentToolResult<unknown>) => void; cwd?: string } = {},
): Promise<AgentToolResult<unknown>> {
  const tool = createPowerShellTool(pi, options.cwd ?? CWD, undefined);
  const pending = tool.execute('ps-call', params, options.signal, options.onUpdate, ctx) as Promise<AgentToolResult<unknown>>;
  void pending.catch(() => undefined);
  return pending;
}

/** Restores the module-level fakes the fake-shell describes install, so the Windows cases get the real ones back. */
function useFakeShellEnvironment(): void {
  const realCreateShellJob = vi.mocked(createShellJob).getMockImplementation();
  const realKillProcessTree = vi.mocked(killProcessTree).getMockImplementation();

  beforeEach(() => {
    spawnControl.calls = [];
    // The fake pid names no real process, so neither the job object nor the kill may run for real.
    vi.mocked(createShellJob).mockImplementation(() => undefined);
    vi.mocked(killProcessTree).mockImplementation(() => undefined);
    vi.mocked(killProcessTree).mockClear();
    vi.mocked(createShellJob).mockClear();
  });

  afterEach(() => {
    spawnControl.fake = null;
    if (realCreateShellJob) vi.mocked(createShellJob).mockImplementation(realCreateShellJob);
    if (realKillProcessTree) vi.mocked(killProcessTree).mockImplementation(realKillProcessTree);
    vi.useRealTimers();
  });
}

/**
 * The operations layer on its own. It is the half that owns the spawn, the executable fallback and the
 * exit-code mapping; pi's shell definition owns everything downstream of the number it returns.
 */
describe('createTrackedPowerShellOperations', () => {
  useFakeShellEnvironment();
  const ops = createTrackedPowerShellOperations(undefined);

  it('maps a shell killed by a signal onto 128 + the signal number', async () => {
    const shell = armFakeShell();
    const settled = ops.exec('Start-Sleep 30', CWD, { onData: () => undefined, env: process.env });
    await shell.spawned;

    shell.child.emit('close', null, 'SIGKILL');

    expect(osConstants.signals.SIGKILL).toBe(9);
    await expect(settled).resolves.toEqual({ exitCode: 128 + osConstants.signals.SIGKILL });
  });

  it('maps a close carrying neither a code nor a signal onto exit code 1, never onto null', async () => {
    const shell = armFakeShell();
    const settled = ops.exec('Write-Output ok', CWD, { onData: () => undefined, env: process.env });
    await shell.spawned;

    shell.child.emit('close', null, null);

    // A null here is what makes pi report "Command terminated without an exit code", which this
    // implementation can therefore never produce.
    await expect(settled).resolves.toEqual({ exitCode: 1 });
  });

  it('prepends the UTF-8 console encoding line to the command it spawns', async () => {
    const shell = armFakeShell();
    const settled = ops.exec('Get-ChildItem', CWD, { onData: () => undefined, env: process.env });
    await shell.spawned;
    shell.child.emit('close', 0);
    await settled;

    expect(spawnControl.calls[0]?.args).toEqual([...POWERSHELL_ARGS, `${UTF8_OUTPUT_PREFIX}Get-ChildItem`]);
  });

  it('falls through to powershell.exe when spawning pwsh throws synchronously', async () => {
    const child = fakeChild();
    spawnControl.fake = (exe) => {
      if (exe === 'pwsh') throw enoent('pwsh');
      setImmediate(() => child.emit('close', 0));
      return child;
    };

    await expect(ops.exec('Write-Output ok', CWD, { onData: () => undefined, env: process.env })).resolves.toEqual({ exitCode: 0 });

    expect(spawnControl.calls.map((call) => call.exe)).toEqual(['pwsh', 'powershell.exe']);
  });

  it("falls through to powershell.exe when pwsh reports ENOENT on the child's error event", async () => {
    spawnControl.fake = (exe) => {
      const child = fakeChild();
      if (exe === 'pwsh') setImmediate(() => child.emit('error', enoent('pwsh')));
      else setImmediate(() => child.emit('close', 0));
      return child;
    };

    await expect(ops.exec('Write-Output ok', CWD, { onData: () => undefined, env: process.env })).resolves.toEqual({ exitCode: 0 });

    expect(spawnControl.calls.map((call) => call.exe)).toEqual(['pwsh', 'powershell.exe']);
  });

  it('throws naming both candidates when neither executable exists', async () => {
    spawnControl.fake = (exe) => {
      const child = fakeChild();
      setImmediate(() => child.emit('error', enoent(exe)));
      return child;
    };

    const message = await messageOf(ops.exec('Write-Output ok', CWD, { onData: () => undefined, env: process.env }));

    // Named candidates, because a bare "PowerShell not found" reads to a model as a command it may retry.
    expect(message).toContain('pwsh');
    expect(message).toContain('powershell.exe');
    expect(spawnControl.calls.map((call) => call.exe)).toEqual(['pwsh', 'powershell.exe']);
  });

  it('refuses to spawn a shell when no environment was supplied', async () => {
    // Omitting it makes spawn inherit the extension host environment, which holds provider credentials.
    await expect(ops.exec('Write-Output leak', CWD, { onData: () => undefined })).rejects.toThrow(
      'PowerShell exec requires an explicit environment',
    );

    expect(spawnControl.calls).toEqual([]);
  });

  it('reports a missing working directory instead of blaming a missing PowerShell', async () => {
    const missing = join(tmpdir(), 'damocles-no-such-dir-7c2e40');
    spawnControl.fake = () => fakeChild();

    const message = await messageOf(ops.exec('Write-Output ok', missing, { onData: () => undefined, env: process.env }));

    expect(message).toContain('Working directory does not exist');
    expect(message).toContain('Cannot execute PowerShell commands.');
    expect(spawnControl.calls).toEqual([]);
  });

  it('starts no shell at all once the user has already aborted', async () => {
    spawnControl.fake = () => fakeChild();

    await expect(ops.exec('Get-Process', CWD, { onData: () => undefined, env: process.env, signal: AbortSignal.abort() })).rejects.toThrow(
      'aborted',
    );

    expect(spawnControl.calls).toEqual([]);
  });
});

/**
 * pi's shell definition owns the result. Every non-zero outcome reaches the model as a thrown error
 * carrying the partial output, which is what stops three lines of a build log reading as a finished
 * build. The status wording is pi's, from `dist/core/tools/bash.js`.
 */
describe('the PowerShell tool result', () => {
  useFakeShellEnvironment();

  it('returns the output as a normal result for exit code 0', async () => {
    const shell = armFakeShell();
    const settled = start({ command: 'Write-Output ok' });
    await shell.spawned;

    shell.child.stdout.emit('data', Buffer.from('ok\n'));
    shell.child.emit('close', 0);

    expect(textOf(await settled)).toContain('ok');
  });

  it('THROWS "Command exited with code 42" for a non-zero exit instead of returning a success', async () => {
    const shell = armFakeShell();
    const settled = start({ command: 'exit 42' });
    await shell.spawned;

    shell.child.stdout.emit('data', Buffer.from('build failed\n'));
    shell.child.emit('close', 42);

    const message = await messageOf(settled);
    expect(message).toContain('build failed');
    expect(message.endsWith('Command exited with code 42')).toBe(true);
    // The trailing `[exit code 42]` note of a success-shaped result is not an error to the agent loop.
    expect(message).not.toContain('[exit code');
  });

  it('throws "Command exited with code 137" for a shell killed by SIGKILL', async () => {
    const shell = armFakeShell();
    const settled = start({ command: 'Start-Sleep 30' });
    await shell.spawned;

    shell.child.emit('close', null, 'SIGKILL');

    const message = await messageOf(settled);
    // 128 + SIGKILL, the shell convention the operations layer reports in place of a null exit code.
    expect(128 + osConstants.signals.SIGKILL).toBe(137);
    expect(message.endsWith('Command exited with code 137')).toBe(true);
  });

  it('throws "Command exited with code 1", not "terminated without an exit code", for a close with no code and no signal', async () => {
    const shell = armFakeShell();
    const settled = start({ command: 'Write-Output ok' });
    await shell.spawned;

    shell.child.emit('close', null, null);

    const message = await messageOf(settled);
    expect(message.endsWith('Command exited with code 1')).toBe(true);
    // pi reaches that wording only for an `exitCode: null`, which the operations layer never returns.
    expect(message).not.toContain('terminated without an exit code');
  });

  it('throws the timeout status BEHIND the partial output, and reads the timeout parameter as seconds', async () => {
    vi.useFakeTimers();
    const shell = armFakeShell();
    const settled = start({ command: 'npm run build', timeout: 1 });
    await shell.spawned;

    shell.child.stdout.emit('data', Buffer.from('Compiling 1 of 400\n'));

    // A timeout read as milliseconds would have fired the kill inside this window.
    await vi.advanceTimersByTimeAsync(999);
    expect(killProcessTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(killProcessTree).toHaveBeenCalledTimes(1);

    shell.child.emit('close', null, 'SIGKILL');

    const message = await messageOf(settled);
    expect(message).toContain('Compiling 1 of 400');
    // Partial output alone, returned as a success, reads to a model as a build that finished.
    expect(message.endsWith('Command timed out after 1 seconds')).toBe(true);
  });

  it('throws "Command aborted" behind the partial output when the run signal fires mid-command', async () => {
    const shell = armFakeShell();
    const controller = new AbortController();
    const settled = start({ command: 'Start-Sleep 30' }, { signal: controller.signal });
    await shell.spawned;

    shell.child.stdout.emit('data', Buffer.from('two lines in\n'));
    controller.abort();
    expect(killProcessTree).toHaveBeenCalledTimes(1);

    shell.child.emit('close', null, 'SIGTERM');

    const message = await messageOf(settled);
    expect(message).toContain('two lines in');
    expect(message.endsWith('Command aborted')).toBe(true);
  });

  it('throws a bare "Command aborted" when the signal was already aborted, so no fallback shell starts', async () => {
    spawnControl.fake = () => fakeChild();

    const message = await messageOf(start({ command: 'Get-Process', timeout: 50 }, { signal: AbortSignal.abort() }));

    expect(message).toBe('Command aborted');
    expect(spawnControl.calls).toEqual([]);
  });

  it('kills nothing once the child has been reaped, since that pid is free to be reused', async () => {
    const shell = armFakeShell();
    const controller = new AbortController();
    const settled = start({ command: 'Start-Sleep 30' }, { signal: controller.signal });
    await shell.spawned;

    // The gap the latch closes: the child is reaped, but 'close' has not landed and the listeners are live.
    shell.child.emit('exit', 0, null);
    controller.abort();
    shell.child.emit('close', 0);
    await messageOf(settled);

    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('passes windowsHide so no console window flashes for a command', async () => {
    const shell = armFakeShell();
    const settled = start({ command: 'Write-Output ok' });
    await shell.spawned;
    shell.child.emit('close', 0);
    await settled;

    expect(spawnControl.calls[0]?.options['windowsHide']).toBe(true);
  });

  it('reports a missing working directory instead of blaming a missing PowerShell', async () => {
    const missing = join(tmpdir(), 'damocles-no-such-dir-7c2e40');
    spawnControl.fake = () => fakeChild();

    const message = await messageOf(start({ command: 'Write-Output ok' }, { cwd: missing }));

    expect(message).toContain('Working directory does not exist');
    expect(spawnControl.calls).toEqual([]);
  });
});

describe('the PowerShell tool identity', () => {
  it('registers under the capitalised PowerShell, which pi\'s own lowercase built-in must never become', () => {
    const tool = createPowerShellTool(pi, '/cwd', undefined);

    expect(tool.name).toBe('PowerShell');
    expect(tool.label).toBe('PowerShell');
    // `mapPiToolName`, the permission gate and the read-only-shell classifier all key off the spelling.
    expect(createPowerShellToolDefinition('/cwd').name).toBe('powershell');
  });

  it("carries pi's own shell parameters, whose timeout is documented in seconds, plus the card summary", () => {
    const tool = createPowerShellTool(pi, '/cwd', undefined);

    const upstream = (createPowerShellToolDefinition('/cwd').parameters as { properties: Record<string, { description?: string }> }).properties;
    const shipped = (tool.parameters as { properties: Record<string, unknown> }).properties;
    // Non-vacuous: both sides must be a real object schema, not two undefineds comparing equal.
    expect(Object.keys(upstream)).toEqual(expect.arrayContaining(['command', 'timeout']));
    expect(upstream['timeout']?.description).toBe('Timeout in seconds (optional, no default timeout)');
    for (const [name, schema] of Object.entries(upstream)) expect(shipped[name]).toEqual(schema);
    // `ToolOverlay` renders this as the card summary; pi's schema has no field for it.
    expect(Object.keys(shipped)).toEqual([...Object.keys(upstream), 'description']);
  });
});

/**
 * The shared process-lifetime helper, against a real shell. Windows-only because a PowerShell has to
 * actually be spawned for a job object to exist.
 */
describe.runIf(process.platform === 'win32')('PowerShell process lifetime', () => {
  beforeEach(() => {
    jobState.created = 0;
    jobState.terminated = 0;
    jobState.disposed = 0;
    vi.mocked(killProcessTree).mockClear();
    vi.mocked(createShellJob).mockClear();
  });

  it('gets its own job object and terminates it when a command is aborted', async () => {
    const tool = createPowerShellTool(pi, CWD, undefined);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 700);

    const message = await messageOf(tool.execute('ps-1', { command: 'Start-Sleep -Seconds 30' }, controller.signal, undefined, ctx));

    expect(message).toContain('Command aborted');
    expect(jobState.created).toBe(1);
    expect(killProcessTree).toHaveBeenCalledWith(expect.any(Number), expect.objectContaining({ terminate: expect.any(Function) }));
    expect(jobState.terminated).toBeGreaterThan(0);
    expect(jobState.disposed).toBeGreaterThan(0);
  }, 30_000);

  it('releases the job on the normal exit path', async () => {
    const tool = createPowerShellTool(pi, CWD, undefined);

    const result = await tool.execute('ps-2', { command: 'Write-Output ok' }, undefined, undefined, ctx);

    expect(textOf(result as AgentToolResult<unknown>)).toContain('ok');
    expect(jobState.created).toBe(1);
    expect(jobState.disposed).toBeGreaterThan(0);
    expect(killProcessTree).not.toHaveBeenCalled();
  }, 30_000);

  it('throws the exit code of a real failing command', async () => {
    const tool = createPowerShellTool(pi, CWD, undefined);

    const message = await messageOf(tool.execute('ps-3', { command: 'exit 42' }, undefined, undefined, ctx));

    expect(message.endsWith('Command exited with code 42')).toBe(true);
  }, 30_000);
});
