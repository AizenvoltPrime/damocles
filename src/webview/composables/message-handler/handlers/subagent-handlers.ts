import { i18n } from "@/i18n";
import type { HandlerRegistry } from "../types";

export function createSubagentHandlers(): Partial<HandlerRegistry> {
  return {
    subagentSteered: (msg, ctx) => {
      if (msg.status === "steered" || msg.status === "queued") {
        ctx.stores.streamingStore.addSteerChip(msg.message, {
          agentId: msg.agentId,
          ...(msg.agentType !== undefined && { agentType: msg.agentType }),
          ...(msg.description !== undefined && { description: msg.description }),
        });
        if (msg.toolUseId) ctx.stores.subagentStore.addUserMessageToSubagent(msg.toolUseId, msg.message);
        return;
      }
      const key = msg.status === "not-found" ? "notFound" : msg.status;
      ctx.stores.streamingStore.addErrorMessage(i18n.global.t(`steerCommand.${key}`));
    },

    subagentStart: (msg, ctx) => {
      ctx.stores.subagentStore.startSubagent(msg.agentId, msg.agentType, msg.toolUseId, msg.isBackground);
    },

    subagentStop: (msg, ctx) => {
      ctx.stores.subagentStore.stopSubagent(msg.toolUseId, msg.agentId, msg.lastAssistantMessage);
    },

    subagentModelUpdate: (msg, ctx) => {
      ctx.stores.subagentStore.updateSubagentModel(msg.agentToolId, msg.model);
    },

    subagentTemplateUpdate: (msg, ctx) => {
      ctx.stores.subagentStore.updateSubagentTemplate(msg.agentToolId, msg.templatePath);
    },

    subagentMessagesUpdate: (msg, ctx) => {
      ctx.stores.subagentStore.replaceSubagentMessages(msg.agentToolId, msg.messages);
    },

    taskStarted: (msg, ctx) => {
      if (msg.toolUseId) {
        ctx.stores.subagentStore.registerAgentTool(msg.toolUseId, {
          description: msg.description,
          ...(msg.taskType !== undefined && { subagent_type: msg.taskType }),
        });
        ctx.stores.subagentStore.resetToRunning(msg.toolUseId, msg.description, msg.isBackground);
      }
    },

    taskNotification: (msg, ctx) => {
      if (!msg.toolUseId) return;
      const { subagentStore } = ctx.stores;
      if (msg.status === "completed") {
        subagentStore.completeSubagent(msg.toolUseId);
      } else if (msg.status === "failed" || msg.status === "stopped") {
        subagentStore.failSubagent(msg.toolUseId);
      }
    },
  };
}
