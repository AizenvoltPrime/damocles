// Every git process the source control engine starts (plan AD4, "Process model"; docs/invariants.md "Source control").
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { childEnv } from '../pi-session/checkpoints/exec';
import { processLauncher, type Launcher, type SessionJob } from '../process-launcher';
import { GitError, GitUntrustedError, redactUrls } from './errors';

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

export function gitAtLeast(version: GitVersion, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor);
}

// Never for checkout or reset, which git 2.43 parses wrongly with it.
export function endOfOptions(version: GitVersion): string[] {
  return gitAtLeast(version, 2, 24) ? ['--end-of-options'] : [];
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

/** Text fit for a log line: URL userinfo redacted and control, line-separator and bidi characters escaped. */
export function logText(text: string): string {
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

export class GitOutputTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`git printed more than the ${maxBytes} bytes the engine reads`);
    this.name = 'GitOutputTooLargeError';
    this.maxBytes = maxBytes;
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
  // stdin (a commit message, a pathspec list, a blob's bytes); never logged
  readonly input?: string | Buffer;
  // stdout beyond this rejects the call with GitOutputTooLargeError: a cancellable call is ended, any other runs to its end
  readonly maxOutputBytes?: number;
  // stdout beyond maxOutputBytes is dropped, the process runs to its end and the result is marked truncated
  readonly preview?: true;
  // a non-zero exit is an answer, not an error (check-ignore, rev-parse probes)
  readonly allowFailure?: boolean;
  // the call names paths a repository author chose: GIT_LITERAL_PATHSPECS=1, so a name like `a*` or `:(top)` never widens a
  // discard or a stage. Only these calls get it, since hooks inherit the environment and a hook's own globs must keep working.
  readonly literalPathspecs?: true;
  // streamed stdout, decoded as UTF-8 across chunks and never buffered (the result's stdout is empty, and maxOutputBytes does
  // not apply); 'stop' ends a cancellable call's process tree and the call resolves
  readonly onData?: (chunk: string) => 'stop' | undefined;
  // Makes the call cancellable: its process tree runs in its own job (a process group on POSIX), and an abort kills the
  // whole tree and rejects with the signal's reason. A write carries one only as a remote operation, whose locks a kill leaves.
  readonly signal?: AbortSignal;
  // The owner's session job, which a cancellable call's process tree also joins, so the owner's dispose or the host's death
  // kills it. A call without signal never joins it, so an engine write that is no remote operation is never killed.
  readonly session?: SessionJob;
  // GIT_CEILING_DIRECTORIES: git never searches up into one, but still checks the call's own folder when it is one
  readonly ceilingDirectories?: readonly string[];
  // git may reach no remote: GIT_ALLOW_PROTOCOL names a protocol that does not exist, which overrides every protocol.*.allow
  readonly localOnly?: true;
  // the askpass registration's variables, only on a call that may need credentials (a remote operation or a clone)
  readonly askpassEnv?: Readonly<Record<string, string>>;
  // set only by Repository.withStash after its fenced stash push; fence() refuses a starting pull, merge or rebase without it
  readonly fencedStash?: true;
  // command-line config passed as GIT_CONFIG_COUNT pairs, which carry a key holding '=' that -c would split
  readonly config?: ReadonlyArray<readonly [key: string, value: string]>;
  // GIT_INDEX_FILE: a temporary index, so a snapshot of the working tree never touches the repository's real index
  readonly indexFile?: string;
}

// A clone: the one git call that runs in no project, so no trust decides it (it runs no code of an existing repository).
export interface GitCloneCall {
  // the folder the clone's target lies in; no git the clone starts looks for a repository above it
  readonly cwd: string;
  readonly args: readonly string[];
  readonly signal: AbortSignal;
  readonly session?: SessionJob;
  readonly askpassEnv?: Readonly<Record<string, string>>;
}

export interface GitResult {
  readonly exitCode: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  // only a preview call's: stdout holds the first maxOutputBytes of a longer output
  readonly truncated?: true;
}

export interface GitLog {
  appendLine(line: string): void;
}

export interface GitRunnerDeps {
  readonly git: GitBinary;
  readonly log: GitLog;
  readonly isTrusted: (project: string) => boolean;
  // the process-wide launcher when left out
  readonly launcher?: Launcher;
  readonly now?: () => number;
  // the stdout bound of a call that names none
  readonly maxOutputBytes?: number;
}

export interface GitRunner {
  readonly git: GitBinary;
  run(call: GitCall): Promise<GitResult>;
  // the environment a call runs with, which the docs and tests read from here
  envFor(call: Pick<GitCall, 'kind' | 'parsed' | 'literalPathspecs' | 'ceilingDirectories' | 'localOnly' | 'askpassEnv' | 'config' | 'indexFile'>): NodeJS.ProcessEnv;
}

