import { processLauncher } from '../../process-launcher';
import type { ExecEnv, Result } from './types';

interface ProcessOutput {
  stdout: string;
  // stdout as the bytes the process wrote
  bytes: Buffer;
  stderr: string;
}

/** A process that ran and exited non-zero; `exitCode` is null when a signal ended it. */
export class ExecExitError extends Error {
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null) {
    super(message);
    this.name = 'ExecExitError';
    this.exitCode = exitCode;
  }
}

// `git rev-parse --local-env-vars`: an inherited value would point git at a repository other than the one each call names.
const REPOSITORY_LOCAL_GIT_VARS = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_COUNT',
  'GIT_OBJECT_DIRECTORY',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_GRAFT_FILE',
  'GIT_INDEX_FILE',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_REPLACE_REF_BASE',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_COMMON_DIR',
  // Listed by git 2.39 and earlier, still shipped by LTS distributions.
  'GIT_INTERNAL_SUPER_PREFIX',
]);

/** The process environment minus repository-local git variables, with `env` laid on top. */
export function childEnv(env?: ExecEnv): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (REPOSITORY_LOCAL_GIT_VARS.has(upper) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(upper)) continue;
    inherited[key] = value;
  }
  return { ...inherited, ...env };
}

/** The process wrote more stdout than the call allows; it was killed and nothing past the bound was kept. */
export class ExecOutputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExecOutputTooLargeError';
  }
}

/** A function is called as the process starts, so its throw (`gitExecutable` finding no git) fails the call as a spawn error would. */
export type ExecCommand = string | (() => string);

/** Called with the pid of a spawned child; the returned function runs once the child is gone. */
export type TrackChild = (pid: number) => () => void;

/**
 * Run a command and collect its stdout/stderr. The optional `env` is merged on top of `childEnv()`
 * so git keeps its PATH and credential helpers while pointing at our private
 * bare repo. Rejects with an Error whose message includes the trimmed stderr when the process exits
 * non-zero or cannot be spawned at all (e.g. git missing → `ENOENT`).
 *
 * With `timeoutMs`, a process still running at the deadline is killed and the promise rejects saying
 * it timed out. The rejection is raised by the timer rather than by the resulting `close`, because a
 * killed child whose stdio a grandchild still holds open never emits `close` at all, which is the
 * hang this parameter exists to bound. Callers that pass nothing wait as long as the process runs.
 *
 * The process starts on the launcher (`process-launcher/`). `track` sees the child's pid once the launcher reports the start
 * and is released once the child has closed (exited with every output closed) or failed.
 *
 * With `maxStdoutBytes`, a process that writes more stdout is killed and the promise rejects with ExecOutputTooLargeError.
 */
export function exec(
  command: ExecCommand,
  args: string[],
  env?: ExecEnv,
  cwd?: string,
  timeoutMs?: number,
  input?: string,
  track?: TrackChild,
  maxStdoutBytes?: number,
): Promise<ProcessOutput> {
  return new Promise<ProcessOutput>((resolve, reject) => {
    const file = typeof command === 'string' ? command : command();
    const child = processLauncher().launch({ file, args, ...(cwd !== undefined ? { cwd } : {}), env: childEnv(env), windowsHide: true });
    let untrack: (() => void) | undefined;
    let released = false;
    const release = (): void => {
      released = true;
      untrack?.();
      untrack = undefined;
    };
    if (track) {
      child.pid.then((pid) => {
        if (released) return;
        try {
          untrack = track(pid);
        } catch (err) {
          child.kill({ signal: 'SIGKILL' });
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }, () => undefined);
    }

    // Decoded once at close: a multi-byte character can straddle two chunks.
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let overflowed = false;
    let timedOut = false;
    const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
      timedOut = true;
      child.kill({ signal: 'SIGKILL' });
      reject(new Error(`${file} ${args.join(' ')} timed out after ${timeoutMs}ms and was killed`));
    }, timeoutMs);

    child.onData('stdout', (chunk) => {
      if (overflowed) return;
      stdoutBytes += chunk.length;
      if (maxStdoutBytes !== undefined && stdoutBytes > maxStdoutBytes) {
        overflowed = true;
        stdoutChunks.length = 0;
        child.kill({ signal: 'SIGKILL' });
        return;
      }
      stdoutChunks.push(chunk);
    });
    child.onData('stderr', (chunk) => {
      stderrChunks.push(chunk);
    });
    child.end(input);

    Promise.all([child.exited, child.closed]).then(
      ([{ code }]) => {
        if (timer) clearTimeout(timer);
        release();
        // The timer already rejected, and the kill's own close code says nothing the caller can use.
        if (timedOut) return;
        if (overflowed) {
          reject(new ExecOutputTooLargeError(`${file} ${args.join(' ')} wrote more than ${maxStdoutBytes} bytes and was killed`));
          return;
        }
        const bytes = Buffer.concat(stdoutChunks);
        const stdout = bytes.toString('utf8');
        const stderr = Buffer.concat(stderrChunks).toString('utf8');
        if (code === 0) {
          resolve({ stdout, bytes, stderr });
          return;
        }
        const detail = stderr.trim() || stdout.trim();
        reject(new ExecExitError(`${file} ${args.join(' ')} exited with code ${code}${detail ? `: ${detail}` : ''}`, code));
      },
      (err: unknown) => {
        if (timer) clearTimeout(timer);
        release();
        reject(err);
      },
    );
  });
}

/**
 * `exec` wrapped in the engine's `Result` channel: the promise always resolves, surfacing failures
 * as `{ ok: false, error }` rather than a thrown rejection. This is the form most callers use,
 * since the whole engine is fail-soft.
 */
export async function execSafe(
  command: ExecCommand,
  args: string[],
  env?: ExecEnv,
  cwd?: string,
  input?: string,
): Promise<Result<ProcessOutput>> {
  try {
    const value = await exec(command, args, env, cwd, undefined, input);
    return { ok: true, value };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
