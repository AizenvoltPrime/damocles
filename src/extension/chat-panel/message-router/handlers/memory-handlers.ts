import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { MemoryTier, MemoryEntry } from "../../../../shared/types/memory";

/**
 * Webview→extension message types owned by the memory domain. The router uses this to route an
 * uncaught handler exception to a `memoryError` (which clears panel loading state) rather than a
 * chat-transcript `error`. Keep in sync with the keys returned by {@link createMemoryHandlers}.
 */
export const MEMORY_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  "requestMemories",
  "requestMoreObservations",
  "createMemory",
  "updateMemory",
  "deleteMemory",
  "searchMemories",
  "pinMemory",
  "unpinMemory",
  "forgetMemory",
  "unforgetMemory",
  "getMemoryHistory",
  "getRelatedMemories",
  "getProfile",
  "setProfileSection",
  "requestConsolidationPreview",
  "triggerConsolidation",
]);

export function createMemoryHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage } = deps;

  /**
   * Load the panel's memory list from one consistent source: live memory-graph rows
   * (fact/preference/episode/note, incl. global preferences and forgotten rows for the toggle) plus
   * the first page of observations. Replaces the per-tier getAllMemories, which missed global
   * preferences and could surface superseded versions.
   */
  function loadPanel(sessionId: string): { memories: MemoryEntry[]; hasMoreObservations: boolean } {
    const svc = deps.memoryService;
    if (!svc || !deps.workspacePath) return { memories: [], hasMoreObservations: false };
    const graph = svc.getPanelMemories(sessionId, deps.workspacePath);
    const observations = svc.getObservationPage(deps.workspacePath, 0);
    return { memories: [...graph, ...observations.entries], hasMoreObservations: observations.hasMore };
  }

  return {
    requestMemories: async (msg, ctx) => {
      if (msg.type !== "requestMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const panel = loadPanel(ctx.session.memorySessionId);
      postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations });
    },

    requestMoreObservations: async (msg, ctx) => {
      if (msg.type !== "requestMoreObservations") return;

      if (!deps.memoryService?.isEnabled || !deps.workspacePath) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const { entries, hasMore } = deps.memoryService.getObservationPage(deps.workspacePath, msg.offset);
      postMessage(ctx.host, { type: "moreObservationsLoaded", observations: entries, hasMore });
    },

    createMemory: async (msg, ctx) => {
      if (msg.type !== "createMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
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

    updateMemory: async (msg, ctx) => {
      if (msg.type !== "updateMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      deps.memoryService.updateMemory(msg.id, msg.content, msg.tags);
      const panel = loadPanel(ctx.session.memorySessionId);
      postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations });
    },

    deleteMemory: async (msg, ctx) => {
      if (msg.type !== "deleteMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const deleted = deps.memoryService.deleteMemory(msg.id);
      if (deleted) {
        postMessage(ctx.host, { type: "memoryDeleted", id: msg.id });
      }
    },

    searchMemories: async (msg, ctx) => {
      if (msg.type !== "searchMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const results = await deps.memoryService.searchMemories(msg.query);
      postMessage(ctx.host, { type: "searchResults", results });
    },

    pinMemory: async (msg, ctx) => {
      if (msg.type !== "pinMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const success = deps.memoryService.pinMemory(msg.id);
      if (success) {
        postMessage(ctx.host, { type: "memoryPinned", id: msg.id });
        const panel = loadPanel(ctx.session.memorySessionId);
        postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations });
      } else {
        postMessage(ctx.host, { type: "memoryError", message: "Failed to pin memory — ID may not exist" });
      }
    },

    unpinMemory: async (msg, ctx) => {
      if (msg.type !== "unpinMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const success = deps.memoryService.unpinMemory(msg.id);
      if (success) {
        postMessage(ctx.host, { type: "memoryUnpinned", id: msg.id });
        const panel = loadPanel(ctx.session.memorySessionId);
        postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations });
      } else {
        postMessage(ctx.host, { type: "memoryError", message: "Failed to unpin memory — ID may not exist" });
      }
    },

    forgetMemory: async (msg, ctx) => {
      if (msg.type !== "forgetMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const { forgotten } = await deps.memoryService.forgetMemory(msg.id, msg.scope ?? "chain");
      postMessage(ctx.host, { type: "memoryForgotten", id: msg.id, count: forgotten });
      const panel = loadPanel(ctx.session.memorySessionId);
      postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations });
    },

    unforgetMemory: async (msg, ctx) => {
      if (msg.type !== "unforgetMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const { restored } = await deps.memoryService.unforgetMemory(msg.id, msg.scope ?? "chain");
      postMessage(ctx.host, { type: "memoryUnforgotten", id: msg.id, count: restored });
      const panel = loadPanel(ctx.session.memorySessionId);
      postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations });
    },

    getMemoryHistory: async (msg, ctx) => {
      if (msg.type !== "getMemoryHistory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const entries = deps.memoryService.getMemoryHistory(msg.id);
      postMessage(ctx.host, { type: "memoryHistory", id: msg.id, entries });
    },

    getRelatedMemories: async (msg, ctx) => {
      if (msg.type !== "getRelatedMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const entries = deps.memoryService.getRelatedMemories(msg.id);
      postMessage(ctx.host, { type: "relatedMemories", id: msg.id, entries });
    },

    getProfile: async (msg, ctx) => {
      if (msg.type !== "getProfile") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const project = deps.memoryService.getProfile("project", deps.workspacePath);
      const global = deps.memoryService.getProfile("global", "");
      postMessage(ctx.host, { type: "profileData", project, global });
    },

    setProfileSection: async (msg, ctx) => {
      if (msg.type !== "setProfileSection") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const workspace = msg.scope === "project" ? deps.workspacePath : "";
      await deps.memoryService.setProfileSection(msg.scope, workspace, msg.section, msg.content);
      const project = deps.memoryService.getProfile("project", deps.workspacePath);
      const global = deps.memoryService.getProfile("global", "");
      postMessage(ctx.host, { type: "profileData", project, global });
    },

    requestConsolidationPreview: async (msg, ctx) => {
      if (msg.type !== "requestConsolidationPreview") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      postMessage(ctx.host, { type: "consolidationPreview", candidates: deps.memoryService.getPendingCandidates() });
      postMessage(ctx.host, { type: "consolidationPendingCount", count: deps.memoryService.getPendingCount() });
      const lastResult = deps.memoryService.getLastConsolidationResult();
      if (lastResult) postMessage(ctx.host, { type: "consolidationResult", result: lastResult });
    },

    triggerConsolidation: async (msg, ctx) => {
      if (msg.type !== "triggerConsolidation") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.triggerConsolidation();
      postMessage(ctx.host, { type: "consolidationPreview", candidates: deps.memoryService.getPendingCandidates() });
    },
  };
}
