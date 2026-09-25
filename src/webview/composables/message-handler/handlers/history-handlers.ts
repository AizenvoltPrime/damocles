import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { HandlerRegistry } from "../types";
import { convertHistoryTools, toUserContentBlocks } from "../utils";
import { TOOL_AGENT, TOOL_TASK_LIST, TEAM_CREATE_TOOL, TEAM_RESUME_TOOL } from "@shared/tool-names";
import { useExploreStore } from "@/stores/useExploreStore";
import { isImageBlock } from "@shared/types/content";

export function createHistoryHandlers(): Partial<HandlerRegistry> {
  return {
    userReplay: (msg, ctx) => {
      if (msg.steerTarget) {
        ctx.stores.streamingStore.addSteerChip(msg.content, msg.steerTarget, {
          promptIndex: msg.promptIndex,
          isReplay: true,
          images: msg.contentBlocks?.filter(isImageBlock),
        });
        return;
      }
      ctx.stores.streamingStore.addUserMessage(
        toUserContentBlocks(msg.contentBlocks) ?? msg.content,
        true,
        msg.sdkMessageId,
        msg.isInjected,
        undefined,
        msg.promptIndex,
        msg.isMidStream,
      );
    },

    assistantReplay: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, taskStore, teamStore } = ctx.stores;

      if (msg.tools) {
        for (const tool of msg.tools) {
          if (tool.name === TOOL_AGENT && !useExploreStore().hasExplore(tool.id)) {
            subagentStore.restoreSubagentFromHistory(tool);
          }
          if (tool.name === TEAM_CREATE_TOOL) {
            teamStore.registerTeamFromTool(
              tool.id,
              tool.input as { title?: string; agents?: Array<{ name: string; role: string }> },
              {
                status: tool.isError ? 'failed' : tool.result ? 'completed' : 'cancelled',
                ...(tool.result !== undefined && { result: tool.result }),
              },
            );
            // registerTeamFromTool only has the create_team input (title + roster). Pull the full
            // persisted team (per-agent models, tokens, tool counts, aggregate stats) so the historical
            // card matches a freshly-run one instead of showing zeros until the overlay is opened.
            ctx.vscode.postMessage({ type: 'requestTeamDataByToolUse', toolUseId: tool.id });
          }
          // The host resolves a resume call to its team through the call's invocation entry.
          if (tool.name === TEAM_RESUME_TOOL && !tool.isError) {
            ctx.vscode.postMessage({ type: 'requestTeamDataByToolUse', toolUseId: tool.id });
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

      const toolCalls = convertHistoryTools(msg.tools);
      streamingStore.addMessage({
        role: "assistant",
        content: msg.content,
        ...(msg.thinking !== undefined && { thinking: msg.thinking }),
        ...(toolCalls !== undefined && { toolCalls }),
        ...(msg.contentBlocks !== undefined && { contentBlocks: msg.contentBlocks }),
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
      sessionStore.addCompactMarker(msg.trigger, msg.preTokens, msg.postTokens, msg.summary, msg.timestamp, cutoffTimestamp, msg.entryId, msg.billedTokens, msg.billedCost);
    },

    cacheMissNotice: (msg, ctx) => {
      ctx.stores.sessionStore.addCacheMissNotice(msg.missedTokens, msg.missedCost, msg.idleMs, msg.modelChanged, msg.timestamp);
    },

    compactionAborted: (msg, ctx) => {
      ctx.stores.sessionStore.addCompactionAbortedNotice(msg.trigger, msg.willRetry, msg.timestamp, msg.errorMessage);
    },

    thinkingDroppedNotice: (msg, ctx) => {
      ctx.stores.sessionStore.addThinkingDroppedNotice(msg.count, msg.reasons, msg.timestamp);
    },

    compactSummary: (msg, ctx) => {
      const { sessionStore, streamingStore } = ctx.stores;
      const markers = sessionStore.compactMarkers;
      const lastMarker = markers.length > 0 ? markers[markers.length - 1] : null;
      if (lastMarker) {
        // The summary is the only point a compaction removes messages, so the notices anchored to them go here.
        const cutoff = lastMarker.messageCutoffTimestamp ?? lastMarker.timestamp;
        streamingStore.truncateMessagesBeforeTimestamp(cutoff);
        sessionStore.dropTruncatedNotices(cutoff);
      }
      sessionStore.updateLastCompactMarkerSummary(msg.summary);
    },

    promptHistory: () => {},

    promptHistoryPush: () => {},
  };
}
