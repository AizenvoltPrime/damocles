import { randomBytes } from 'crypto';
import * as fs from 'fs';
import { log } from '../../logger';
import { formatPerfLine } from '../../../shared/perf-line';
import { parseDiffStats } from './diff-parser';
import {
  checkpointRefName,
  folderRepoFor,
  preRewindRefName,
  readSkippedManifest,
  registerSession,
  type FolderRepoHandle,
} from './folder-repo';
import { LockWaitAbortedError } from './lock';
import { RepoManager, type SnapshotResult } from './repo-manager';
import { getGitDir, getIndexPath, getRepoDir } from './resolver';
import type {
  CheckpointEntry,
  CheckpointEntryV3,
  CheckpointRecord,
  FileChange,
  NotRewindableParams,
  NotRewindableReason,
  NotRewindableRecord,
  PreRewindRecord,
  PreRewindTarget,
  RestoreResult,
  Result,
  SafeCheckoutResult,
  SkippedFile,
  SkippedSummary,
} from './types';

export interface AutoCheckpointProducerOptions {
  sessionId: string;
  /** Resolves the conversation's legacy per-session repo for v2 entries. */
  sessionFile: string;
  cwd: string;
  /** Read at every snapshot and restore, so a settings change applies to the next one. */
  maxFileSizeBytes: () => number;
  createTurnId: () => string;
  now: () => Date;
}

export interface AutoCheckpointTurnStartInput {
  userEntryId: string;
  prompt: string;
}

/** `entries` holds the record of a previous turn this start finalized, on success or failure alike. */
export type AutoCheckpointStartResult =
  | { ok: true; entries: CheckpointRecord[] }
  | { ok: false; message: string; entries: CheckpointRecord[] };

export type AutoCheckpointFinalizeResult = { ok: true; record: CheckpointRecord } | { ok: false };

export type AutoCheckpointSnapshotResult = { ok: true; entry: CheckpointEntryV3 } | { ok: false; message: string };

/** `signal` abandons a restore that has not taken the folder lock yet; once it holds the lock the restore runs to completion. */
export interface RestoreOptions {
  signal?: AbortSignal;
}

type BaselineOutcome = { ok: true; commit: string; skipped: SkippedSummary } | { ok: false; error: string };

interface PendingTurn {
  readonly turnId: string;
  readonly userEntryId: string;
  readonly prompt: string;
  baseline: Promise<BaselineOutcome>;
  notRewindable: { reason: NotRewindableReason; params: NotRewindableParams } | null;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Drives one conversation's checkpoints in its folder's shared repo. `turnStart` takes the turn's
 * baseline (the before-state) and resolves once it is on disk; `finalizeRun` takes the after-state and
 * yields the turn's record. Every git step of this producer runs in call order on one queue, and each
 * takes the folder lock, which also orders it against other conversations and processes. No queued
 * step ever awaits a later one, and nothing awaits a baseline while holding the lock.
 *
 * A commit only lives while a ref in `refs/damocles/sessions/<sessionId>/` points at it. After
 * `markNotRewindable` or `dispose`, no ref is written for the turn (and a before-ref already written is
 * deleted at finalize), so a late baseline is never a turn's baseline. A turn this producer finalized
 * never starts again, so its refs are never rewritten.
 */
export class AutoCheckpointProducer {
  private readonly options: AutoCheckpointProducerOptions;
  private readonly folder: FolderRepoHandle;
  private pending: PendingTurn | null = null;
  private readonly finalized = new Set<string>();
  private disposed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: AutoCheckpointProducerOptions) {
    this.options = options;
    this.folder = folderRepoFor(options.cwd);
  }

