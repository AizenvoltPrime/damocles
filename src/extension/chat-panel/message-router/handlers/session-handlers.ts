import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { log } from "../../../logger";
import { renamePiSession, deletePiSession, tagPiSession } from "../../../pi-session/session-store";
import { PiRuntime, type LiveSessionMutator } from "../../../pi-session/pi-runtime";

/**
 * The live rename/tag surface for a session open in ANY panel, or undefined. Routing a mutation here
 * (instead of the file-based store path) when the session is live avoids a second writer forking its
 * branch — covering the current panel AND other panels (US-012). Never spins up pi just to check.
 */
function liveSessionMutator(sessionId: string): LiveSessionMutator | undefined {
  return PiRuntime.exists ? PiRuntime.get().getSessionMutator(sessionId) : undefined;
}

export function createSessionHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, storageManager, settingsManager, getLanguagePreference } = deps;

  return {
    ready: async (msg, ctx) => {
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
          await deps.historyManager.loadSessionHistory(msg.savedSessionId, ctx.host);
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
        // If the target session is live in ANY panel, rename through its LIVE manager — a second
        // file-writer would fork the branch and drop messages (data loss). Sessions with no live
        // writer use the file-based path.
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
        // Same anti-fork routing as rename: live manager when the session is open in any panel, else file.
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
        const isActiveSession = ctx.session.persistenceSessionId === msg.sessionId;
        // Tear down the live session BEFORE removing its file. Otherwise an in-flight turn's append can
        // land in the await window after the rm and resurrect the just-deleted session's file (pi
        // rewrites the full file incl. header on persist). whenReplaced resolves once pi has disposed
        // the old AgentSession (which aborts the turn).
        if (isActiveSession) {
          ctx.session.teamService?.cancelActiveTeam();
          ctx.session.reset();
          await ctx.session.whenReplaced?.();
          postMessage(ctx.host, { type: "sessionCleared" });
        }

        await deletePiSession(workspacePath, msg.sessionId);
        deps.memoryService?.deleteSessionMemories(msg.sessionId);

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
