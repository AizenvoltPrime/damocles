import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import {
  SSH_FAILURE_CODES,
  type CachedPlatform,
  type ConnectFailure,
  type ConnectStep,
  type ConnectStepEvent,
  type HostNotice,
  type SshFailureCode,
  type SshPrompt,
  type SshPromptAnswer,
} from '../../preload/overlay-channels';
import type { ProjectConnection } from '../../preload/shell-channels';
import type { SshHostRecord } from './host-store';
import type { LoopAttempt } from './reconnect';
import { knownHostsRemoveCommand, SshConnectError, type SshAttemptHooks } from './ssh';

// the steps stage 1 reports once it runs on the target
const STAGE_STEPS: ReadonlySet<Attempt['step']> = new Set<Attempt['step']>(['checking', 'installing', 'starting']);

export interface SshStartRequest {
  readonly host: SshHostRecord;
  readonly signal: AbortSignal;
  readonly hooks: SshAttemptHooks;
  readonly savePlatform: (platform: CachedPlatform) => Promise<void>;
  readonly installFolderSettled: () => Promise<void>;
}

// A running ssh bridge: its byte stream past the bridge's authentication, and ssh's stderr tail for Show log.
export interface SshStarted {
  readonly stream: Duplex;
  stderrTail(): string;
  dispose(): void;
}

export interface RemoteConnectionsDeps {
  readonly host: (hostId: string) => SshHostRecord | undefined;
  // starts ssh and the bridge; rejects with an error carrying code (an SshFailureCode), params and stderrTail
  readonly startSsh: (request: SshStartRequest) => Promise<SshStarted>;
  readonly savePlatform: (hostId: string, platform: CachedPlatform) => Promise<void>;
  readonly installFolderSettled: (hostId: string) => Promise<void>;
  // Authorities.connect for the host's authority key: the transport below, then hello, welcome and attach
  readonly connect: (hostId: string) => Promise<void>;
  // the host's connection: usable, held while suspect, or neither (none, or its transport lost)
  readonly connection: (hostId: string) => 'usable' | 'suspect' | undefined;
  // an attempt, a prompt or a host's notices changed
  readonly changed: (hostId: string) => void;
  readonly log: (line: string) => void;
}

interface PendingPrompt {
  readonly id: string;
  readonly prompt: SshPrompt;
  readonly answer: (value: SshPromptAnswer | undefined) => void;
}

interface Attempt {
  readonly id: string;
  readonly hostId: string;
  readonly controller: AbortController;
  step: ConnectStep | 'connected' | 'failed';
  readonly visited: ConnectStep[];
  progress?: number | undefined;
  prompt?: PendingPrompt | undefined;
  failure?: ConnectFailure;
  readonly notices: HostNotice[];
  // a user waits on it in the Connect dialog; an attempt nobody watches holds its prompt behind the sign-in banner
  watched: boolean;
  // settles once the attempt connected or failed, rejecting with the transport's or the handshake's error
  done: Promise<void>;
  // an ssh call that is no connect (the removal stage), which shows only its prompts
  readonly stage?: true;
}

interface HostState {
  attempt?: Attempt;
  started?: SshStarted | undefined;
  // ssh's stderr tail as the last bridge left it
  lastStderr: string;
}

// An error the transport throws: an SshFailureCode with its parameters and ssh's stderr tail.
interface ConnectError {
  readonly code: SshFailureCode;
  readonly params: Readonly<Record<string, string | number>>;
  readonly stderrTail?: string;
}

function isConnectError(err: unknown): err is ConnectError {
  if (!(err instanceof Error)) return false;
  const { code, params } = err as Partial<ConnectError>;
  return (SSH_FAILURE_CODES as readonly unknown[]).includes(code) && typeof params === 'object' && params !== null;
}

const BOUNDED_PARAM_CHARS = 500;

