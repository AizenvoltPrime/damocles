import * as vscode from "vscode";
import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { HostInstance } from "../../types";
import { log } from "../../../logger";
import { renamePiSession, deletePiSession, tagPiSession } from "../../../pi-session/session-store";
import { PiRuntime, type LiveSessionMutator } from "../../../pi-session/pi-runtime";
import { claimStoredSession, findStoredSessionHolder } from "../../session-ownership";

/**
 * The live mutation surface (rename, tag, delete-detach) for a session open in any panel, or
 * undefined. Routing here when the session is live avoids a second writer forking its branch, and
 * lets a delete stop the writer that owns it. Never spins up pi just to check.
 */
function liveSessionMutator(sessionId: string): LiveSessionMutator | undefined {
  return PiRuntime.exists ? PiRuntime.get().getSessionMutator(sessionId) : undefined;
}

export function createSessionHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, settingsManager, getLanguagePreference } = deps;

  /** The session's own folder, from any open folder; an id no open folder holds can only be the panel's own. */
  const sessionCwd = async (sessionId: string, panelCwd: string): Promise<string> =>
    (await storageManager.folderOf(sessionId))?.fsPath ?? panelCwd;

  return {
    ready: async (msg, ctx) => {
      // The webview's dialog queue starts empty, so every modal this side is still awaiting is gone
      // from screen. Posted again here, before any state is pushed back, so a reload cannot deadlock a
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
      settingsManager.sendMcpConfig(ctx.host, ctx.folder.key);
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

      deps.postWorkspaceFolderState(ctx.panelId);

      const savedSessionId = msg.type === "ready" ? msg.savedSessionId : undefined;
      const savedFolderKey = msg.type === "ready" ? msg.savedWorkspaceFolderKey : undefined;
      // A saved conversation or folder the host did not open in moves the panel there.
      const sessionFolder = savedSessionId && !findStoredSessionHolder(deps.getPanels(), ctx, savedSessionId)
        ? await storageManager.folderOf(savedSessionId)
        : undefined;
      const target = sessionFolder
        ?? (savedFolderKey !== undefined ? deps.folderRegistry.resolve(savedFolderKey) : undefined)
        ?? ctx.folder;
      // A restored panel whose conversation another panel already holds opens empty instead.
      const resumeSaved = async (instance: Pick<HostInstance, "host" | "session" | "folder">): Promise<boolean> => {
        if (!savedSessionId) return false;
        if (claimStoredSession(deps.getPanels(), { panelId: ctx.panelId, session: instance.session }, savedSessionId)) return false;
        try {
          await deps.historyManager.loadSessionHistory(instance.folder.fsPath, savedSessionId, instance.host, instance.session);
          postMessage(instance.host, { type: "sessionStarted", sessionId: savedSessionId });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return true;
          log("[MessageRouter] Error auto-resuming session:", err);
          postMessage(instance.host, { type: "sessionStarted", sessionId: savedSessionId });
        }
        return true;
      };

      if (target.key !== ctx.folder.key) {
        // Claimed inside the switch, so a message the webview sent meanwhile reaches the restored session.
        await deps.switchPanelFolder(ctx.panelId, target.key, "restore", resumeSaved);
        return;
      }
      if (!(await resumeSaved(ctx))) await ctx.session.initializeEarly();
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
          await renamePiSession(await sessionCwd(msg.sessionId, ctx.folder.fsPath), msg.sessionId, msg.newName);
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
          await tagPiSession(await sessionCwd(msg.sessionId, ctx.folder.fsPath), msg.sessionId, msg.tag);
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
        // resurrects the path as a header-less file. Detach the registered owner, the other panel that
        // holds it, AND this panel (deduped when they are the same object), since a panel may only POINT
        // at the session as a not-yet-started resume/fork target, which registers nothing. A detach that
        // fails throws, which aborts the delete rather than removing a file someone can still write to.
        // Resolved first: an await between the detach and the rm would let another panel claim the session.
        const cwd = await sessionCwd(msg.sessionId, ctx.folder.fsPath);
        const holders = new Set<{ detachFromDeletedSession(): Promise<void> }>();
        const registered = liveSessionMutator(msg.sessionId);
        if (registered) holders.add(registered);
        const otherPanel = findStoredSessionHolder(deps.getPanels(), ctx, msg.sessionId);
        if (otherPanel) holders.add(otherPanel.session);
        if (ctx.session.persistenceSessionId === msg.sessionId) holders.add(ctx.session);
        await Promise.all([...holders].map((h) => h.detachFromDeletedSession()));

        await deletePiSession(cwd, msg.sessionId);
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
