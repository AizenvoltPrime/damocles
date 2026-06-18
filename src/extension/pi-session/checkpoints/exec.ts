import { spawn } from 'child_process';
import type { ExecEnv, Result } from './types';

interface ProcessOutput {
  stdout: string;
  stderr: string;
}

/**
 * Run a command and collect its stdout/stderr. The optional `env` is merged on top of the current
 * process environment so git keeps its PATH and credential helpers while pointing at our private
 * bare repo. Rejects with an Error whose message includes the trimmed stderr when the process exits
 * non-zero or cannot be spawned at all (e.g. git missing → `ENOENT`).
 */
export function exec(command: string, args: string[], env?: ExecEnv, cwd?: string): Promise<ProcessOutput> {
  return new Promise<ProcessOutput>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const detail = stderr.trim() || stdout.trim();
        reject(new Error(`${command} ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`));
      }
    });
  });
}

/**
 * `exec` wrapped in the engine's `Result` channel: the promise always resolves, surfacing failures
 * as `{ ok: false, error }` rather than a thrown rejection. This is the form most callers use,
 * since the whole engine is fail-soft.
 */
export async function execSafe(
  command: string,
  args: string[],
  env?: ExecEnv,
  cwd?: string,
): Promise<Result<ProcessOutput>> {
  try {
    const value = await exec(command, args, env, cwd);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
