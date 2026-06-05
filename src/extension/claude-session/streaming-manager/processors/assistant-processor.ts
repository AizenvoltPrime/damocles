import { createEmptyStreamingContent } from '../../types';
import { serializeContent } from '../../utils';
import { calculateThinkingDuration, commitStreamingText } from '../utils';
import { TOOL_CRON_DELETE, TOOL_WORKFLOW } from '../../../../shared/tool-names';
import type { ProcessorContext, ProcessorDependencies, MessageProcessor } from '../types';
import type { ToolUseBlock } from '../../../../shared/types/content';
import type { RefusalStopDetails } from '../../../../shared/types/session';

interface AssistantMessageData {
  message: {
    id: string;
    content: unknown[];
    model: string;
    stop_reason: string | null;
    stop_details?: RefusalStopDetails | null;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      _openai_cached_input_tokens?: number;
      _openai_reasoning_tokens?: number;
    };
  };
  session_id: string;
  parent_tool_use_id?: string | null;
  isSidechain?: boolean;
}

export function createAssistantProcessor(deps: ProcessorDependencies): Record<string, MessageProcessor> {
  const handler: MessageProcessor = (message: Record<string, unknown>, ctx: ProcessorContext): void => {
    const msg = message as unknown as AssistantMessageData;
    const parentToolUseId = msg.parent_tool_use_id ?? null;
    const { state } = ctx;
    const { callbacks, toolManager } = deps;

    if (!msg.isSidechain && msg.message.usage) {
      const inputTokens = msg.message.usage.input_tokens ?? 0;
      /** Skip when 0: Codex bridge ships message_start usage=0 (real values arrive via handleMessageDelta from finalize). Claude turns always have >0 input. */
      if (inputTokens > 0) {
        const cacheCreationTokens = msg.message.usage.cache_creation_input_tokens ?? 0;
        const cacheReadTokens = msg.message.usage.cache_read_input_tokens ?? 0;
        const cachedInputTokens = msg.message.usage._openai_cached_input_tokens;
        const reasoningTokens = msg.message.usage._openai_reasoning_tokens;
        const totalContextTokens = inputTokens + cacheCreationTokens + cacheReadTokens;

        state.lastContextTokens = totalContextTokens;

        callbacks.onMessage({
          type: 'tokenUsageUpdate',
          inputTokens,
          cacheCreationTokens,
          cacheReadTokens,
          ...(typeof cachedInputTokens === 'number' ? { cachedInputTokens } : {}),
          ...(typeof reasoningTokens === 'number' ? { reasoningTokens } : {}),
        });

        deps.checkpointTracker.updateTokenUsage(totalContextTokens);
      }
    }

    if (state.pendingAssistant && state.pendingAssistant.id !== msg.message.id) {
      ctx.flushPendingAssistant();
      if (state.streamingContent.messageId !== msg.message.id) {
        state.streamingContent = createEmptyStreamingContent();
        state.streamingContent.messageId = msg.message.id;
        state.streamingContent.parentToolUseId = parentToolUseId;
      }
    } else if (!state.streamingContent.messageId) {
      state.streamingContent.messageId = msg.message.id;
      state.streamingContent.parentToolUseId = parentToolUseId;
    }

    const serializedContent = serializeContent(msg.message.content);
    const hasToolBlocks = serializedContent.some((b) => b.type === 'tool_use');
    const hasAccumulatedText = hasToolBlocks && state.streamingContent.text;

    for (const block of serializedContent) {
      if (block.type === 'tool_use') {
        if (toolManager.getStreamedToolInfo(block.id)) {
          continue;
        }

        const duration = calculateThinkingDuration(state.streamingContent);
        if (duration !== null) {
          callbacks.onMessage({
            type: 'partial',
            data: {
              type: 'partial',
              content: [],
              session_id: state.sessionId || '',
              messageId: state.streamingContent.messageId,
              streamingThinking: state.streamingContent.thinking,
              isThinking: false,
              thinkingDuration: duration,
            },
            parentToolUseId,
          });
        }
        state.streamingContent.hasStreamedTools = true;
        state.markStreamedOutput();
        if (block.name === TOOL_WORKFLOW) {
          state.workflowToolUseIds.add(block.id);
        }
        toolManager.registerStreamedTool(block.id, {
          toolName: block.name,
          messageId: msg.message.id,
          parentToolUseId,
        });
        toolManager.queueToolInfo(block.name, { toolUseId: block.id, parentToolUseId });
        if (deps.recallService && !parentToolUseId) {
          deps.recallService.onToolUse(block.name, block.input as Record<string, unknown>, block.id);

        }

        const currentText = state.streamingContent.text;
        if (currentText.length > state.streamingContent.committedTextLength) {
          const uncommittedText = currentText.slice(state.streamingContent.committedTextLength);
          if (uncommittedText.trim()) {
            state.streamingContent.contentBlocks.push({ type: 'text', text: uncommittedText });
          }
          state.streamingContent.committedTextLength = currentText.length;
        }

        state.streamingContent.contentBlocks.push({
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input,
        });

        callbacks.onMessage({
          type: 'toolStreaming',
          messageId: msg.message.id,
          tool: {
            id: block.id,
            name: block.name,
            input: block.input,
          },
          contentBlocks: [...state.streamingContent.contentBlocks],
          parentToolUseId,
        });

        if (block.name === TOOL_CRON_DELETE && deps.recallService && !parentToolUseId) {
          const deleteJobId = String((block.input as Record<string, unknown>)['id'] ?? '');
          void toolManager.handlePostToolUse(TOOL_CRON_DELETE, block.id, { id: deleteJobId })
            .then(() => {
              if (deleteJobId && deps.loopJobTracker) {
                deps.loopJobTracker.trackDeletion(deleteJobId);
              }
            });
        }
      }
    }

    const nonTextContent = serializedContent.filter((b) => b.type !== 'text');
    const textContent = serializedContent.filter((b) => b.type === 'text') as {
      type: 'text';
      text: string;
    }[];
    const hasStreamingText = state.streamingContent.text.length > 0;

    if (!state.pendingAssistant) {
      const initialContent: typeof serializedContent = [];
      if (hasAccumulatedText) {
        initialContent.push({ type: 'text' as const, text: state.streamingContent.text });
        state.streamingContent.text = '';
      } else if (!hasStreamingText && textContent.length > 0) {
        initialContent.push(...textContent);
      }
      initialContent.push(...nonTextContent);
      state.pendingAssistant = {
        id: msg.message.id,
        model: msg.message.model,
        stopReason: msg.message.stop_reason,
        stopDetails: msg.message.stop_details ?? null,
        content: initialContent,
        sessionId: msg.session_id,
        parentToolUseId,
      };
    } else {
      if (hasAccumulatedText) {
        commitStreamingText(state.streamingContent, state.pendingAssistant);
      } else if (!hasStreamingText && textContent.length > 0) {
        state.pendingAssistant.content.push(...textContent);
      }
      const existingToolIds = new Set(
        state.pendingAssistant.content
          .filter((b): b is ToolUseBlock => b.type === 'tool_use')
          .map((b) => b.id)
      );
      const newNonTextContent = nonTextContent.filter(
        (b) => b.type !== 'tool_use' || !existingToolIds.has((b as { id: string }).id)
      );
      state.pendingAssistant.content.push(...newNonTextContent);
      state.pendingAssistant.stopReason = msg.message.stop_reason;
      state.pendingAssistant.stopDetails = msg.message.stop_details ?? null;
    }
  };

  return { assistant: handler };
}
