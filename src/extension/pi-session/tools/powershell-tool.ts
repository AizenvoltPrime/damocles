import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { spawn, type ChildProcess } from 'child_process';
import type { PowerShellOperations, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_POWERSHELL } from '../../../shared/tool-names';
import { resolveTimeoutMs, waitForShellExit, withCommandDescription, type ShellExit } from './bash-tool';
import { createShellJob, killProcessTree, type ShellSessionJob } from './process-tree';

/** Without it PowerShell writes the console codepage and any non-ASCII output decodes as mojibake. */
const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

/** `pwsh` leads so PowerShell 7 wins where both exist, and it is the only one that resolves off Windows. */
const POWERSHELL_EXECUTABLES = ['pwsh', 'powershell.exe'] as const;

const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-Command'];

/** pi's shell definition carries its own schema and render types; only the erased shape is assignable both ways. */
type AnyToolDefinition = ToolDefinition<any, any, any>;

interface ExecOnceOptions {
  onData: (data: Buffer) => void;
  signal: AbortSignal | undefined;
  /** Seconds, carried alongside the resolved milliseconds because pi matches on `timeout:<seconds>`. */
  timeout: number | undefined;
  timeoutMs: number | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * Run one candidate executable. Resolves `undefined` when that executable is not installed, which is
 * what lets the caller fall through to the next one.
 */
async function execOnce(
  exe: string,
  command: string,
  cwd: string,
  options: ExecOnceOptions,
  shellJob: ShellSessionJob | undefined,
): Promise<{ exitCode: number | null } | undefined> {
  const { onData, signal, timeout, timeoutMs, env } = options;
  let child: ChildProcess;
  try {
    child = spawn(exe, [...POWERSHELL_ARGS, command], {
      cwd,
      // POSIX gets its own process group here; that group is what makes the shell's descendants killable.
      detached: process.platform !== 'win32',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return undefined;
  }
  // Must stay the first statement after spawn: a child created before assignment is outside the job permanently.
  const job = child.pid === undefined ? undefined : createShellJob(child.pid, shellJob);

  // The pid is reusable the moment the child is reaped, so a later kill would land on a stranger.
  let exited = false;
  child.once('exit', () => {
    exited = true;
  });
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const killShell = (): void => {
    if (exited || child.pid === undefined) return;
    killProcessTree(child.pid, job);
  };

  try {
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killShell();
      }, timeoutMs);
    }
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    if (signal) {
      if (signal.aborted) killShell();
      else signal.addEventListener('abort', killShell, { once: true });
    }

    let exit: ShellExit;
    try {
      exit = await waitForShellExit(child);
    } catch (err) {
      // A missing executable surfaces here rather than from `spawn`, so the fallback is chosen on it.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    if (signal?.aborted) throw new Error('aborted');
    if (timedOut) throw new Error(`timeout:${timeout}`);
    // A signal-killed shell has no exit code, and pi's shell tool rejects a null one, so the shell
    // convention stands in for it.
    return { exitCode: exit.code ?? (exit.signal ? 128 + (osConstants.signals[exit.signal] ?? 0) : 1) };
  } finally {
    job?.dispose();
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener('abort', killShell);
  }
}

/**
 * pi's local PowerShell operations, reimplemented so the spawned shell's pid is visible here.
 *
 * `createLocalPowerShellOperations` spawns internally and surfaces only the exit code, so nothing
 * wrapped around it can name the process to track, which is the same reason `bash-tool.ts` owns its
 * spawn. It also resolves the executable through `getPowerShellConfig`, which throws off win32; this
 * tool is registered on every platform, so the candidates are tried here instead.
 * The thrown `aborted` and `timeout:<seconds>` messages are the two pi's shell tool matches on.
 */
export function createTrackedPowerShellOperations(shellJob: ShellSessionJob | undefined): PowerShellOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error('aborted');
      // Omitting it makes spawn inherit the extension host environment, which holds provider credentials.
      if (env === undefined) throw new Error('PowerShell exec requires an explicit environment');
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`);
      }
      for (const exe of POWERSHELL_EXECUTABLES) {
        // An abort raised while the first executable failed must stop the fallback from starting a shell.
        if (signal?.aborted) throw new Error('aborted');
        const result = await execOnce(exe, `${UTF8_OUTPUT_PREFIX}${command}`, cwd, { onData, signal, timeout, timeoutMs, env }, shellJob);
        if (result) return result;
      }
      throw new Error(`No PowerShell executable found (tried ${POWERSHELL_EXECUTABLES.join(' and ')}).`);
    },
  };
}

/**
 * The `PowerShell` tool. pi's own shell definition does the result handling, so a non-zero exit, a
 * null exit code and a timeout all reach the model as errors with the same wording bash uses.
 *
 * The name must stay the capitalised `PowerShell`: pi ships a separate lowercase `powershell`
 * built-in, and `mapPiToolName`, the permission gate and the read-only-shell classifier all key off
 * the exact spelling. `pi-session.test.ts` pins that the two never converge.
 */
export function createPowerShellTool(pi: PiCodingAgentModule, cwd: string, shellJob: ShellSessionJob | undefined): ToolDefinition {
  const operations = createTrackedPowerShellOperations(shellJob);
  const definition: AnyToolDefinition = pi.createPowerShellToolDefinition(cwd, { operations });
  return { ...definition, name: TOOL_POWERSHELL, label: 'PowerShell', parameters: withCommandDescription(definition.parameters) };
}
