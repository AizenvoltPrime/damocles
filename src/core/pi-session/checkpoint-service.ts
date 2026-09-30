import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';
import { perfSpan } from '../perf';
import type { SettingsStore } from '../../platform/settings-store';
import {
  AutoCheckpointProducer,
  getCheckpointEntries,
  getNotRewindableEntries,
  checkpointGitAvailability,
  type AutoCheckpointProducerOptions,
  type CheckpointEntry,
  type NotRewindableParams,
  type PreRewindRecord,
  type RestoreResult,
  type StoredCheckpointRecord,
} from './checkpoints';

/** The slice of pi's `SessionManager` the checkpoint engine reads (live or via the extension ctx). */
export interface CheckpointTreeReader {
  getBranch(fromId?: string): SessionEntry[];
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getEntries(): SessionEntry[];
}

/** The producer calls the service makes; `AutoCheckpointProducer` in production. */
export type CheckpointProducer = Pick<AutoCheckpointProducer, 'turnStart' | 'markNotRewindable' | 'finalizeRun' | 'snapshot' | 'restore' | 'restorePreRewind' | 'dispose'>;

/**
 * A restore as the user sees it: the producer's result, or why no restore ran. `service-unavailable`
 * means this session has no live checkpoint service (disposed by a switch, or no session file yet);
 * `git-unavailable` means the git probe failed; `failed` is a restore that threw.
 */
export type ServiceRestoreResult =
  | RestoreResult
  | { ok: false; reason: 'service-unavailable'; preRewind: null }
  | { ok: false; reason: 'git-unavailable'; error: string; preRewind: null }
  | { ok: false; reason: 'failed'; error: string; preRewind: null };

/** How long a user's rewind or undo waits for earlier checkpoint work in the folder before it gives up untouched. */
export const RESTORE_WAIT_MS = 30_000;

/** What the service needs from the owning `PiSession`. */
export interface CheckpointHost {
  cwd: string;
  sessionId: string;
  /** A turn's checkpoint became available (just finalized, or pre-existing on resume). Idempotent. */
  onCheckpointReady(userEntryId: string): void;
  /** Append a record minted off the pi handler path. False when the session is no longer live in this panel. */
  persist(record: StoredCheckpointRecord): boolean;
  /** The one notice a turn gets when a file-changing tool stopped waiting for its baseline. */
  onBaselineTimeout(waitedMs: number): void;
  /** `damocles.checkpoints.baselineWaitSeconds` in ms, read at each wait. */
  baselineWaitMs(): number;
  /** `damocles.checkpoints.maxFileSizeMB` in bytes, read at each snapshot. */
  maxFileSizeBytes(): number;
  createProducer?: (options: AutoCheckpointProducerOptions) => CheckpointProducer;
}

/** A numeric checkpoint setting held to the range its `package.json` entry declares; a non-number reads as its default. */
export function clampSetting(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** `damocles.checkpoints.baselineWaitSeconds` in ms; bounds equal the `package.json` entry. */
export function checkpointBaselineWaitMs(settings: Pick<SettingsStore, 'get'>): number {
  return clampSetting(settings.get<number>('damocles.checkpoints.baselineWaitSeconds', 30), 5, 600, 30) * 1000;
}

/** `damocles.checkpoints.maxFileSizeMB` in bytes; bounds equal the `package.json` entry. */
export function checkpointMaxFileSizeBytes(settings: Pick<SettingsStore, 'get'>): number {
  return clampSetting(settings.get<number>('damocles.checkpoints.maxFileSizeMB', 25), 1, 2048, 25) * 1024 * 1024;
}

interface PiMessage {
  role?: string;
  content?: unknown;
}

function piMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => !!b && (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join(' ');
}

/** The last user-role message entry on the active branch — the entry that started the current turn. */
function findLastUserEntry(sm: CheckpointTreeReader): { id: string; prompt: string } | null {
  const branch = sm.getBranch(sm.getLeafId() ?? undefined);
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i];
    if (entry && entry.type === 'message' && (entry as { message?: PiMessage }).message?.role === 'user') {
      return { id: entry.id, prompt: piMessageText((entry as { message?: PiMessage }).message?.content).slice(0, 500) };
    }
  }
  return null;
}

