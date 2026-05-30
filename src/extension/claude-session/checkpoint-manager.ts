import { log } from '../logger';
import {
  persistInterruptMarker,
  persistPartialAssistant,
  persistCancelledPrompt,
  findUserMessageInCurrentTurn,
  findLastMessageInCurrentTurn,
  getLastMessageUuid,
  getMessageParentUuid,
} from '../session';
import type { MessageCallbacks, Query, RewindOption, StreamingContent } from './types';
import { retryWithBackoff } from './utils';

/**
 * CheckpointManager handles rewind, checkpoints, and session identity.
 *
 * Responsibilities:
 * - File checkpoint rewind via SDK
 * - Conversation forking via resumeSessionAt
 * - Track message → user message checkpoints
 * - Accumulate session cost
 * - Handle interrupt persistence
 */
export class CheckpointManager {
  private _resumeSessionId: string | null = null;
  private _pendingResumeSessionAt: string | null = null;
  private messageCheckpoints: Map<string, string> = new Map();
  private rewindableUserIds: Set<string> = new Set();
  private _accumulatedCost = 0;
  private _wasInterrupted = false;
  private _currentPrompt: string | null = null;
  private _currentCorrelationId: string | null = null;
  private _rewindEpoch = 0;
  private _lastBroadcastSize = -1;
  private _pendingCancelledCompaction = false;

  private cwd: string;
  private callbacks: MessageCallbacks;

  constructor(cwd: string, callbacks: MessageCallbacks) {
    this.cwd = cwd;
    this.callbacks = callbacks;
  }

  get resumeSessionId(): string | null {
    return this._resumeSessionId;
  }

  setResumeSession(sessionId: string | null): void {
    this._resumeSessionId = sessionId;
  }

  clearResumeSession(): void {
    this._resumeSessionId = null;
  }

  get pendingResumeAt(): string | null {
    return this._pendingResumeSessionAt;
  }

  clearPendingResumeAt(): string | null {
    const value = this._pendingResumeSessionAt;
    this._pendingResumeSessionAt = null;
    return value;
  }

  get wasInterrupted(): boolean {
    return this._wasInterrupted;
  }

  set wasInterrupted(value: boolean) {
    this._wasInterrupted = value;
  }

  get currentPrompt(): string | null {
    return this._currentPrompt;
  }

  set currentPrompt(value: string | null) {
    this._currentPrompt = value;
  }

  get currentCorrelationId(): string | null {
    return this._currentCorrelationId;
  }

  set currentCorrelationId(value: string | null) {
    this._currentCorrelationId = value;
  }

  get rewindEpoch(): number {
    return this._rewindEpoch;
  }

  /** Track checkpoint mapping assistant message → user message */
  trackCheckpoint(assistantMessageId: string, userMessageId: string): void {
    this.messageCheckpoints.set(assistantMessageId, userMessageId);
    this.rewindableUserIds.add(userMessageId);
    this.broadcastCheckpoints();
  }

  /** Seed rewindable user-message IDs from historical session data */
  seedCheckpoints(userMessageIds: Iterable<string>): void {
    for (const id of userMessageIds) this.rewindableUserIds.add(id);
    this.broadcastCheckpoints();
  }

  /** Push the authoritative rewindable user-message ID set to the webview */
  private broadcastCheckpoints(): void {
    const size = this.rewindableUserIds.size;
    if (size === this._lastBroadcastSize) return;
    this._lastBroadcastSize = size;
    this.callbacks.onMessage({ type: 'checkpointInfo', userMessageIds: [...this.rewindableUserIds] });
  }

  /** Get checkpoint (user message) for an assistant message */
  getCheckpointForMessage(assistantMessageId: string): string | undefined {
    return this.messageCheckpoints.get(assistantMessageId);
  }

  /** Update accumulated cost */
  updateCost(cost: number): void {
    this._accumulatedCost = cost;
  }

  /** Get accumulated cost */
  getAccumulatedCost(): number {
    return this._accumulatedCost;
  }