// The runner the host creates: run, plus clone, which ScmService's trust gate never wraps.
export interface GitCloner {
  clone(call: GitCloneCall): Promise<GitResult>;
}

const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_LOGGED_STDERR_CHARS = 2000;
const INHERITED_PATHSPEC_MODES: ReadonlySet<string> = new Set(['GIT_LITERAL_PATHSPECS', 'GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']);
// A chat worktree sits deeper than its project, so a path that fits there can pass Windows' 260 characters in the worktree;
// Git for Windows reaches such a path only with core.longpaths, which other platforms ignore.
const ENGINE_CONFIG: ReadonlyArray<readonly [string, string]> = [['core.longpaths', 'true']];

/** The environment every engine git call runs with: no prompt and no editor; literal pathspecs where it names paths. */
export function gitEnv(call: Pick<GitCall, 'kind' | 'parsed' | 'literalPathspecs' | 'ceilingDirectories' | 'localOnly' | 'askpassEnv' | 'config' | 'indexFile'>): NodeJS.ProcessEnv {
  const env = childEnv();
  // An inherited pathspec mode turns the fence's exclusions into file names or clashes with the literal mode set here; keys
  // match as Windows does.
  for (const key of Object.keys(env)) if (INHERITED_PATHSPEC_MODES.has(key.toUpperCase())) delete env[key];
  const inherited = env['GIT_CEILING_DIRECTORIES'];
  const ceilings = [...(call.ceilingDirectories ?? []), ...(inherited ? [inherited] : [])];
  return {
    ...env,
    // before the engine's own variables, so a registration can never override one
    ...call.askpassEnv,
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    ...(call.literalPathspecs ? { GIT_LITERAL_PATHSPECS: '1' } : {}),
    ...(call.indexFile !== undefined ? { GIT_INDEX_FILE: call.indexFile } : {}),
    ...(call.localOnly ? { GIT_ALLOW_PROTOCOL: 'none' } : {}),
    ...configPairs([...ENGINE_CONFIG, ...(call.config ?? [])]),
    ...(call.parsed ? { LC_ALL: 'C' } : {}),
    ...(ceilings.length > 0 ? { GIT_CEILING_DIRECTORIES: ceilings.join(path.delimiter) } : {}),
    // Status takes no optional lock, so it never holds the index lock another tool needs. A working-tree diff refreshes the
    // index whatever GIT_OPTIONAL_LOCKS says, so every engine diff passes -c diff.autoRefreshIndex=false instead.
    ...(call.kind === 'status' ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
  };
}

// childEnv() drops any inherited GIT_CONFIG_COUNT, KEY and VALUE, so these are the only pairs
function configPairs(config: ReadonlyArray<readonly [string, string]>): Record<string, string> {
  const pairs: Record<string, string> = { GIT_CONFIG_COUNT: String(config.length) };
  config.forEach(([key, value], index) => {
    pairs[`GIT_CONFIG_KEY_${index}`] = key;
    pairs[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return pairs;
}

/** The index of the subcommand in args: the first argument that is no option, skipping the value of -c and -C. */
export function subcommandIndex(args: readonly string[]): number {
  let index = 0;
  while (index < args.length && args[index]!.startsWith('-')) index += args[index] === '-c' || args[index] === '-C' ? 2 : 1;
  return index;
}

export function createGitRunner(deps: GitRunnerDeps): GitRunner & GitCloner {
  const launcher = deps.launcher ?? processLauncher();
  const now = deps.now ?? (() => Date.now());
  const defaultMaxOutput = deps.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const execute = (call: Omit<GitCall, 'project'>): Promise<GitResult> =>
    new Promise<GitResult>((resolve, reject) => {
      if (call.signal?.aborted) {
        reject(call.signal.reason);
        return;
      }
      // git before 2.31 ignores GIT_CONFIG_COUNT, so it gets the engine's config as -c options
      const args = gitAtLeast(deps.git.version, 2, 31) ? call.args : [...ENGINE_CONFIG.flatMap(([key, value]) => ['-c', `${key}=${value}`]), ...call.args];
      const started = now();
      const argv = args.map((arg) => logArg(redactUrls(arg))).join(' ');
      const cancellable = call.signal !== undefined;
      // Detached on POSIX: its own process group, which a kill signals as a whole. A cancellable call's process tree also
      // joins the owner's session job, which the launcher's worker assigns right after the start.
      const child = launcher.launch({
        file: deps.git.path,
        args,
        cwd: call.cwd,
        env: gitEnv(call),
        windowsHide: true,
        shell: false,
        detached: cancellable && process.platform !== 'win32',
        ...(cancellable && call.session ? { job: call.session.id } : {}),
      });
      let settled = false;
      let spawned = false;
      // Never after the call settled: the pid may name another process by then.
      const end = (): void => {
        if (settled) return;
        if (cancellable) child.kill({ tree: true });
        else child.kill();
      };
      let cancelled = false;
      const onAbort = (): void => {
        cancelled = true;
        end();
      };
      call.signal?.addEventListener('abort', onAbort, { once: true });
      const out: Buffer[] = [];
      let outBytes = 0;
      let stderr = '';
      const stderrDecoder = new StringDecoder('utf8');
      let tooLarge = false;
      let stopped = false;
      const decoder = call.onData ? new StringDecoder('utf8') : undefined;
      const max = call.maxOutputBytes ?? defaultMaxOutput;
      child.onData('stdout', (chunk) => {
        if (tooLarge || stopped) return;
        if (decoder) {
          // a streamed call's stdout goes to onData alone; it bounds what it keeps itself
          if (call.onData!(decoder.write(chunk)) !== 'stop') return;
          stopped = true;
          end();
          return;
        }
        const kept = outBytes;
        outBytes += chunk.length;
        if (outBytes > max) {
          if (call.preview) out.push(chunk.subarray(0, max - kept));
          tooLarge = true;
          // An index write is never killed: past the bound it runs to its end with its output dropped.
          if (cancellable && !call.preview) end();
          return;
        }
        out.push(chunk);
      });
      child.onData('stderr', (chunk) => {
        if (stderr.length < 1_000_000) stderr += stderrDecoder.write(chunk);
      });
      child.end(call.input ?? '');
      child.pid.then(() => {
        spawned = true;
      }, () => undefined);
      Promise.all([child.exited, child.closed]).then(
        ([{ code }]) => {
          settled = true;
          call.signal?.removeEventListener('abort', onAbort);
          const ms = now() - started;
          if (cancelled) {
            deps.log.appendLine(`> git ${argv} [${ms}ms] cancelled`);
            reject(call.signal!.reason);
            return;
          }
          // a sequence split across the last chunks completes only at the end
          if (stderr.length < 1_000_000) stderr += stderrDecoder.end();
          if (decoder && !stopped) {
            const rest = decoder.end();
            if (rest !== '') call.onData!(rest);
          }
          if (tooLarge && !call.preview) {
            const failed = !cancellable && code !== 0;
            deps.log.appendLine(`> git ${argv} [${ms}ms]${failed ? ` exit ${code ?? -1}` : ''}, output over ${max} bytes`);
            if (failed && stderr.trim() !== '') deps.log.appendLine(logText(stderr.trim().slice(0, MAX_LOGGED_STDERR_CHARS)));
            reject(new GitOutputTooLargeError(max));
            return;
          }
          const exitCode = stopped ? 0 : (code ?? -1);
          const outcome = stopped ? ' stopped' : exitCode === 0 ? '' : ` exit ${exitCode}`;
          deps.log.appendLine(`> git ${argv} [${ms}ms]${outcome}${tooLarge ? `, output past ${max} bytes not kept` : ''}`);
          if (exitCode !== 0 && stderr.trim() !== '') deps.log.appendLine(logText(stderr.trim().slice(0, MAX_LOGGED_STDERR_CHARS)));
          const stdout = Buffer.concat(out);
          if (exitCode !== 0 && !call.allowFailure) {
            reject(new GitError(`git ${args[subcommandIndex(args)] ?? ''} exited with ${exitCode}`, code, stdout.toString('utf8'), stderr));
            return;
          }
          resolve({ exitCode, stdout, stderr, ...(tooLarge ? { truncated: true as const } : {}) });
        },
        (err: unknown) => {
          settled = true;
          call.signal?.removeEventListener('abort', onAbort);
          if (cancelled) {
            deps.log.appendLine(`> git ${argv} [${now() - started}ms] cancelled`);
            reject(call.signal!.reason);
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          deps.log.appendLine(`> git ${argv} [${spawned ? `failed: ${logText(message)}` : `failed to start: ${logText(message)}`}]`);
          reject(err);
        },
      );
    });
  return {
    git: deps.git,
    envFor: gitEnv,
    run(call) {
      if (!deps.isTrusted(call.project)) return call.signal?.aborted ? Promise.reject(call.signal.reason) : Promise.reject(new GitUntrustedError());
      return execute(call);
    },
    clone(call) {
      if (call.args[subcommandIndex(call.args)] !== 'clone') return Promise.reject(new Error('The clone entry runs git clone only'));
      return execute({ cwd: call.cwd, args: call.args, kind: 'mutation', signal: call.signal, ceilingDirectories: [call.cwd], ...(call.session ? { session: call.session } : {}), ...(call.askpassEnv ? { askpassEnv: call.askpassEnv } : {}) });
    },
  };
}

export class GitQueueDisposedError extends Error {
  constructor(options?: ErrorOptions) {
    super('The repository was closed', options);
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
 * trailing run). Disposing kills running reads, status runs and a pull through signal; any other running mutation finishes.
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

  // Aborted on dispose; an engine write other than a remote operation never carries it.
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
