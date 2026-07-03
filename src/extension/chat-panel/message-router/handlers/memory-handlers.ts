import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { MemoryScope, MemoryEntry } from "../../../../shared/types/memory";
import type { ObservationCursor } from "../../../../shared/types/memory";

/**
 * Memory-domain message types → the `memoryError.source` a thrown handler must carry. The router uses
 * this to route an uncaught handler exception to a `memoryError` (clears panel loading state) rather
 * than a chat-transcript `error`. The source MUST match what each handler posts on a soft failure, or a
 * throw strands the pending-create token / consolidation stepper the source is what settles. Reads map
 * to `undefined` (no pending UI state). Keep in sync with {@link createMemoryHandlers}.
 */
export const MEMORY_MESSAGE_SOURCES: ReadonlyMap<string, "panel" | "consolidation" | undefined> = new Map([
  ["requestMemories", undefined],
  ["requestMoreObservations", undefined],
  ["createMemory", "panel"],
  ["updateMemory", "panel"],
  ["deleteMemory", "panel"],
  ["searchMemories", undefined],
  ["pinMemory", "panel"],
  ["unpinMemory", "panel"],
  ["forgetMemory", "panel"],
  ["unforgetMemory", "panel"],
  ["getMemoryHistory", undefined],
  ["getRelatedMemories", undefined],
  ["getProfile", undefined],
  ["setProfileSection", "panel"],
  ["requestConsolidationPreview", "consolidation"],
  ["triggerConsolidation", "consolidation"],
]);

export const MEMORY_MESSAGE_TYPES: ReadonlySet<string> = new Set(MEMORY_MESSAGE_SOURCES.keys());

