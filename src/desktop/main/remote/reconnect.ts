// The reconnect loop: docs/invariants.md "Remote daemon and wire", the reconnect loop.
import type { ConnectFailure } from '../../preload/overlay-channels';
import type { ProjectConnection } from '../../preload/shell-channels';
import type { Disposable } from '../../../platform/disposable';
import type { HostReconnect, PermanentFailureCode } from '../../../shared/host-connection';

export type { PermanentFailureCode } from '../../../shared/host-connection';
export type ReconnectPhase = HostReconnect;

// seconds before each attempt after a drop; past the last, every RECONNECT_REPEAT_S forever (D3)
export const RECONNECT_BACKOFF_S: readonly number[] = [0, 5, 5, 10, 10, 10, 10, 10, 30];
export const RECONNECT_REPEAT_S = 30;
// paused while the attempt waits on a prompt; off once stage 1 runs on the target or a user watches the attempt
export const ATTEMPT_TIMEOUT_MS = 30_000;
// Electron's main process has net.online and no network-change event, so it is sampled this often while a loop waits
export const NETWORK_SAMPLE_MS = 2000;

// resumed: the same connection, resumed inside the grace or out of a suspect state; attached: a fresh connection whose core
// attach is ready and whose chats rejoined or restored. restarted: a new core epoch, the daemon's own restart or its core's.
export interface ConnectionGain {
  readonly authorityKey: string;
  readonly how: 'resumed' | 'attached';
  readonly restarted?: 'server' | 'engine';
}

export type ReconnectEvent =
  | { readonly kind: 'suspect'; readonly authorityKey: string }
  | { readonly kind: 'lost'; readonly authorityKey: string }
  | { readonly kind: 'wait'; readonly authorityKey: string; readonly retryAt: number }
  | { readonly kind: 'running'; readonly authorityKey: string }
  | { readonly kind: 'signIn'; readonly authorityKey: string }
  | { readonly kind: 'permanent'; readonly authorityKey: string; readonly code: PermanentFailureCode; readonly dropped: boolean }
  | { readonly kind: 'gain'; readonly gain: ConnectionGain }
  // the loop stopped without a connection: no open views, the user cancelled or disconnected
  | { readonly kind: 'idle'; readonly authorityKey: string };

const PREREQUISITES: ReadonlySet<string> = new Set(['unsupportedOs', 'glibcTooOld', 'glibcxxMissing', 'kernelTooOld', 'macosTooOld', 'windowsBuildTooOld', 'nixLdMissing', 'noexec', 'lowSpace', 'installFolderInvalid', 'installFolderUnsafe']);
const INSTALL: ReadonlySet<string> = new Set(['hashMismatch', 'downloadAndUploadFailed', 'selfTestFailed']);
// a refusal no retry changes without the user: the server refused every key, or strict checking refused an unknown host key
const AUTH: ReadonlySet<string> = new Set(['permissionDenied', 'hostKeyRefused']);

/** The permanent failure a connect failure is, or undefined when the next attempt may succeed. */
export function permanentFailureOf(failure: ConnectFailure): PermanentFailureCode | undefined {
  if (failure.code === 'hostKeyChanged') return 'hostKeyChanged';
  if (failure.code === 'destinationRefused') return 'destination';
  if (PREREQUISITES.has(failure.code)) return 'prerequisites';
  if (INSTALL.has(failure.code)) return 'install';
  if (AUTH.has(failure.code)) return 'authFailed';
  return undefined;
}

/** The wait before attempt `index` (0 is the first after a drop). */
export function backoffMs(index: number): number {
  return (RECONNECT_BACKOFF_S[index] ?? RECONNECT_REPEAT_S) * 1000;
}

// One attempt of the loop. joined: an attempt the loop did not start was running, which the loop awaits and never times out
// or aborts.
export interface LoopAttempt {
  readonly joined: boolean;
  readonly outcome: Promise<void>;
}

