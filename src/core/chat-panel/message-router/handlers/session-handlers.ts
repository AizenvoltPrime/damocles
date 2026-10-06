import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { HostInstance } from "../../types";
import { log } from "../../../logger";
import { t } from "../../../l10n";
import { perfSpan, timed } from "../../../perf";
import type { PanelHost } from "../../../../platform/window-service";
import type { CatalogResult } from "../../session-catalog";
import { announceLeaseRefusal, claimStoredSession, findStoredSessionHolder, leaseRefusalFor, requestSessionHandoff, type LeaseTakeover } from "../../session-ownership";
import { readSessionLeaseOwner } from "../../../pi-session/session-store/session-lease";
import { isUuid } from "../../../../shared/uuid";
import { resumeStoredSession } from "./resume-session";

// Past the moment a lease turns stale, so the retried claim takes it over.
const RESTORE_RETRY_MARGIN_MS = 1_000;

export function createSessionHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, settingsManager, getLanguagePreference, sessionCatalog } = deps;

  /** The first page of the stored sessions, for a webview whose list a catalog change made stale. */
  const postFirstSessionPage = async (host: PanelHost): Promise<void> => {
    try {
      const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
      postMessage(host, { type: "storedSessions", sessions, hasMore, nextOffset, isFirstPage: true });
    } catch (err) {
      log("[SessionHandlers] Error fetching sessions:", err);
    }
  };

  /** The catalog already told the user about a lease refusal; a missing session means the webview's list is stale. */
  const reportFailure = async (
    host: PanelHost,
    result: Exclude<CatalogResult, { ok: true }>,
    failureText: (detail: string) => string,
  ): Promise<void> => {
    switch (result.reason) {
      case "leased":
        return;
      case "missing":
        await postFirstSessionPage(host);
        return;
      case "invalid":
      case "failed":
        postMessage(host, { type: "notification", message: failureText(result.message), notificationType: "error" });
        return;
    }
  };

  return {
    ready: async (msg, ctx) => {
      // The webview's dialog queue starts empty, so every modal this side is still awaiting is gone
      // from screen. Posted again here, before any state is pushed back, so a reload cannot deadlock a
      // nested agent on a modal that no longer exists.
      ctx.session.onWebviewReady();
      deps.webviewPrompts.repost(ctx.panelId);
      // The webview's identity, which survives a window reload; anything but a well-formed token is no identity.
      const panelToken = msg.type === "ready" && isUuid(msg.panelToken) ? msg.panelToken : null;
      const readyInstance = deps.getPanels().get(ctx.panelId);
      if (readyInstance) {
        readyInstance.panelToken = panelToken;
        readyInstance.session.setPanelToken(panelToken);
      }
      // Before any state, so the webview hides a host's missing affordances before it renders any of them.
      postMessage(ctx.host, { type: "hostCapabilities", capabilities: deps.platform.capabilities });
      const total = perfSpan("ready.total");

      // The webview renders the conversation with these, so they precede any replay.
      const settingsSpan = perfSpan("ready.settings");
      await settingsManager.sendCurrentSettings(ctx.host, ctx.permissionHandler, ctx.folder);
      settingsManager.sendMcpConfig(ctx.host, ctx.folder.key);
      postMessage(ctx.host, { type: "toolStatus", data: ctx.session.getToolStatus() });
      settingsManager.sendModelForPanel(ctx.host, ctx.panelId);
      settingsManager.sendThinkingForPanel(ctx.host, ctx.panelId, ctx.folder);
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
      let handOver: (() => void) | undefined;
      if (savedSessionId && leaseRefusal) {
        // A holder whose heartbeat stopped died or hung; its lease turns stale at `heldUntilMs`, and the restore is retried once then.
        const heldUntilMs = leaseRefusal.kind === "other-process" ? leaseRefusal.heldUntilMs : undefined;
        const takeover: LeaseTakeover = {
          sessionId: savedSessionId,
          canOpen: () => deps.getPanels().has(ctx.panelId),
          open: () => resumeStoredSession(deps, ctx.panelId, savedSessionId),
        };
        const owner = leaseRefusal.kind === "other-process" && heldUntilMs === undefined && panelToken !== null
          ? readSessionLeaseOwner(savedSessionId)
          : undefined;
        if (owner?.panelToken === panelToken) {
          // This panel's previous incarnation holds it: an extension host a reload left running, or one still shutting down.
          const handoff = requestSessionHandoff(savedSessionId, owner.nonce);
          handOver = () => {
            handoff.then(async (result) => {
              const instance = deps.getPanels().get(ctx.panelId);
              if (!instance) return;
              if (result === "timeout") {
                announceLeaseRefusal(deps.platform.notifications, leaseRefusal, { takeover });
                return;
              }
              // The user started or opened a conversation in the panel meanwhile.
              if (instance.session.hasConversation()) return;
              await resumeStoredSession(deps, ctx.panelId, savedSessionId);
            }).catch((err: unknown) => log("[MessageRouter] Restoring %s after its handover failed: %O", savedSessionId, err));
          };
        } else {
          announceLeaseRefusal(deps.platform.notifications, leaseRefusal, { retryScheduled: heldUntilMs !== undefined, takeover });
        }
        if (heldUntilMs !== undefined) {
          setTimeout(() => {
            const instance = deps.getPanels().get(ctx.panelId);
            // The panel closed, or the user started or opened a conversation there meanwhile.
            if (!instance || instance.session.hasConversation()) return;
            resumeStoredSession(deps, ctx.panelId, savedSessionId).catch((err) => log("[MessageRouter] Retrying the restore of %s failed: %O", savedSessionId, err));
          }, heldUntilMs - Date.now() + RESTORE_RETRY_MARGIN_MS);
        }
      }
      try {
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
          await deps.switchPanelFolder(ctx.panelId, target.key, "restore", async (instance) => { await resumeSaved(instance); });
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
      } finally {
        // After the restore posted everything, and even when it threw: the holder lets go either way, so the conversation must still open here or the user be told.
        handOver?.();
      }
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
      const result = await sessionCatalog.rename(msg.sessionId, msg.newName);
      if (!result.ok) {
        await reportFailure(ctx.host, result, (detail) => t("Failed to rename session: {0}", detail));
        return;
      }
      postMessage(ctx.host, { type: "sessionRenamed", sessionId: msg.sessionId, newName: msg.newName.trim() });
      await postFirstSessionPage(ctx.host);
    },

    tagSession: async (msg, ctx) => {
      if (msg.type !== "tagSession") return;
      const result = await sessionCatalog.tag(msg.sessionId, msg.tag);
      if (!result.ok) {
        await reportFailure(ctx.host, result, (detail) => t("Failed to tag session: {0}", detail));
        return;
      }
      postMessage(ctx.host, { type: "sessionTagged", sessionId: msg.sessionId, tag: msg.tag === null ? null : msg.tag.trim() });
    },

    deleteSession: async (msg, ctx) => {
      if (msg.type !== "deleteSession") return;
      const result = await sessionCatalog.delete(msg.sessionId);
      if (!result.ok) {
        await reportFailure(ctx.host, result, (detail) => t("Failed to delete session: {0}", detail));
        return;
      }
      postMessage(ctx.host, { type: "sessionDeleted", sessionId: msg.sessionId });
      await postFirstSessionPage(ctx.host);
    },
  };
}
