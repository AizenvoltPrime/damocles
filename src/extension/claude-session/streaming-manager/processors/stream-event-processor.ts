import { log } from '../../../logger';
import { createEmptyStreamingContent } from '../../types';
import { isLocalCommandText } from '../../utils';
import { calculateThinkingDuration } from '../utils';
import type { ProcessorContext, ProcessorDependencies, MessageProcessor } from '../types';

interface StreamEvent {
  type: string;
  message?: { id: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: {
    type: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string;
  };
  usage?: { output_tokens?: number };
}

function handleMessageStart(
  event: { message?: { id: string; model?: string } },
  parentToolUseId: string | null,
  ctx: ProcessorContext
): void {
  if (!event.message?.id) return;

  const { state } = ctx;

  if (state.streamingContent.messageId && state.streamingContent.messageId !== event.message.id) {
    ctx.flushPendingAssistant();
  }

  state.streamingContent = createEmptyStreamingContent();
  state.streamingContent.messageId = event.message.id;
  state.streamingContent.model = event.message.model ?? null;
  state.streamingContent.parentToolUseId = parentToolUseId;
}

function handleContentBlockStart(
  event: { index?: number; content_block?: { type: string; id?: string; name?: string } },
  ctx: ProcessorContext
): void {
  const index = event.index;
  const block = event.content_block;
  if (index === undefined || !block) return;

  const { state } = ctx;
  state.streamingContent.activeBlockIndex = index;
  state.streamingContent.activeBlockType = block.type as 'text' | 'thinking' | 'tool_use' | null;

  if (block.type === 'tool_use' && block.id) {
    state.streamingContent.activeToolId = block.id;
  } else if (block.type === 'thinking') {
    if (!state.streamingContent.thinkingStartTime) {
      state.streamingContent.thinkingStartTime = Date.now();
    }
    state.streamingContent.isThinking = true;
  }
}

function handleThinkingDelta(thinking: string, ctx: ProcessorContext, deps: ProcessorDependencies): void {
  if (!thinking) return;

  const { state } = ctx;
  const { callbacks } = deps;

  if (!state.streamingContent.thinkingStartTime) {
    state.streamingContent.thinkingStartTime = Date.now();
  }
  state.streamingContent.thinking += thinking;
  state.streamingContent.isThinking = true;

  if (!state.streamingContent.hasStreamedTools || state.streamingContent.activeBlockType === 'thinking') {
    callbacks.onMessage({
      type: 'partial',
      data: {
        type: 'partial',
        content: [],
        session_id: state.sessionId || '',
        messageId: state.streamingContent.messageId,
        streamingThinking: state.streamingContent.thinking,
        isThinking: true,
      },
      parentToolUseId: state.streamingContent.parentToolUseId,
    });
  }
}

function handleTextDelta(text: string, ctx: ProcessorContext, deps: ProcessorDependencies): void {
  if (!text) return;

  const { state } = ctx;
  const { callbacks } = deps;

  if (deps.recallService && !state.streamingContent.parentToolUseId) {
    deps.recallService.onStreamDelta(text);
  }

  calculateThinkingDuration(state.streamingContent);
  state.streamingContent.text += text;

  if (isLocalCommandText(state.streamingContent.text)) {
    log('[StreamingManager] Filtering local command text from streaming');
    return;
  }

  callbacks.onMessage({
    type: 'partial',
    data: {
      type: 'partial',
      content: [],
      session_id: state.sessionId || '',
      messageId: state.streamingContent.messageId,
      streamingThinking: state.streamingContent.thinking,
      streamingText: state.streamingContent.text,
      isThinking: false,
      ...(state.streamingContent.thinkingDuration != null ? { thinkingDuration: state.streamingContent.thinkingDuration } : {}),
    },
    parentToolUseId: state.streamingContent.parentToolUseId,
  });
}

function handleContentBlockDelta(
  event: { delta?: { type: string; text?: string; thinking?: string; signature?: string } },
  ctx: ProcessorContext,
  deps: ProcessorDependencies
): void {
  const delta = event.delta;
  if (!delta) return;

  switch (delta.type) {
    case 'thinking_delta':
      handleThinkingDelta(delta.thinking || '', ctx, deps);
      break;
    case 'signature_delta':
      if (delta.signature) {
        ctx.state.streamingContent.thinkingSignature += delta.signature;
      }
      break;
    case 'text_delta':
      handleTextDelta(delta.text || '', ctx, deps);
      break;
  }
}

function handleContentBlockStop(ctx: ProcessorContext, deps: ProcessorDependencies): void {
  const { state } = ctx;
  const completedBlockType = state.streamingContent.activeBlockType;

  if (completedBlockType === 'thinking') {
    calculateThinkingDuration(state.streamingContent);
  }

  log('[StreamEvent.contentBlockStop] type=%s, messageId=%s',
    completedBlockType, state.streamingContent.messageId);

  state.streamingContent.activeBlockIndex = null;
  state.streamingContent.activeBlockType = null;
  state.streamingContent.activeToolId = null;

  if (completedBlockType === 'thinking') {
    if (deps.recallService?.isEnabled) {
      const messageId = state.streamingContent.messageId;
      const model = state.streamingContent.model;
      if (messageId && model && state.streamingContent.thinking) {
        deps.recallService.onThinkingBlockComplete(
          messageId, model, state.streamingContent.thinking,
          state.streamingContent.parentToolUseId ?? undefined,
          state.streamingContent.thinkingSignature || undefined
        );
      }
    }
    state.streamingContent.thinking = '';
    state.streamingContent.thinkingSignature = '';
  }
}

function handleMessageDelta(event: {
  delta?: { stop_reason?: string };
  usage?: { output_tokens?: number };
}): void {
  if (event.delta?.stop_reason) {
    log('[StreamingManager] Message stop_reason: ', event.delta.stop_reason);
  }
  if (event.usage?.output_tokens) {
    log('[StreamingManager] Output tokens: ', event.usage.output_tokens);
  }
}

export function createStreamEventProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (message: Record<string, unknown>, ctx: ProcessorContext): void => {
    const streamParentToolUseId = (message['parent_tool_use_id'] as string | null) ?? null;
    const event = message['event'] as StreamEvent;

    switch (event.type) {
      case 'message_start':
        handleMessageStart(event, streamParentToolUseId, ctx);
        break;
      case 'content_block_start':
        handleContentBlockStart(event, ctx);
        break;
      case 'content_block_delta':
        handleContentBlockDelta(event, ctx, deps);
        break;
      case 'content_block_stop':
        handleContentBlockStop(ctx, deps);
        break;
      case 'message_delta':
        handleMessageDelta(event);
        break;
      case 'message_stop':
        log('[StreamingManager] Message stream complete');
        break;
      case 'ping':
        break;
      default:
        log('[StreamingManager] Unknown stream event type: %s', event.type);
    }
  };

  return { stream_event: handler };
}