// What the loop reads of a connection; Authorities' RemoteConnection matches it.
export interface HeldConnection {
  lost(): boolean;
  suspectSince(): number | undefined;
}

export interface ReconnectorDeps {
  // the authority is another owner's (the update flow follows a daemon of another protocol there): no loop runs for it
  readonly handedOff: (authorityKey: string) => boolean;
  // Authorities' coarse state: failed after a drop or a failed attempt, connecting while any attempt runs, offline otherwise
  readonly state: (authorityKey: string) => ProjectConnection;
  // the connection usable for new work: neither suspect nor lost
  readonly usable: (authorityKey: string) => boolean;
  // the connection usable or held for a resume
  readonly held: (authorityKey: string) => HeldConnection | undefined;
  readonly hostExists: (authorityKey: string) => boolean;
  // editor tabs of its files, its terminals, its chats, or the selected project's authority
  readonly hasOpenViews: (authorityKey: string) => boolean;
  // one attempt, unwatched: its outcome resolves once connected, rejects with the attempt's error; signal aborts an attempt
  // the loop started. force (Reconnect now) gives up a suspect connection's transport, which any other connect joins.
  readonly attempt: (authorityKey: string, signal: AbortSignal, force: boolean) => LoopAttempt;
  // the attempt in flight runs stage 1 on the target (checking, installing, starting)
  readonly staging: (authorityKey: string) => boolean;
  // a user watches the attempt in flight in the Connect dialog
  readonly watched: (authorityKey: string) => boolean;
  readonly failureOf: (err: unknown) => ConnectFailure;
  // the failure of the authority's last attempt made outside the loop (a launch connect, a selection)
  readonly lastFailure: (authorityKey: string) => ConnectFailure | undefined;
  // the attempt waits on a prompt nobody watches
  readonly signInNeeded: (authorityKey: string) => boolean;
  // after a resume from sleep or a network change: ssh -O exit on Damocles' master, whose connection may be dead
  readonly endMaster: (authorityKey: string) => Promise<void>;
  // Electron's net.online: false means no network at all
  readonly online: () => boolean;
  readonly log: (line: string) => void;
}

interface Unhealthy {
  readonly since: number;
  // the connection held when it turned unhealthy; usable again as the same one is a resume
  readonly connection: HeldConnection | undefined;
  // a connection of this run dropped, as opposed to an attempt that never connected
  readonly dropped: boolean;
  phase: ReconnectPhase['phase'];
  index: number;
  retryAt?: number;
  code?: PermanentFailureCode;
  timer?: NodeJS.Timeout | undefined;
  attempt?: LoopRun | undefined;
}

interface LoopRun {
  readonly controller: AbortController;
  timeout: NodeJS.Timeout | undefined;
  timedOut: boolean;
  // ATTEMPT_TIMEOUT_MS applies: the loop started it, nobody watches it and stage 1 has not started on the target
  bounded: boolean;
}

export class Reconnector {
  private readonly deps: ReconnectorDeps;
  private readonly records = new Map<string, Unhealthy>();
  // the connection each authority last had usable this run
  private readonly lastUsable = new Map<string, HeldConnection>();
  // a wake ends Damocles' master before the authority's next attempt
  private readonly endMasterFirst = new Set<string>();
  private readonly listeners = new Set<(event: ReconnectEvent) => void>();
  private disposed = false;
  private network: { timer: NodeJS.Timeout; online: boolean } | undefined;

  constructor(deps: ReconnectorDeps) {
    this.deps = deps;
  }

  /** undefined while usable, before any trouble, and after a user Disconnect or the loop stopped. */
  phase(authorityKey: string): ReconnectPhase | undefined {
    const record = this.records.get(authorityKey);
    if (!record) return undefined;
    const { since } = record;
    switch (record.phase) {
      case 'waiting':
        return { phase: 'waiting', since, retryAt: record.retryAt! };
      case 'failed':
        return { phase: 'failed', since, code: record.code! };
      default:
        return { phase: record.phase, since };
    }
  }

