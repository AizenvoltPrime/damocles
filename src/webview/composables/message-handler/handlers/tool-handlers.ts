import { TOOL_AGENT, TOOL_TASK_CREATE, TOOL_TASK_UPDATE, TOOL_TASK_LIST, TOOL_TASK_GET, TASK_MANAGEMENT_TOOLS } from "@shared/tool-names";
import type { HandlerRegistry } from "../types";
import { extractUserDenialFeedback } from "../utils";

export function createToolHandlers(): Partial<HandlerRegistry> {
  return {
    toolStreaming: (msg, ctx) => {
      const { uiStore, streamingStore, sessionStore, subagentStore, taskStore } = ctx.stores;
      const targetMsgId = msg.messageId;
      const parentToolUseId = msg.parentToolUseId;
      uiStore.setCurrentRunningTool(msg.tool.name);
      const hasSubagent = parentToolUseId ? subagentStore.hasSubagent(parentToolUseId) : false;

      if (msg.tool.name === TOOL_AGENT) {
        subagentStore.registerAgentTool(
          msg.tool.id,
          msg.tool.input as { description?: string; prompt?: string; subagent_type?: string }
        );
      }

      if (msg.tool.name === TOOL_TASK_CREATE || msg.tool.name === TOOL_TASK_UPDATE) {
        taskStore.trackToolInput(msg.tool.id, msg.tool.input);
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
      const { uiStore, streamingStore, subagentStore, taskStore } = ctx.stores;

      if (msg.toolName === TOOL_AGENT && subagentStore.hasSubagent(msg.toolUseId)) {
        try {
          const parsed = JSON.parse(msg.result);
          if (parsed.status === 'queued_to_running') {
            uiStore.setCurrentRunningTool(null);
            return;
          }
          subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result);
          subagentStore.completeSubagent(msg.toolUseId);
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
          subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result);
        }
      } else {
        const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result);
        if (!found) {
          streamingStore.updateToolStatus(msg.toolUseId, "completed", { result: msg.result });
        }
      }

      if (TASK_MANAGEMENT_TOOLS.has(msg.toolName)) {
        try {
          const result = JSON.parse(msg.result);
          switch (msg.toolName) {
            case TOOL_TASK_CREATE:
              taskStore.handleTaskCreate(msg.toolUseId, result);
              uiStore.setTasksPanelCollapsed(false);
              break;
            case TOOL_TASK_UPDATE:
              taskStore.handleTaskUpdate(msg.toolUseId, result);
              break;
            case TOOL_TASK_LIST:
              taskStore.handleTaskList(result);
              break;
            case TOOL_TASK_GET:
              taskStore.handleTaskGet(result);
              break;
          }
        } catch {
          console.warn("[tool-handlers] Failed to parse Task* tool result");
        }
      }

      uiStore.setCurrentRunningTool(null);
    },

    toolFailed: (msg, ctx) => {
      const { uiStore, streamingStore, subagentStore } = ctx.stores;
      const feedback = extractUserDenialFeedback(msg.error);
      const isUserDenial = feedback !== undefined;
      const status = isUserDenial ? "denied" : "failed";

      const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, status, undefined, msg.error);
      if (!found) {
        streamingStore.updateToolStatus(msg.toolUseId, status, {
          errorMessage: msg.error,
          feedback,
        });
      }
      if (msg.toolName === TOOL_AGENT && subagentStore.hasSubagent(msg.toolUseId)) {
        subagentStore.failSubagent(msg.toolUseId);
      }
      uiStore.setCurrentRunningTool(null);
    },

    toolAbandoned: (msg, ctx) => {
      const { streamingStore, subagentStore } = ctx.stores;
      const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, "abandoned");
      if (!found) {
        streamingStore.updateToolStatus(msg.toolUseId, "abandoned");
      }
    },

    toolProgress: (msg, ctx) => {
      const { streamingStore, subagentStore } = ctx.stores;
      const found = subagentStore.updateSubagentToolMetadata(msg.toolUseId, {
        elapsedTimeSeconds: msg.elapsedTimeSeconds,
      });
      if (!found) {
        streamingStore.updateToolElapsedTime(msg.toolUseId, msg.elapsedTimeSeconds);
      }
    },

    toolUseSummary: (msg, ctx) => {
      ctx.stores.streamingStore.updateToolSummary(msg.precedingToolUseIds, msg.summary);
    },
  };
}
