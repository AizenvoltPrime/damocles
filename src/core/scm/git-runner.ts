// Every git process the source control engine starts (plan AD4, "Process model"; docs/invariants.md "Source control").
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { childEnv } from '../pi-session/checkpoints/exec';
import { createShellJob, killProcessTree, type ShellJob, type ShellSessionJob } from '../pi-session/tools/process-tree';

export interface GitVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

// The git the host found: an absolute path, never a bare name, whose relative PATH entries resolve against the repository.
export interface GitBinary {
  readonly path: string;
  readonly version: GitVersion;
}

/** `git version 2.45.1.windows.1` → 2.45.1; undefined when the text names no version. */
export function parseGitVersion(text: string): GitVersion | undefined {
  const match = /^git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(text.trim());
  return match ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3] ?? 0) } : undefined;
}

export function gitAtLeast(version: GitVersion, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor);
}

// Any scheme://userinfo@ loses its userinfo: tokens and passwords ride in remote URLs.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]*@/gi;

export function redactUrls(text: string): string {
  return text.replace(URL_USERINFO, '$1');
}

// Characters that could break or reorder a log line: control and line-separator characters and bidi controls.
// eslint-disable-next-line no-control-regex
const LOG_UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

function escapeLogUnsafe(text: string): string {
  return text.replace(LOG_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// An argument is logged bare only when it holds nothing a reader could mistake; anything else is JSON-quoted with the
// log's escapes, so a file name cannot forge or reorder a log line.
function logArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : escapeLogUnsafe(JSON.stringify(arg));
}

function logText(text: string): string {
  return escapeLogUnsafe(redactUrls(text));
}

/**
 * A revision git may read as one: no leading '-' (an option such as --upload-pack=x), no control characters and none of
 * check-ref-format's forbidden sequences. Every revision a caller passes is checked here before any spawn.
 */
export function isSafeRevision(ref: string): boolean {
  if (ref.length === 0 || ref.length > 1024 || ref.startsWith('-')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(ref)) return false;
  if (ref.includes('..') || ref.includes('@{') || ref.includes('//') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) return false;
  return !ref.split('/').some((part) => part.startsWith('.'));
}

/** Throws unless isSafeRevision; then the revision, for the argv. */
export function revision(ref: string): string {
  if (!isSafeRevision(ref)) throw new Error('Refused a revision that git could read as an option or a malformed ref');
  return ref;
}

// Windows' command line limit is 32,767 characters; a chunk of paths gets at most MAX_CLI_LENGTH of them, which leaves
// 2,767 for the git path and the arguments before the paths.
export const MAX_CLI_LENGTH = 30_000;

/**
 * VS Code's splitInChunks (extensions/git/src/util.ts, MIT): path lists split so each chunk's command line stays under the
 * limit. Each path costs its length plus 3: the separating space and the two quotes Windows adds around a path with a space.
 */
export function* splitInChunks(values: readonly string[], maxChunkLength: number): IterableIterator<string[]> {
  let current: string[] = [];
  let length = 0;
  for (const value of values) {
    const cost = value.length + 3;
    let next = length + cost;
    if (next > maxChunkLength && current.length > 0) {
      yield current;
      current = [];
      next = cost;
    }
    current.push(value);
    length = next;
  }
  if (current.length > 0) yield current;
}

export class GitError extends Error {
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(message: string, exitCode: number | null, stdout: string, stderr: string) {
    super(message);
    this.name = 'GitError';
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

// The engine runs no git for a project that is not trusted (D8); the runner refuses as the last line.
export class GitUntrustedError extends Error {
  constructor() {
    super('Source control runs no git in an untrusted project');
    this.name = 'GitUntrustedError';
  }
}

export class GitOutputTooLargeError extends Error {
  constructor() {
    super('git printed more than the engine reads');
    this.name = 'GitOutputTooLargeError';
  }
}

export type GitCallKind = 'read' | 'status' | 'mutation';

export interface GitCall {
  // the project folder whose trust governs this call
  readonly project: string;
  readonly cwd: string;
  readonly args: readonly string[];
  readonly kind: GitCallKind;
  // output the engine parses runs with LC_ALL=C
  readonly parsed?: boolean;
  // stdin (a commit message, a pathspec list); never logged
  readonly input?: string;
  // stdout beyond this ends a cancellable call with GitOutputTooLargeError; any other call keeps running and drops the rest
  readonly maxOutputBytes?: number;
  // a non-zero exit is an answer, not an error (check-ignore, rev-parse probes)
  readonly allowFailure?: boolean;
  // the call names paths a repository author chose: GIT_LITERAL_PATHSPECS=1, so a name like `a*` or `:(top)` never widens a
  // discard or a stage. Only these calls get it, since hooks inherit the environment and a hook's own globs must keep working.
  readonly literalPathspecs?: true;
  // streamed stdout, decoded as UTF-8 across chunks; 'stop' ends a cancellable call's process tree and the call resolves
  // with what was read
  readonly onData?: (chunk: string) => 'stop' | undefined;
  // Makes the call cancellable: its process tree runs in its own job (a process group on POSIX), and an abort kills the
  // whole tree and rejects with the signal's reason. Only a call that never writes the index or a ref may carry one.
  readonly signal?: AbortSignal;
  // The owner's session job, which a cancellable call's process tree also joins, so the owner's dispose or the host's death
  // kills it. A call without signal never joins it, so an index write is never killed.
  readonly session?: ShellSessionJob;
  // GIT_CEILING_DIRECTORIES: git looks for a repository at none of these folders nor above them
  readonly ceilingDirectories?: readonly string[];
  // git may reach no remote: GIT_ALLOW_PROTOCOL names a protocol that does not exist, which overrides every protocol.*.allow
  readonly localOnly?: true;
}

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export interface GitLog {
  appendLine(line: string): void;
}

export interface GitRunnerDeps {
  readonly git: GitBinary;
  readonly log: GitLog;
  readonly isTrusted: (project: string) => boolean;
  readonly spawn?: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  readonly now?: () => number;
}

export interface GitRunner {
  readonly git: GitBinary;
  run(call: GitCall): Promise<GitResult>;
  // the environment a call runs with, which the docs and tests read from here
  envFor(call: Pick<GitCall, 'kind' | 'parsed' | 'literalPathspecs' | 'ceilingDirectories' | 'localOnly'>): NodeJS.ProcessEnv;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_LOGGED_STDERR_CHARS = 2000;
const INHERITED_PATHSPEC_MODES: ReadonlySet<string> = new Set(['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']);

/** The environment every engine git call runs with: no prompt and no editor; literal pathspecs where it names paths. */
export function gitEnv(call: Pick<GitCall, 'kind' | 'parsed' | 'literalPathspecs' | 'ceilingDirectories' | 'localOnly'>): NodeJS.ProcessEnv {
  const env = childEnv();
  // An inherited pathspec mode turns the fence's exclusions into file names or clashes with the literal mode set here; keys
  // match as Windows does.
  for (const key of Object.keys(env)) if (INHERITED_PATHSPEC_MODES.has(key.toUpperCase())) delete env[key];
  const inherited = env['GIT_CEILING_DIRECTORIES'];
  const ceilings = [...(call.ceilingDirectories ?? []), ...(inherited ? [inherited] : [])];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    ...(call.literalPathspecs ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
    ...(call.localOnly ? { GIT_ALLOW_PROTOCOL: 'none' } : {}),
    ...(call.parsed ? { LC_ALL: 'C' } : {}),
    ...(ceilings.length > 0 ? { GIT_CEILING_DIRECTORIES: ceilings.join(path.delimiter) } : {}),
    // Status takes no optional lock, so it never holds the index lock another tool needs. A working-tree diff refreshes the
    // index whatever GIT_OPTIONAL_LOCKS says, so every engine diff passes -c diff.autoRefreshIndex=false instead.
    ...(call.kind === 'status' ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  };
}

/** The index of the subcommand in args: the first argument that is no option, skipping the value of -c and -C. */
export function subcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += args[index] === '-c' || args[index] === '-C' ? 2 : 1;
  return index;
}

export function createGitRunner(deps: GitRunnerDeps): GitRunner {
  const spawn = deps.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options));
  const now = deps.now ?? (() => Date.now());
  return {
    git: deps.git,
    envFor: gitEnv,
    run(call) {
      return new Promise<GitResult>((resolve, reject) => {
        if (call.signal?.aborted) {
          reject(call.signal.reason);
          return;
        }
        if (!deps.isTrusted(call.project)) {
          reject(new GitUntrustedError());
          return;
        }
        const args = call.args;
        const started = now();
        const argv = args.map((arg) => logArg(redactUrls(arg))).join(' ');
        const cancellable = call.signal !== undefined;
        let child: ChildProcess;
        let job: ShellJob | undefined;
        try {
          // detached on POSIX: its own process group, which a kill signals as a whole
          child = spawn(deps.git.path, args, { cwd: call.cwd, env: gitEnv(call), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'], detached: cancellable && process.platform !== 'win32' });
          // The first statement after spawn: a hook git starts before the assignment would stay outside the job.
          job = cancellable && child.pid !== undefined ? createShellJob(child.pid, call.session) : undefined;
        } catch (err) {
          deps.log.appendLine(`> git ${argv} [failed to start: ${logText(err instanceof Error ? err.message : String(err))}]`);
          reject(err);
          return;
        }
        let settled = false;
        // Never after the call settled: the pid may name another process by then.
        const end = (): void => {
          if (settled) return;
          if (cancellable && child.pid !== undefined) killProcessTree(child.pid, job);
          else child.kill();
        };
        let cancelled = false;
        const onAbort = (): void => {
          cancelled = true;
          end();
        };
        call.signal?.addEventListener('abort', onAbort, { once: true });
        const release = (): void => {
          call.signal?.removeEventListener('abort', onAbort);
          job?.dispose();
        };
        const out: Buffer[] = [];
        let outBytes = 0;
        let stderr = '';
        let tooLarge = false;
        let stopped = false;
        const decoder = call.onData ? new StringDecoder('utf8') : undefined;
        const max = call.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        child.stdout!.on('data', (chunk: Buffer) => {
          if (tooLarge || stopped) return;
          if (decoder && call.onData!(decoder.write(chunk)) === 'stop') {
            stopped = true;
            end();
            return;
          }
          outBytes += chunk.length;
          if (outBytes > max) {
            tooLarge = true;
            // An index write is never killed: past the bound its output is dropped and it runs to its end.
            if (cancellable) end();
            return;
          }
          out.push(chunk);
        });
        child.stderr!.setEncoding('utf8');
        child.stderr!.on('data', (chunk: string) => {
          if (stderr.length < 1_000_000) stderr += chunk;
        });
        child.stdin!.on('error', () => undefined);
        child.stdin!.end(call.input ?? '');
        child.on('error', (err) => {
          if (settled) return;
          settled = true;
          release();
          deps.log.appendLine(`> git ${argv} [failed to start: ${logText(err.message)}]`);
          reject(err);
        });
        child.on('close', (code) => {
          if (settled) return;
          settled = true;
          release();
          const ms = now() - started;
          if (cancelled) {
            deps.log.appendLine(`> git ${argv} [${ms}ms] cancelled`);
            reject(call.signal!.reason);
            return;
          }
          if (tooLarge && cancellable) {
            deps.log.appendLine(`> git ${argv} [${ms}ms, output over ${max} bytes]`);
            reject(new GitOutputTooLargeError());
            return;
          }
          const exitCode = stopped ? 0 : (code ?? -1);
          const outcome = stopped ? ' stopped' : exitCode === 0 ? '' : ` exit ${exitCode}`;
          deps.log.appendLine(`> git ${argv} [${ms}ms]${outcome}${tooLarge ? `, output over ${max} bytes dropped` : ''}`);
          if (exitCode !== 0 && stderr.trim() !== '') deps.log.appendLine(logText(stderr.trim().slice(0, MAX_LOGGED_STDERR_CHARS)));
          const stdout = Buffer.concat(out);
          if (exitCode !== 0 && !call.allowFailure) {
            reject(new GitError(`git ${args[subcommandIndex(args)] ?? ''} exited with ${exitCode}`, code, stdout.toString('utf8'), stderr));
            return;
          }
          resolve({ exitCode, stdout, stderr });
        });
      });
    },
  };
}

export class GitQueueDisposedError extends Error {
  constructor() {
    super('The repository was closed');
    this.name = 'GitQueueDisposedError';
  }
}

interface Waiting {
  readonly kind: 'status' | 'mutation';
  readonly start: () => void;
  readonly cancel: () => void;
}

export const MAX_CONCURRENT_READS = 4;

/**
 * One repository's work queue. Reads run up to MAX_CONCURRENT_READS at once. Mutations and status runs are exclusive of
 * each other, in arrival order; one status runs at a time, and every status request made while one waits joins it (the one
 * trailing run). Disposing rejects what waits and kills the process trees of running reads and status runs through signal;
 * a running mutation finishes, since an index write is never cancelled.
 */
export class RepoQueue {
  private reads = 0;
  private readonly readWaiters: Array<{ readonly start: () => void; readonly cancel: () => void }> = [];
  private readonly exclusive: Waiting[] = [];
  private exclusiveRunning = false;
  private queuedStatus: Promise<unknown> | undefined;
  private disposed = false;
  private mutationsRunning = 0;
  private readonly idleListeners = new Set<() => void>();
  private readonly cancel = new AbortController();

  // Aborted on dispose. Only a call that never writes the index or a ref may carry it (GitCall.signal).
  get signal(): AbortSignal {
    return this.cancel.signal;
  }

  read<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposed) return Promise.reject(new GitQueueDisposedError());
    return new Promise<T>((resolve, reject) => {
      const start = (): void => {
        this.reads++;
        Promise.resolve().then(task).then(resolve, reject).finally(() => {
          this.reads--;
          this.readWaiters.shift()?.start();
        });
      };
      if (this.reads < MAX_CONCURRENT_READS) start();
      else this.readWaiters.push({ start, cancel: () => reject(new GitQueueDisposedError()) });
    });
  }

  mutation<T>(task: () => Promise<T>): Promise<T> {
    const queued = this.enqueueExclusive('mutation', task);
    this.notifyIdle();
    this.next();
    return queued;
  }

  // A status asked for while one waits shares that one's answer.
  status<T>(task: () => Promise<T>): Promise<T> {
    if (this.queuedStatus) return this.queuedStatus as Promise<T>;
    const queued = this.enqueueExclusive('status', task, () => {
      this.queuedStatus = undefined;
    });
    this.queuedStatus = queued;
    queued.catch(() => undefined);
    this.next();
    return queued;
  }

  // an index write runs: the snapshot's busy flag
  get busy(): boolean {
    return this.mutationsRunning > 0 || this.exclusive.some((waiting) => waiting.kind === 'mutation');
  }

  onIdleChange(listener: () => void): () => void {
    this.idleListeners.add(listener);
    return () => this.idleListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const waiting of this.exclusive.splice(0)) waiting.cancel();
    for (const waiting of this.readWaiters.splice(0)) waiting.cancel();
    this.queuedStatus = undefined;
    this.idleListeners.clear();
    this.cancel.abort(new GitQueueDisposedError());
  }

  private enqueueExclusive<T>(kind: 'status' | 'mutation', task: () => Promise<T>, onStart?: () => void): Promise<T> {
    if (this.disposed) return Promise.reject(new GitQueueDisposedError());
    const promise = new Promise<T>((resolve, reject) => {
      this.exclusive.push({
        kind,
        start: () => {
          onStart?.();
          if (kind === 'mutation') this.mutationsRunning++;
          Promise.resolve().then(task).then(resolve, reject).finally(() => {
            if (kind === 'mutation') this.mutationsRunning--;
            this.exclusiveRunning = false;
            this.next();
            this.notifyIdle();
          });
        },
        cancel: () => reject(new GitQueueDisposedError()),
      });
    });
    return promise;
  }

  private next(): void {
    if (this.exclusiveRunning || this.disposed) return;
    const waiting = this.exclusive.shift();
    if (!waiting) return;
    this.exclusiveRunning = true;
    waiting.start();
  }

  private notifyIdle(): void {
    for (const listener of this.idleListeners) listener();
  }
}