/** The turn whose baseline file-changing tools wait for. */
interface CurrentTurn {
  userEntryId: string;
  /** Resolves when the baseline is on disk, failed, or git is unavailable. Never rejects. */
  baseline: Promise<void>;
  baselineDone: boolean;
  /** The producer has been handed this turn, so `markNotRewindable` can name it. */
  started: boolean;
  /** A tool stopped waiting: the turn is not rewindable and nothing waits for it again. */
  timedOut: boolean;
  timeoutParams: NotRewindableParams;
}

type WaitOutcome = 'ready' | 'timeout' | 'aborted' | 'disposed';

/**
 * Per-session driver of the checkpoint producer. No pi handler awaits it: every lifecycle call starts
 * work on one ordered chain and returns, records reach the session through `host.persist` when the work
 * finishes, and file-changing tools wait for the current turn's baseline through `awaitBaseline`
 * (docs/invariants.md, "Checkpoints"). Failures are logged and leave the turn without a checkpoint.
 */
export class CheckpointService {
  private readonly host: CheckpointHost;
  private producer: CheckpointProducer | null = null;
  private gitAvailable: boolean | null = null;
  private gitUnavailableReason = '';
  private turnCounter = 0;
  private chain: Promise<void> = Promise.resolve();
  private turn: CurrentTurn | null = null;
  /** Every user entry this service started a turn for or found recorded; a turn is never started twice. */
  private readonly knownTurns = new Set<string>();
  private disposed = false;
  private readonly disposal = new AbortController();

  constructor(host: CheckpointHost) {
    this.host = host;
  }

  get sessionId(): string {
    return this.host.sessionId;
  }

  /** Queue `fn` after every earlier step. The returned promise never rejects. */
  private enqueue(label: string, fn: () => Promise<void>): Promise<void> {
    const next = this.chain.then(fn).catch((err: unknown) => {
      log('[CheckpointService] %s failed, the turn keeps no checkpoint: %O', label, err);
    });
    this.chain = next;
    return next;
  }

  /** Bind the producer lazily, once git is confirmed available and the session file is known. */
  private async ensureProducer(sm: CheckpointTreeReader): Promise<CheckpointProducer | null> {
    if (this.disposed || this.gitAvailable === false) return null;
    if (this.producer) return this.producer;
    const sessionFile = sm.getSessionFile();
    if (!sessionFile) {
      log('[CheckpointService] session %s has no file path yet; no checkpoint for this step', this.host.sessionId);
      return null;
    }
    if (this.gitAvailable === null) {
      const git = await checkpointGitAvailability();
      this.gitAvailable = git.available;
      if (!git.available) {
        this.gitUnavailableReason = git.reason ?? 'unknown';
        log('[CheckpointService] git unavailable, checkpoints disabled for this session: %s', git.reason ?? 'unknown');
        return null;
      }
    }
    if (this.disposed) return null;
    const options: AutoCheckpointProducerOptions = {
      sessionId: this.host.sessionId,
      sessionFile,
      cwd: this.host.cwd,
      maxFileSizeBytes: () => this.host.maxFileSizeBytes(),
      createTurnId: () => `turn-${++this.turnCounter}`,
      now: () => new Date(),
    };
    this.producer = this.host.createProducer ? this.host.createProducer(options) : new AutoCheckpointProducer(options);
    return this.producer;
  }

  /** Hand a finished record to the session, or drop it (logged) once the session is gone from this panel. */
  private deliver(record: StoredCheckpointRecord): void {
    if (this.disposed || !this.host.persist(record)) {
      const subject = record.kind === 'pre-rewind' ? `${record.id} (commit ${record.commit})` : record.userEntryId;
      log('[CheckpointService] dropped the %s record for %s: session %s is no longer live here', record.kind, subject, this.host.sessionId);
      return;
    }
    if (record.kind === 'checkpoint') this.host.onCheckpointReady(record.userEntryId);
  }