/** The failure an attempt shows: the transport's code, else the handshake's reason. */
export function failureOf(err: unknown): ConnectFailure {
  if (isConnectError(err)) {
    const host = err.params['host'];
    // the one text the changed-key dialog shows and copies
    return { code: err.code, params: err.code === 'hostKeyChanged' && typeof host === 'string' ? { ...err.params, command: knownHostsRemoveCommand(host) } : err.params };
  }
  return { code: 'handshakeFailed', params: { reason: (err instanceof Error ? err.message : String(err)).slice(0, BOUNDED_PARAM_CHARS) } };
}

/** Whether an attempt ended because the user cancelled it, which leaves its host offline rather than failed. */
export function isCancelled(err: unknown): boolean {
  return isConnectError(err) && err.code === 'cancelled';
}

/**
 * The SSH hosts' connection attempts (docs/invariants.md "Remote daemon and wire"): one attempt per host at a time, shared by
 * every caller, with its steps, the prompt ssh waits on and its failure. Authorities keeps the connection itself; this
 * manager is the ssh transport it calls; reconnect.ts decides when a dropped connection is attempted again.
 */
export class RemoteConnections {
  private readonly deps: RemoteConnectionsDeps;
  private readonly hosts = new Map<string, HostState>();
  private disposed = false;

  constructor(deps: RemoteConnectionsDeps) {
    this.deps = deps;
  }

  /**
   * Connects the host, or joins its attempt in flight; resolves the attempt's id at once. watched: a user waits on it in the
   * Connect dialog, so a prompt shows there instead of behind the sign-in banner. A suspect connection is joined, since only
   * the keepalive timeout decides a drop, unless force (Reconnect now) gives up its transport.
   */
  connect(hostId: string, watched: boolean, options: { readonly force?: boolean } = {}): string {
    if (this.disposed) throw new Error('The app is quitting');
    if (!this.deps.host(hostId)) throw new Error(`No saved host ${hostId}`);
    const state = this.stateOf(hostId);
    const running = this.running(state);
    if (running?.stage) throw new Error(`An ssh call to ${hostId} is running; connect once it finished`);
    if (running) {
      if (watched && !running.watched) {
        running.watched = true;
        this.deps.changed(hostId);
      }
      return running.id;
    }
    const held = this.deps.connection(hostId);
    if (state.attempt?.step === 'connected' && (held === 'usable' || (held === 'suspect' && options.force !== true))) return state.attempt.id;
    const attempt: Attempt = { id: randomUUID(), hostId, controller: new AbortController(), step: 'connecting', visited: ['connecting'], notices: [], watched, done: Promise.resolve() };
    state.attempt = attempt;
    this.deps.changed(hostId);
    attempt.done = this.deps.connect(hostId).then(() => {
      if (state.attempt !== attempt) return;
      attempt.step = 'connected';
      attempt.prompt = undefined;
      this.deps.changed(hostId);
    }, (err: unknown) => {
      // Cancel, Escape or Disconnect Host ended it, whatever the transport or the handshake threw on the way out
      const ended = attempt.controller.signal.aborted && !isCancelled(err) ? new SshConnectError('cancelled', {}, state.started?.stderrTail() ?? state.lastStderr) : err;
      if (state.attempt === attempt) this.fail(attempt, ended);
      throw ended;
    });
    attempt.done.catch(() => undefined);
    return attempt.id;
  }

  /** Settles with the attempt's outcome; undefined for an attempt that is no longer the host's. */
  outcome(attemptId: string): Promise<void> | undefined {
    return this.attemptById(attemptId)?.done;
  }

  /**
   * The reconnect loop's attempt: joins a connect attempt in flight, which only its own caller ends, else connects unwatched,
   * cancelled by signal until it settles.
   */
  loopAttempt(hostId: string, signal: AbortSignal, force: boolean): LoopAttempt {
    const running = this.running(this.stateOf(hostId));
    if (running && !running.stage) return { joined: true, outcome: running.done };
    const attemptId = this.connect(hostId, false, { force });
    const cancel = (): void => this.cancel(attemptId);
    signal.addEventListener('abort', cancel, { once: true });
    return { joined: false, outcome: this.attemptById(attemptId)!.done.finally(() => signal.removeEventListener('abort', cancel)) };
  }

