import * as crypto from 'crypto';
import { log } from '../../logger';
import type { MessageCallbacks, Query, StreamingContent } from '../types';
import { SDK_USER_ABORT_MESSAGE } from '../utils';
import type { ToolManager } from '../tool-manager';
import type { ContextDistillationService } from '../../context-distillation';
import { StreamingState } from './state';
import { createProcessorRegistry } from './processor-registry';
import type {
  CheckpointTracker,
  TurnCompleteCallback,
  ProcessorRegistry,
  ProcessorContext,
  ProcessorDependencies,
} from './types';

export type { CheckpointTracker, TurnCompleteCallback };

/**
 * StreamingManager handles message processing and content accumulation.
 *
 * This is a thin facade that:
 * - Wires state management and processors together
 * - Exposes the public API for ClaudeSession
 * - Delegates message handling to specialized processors
 *
 * Internal architecture:
 * - StreamingState: centralized mutable state with change notifications
 * - ProcessorRegistry: map-based message-type-specific handlers
 * - Utils: pure helper functions for calculations
 */
export class StreamingManager {
  private state: StreamingState;
  private processors: ProcessorRegistry;
  private deps: ProcessorDependencies;

  constructor(
    callbacks: MessageCallbacks,
    toolManager: ToolManager,
    checkpointTracker: CheckpointTracker,
    cwd: string,
    contextDistillation?: ContextDistillationService,
  ) {
    this.deps = {
      callbacks,
      toolManager,
      checkpointTracker,
      ...(contextDistillation !== undefined ? { contextDistillation } : {}),
      cwd,
    };

    this.state = new StreamingState(callbacks);
    this.processors = createProcessorRegistry(this.deps);
  }

  get sessionId(): string | null {
    return this.state.sessionId;
  }

  set sessionId(value: string | null) {
    this.state.setSessionId(value);
  }

  get lastUserMessageId(): string | null {
    return this.state.lastUserMessageId;
  }

  set lastUserMessageId(value: string | null) {
    this.state.lastUserMessageId = value;
  }

  get isProcessing(): boolean {
    return this.state.isProcessing;
  }

  set processing(value: boolean) {
    this.state.setProcessing(value);
  }

  get streamingText(): string {
    return this.state.streamingText;
  }

  get currentStreamingContent(): StreamingContent {
    return this.state.streamingContent;
  }

  set onTurnComplete(callback: TurnCompleteCallback | null) {
    this.state.onTurnComplete = callback;
  }

  get silentAbort(): boolean {
    return this.state.silentAbort;
  }

  set silentAbort(value: boolean) {
    this.state.silentAbort = value;
  }

  set sessionConflict(value: boolean) {
    this.state.sessionConflict = value;
  }

  set onTurnEndFlush(callback: (() => boolean) | null) {
    this.state.onTurnEndFlush = callback;
  }

  flushPendingAssistant(): void {
    const pending = this.state.pendingAssistant;
    if (!pending) return;

    this.state.pendingAssistant = null;

    if (this.state.lastUserMessageId) {
      this.deps.checkpointTracker.trackCheckpoint(pending.id, this.state.lastUserMessageId);
    }

    this.deps.toolManager.sendAbandonedTools(pending.id);

    if (this.state.streamingContent.messageId === pending.id) {
      const hasThinkingInPending = pending.content.some((b) => b.type === 'thinking');
      const hasTextInPending = pending.content.some((b) => b.type === 'text');

      if (!hasThinkingInPending && this.state.streamingContent.thinking) {
        pending.content.unshift({
          type: 'thinking',
          thinking: this.state.streamingContent.thinking,
        });
      }
      if (!hasTextInPending && this.state.streamingContent.text) {
        pending.content.push({ type: 'text', text: this.state.streamingContent.text });
      }
    }

    this.deps.callbacks.onMessage({
      type: 'assistant',
      data: {
        type: 'assistant',
        message: {
          id: pending.id,
          role: 'assistant',
          content: pending.content,
          model: pending.model,
          stop_reason: pending.stopReason,
        },
        session_id: pending.sessionId,
      },
      parentToolUseId: pending.parentToolUseId,
    });

    if (this.deps.contextDistillation?.isEnabled) {
      const flushedUuid = crypto.randomUUID();

      const flushedData = {
        uuid: flushedUuid,
        messageId: pending.id,
        model: pending.model,
        content: [...pending.content],
        stopReason: pending.stopReason,
        sessionId: pending.sessionId,
      };

      log('[StreamingManager.flush] Persisting assistant data: messageId=%s, blocks=%d, parentToolUseId=%s',
        pending.id, pending.content.length, pending.parentToolUseId ?? 'none');
      this.deps.contextDistillation.persistAssistantData(flushedData, pending.parentToolUseId ?? null);
    }
  }

  async consumeQueryInBackground(
    result: Query,
    budgetLimit: number | null,
    abortSignal: AbortSignal,
    onComplete: () => void
  ): Promise<void> {
    const queryGeneration = this.state.incrementQueryGeneration();
    this.state.currentQueryGeneration = queryGeneration;
    this.state.budgetLimit = budgetLimit;
    let receivedResult = false;

    try {
      for await (const message of result) {
        if (abortSignal.aborted) {
          break;
        }

        if (queryGeneration !== this.state.currentQueryGeneration) {
          break;
        }

        const msg = message as { type: string };
        if (msg.type === 'result') {
          receivedResult = true;
        }
        this.processSDKMessage(message);
      }
    } catch (err) {
      const isSessionConflict = this.state.sessionConflict ||
        (err instanceof Error && err.message.includes('already in use'));
      const isDistillConflict = isSessionConflict && !!this.deps.contextDistillation?.isEnabled;
      if (isDistillConflict) {
        this.state.sessionConflict = false;
        log('[StreamingManager] Session conflict detected — invoking onSessionConflict callback');
        this.deps.callbacks.onSessionConflict?.();
      }
      const isUserInitiatedAbort = err instanceof Error && err.message === SDK_USER_ABORT_MESSAGE;
      const shouldReport =
        err instanceof Error &&
        err.name !== 'AbortError' &&
        !isUserInitiatedAbort &&
        !this.state.silentAbort &&
        !isDistillConflict;
      if (shouldReport) {
        log('[StreamingManager] Query consumption error', err.message, err.stack, { budgetLimit });
        this.deps.callbacks.onMessage({
          type: 'error',
          message: err.message,
        });
      }
    } finally {
      const isStaleQuery = queryGeneration !== this.state.currentQueryGeneration;
      if (isStaleQuery) {
        onComplete();
        return;
      }

      if (!receivedResult) {
        this.deps.toolManager.sendAllAbandonedTools();
        this.state.setProcessing(false);
        this.state.fireTurnComplete();
      }

      onComplete();
    }
  }

  private processSDKMessage(message: unknown): void {
    const msg = message as { type: string; subtype?: string };
    const ctx = this.createContext();

    const key = msg.type === 'system' && msg.subtype
      ? `system:${msg.subtype}`
      : msg.type;

    const processor = this.processors.get(key);
    if (processor) {
      processor(msg as Record<string, unknown>, ctx);
    } else {
      log('[StreamingManager] No processor for message type: %s', key);
    }
  }

  resetStreaming(): void {
    this.state.resetStreaming();
  }

  resetTurn(): void {
    this.state.resetTurn();
  }

  private createContext(): ProcessorContext {
    return {
      state: this.state,
      deps: this.deps,
      flushPendingAssistant: () => this.flushPendingAssistant(),
    };
  }
}