  onEvent(listener: (event: ReconnectEvent) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => { this.listeners.delete(listener); } };
  }

  /** Authorities' state or connection moved. */
  stateChanged(authorityKey: string): void {
    if (this.disposed) return;
    const held = this.deps.held(authorityKey);
    let record = this.records.get(authorityKey);
    if (this.deps.usable(authorityKey)) {
      this.lastUsable.set(authorityKey, held!);
      if (!record) return;
      // the attempt in flight is the one that just connected: aborting it would kill its transport
      this.stop(record, false);
      this.records.delete(authorityKey);
      // a fresh connection's gain waits for its attach and its chats (attached)
      if (record.connection !== undefined && record.connection === held) this.emit({ kind: 'gain', gain: { authorityKey, how: 'resumed' } });
      else this.emit({ kind: 'idle', authorityKey });
      return;
    }
    // offline: the user disconnected it, or it never connected; handed off: the update flow connects it once the old daemon is gone
    if (this.deps.state(authorityKey) === 'offline' || this.deps.handedOff(authorityKey)) {
      if (record) this.idle(authorityKey, record);
      return;
    }
    const looping = record !== undefined && record.phase !== 'suspect';
    const suspect = held && !held.lost() ? held.suspectSince() : undefined;
    if (suspect !== undefined && !looping) {
      if (record) return;
      this.records.set(authorityKey, this.unhealthy(suspect, held, true, 'suspect'));
      this.emit({ kind: 'suspect', authorityKey });
      return;
    }
    if (looping || this.deps.state(authorityKey) !== 'failed') return;
    if (!this.deps.hasOpenViews(authorityKey)) {
      if (record) this.idle(authorityKey, record);
      return;
    }
    const dropped = this.lastUsable.has(authorityKey);
    record = this.unhealthy(record?.since ?? Date.now(), record?.connection ?? held, dropped, 'waiting');
    this.records.set(authorityKey, record);
    this.emit({ kind: 'lost', authorityKey });
    // an attempt outside the loop just failed, so the first wait is the second step's; its failure arrives in attemptChanged
    record.index = dropped ? 0 : 1;
    this.schedule(authorityKey, record);
  }

  /**
   * The attempt in flight changed: a prompt now waits behind the sign-in banner, or was answered. An attempt outside the loop
   * that failed reports its failure here, after the state: a cancel ends the loop and a permanent failure stops it.
   */
  attemptChanged(authorityKey: string): void {
    const record = this.records.get(authorityKey);
    if (record && !record.attempt && !record.dropped && record.phase === 'waiting') {
      const failure = this.deps.lastFailure(authorityKey);
      const permanent = failure && permanentFailureOf(failure);
      if (failure?.code === 'cancelled') this.idle(authorityKey, record);
      else if (permanent) {
        this.stop(record);
        this.fail(authorityKey, record, permanent);
      }
      return;
    }
    const attempt = record?.attempt;
    if (!record || !attempt) return;
    // stage 1's silent steps (the install lock, unpacking, the self-test) outlast any fixed bound: its own limits and ssh's
    // keepalive end it from here, as the user's Cancel ends an attempt they watch
    if (attempt.bounded && (this.deps.staging(authorityKey) || this.deps.watched(authorityKey))) {
      attempt.bounded = false;
      clearTimeout(attempt.timeout);
      attempt.timeout = undefined;
    }
    const waiting = this.deps.signInNeeded(authorityKey);
    if (waiting && record.phase === 'running') {
      clearTimeout(attempt.timeout);
      attempt.timeout = undefined;
      record.phase = 'signIn';
      this.emit({ kind: 'signIn', authorityKey });
    } else if (!waiting && record.phase === 'signIn') {
      record.phase = 'running';
      if (attempt.bounded) attempt.timeout = this.attemptTimeout(attempt);
      this.emit({ kind: 'running', authorityKey });
    }
  }

  /** A fresh connection's core attach is ready and its chats rejoined or restored. */
  attached(gain: ConnectionGain): void {
    if (this.disposed) return;
    this.emit({ kind: 'gain', gain });
  }

  /** Reconnect now and Retry: an attempt at once, the backoff from its start; a permanent failure is tried again. */
  reconnectNow(authorityKey: string): void {
    if (this.disposed || this.deps.usable(authorityKey)) return;
    let record = this.records.get(authorityKey);
    if (record?.attempt) return;
    if (!record || record.phase === 'suspect') {
      const held = this.deps.held(authorityKey);
      record = this.unhealthy(record?.since ?? Date.now(), record?.connection ?? held, held !== undefined, 'waiting');
      this.records.set(authorityKey, record);
    }
    this.stop(record);
    record.index = 0;
    this.run(authorityKey, record, true);
  }

  /** The user disconnected the authority: no loop until the next connect. */
  disconnected(authorityKey: string): void {
    const record = this.records.get(authorityKey);
    this.lastUsable.delete(authorityKey);
    if (record) this.idle(authorityKey, record);
  }

  /** A resume from sleep or the network coming back: every waiting loop attempts at once, Damocles' master ended first. */
  wake(why: string): void {
    if (this.disposed) return;
    for (const key of new Set([...this.lastUsable.keys(), ...this.records.keys()])) this.endMasterFirst.add(key);
    for (const [key, record] of this.records) {
      if (record.phase !== 'waiting') continue;
      this.deps.log(`[remote] ${key}: ${why}; attempting at once`);
      this.stop(record);
      this.run(key, record);
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.network?.timer);
    this.network = undefined;
    for (const record of this.records.values()) this.stop(record);
    this.records.clear();
    this.listeners.clear();
  }

  private unhealthy(since: number, connection: HeldConnection | undefined, dropped: boolean, phase: ReconnectPhase['phase']): Unhealthy {
    return { since, connection, dropped, phase, index: 0 };
  }

  // The network coming back wakes the waiting loops; sampled only while one waits.
  private sampleNetwork(): void {
    const waiting = [...this.records.values()].some((record) => record.phase === 'waiting');
    if (!waiting || this.disposed) {
      clearInterval(this.network?.timer);
      this.network = undefined;
      return;
    }
    if (this.network) return;
    const network = {
      online: this.deps.online(),
      timer: setInterval(() => {
        const online = this.deps.online();
        const cameBack = online && !network.online;
        network.online = online;
        if (cameBack) this.wake('the network came back');
      }, NETWORK_SAMPLE_MS),
    };
    this.network = network;
  }

  private emit(event: ReconnectEvent): void {
    this.sampleNetwork();
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (err) {
        this.deps.log(`[remote] a reconnect listener threw: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      }
    }
  }

  private stop(record: Unhealthy, abort = true): void {
    clearTimeout(record.timer);
    record.timer = undefined;
    if (record.attempt) {
      clearTimeout(record.attempt.timeout);
      if (abort) record.attempt.controller.abort();
      record.attempt = undefined;
    }
  }

  private idle(authorityKey: string, record: Unhealthy): void {
    this.stop(record);
    this.records.delete(authorityKey);
    this.emit({ kind: 'idle', authorityKey });
  }

  private fail(authorityKey: string, record: Unhealthy, code: PermanentFailureCode): void {
    record.phase = 'failed';
    record.code = code;
    this.deps.log(`[remote] ${authorityKey}: a permanent failure (${code}); no more attempts until Retry`);
    this.emit({ kind: 'permanent', authorityKey, code, dropped: record.dropped });
  }

  private schedule(authorityKey: string, record: Unhealthy): void {
    const wait = backoffMs(record.index);
    record.phase = 'waiting';
    record.retryAt = Date.now() + wait;
    record.timer = setTimeout(() => {
      record.timer = undefined;
      this.run(authorityKey, record);
    }, wait);
    this.emit({ kind: 'wait', authorityKey, retryAt: record.retryAt });
  }

  private attemptTimeout(attempt: LoopRun): NodeJS.Timeout {
    return setTimeout(() => {
      attempt.timedOut = true;
      attempt.controller.abort();
    }, ATTEMPT_TIMEOUT_MS);
  }

  // A start the transport refuses (a removal stage runs, the app quits) fails as the attempt would.
  private startAttempt(authorityKey: string, attempt: LoopRun, force: boolean): LoopAttempt {
    try {
      return this.deps.attempt(authorityKey, attempt.controller.signal, force);
    } catch (err) {
      return { joined: false, outcome: Promise.reject(err) };
    }
  }

  private run(authorityKey: string, record: Unhealthy, force = false): void {
    if (this.records.get(authorityKey) !== record || this.disposed) return;
    if (!this.deps.hostExists(authorityKey)) {
      this.fail(authorityKey, record, 'hostRemoved');
      return;
    }
    if (!this.deps.hasOpenViews(authorityKey)) {
      this.idle(authorityKey, record);
      return;
    }
    record.phase = 'running';
    const attempt: LoopRun = { controller: new AbortController(), timeout: undefined, timedOut: false, bounded: true };
    record.attempt = attempt;
    this.emit({ kind: 'running', authorityKey });
    const ended = this.endMasterFirst.delete(authorityKey) ? this.deps.endMaster(authorityKey) : Promise.resolve();
    void ended.then(() => {
      if (record.attempt !== attempt || attempt.controller.signal.aborted) return;
      const started = this.startAttempt(authorityKey, attempt, force);
      if (started.joined) {
        attempt.bounded = false;
        this.deps.log(`[remote] ${authorityKey}: an attempt is already running; the loop waits for its outcome`);
      } else {
        attempt.timeout = this.attemptTimeout(attempt);
      }
      // a prompt may already wait
      this.attemptChanged(authorityKey);
      started.outcome.then(() => {
        if (record.attempt !== attempt) return;
        clearTimeout(attempt.timeout);
        record.attempt = undefined;
        // connected, then suspect or lost before the loop saw it usable: the next step attempts again
        if (!this.deps.usable(authorityKey)) {
          this.deps.log(`[remote] ${authorityKey}: attempt ${record.index + 1} connected, but the connection is not usable`);
          record.index++;
          this.schedule(authorityKey, record);
          return;
        }
        // the usable connection reaches stateChanged, which ends the record
        this.stateChanged(authorityKey);
      }, (err: unknown) => {
        if (record.attempt !== attempt) return;
        clearTimeout(attempt.timeout);
        record.attempt = undefined;
        const failure = this.deps.failureOf(err);
        if (failure.code === 'cancelled' && !attempt.timedOut) {
          this.deps.log(`[remote] ${authorityKey}: the attempt was cancelled; reconnecting stops`);
          this.idle(authorityKey, record);
          return;
        }
        // a daemon of another protocol answered: the update flow holds it and connects once it is gone
        if (this.deps.handedOff(authorityKey)) {
          this.deps.log(`[remote] ${authorityKey}: a daemon of another protocol answered; the update flow follows it`);
          this.idle(authorityKey, record);
          return;
        }
        const permanent = permanentFailureOf(failure);
        if (permanent) {
          this.fail(authorityKey, record, permanent);
          return;
        }
        this.deps.log(`[remote] ${authorityKey}: attempt ${record.index + 1} failed (${attempt.timedOut ? 'timed out' : failure.code})`);
        record.index++;
        this.schedule(authorityKey, record);
      });
    }, (err: unknown) => {
      this.deps.log(`[remote] ${authorityKey}: ending the master connection failed: ${err instanceof Error ? err.message : String(err)}`);
      if (record.attempt !== attempt) return;
      record.attempt = undefined;
      record.index++;
      this.schedule(authorityKey, record);
    });
  }
}
