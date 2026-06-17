import { spawn } from 'child_process';
import { Type } from 'typebox';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { PiCodingAgentModule } from '../pi-loader';
import { TOOL_POWERSHELL } from '../../../shared/tool-names';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

const powershellSchema = Type.Object(
  {
    command: Type.String({ description: 'The PowerShell command to execute' }),
    timeout: Type.Optional(Type.Number({ description: 'Optional timeout in milliseconds (max 600000)' })),
    description: Type.Optional(Type.String({ description: 'Clear, concise description of what this command does in active voice' })),
  },
  { additionalProperties: false },
);

interface PowerShellRun {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  aborted: boolean;
  spawnFailed: boolean;
}

/**
 * Kill the spawned shell AND its descendants. `child.kill()` signals only the direct process, so a
 * PowerShell that launched its own child processes would orphan them. On Windows `taskkill /T /F`
 * terminates the whole tree by pid; elsewhere we fall back to the direct kill (POSIX pwsh is rare and
 * tree-killing there needs a detached process group, which we don't spawn).
 */
function killTree(child: ReturnType<typeof spawn>): void {
  const pid = child.pid;
  if (process.platform === 'win32' && pid !== undefined) {
    try {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F']);
      killer.on('error', () => child.kill());
      return;
    } catch {
      // fall through to the direct kill
    }
  }
  child.kill();
}

function trySpawn(exe: string, command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<PowerShellRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', command], { cwd, ...(signal ? { signal } : {}) });
    } catch {
      resolve({ output: '', exitCode: null, timedOut: false, aborted: false, spawnFailed: true });
      return;
    }
    let output = '';
    let timedOut = false;
    let aborted = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    // spawn's `signal` kills the direct process on abort; also kill the tree so descendants don't orphan.
    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    child.stdout?.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { output += d.toString(); });
    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup();
      if (aborted || err.name === 'AbortError' || err.code === 'ABORT_ERR') {
        resolve({ output, exitCode: null, timedOut, aborted: true, spawnFailed: false });
        return;
      }
      if (err.code === 'ENOENT') {
        resolve({ output: '', exitCode: null, timedOut: false, aborted: false, spawnFailed: true });
        return;
      }
      resolve({ output: output || err.message, exitCode: null, timedOut, aborted: false, spawnFailed: false });
    });
    child.on('close', (code) => {
      cleanup();
      resolve({ output, exitCode: code, timedOut, aborted, spawnFailed: false });
    });
  });
}

/** Run a PowerShell command, preferring PowerShell 7+ (`pwsh`) and falling back to Windows PowerShell. */
async function runPowerShell(command: string, cwd: string, timeoutMs: number, signal: AbortSignal | undefined): Promise<PowerShellRun> {
  for (const exe of ['pwsh', 'powershell.exe']) {
    const result = await trySpawn(exe, command, cwd, timeoutMs, signal);
    if (!result.spawnFailed) return result;
  }
  return { output: 'PowerShell not found (tried pwsh and powershell.exe)', exitCode: null, timedOut: false, aborted: false, spawnFailed: true };
}

/** Build the custom `PowerShell` shell tool. Gated by the central permission gate before execution. */
export function createPowerShellTool(pi: PiCodingAgentModule, cwd: string): ToolDefinition {
  return pi.defineTool<typeof powershellSchema, undefined>({
    name: TOOL_POWERSHELL,
    label: 'PowerShell',
    description: 'Executes a given PowerShell command (pwsh 7+, falling back to Windows PowerShell).',
    parameters: powershellSchema,
    execute: async (_toolCallId, params, signal) => {
      const timeoutMs = typeof params.timeout === 'number' ? Math.min(Math.max(params.timeout, 0), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
      const run = await runPowerShell(params.command, cwd, timeoutMs, signal);
      if (run.aborted) {
        const partial = run.output.trim();
        const text = partial ? `PowerShell command aborted.\n${partial}` : 'PowerShell command aborted.';
        return { content: [{ type: 'text', text }], details: undefined };
      }
      const base = run.output.trim() || (run.timedOut ? `Command timed out after ${timeoutMs}ms` : '(no output)');
      const text = run.exitCode && run.exitCode !== 0 ? `${base}\n[exit code ${run.exitCode}]` : base;
      return { content: [{ type: 'text', text }], details: undefined };
    },
  });
}
