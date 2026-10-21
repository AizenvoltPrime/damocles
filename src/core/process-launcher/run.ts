import { abortError, processLauncher, type ProcessExit } from './launcher';
import type { SpawnSpec } from './protocol';

export interface RunOutput {
  // null on a timeout: the result does not wait for the killed process
  readonly exit: ProcessExit | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export interface RunOptions {
  readonly input?: string;
  // the process tree is killed and the run resolves at once with what it printed so far
  readonly timeoutMs?: number;
  // aborting, before or after the start, kills the process tree and rejects the run at once with the signal's reason
  readonly signal?: AbortSignal;
}

/** Runs a process on the launcher to its close and collects its output; rejects with the start error when it cannot start. */
export function runProcess(spec: SpawnSpec, options: RunOptions = {}): Promise<RunOutput> {
  const { signal } = options;
  const child = processLauncher().launch(spec, signal ? { signal } : {});
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.onData('stdout', (chunk) => stdout.push(chunk));
  child.onData('stderr', (chunk) => stderr.push(chunk));
  if (spec.stdio?.[0] !== 'ignore') child.end(options.input);
  const output = (exit: ProcessExit | null): RunOutput => ({ exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
  return new Promise<RunOutput>((resolve, reject) => {
    const settle = (done: () => void): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      done();
    };
    // the launcher kills the tree on the abort
    const onAbort = (): void => settle(() => reject(abortError(signal!)));
    // A descendant holding the output open would hold the close, so a timeout settles without it.
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
      child.kill({ tree: true, signal: 'SIGKILL' });
      settle(() => resolve(output(null)));
    }, options.timeoutMs);
    // the launcher worker keeps the host alive while the process runs
    timer?.unref();
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.all([child.exited, child.closed]).then(
      ([exit]) => settle(() => resolve(output(exit))),
      (err: unknown) => settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
    );
  });
}
