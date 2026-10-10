import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { MemoryScope, MemoryEntry } from "../../../../shared/types/memory";
import type { ObservationCursor } from "../../../../shared/types/memory";
import type { MemoryAuditErrorCode } from "../../../../shared/types/memory-audit";

/**
 * Memory-domain message types → the `memoryError.source` a thrown handler must carry. The router uses
 * this to route an uncaught handler exception to a `memoryError` (clears panel loading state) rather
 * than a chat-transcript `error`. The source MUST match what each handler posts on a soft failure, or a
 * throw strands the pending-create token / consolidation stepper the source is what settles. Panel reads
 * map to `undefined` (no pending UI state); every audit message maps to `"audit"`, reads included, so
 * the overlay never waits on a request that threw. Keep in sync with {@link createMemoryHandlers}.
 */
export const MEMORY_MESSAGE_SOURCES: ReadonlyMap<string, "panel" | "consolidation" | "audit" | undefined> = new Map([
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
  ["retrySetAsideTurns", "consolidation"],
  ["requestMemoryAudit", "audit"],
  ["requestMemoryAuditSummary", "audit"],
  ["startMemoryAudit", "audit"],
  ["cancelMemoryAudit", "audit"],
  ["applyMemoryAudit", "audit"],
  ["revertMemoryAudit", "audit"],
]);

export const MEMORY_MESSAGE_TYPES: ReadonlySet<string> = new Set(MEMORY_MESSAGE_SOURCES.keys());

