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
        ...(msg.editLineNumber ? { metadata: { editLineNumber: msg.editLineNumber } } : {}),
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
          ...(toolCall.metadata !== undefined && { metadata: toolCall.metadata }),
        });
        streamingStore.updateToolStatus(toolCall.id, "awaiting_approval");
      }

      const agentDescription = parentToolUseId ? subagentStore.getSubagentDescription(parentToolUseId) : undefined;

      // `PendingPermissionInfo` declares these optional, so an absent field is forwarded as an
      // absent key rather than an explicit undefined that a later spread could use to clobber.
      permissionStore.addPermission(msg.toolUseId, {
        toolName: msg.toolName,
        ...(msg.filePath !== undefined && { filePath: msg.filePath }),
        ...(msg.originalContent !== undefined && { originalContent: msg.originalContent }),
        ...(msg.proposedContent !== undefined && { proposedContent: msg.proposedContent }),
        ...(msg.command !== undefined && { command: msg.command }),
        ...(parentToolUseId !== undefined && { parentToolUseId }),
        ...(agentDescription !== undefined && { agentDescription }),
        ...(msg.suggestions !== undefined && { suggestions: msg.suggestions }),
        ...(msg.blockedPath !== undefined && { blockedPath: msg.blockedPath }),
        ...(msg.decisionReason !== undefined && { decisionReason: msg.decisionReason }),
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
        ...(parentToolUseId !== undefined && { parentToolUseId }),
        ...(agentDescription !== undefined && { agentDescription }),
      });
    },

    requestForm: (msg, ctx) => {
      const { subagentStore, formStore } = ctx.stores;
      const parentToolUseId = msg.parentToolUseId;
      const agentDescription = parentToolUseId ? subagentStore.getSubagentDescription(parentToolUseId) : undefined;

      formStore.setForm({
        toolUseId: msg.toolUseId,
        form: msg.form,
        ...(parentToolUseId !== undefined && { parentToolUseId }),
        ...(agentDescription !== undefined && { agentDescription }),
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
        ...(msg.skillDescription !== undefined && { skillDescription: msg.skillDescription }),
      });
      if (msg.skillDescription) {
        streamingStore.updateToolMetadata(msg.toolUseId, {
          skillDescription: msg.skillDescription,
        });
      }
    },

    requestElicitation: (msg, ctx) => {
      ctx.stores.elicitationStore.addElicitation({
        elicitationId: msg.elicitationId,
        serverName: msg.serverName,
        message: msg.message,
        mode: msg.mode,
        ...(msg.url !== undefined ? { url: msg.url } : {}),
        ...(msg.requestedSchema !== undefined ? { requestedSchema: msg.requestedSchema } : {}),
      });
    },
  };
}
