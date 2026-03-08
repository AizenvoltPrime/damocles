import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { MemoryTier } from "../../../../shared/types/memory";

export function createMemoryHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage } = deps;

  function computeHasMoreObservations(): boolean {
    if (!deps.workspacePath || !deps.memoryService?.isEnabled) return false;
    return deps.memoryService.getObservationCount(deps.workspacePath) > 20;
  }

  return {
    requestMemories: (msg, ctx) => {
      if (msg.type !== "requestMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const memories = deps.memoryService.getAllMemories(
        msg.tier,
        ctx.session.memorySessionId,
        deps.workspacePath
      );
      const hasMoreObservations = computeHasMoreObservations();
      postMessage(ctx.host, { type: "memoriesUpdate", memories, hasMoreObservations });
    },

    requestMoreObservations: (msg, ctx) => {
      if (msg.type !== "requestMoreObservations") return;

      if (!deps.memoryService?.isEnabled || !deps.workspacePath) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const { entries, hasMore } = deps.memoryService.getObservationPage(deps.workspacePath, msg.offset);
      postMessage(ctx.host, { type: "moreObservationsLoaded", observations: entries, hasMore });
    },

    createMemory: (msg, ctx) => {
      if (msg.type !== "createMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
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
        postMessage(ctx.host, { type: "memoryCreated", memory });
      }
    },

    updateMemory: (msg, ctx) => {
      if (msg.type !== "updateMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      deps.memoryService.updateMemory(msg.id, msg.content, msg.tags);
      const memories = deps.memoryService.getAllMemories(
        undefined,
        ctx.session.memorySessionId,
        deps.workspacePath
      );
      postMessage(ctx.host, { type: "memoriesUpdate", memories, hasMoreObservations: computeHasMoreObservations() });
    },

    deleteMemory: (msg, ctx) => {
      if (msg.type !== "deleteMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const deleted = deps.memoryService.deleteMemory(msg.id);
      if (deleted) {
        postMessage(ctx.host, { type: "memoryDeleted", id: msg.id });
      }
    },

    searchMemories: (msg, ctx) => {
      if (msg.type !== "searchMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const results = deps.memoryService.searchMemories(msg.query);
      postMessage(ctx.host, { type: "searchResults", results });
    },

    pinMemory: (msg, ctx) => {
      if (msg.type !== "pinMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const success = deps.memoryService.pinMemory(msg.id);
      if (success) {
        postMessage(ctx.host, { type: "memoryPinned", id: msg.id });
        const memories = deps.memoryService.getAllMemories(
          undefined,
          ctx.session.memorySessionId,
          deps.workspacePath
        );
        postMessage(ctx.host, { type: "memoriesUpdate", memories, hasMoreObservations: computeHasMoreObservations() });
      } else {
        postMessage(ctx.host, { type: "memoryError", message: "Failed to pin memory — ID may not exist" });
      }
    },

    unpinMemory: (msg, ctx) => {
      if (msg.type !== "unpinMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      const success = deps.memoryService.unpinMemory(msg.id);
      if (success) {
        postMessage(ctx.host, { type: "memoryUnpinned", id: msg.id });
        const memories = deps.memoryService.getAllMemories(
          undefined,
          ctx.session.memorySessionId,
          deps.workspacePath
        );
        postMessage(ctx.host, { type: "memoriesUpdate", memories, hasMoreObservations: computeHasMoreObservations() });
      } else {
        postMessage(ctx.host, { type: "memoryError", message: "Failed to unpin memory — ID may not exist" });
      }
    },
  };
}
