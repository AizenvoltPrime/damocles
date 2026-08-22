import { TOOL_AGENT, TOOL_TASK_CREATE, TOOL_TASK_UPDATE, TOOL_TASK_LIST, TOOL_TASK_GET, TASK_MANAGEMENT_TOOLS, TEAM_CREATE_TOOL, TOOL_MONITOR } from "@shared/tool-names";
import type { TaskCreateInput, TaskUpdateInput, TaskUpdateStatus } from "@shared/types/subagents";
import type { HandlerRegistry } from "../types";
import { extractDenialFeedback } from "../utils";

function str(bag: Record<string, unknown>, key: string): string | undefined {
  const value = bag[key];
  return typeof value === "string" ? value : undefined;
}

function record(bag: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = bag[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/**
 * Tool inputs arrive as untyped agent JSON, so the required key is read rather than asserted: a
 * TaskCreate with no subject is not a task the store can track, and asserting would hand it a
 * `subject` of `undefined` typed as `string`.
 */
function readTaskCreateInput(bag: Record<string, unknown>): TaskCreateInput | undefined {
  const subject = str(bag, "subject");
  if (subject === undefined) return undefined;
  const description = str(bag, "description");
  const activeForm = str(bag, "activeForm");
  const metadata = record(bag, "metadata");
  return {
    subject,
    ...(description !== undefined && { description }),
    ...(activeForm !== undefined && { activeForm }),
    ...(metadata !== undefined && { metadata }),
  };
}

function readTaskUpdateInput(bag: Record<string, unknown>): TaskUpdateInput | undefined {
  const taskId = str(bag, "taskId");
  if (taskId === undefined) return undefined;

  const status = str(bag, "status");
  const isUpdateStatus = (s: string): s is TaskUpdateStatus =>
    s === "pending" || s === "in_progress" || s === "completed" || s === "deleted";

  const strings = (key: string): string[] | undefined => {
    const value = bag[key];
    return Array.isArray(value) && value.every((v): v is string => typeof v === "string") ? value : undefined;
  };

  const subject = str(bag, "subject");
  const description = str(bag, "description");
  const activeForm = str(bag, "activeForm");
  const owner = str(bag, "owner");
  const metadata = record(bag, "metadata");
  const addBlocks = strings("addBlocks");
  const addBlockedBy = strings("addBlockedBy");

  return {
    taskId,
    ...(subject !== undefined && { subject }),
    ...(description !== undefined && { description }),
    ...(activeForm !== undefined && { activeForm }),
    ...(status !== undefined && isUpdateStatus(status) && { status }),
    ...(addBlocks !== undefined && { addBlocks }),
    ...(addBlockedBy !== undefined && { addBlockedBy }),
    ...(owner !== undefined && { owner }),
    ...(metadata !== undefined && { metadata }),
  };
}

export function createToolHandlers(): Partial<HandlerRegistry> {
  return {
    toolStreaming: (msg, ctx) => {
      const { uiStore, streamingStore, sessionStore, subagentStore, taskStore, teamStore } = ctx.stores;
      const targetMsgId = msg.messageId;
      const parentToolUseId = msg.parentToolUseId;
      uiStore.setCurrentRunningTool(msg.tool.name);
      const hasSubagent = parentToolUseId ? subagentStore.hasSubagent(parentToolUseId) : false;

      if (msg.tool.name === TOOL_AGENT) {
        subagentStore.registerAgentTool(
          msg.tool.id,
          msg.tool.input as { description?: string; prompt?: string; subagent_type?: string; run_in_background?: boolean }
        );
      }

      if (msg.tool.name === TEAM_CREATE_TOOL) {
        teamStore.registerTeamFromTool(
          msg.tool.id,
          msg.tool.input as { title?: string; agents?: Array<{ name: string; role: string }> },
        );
      }

      if (msg.tool.name === TOOL_TASK_CREATE) {
        const input = readTaskCreateInput(msg.tool.input);
        if (input) taskStore.trackToolInput(msg.tool.id, { tool: "TaskCreate", input });
      } else if (msg.tool.name === TOOL_TASK_UPDATE) {
        const input = readTaskUpdateInput(msg.tool.input);
        if (input) taskStore.trackToolInput(msg.tool.id, { tool: "TaskUpdate", input });
      }

      if (msg.tool.name === TOOL_MONITOR) {
        ctx.stores.monitorStore.trackInput(msg.tool.id, msg.tool.input);
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
      const { uiStore, streamingStore, subagentStore, taskStore } = ctx.stores;

      if (msg.parentToolUseId && subagentStore.hasSubagent(msg.parentToolUseId) && msg.toolName !== TOOL_AGENT) {
        subagentStore.addToolCallToSubagent(msg.parentToolUseId, {
          id: msg.toolUseId,
          name: msg.toolName,
          input: {},
          status: 'completed',
          result: msg.result,
          ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
        });
      }

      if (msg.toolName === TOOL_AGENT && subagentStore.hasSubagent(msg.toolUseId)) {
        try {
          const parsed = JSON.parse(msg.result);
          if (parsed.status === 'queued_to_running' || parsed.status === 'async_launched') {
            uiStore.setCurrentRunningTool(null);
            return;
          }
          subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result, undefined, msg.durationMs);
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
          subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result, undefined, msg.durationMs);
        }
      } else {
        const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, "completed", msg.result, undefined, msg.durationMs);
        if (!found) {
          streamingStore.updateToolStatus(msg.toolUseId, "completed", {
            result: msg.result,
            ...(msg.durationMs !== undefined && { durationMs: msg.durationMs }),
          });
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
      if (msg.toolName === TOOL_MONITOR) {
        ctx.stores.monitorStore.failByToolUseId(msg.toolUseId);
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
