import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { HandlerRegistry } from "../types";
import { convertHistoryTools } from "../utils";
import { TOOL_AGENT, TOOL_TASK_LIST, TOOL_MONITOR, TEAM_CREATE_TOOL } from "@shared/tool-names";

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
      const { uiStore, streamingStore, subagentStore, taskStore, teamStore, monitorStore } = ctx.stores;

      if (msg.tools) {
        for (const tool of msg.tools) {
          if (tool.name === TOOL_AGENT) {
            subagentStore.restoreSubagentFromHistory(tool);
          }
          if (tool.name === TEAM_CREATE_TOOL) {
            teamStore.registerTeamFromTool(
              tool.id,
              tool.input as { title?: string; agents?: Array<{ name: string; role: string }> },
              { status: tool.isError ? 'failed' : tool.result ? 'completed' : 'cancelled', result: tool.result },
            );
          }
          if (tool.name === TOOL_MONITOR) {
            monitorStore.restoreFromHistory(
              tool.id,
              tool.input as Record<string, unknown>,
              tool.metadata as Record<string, unknown> | null | undefined,
            );
          }
          if (tool.name === TOOL_TASK_LIST && tool.result) {
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

    checkpointInfo: (msg, ctx) => {
      ctx.stores.sessionStore.setCheckpointMessages(msg.userMessageIds);
    },

    rewindHistory: (msg, ctx) => {
      ctx.stores.uiStore.setRewindHistory(msg.prompts);
    },

    rewindComplete: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, taskStore, monitorStore } = ctx.stores;
      const { refs } = ctx;
      const option = msg.option;
      const truncateConversation = option === "code-and-conversation" || option === "conversation-only";

      if (truncateConversation) {
        subagentStore.$reset();
        monitorStore.$reset();
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