  /**
   * The transport Authorities runs for the host's authority: ssh for the host's current attempt, asked once more by an attempt
   * whose resume the daemon refused.
   */
  async transport(hostId: string): Promise<Duplex> {
    const state = this.stateOf(hostId);
    const attempt = state.attempt;
    const host = this.deps.host(hostId);
    if (!attempt || attempt.step === 'connected' || attempt.step === 'failed' || !host) throw new Error(`No connection attempt for ${hostId} is waiting on its transport`);
    const started = await this.deps.startSsh({
      host,
      signal: attempt.controller.signal,
      hooks: this.hooksOf(attempt),
      savePlatform: (platform) => this.deps.savePlatform(hostId, platform),
      installFolderSettled: () => this.deps.installFolderSettled(hostId),
    }).catch((err: unknown) => {
      if (isConnectError(err) && err.stderrTail !== undefined) state.lastStderr = err.stderrTail;
      throw err;
    });
    state.started = started;
    // the bridge's end, a drop or a cancel during the handshake: ssh goes and its last stderr stays for Show log
    started.stream.once('close', () => {
      state.lastStderr = started.stderrTail();
      started.dispose();
      if (state.started === started) state.started = undefined;
    });
    // a cancel between the transport resolving and here reaches no listener
    if (attempt.controller.signal.aborted) {
      started.stream.destroy();
      throw new SshConnectError('cancelled', {}, started.stderrTail());
    }
    attempt.controller.signal.addEventListener('abort', () => started.stream.destroy(), { once: true });
    return started.stream;
  }

  /**
   * The user's answer to the prompt the attempt waits on; null cancels it. Answers to another prompt are ignored. remember
   * is refused unless the prompt offered it.
   */
  answer(attemptId: string, promptId: string, answer: string | null, remember: boolean): void {
    const attempt = this.attemptById(attemptId);
    const pending = attempt?.prompt;
    if (!attempt || pending?.id !== promptId) {
      this.deps.log('[remote] ignoring an answer to a prompt that is not waiting');
      return;
    }
    if (pending.prompt.kind === 'hostKey' && answer !== null && answer !== 'connect' && answer !== 'cancel') throw new Error('A host key is answered connect or cancel');
    if (remember && !(pending.prompt.kind === 'secret' && pending.prompt.offerRemember === true)) throw new Error('The prompt offers no Remember on this computer');
    attempt.prompt = undefined;
    this.deps.changed(attempt.hostId);
    pending.answer(answer === null ? undefined : { answer, remember });
  }

  /**
   * An ssh call that is no connect (the removal stage): its questions show as the host's attempt prompt while it runs, and the
   * host's attempt is what it was afterwards. A connect meanwhile is refused.
   */
  async withPrompts<T>(hostId: string, run: (prompt: SshAttemptHooks['prompt'], signal: AbortSignal) => Promise<T>): Promise<T> {
    const state = this.stateOf(hostId);
    const previous = state.attempt;
    if (previous && previous.step !== 'connected' && previous.step !== 'failed') throw new Error(`An attempt to reach ${hostId} is running`);
    const attempt: Attempt = { id: randomUUID(), hostId, controller: new AbortController(), step: 'authenticating', visited: ['authenticating'], notices: [], watched: true, done: Promise.resolve(), stage: true };
    state.attempt = attempt;
    this.deps.changed(hostId);
    try {
      return await run(this.hooksOf(attempt).prompt, attempt.controller.signal);
    } finally {
      if (state.attempt === attempt) {
        if (previous) state.attempt = previous;
        else delete state.attempt;
        this.deps.changed(hostId);
      }
    }
  }