export function createMemoryHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage } = deps;

  /**
   * Load the panel's memory list from live memory-graph rows (incl. global preferences and forgotten
   * rows for the toggle) plus the first page of observations.
   */
  function loadPanel(sessionId: string): { memories: MemoryEntry[]; hasMoreObservations: boolean; observationCursor: ObservationCursor | null } {
    const svc = deps.memoryService;
    if (!svc || !deps.workspacePath) return { memories: [], hasMoreObservations: false, observationCursor: null };
    const graph = svc.getPanelMemories(sessionId, deps.workspacePath);
    const observations = svc.getObservationPage(deps.workspacePath);
    return {
      memories: [...graph, ...observations.entries],
      hasMoreObservations: observations.hasMore,
      observationCursor: observations.nextCursor,
    };
  }

  return {
    requestMemories: async (msg, ctx) => {
      if (msg.type !== "requestMemories") return;

      // Read guards stay untagged: source:'panel' bumps the panel's create-error token, so tagging a
      // read failure would wrongly reset a pending create. Only CRUD mutations carry source:'panel'.
      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const panel = loadPanel(ctx.session.memorySessionId);
      postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations, observationCursor: panel.observationCursor });
    },

    requestMoreObservations: async (msg, ctx) => {
      if (msg.type !== "requestMoreObservations") return;

      if (!deps.memoryService?.isEnabled || !deps.workspacePath) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const { entries, hasMore, nextCursor } = deps.memoryService.getObservationPage(deps.workspacePath, msg.cursor);
      postMessage(ctx.host, { type: "moreObservationsLoaded", observations: entries, hasMore, nextCursor });
    },

    createMemory: async (msg, ctx) => {
      if (msg.type !== "createMemory") return;

      const requestId = msg.requestId;
      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Memory system is not available", ...(requestId ? { requestId } : {}) });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const tier = msg.tier;
      let memory: MemoryEntry | null = null;

      // A project-scoped row needs a workspace, else it saves with NULL workspace and getPanelMemories
      // never returns it — the user sees "created" for a memory that never appears. Fail loudly instead.
      if (tier === "project" && !deps.workspacePath) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Open a workspace folder to save a project-scoped memory.", ...(requestId ? { requestId } : {}) });
        return;
      }

      if (tier === "note") {
        memory = await deps.memoryService.addNote(msg.content, msg.tags);
      } else {
        const scope: MemoryScope = tier;
        memory = await deps.memoryService.saveMemory({
          content: msg.content,
          kind: msg.kind ?? "fact",
          scope,
          sessionId: ctx.session.memorySessionId,
          workspace: deps.workspacePath,
          ...(msg.tags ? { tags: msg.tags } : {}),
        });
      }

      if (memory) {
        postMessage(ctx.host, { type: "memoryCreated", memory, ...(requestId ? { requestId } : {}) });
      } else {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Failed to create memory.", ...(requestId ? { requestId } : {}) });
      }
    },

    updateMemory: async (msg, ctx) => {
      if (msg.type !== "updateMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const updated = await deps.memoryService.updateMemory(msg.id, msg.content, msg.tags);
      if (!updated) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Failed to update memory." });
        return;
      }
      // A fact/preference edit forks a new version row (new id); the panel must drop the pre-edit id.
      postMessage(ctx.host, {
        type: "memoryUpdated",
        memory: updated,
        ...(updated.id !== msg.id ? { replacedId: msg.id } : {}),
      });
    },

    deleteMemory: async (msg, ctx) => {
      if (msg.type !== "deleteMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const deleted = await deps.memoryService.deleteMemory(msg.id);
      if (deleted) {
        postMessage(ctx.host, { type: "memoryDeleted", id: msg.id });
      } else {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Failed to delete memory." });
      }
    },

    searchMemories: async (msg, ctx) => {
      if (msg.type !== "searchMemories") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      // Panel has no cross-workspace opt-in, so force scoping regardless of what the webview sent.
      // Clamp the limit like the tool path does — the panel path otherwise passed it through unbounded.
      const query = {
        ...msg.query,
        ...(msg.query.limit !== undefined ? { limit: Math.min(Math.max(msg.query.limit, 1), 100) } : {}),
        workspace: deps.workspacePath,
        sessionId: ctx.session.memorySessionId,
        allWorkspaces: false,
      };
      const results = await deps.memoryService.searchMemories(query);
      // Echo the query so the panel can drop results that arrive out of order (A→B: A's late results
      // must not render under B's label).
      postMessage(ctx.host, { type: "searchResults", results, ...(msg.query.query ? { query: msg.query.query } : {}) });
    },

    pinMemory: async (msg, ctx) => {
      if (msg.type !== "pinMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const success = await deps.memoryService.pinMemory(msg.id);
      if (success) {
        postMessage(ctx.host, { type: "memoryPinned", id: msg.id });
      } else {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Failed to pin memory — ID may not exist" });
      }
    },

    unpinMemory: async (msg, ctx) => {
      if (msg.type !== "unpinMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const success = await deps.memoryService.unpinMemory(msg.id);
      if (success) {
        postMessage(ctx.host, { type: "memoryUnpinned", id: msg.id });
      } else {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Failed to unpin memory — ID may not exist" });
      }
    },

    forgetMemory: async (msg, ctx) => {
      if (msg.type !== "forgetMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      // exactId: the panel clicked a concrete row — never fall through to content matching, which
      // could forget an unrelated memory if this id is stale.
      const { forgotten } = await deps.memoryService.forgetMemory(msg.id, msg.scope ?? "chain", true);
      if (forgotten === 0) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "No matching memory found to forget." });
        return;
      }
      postMessage(ctx.host, { type: "memoryForgotten", id: msg.id, count: forgotten });
    },

    unforgetMemory: async (msg, ctx) => {
      if (msg.type !== "unforgetMemory") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const { restored } = await deps.memoryService.unforgetMemory(msg.id, msg.scope ?? "chain");
      if (restored === 0) {
        postMessage(ctx.host, { type: "memoryError", source: "panel", message: "No matching memory found to unforget." });
        return;
      }
      postMessage(ctx.host, { type: "memoryUnforgotten", id: msg.id, count: restored });
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
      const ok = await deps.memoryService.setProfileSection(msg.scope, workspace, msg.section, msg.content);
      if (!ok) {
        // Targeted failure so the panel clears ONLY this section's pending flag (keeping the draft),
        // instead of a coarse memoryError that would leave it hung.
        postMessage(ctx.host, { type: "profileSectionError", scope: msg.scope, section: msg.section, message: "Failed to save profile section." });
        return;
      }
      const project = deps.memoryService.getProfile("project", deps.workspacePath);
      const global = deps.memoryService.getProfile("global", "");
      // savedSection scopes the panel's confirm+re-seed to this section only.
      postMessage(ctx.host, { type: "profileData", project, global, savedSection: { scope: msg.scope, section: msg.section } });
    },

    requestConsolidationPreview: async (msg, ctx) => {
      if (msg.type !== "requestConsolidationPreview") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "consolidation", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      postMessage(ctx.host, { type: "consolidationPreview", candidates: deps.memoryService.getPendingCandidates() });
      postMessage(ctx.host, { type: "consolidationPendingCount", count: deps.memoryService.getPendingCount() });
      const lastResult = deps.memoryService.getLastConsolidationResult();
      if (lastResult) postMessage(ctx.host, { type: "consolidationResult", result: lastResult });

      // Replay live state so reopening the overlay mid-pass restores the running badge and every
      // phase's stepper status, not just the current one.
      const activity = deps.memoryService.getConsolidationActivity();
      postMessage(ctx.host, { type: "consolidationRunning", running: activity.running });
      if (activity.running) {
        for (const event of activity.phaseEvents) {
          postMessage(ctx.host, { type: "consolidationProgress", event });
        }
      }
    },

    triggerConsolidation: async (msg, ctx) => {
      if (msg.type !== "triggerConsolidation") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "consolidation", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.triggerConsolidation();
      postMessage(ctx.host, { type: "consolidationPreview", candidates: deps.memoryService.getPendingCandidates() });
    },
  };
}