  /**
   * Rewind to a specific message with various restore options.
   *
   * Options:
   * - 'fork-conversation': Spawn a new panel forked from this point. No file rewind. No source-panel mutation.
   * - 'code-only': Restore files only (conversation stays linear in source panel).
   * - 'fork-and-rewind-code': Restore files in source panel AND spawn a new forked panel.
   */
  async rewindFiles(
    userMessageId: string,
    option: RewindOption,
    sessionId: string | null,
    query: Query | null,
    promptContent: string | undefined,
    onSpawnFork?: (forkAtUuid: string | null, userMessageId: string) => Promise<void>,
  ): Promise<void> {
    const needsFileRewind = option === 'code-only' || option === 'fork-and-rewind-code';
    const needsForkSpawn = option === 'fork-conversation' || option === 'fork-and-rewind-code';

    let fileRewindError: string | null = null;

    this._rewindEpoch++;

    this._currentPrompt = null;
    this._currentCorrelationId = null;
    this._wasInterrupted = false;

    try {
      let parentUuid: string | null = null;
      if (sessionId) {
        parentUuid = await getMessageParentUuid(this.cwd, sessionId, userMessageId);
      }

      if (needsFileRewind) {
        if (!query) {
          fileRewindError = 'No active session to rewind files';
        } else {
          try {
            await query.rewindFiles(userMessageId);
          } catch (fileErr) {
            const errorMsg = fileErr instanceof Error ? fileErr.message : String(fileErr);
            log('[CheckpointManager] File rewind failed: %s', errorMsg);
            fileRewindError = errorMsg;
          }
        }
      }

      if (needsForkSpawn) {
        if (!sessionId) {
          this.callbacks.onMessage({ type: 'rewindError', message: 'No active session to fork' });
          return;
        }
        if (!onSpawnFork) {
          this.callbacks.onMessage({ type: 'rewindError', message: 'Fork spawn callback unavailable' });
          return;
        }
        await onSpawnFork(parentUuid, userMessageId);
        return;
      }

      this.callbacks.onMessage({
        type: 'rewindComplete',
        rewindToMessageId: userMessageId,
        option,
        ...(promptContent && { promptContent }),
        ...(fileRewindError && { fileRewindWarning: fileRewindError }),
      });
    } catch (error) {
      log('[CheckpointManager] rewindFiles error: %s', error instanceof Error ? error.message : error);
      this.callbacks.onMessage({
        type: 'rewindError',
        message: error instanceof Error ? error.message : 'Rewind failed',
      });
    }
  }

  /**
   * Handle interrupt persistence after message processing.
   *
   * This method captures the rewind epoch at the start and checks it before
   * sending any messages. If a rewind occurred during the async operations,
   * the interrupt recovery is discarded as stale.
   */
  async handleInterruptPersistence(
    sessionId: string,
    _lastUserMessageId: string | null,
    streamingContent: StreamingContent,
    currentModel: string | null,
    canRecover: boolean
  ): Promise<string | null> {
    if (!this._wasInterrupted || !this._currentPrompt) {
      return null;
    }

    // Capture epoch at start - if it changes during async operations, a rewind occurred
    const epochAtStart = this._rewindEpoch;
    const correlationIdAtStart = this._currentCorrelationId;
    const promptAtStart = this._currentPrompt;

    try {
      const sdkUserMessage = await retryWithBackoff(
        () => findUserMessageInCurrentTurn(this.cwd, sessionId, promptAtStart),
        (msg) => msg !== null
      );

      // Check if rewind occurred during async operation
      if (this._rewindEpoch !== epochAtStart) {
        return null;
      }

      if (sdkUserMessage) {
        // Send userMessageIdAssigned so webview can link the message for rewind
        if (correlationIdAtStart && sdkUserMessage.uuid) {
          this.callbacks.onMessage({
            type: 'userMessageIdAssigned',
            sdkMessageId: sdkUserMessage.uuid,
            correlationId: correlationIdAtStart,
          });
        }

        const lastMsgUuid = await findLastMessageInCurrentTurn(this.cwd, sessionId);
        let lastUuidForChain = lastMsgUuid ?? sdkUserMessage.uuid;

        if (streamingContent.text && lastUuidForChain) {
          const partialUuid = await persistPartialAssistant({
            workspacePath: this.cwd,
            sessionId,
            parentUuid: lastUuidForChain,
            text: streamingContent.text,
            ...(currentModel != null ? { model: currentModel } : {}),
          });
          lastUuidForChain = partialUuid;
        }

        if (lastUuidForChain) {
          return await persistInterruptMarker({
            workspacePath: this.cwd,
            sessionId,
            parentUuid: lastUuidForChain,
          });
        }
      } else {
        // Check epoch again before sending interruptRecovery
        if (this._rewindEpoch !== epochAtStart) {
          return null;
        }

        // Only recover (remove + autofill) when no visible output streamed this turn. Once output
        // exists, a missing user message is just the JSONL-write race — leave the message in place.
        if (canRecover && correlationIdAtStart && promptAtStart) {
          this.callbacks.onMessage({
            type: 'interruptRecovery',
            correlationId: correlationIdAtStart,
            promptContent: promptAtStart,
          });
        }
        return null;
      }
    } catch (err) {
      log('[CheckpointManager] handleInterruptPersistence error:', err);
    }

    return null;
  }

