import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import type { PowerShellOperations, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AnyToolDefinition } from './any-tool-definition';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_POWERSHELL } from '../../../shared/tool-names';
import { resolveTimeoutMs, SHELL_EXIT_OUTPUT_GRACE_MS, waitForShellExit, withCommandDescription, type ShellExit } from './bash-tool';
import { processLauncher, type SessionJob } from '../../process-launcher';
import { findPwsh, windowsPowerShell } from '../../system-tools';

/** Without it PowerShell writes the console codepage and any non-ASCII output decodes as mojibake. */
const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

/**
 * Absolute paths only: a bare name would search the working folder (a repository) first on Windows. `pwsh` leads so
 * PowerShell 7 wins where both exist, and it is the only one off Windows.
 */
async function powerShellExecutables(env: NodeJS.ProcessEnv): Promise<string[]> {
  const pwsh = await findPwsh(env);
  return [...(pwsh !== undefined ? [pwsh] : []), ...(process.platform === 'win32' ? [windowsPowerShell()] : [])];
}

/**
 * Process-scope `Bypass`, so `.ps1` shims such as `npm.ps1` run under Windows' default `Restricted`
 * policy. A Group Policy setting still overrides it. Execution policy exists only on Windows.
 */
const POWERSHELL_ARGS = [
  '-NoProfile',
  '-NonInteractive',
  ...(process.platform === 'win32' ? ['-ExecutionPolicy', 'Bypass'] : []),
  '-Command',
];


interface ExecOnceOptions {
  onData: (data: Buffer) => void;
  signal: AbortSignal | undefined;
  /** Seconds, carried alongside the resolved milliseconds because pi matches on `timeout:<seconds>`. */
  timeout: number | undefined;
  timeoutMs: number | undefined;
  env: NodeJS.ProcessEnv;
}

/**
 * Run one candidate executable. Resolves its start error when it could not start, which is what lets the caller fall
 * through to the next one.
 */
async function execOnce(
  exe: string,
  command: string,
  cwd: string,
  options: ExecOnceOptions,
  shellJob: SessionJob | undefined,
): Promise<{ exitCode: number | null } | { startError: Error }> {
  const { onData, signal, timeout, timeoutMs, env } = options;
  const shell = processLauncher().launch({
    file: exe,
    args: [...POWERSHELL_ARGS, command],
    cwd,
    // POSIX gets its own process group here; that group is what makes the shell's descendants killable.
    detached: process.platform !== 'win32',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    exitOutputIdleMs: SHELL_EXIT_OUTPUT_GRACE_MS,
    ...(shellJob ? { job: shellJob.id } : {}),
  });

  const started = shell.pid.then(() => true, () => false);
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  // Once the shell has exited, a tree kill would reach the jobs it deliberately left running.
  const killShell = (): void => shell.kill({ tree: true, whileRunning: true });

  try {
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        killShell();
      }, timeoutMs);
    }
    shell.onData('stdout', onData);
    shell.onData('stderr', onData);
    if (signal) {
      if (signal.aborted) killShell();
      else signal.addEventListener('abort', killShell, { once: true });
    }

    let exit: ShellExit;
    try {
      exit = await waitForShellExit(shell);
    } catch (err) {
      // A process that never started ran nothing, so the next candidate may run the command.
      if (!(await started)) return { startError: err instanceof Error ? err : new Error(String(err)) };
      throw err;
    }
    if (signal?.aborted) throw new Error('aborted');
    if (timedOut) throw new Error(`timeout:${timeout}`);
    // A signal-killed shell has no exit code, and pi's shell tool rejects a null one, so the shell
    // convention stands in for it.
    return { exitCode: exit.code ?? (exit.signal ? 128 + (osConstants.signals[exit.signal] ?? 0) : 1) };
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    if (signal) signal.removeEventListener('abort', killShell);
  }
}

/**
 * pi's local PowerShell operations, reimplemented so the shell starts on the process launcher inside
 * the panel's session job.
 *
 * `createLocalPowerShellOperations` spawns internally and surfaces only the exit code, so nothing
 * wrapped around it can put the shell in a job or stop its tree, which is the same reason `bash-tool.ts`
 * owns its start. It also resolves the executable through `getPowerShellConfig`, which throws off win32; this
 * tool is registered on every platform, so the candidates are tried here instead.
 * The thrown `aborted` and `timeout:<seconds>` messages are the two pi's shell tool matches on.
 */
export function createTrackedPowerShellOperations(shellJob: SessionJob | undefined, extraEnv: () => Readonly<Record<string, string>> | undefined = () => undefined): PowerShellOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env: piEnv }) => {
      const extra = extraEnv();
      const env = piEnv !== undefined && extra !== undefined ? { ...piEnv, ...extra } : piEnv;
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error('aborted');
      // Omitting it makes spawn inherit the extension host environment, which holds provider credentials.
      if (env === undefined) throw new Error('PowerShell exec requires an explicit environment');
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`);
      }
      const failures: string[] = [];
      for (const exe of await powerShellExecutables(env)) {
        // An abort raised while the first executable failed must stop the fallback from starting a shell.
        if (signal?.aborted) throw new Error('aborted');
        const result = await execOnce(exe, `${UTF8_OUTPUT_PREFIX}${command}`, cwd, { onData, signal, timeout, timeoutMs, env }, shellJob);
        if (!('startError' in result)) return result;
        failures.push(`${exe}: ${result.startError.message}`);
      }
      const tried = process.platform === 'win32' ? 'pwsh.exe on PATH or in %ProgramFiles%\\PowerShell\\7, then Windows PowerShell' : 'pwsh on PATH';
      throw new Error(`No PowerShell executable could start (looked for ${tried}${failures.length > 0 ? `; ${failures.join('; ')}` : ''}).`);
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
export function createPowerShellTool(pi: PiCodingAgentModule, cwd: string, shellJob: SessionJob | undefined, extraEnv?: () => Readonly<Record<string, string>> | undefined): ToolDefinition {
  const operations = createTrackedPowerShellOperations(shellJob, extraEnv);
  const definition: AnyToolDefinition = pi.createPowerShellToolDefinition(cwd, { operations });
  return { ...definition, name: TOOL_POWERSHELL, label: 'PowerShell', parameters: withCommandDescription(definition.parameters) };
}
