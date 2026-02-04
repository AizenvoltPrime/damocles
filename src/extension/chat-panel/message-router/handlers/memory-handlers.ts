import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { MemoryTier } from "../../../../shared/types/memory";

export function createMemoryHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage } = deps;

  return {
    requestMemories: (msg, ctx) => {
      if (msg.type !== "requestMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.panel, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const memories = deps.memoryService.getAllMemories(
        msg.tier,
        ctx.session.memorySessionId,
        deps.workspacePath
      );
      postMessage(ctx.panel, { type: "memoriesUpdate", memories });
    },

    createMemory: (msg, ctx) => {
      if (msg.type !== "createMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.panel, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const tier: MemoryTier = msg.tier;
      let memory = null;

      if (tier === "session") {
        memory = deps.memoryService.addSessionMemory(ctx.session.memorySessionId, msg.content, msg.tags);
      } else if (tier === "project") {
        memory = deps.memoryService.addProjectMemory(deps.workspacePath, msg.content, msg.tags);
      } else if (tier === "global") {
        memory = deps.memoryService.addGlobalMemory(msg.content, msg.tags);
      } else if (tier === "note") {
        memory = deps.memoryService.addNote(msg.content, msg.tags);
      }

      if (memory) {
        postMessage(ctx.panel, { type: "memoryCreated", memory });
      }
    },

    updateMemory: (msg, ctx) => {
      if (msg.type !== "updateMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.panel, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      deps.memoryService.updateMemory(msg.id, msg.content, msg.tags);
      const memories = deps.memoryService.getAllMemories(
        undefined,
        ctx.session.memorySessionId,
        deps.workspacePath
      );
      postMessage(ctx.panel, { type: "memoriesUpdate", memories });
    },

    deleteMemory: (msg, ctx) => {
      if (msg.type !== "deleteMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.panel, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const deleted = deps.memoryService.deleteMemory(msg.id);
      if (deleted) {
        postMessage(ctx.panel, { type: "memoryDeleted", id: msg.id });
      }
    },

    searchMemories: (msg, ctx) => {
      if (msg.type !== "searchMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.panel, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const results = deps.memoryService.searchMemories(msg.query);
      postMessage(ctx.panel, { type: "searchResults", results });
    },
  };
}