  /** Queue `fn` behind every earlier git step of this producer; a rejected step never stalls the queue. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    this.tail = run.catch((err: unknown) => log('[Checkpoints] a queued checkpoint step failed: %s', errorText(err)));
    return run;
  }

  /**
   * Start the turn of `input.userEntryId` and resolve when its baseline is taken. A start for the
   * pending turn takes nothing new and resolves with that same baseline. A start for a turn this producer
   * already finalized is refused at once. A different pending turn is finalized first and its record
   * returned in `entries`.
   */
  turnStart(input: AutoCheckpointTurnStartInput): Promise<AutoCheckpointStartResult> {
    if (this.finalized.has(input.userEntryId)) {
      log('[Checkpoints] turnStart(%s) refused: that turn already has its record', input.userEntryId);
      return Promise.resolve({ ok: false, message: 'already-finalized', entries: [] });
    }
    const current = this.pending;
    if (current?.userEntryId === input.userEntryId) {
      return current.baseline.then((o) => (o.ok ? { ok: true, entries: [] } : { ok: false, message: o.error, entries: [] }));
    }
    const carried = current ? this.finalizeTurn(current) : Promise.resolve(null);
    const turn: PendingTurn = {
      turnId: this.options.createTurnId(),
      userEntryId: input.userEntryId,
      prompt: input.prompt,
      notRewindable: null,
      baseline: Promise.resolve({ ok: false, error: 'not started' }),
    };
    turn.baseline = this.enqueue(() => this.takeBaseline(turn));
    this.pending = turn;
    return Promise.all([carried, turn.baseline]).then(([record, outcome]): AutoCheckpointStartResult => {
      const entries = record ? [record] : [];
      return outcome.ok ? { ok: true, entries } : { ok: false, message: outcome.error, entries };
    });
  }

  /**
   * The turn cannot use its baseline: a tool may have run before it was taken. Valid before or after
   * `turnStart` resolves; the first call per turn decides the reason. A call for a turn that is not
   * pending (never started, or already finalized) changes nothing and is logged. Returns whether this
   * call made the turn not rewindable.
   */
  markNotRewindable(userEntryId: string, reason: NotRewindableReason, params: NotRewindableParams): boolean {
    const turn = this.pending;
    if (turn?.userEntryId !== userEntryId) {
      log('[Checkpoints] markNotRewindable(%s) ignored: that turn is not pending', userEntryId);
      return false;
    }
    if (turn.notRewindable) return false;
    turn.notRewindable = { reason, params };
    return true;
  }

  /** Close the pending turn: its v3 entry, or its not-rewindable record. */
  async finalizeRun(): Promise<AutoCheckpointFinalizeResult> {
    const turn = this.pending;
    if (!turn) return { ok: false };
    this.pending = null;
    const record = await this.finalizeTurn(turn);
    return record ? { ok: true, record } : { ok: false };
  }

  /** Under the folder lock: create the repo if needed, then prepare, stage and commit the work tree. */
  private async snapshotLocked(subject: string): Promise<SnapshotResult> {
    const { repo } = this.folder;
    const staticPatterns = await repo.ensureFolderRepo(this.options.cwd);
    const prepared = await repo.prepareSnapshot(staticPatterns, this.options.maxFileSizeBytes());
    return repo.snapshot(subject, prepared);
  }

  /** The ref updates keeping a snapshot alive: its commit under `ref`, and its manifest under `skippedRef`. */
  private static snapshotRefs(snap: SnapshotResult, ref: string, skippedRef: string): Array<{ ref: string; commit: string }> {
    return [{ ref, commit: snap.commit }, ...(snap.skipped.manifest === null ? [] : [{ ref: skippedRef, commit: snap.skipped.manifest }])];
  }

  /** Roll up small packs off the lock and off the queue; the result is only logged. */
  private consolidatePacks(): void {
    void this.folder.repo.consolidatePacksIfCrowded().catch((err: unknown) => log('[Checkpoints] pack roll-up check failed: %s', errorText(err)));
  }

  /** A compaction anchor: one snapshot referenced as `.../<compactionEntryId>/snapshot`. The pending turn is untouched. */
  snapshot(compactionEntryId: string): Promise<AutoCheckpointSnapshotResult> {
    return this.enqueue(async (): Promise<AutoCheckpointSnapshotResult> => {
      if (this.disposed) return { ok: false, message: 'the conversation was closed' };
      try {
        const ref = checkpointRefName(this.options.sessionId, compactionEntryId, 'snapshot');
        const skippedRef = checkpointRefName(this.options.sessionId, compactionEntryId, 'skipped');
        const { repo, repoDir, folderId } = this.folder;
        const result = await repo.withLock(async (): Promise<AutoCheckpointSnapshotResult> => {
          const snap = await this.snapshotLocked(`checkpoint ${this.options.sessionId} ${compactionEntryId} snapshot`);
          if (this.disposed) return { ok: false, message: 'the conversation was closed' };
          await registerSession(repoDir, this.options.sessionId, this.options.sessionFile);
          await repo.updateRefs(AutoCheckpointProducer.snapshotRefs(snap, ref, skippedRef));
          const entry: CheckpointEntryV3 = {
            v: 3,
            kind: 'checkpoint',
            repo: 'folder',
            folderId,
            turnId: `compact-${this.options.createTurnId()}`,
            userEntryId: compactionEntryId,
            beforeCommit: snap.commit,
            afterCommit: snap.commit,
            prompt: '',
            fileCount: 0,
            fileChanges: [],
            skipped: snap.skipped,
            createdAt: this.options.now().toISOString(),
          };
          return { ok: true, entry };
        });
        this.consolidatePacks();
        return result;
      } catch (err) {
        log('[Checkpoints] compaction snapshot %s failed: %s', compactionEntryId, errorText(err));
        return { ok: false, message: errorText(err) };
      }
    });
  }