  get pendingCancelledCompaction(): boolean {
    return this._pendingCancelledCompaction;
  }

  markPendingCancelledCompaction(): void {
    this._pendingCancelledCompaction = true;
  }

  clearPendingCancelledCompaction(): void {
    this._pendingCancelledCompaction = false;
  }

  /**
   * After a no-output interrupt that the user recovered (prompt removed from the live UI), record a
   * `cancelled-prompt` marker for the user message the SDK already persisted, so `compactCancelledTurns`
   * can later physically delete the cancelled turn from the log. Resolves the SDK user-message UUID
   * with retry to tolerate the async JSONL-write race. Aborts if a rewind raced in, or if a new send
   * started while resolving — the recovery flow auto-fills the prompt, so re-sending identical text is
   * common, and `findUserMessageInCurrentTurn` returns the LAST content match, which would then be the
   * RE-SENT message. Tagging that would delete a valid turn, so we bail and leave the orphan for the
   * content-agnostic history-load compaction. `sendGeneration` is the per-send processing generation
   * captured at cancel time; `getCurrentGeneration` reads it live just before the write.
   */
  async handleRecoveryPersistence(
    sessionId: string,
    prompt: string,
    sendGeneration: number,
    getCurrentGeneration: () => number
  ): Promise<void> {
    const epochAtStart = this._rewindEpoch;
    try {
      const sdkUserMessage = await retryWithBackoff(
        () => findUserMessageInCurrentTurn(this.cwd, sessionId, prompt),
        (msg) => msg !== null
      );

      if (this._rewindEpoch !== epochAtStart) {
        return;
      }

      if (getCurrentGeneration() !== sendGeneration) {
        return;
      }

      if (sdkUserMessage?.uuid) {
        await persistCancelledPrompt(this.cwd, sessionId, sdkUserMessage.uuid);
      }
    } catch (err) {
      log('[CheckpointManager] handleRecoveryPersistence error:', err);
    }
  }

  /**
   * Read user message UUID after successful message processing.
   * @param excludeUuid - UUID to exclude (the previously known last user message)
   */
  async readUserMessageUuid(sessionId: string, excludeUuid?: string | null): Promise<string | null> {
    if (!this._currentPrompt) {
      return null;
    }

    try {
      const prompt = this._currentPrompt;
      const sdkUserMessage = await retryWithBackoff(
        () => findUserMessageInCurrentTurn(this.cwd, sessionId, prompt),
        (msg) => msg !== null && (!excludeUuid || msg.uuid !== excludeUuid)
      );

      return sdkUserMessage?.uuid ?? null;
    } catch (err) {
      log('[CheckpointManager] Error reading user message UUID:', err);
    }

    return null;
  }

  /**
   * Get last message UUID from session file.
   */
  async getLastMessageUuid(sessionId: string): Promise<string | null> {
    try {
      return await getLastMessageUuid(this.cwd, sessionId);
    } catch (err) {
      log('[CheckpointManager] getLastMessageUuid failed:', err);
      return null;
    }
  }

  /**
   * Read UUID for a flushed (queued) message after its turn completes.
   */
  async readFlushedMessageUuid(
    sessionId: string,
    content: string,
    excludeUuid?: string | null
  ): Promise<string | null> {
    try {
      const sdkUserMessage = await retryWithBackoff(
        () => findUserMessageInCurrentTurn(this.cwd, sessionId, content),
        (msg) => msg !== null && (!excludeUuid || msg.uuid !== excludeUuid)
      );

      return sdkUserMessage?.uuid ?? null;
    } catch (err) {
      log('[CheckpointManager] Error reading flushed message UUID:', err);
      return null;
    }
  }

  /** Reset all checkpoint state */
  reset(): void {
    this._resumeSessionId = null;
    this._pendingResumeSessionAt = null;
    this.messageCheckpoints.clear();
    this.rewindableUserIds.clear();
    this._accumulatedCost = 0;
    this._wasInterrupted = false;
    this._currentPrompt = null;
    this._currentCorrelationId = null;
    this._lastBroadcastSize = -1;
    this.broadcastCheckpoints();
  }
}
