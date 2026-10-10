import { TOOL_AGENT, TEAM_CREATE_TOOL } from "@shared/tool-names";
import type { HandlerRegistry } from "../types";
import { extractDenialFeedback } from "../utils";
import { takeRejectedCancels } from "@/composables/useToolCancel";
import { endedSubagentStatus } from "@/stores/useSubagentStore";

export function createToolHandlers(): Partial<HandlerRegistry> {
  return {
    toolStreaming: (msg, ctx) => {
      const { uiStore, streamingStore, sessionStore, subagentStore, teamStore } = ctx.stores;
      const targetMsgId = msg.messageId;
      const parentToolUseId = msg.parentToolUseId;
      uiStore.setCurrentRunningTool(msg.tool.name);
      const hasSubagent = parentToolUseId ? subagentStore.hasSubagent(parentToolUseId) : false;

      if (msg.tool.name === TOOL_AGENT) {
        subagentStore.registerAgentTool(
          msg.tool.id,
          msg.tool.input as { description?: string; prompt?: string; subagent_type?: string; run_in_background?: boolean; resume?: string; message?: string }
        );
      }

      if (msg.tool.name === TEAM_CREATE_TOOL) {
        teamStore.registerTeamFromTool(
          msg.tool.id,
          msg.tool.input as { title?: string; agents?: Array<{ name: string; role: string }> },
        );
      }

      if (parentToolUseId && hasSubagent) {
        subagentStore.addToolCallToSubagent(parentToolUseId, {
          id: msg.tool.id,
          name: msg.tool.name,
          input: msg.tool.input,
          status: "running",
        });
        sessionStore.trackFileAccess(msg.tool.name, msg.tool.input);
        return;
      }

      streamingStore.getOrCreateStreamingMessage(targetMsgId);
      streamingStore.addToolCall(msg.tool, msg.contentBlocks, targetMsgId);
      sessionStore.trackFileAccess(msg.tool.name, msg.tool.input);
    },

    toolPending: (msg, ctx) => {
      const { streamingStore, subagentStore } = ctx.stores;
      if (msg.parentToolUseId && subagentStore.hasSubagent(msg.parentToolUseId)) {
        subagentStore.addToolCallToSubagent(msg.parentToolUseId, {
          id: msg.toolUseId,
          name: msg.toolName,
          input: typeof msg.input === 'object' && msg.input !== null ? msg.input as Record<string, unknown> : {},
          status: 'running',
        });
      }
      const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, "running");
      if (!found) {
        streamingStore.updateToolStatus(msg.toolUseId, "running");
      }
    },

    toolMetadata: (msg, ctx) => {
      const { streamingStore, subagentStore } = ctx.stores;
      const found = subagentStore.updateSubagentToolMetadata(msg.toolUseId, msg.metadata);
      if (!found) {
        streamingStore.updateToolMetadata(msg.toolUseId, msg.metadata);
      }
    },

    toolCompleted: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore } = ctx.stores;

      if (msg.parentToolUseId && subagentStore.hasSubagent(msg.parentToolUseId) && msg.toolName !== TOOL_AGENT) {
        subagentStore.addToolCallToSubagent(msg.parentToolUseId, {
          id: msg.toolUseId,
          name: msg.toolName,
          input: {},
          status: 'completed',
          result: msg.result,
          ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
          ...(msg.imageCount !== undefined && { imageCount: msg.imageCount }),
        });
      }

      if (msg.toolName === TOOL_AGENT && subagentStore.hasSubagent(msg.toolUseId)) {
        try {
          const parsed = JSON.parse(msg.result);
          if (parsed.status === 'queued_to_running' || parsed.status === 'async_launched') {
            uiStore.setCurrentRunningTool(null);
            return;
          }
          const agentStatus: unknown = parsed.agentStatus;
          const status = endedSubagentStatus(typeof agentStatus === "string" ? agentStatus : "completed");
          subagentStore.updateSubagentToolStatus(msg.toolUseId, status, msg.result, undefined, msg.durationMs, msg.imageCount);
          // Before setSubagentResult, which ends a card still running as completed.
          subagentStore.endSubagent(msg.toolUseId, status);
          const contentItems = parsed.content as Array<{ type: string; text?: string }> | undefined;
          const contentText =
            contentItems
              ?.filter((item) => item.type === "text" && item.text)
              .map((item) => item.text)
              .join("\n") || "";
          subagentStore.setSubagentResult(msg.toolUseId, {
            content: contentText,
            totalDurationMs: parsed.totalDurationMs,
            totalTokens: parsed.totalTokens,
            totalToolUseCount: parsed.totalToolUseCount,
            sdkAgentId: parsed.agentId,
          });
        } catch {
          console.warn("[tool-handlers] Failed to parse Agent tool result");
          subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result, undefined, msg.durationMs, msg.imageCount);
        }
      } else {
        const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result, undefined, msg.durationMs, msg.imageCount);
        if (!found) {
          streamingStore.updateToolStatus(msg.toolUseId, "completed", {
            result: msg.result,
            ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
            ...(msg.imageCount !== undefined && { imageCount: msg.imageCount }),
          });
        }
      }

      uiStore.setCurrentRunningTool(null);
    },

    toolFailed: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore } = ctx.stores;
      const feedback = extractDenialFeedback(msg.error);
      const status = feedback !== undefined ? "denied" : "failed";

      if (msg.parentToolUseId && subagentStore.hasSubagent(msg.parentToolUseId) && msg.toolName !== TOOL_AGENT) {
        subagentStore.addToolCallToSubagent(msg.parentToolUseId, {
          id: msg.toolUseId,
          name: msg.toolName,
          input: {},
          status,
          errorMessage: msg.error,
          ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
        });
      }

      const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, status, undefined, msg.error, msg.durationMs);
      if (!found) {
        streamingStore.updateToolStatus(msg.toolUseId, status, {
          errorMessage: msg.error,
          ...(feedback !== undefined && { feedback }),
          ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
        });
      }
      if (msg.toolName === TOOL_AGENT && subagentStore.hasSubagent(msg.toolUseId)) {
        subagentStore.failSubagent(msg.toolUseId);
      }
      if (msg.toolName === TEAM_CREATE_TOOL) {
        ctx.stores.teamStore.failPendingTeamByToolUseId(msg.toolUseId);
      }
      uiStore.setCurrentRunningTool(null);
    },

    toolAbandoned: (msg, ctx) => {
      const { streamingStore, subagentStore } = ctx.stores;
      const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, "abandoned", undefined, undefined, undefined, undefined, msg.reason);
      if (!found) {
        streamingStore.updateToolStatus(msg.toolUseId, "abandoned", { abandonReason: msg.reason });
      }
    },

    toolCancelRejected: (msg, ctx) => {
      const { streamingStore, subagentStore, teamStore } = ctx.stores;
      for (const rejected of takeRejectedCancels(msg.toolUseId, msg.requestId)) {
        switch (rejected.source) {
          case "session":
            streamingStore.clearToolCancelRequested(rejected.toolUseId);
            break;
          case "subagent":
            subagentStore.clearSubagentToolCancelRequested(rejected.toolUseId);
            break;
          case "team":
            teamStore.clearAgentToolCancelRequested(rejected.toolUseId);
            break;
        }
      }
    },

    toolProgress: (msg, ctx) => {
      const { streamingStore, subagentStore } = ctx.stores;
      // Every frame carries the elapsed time, and for a shell tool every frame also carries output, so
      // recording it after the output branch would mean those tools never record an elapsed time at all.
      const inSubagent = subagentStore.updateSubagentToolMetadata(msg.toolUseId, {
        elapsedTimeSeconds: msg.elapsedTimeSeconds,
      });
      if (!inSubagent) {
        streamingStore.updateToolElapsedTime(msg.toolUseId, msg.elapsedTimeSeconds);
      }

      if (msg.output === undefined) return;
      const output = msg.output;
      const truncated = msg.outputTruncated === true;
      if (inSubagent) {
        subagentStore.updateSubagentToolLiveOutput(msg.toolUseId, output, truncated);
      } else {
        streamingStore.updateToolLiveOutput(msg.toolUseId, output, truncated);
      }
    },

    toolUseSummary: (msg, ctx) => {
      ctx.stores.streamingStore.updateToolSummary(msg.precedingToolUseIds, msg.summary);
    },
  };
}
