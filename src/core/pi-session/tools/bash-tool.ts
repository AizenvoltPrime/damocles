import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { Type } from 'typebox';
import type { BashOperations, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { processLauncher, type LaunchedProcess, type SessionJob } from '../../process-launcher';
import { findBash } from '../../system-tools';

/** pi's own ceiling, mirrored because `resolveTimeoutMs` is internal to its bash tool. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** A detached descendant can hold the shell's stdout open forever, so the wait ends on an idle pipe. */
export const SHELL_EXIT_OUTPUT_GRACE_MS = 100;

/** The subset of pi's `BashToolOptions` that comes from user settings. */
export interface ShellOptions {
  commandPrefix?: string;
  shellPath?: string;
  /** Added to each command's environment through pi's spawnHook (D32's worktree variables); never written into process.env. */
  env?: Readonly<Record<string, string>>;
}

/** pi's bash definition carries its own schema and render types; only the erased shape is assignable both ways. */
type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface BashToolDeps {
  /** Read per call, so a settings edit takes effect without reloading the window. */
  getShellOptions: () => ShellOptions;
  /** The panel-lived session job every shell call starts in. */
  shellJob: SessionJob | undefined;
}

/**
 * Add the written command summary both shell tool cards render (`ToolOverlay.vue`), which pi's shell
 * schema has no field for. Safe to append: pi's shell `execute` reads only `command` and `timeout`.
 * Shared with `powershell-tool.ts` so the two shell tools present one schema.
 */
export function withCommandDescription(parameters: { properties: Record<string, unknown> }): ReturnType<typeof Type.Object> {
  return Type.Object({
    ...parameters.properties,
    description: Type.Optional(Type.String({ description: 'Clear, concise description of what this command does in active voice' })),
  });
}

/** Shared with `powershell-tool.ts` so both shell tools read the `timeout` parameter as the same unit. */
export function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error('Invalid timeout: must be a finite number of seconds');
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

/** How a shell terminated. `code` is null exactly when `signal` names the signal that killed it. */
export interface ShellExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Wait for a shell to terminate without hanging on output a descendant still holds.
 *
 * `closed` alone cannot be the trigger: a backgrounded job inherits the shell's stdout pipe and holds it
 * open past the shell's exit. A fixed deadline from the exit loses output still being written past it, so
 * the shell starts with `exitOutputIdleMs: SHELL_EXIT_OUTPUT_GRACE_MS`, and the launcher closes its output
 * once that long passes after the exit with no new chunk.
 */
export async function waitForShellExit(shell: LaunchedProcess): Promise<ShellExit> {
  const exit = await shell.exited;
  // A worker that dies after the exit loses only output, so the exit still stands.
  await Promise.allSettled([shell.closed]);
  return exit;
}

type ShellConfig = ReturnType<PiCodingAgentModule['getShellConfig']>;

/**
 * pi's shell choice, with the bash found by `findBash` so pi never looks one up itself. Without one, POSIX gets pi's
 * `sh` fallback; on Windows pi would only search further where Damocles never runs a tool from (the working folder).
 */
async function shellConfigFor(pi: PiCodingAgentModule, shellPath: string | undefined): Promise<ShellConfig> {
  if (shellPath !== undefined) return pi.getShellConfig(shellPath);
  const bash = await findBash();
  if (bash !== undefined) return pi.getShellConfig(bash);
  if (process.platform !== 'win32') return { shell: '/bin/sh', args: ['-c'] };
  throw new Error('No bash shell found. Install Git for Windows (https://git-scm.com/download/win), add a bash.exe folder to PATH, or set shellPath in settings.json.');
}

/**
 * pi's local bash operations, reimplemented so the shell starts on the process launcher inside the panel's
 * session job.
 *
 * `createLocalBashOperations` spawns internally and surfaces only the exit code, so nothing wrapped
 * around it can put the shell in a job or stop its tree. Owning the start is what makes that possible,
 * and it is the same reason `powershell-tool.ts` owns its start. Behaviour is pi's, down to
 * the thrown `aborted` and `timeout:<seconds>` messages its bash tool matches on, and
 * `__tests__/bash-operations.test.ts` asserts that against the real `createLocalBashOperations`.
 * pi's `trackDetachedChildPid`/`untrackDetachedChildPid` are deliberately absent: they feed pi's CLI
 * signal handlers, which the extension host never installs, and the session job covers the same ground.
 */
export function createTrackedBashOperations(
  pi: PiCodingAgentModule,
  getShellOptions: () => ShellOptions,
  shellJob: SessionJob | undefined,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error('aborted');
      // Omitting it makes spawn inherit the extension host environment, which holds provider credentials.
      if (env === undefined) throw new Error('bash exec requires an explicit environment');
      const shellConfig = await shellConfigFor(pi, getShellOptions().shellPath);
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }

      const commandFromStdin = shellConfig.commandTransport === 'stdin';
      const shell = processLauncher().launch({
        file: shellConfig.shell,
        args: commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
        cwd,
        // POSIX gets its own process group here; that group is what makes backgrounded jobs killable.
        detached: process.platform !== 'win32',
        env,
        stdio: [commandFromStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
        exitOutputIdleMs: SHELL_EXIT_OUTPUT_GRACE_MS,
        ...(shellJob ? { job: shellJob.id } : {}),
      });
      if (commandFromStdin) shell.end(command);

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
        const { code, signal: exitSignal } = await waitForShellExit(shell);
        if (signal?.aborted) throw new Error('aborted');
        if (timedOut) throw new Error(`timeout:${timeout}`);
        // A signal-killed shell has no exit code, and pi's bash tool rejects a null one, so the shell
        // convention stands in for it.
        return { exitCode: code ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1) };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', killShell);
      }
    },
  };
}

