import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { renameSession, deleteSession, tagSessionViaSDK } from "../../../session";
import { log } from "../../../logger";
import { isRecallSession } from "../../../recall/history-builder";

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
      settingsManager.sendMcpConfig(ctx.host);
      settingsManager.sendPluginConfig(ctx.host);
      settingsManager.sendProviderProfilesForPanel(ctx.host, ctx.panelId);
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      settingsManager.sendBetasForPanel(ctx.host, ctx.panelId);
      settingsManager.sendStrategyForPanel(ctx.host, ctx.panelId);
      postMessage(ctx.host, { type: "languageChange", locale: getLanguagePreference() });

      try {
        const { history, hasMore } = await storageManager.getPromptHistory(0);
        postMessage(ctx.host, { type: "promptHistory", history, hasMore });
      } catch (err) {
        log("[MessageRouter] Error pre-loading prompt history:", err);
      }

      if (msg.type === "ready" && msg.savedSessionId) {
        const isRecall = await isRecallSession(workspacePath, msg.savedSessionId);
        const currentStrategy = settingsManager.getActiveStrategyForPanel(ctx.panelId);
        const currentIsRecall = currentStrategy === "recall";

        if (isRecall !== currentIsRecall) {
          log("[MessageRouter] Skipping auto-resume: saved session is %s but current mode is %s", isRecall ? "recall" : "normal", currentIsRecall ? "recall" : "normal");
          await ctx.session.initializeEarly();
        } else {
          if (isRecall) {
            await ctx.session.setRecallSession(msg.savedSessionId);
          } else {
            ctx.session.setResumeSession(msg.savedSessionId);
          }
          try {
            await deps.historyManager.loadSessionHistory(msg.savedSessionId, ctx.host);
            postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.savedSessionId });
          } catch (err) {
            log("[MessageRouter] Error auto-resuming session:", err);
            postMessage(ctx.host, { type: "sessionStarted", sessionId: msg.savedSessionId });
          }
        }
      } else {
        await ctx.session.initializeEarly();
      }
    },

    renameSession: async (msg, ctx) => {
      if (msg.type !== "renameSession") return;
      try {
        await renameSession(workspacePath, msg.sessionId, msg.newName);
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
        await tagSessionViaSDK(msg.sessionId, msg.tag, workspacePath);
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
        await deleteSession(workspacePath, msg.sessionId);
        deps.memoryService?.deleteSessionMemories(msg.sessionId);

        if (isActiveSession) {
          ctx.session.reset();
          postMessage(ctx.host, { type: "sessionCleared" });
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
