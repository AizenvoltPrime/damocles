import { parseDiffStats } from './diff-parser';
import type { RepoManager } from './repo-manager';
import type { CheckpointEntry, CheckpointExcludeSet, FileChange } from './types';

export interface AutoCheckpointProducerOptions {
  repo: RepoManager;
  exclude: readonly string[] | CheckpointExcludeSet;
  createTurnId: () => string;
  now: () => Date;
}

export interface AutoCheckpointTurnStartInput {
  userEntryId: string;
  prompt: string;
}

export interface AutoCheckpointTurnEndInput {
  userEntryId: string;
  prompt: string;
}

export type AutoCheckpointStartResult =
  | { ok: true; entries: readonly CheckpointEntry[] }
  | { ok: false; message: string };

export type AutoCheckpointEndResult = { ok: true } | { ok: false };

export type AutoCheckpointFinalizeResult = { ok: true; entry: CheckpointEntry } | { ok: false };

/** In-flight turn awaiting finalization: its pre-turn commit plus the metadata we'll persist. */
interface PendingTurn {
  turnId: string;
  userEntryId: string;
  prompt: string;
  beforeCommit: string;
}

/**
 * Drives the per-turn checkpoint lifecycle for a single session. The pi turn loop calls `turnStart`
 * on every assistant `message_start` (deduped by user entry id), `turnEnd` after each sub-turn to
 * keep the prompt current, and `finalizeRun` once the agent loop ends. Exactly one checkpoint pair
 * (before/after) is produced per user entry; an abandoned turn (new user entry arriving before the
 * previous finalized) is finalized eagerly so no snapshot is lost.
 */
export class AutoCheckpointProducer {
  private readonly repo: RepoManager;
  private readonly exclude: readonly string[] | CheckpointExcludeSet;
  private readonly createTurnId: () => string;
  private readonly now: () => Date;
  private pending: PendingTurn | null = null;

  constructor(options: AutoCheckpointProducerOptions) {
    this.repo = options.repo;
    this.exclude = options.exclude;
    this.createTurnId = options.createTurnId;
    this.now = options.now;
  }

  /**
   * Discard any in-flight turn without finalizing it, returning the dropped turn's user entry id (or
   * `null` if none was pending) so the caller can log that its already-taken pre-turn commit was
   * intentionally abandoned and that turn left non-rewindable.
   */
  discardRun(): string | null {
    const droppedUserEntryId = this.pending?.userEntryId ?? null;
    this.pending = null;
    return droppedUserEntryId;
  }

  /**
   * Begin (or no-op for) the turn identified by `input.userEntryId`. If a different turn is still
   * pending, it is finalized first and its entry returned alongside. A start for the same pending
   * turn is a cheap no-op (this fires on every assistant message). Otherwise we lock the repo,
   * ensure it exists, and capture the pre-turn `beforeCommit`.
   */
  async turnStart(input: AutoCheckpointTurnStartInput): Promise<AutoCheckpointStartResult> {
    try {
      const carried: CheckpointEntry[] = [];

      if (this.pending) {
        if (this.pending.userEntryId === input.userEntryId) {
          return { ok: true, entries: [] };
        }
        const finalized = await this.finalizeRun();
        if (finalized.ok) carried.push(finalized.entry);
      }

      const turnId = this.createTurnId();
      const beforeCommit = await this.repo.withLock(async () => {
        await this.repo.ensureReady(this.exclude);
        return this.repo.checkpoint(input.userEntryId);
      });

      this.pending = { turnId, userEntryId: input.userEntryId, prompt: input.prompt, beforeCommit };
      return { ok: true, entries: carried };
    } catch (err) {
      this.pending = null;
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Refresh the stored prompt for the active turn (the final prompt text is only known once the
   * sub-turn ends). Returns whether a matching pending turn existed to update.
   */
  async turnEnd(input: AutoCheckpointTurnEndInput): Promise<AutoCheckpointEndResult> {
    if (this.pending && this.pending.userEntryId === input.userEntryId) {
      this.pending.prompt = input.prompt;
      return { ok: true };
    }
    return { ok: false };
  }

  /**
   * Close out the pending turn: stage the work tree, diff against `beforeCommit`, and — only when
   * something changed — take the `afterCommit` snapshot (otherwise `afterCommit === beforeCommit`).
   * Builds and returns the `CheckpointEntry`. Pending state is always cleared, even on error.
   */
  async finalizeRun(): Promise<AutoCheckpointFinalizeResult> {
    const pending = this.pending;
    if (!pending) return { ok: false };

    try {
      return await this.repo.withLock(async () => {
        await this.repo.stageAll();
        const diff = await this.repo.diffAgainst(pending.beforeCommit);
        const fileChanges: readonly FileChange[] = parseDiffStats(diff);
        const afterCommit =
          fileChanges.length > 0 ? await this.repo.checkpoint(pending.userEntryId) : pending.beforeCommit;

        const entry: CheckpointEntry = {
          v: 2,
          kind: 'checkpoint',
          turnId: pending.turnId,
          userEntryId: pending.userEntryId,
          beforeCommit: pending.beforeCommit,
          afterCommit,
          prompt: pending.prompt,
          fileCount: fileChanges.length,
          fileChanges,
          createdAt: this.now().toISOString(),
        };
        return { ok: true, entry };
      });
    } catch {
      return { ok: false };
    } finally {
      this.pending = null;
    }
  }
}
