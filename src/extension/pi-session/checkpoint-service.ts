import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';
import {
  RepoManager,
  AutoCheckpointProducer,
  getRepoDir,
  getGitDir,
  getIndexPath,
  getCheckpointEntries,
  execSafe,
  CHECKPOINT_EXCLUDE_SET,
  type CheckpointEntry,
} from './checkpoints';

/** The slice of pi's `SessionManager` the checkpoint engine reads (live or via the extension ctx). */
export interface CheckpointTreeReader {
  getBranch(fromId?: string): SessionEntry[];
  getLeafId(): string | null;
  getSessionFile(): string | undefined;
  getEntries(): SessionEntry[];
}

/** Callback surface the service uses to notify the owning `PiSession` of rewindable turns. */
export interface CheckpointHost {
  cwd: string;
  /** A turn's checkpoint became available (just finalized, or pre-existing on resume). Idempotent. */
  onCheckpointReady(userEntryId: string): void;
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

/**
 * Per-session auto-checkpoint engine driver (US-013b). Owns one `RepoManager` + `AutoCheckpointProducer`
 * bound to the session's bare repo, driven by the pi turn lifecycle (message_start → turnStart,
 * turn_end → turnEnd, agent_end → finalize). Checkpoints are always on when git is available; git
 * absence is detected once and disables the engine cleanly (every method no-ops, nothing throws — FR-6).
 *
 * Methods that mint checkpoint entries RETURN them so the extension factory (which holds the pi
 * `appendEntry` API) can persist them; the service notifies the host of each rewindable turn directly.
 */
export class CheckpointService {
  private readonly host: CheckpointHost;
  private repo: RepoManager | null = null;
  private producer: AutoCheckpointProducer | null = null;
  private gitAvailable: boolean | null = null;
  private turnCounter = 0;
  /** One-shot: skip the NEXT agent_end finalize because the turn is being held open for a continuation
   *  round (plan-mode nudge / background-subagent keep-alive both re-prompt via `triggerTurn`). Without
   *  this, every held continuation's agent_end would finalize a fresh checkpoint for the SAME user entry,
   *  producing duplicate rewind rows (one per continuation) and a wrong restore point (the latest
   *  mid-turn snapshot instead of the true pre-prompt state). Set by the keep-alive `agent_end` hook,
   *  which runs before the checkpoint `agent_end` hook in the same emit, so it is consumed within the
   *  same cycle — one logical turn keeps its single pending checkpoint and finalizes once when it ends. */
  private deferFinalize = false;
  /** Serializes the producer's async steps so concurrent lifecycle events can't interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(host: CheckpointHost) {
    this.host = host;
  }

  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Bind the bare repo lazily (once git is confirmed available and the session file is known). */
  private async ensureProducer(sm: CheckpointTreeReader): Promise<AutoCheckpointProducer | null> {
    if (this.gitAvailable === false) return null;
    if (this.producer) return this.producer;
    const sessionFile = sm.getSessionFile();
    if (!sessionFile) return null;
    if (this.gitAvailable === null) {
      const probe = await execSafe('git', ['--version']);
      this.gitAvailable = probe.ok;
      if (!probe.ok) {
        log('[CheckpointService] git unavailable — checkpoints disabled for this session');
        return null;
      }
    }
    const repoDir = getRepoDir(sessionFile);
    this.repo = new RepoManager(getGitDir(repoDir), getIndexPath(repoDir), this.host.cwd);
    this.producer = new AutoCheckpointProducer({
      repo: this.repo,
      exclude: CHECKPOINT_EXCLUDE_SET,
      createTurnId: () => `turn-${++this.turnCounter}`,
      now: () => new Date(),
    });
    return this.producer;
  }

  /**
   * Assistant message of a turn: snapshot the pre-turn state for the latest user entry. Called on every
   * assistant message_start; the producer dedups by user entry id (cheap no-op within a turn), so this
   * stays correct even if a prior turn aborted before agent_end finalized it.
   */
  onMessageStart(message: PiMessage, sm: CheckpointTreeReader): Promise<CheckpointEntry[]> {
    if (message.role !== 'assistant') return Promise.resolve([]);
    return this.serialize(async () => {
      const producer = await this.ensureProducer(sm);
      if (!producer) return [];
      const leaf = findLastUserEntry(sm);
      if (!leaf) return [];
      const result = await producer.turnStart({ userEntryId: leaf.id, prompt: leaf.prompt });
      if (!result.ok) {
        log('[CheckpointService] turnStart failed: %s', result.message);
        return [];
      }
      // A still-pending previous turn is finalized here; surface those entries as rewindable.
      for (const entry of result.entries) this.host.onCheckpointReady(entry.userEntryId);
      return [...result.entries];
    });
  }