/**
 * The `bash` replacement, which owns the spawned shell's process lifetime; pi's own bash definition
 * does the rest.
 *
 * The name has to stay the literal lowercase `bash`, since that is what makes this replace pi's built-in
 * rather than add a tool, and what keeps the permission gate, the plan-mode classification and the
 * active-set lists keyed off the name they already use.
 * Never add an `excludeTools` entry for it: `isAllowedTool` filters custom tools through that same set,
 * so excluding `bash` would drop this replacement along with the original.
 * Metadata may be spread from a delegate built once because shell options reach no metadata field and
 * pi's `bash.ts` has no `this` reference.
 * The executing delegate must be memoized on the serialized options, since pi builds its shell
 * operations at construction and a changed `shellPath` or `commandPrefix` needs a rebuild.
 * Introduce no default timeout: pi ships bash without one and long builds depend on that.
 */
export function createBashTool(pi: PiCodingAgentModule, cwd: string, deps: BashToolDeps): ToolDefinition {
  const { getShellOptions, shellJob } = deps;
  const operations = createTrackedBashOperations(pi, getShellOptions, shellJob);
  const build = ({ env, ...options }: ShellOptions): AnyToolDefinition => pi.createBashToolDefinition(cwd, {
    ...options,
    operations,
    ...(env !== undefined ? { spawnHook: (context) => ({ ...context, env: { ...context.env, ...env } }) } : {}),
  });
  const initialOptions = getShellOptions();
  let cachedKey = JSON.stringify(initialOptions);
  let cachedDelegate = build(initialOptions);
  const metadata = cachedDelegate;

  const resolveDelegate = (): AnyToolDefinition => {
    const options = getShellOptions();
    const key = JSON.stringify(options);
    if (key !== cachedKey) {
      cachedKey = key;
      cachedDelegate = build(options);
    }
    return cachedDelegate;
  };

  return {
    // `constrainedSampling` comes in with this spread, so declaring it here would shadow pi's own setting.
    ...metadata,
    parameters: withCommandDescription(metadata.parameters),
    execute: (toolCallId, params, signal, onUpdate, ctx) => resolveDelegate().execute(toolCallId, params, signal, onUpdate, ctx),
  };
}
