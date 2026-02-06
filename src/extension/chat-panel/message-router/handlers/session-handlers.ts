import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import { renameSession, deleteSession } from "../../../session";
import { log } from "../../../logger";
import { isDistillSession, unregisterDistillSession } from "../../../context-distillation/registry";
import { CONTEXT_DIR } from "../../../context-distillation/context-store";

export function createSessionHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { workspacePath, postMessage, storageManager, settingsManager, getLanguagePreference } = deps;

  return {
    ready: async (msg, ctx) => {
      try {
        const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
        postMessage(ctx.panel, {
          type: "storedSessions",
          sessions,
          hasMore,
          nextOffset,
          isFirstPage: true,
        });
      } catch (err) {
        log("[MessageRouter] Error fetching sessions:", err);
      }

      await settingsManager.sendCurrentSettings(ctx.panel, ctx.permissionHandler);
      settingsManager.sendAvailableModels(ctx.session, ctx.panel);
      settingsManager.sendMcpConfig(ctx.panel);
      settingsManager.sendPluginConfig(ctx.panel);
      settingsManager.sendProviderProfilesForPanel(ctx.panel, ctx.panelId);
      postMessage(ctx.panel, { type: "languageChange", locale: getLanguagePreference() });

      try {
        const { history, hasMore } = await storageManager.getPromptHistory(0);
        postMessage(ctx.panel, { type: "promptHistory", history, hasMore });
      } catch (err) {
        log("[MessageRouter] Error pre-loading prompt history:", err);
      }

      if (msg.type === "ready" && msg.savedSessionId) {
        const isDistill = await isDistillSession(msg.savedSessionId);
        const currentStrategy = vscode.workspace.getConfiguration("damocles").get<string>("contextStrategy", "default");
        const currentIsDistill = currentStrategy === "distill";

        if (isDistill !== currentIsDistill) {
          log("[MessageRouter] Skipping auto-resume: saved session is %s but current mode is %s", isDistill ? "distill" : "normal", currentIsDistill ? "distill" : "normal");
          await ctx.session.initializeEarly();
        } else {
          if (isDistill) {
            ctx.session.setDistillSession(msg.savedSessionId);
          } else {
            ctx.session.setResumeSession(msg.savedSessionId);
          }
          try {
            await deps.historyManager.loadSessionHistory(msg.savedSessionId, ctx.panel);
            postMessage(ctx.panel, { type: "sessionStarted", sessionId: msg.savedSessionId });
          } catch (err) {
            log("[MessageRouter] Error auto-resuming session:", err);
            postMessage(ctx.panel, { type: "sessionStarted", sessionId: msg.savedSessionId });
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
        postMessage(ctx.panel, {
          type: "sessionRenamed",
          sessionId: msg.sessionId,
          newName: msg.newName,
        });
        storageManager.invalidateSessionsCache();
        const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
        postMessage(ctx.panel, {
          type: "storedSessions",
          sessions,
          hasMore,
          nextOffset,
          isFirstPage: true,
        });
      } catch (err) {
        log("[MessageRouter] Error renaming session:", err);
        postMessage(ctx.panel, {
          type: "notification",
          message: vscode.l10n.t("Failed to rename session: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    deleteSession: async (msg, ctx) => {
      if (msg.type !== "deleteSession") return;
      try {
        const isActiveSession = ctx.session.currentSessionId === msg.sessionId;
        await deleteSession(workspacePath, msg.sessionId);
        deps.memoryService?.deleteSessionMemories(msg.sessionId);
        void unregisterDistillSession(msg.sessionId);
        void fs.unlink(path.join(CONTEXT_DIR, `${msg.sessionId}.context.md`)).catch(() => {});

        if (isActiveSession) {
          ctx.session.reset();
          postMessage(ctx.panel, { type: "sessionCleared" });
        }

        postMessage(ctx.panel, { type: "sessionDeleted", sessionId: msg.sessionId });
        storageManager.invalidateSessionsCache();
        const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
        postMessage(ctx.panel, {
          type: "storedSessions",
          sessions,
          hasMore,
          nextOffset,
          isFirstPage: true,
        });
      } catch (err) {
        log("[MessageRouter] Error deleting session:", err);
        postMessage(ctx.panel, {
          type: "notification",
          message: vscode.l10n.t("Failed to delete session: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },
  };
}
