import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { HostInstance } from "../../types";
import { log } from "../../../logger";
import { t } from "../../../l10n";
import { perfSpan, timed } from "../../../perf";
import { renamePiSession, deletePiSession, tagPiSession } from "../../../pi-session/session-store";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { announceLeaseRefusal, claimStoredSession, findStoredSessionHolder, leaseRefusalFor, whileSessionLeased } from "../../session-ownership";
import { resumeStoredSession } from "./resume-session";

// Past the moment a lease turns stale, so the retried claim takes it over.
const RESTORE_RETRY_MARGIN_MS = 1_000;

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
      deps.webviewPrompts.repost(ctx.panelId);
      // Before any state, so the webview hides a host's missing affordances before it renders any of them.
      postMessage(ctx.host, { type: "hostCapabilities", capabilities: deps.platform.capabilities });
      const total = perfSpan("ready.total");

      // The webview renders the conversation with these, so they precede any replay.
      const settingsSpan = perfSpan("ready.settings");
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler);
      settingsManager.sendMcpConfig(ctx.host, ctx.folder.key);
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId);
      postMessage(ctx.host, { type: "languageChange", locale: getLanguagePreference() });
      settingsSpan.end();
      deps.postWorkspaceFolderState(ctx.panelId);

      // Both parse session files synchronously on this thread, so they run after the replay, never beside it.
      const postSessionList = async (): Promise<void> => {
        try {
          const { sessions, hasMore, nextOffset } = await timed("ready.sessions", () => storageManager.getStoredSessions());
          postMessage(ctx.host, { type: "storedSessions", sessions, hasMore, nextOffset, isFirstPage: true });
        } catch (err) {
          log("[MessageRouter] Error fetching sessions:", err);
        }
      };
      const postPromptHistory = async (): Promise<void> => {
        try {
          const { history, hasMore } = await timed("ready.promptHistory", () => storageManager.getPromptHistory(0));
          postMessage(ctx.host, { type: "promptHistory", history, hasMore });
        } catch (err) {
          log("[MessageRouter] Error pre-loading prompt history:", err);
        }
      };

      const savedSessionId = msg.type === "ready" ? msg.savedSessionId : undefined;
      const savedFolderKey = msg.type === "ready" ? msg.savedWorkspaceFolderKey : undefined;
      const heldHere = savedSessionId !== undefined && findStoredSessionHolder(deps.getPanels(), ctx, savedSessionId) !== undefined;
      // Read before any move: a restore its lease refuses opens empty on the saved folder.
      const leaseRefusal = savedSessionId && !heldHere ? leaseRefusalFor(savedSessionId) : undefined;
      if (savedSessionId && leaseRefusal) {
        // A holder whose heartbeat stopped died or hung; its lease turns stale at `heldUntilMs`, and the restore is retried once then.
        const heldUntilMs = leaseRefusal.kind === "other-process" ? leaseRefusal.heldUntilMs : undefined;
        announceLeaseRefusal(deps.platform.notifications, leaseRefusal, heldUntilMs !== undefined);
        if (heldUntilMs !== undefined) {
          setTimeout(() => {
            const instance = deps.getPanels().get(ctx.panelId);
            // The panel closed, or the user started or opened a conversation there meanwhile.
            if (!instance || instance.session.hasConversation()) return;
            resumeStoredSession(deps, ctx.panelId, savedSessionId).catch((err) => log("[MessageRouter] Retrying the restore of %s failed: %O", savedSessionId, err));
          }, heldUntilMs - Date.now() + RESTORE_RETRY_MARGIN_MS);
        }
      }
      // A saved conversation or folder the host did not open in moves the panel there.
      const sessionFolder = savedSessionId && !heldHere && !leaseRefusal
        ? await timed("ready.folderOf", () => storageManager.folderOf(savedSessionId))
        : undefined;
      const target = sessionFolder
        ?? (savedFolderKey !== undefined ? deps.folderRegistry.resolve(savedFolderKey) : undefined)
        ?? ctx.folder;
      // A restored panel whose conversation another panel already holds opens empty instead.
      const resumeSaved = async (instance: Pick<HostInstance, "host" | "session" | "folder">): Promise<boolean> => {
        if (!savedSessionId || leaseRefusal) return false;
        if (claimStoredSession(deps.platform.notifications, deps.getPanels(), { panelId: ctx.panelId, session: instance.session }, savedSessionId)) return false;
        try {
          const rewindableIds = await timed("ready.replay", () =>
            deps.historyManager.loadSessionHistory(instance.folder.fsPath, savedSessionId, instance.host, instance.session));
          postMessage(instance.host, { type: "sessionStarted", sessionId: savedSessionId, stored: rewindableIds !== null });
        } catch (err) {
          if (err instanceof Error && err.name === 'AbortError') return true;
          log("[MessageRouter] Error auto-resuming session:", err);
          postMessage(instance.host, { type: "sessionStarted", sessionId: savedSessionId });
        }
        return true;
      };

      let route: "switch" | "restore" | "fresh";
      if (target.key !== ctx.folder.key) {
        // Claimed inside the switch, so a message the webview sent meanwhile reaches the restored session.
        await deps.switchPanelFolder(ctx.panelId, target.key, "restore", resumeSaved);
        route = "switch";
      } else {
        // A status posted before `ready` never reached the webview; a switch posts its target folder's status itself.
        const compass = deps.compassRegistry?.get(ctx.folder.key);
        if (compass?.isEnabled) postMessage(ctx.host, { type: "compassStatusUpdate", status: compass.getStatus() });
        route = (await resumeSaved(ctx)) ? "restore" : "fresh";
        // The webview persists only a stored conversation's id, so a reload of a panel whose conversation pi has not written yet sends none.
        const liveId = route === "fresh" ? ctx.session.currentSessionId : null;
        if (liveId) postMessage(ctx.host, { type: "sessionStarted", sessionId: liveId, stored: ctx.session.hasSessionFile() });
      }
      await postSessionList();
      await postPromptHistory();
      total.end({ path: route });
      // Starting the session builds the pi runtime, folder runtime and project MCP, which block this thread
      // in long stretches, so it waits until the conversation and the lists are posted.
      const current = deps.getPanels().get(ctx.panelId)?.session;
      if (current) {
        void current.initializeEarly().then(async () => {
          await settingsManager.sendAvailableModels(current, ctx.host);
          // The image catalog and OpenRouter auth come from pi's runtime, which exists only from here on.
          settingsManager.sendImageGenerationSettings(ctx.host);
        }).catch((err: unknown) => log("[SessionHandlers] posting the models after the session started failed: %O", err));
      }
    },

    renameSession: async (msg, ctx) => {
      if (msg.type !== "renameSession") return;
      try {
        // Rename through the live manager when the session is open in any panel — a second file-writer
        // would fork the branch and drop messages. Otherwise use the file-based path.
        const mutator = PiRuntime.liveSessionMutator(msg.sessionId);
        if (mutator) {
          await mutator.renameActiveSession(msg.newName);
        } else {
          const cwd = await sessionCwd(msg.sessionId, ctx.folder.fsPath);
          if (!(await whileSessionLeased(deps.platform.notifications, msg.sessionId, () => renamePiSession(cwd, msg.sessionId, msg.newName)))) return;
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
          message: t("Failed to rename session: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },

    tagSession: async (msg, ctx) => {
      if (msg.type !== "tagSession") return;
      try {
        // Same anti-fork routing as rename.
        const mutator = PiRuntime.liveSessionMutator(msg.sessionId);
        if (mutator) {
          await mutator.setActiveSessionTag(msg.tag);
        } else {
          const cwd = await sessionCwd(msg.sessionId, ctx.folder.fsPath);
          if (!(await whileSessionLeased(deps.platform.notifications, msg.sessionId, () => tagPiSession(cwd, msg.sessionId, msg.tag)))) return;
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
          message: t("Failed to tag session: {0}", err instanceof Error ? err.message : "Unknown error"),
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
        // The lease is taken as its writer before any detach: another process holding the session refuses
        // the delete untouched, and neither another process nor another panel of this one can claim it
        // between the detach and the rm.
        const cwd = await sessionCwd(msg.sessionId, ctx.folder.fsPath);
        const deleted = await whileSessionLeased(deps.platform.notifications, msg.sessionId, async () => {
          const holders = new Set<{ detachFromDeletedSession(): Promise<void> }>();
          const registered = PiRuntime.liveSessionMutator(msg.sessionId);
          if (registered) holders.add(registered);
          const otherPanel = findStoredSessionHolder(deps.getPanels(), ctx, msg.sessionId);
          if (otherPanel) holders.add(otherPanel.session);
          if (ctx.session.persistenceSessionId === msg.sessionId) holders.add(ctx.session);
          await Promise.all([...holders].map((h) => h.detachFromDeletedSession()));
          await deletePiSession(cwd, msg.sessionId);
        });
        if (!deleted) return;
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
          message: t("Failed to delete session: {0}", err instanceof Error ? err.message : "Unknown error"),
          notificationType: "error",
        });
      }
    },
  };
}
