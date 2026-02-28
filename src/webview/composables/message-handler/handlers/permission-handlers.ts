import type { HandlerRegistry } from "../types";
import type { ToolCall } from "@shared/types/session";
import { TOOL_EDIT, TOOL_WRITE } from "@shared/tool-names";

export function createPermissionHandlers(): Partial<HandlerRegistry> {
  return {
    requestPermission: (msg, ctx) => {
      const { streamingStore, sessionStore, subagentStore, permissionStore } = ctx.stores;
      const parentToolUseId = msg.parentToolUseId;
      const hasSubagent = parentToolUseId ? subagentStore.hasSubagent(parentToolUseId) : false;

      const toolCall: ToolCall = {
        id: msg.toolUseId,
        name: msg.toolName,
        input: msg.toolInput,
        status: "awaiting_approval",
        metadata: msg.editLineNumber ? { editLineNumber: msg.editLineNumber } : undefined,
      };

      if (msg.toolName === TOOL_EDIT || msg.toolName === TOOL_WRITE) {
        sessionStore.trackFileAccess(msg.toolName, msg.toolInput);
      }

      if (parentToolUseId && hasSubagent) {
        subagentStore.addToolCallToSubagent(parentToolUseId, toolCall);
      } else {
        streamingStore.addToolCall({
          id: toolCall.id,
          name: toolCall.name,
          input: toolCall.input,
          metadata: toolCall.metadata,
        });
        streamingStore.updateToolStatus(toolCall.id, "awaiting_approval");
      }

      const agentDescription = parentToolUseId ? subagentStore.getSubagentDescription(parentToolUseId) : undefined;

      permissionStore.addPermission(msg.toolUseId, {
        toolName: msg.toolName,
        filePath: msg.filePath,
        originalContent: msg.originalContent,
        proposedContent: msg.proposedContent,
        command: msg.command,
        parentToolUseId,
        agentDescription,
        suggestions: msg.suggestions,
        blockedPath: msg.blockedPath,
        decisionReason: msg.decisionReason,
      });
    },

    permissionAutoResolved: (msg, ctx) => {
      const { streamingStore, subagentStore, permissionStore } = ctx.stores;
      permissionStore.removePermission(msg.toolUseId);

      if (permissionStore.pendingPlanApproval?.toolUseId === msg.toolUseId) {
        permissionStore.clearPendingPlanApproval();
      }

      const found = subagentStore.updateSubagentToolStatus(msg.toolUseId, "approved");
      if (!found) {
        streamingStore.updateToolStatus(msg.toolUseId, "approved");
      }
    },

    requestQuestion: (msg, ctx) => {
      const { subagentStore, questionStore } = ctx.stores;
      const parentToolUseId = msg.parentToolUseId;
      const agentDescription = parentToolUseId ? subagentStore.getSubagentDescription(parentToolUseId) : undefined;

      questionStore.setQuestion({
        toolUseId: msg.toolUseId,
        questions: msg.questions,
        parentToolUseId,
        agentDescription,
      });
    },

    requestPlanApproval: (msg, ctx) => {
      ctx.stores.streamingStore.updateToolStatus(msg.toolUseId, "awaiting_approval");
      ctx.stores.permissionStore.setPendingPlanApproval({
        toolUseId: msg.toolUseId,
        planContent: msg.planContent,
      });
    },

    requestSkillApproval: (msg, ctx) => {
      const { streamingStore, permissionStore } = ctx.stores;
      permissionStore.setPendingSkillApproval({
        toolUseId: msg.toolUseId,
        skillName: msg.skillName,
        skillDescription: msg.skillDescription,
      });
      if (msg.skillDescription) {
        streamingStore.updateToolMetadata(msg.toolUseId, {
          skillDescription: msg.skillDescription,
        });
      }
    },
  };
}
