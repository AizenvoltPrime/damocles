import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { spawn } from 'child_process';
import { Type } from 'typebox';
import type { ToolDefinition, TruncationResult } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_POWERSHELL } from '../../../shared/tool-names';
import { SHELL_ABORTED_DETAIL_KEY } from './cancellable-shell';
import { createShellJob, killProcessTree, type ShellSessionJob } from './process-tree';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
/** Matches pi's BASH_UPDATE_THROTTLE_MS so both shell tools stream at the same rate. */
export const POWERSHELL_UPDATE_THROTTLE_MS = 100;

const powershellSchema = Type.Object(
  {
    command: Type.String({ description: 'The PowerShell command to execute' }),
    timeout: Type.Optional(Type.Number({ description: 'Optional timeout in milliseconds (max 600000)' })),
    description: Type.Optional(Type.String({ description: 'Clear, concise description of what this command does in active voice' })),
  },
  { additionalProperties: false },
);

/** Partial-frame details, shaped like pi's BashToolDetails so consumers read one field name for both shell tools. */
interface PowerShellToolDetails {
  truncation?: TruncationResult | undefined;
  /** Set only when this tool saw the abort, because a returned result is otherwise indistinguishable from a completed command. */
  [SHELL_ABORTED_DETAIL_KEY]?: true;
}

interface PowerShellRun {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnFailed: boolean;
}

/** pi's rolling-tail shape from bash-executor.ts: drop the oldest chunk while over the cap, never the last one. */
export type TruncateTailFn = (content: string, options?: { maxLines?: number; maxBytes?: number }) => TruncationResult;

export interface ShellOutputBuffer {
  append(text: string): void;
  snapshot(): { content: string; truncation: TruncationResult };
}

/**
 * Bounded output buffer for a spawned shell. Holds at most `2 * maxBytes` of tail, then snapshots
 * through pi's `truncateTail`. `truncate` is injected because this file may not value-import the
 * pure-ESM pi package: the extension bundle is CJS and reaches pi only through `pi-loader`.
 */
export function createShellOutputBuffer(truncate: TruncateTailFn, maxLines: number, maxBytes: number): ShellOutputBuffer {
  const chunks: string[] = [];
  const maxBuffered = maxBytes * 2;
  let buffered = 0;
  return {
    append(text: string): void {
      chunks.push(text);
      buffered += text.length;
      // `length > 1` mirrors pi: a single oversized chunk is kept, so the buffer can exceed the cap by one chunk.
      while (buffered > maxBuffered && chunks.length > 1) {
        buffered -= chunks.shift()!.length;
      }
    },
    snapshot(): { content: string; truncation: TruncationResult } {
      const result = truncate(chunks.join(''), { maxLines, maxBytes });
      return { content: result.content, truncation: result };
    },
  };
}

function trySpawn(
  exe: string,
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  buffer: ShellOutputBuffer,
  onOutput: () => void,
  shellJob: ShellSessionJob | undefined,
): Promise<PowerShellRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', command], {
        cwd,
        // POSIX gets its own process group here; that group is what makes the shell's descendants killable.
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      resolve({ output: '', exitCode: null, timedOut: false, aborted: false, spawnFailed: true });
      return;
    }
    // Must stay the first statement after spawn: a child created before assignment is outside the job permanently.
    const job = child.pid === undefined ? undefined : createShellJob(child.pid, shellJob);
    // The pid is reusable the moment the child is reaped, so a later kill would land on a stranger.
    let exited = false;
    child.once('exit', () => {
      exited = true;
    });
    const killShell = (): void => {
      if (exited || child.pid === undefined) return;
      killProcessTree(child.pid, job);
    };
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killShell();
    }, timeoutMs);
    // Never hand `signal` to spawn as well: Node's own abort listener emits 'error' first and the cleanup it triggers unregisters this one.
    const onAbort = (): void => {
      aborted = true;
      killShell();
    };
    // `addEventListener` never fires on an already-aborted signal, so that case has to be handled directly.
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      job?.dispose();
      signal?.removeEventListener('abort', onAbort);
    };
    // stdout and stderr share one buffer so the snapshot keeps the interleaving the shell produced.
    const append = (d: Buffer): void => {
      buffer.append(d.toString());
      onOutput();
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (aborted) {
        resolve({ output: buffer.snapshot().content, exitCode: null, timedOut, aborted: true, spawnFailed: false });
        return;
      }
      if (err.code === 'ENOENT') {
        resolve({ output: '', exitCode: null, timedOut: false, aborted: false, spawnFailed: true });
        return;
      }
      resolve({ output: buffer.snapshot().content || err.message, exitCode: null, timedOut, aborted: false, spawnFailed: false });
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ output: buffer.snapshot().content, exitCode: code, timedOut, aborted, spawnFailed: false });
    });
  });
}

