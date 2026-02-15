import { nextTick } from "vue";
import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { HandlerRegistry } from "../types";
import type { ChatMessage } from "@shared/types/session";
import type { HistoryMessage } from "@shared/types/content";
import { convertHistoryTools } from "../utils";

export function createHistoryHandlers(): Partial<HandlerRegistry> {
  return {
    userReplay: (msg, ctx) => {
      ctx.stores.streamingStore.addUserMessage(
        msg.contentBlocks ?? msg.content,
        true,
        msg.sdkMessageId,
        msg.isInjected
      );
    },

    assistantReplay: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, taskStore } = ctx.stores;

      if (msg.tools) {
        for (const tool of msg.tools) {
          if (tool.name === "Task") {
            subagentStore.restoreSubagentFromHistory(tool);
          }
          if (tool.name === "TaskList" && tool.result) {
            try {
              const result = JSON.parse(tool.result);
              taskStore.handleTaskList(result);
              uiStore.setTasksPanelCollapsed(false);
            } catch {
              // ignore parse errors
            }
          }
        }
      }

      streamingStore.addMessage({
        role: "assistant",
        content: msg.content,
        thinking: msg.thinking,
        toolCalls: convertHistoryTools(msg.tools),
        contentBlocks: msg.contentBlocks,
        timestamp: Date.now(),
        isReplay: true,
      });
    },

    errorReplay: (msg, ctx) => {
      ctx.stores.streamingStore.addMessage({
        role: "error",
        content: msg.content,
        timestamp: Date.now(),
        isReplay: true,
      });
    },

    historyChunk: (msg, ctx) => {
      const { sessionStore, streamingStore, subagentStore } = ctx.stores;
      const { refs } = ctx;

      sessionStore.updateHistoryPagination(msg.hasMore, msg.nextOffset, msg.promptIndexOffset);

      if (msg.messages.length > 0) {
        const container = refs.messageContainerRef.value;
        const previousScrollHeight = container?.scrollHeight || 0;

        for (const historyMsg of msg.messages) {
          if (historyMsg.tools) {
            for (const tool of historyMsg.tools) {
              if (tool.name === "Task") {
                subagentStore.restoreSubagentFromHistory(tool);
              }
            }
          }
        }

        const olderMessages: ChatMessage[] = msg.messages.map((historyMsg: HistoryMessage) => ({
          id: streamingStore.generateId(),
          sdkMessageId: historyMsg.sdkMessageId,
          role: historyMsg.type,
          content: historyMsg.content,
          contentBlocks: historyMsg.contentBlocks,
          thinking: historyMsg.thinking,
          toolCalls: convertHistoryTools(historyMsg.tools),
          timestamp: Date.now(),
          isReplay: true,
          isInjected: historyMsg.isInjected,
        }));

        streamingStore.prependMessages(olderMessages);

        nextTick(() => {
          if (container) {
            const newScrollHeight = container.scrollHeight;
            container.scrollTop = newScrollHeight - previousScrollHeight;
          }
        });
      }
    },

    checkpointInfo: (msg, ctx) => {
      ctx.stores.sessionStore.setCheckpointMessages(msg.checkpoints.map((cp: { userMessageId: string }) => cp.userMessageId));
    },

    rewindHistory: (msg, ctx) => {
      ctx.stores.uiStore.setRewindHistory(msg.prompts);
    },

    rewindComplete: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, taskStore } = ctx.stores;
      const { refs } = ctx;
      const option = msg.option;
      const truncateConversation = option === "code-and-conversation" || option === "conversation-only";

      if (truncateConversation) {
        subagentStore.$reset();
        taskStore.clearTasks();
        uiStore.setTasksPanelCollapsed(true);

        const removedContent = streamingStore.truncateToMessage(msg.rewindToMessageId, msg.promptContent);
        if (removedContent !== null) {
          refs.chatInputRef.value?.setInput(removedContent);
          if (option === "code-and-conversation") {
            toast.success(i18n.global.t("toast.rewindBoth"));
          } else {
            toast.success(i18n.global.t("toast.rewindConversation"));
          }
        } else {
          toast.warning(i18n.global.t("toast.truncateFailed"));
          if (option === "code-and-conversation") {
            toast.success(i18n.global.t("toast.rewindFilesPartial"));
          }
        }
      } else {
        toast.success(i18n.global.t("toast.rewindFiles"));
      }
    },

    rewindError: (msg) => {
      toast.error(i18n.global.t("toast.rewindFailed", { message: msg.message }));
    },

    compactBoundary: (msg, ctx) => {
      const { sessionStore, streamingStore } = ctx.stores;

      if (!msg.isHistorical) {
        sessionStore.clearCompactMarkers();
      }
      const compactMessage = [...streamingStore.messages]
        .reverse()
        .find((m) => m.role === "user" && m.content.trim().toLowerCase().startsWith("/compact"));
      const cutoffTimestamp = compactMessage?.timestamp;
      sessionStore.addCompactMarker(msg.trigger, msg.preTokens, msg.postTokens, msg.summary, msg.timestamp, cutoffTimestamp);
    },

    compactSummary: (msg, ctx) => {
      const { sessionStore, streamingStore } = ctx.stores;
      const markers = sessionStore.compactMarkers;
      const lastMarker = markers.length > 0 ? markers[markers.length - 1] : null;
      if (lastMarker) {
        const cutoff = lastMarker.messageCutoffTimestamp ?? lastMarker.timestamp;
        streamingStore.truncateMessagesBeforeTimestamp(cutoff);
      }
      sessionStore.updateLastCompactMarkerSummary(msg.summary);
    },

    promptHistory: () => {},

    promptHistoryPush: () => {},
  };
}
