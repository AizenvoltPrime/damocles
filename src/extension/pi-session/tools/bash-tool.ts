import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { spawn, type ChildProcess } from 'child_process';
import { Type } from 'typebox';
import type { BashOperations, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { withPerCallCancel } from './cancellable-shell';
import { createShellJob, killProcessTree, type ShellSessionJob } from './process-tree';
import type { ShellCancelRegistry } from './shell-cancel-registry';

/** pi's own ceiling, mirrored because `resolveTimeoutMs` is internal to its bash tool. */
const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
/** A detached descendant can hold the shell's stdout open forever, so the wait ends on an idle pipe. */
const EXIT_STDIO_GRACE_MS = 100;

/** The subset of pi's `BashToolOptions` that comes from user settings. */
export interface ShellOptions {
  commandPrefix?: string;
  shellPath?: string;
}

/** pi's bash definition carries its own schema and render types; only the erased shape is assignable both ways. */
type AnyToolDefinition = ToolDefinition<any, any, any>;

export interface BashToolDeps {
  /** Read per call, so a settings edit takes effect without reloading the window. */
  getShellOptions: () => ShellOptions;
  cancelRegistry: ShellCancelRegistry;
  /** The panel-lived job every shell call nests inside; `undefined` off win32. */
  shellJob: ShellSessionJob | undefined;
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
 * Wait for a shell to terminate without hanging on stdio a descendant still holds.
 *
 * `close` cannot be the only trigger: a backgrounded job inherits the shell's stdout pipe and holds it
 * open past the shell's exit, so on Windows the event never fires. A fixed deadline from `exit` loses
 * output still being written past it, so the grace timer is re-armed on every chunk instead.
 */
export function waitForShellExit(child: ChildProcess): Promise<ShellExit> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      child.removeListener('close', onClose);
      child.stdout?.removeListener('end', onStdoutEnd);
      child.stderr?.removeListener('end', onStderrEnd);
      child.stdout?.removeListener('data', onData);
      child.stderr?.removeListener('data', onData);
    };

    const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ code, signal });
    };

    const armIdleTimer = (): void => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finalize(exitCode, exitSignal), EXIT_STDIO_GRACE_MS);
    };

    const finalizeIfStreamsEnded = (): void => {
      if (exited && !settled && stdoutEnded && stderrEnded) finalize(exitCode, exitSignal);
    };

    function onData(): void {
      if (exited && !settled) armIdleTimer();
    }
    function onStdoutEnd(): void {
      stdoutEnded = true;
      finalizeIfStreamsEnded();
    }
    function onStderrEnd(): void {
      stderrEnded = true;
      finalizeIfStreamsEnded();
    }
    function onError(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    }
    function onExit(code: number | null, signal: NodeJS.Signals | null): void {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      finalizeIfStreamsEnded();
      if (!settled) armIdleTimer();
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      finalize(code, signal);
    }

    child.stdout?.once('end', onStdoutEnd);
    child.stderr?.once('end', onStderrEnd);
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('error', onError);
    child.once('exit', onExit);
    child.once('close', onClose);
  });
}

/**
 * pi's local bash operations, reimplemented so the spawned shell's pid is visible here.
 *
 * `createLocalBashOperations` spawns internally and surfaces only the exit code, so nothing wrapped
 * around it can name the process to track. Owning the spawn is what makes the descendant tracker
 * possible, and it is the same reason `powershell-tool.ts` owns its spawn. Behaviour is pi's, down to
 * the thrown `aborted` and `timeout:<seconds>` messages its bash tool matches on, and
 * `__tests__/bash-operations.test.ts` asserts that against the real `createLocalBashOperations`.
 * pi's `trackDetachedChildPid`/`untrackDetachedChildPid` are deliberately absent: they feed pi's CLI
 * signal handlers, which the extension host never installs, and the session job covers the same ground.
 */
export function createTrackedBashOperations(
  pi: PiCodingAgentModule,
  getShellOptions: () => ShellOptions,
  shellJob: ShellSessionJob | undefined,
): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error('aborted');
      // Omitting it makes spawn inherit the extension host environment, which holds provider credentials.
      if (env === undefined) throw new Error('bash exec requires an explicit environment');
      const shellConfig = pi.getShellConfig(getShellOptions().shellPath);
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }

      const commandFromStdin = shellConfig.commandTransport === 'stdin';
      const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
        cwd,
        // POSIX gets its own process group here; that group is what makes backgrounded jobs killable.
        detached: process.platform !== 'win32',
        env,
        stdio: [commandFromStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      // Git Bash forks its background jobs about 10ms in, so this must stay the first statement after spawn.
      const job = child.pid === undefined ? undefined : createShellJob(child.pid, shellJob);
      if (commandFromStdin) {
        // A shell that exits before reading its script closes this pipe; an unlistened stream error is fatal.
        child.stdin?.on('error', () => {});
        child.stdin?.end(command);
      }

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
        const { code, signal: exitSignal } = await waitForShellExit(child);
        if (signal?.aborted) throw new Error('aborted');
        if (timedOut) throw new Error(`timeout:${timeout}`);
        // A signal-killed shell has no exit code, and pi's bash tool rejects a null one, so the shell
        // convention stands in for it.
        return { exitCode: code ?? (exitSignal ? 128 + (osConstants.signals[exitSignal] ?? 0) : 1) };
      } finally {
        job?.dispose();
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener('abort', killShell);
      }
    },
  };
}

/**
 * The `bash` replacement, which exists to own a per-call `AbortController` and the spawned shell's
 * process lifetime. pi's own bash definition is kept underneath and does all the rest.
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
  const { getShellOptions, cancelRegistry, shellJob } = deps;
  const operations = createTrackedBashOperations(pi, getShellOptions, shellJob);
  const build = (options: ShellOptions): AnyToolDefinition => pi.createBashToolDefinition(cwd, { ...options, operations });
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

  return withPerCallCancel(
    {
      // `constrainedSampling` comes in with this spread, so declaring it here would shadow pi's own setting.
      ...metadata,
      parameters: withCommandDescription(metadata.parameters),
      execute: (toolCallId, params, signal, onUpdate, ctx) => resolveDelegate().execute(toolCallId, params, signal, onUpdate, ctx),
    },
    cancelRegistry,
  );
}