/** Run a PowerShell command, preferring PowerShell 7+ (`pwsh`) and falling back to Windows PowerShell. */
async function runPowerShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  buffer: ShellOutputBuffer,
  onOutput: () => void,
  shellJob: ShellSessionJob | undefined,
): Promise<PowerShellRun> {
  for (const exe of ['pwsh', 'powershell.exe']) {
    // An abort raised while the first executable failed must stop the fallback from starting a shell.
    if (signal?.aborted) return { output: buffer.snapshot().content, exitCode: null, timedOut: false, aborted: true, spawnFailed: false };
    const result = await trySpawn(exe, command, cwd, timeoutMs, signal, buffer, onOutput, shellJob);
    if (!result.spawnFailed) return result;
  }
  return { output: 'PowerShell not found (tried pwsh and powershell.exe)', exitCode: null, timedOut: false, aborted: false, spawnFailed: true };
}

/** Build the custom `PowerShell` shell tool. Gated by the central permission gate before execution. */
export function createPowerShellTool(pi: PiCodingAgentModule, cwd: string, shellJob: ShellSessionJob | undefined): ToolDefinition {
  return pi.defineTool<typeof powershellSchema, PowerShellToolDetails | undefined>({
    name: TOOL_POWERSHELL,
    label: 'PowerShell',
    description: 'Executes a given PowerShell command (pwsh 7+, falling back to Windows PowerShell).',
    parameters: powershellSchema,
    execute: async (_toolCallId, params, signal, onUpdate) => {
      // Without this, spawn reports ENOENT for the directory and both executables read as missing.
      try {
        await access(cwd, constants.F_OK);
      } catch {
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute PowerShell commands.`);
      }
      const timeoutMs = typeof params.timeout === 'number' ? Math.min(Math.max(params.timeout, 0), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      const buffer = createShellOutputBuffer(pi.truncateTail, pi.DEFAULT_MAX_LINES, pi.DEFAULT_MAX_BYTES);
      let updateTimer: NodeJS.Timeout | undefined;
      let updateDirty = false;
      let lastUpdateAt = 0;

      const emitUpdate = (): void => {
        if (!onUpdate || !updateDirty) return;
        updateDirty = false;
        lastUpdateAt = Date.now();
        const snapshot = buffer.snapshot();
        onUpdate({
          content: [{ type: 'text', text: snapshot.content }],
          details: { truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined },
        });
      };

      const clearUpdateTimer = (): void => {
        if (updateTimer) {
          clearTimeout(updateTimer);
          updateTimer = undefined;
        }
      };

      const scheduleUpdate = (): void => {
        if (!onUpdate) return;
        updateDirty = true;
        const delay = POWERSHELL_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
        if (delay <= 0) {
          clearUpdateTimer();
          emitUpdate();
          return;
        }
        updateTimer ??= setTimeout(() => {
          updateTimer = undefined;
          emitUpdate();
        }, delay);
      };

      onUpdate?.({ content: [{ type: 'text', text: '' }], details: undefined });

      const run = await runPowerShell(params.command, cwd, timeoutMs, signal, buffer, scheduleUpdate, shellJob);
      clearUpdateTimer();
      // Force the last frame so the final snapshot always reaches the UI, even if the throttle just fired.
      updateDirty = true;
      emitUpdate();

      if (run.aborted) {
        const partial = run.output.trim();
        const text = partial ? `PowerShell command aborted.\n${partial}` : 'PowerShell command aborted.';
        return { content: [{ type: 'text', text }], details: { [SHELL_ABORTED_DETAIL_KEY]: true } };
      }
      const base = run.output.trim() || (run.timedOut ? `Command timed out after ${timeoutMs}ms` : '(no output)');
      const text = run.exitCode && run.exitCode !== 0 ? `${base}\n[exit code ${run.exitCode}]` : base;
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });
}