  /** Ends the attempt: ssh is killed and the host stays offline. */
  cancel(attemptId: string): void {
    const attempt = this.attemptById(attemptId);
    if (attempt) this.end(attempt);
  }

  /**
   * Disconnect Host: the host's connect attempt in flight ends as a Cancel does; a removal stage is its own. Settles once that
   * attempt settled, whatever its outcome (its own handlers report it), so a connect after it starts afresh, never joining it.
   */
  cancelHost(hostId: string): Promise<void> {
    const running = this.running(this.stateOf(hostId));
    if (!running || running.stage) return Promise.resolve();
    this.cancel(running.id);
    return running.done.then(() => undefined, () => undefined);
  }

  /** Forget host: its attempt in flight ends and nothing of the host stays: attempt, notices, stderr tail. */
  forget(hostId: string): void {
    const state = this.hosts.get(hostId);
    if (!state) return;
    this.hosts.delete(hostId);
    const attempt = state.attempt;
    // an attempt that is no longer the host's reports nothing when it settles
    delete state.attempt;
    if (attempt) this.end(attempt);
    state.started?.dispose();
  }

  /** The Connect dialog shows (true) or no longer shows (false) the host's attempt. */
  watch(hostId: string, watched: boolean): void {
    const attempt = this.hosts.get(hostId)?.attempt;
    if (!attempt || attempt.watched === watched) return;
    attempt.watched = watched;
    this.deps.changed(hostId);
  }

  /** A user watches the host's attempt in flight in the Connect dialog. */
  isWatched(hostId: string): boolean {
    const state = this.hosts.get(hostId);
    return (state && this.running(state))?.watched === true;
  }

  /** The host's connect attempt in flight runs stage 1 on the target. */
  staging(hostId: string): boolean {
    const state = this.hosts.get(hostId);
    const running = state && this.running(state);
    return running !== undefined && !running.stage && STAGE_STEPS.has(running.step);
  }

  /** The host's latest attempt as the timeline shows it. */
  attempt(hostId: string): ConnectStepEvent | undefined {
    const attempt = this.hosts.get(hostId)?.attempt;
    if (!attempt) return undefined;
    return {
      attemptId: attempt.id,
      hostId,
      step: attempt.step,
      visited: [...attempt.visited],
      ...(attempt.progress !== undefined ? { progress: attempt.progress } : {}),
      ...(attempt.prompt ? { prompt: { promptId: attempt.prompt.id, ...attempt.prompt.prompt } } : {}),
      ...(attempt.failure ? { failure: attempt.failure } : {}),
      notices: [...attempt.notices],
    };
  }

  /** An attempt nobody watches waits on a prompt: the sign-in banner shows for the host. */
  signInNeeded(hostId: string): boolean {
    const attempt = this.hosts.get(hostId)?.attempt;
    return attempt?.prompt !== undefined && !attempt.watched;
  }

  /** The failure of the host's last attempt while it is the host's latest outcome. */
  failure(hostId: string): ConnectFailure | undefined {
    return this.hosts.get(hostId)?.attempt?.failure;
  }

  notices(hostId: string): readonly HostNotice[] {
    return this.hosts.get(hostId)?.attempt?.notices ?? [];
  }

  /** A notice that no longer holds (linger enabled after the probe reported none) leaves the host's card. */
  dropNotice(hostId: string, code: HostNotice['code']): void {
    const attempt = this.hosts.get(hostId)?.attempt;
    if (!attempt) return;
    const kept = attempt.notices.filter((notice) => notice.code !== code);
    if (kept.length === attempt.notices.length) return;
    attempt.notices.splice(0, attempt.notices.length, ...kept);
    this.deps.changed(hostId);
  }

  /** ssh's stderr tail: the running bridge's, else what the last one left. */
  stderrTail(hostId: string): string {
    const state = this.hosts.get(hostId);
    return state?.started?.stderrTail() ?? state?.lastStderr ?? '';
  }