  /**
   * Start the baseline for the turn opened by `userEntryId` and return at once. A repeat for a known
   * entry is a no-op, including after a timeout or a finalize, so a turn never gets a second baseline
   * and a gate waiter in a run keyed on a finished turn has nothing to wait for.
   */
  startTurn(sm: CheckpointTreeReader, userEntryId: string, prompt: string): void {
    if (this.disposed || this.knownTurns.has(userEntryId)) return;
    this.knownTurns.add(userEntryId);
    const turn: CurrentTurn = {
      userEntryId,
      baseline: Promise.resolve(),
      baselineDone: false,
      started: false,
      timedOut: false,
      timeoutParams: {},
    };
    this.turn = turn;
    turn.baseline = this.enqueue('baseline', async () => {
      const producer = await this.ensureProducer(sm);
      if (!producer) return;
      const started = producer.turnStart({ userEntryId, prompt: prompt.slice(0, 500) });
      turn.started = true;
      if (turn.timedOut) producer.markNotRewindable(userEntryId, 'baseline-timeout', turn.timeoutParams);
      const result = await started;
      if (!result.ok) log('[CheckpointService] baseline for %s failed: %s', userEntryId, result.message);
      for (const record of result.entries) this.deliver(record);
    }).finally(() => {
      turn.baselineDone = true;
    });
  }

  /** Assistant message_start: start the baseline for the latest user entry (a steered message opens a turn here). */
  onMessageStart(message: PiMessage, sm: CheckpointTreeReader): void {
    if (message.role !== 'assistant') return;
    const leaf = findLastUserEntry(sm);
    if (leaf) this.startTurn(sm, leaf.id, leaf.prompt);
  }

  /** The run settled: finalize its turn after its baseline, in the background. */
  onSettled(): void {
    if (!this.turn) return;
    this.turn = null;
    void this.enqueue('finalize', async () => {
      if (this.disposed || !this.producer) return;
      const result = await this.producer.finalizeRun();
      if (result.ok) this.deliver(result.record);
    });
  }

  /** Compaction completed: snapshot the tree under the compaction entry id so the anchor becomes rewindable. */
  onSessionCompact(compactionEntryId: string, sm: CheckpointTreeReader): void {
    void this.enqueue('compaction snapshot', async () => {
      const producer = await this.ensureProducer(sm);
      if (!producer) return;
      const result = await producer.snapshot(compactionEntryId);
      if (!result.ok) {
        log('[CheckpointService] compaction snapshot for %s failed: %s', compactionEntryId, result.message);
        return;
      }
      this.deliver(result.entry);
    });
  }

