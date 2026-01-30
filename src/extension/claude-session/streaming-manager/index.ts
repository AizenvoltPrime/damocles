import { log } from '../../logger';
import type { MessageCallbacks, Query, StreamingContent } from '../types';
import { SDK_USER_ABORT_MESSAGE } from '../utils';
import type { ToolManager } from '../tool-manager';
import { StreamingState } from './state';
import { createProcessorRegistry } from './processor-registry';
import type {
  CheckpointTracker,
  TurnCompleteCallback,
  ProcessorRegistry,
  ProcessorContext,
  ProcessorDependencies,
  ResultProcessorExtra,
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
 * - ProcessorRegistry: message-type-specific handlers
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
    cwd: string
  ) {
    this.deps = {
      callbacks,
      toolManager,
      checkpointTracker,
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

  set silentAbort(value: boolean) {
    this.state.silentAbort = value;
  }

  set onTurnEndFlush(callback: (() => void) | null) {
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
  }

  async consumeQueryInBackground(
    result: Query,
    budgetLimit: number | null,
    abortSignal: AbortSignal,
    onComplete: () => void
  ): Promise<void> {
    const queryGeneration = this.state.incrementQueryGeneration();
    this.state.currentQueryGeneration = queryGeneration;
    let receivedResult = false;

    try {
      for await (const message of result) {
        if (abortSignal.aborted) {
          break;
        }
        const msg = message as { type: string };
        if (msg.type === 'result') {
          receivedResult = true;
        }
        this.processSDKMessage(message, budgetLimit, queryGeneration);
      }
    } catch (err) {
      const isUserInitiatedAbort = err instanceof Error && err.message === SDK_USER_ABORT_MESSAGE;
      const shouldReport =
        err instanceof Error &&
        err.name !== 'AbortError' &&
        !isUserInitiatedAbort &&
        !this.state.silentAbort;
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

      this.state.silentAbort = false;
      onComplete();

      if (!receivedResult) {
        this.deps.toolManager.sendAllAbandonedTools();
        this.state.setProcessing(false);
        this.state.fireTurnComplete();
      }
    }
  }

  processSDKMessage(message: unknown, budgetLimit: number | null, queryGeneration?: number): void {
    const msg = message as { type: string; [key: string]: unknown };
    const ctx = this.createContext();

    switch (msg.type) {
      case 'assistant':
        this.processors.assistant(msg, ctx);
        break;
      case 'stream_event':
        this.processors.stream_event(msg, ctx);
        break;
      case 'system':
        this.processors.system(msg, ctx);
        break;
      case 'user':
        this.processors.user(msg, ctx);
        break;
      case 'result': {
        const extra: ResultProcessorExtra = { budgetLimit, queryGeneration };
        this.processors.result(msg, ctx, extra);
        break;
      }
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