  /** End of a sub-turn: keep the producer's prompt for the active user entry current. */
  onTurnEnd(sm: CheckpointTreeReader): Promise<void> {
    if (!this.producer) return Promise.resolve();
    return this.serialize(async () => {
      const leaf = findLastUserEntry(sm);
      if (leaf && this.producer) await this.producer.turnEnd({ userEntryId: leaf.id, prompt: leaf.prompt });
    });
  }

  /**
   * Mark that the next `agent_end` does NOT end the turn — Damocles is holding it open for a
   * continuation round (a `triggerTurn` follow-up). One-shot: cleared as it is consumed in `onAgentEnd`.
   * Must be called from the keep-alive `agent_end` hook (which runs before the checkpoint hook in the
   * same emit) so the pending checkpoint survives the held continuation instead of finalizing early.
   */
  deferNextFinalize(): void {
    this.deferFinalize = true;
  }

  /** End of the agent loop: finalize the turn's checkpoint (afterCommit + diff) — unless this agent_end
   *  is a held continuation (deferFinalize), in which case the pending checkpoint is kept for the next
   *  agent_end so one logical turn yields exactly one checkpoint. */
  onAgentEnd(_sm: CheckpointTreeReader): Promise<CheckpointEntry[]> {
    if (this.deferFinalize) {
      this.deferFinalize = false;
      return Promise.resolve([]);
    }
    if (!this.producer) return Promise.resolve([]);
    return this.serialize(async () => {
      if (!this.producer) return [];
      const result = await this.producer.finalizeRun();
      if (!result.ok) return [];
      this.host.onCheckpointReady(result.entry.userEntryId);
      return [result.entry];
    });
  }

  /**
   * Compaction completed: mint an exact-snapshot checkpoint keyed by the compaction entry id so the
   * compaction anchor becomes a rewind point (its files can be restored). This is a single atomic
   * commit with no two-phase turn lifecycle — `beforeCommit === afterCommit === snapshotHash`, with
   * an empty prompt and no file diff. It runs INSIDE the service's `serialize` chain, so it can never
   * interleave with `onMessageStart`/`onAgentEnd`, and it MUST NOT touch the producer's pending turn:
   * `finalizeRun` diffs against its stored `beforeCommit` HASH (not HEAD), so an extra commit here
   * cannot disturb an in-flight turn. The producer is obtained only to trigger lazy repo binding.
   *
   * A re-fired `session_compact` for the same id is harmless: the rewind reader keys its diff map by
   * `userEntryId` (last wins) and emits one anchor per compaction entry, so no phantom row.
   */
  onSessionCompact(compactionEntryId: string, sm: CheckpointTreeReader): Promise<CheckpointEntry[]> {
    return this.serialize(async () => {
      try {
        const producer = await this.ensureProducer(sm);
        if (!producer) return [];
        if (!this.repo) return [];
        const snapshotHash = await this.repo.withLock(async () => {
          await this.repo!.ensureReady(CHECKPOINT_EXCLUDE_SET);
          return this.repo!.checkpoint(compactionEntryId);
        });
        const entry: CheckpointEntry = {
          v: 2,
          kind: 'checkpoint',
          turnId: `compact-${++this.turnCounter}`,
          userEntryId: compactionEntryId,
          beforeCommit: snapshotHash,
          afterCommit: snapshotHash,
          prompt: '',
          fileCount: 0,
          fileChanges: [],
          createdAt: new Date().toISOString(),
        };
        this.host.onCheckpointReady(compactionEntryId);
        return [entry];
      } catch (err) {
        log('[CheckpointService] onSessionCompact failed: %O', err);
        return [];
      }
    });
  }

  /** The bare repo for file restore/clone (lazily bound). Null when git is unavailable (FR-6). */
  getRepo(sm: CheckpointTreeReader): Promise<RepoManager | null> {
    return this.serialize(async () => {
      await this.ensureProducer(sm);
      return this.repo;
    });
  }

  /** Re-surface checkpoints persisted in a resumed/forked session so its turns are immediately rewindable. */
  hydrate(sm: CheckpointTreeReader): void {
    try {
      const branch = sm.getBranch(sm.getLeafId() ?? undefined);
      for (const cp of getCheckpointEntries(branch)) this.host.onCheckpointReady(cp.userEntryId);
    } catch (err) {
      log('[CheckpointService] hydrate failed: %O', err);
    }
  }

  dispose(): void {
    const droppedUserEntryId = this.producer?.discardRun() ?? null;
    if (droppedUserEntryId) {
      // The turn's pre-turn (before) commit is already in the bare repo, but its CheckpointEntry was
      // never persisted (the panel closed / session rebound before agent_end finalized it), so that
      // turn is left non-rewindable. Surface it rather than dropping it silently (FR-6 fail-soft).
      log('[CheckpointService] dispose dropped an unfinalized checkpoint for user entry %s', droppedUserEntryId);
    }
  }
}