  /**
   * Restore the work tree to `entry.beforeCommit` from the repo that holds it: a v2 entry's legacy
   * per-session repo, or a v3 entry's folder repo. Files over the cap, ignored, or skipped by the
   * target snapshot are never touched (`RepoManager.safeCheckoutLocked`). The current state is
   * snapshotted first (`PreRewindRecord`), and nothing is restored when that fails.
   */
  restore(entry: CheckpointEntry, options?: RestoreOptions): Promise<RestoreResult> {
    return this.restoreTo(entry.v === 3 ? { repo: 'folder', folderId: entry.folderId } : { repo: 'legacy' }, entry.beforeCommit, { kind: 'turn', userEntryId: entry.userEntryId }, options?.signal);
  }

  /** Undo a rewind: restore `record`'s snapshot through the same protections, snapshotting the current state first. */
  restorePreRewind(record: PreRewindRecord, options?: RestoreOptions): Promise<RestoreResult> {
    return this.restoreTo({ repo: 'folder', folderId: record.folderId }, record.commit, { kind: 'undo', preRewindId: record.id }, options?.signal);
  }

  /** The full skipped list of `source`, read without the folder lock. */
  readSkippedManifest(source: CheckpointEntryV3 | PreRewindRecord): Promise<Result<SkippedFile[]>> {
    return readSkippedManifest(source, this.options.cwd);
  }