  /** Every attempt in flight ends; connections themselves close with Authorities. */
  dispose(): void {
    this.disposed = true;
    for (const state of this.hosts.values()) {
      if (state.attempt) this.cancel(state.attempt.id);
      state.started?.dispose();
    }
  }

  private stateOf(hostId: string): HostState {
    let state = this.hosts.get(hostId);
    if (!state) {
      state = { lastStderr: '' };
      this.hosts.set(hostId, state);
    }
    return state;
  }

  private attemptById(attemptId: string): Attempt | undefined {
    return [...this.hosts.values()].find((state) => state.attempt?.id === attemptId)?.attempt;
  }

  // the host's attempt while it neither connected nor failed
  private running(state: HostState): Attempt | undefined {
    const attempt = state.attempt;
    return attempt && attempt.step !== 'connected' && attempt.step !== 'failed' ? attempt : undefined;
  }

  private end(attempt: Attempt): void {
    if (attempt.step === 'connected' || attempt.step === 'failed') return;
    attempt.controller.abort();
    attempt.prompt?.answer(undefined);
  }

  private fail(attempt: Attempt, err: unknown): void {
    attempt.step = 'failed';
    attempt.prompt = undefined;
    attempt.progress = undefined;
    attempt.failure = failureOf(err);
    this.deps.log(`[remote] connecting to host ${attempt.hostId} failed: ${attempt.failure.code} ${JSON.stringify(attempt.failure.params)}`);
    this.deps.changed(attempt.hostId);
  }

  private hooksOf(attempt: Attempt): SshAttemptHooks {
    const live = (): boolean => this.hosts.get(attempt.hostId)?.attempt === attempt && attempt.step !== 'connected' && attempt.step !== 'failed';
    return {
      step: (step) => {
        if (!live() || attempt.step === step) return;
        attempt.step = step;
        attempt.progress = undefined;
        if (!attempt.visited.includes(step)) attempt.visited.push(step);
        this.deps.changed(attempt.hostId);
      },
      progress: (fraction) => {
        if (!live() || !Number.isFinite(fraction)) return;
        attempt.progress = Math.min(1, Math.max(0, fraction));
        this.deps.changed(attempt.hostId);
      },
      prompt: (prompt, signal) => {
        if (!live() || attempt.controller.signal.aborted || signal.aborted) return Promise.resolve(undefined);
        // ssh asks one question at a time; a new one replaces an unanswered one, which is answered cancelled
        attempt.prompt?.answer(undefined);
        return new Promise<SshPromptAnswer | undefined>((resolve) => {
          const pending: PendingPrompt = { id: randomUUID(), prompt, answer: resolve };
          attempt.prompt = pending;
          // ssh withdrew the question (it exited, or the attempt was cancelled): the dialog stops showing it
          signal.addEventListener('abort', () => {
            if (attempt.prompt !== pending) return;
            attempt.prompt = undefined;
            resolve(undefined);
            this.deps.changed(attempt.hostId);
          }, { once: true });
          this.deps.changed(attempt.hostId);
        });
      },
      notice: (notice) => {
        if (!live()) return;
        // a low limit is shown once the target's watcher runs out for a project (watch-limit.ts), not at the probe
        if (notice.code === 'lowInotify') {
          this.deps.log(`[remote] host ${attempt.hostId}: fs.inotify.max_user_watches is ${notice.params['limit']}`);
          return;
        }
        attempt.notices.push(notice);
        this.deps.changed(attempt.hostId);
      },
    };
  }
}

/** The connection state a host shows: Authorities' state, except that a cancelled attempt leaves it offline. */
export function hostConnection(state: ProjectConnection, failure: ConnectFailure | undefined): ProjectConnection {
  return state === 'failed' && failure?.code === 'cancelled' ? 'offline' : state;
}
