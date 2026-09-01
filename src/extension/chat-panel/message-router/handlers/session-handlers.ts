import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { log } from "../../../logger";
import { renamePiSession, deletePiSession, tagPiSession } from "../../../pi-session/session-store";
import { PiRuntime, type LiveSessionMutator } from "../../../pi-session/pi-runtime";

/**
 * The live mutation surface (rename, tag, delete-detach) for a session open in any panel, or
 * undefined. Routing here when the session is live avoids a second writer forking its branch, and
 * lets a delete stop the writer that owns it. Never spins up pi just to check.
 */
function liveSessionMutator(sessionId: string): LiveSessionMutator | undefined {
  return PiRuntime.exists ? PiRuntime.get().getSessionMutator(sessionId) : undefined;
}

export function createSessionHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, storageManager, settingsManager, getLanguagePreference } = deps;

  return {
    ready: async (msg, ctx) => {
      // The webview's dialog queue starts empty, so anything this side is still awaiting can no longer
      // be answered. Released here, before any state is pushed back, so a reload cannot deadlock a
      // nested agent on a modal that no longer exists.
      ctx.session.onWebviewReady();
      try {
        const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
        postMessage(ctx.host, {
          type: "storedSessions",
          sessions,
          hasMore,
          nextOffset,
          isFirstPage: true,
        });
      } catch (err) {
        log("[MessageRouter] Error fetching sessions:", err);
      }

      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      settingsManager.sendAvailableModels(ctx.session, ctx.host);
      settingsManager.sendOpenAIModelPricing(ctx.host);
      settingsManager.sendMcpConfig(ctx.host);
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      postMessage(ctx.host, { type: "languageChange", locale: getLanguagePreference() });

      try {
        const { history, hasMore } = await storageManager.getPromptHistory(0);
        postMessage(ctx.host, { type: "promptHistory", history, hasMore });
      } catch (err) {
        log("[MessageRouter] Error pre-loading prompt history:", err);
      }

      if (msg.type === "ready" && msg.savedSessionId) {
        ctx.session.setResumeSession(msg.savedSessionId);
        try {
          await deps.historyManager.loadSessionHistory(msg.savedSessionId, ctx.host, ctx.session);
          postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.savedSessionId });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return;
          log("[MessageRouter] Error auto-resuming session:", err);
          postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.savedSessionId });
        }
      } else {
        await ctx.session.initializeEarly();
      }
    },

    renameSession: async (msg, ctx) => {
      if (msg.type !== "renameSession") return;
      try {
        // Rename through the live manager when the session is open in any panel — a second file-writer
        // would fork the branch and drop messages. Otherwise use the file-based path.
        const mutator = liveSessionMutator(msg.sessionId);
        if (mutator) {
          await mutator.renameActiveSession(msg.newName);
        } else {
          await renamePiSession(workspacePath, msg.sessionId, msg.newName);
        }
        postMessage(ctx.host, {
          type: "sessionRenamed",
          sessionId: msg.sessionId,
          newName: msg.newName,
        });
        storageManager.invalidateSessionsCache();
        const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
        postMessage(ctx.host, {
          type: "storedSessions",
          sessions,
          hasMore,
          nextOffset,
          isFirstPage: true,
        });
      } catch (err) {
        log("[MessageRouter] Error renaming session:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to rename session: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    tagSession: async (msg, ctx) => {
      if (msg.type !== "tagSession") return;
      try {
        // Same anti-fork routing as rename.
        const mutator = liveSessionMutator(msg.sessionId);
        if (mutator) {
          await mutator.setActiveSessionTag(msg.tag);
        } else {
          await tagPiSession(workspacePath, msg.sessionId, msg.tag);
        }
        postMessage(ctx.host, {
          type: "sessionTagged",
          sessionId: msg.sessionId,
          tag: msg.tag,
        });
        storageManager.updateSessionTagInCache(msg.sessionId, msg.tag);
      } catch (err) {
        log("[MessageRouter] Error tagging session:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to tag session: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    deleteSession: async (msg, ctx) => {
      if (msg.type !== "deleteSession") return;
      try {
        // Every holder of this session must stop writing BEFORE the file goes, else its next append
        // resurrects the path as a header-less file. There can be more than one: two panels resuming
        // the same file get the same header-derived session id, and the mutator registry is a Map, so
        // the second registration silently displaces the first. Detach the registered owner AND this
        // panel (deduped when they are the same object) — this panel may be the displaced one, or may
        // only POINT at the session as a not-yet-started resume/fork target. A detach that fails
        // throws, which aborts the delete rather than removing a file someone can still write to.
        const holders = new Set<{ detachFromDeletedSession(): Promise<void> }>();
        const registered = liveSessionMutator(msg.sessionId);
        if (registered) holders.add(registered);
        if (ctx.session.persistenceSessionId === msg.sessionId) holders.add(ctx.session);
        await Promise.all([...holders].map((h) => h.detachFromDeletedSession()));

        await deletePiSession(workspacePath, msg.sessionId);
        // The file is now gone — that's the deletion truth. Memory cleanup is best-effort secondary
        // work; a failure here must not flip the UI back to "delete failed" for an already-gone session.
        try {
          await deps.memoryService?.deleteSessionMemories(msg.sessionId);
        } catch (memErr) {
          log("[MessageRouter] Session file deleted but memory cleanup failed:", memErr);
        }

        postMessage(ctx.host, { type: "sessionDeleted", sessionId: msg.sessionId });
        storageManager.invalidateSessionsCache();
        const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
        postMessage(ctx.host, {
          type: "storedSessions",
          sessions,
          hasMore,
          nextOffset,
          isFirstPage: true,
        });
      } catch (err) {
        log("[MessageRouter] Error deleting session:", err);
        postMessage(ctx.host, {
          type: "notification",
          message: vscode.l10n.t("Failed to delete session: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },
  };
}
