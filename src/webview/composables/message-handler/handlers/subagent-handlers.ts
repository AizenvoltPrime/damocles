import type { HandlerRegistry } from "../types";

export function createSubagentHandlers(): Partial<HandlerRegistry> {
  return {
    subagentStart: (msg, ctx) => {
      ctx.stores.subagentStore.startSubagent(msg.agentId, msg.agentType, msg.toolUseId);
    },

    subagentStop: (msg, ctx) => {
      ctx.stores.subagentStore.stopSubagent(msg.toolUseId, msg.agentId, msg.lastAssistantMessage);
    },

    subagentModelUpdate: (msg, ctx) => {
      ctx.stores.subagentStore.updateSubagentModel(msg.agentToolId, msg.model);
    },

    subagentMessagesUpdate: (msg, ctx) => {
      ctx.stores.subagentStore.replaceSubagentMessages(msg.agentToolId, msg.messages);
    },

    taskStarted: (msg, ctx) => {
      if (msg.toolUseId) {
        ctx.stores.subagentStore.registerAgentTool(msg.toolUseId, {
          description: msg.description,
          subagent_type: msg.taskType,
        });
        ctx.stores.subagentStore.resetToRunning(msg.toolUseId, msg.description);
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