  /**
   * Queued after every earlier step; `signal` is honoured while waiting in the queue and for the folder
   * lock. A v3 target is snapshotted and restored in one lock hold; a v2 target's legacy repo has its
   * own lock, taken after the folder lock is released, since no code nests two locks.
   */
  private restoreTo(source: { repo: 'folder'; folderId: string } | { repo: 'legacy' }, targetCommit: string, target: PreRewindTarget, signal?: AbortSignal): Promise<RestoreResult> {
    const aborted: RestoreResult = { ok: false, reason: 'aborted', preRewind: null };
    if (signal?.aborted) return Promise.resolve(aborted);
    let started = false;
    const queued = this.enqueue(async (): Promise<RestoreResult> => {
      if (signal?.aborted) return aborted;
      started = true;
      const cap = this.options.maxFileSizeBytes();
      const { repo, folderId } = this.folder;
      let legacy: RepoManager | null = null;
      if (source.repo === 'folder') {
        if (source.folderId !== folderId) {
          return { ok: false, reason: 'unavailable', error: `the checkpoint belongs to folder repo ${source.folderId}, not to ${this.options.cwd}`, preRewind: null };
        }
        if (!fs.existsSync(getGitDir(this.folder.repoDir))) {
          return { ok: false, reason: 'unavailable', error: `the folder checkpoint repo is gone (${this.folder.repoDir})`, preRewind: null };
        }
      } else {
        const repoDir = getRepoDir(this.options.sessionFile);
        if (!fs.existsSync(getGitDir(repoDir))) {
          return { ok: false, reason: 'unavailable', error: `the checkpoint repo of this conversation is gone (${repoDir})`, preRewind: null };
        }
        legacy = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), this.options.cwd);
      }
      type Held = { refused: RestoreResult } | { preRewind: PreRewindRecord; checkout: SafeCheckoutResult | null };
      let held: Held;
      try {
        held = await repo.withLock(async (): Promise<Held> => {
          if (source.repo === 'folder') {
            const mismatch = await repo.folderMismatch(this.options.cwd);
            if (mismatch !== null) return { refused: { ok: false, reason: 'unavailable', error: mismatch, preRewind: null } };
          }
          let preRewind: PreRewindRecord;
          try {
            preRewind = await this.takePreRewindLocked(target);
          } catch (err) {
            log('[Checkpoints] pre-rewind snapshot failed, so nothing is restored: %s', errorText(err));
            return { refused: { ok: false, reason: 'snapshot-failed', error: errorText(err), preRewind: null } };
          }
          const checkout = source.repo === 'folder' ? await repo.safeCheckoutLocked(targetCommit, { maxFileSizeBytes: cap }) : null;
          return { preRewind, checkout };
        }, signal ? { signal } : undefined);
      } catch (err) {
        if (err instanceof LockWaitAbortedError) return aborted;
        return { ok: false, reason: 'snapshot-failed', error: errorText(err), preRewind: null };
      }
      if ('refused' in held) return held.refused;
      this.consolidatePacks();
      const { preRewind } = held;
      const result: SafeCheckoutResult =
        held.checkout ??
        (await legacy!.safeCheckout(targetCommit, { maxFileSizeBytes: cap }).catch((err: unknown): SafeCheckoutResult => ({ ok: false, reason: 'checkout-failed', error: errorText(err) })));
      if (result.ok) return { ok: true, preRewind };
      if (result.rollbackError !== undefined) {
        log('[Checkpoints] restore and its rollback both failed; the pre-rewind state is kept as %s: %s / %s', preRewind.commit, result.error, result.rollbackError);
      }
      return { ...result, preRewind };
    });
    if (!signal) return queued;
    // Only the wait in this producer's queue ends here; the lock wait ends inside `withLock`.
    return new Promise<RestoreResult>((resolve, reject) => {
      const onAbort = (): void => {
        if (!started) resolve(aborted);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      queued.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
  }

  /** Under the folder lock: snapshot the work tree and ref it in this conversation's pre-rewind namespace. */
  private async takePreRewindLocked(target: PreRewindTarget): Promise<PreRewindRecord> {
    const now = this.options.now();
    const id = `${now.getTime()}-${randomBytes(4).toString('hex')}`;
    const snap = await this.snapshotLocked(`pre-rewind ${this.options.sessionId} ${id}`);
    await registerSession(this.folder.repoDir, this.options.sessionId, this.options.sessionFile);
    await this.folder.repo.updateRefs(
      AutoCheckpointProducer.snapshotRefs(snap, preRewindRefName(this.options.sessionId, id, 'snapshot'), preRewindRefName(this.options.sessionId, id, 'skipped')),
    );
    log('[Checkpoints] pre-rewind snapshot %s of session %s is commit %s', id, this.options.sessionId, snap.commit);
    return { v: 3, kind: 'pre-rewind', id, folderId: this.folder.folderId, commit: snap.commit, skipped: snap.skipped, target, createdAt: now.toISOString() };
  }

  /**
   * Drop the pending turn and stop writing refs for good; returns the dropped user entry id. Must run
   * before a conversation's refs are deleted, so none is written after.
   */
  dispose(): string | null {
    this.disposed = true;
    const dropped = this.pending?.userEntryId ?? null;
    this.pending = null;
    return dropped;
  }

  private async takeBaseline(turn: PendingTurn): Promise<BaselineOutcome> {
    const started = Date.now();
    if (this.disposed) return { ok: false, error: 'the conversation was closed before its baseline' };
    try {
      const ref = checkpointRefName(this.options.sessionId, turn.userEntryId, 'before');
      const skippedRef = checkpointRefName(this.options.sessionId, turn.userEntryId, 'skipped');
      const { repo, repoDir } = this.folder;
      const outcome = await repo.withLock(async (): Promise<BaselineOutcome> => {
        const lockWaitMs = Date.now() - started;
        const snap = await this.snapshotLocked(`checkpoint ${this.options.sessionId} ${turn.userEntryId} before`);
        // Decided under the lock, so a turn marked before this point never gets a ref at all.
        if (turn.notRewindable === null && !this.disposed) {
          await registerSession(repoDir, this.options.sessionId, this.options.sessionFile);
          await repo.updateRefs(AutoCheckpointProducer.snapshotRefs(snap, ref, skippedRef));
        }
        log(formatPerfLine('checkpoint.baseline', Date.now() - started, { files: snap.files, skipped: snap.skipped.totalCount, lockWaitMs }));
        return { ok: true, commit: snap.commit, skipped: snap.skipped };
      });
      this.consolidatePacks();
      return outcome;
    } catch (err) {
      log('[Checkpoints] baseline for user entry %s failed: %s', turn.userEntryId, errorText(err));
      return { ok: false, error: errorText(err) };
    }
  }

  private finalizeTurn(turn: PendingTurn): Promise<CheckpointRecord | null> {
    this.finalized.add(turn.userEntryId);
    return this.enqueue(async (): Promise<CheckpointRecord | null> => {
      const outcome = await turn.baseline;
      const createdAt = this.options.now().toISOString();
      if (turn.notRewindable || !outcome.ok) {
        const { reason, params } = turn.notRewindable ?? { reason: 'baseline-failed' as const, params: outcome.ok ? {} : { error: outcome.error } };
        if (outcome.ok) await this.dropBeforeRef(turn);
        const record: NotRewindableRecord = { v: 3, kind: 'not-rewindable', userEntryId: turn.userEntryId, reason, params, createdAt };
        return this.disposed ? null : record;
      }
      if (this.disposed) return null;
      return this.takeAfterState(turn, outcome.commit, outcome.skipped, createdAt);
    });
  }

  private async dropBeforeRef(turn: PendingTurn): Promise<void> {
    try {
      const refs = [checkpointRefName(this.options.sessionId, turn.userEntryId, 'before'), checkpointRefName(this.options.sessionId, turn.userEntryId, 'skipped')];
      await this.folder.repo.withLock(async () => {
        const present = new Set((await this.folder.repo.listRefs(`refs/damocles/sessions/${this.options.sessionId}/${turn.userEntryId}/`)).map((r) => r.ref));
        await this.folder.repo.deleteRefs(refs.filter((r) => present.has(r)));
      });
    } catch (err) {
      log('[Checkpoints] dropping the baseline refs of not-rewindable turn %s failed: %s', turn.userEntryId, errorText(err));
    }
  }

  /**
   * Stage the after-state and diff it against the baseline; commit it only when something changed. A
   * file that grew past the cap is a skip, not a deletion, so it is left out of the change list. If
   * that fails the turn keeps its baseline, which is all a rewind needs, with an empty change list.
   */
  private async takeAfterState(turn: PendingTurn, beforeCommit: string, skipped: SkippedSummary, createdAt: string): Promise<CheckpointEntryV3 | null> {
    const entryFor = (afterCommit: string, fileChanges: readonly FileChange[]): CheckpointEntryV3 => ({
      v: 3,
      kind: 'checkpoint',
      repo: 'folder',
      folderId: this.folder.folderId,
      turnId: turn.turnId,
      userEntryId: turn.userEntryId,
      beforeCommit,
      afterCommit,
      prompt: turn.prompt,
      fileCount: fileChanges.length,
      fileChanges,
      skipped,
      createdAt,
    });
    const { repo } = this.folder;
    try {
      const entry = await repo.withLock(async () => {
        const staticPatterns = await repo.ensureFolderRepo(this.options.cwd);
        const prepared = await repo.prepareSnapshot(staticPatterns, this.options.maxFileSizeBytes());
        const staged = await repo.stage(prepared);
        const grown = RepoManager.sizeSkipped(prepared, staged);
        const fileChanges = parseDiffStats(await repo.diffAgainst(beforeCommit)).filter((c) => !grown.has(c.path));
        if (fileChanges.length === 0) return entryFor(beforeCommit, fileChanges);
        const afterCommit = await repo.commitIndex(`checkpoint ${this.options.sessionId} ${turn.userEntryId} after`, prepared, staged, beforeCommit);
        if (this.disposed) return null;
        await repo.updateRefs([{ ref: checkpointRefName(this.options.sessionId, turn.userEntryId, 'after'), commit: afterCommit }]);
        return entryFor(afterCommit, fileChanges);
      });
      this.consolidatePacks();
      return entry;
    } catch (err) {
      log('[Checkpoints] after-state of user entry %s failed, keeping its baseline only: %s', turn.userEntryId, errorText(err));
      return this.disposed ? null : entryFor(beforeCommit, []);
    }
  }
}
