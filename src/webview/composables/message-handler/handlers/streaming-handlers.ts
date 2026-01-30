import type { HandlerRegistry, ScrollBehavior } from "../types";
import type { ChatMessage } from "@shared/types/session";

export function createStreamingHandlers(): Partial<HandlerRegistry> {
  return {
    userMessage: (msg, ctx): ScrollBehavior => {
      ctx.stores.streamingStore.addUserMessage(
        msg.contentBlocks ?? msg.content,
        false,
        undefined,
        undefined,
        msg.correlationId
      );
      return { forceScrollToBottom: true };
    },

    userMessageIdAssigned: (msg, ctx) => {
      ctx.stores.streamingStore.assignSdkIdByCorrelationId(msg.correlationId, msg.sdkMessageId);
    },

    assistant: (msg, ctx) => {
      const { streamingStore, sessionStore, subagentStore } = ctx.stores;
      const assistantMsg = msg.data;
      const msgId = assistantMsg.message.id;
      const parentToolUseId = msg.parentToolUseId;
      const textContent = streamingStore.extractTextFromContent(assistantMsg.message.content);
      const toolCalls = streamingStore.extractToolCalls(assistantMsg.message.content);
      const thinkingContent = streamingStore.extractThinkingContent(assistantMsg.message.content);
      const hasSubagent = parentToolUseId ? subagentStore.hasSubagent(parentToolUseId) : false;

      for (const tool of toolCalls) {
        sessionStore.trackFileAccess(tool.name, tool.input);
      }

      if (parentToolUseId && hasSubagent) {
        const subagentContentBlocks = assistantMsg.message.content.filter(
          (block): block is
            | { type: "text"; text: string }
            | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
            | { type: "thinking"; thinking: string } =>
            block.type === "text" || block.type === "tool_use" || block.type === "thinking"
        );
        const subagentToolCalls = subagentStore.buildToolCallsWithStatus(parentToolUseId, subagentContentBlocks);
        const subagentMsg: ChatMessage = {
          id: streamingStore.generateId(),
          sdkMessageId: msgId,
          role: "assistant",
          content: textContent,
          contentBlocks: subagentContentBlocks.length > 0 ? subagentContentBlocks : undefined,
          toolCalls: subagentToolCalls.length > 0 ? subagentToolCalls : undefined,
          timestamp: Date.now(),
          parentToolUseId,
        };
        subagentStore.addMessageToSubagent(parentToolUseId, subagentMsg);
        sessionStore.setCurrentSession(assistantMsg.session_id);
        return;
      }

      const contentBlocks = assistantMsg.message.content.filter(
        (block): block is { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> } =>
          block.type === "text" || block.type === "tool_use"
      );

      const currentMsg = streamingStore.getOrCreateStreamingMessage(msgId);

      const updates: Partial<ChatMessage> = {};
      if (textContent) {
        updates.content = textContent;
      }
      if (contentBlocks.length > 0) {
        updates.contentBlocks = contentBlocks;
      }
      if (thinkingContent) {
        updates.thinking = thinkingContent;
      }
      if (toolCalls.length > 0) {
        updates.toolCalls = streamingStore.mergeToolCalls(currentMsg.toolCalls, toolCalls);
      }
      if (toolCalls.length > 0 || textContent) {
        updates.isThinkingPhase = false;
      }
      if (Object.keys(updates).length > 0) {
        streamingStore.updateStreamingMessage(updates, msgId);
      }

      sessionStore.setCurrentSession(assistantMsg.session_id);
    },

    partial: (msg, ctx) => {
      const { streamingStore, subagentStore } = ctx.stores;
      const partialData = msg.data;
      const msgId = partialData.messageId ?? undefined;
      const parentToolUseId = msg.parentToolUseId;

      if (parentToolUseId && subagentStore.hasSubagent(parentToolUseId) && msgId) {
        subagentStore.updateSubagentStreaming(parentToolUseId, msgId, {
          content: partialData.streamingText,
          thinking: partialData.streamingThinking,
          thinkingDuration: partialData.thinkingDuration,
          isThinkingPhase: partialData.isThinking,
        });
        return;
      }

      const currentMsg = streamingStore.getOrCreateStreamingMessage(msgId);

      const updates: Partial<ChatMessage> = {};
      if (partialData.streamingThinking !== undefined) {
        updates.thinking = partialData.streamingThinking;
      }
      if (partialData.streamingText !== undefined) {
        updates.content = partialData.streamingText;
      }
      if (partialData.thinkingDuration !== undefined) {
        updates.thinkingDuration = partialData.thinkingDuration;
      }
      if (!currentMsg.toolCalls || currentMsg.toolCalls.length === 0) {
        updates.isThinkingPhase = partialData.isThinking ?? false;
      }
      if (Object.keys(updates).length > 0) {
        streamingStore.updateStreamingMessage(updates, msgId);
      }
    },

    done: (msg, ctx) => {
      const { streamingStore, sessionStore } = ctx.stores;
      const resultData = msg.data;
      streamingStore.finalizeStreamingMessage();
      sessionStore.updateStats({
        ...(resultData.total_cost_usd !== undefined && { totalCostUsd: resultData.total_cost_usd }),
        ...(resultData.total_output_tokens !== undefined && { totalOutputTokens: resultData.total_output_tokens }),
        ...(resultData.num_turns !== undefined && { numTurns: resultData.num_turns }),
        ...(resultData.context_window_size !== undefined && { contextWindowSize: resultData.context_window_size }),
      });
      if (resultData.session_id) {
        sessionStore.setResumedSession(resultData.session_id);
      }
    },

    processing: (msg, ctx) => {
      const { uiStore, streamingStore } = ctx.stores;
      uiStore.setProcessing(msg.isProcessing);
      if (!msg.isProcessing && streamingStore.streamingMessageId) {
        streamingStore.finalizeStreamingMessage();
      }
    },

    error: (msg, ctx) => {
      ctx.stores.streamingStore.addErrorMessage(msg.message);
    },
  };
}
