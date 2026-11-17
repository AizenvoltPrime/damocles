import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { delimiter, dirname, join, win32 } from 'node:path';
import type { PowerShellOperations, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AnyToolDefinition } from './any-tool-definition';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_POWERSHELL } from '../../../shared/tool-names';
import { resolveTimeoutMs, SHELL_EXIT_OUTPUT_GRACE_MS, shellExitClock, shellExitCode, waitForShellExit, withCommandDescription, withShellExitReport, type ShellExit } from './bash-tool';
import { withUrlWatch } from './shell-url-watch';
import { processLauncher, type SessionJob } from '../../process-launcher';
import { findPwsh, windowsPowerShell } from '../../system-tools';
import type { PowerShellSearch } from '../proven-shell';
import { withEnvOverrides } from '../../../shared/env-spellings';
import { currentShellLease, withShellCredentials, type ShellCredentialLease, type ShellCredentials } from './shell-credentials';

/** Without it PowerShell writes the console codepage and any non-ASCII output decodes as mojibake. */
const UTF8_OUTPUT_PREFIX = 'try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n';

/**
 * Windows PowerShell 5.1 turns redirected native stderr into error records and sets $? to false, so a native command that
 * exited 0 exits 1 (pi #8842). pi-coding-agent 1.5.2 `dist/core/tools/powershell.js:11`, which its package does not export.
 */
const WINDOWS_POWERSHELL_EXIT_SUFFIX = '\n;\nif ($?) { exit 0 }\nif (($LASTEXITCODE -eq 0) -and ("$($Error[0].FullyQualifiedErrorId)" -like "NativeCommandError*")) { exit 0 }\nexit 1';

/** The script `exe` runs: PowerShell 7 needs no exit suffix, and a final backtick would continue the command into it. */
function powerShellScript(exe: string, command: string): string {
  const suffix = win32.basename(exe).toLowerCase() === 'powershell.exe' && !command.endsWith('`') ? WINDOWS_POWERSHELL_EXIT_SUFFIX : '';
  return `${UTF8_OUTPUT_PREFIX}${command}${suffix}`;
}

/**
 * Absolute paths only: a bare name would search the working folder (a repository) first on Windows. `pwsh` leads so
 * PowerShell 7 wins where both exist, and it is the only one off Windows.
 */
async function powerShellExecutables(env: NodeJS.ProcessEnv): Promise<string[]> {
  const pwsh = await findPwsh(env);
  return [...(pwsh !== undefined ? [pwsh] : []), ...(process.platform === 'win32' ? [windowsPowerShell()] : [])];
}

/**
 * The environment both shell tools start with: pi's `getShellEnv` (`dist/utils/shell.js`), its bin folder ahead of
 * `process.env`'s PATH, under `extraEnv`. Kept in step with pi's `getShellEnv`.
 */
export function shellToolEnv(pi: Pick<PiCodingAgentModule, 'getAgentDir'>, extraEnv: Readonly<Record<string, string | undefined>> | undefined): NodeJS.ProcessEnv {
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
  const current = process.env[pathKey] ?? '';
  const binDir = join(pi.getAgentDir(), 'bin');
  const piPath = current.split(delimiter).filter(Boolean).includes(binDir) ? current : [binDir, current].filter(Boolean).join(delimiter);
  return withEnvOverrides<string | undefined>({ ...process.env, [pathKey]: piPath }, extraEnv ?? {}, process.platform);
}

/**
 * Where the PowerShell this tool starts looks a program up: the PATH and PATHEXT of `shellToolEnv`, and pwsh's own folder,
 * which pwsh puts ahead of PATH. Finding pwsh reads the PATH folders, so a caller places them first (`shellLookupFolders`).
 */
export async function powerShellSearch(pi: Pick<PiCodingAgentModule, 'getAgentDir'>, extraEnv: Readonly<Record<string, string | undefined>> | undefined): Promise<PowerShellSearch> {
  const env = shellToolEnv(pi, extraEnv);
  const variable = (name: string): string | undefined => env[Object.keys(env).find((key) => key.toLowerCase() === name) ?? name];
  const pwsh = await findPwsh(env);
  return { path: variable('path') ?? '', pathext: variable('pathext'), pwshHome: pwsh === undefined ? undefined : dirname(pwsh) };
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
  lease: ShellCredentialLease | undefined;
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
  const { onData, signal, timeout, timeoutMs, env, lease } = options;
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
    ...(lease ? { reportsLeftRunning: true } : {}),
    ...(shellJob ? { job: shellJob.id } : {}),
  });

  const exitClock = shellExitClock(shell);
  const started = shell.pid.then(() => true, () => false);
  // only a started shell takes the lease over: one that never started leaves it to the next candidate
  void started.then((ok) => {
    if (ok) lease?.heldBy(shell);
  });
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  // Once the shell has exited, a tree kill would reach the jobs it deliberately left running.
  const killShell = (): void => shell.kill({ tree: true, whileRunning: true });
  const stdout = withUrlWatch(onData);
  const stderr = withUrlWatch(onData);

  try {
    if (timeoutMs !== undefined) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        exitClock.atDeadline();
        killShell();
      }, timeoutMs);
    }
    shell.onData('stdout', stdout.onData);
    shell.onData('stderr', stderr.onData);
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
    if (timedOut) throw exitClock.timeoutError(timeout, exit);
    return { exitCode: shellExitCode(exit) };
  } finally {
    stdout.end();
    stderr.end();
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
export function createTrackedPowerShellOperations(shellJob: SessionJob | undefined, extraEnv: () => Readonly<Record<string, string | undefined>> | undefined = () => undefined): PowerShellOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env: piEnv }) => {
      const lease = currentShellLease();
      const env = piEnv === undefined ? undefined : withEnvOverrides<string | undefined>(withEnvOverrides(piEnv, extraEnv() ?? {}, process.platform), lease?.env ?? {}, process.platform);
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
        const result = await execOnce(exe, powerShellScript(exe, command), cwd, { onData, signal, timeout, timeoutMs, env, lease }, shellJob);
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
export function createPowerShellTool(pi: PiCodingAgentModule, cwd: string, shellJob: SessionJob | undefined, extraEnv?: () => Readonly<Record<string, string | undefined>> | undefined, credentials?: ShellCredentials): ToolDefinition {
  const operations = createTrackedPowerShellOperations(shellJob, extraEnv);
  const definition: AnyToolDefinition = pi.createPowerShellToolDefinition(cwd, { operations });
  return {
    ...definition,
    name: TOOL_POWERSHELL,
    label: 'PowerShell',
    parameters: withCommandDescription(definition.parameters),
    execute: (toolCallId, params, signal, onUpdate, ctx) => withShellCredentials(credentials, toolCallId, () => withShellExitReport(() => definition.execute(toolCallId, params, signal, onUpdate, ctx))),
  };
}