export function createMemoryHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage } = deps;

  /**
   * Load the panel's memory list from live memory-graph rows (incl. global preferences and forgotten
   * rows for the toggle) plus the first page of observations.
   */
  function loadPanel(sessionId: string, workspace: string): { memories: MemoryEntry[]; hasMoreObservations: boolean; observationCursor: ObservationCursor | null } {
    const svc = deps.memoryService;
    if (!svc || !workspace) return { memories: [], hasMoreObservations: false, observationCursor: null };
    const graph = svc.getPanelMemories(sessionId, workspace);
    const observations = svc.getObservationPage(workspace);
    return {
      memories: [...graph, ...observations.entries],
      hasMoreObservations: observations.hasMore,
      observationCursor: observations.nextCursor,
    };
  }

  const UNAVAILABLE = "Memory system is not available";

  function postAuditError(ctx: HandlerContext, code: MemoryAuditErrorCode, message: string): void {
    postMessage(ctx.host, { type: "memoryError", source: "audit", code, message });
  }

  /** The audit state and summary to every panel, or an audit error to the asking one when memory is unavailable. */
  function broadcastAuditState(ctx: HandlerContext): boolean {
    const state = deps.memoryService.getAuditState();
    const summary = deps.memoryService.getAuditSummary();
    if (!state || !summary) {
      postAuditError(ctx, "unavailable", UNAVAILABLE);
      return false;
    }
    for (const [, instance] of deps.getPanels()) {
      postMessage(instance.host, { type: "memoryAuditState", state });
      postMessage(instance.host, { type: "memoryAuditSummary", summary });
    }
    return true;
  }

  /** After an apply or revert: the audit state, then each panel's memory list and profile, which the audit may have changed. */
  function broadcastAfterAuditWrite(ctx: HandlerContext): void {
    broadcastAuditState(ctx);
    const global = deps.memoryService.getProfile("global", "");
    for (const [, instance] of deps.getPanels()) {
      const panel = loadPanel(instance.session.memorySessionId, instance.folder.fsPath);
      postMessage(instance.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations, observationCursor: panel.observationCursor });
      const project = deps.memoryService.getProfile("project", instance.folder.fsPath);
      postMessage(instance.host, { type: "profileData", project, global });
    }
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
      const panel = loadPanel(ctx.session.memorySessionId, ctx.folder.fsPath);
      postMessage(ctx.host, { type: "memoriesUpdate", memories: panel.memories, hasMoreObservations: panel.hasMoreObservations, observationCursor: panel.observationCursor });
    },

    requestMoreObservations: async (msg, ctx) => {
      if (msg.type !== "requestMoreObservations") return;

      if (!deps.memoryService?.isEnabled || !ctx.folder.fsPath) {
        postMessage(ctx.host, { type: "memoryError", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.ensureInitialized();
      const { entries, hasMore, nextCursor } = deps.memoryService.getObservationPage(ctx.folder.fsPath, msg.cursor);
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

      if (tier === "note") {
        memory = await deps.memoryService.addNote(msg.content, msg.tags);
      } else {
        const scope: MemoryScope = tier;
        memory = await deps.memoryService.saveMemory({
          content: msg.content,
          kind: msg.kind ?? "fact",
          scope,
          sessionId: ctx.session.memorySessionId,
          workspace: ctx.folder.fsPath,
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
        workspace: ctx.folder.fsPath,
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
      const project = deps.memoryService.getProfile("project", ctx.folder.fsPath);
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
      const workspace = msg.scope === "project" ? ctx.folder.fsPath : "";
      const ok = await deps.memoryService.setProfileSection(msg.scope, workspace, msg.section, msg.content);
      if (!ok) {
        // Targeted failure so the panel clears ONLY this section's pending flag (keeping the draft),
        // instead of a coarse memoryError that would leave it hung.
        postMessage(ctx.host, { type: "profileSectionError", scope: msg.scope, section: msg.section, message: "Failed to save profile section." });
        return;
      }
      const project = deps.memoryService.getProfile("project", ctx.folder.fsPath);
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
      postMessage(ctx.host, {
        type: "consolidationPendingCount",
        count: deps.memoryService.getPendingCount(),
        setAside: deps.memoryService.getSetAsideCount(),
      });
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

    retrySetAsideTurns: async (msg, ctx) => {
      if (msg.type !== "retrySetAsideTurns") return;

      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryError", source: "consolidation", message: "Memory system is not available" });
        return;
      }

      await deps.memoryService.retrySetAsideTurns();
      postMessage(ctx.host, { type: "consolidationPreview", candidates: deps.memoryService.getPendingCandidates() });
    },

    requestMemoryAudit: async (msg, ctx) => {
      if (msg.type !== "requestMemoryAudit") return;
      if (!deps.memoryService?.isEnabled) {
        postAuditError(ctx, "unavailable", UNAVAILABLE);
        return;
      }
      await deps.memoryService.ensureInitialized();
      const state = deps.memoryService.getAuditState();
      if (state) postMessage(ctx.host, { type: "memoryAuditState", state });
      else postAuditError(ctx, "unavailable", UNAVAILABLE);
    },

    requestMemoryAuditSummary: async (msg, ctx) => {
      if (msg.type !== "requestMemoryAuditSummary") return;
      if (!deps.memoryService?.isEnabled) {
        postMessage(ctx.host, { type: "memoryAuditSummary", summary: null });
        return;
      }
      await deps.memoryService.ensureInitialized();
      postMessage(ctx.host, { type: "memoryAuditSummary", summary: deps.memoryService.getAuditSummary() });
    },

    startMemoryAudit: async (msg, ctx) => {
      if (msg.type !== "startMemoryAudit") return;
      if (!deps.memoryService?.isEnabled) {
        postAuditError(ctx, "unavailable", UNAVAILABLE);
        return;
      }
      const result = await deps.memoryService.startAudit();
      if (!result.started) {
        const message =
          result.reason === "busy"
            ? "A quality audit is already running in this or another window."
            : result.reason === "no-model"
              ? "No model with a configured credential is available for memory sub-calls, so the audit cannot run."
              : UNAVAILABLE;
        postAuditError(ctx, result.reason, message);
        return;
      }
      broadcastAuditState(ctx);
    },

    cancelMemoryAudit: async (msg, ctx) => {
      if (msg.type !== "cancelMemoryAudit") return;
      if (!deps.memoryService?.isEnabled) {
        postAuditError(ctx, "unavailable", UNAVAILABLE);
        return;
      }
      const result = await deps.memoryService.cancelAudit();
      if (broadcastAuditState(ctx)) postMessage(ctx.host, { type: "memoryAuditCancelResult", result });
    },

    applyMemoryAudit: async (msg, ctx) => {
      if (msg.type !== "applyMemoryAudit") return;
      if (!deps.memoryService?.isEnabled) {
        postAuditError(ctx, "unavailable", UNAVAILABLE);
        return;
      }
      const result = await deps.memoryService.applyAudit(msg.runId, msg.accept, msg.reject);
      broadcastAfterAuditWrite(ctx);
      postMessage(ctx.host, { type: "memoryAuditResult", result: { action: "apply", ...result } });
    },

    revertMemoryAudit: async (msg, ctx) => {
      if (msg.type !== "revertMemoryAudit") return;
      if (!deps.memoryService?.isEnabled) {
        postAuditError(ctx, "unavailable", UNAVAILABLE);
        return;
      }
      const result = await deps.memoryService.revertAudit(msg.runId);
      broadcastAfterAuditWrite(ctx);
      postMessage(ctx.host, { type: "memoryAuditResult", result: { action: "revert", ...result } });
    },
  };
}