  /**
   * The gate's wait: resolve once the current turn's baseline exists. Past `baselineWaitMs` the caller
   * proceeds, the turn is marked not rewindable (its late baseline is never used) and the host posts
   * the turn's one notice. An abort or dispose releases the waiter at once.
   */
  async awaitBaseline(signal: AbortSignal, toolName: string): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.baselineDone || turn.timedOut || this.disposed) return;
    const waitMs = this.host.baselineWaitMs();
    const span = perfSpan('checkpoint.wait');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let onDispose: (() => void) | undefined;
    const outcome = await new Promise<WaitOutcome>((resolve) => {
      if (signal.aborted) return resolve('aborted');
      onAbort = () => resolve('aborted');
      onDispose = () => resolve('disposed');
      signal.addEventListener('abort', onAbort, { once: true });
      this.disposal.signal.addEventListener('abort', onDispose, { once: true });
      timer = setTimeout(() => resolve('timeout'), waitMs);
      void turn.baseline.then(() => resolve('ready'));
    });
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener('abort', onAbort);
    if (onDispose) this.disposal.signal.removeEventListener('abort', onDispose);
    span.end({ outcome, tool: toolName, limitMs: waitMs });
    if (outcome !== 'timeout' || turn.timedOut) return;
    turn.timedOut = true;
    turn.timeoutParams = { tool: toolName, waitSeconds: Math.round(waitMs / 1000) };
    log('[CheckpointService] baseline for %s not ready after %d ms; %s proceeds and the turn is not rewindable', turn.userEntryId, waitMs, toolName);
    // A turn not yet handed to the producer is marked the moment it is (see `startTurn`).
    const marked = !turn.started || (this.producer?.markNotRewindable(turn.userEntryId, 'baseline-timeout', turn.timeoutParams) ?? false);
    if (!marked) {
      log('[CheckpointService] turn %s was no longer pending when its wait ran out; no notice', turn.userEntryId);
      return;
    }
    this.host.onBaselineTimeout(waitMs);
  }

  /** Resolve once every queued step has finished, or after `timeoutMs`, whichever comes first. */
  async drain(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      this.chain.then(() => 'drained' as const),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (outcome === 'timeout') log('[CheckpointService] checkpoint work of session %s still running after %d ms; its records will be dropped', this.host.sessionId, timeoutMs);
  }

  /** Restore the files of `entry`'s before-state, after every queued step. */
  restore(entry: CheckpointEntry, sm: CheckpointTreeReader, signal: AbortSignal): Promise<ServiceRestoreResult> {
    return this.runRestore('restore', sm, signal, (producer) => producer.restore(entry, { signal }));
  }

  /** Put back the files a rewind replaced, from its pre-rewind snapshot, after every queued step. */
  restorePreRewind(record: PreRewindRecord, sm: CheckpointTreeReader, signal: AbortSignal): Promise<ServiceRestoreResult> {
    return this.runRestore('undo rewind', sm, signal, (producer) => producer.restorePreRewind(record, { signal }));
  }

  /**
   * Run a restore on the chain and persist its pre-rewind record. When `signal` fires while the step still
   * waits in the chain, resolve 'aborted' at once and skip the step when it is reached; once the step runs,
   * the producer decides, and it ignores the signal after it holds the folder lock.
   */
  private runRestore(label: string, sm: CheckpointTreeReader, signal: AbortSignal, run: (producer: CheckpointProducer) => Promise<RestoreResult>): Promise<ServiceRestoreResult> {
    if (this.disposed) return Promise.resolve({ ok: false, reason: 'service-unavailable', preRewind: null });
    return new Promise((resolve) => {
      let started = false;
      const onAbort = (): void => {
        if (!started) resolve({ ok: false, reason: 'aborted', preRewind: null });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      let result: ServiceRestoreResult = { ok: false, reason: 'aborted', preRewind: null };
      void this.enqueue(label, async () => {
        if (signal.aborted) return;
        started = true;
        const producer = await this.ensureProducer(sm);
        if (!producer) {
          result = this.gitAvailable === false
            ? { ok: false, reason: 'git-unavailable', error: this.gitUnavailableReason, preRewind: null }
            : { ok: false, reason: 'service-unavailable', preRewind: null };
          return;
        }
        try {
          result = await run(producer);
        } catch (err) {
          log('[CheckpointService] %s threw: %O', label, err);
          result = { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err), preRewind: null };
          return;
        }
        if (result.preRewind) {
          log('[CheckpointService] %s kept the pre-rewind state as %s (commit %s)', label, result.preRewind.id, result.preRewind.commit);
          this.deliver(result.preRewind);
        }
      }).then(() => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      });
    });
  }

  /**
   * Re-surface checkpoints persisted in a resumed/forked session so its turns are immediately rewindable,
   * and never start a turn again for an entry that already has a record.
   */
  hydrate(sm: CheckpointTreeReader): void {
    try {
      const branch = sm.getBranch(sm.getLeafId() ?? undefined);
      for (const record of getNotRewindableEntries(branch)) this.knownTurns.add(record.userEntryId);
      for (const cp of getCheckpointEntries(branch)) {
        this.knownTurns.add(cp.userEntryId);
        this.host.onCheckpointReady(cp.userEntryId);
      }
    } catch (err) {
      log('[CheckpointService] hydrate failed: %O', err);
    }
  }

  /** Stop for good: the producer writes no ref after this, queued records are dropped and waiters released. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const droppedUserEntryId = this.producer?.dispose() ?? null;
    this.disposal.abort();
    this.turn = null;
    if (droppedUserEntryId) {
      log('[CheckpointService] dispose dropped the unfinalized checkpoint for user entry %s', droppedUserEntryId);
    }
  }
}
