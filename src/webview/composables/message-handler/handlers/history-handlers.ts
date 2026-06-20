import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { HandlerRegistry } from "../types";
import { convertHistoryTools } from "../utils";
import { TOOL_AGENT, TOOL_TASK_LIST, TOOL_MONITOR, TEAM_CREATE_TOOL } from "@shared/tool-names";
import { useExploreStore } from "@/stores/useExploreStore";

export function createHistoryHandlers(): Partial<HandlerRegistry> {
  return {
    userReplay: (msg, ctx) => {
      ctx.stores.streamingStore.addUserMessage(
        msg.contentBlocks ?? msg.content,
        true,
        msg.sdkMessageId,
        msg.isInjected,
        undefined,
        msg.promptIndex,
      );
    },

    assistantReplay: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, taskStore, teamStore, monitorStore } = ctx.stores;

      if (msg.tools) {
        for (const tool of msg.tools) {
          if (tool.name === TOOL_AGENT && !useExploreStore().hasExplore(tool.id)) {
            subagentStore.restoreSubagentFromHistory(tool);
          }
          if (tool.name === TEAM_CREATE_TOOL) {
            teamStore.registerTeamFromTool(
              tool.id,
              tool.input as { title?: string; agents?: Array<{ name: string; role: string }> },
              { status: tool.isError ? 'failed' : tool.result ? 'completed' : 'cancelled', result: tool.result },
            );
            // registerTeamFromTool only has the create_team input (title + roster). Pull the full
            // persisted team (per-agent models, tokens, tool counts, aggregate stats) so the historical
            // card matches a freshly-run one instead of showing zeros until the overlay is opened.
            ctx.vscode.postMessage({ type: 'requestTeamDataByToolUse', toolUseId: tool.id });
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
      ctx.stores.uiStore.setRewindHistory(msg.prompts, msg.canFork);
    },

    rewindComplete: (msg) => {
      if (msg.option === "code-only") {
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
