import type { HandlerContext, HandlerDependencies, HandlerRegistry } from "../types";
import type { ViewJoinGate } from "../../types";
import type { HostInstance } from "../../types";
import { log } from "../../../logger";
import { t } from "../../../l10n";
import { perfSpan, timed } from "../../../perf";
import type { PanelHost } from "../../../../platform/window-service";
import type { CatalogResult } from "../../session-catalog";
import { announceLeaseRefusal, claimStoredSession, findStoredSessionHolder, leaseRefusalFor, requestSessionHandoff, type LeaseTakeover } from "../../session-ownership";
import { readSessionLeaseOwner } from "../../../pi-session/session-store/session-lease";
import { isUuid } from "../../../../shared/uuid";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import type { ResumeBinding } from "../../panel-worktrees";
import { resumeStoredSession } from "./resume-session";
import { postVoiceRuntimeStatus } from "./voice-stream-handlers";

// Past the moment a lease turns stale, so the retried claim takes it over.
const RESTORE_RETRY_MARGIN_MS = 1_000;

/**
 * A view joining a panel's chat (views.join): the state `ready` posts, then, once a pending resume settled,
 * the conversation pi holds replayed from its in-memory branch, the adapter's live snapshot and `sessionStarted`, and only
 * then the panel's live events, which wait meanwhile. The panel's token, which feeds the lease owner record, is untouched.
 */
export function createViewJoin(deps: HandlerDependencies): (ctx: HandlerContext, gate: ViewJoinGate) => Promise<void> {
  const { storageManager, settingsManager, historyManager, getLanguagePreference } = deps;
  return async (ctx, gate) => {
    gate.post({ type: "hostCapabilities", capabilities: deps.platform.capabilities });
    if (deps.platform.capabilities.windowLayout) gate.post({ type: "terminalShown", ...deps.platform.window.terminalToggle() });
    const pendingAttachments = ctx.terminalAttachments.displayInfo();
    if (pendingAttachments.length > 0) gate.post({ type: "terminalAttachmentsUpdate", attachments: pendingAttachments });
    await settingsManager.sendCurrentSettings(ctx.reply, ctx.permissionHandler, ctx.folder);
    settingsManager.sendMcpConfig(ctx.reply, ctx.folder.key);
    gate.post({ type: "toolStatus", data: ctx.session.getToolStatus() });
    settingsManager.sendModelForPanel(ctx.reply, ctx.panelId);
    settingsManager.sendThinkingForPanel(ctx.reply, ctx.panelId, ctx.folder);
    gate.post({ type: "languageChange", locale: getLanguagePreference() });
    postVoiceRuntimeStatus(deps, ctx.reply);
    deps.postWorkspaceFolderState(ctx.panelId);

    await ctx.session.whenConversationSettled();
    const context = await historyManager.liveReplayContext();
    // The capture and the hold are one synchronous step, so every live event the view waits for comes after the snapshot.
    gate.hold();
    const live = ctx.session.liveConversation();
    try {
      if (live) {
        await historyManager.replayLive(context, ctx.folder.fsPath, ctx.session, ctx.reply, gate.post, live);
      }
    } finally {
      gate.release(live?.snapshot.seq ?? ctx.session.eventSeq);
    }
    // No runtime holds a conversation: the stored one replays from its file, as a restore that has not started does.
    const stored = live ? undefined : ctx.session.storedSessionId;
    if (stored) {
      const rewindable = await historyManager.loadSessionHistory(ctx.folder.fsPath, stored, ctx.reply, ctx.session);
      deps.postMessage(ctx.reply, { type: "sessionStarted", sessionId: stored, stored: rewindable !== null });
    }
    if (live) ctx.session.replayLiveAgents(live.sessionId);
    // The new page's dialog queue and stores are empty: its prompts, state and worktree state are posted again.
    ctx.session.onWebviewReady();
    deps.webviewPrompts.repost(ctx.panelId);
    try {
      const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions();
      deps.postMessage(ctx.reply, { type: "storedSessions", sessions, hasMore, nextOffset, isFirstPage: true });
      const { history, hasMore: moreHistory } = await storageManager.getPromptHistory(0);
      deps.postMessage(ctx.reply, { type: "promptHistory", history, hasMore: moreHistory });
    } catch (err) {
      log("[SessionHandlers] posting the session list to a joining view failed: %O", err);
    }
    await settingsManager.sendAvailableModels(ctx.session, ctx.reply);
    settingsManager.sendImageGenerationSettings(ctx.reply);
  };
}

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
      postMessage(ctx.reply, { type: "hostCapabilities", capabilities: deps.platform.capabilities });
      if (deps.platform.capabilities.windowLayout) postMessage(ctx.reply, { type: "terminalShown", ...deps.platform.window.terminalToggle() });
      // A restarted webview starts with no chips while core still holds the composer's pending attachments.
      const pendingAttachments = ctx.terminalAttachments.displayInfo();
      if (pendingAttachments.length > 0) postMessage(ctx.reply, { type: "terminalAttachmentsUpdate", attachments: pendingAttachments });
      const total = perfSpan("ready.total");
      const savedSessionId = msg.type === "ready" ? msg.savedSessionId : undefined;
      const savedFolderKey = msg.type === "ready" ? msg.savedWorkspaceFolderKey : undefined;
      // A webview that asked to restore keeps its composer unmounted until it hears the place or a started session.
      let placeSignaled = false;
      const signalStarted = (host: PanelHost, message: Extract<ExtensionToWebviewMessage, { type: "sessionStarted" }>): void => {
        placeSignaled = true;
        postMessage(host, message);
      };
      let handOver: (() => void) | undefined;
      let binding: ResumeBinding | undefined;
      // The replay clears the panel itself: under the saved conversation's name, or unnamed when it reads nothing.
      let replayed = false;
      try {
        // The webview renders the conversation with these, so they precede any replay.
        const settingsSpan = perfSpan("ready.settings");
        await settingsManager.sendCurrentSettings(ctx.reply, ctx.permissionHandler, ctx.folder);
        settingsManager.sendMcpConfig(ctx.reply, ctx.folder.key);
        postMessage(ctx.reply, { type: "toolStatus", data: ctx.session.getToolStatus() });
        settingsManager.sendModelForPanel(ctx.reply, ctx.panelId);
        settingsManager.sendThinkingForPanel(ctx.reply, ctx.panelId, ctx.folder);
        postMessage(ctx.reply, { type: "languageChange", locale: getLanguagePreference() });
        postVoiceRuntimeStatus(deps, ctx.reply);
        settingsSpan.end();
        deps.postWorkspaceFolderState(ctx.panelId);

        // Both come from the session metadata worker, after the replay, so the conversation's posts go first.
        const postSessionList = async (): Promise<void> => {
          try {
            const { sessions, hasMore, nextOffset } = await timed("ready.sessions", () => storageManager.getStoredSessions());
            postMessage(ctx.reply, { type: "storedSessions", sessions, hasMore, nextOffset, isFirstPage: true });
          } catch (err) {
            log("[MessageRouter] Error fetching sessions:", err);
          }
        };
        const postPromptHistory = async (): Promise<void> => {
          try {
            const { history, hasMore } = await timed("ready.promptHistory", () => storageManager.getPromptHistory(0));
            postMessage(ctx.reply, { type: "promptHistory", history, hasMore });
          } catch (err) {
            log("[MessageRouter] Error pre-loading prompt history:", err);
          }
        };

        const heldHere = savedSessionId !== undefined && findStoredSessionHolder(deps.getPanels(), ctx, savedSessionId) !== undefined;
        // Read before any move: a restore its lease refuses opens empty on the saved folder.
        const leaseRefusal = savedSessionId && !heldHere ? leaseRefusalFor(savedSessionId) : undefined;
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
            const waiting = deps.getPanels().get(ctx.panelId);
            if (waiting) {
              waiting.restoreRetry = savedSessionId;
              deps.restoreRetryChanged(ctx.panelId);
            }
            // Cleared once the retry settled, so the host sees the session bound before it stops seeing the retry.
            const retried = (): void => {
              const instance = deps.getPanels().get(ctx.panelId);
              if (instance?.restoreRetry !== savedSessionId) return;
              delete instance.restoreRetry;
              deps.restoreRetryChanged(ctx.panelId);
            };
            setTimeout(() => {
              const instance = deps.getPanels().get(ctx.panelId);
              // The panel closed, or the user started or opened a conversation there meanwhile.
              if (!instance || instance.session.hasConversation()) {
                retried();
                return;
              }
              resumeStoredSession(deps, ctx.panelId, savedSessionId)
                .catch((err) => log("[MessageRouter] Retrying the restore of %s failed: %O", savedSessionId, err))
                .finally(retried);
            }, heldUntilMs - Date.now() + RESTORE_RETRY_MARGIN_MS);
          }
        }
        // A saved conversation or folder the host did not open in moves the panel there.
        const listedFolder = savedSessionId && !heldHere && !leaseRefusal
          ? await timed("ready.folderOf", () => storageManager.folderOf(savedSessionId))
          : undefined;
        // A worktree chat comes back in its working folder through its latest entry, never through a key the webview names.
        const resumeBinding = listedFolder && savedSessionId ? await deps.worktrees().resumeFolder(ctx.panelId, savedSessionId, listedFolder) : undefined;
        binding = resumeBinding;
        const target = resumeBinding?.folder
          ?? listedFolder
          ?? (savedFolderKey !== undefined ? deps.folderRegistry.targets().find((t) => t.key === savedFolderKey) : undefined)
          ?? ctx.folder;
        // A restored panel whose conversation another panel already holds opens empty instead.
        const resumeSaved = async (instance: Pick<HostInstance, "host" | "session" | "folder">): Promise<boolean> => {
          if (!savedSessionId || leaseRefusal) return false;
          if (claimStoredSession(deps.platform.notifications, deps.getPanels(), { panelId: ctx.panelId, session: instance.session }, savedSessionId)) return false;
          // A panel pi holds another conversation in shows this one only once pi switched to it, and opens fresh when it cannot.
          const outcome = await timed("ready.open", () => instance.session.openResumeTarget(savedSessionId));
          if (outcome.kind !== "switched" && outcome.kind !== "deferred") return false;
          // The stored file's place reaches the webview before the replay, so its first render is the right composer; a session
          // already running there (a reloaded webview) sends its live state instead.
          if (resumeBinding?.state !== undefined) {
            placeSignaled = true;
            instance.session.worktree.publishStored(resumeBinding.state, savedSessionId);
          }
          try {
            replayed = true;
            const rewindableIds = await timed("ready.replay", () =>
              deps.historyManager.loadSessionHistory(instance.folder.fsPath, savedSessionId, instance.host, instance.session));
            // The replay told the user why it read nothing, so the panel opens a new conversation, and the place published is the panel's own.
            if (rewindableIds === null && instance.session.letGoOfUnreadTarget(savedSessionId)) {
              placeSignaled = false;
              return false;
            }
            signalStarted(instance.host, { type: "sessionStarted", sessionId: savedSessionId, stored: rewindableIds !== null });
          } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') return true;
            log("[MessageRouter] Error auto-resuming session:", err);
            signalStarted(instance.host, { type: "sessionStarted", sessionId: savedSessionId });
          }
          return true;
        };

        let route: "switch" | "restore" | "fresh";
        const switching = target.key !== ctx.folder.key;
        if (switching) {
          // Claimed inside the switch, so a message the webview sent meanwhile reaches the restored session.
          let resumed = false;
          await deps.switchPanelFolder(ctx.panelId, target.key, "restore", async (instance) => { resumed = await resumeSaved(instance); });
          route = resumed ? "switch" : "fresh";
        } else {
          // A status posted before `ready` never reached the webview; a switch posts its target folder's status itself.
          const compass = deps.compassRegistry?.get(ctx.folder.key);
          if (compass?.isEnabled) postMessage(ctx.reply, { type: "compassStatusUpdate", status: compass.getStatus() });
          route = (await resumeSaved(ctx)) ? "restore" : "fresh";
        }
        // The webview names its saved conversation from mount, so a restore that never replayed it (a lease or another
        // panel refused it, its open failed) drops that name before a send can carry it.
        if (savedSessionId && !replayed) postMessage(ctx.reply, { type: "sessionCleared" });
        if (!switching) {
          // The webview persists only a stored conversation's id, so a reload of a panel whose conversation pi has not written yet sends none.
          const liveId = route === "fresh" ? ctx.session.currentSessionId : null;
          if (liveId) signalStarted(ctx.reply, { type: "sessionStarted", sessionId: liveId, stored: ctx.session.hasSessionFile() });
        }
        await postSessionList();
        // On a cold index the history waits for the worker to parse every file, so the session start does not wait for it.
        void postPromptHistory().then(() => total.end({ path: route }));
      } finally {
        const landed = deps.getPanels().get(ctx.panelId);
        binding?.settle(landed);
        // A restore that opened nothing, failed, threw or was overtaken still tells the waiting webview where the panel works now.
        if (savedSessionId && !placeSignaled && landed && deps.platform.capabilities.worktrees) {
          landed.session.worktree.publishStored(deps.worktrees().placeOf(ctx.panelId));
        }
        // After the restore posted everything, and even when it threw: the holder lets go either way, so the conversation must still open here or the user be told.
        handOver?.();
      }
      // Starting the session builds the pi runtime, folder runtime and project MCP, which block this thread
      // in long stretches, so it waits until the conversation and the session list are posted.
      const current = deps.getPanels().get(ctx.panelId)?.session;
      if (current) {
        void current.initializeEarly().then(async () => {
          await settingsManager.sendAvailableModels(current, ctx.reply);
          // The image catalog and OpenRouter auth come from pi's runtime, which exists only from here on.
          settingsManager.sendImageGenerationSettings(ctx.reply);
        }).catch((err: unknown) => log("[SessionHandlers] posting the models after the session started failed: %O", err));
      }
    },

    renameSession: async (msg, ctx) => {
      if (msg.type !== "renameSession") return;
      const result = await sessionCatalog.rename(msg.sessionId, msg.newName);
      if (!result.ok) {
        await reportFailure(ctx.reply, result, (detail) => t("Failed to rename session: {0}", detail));
        return;
      }
      postMessage(ctx.host, { type: "sessionRenamed", sessionId: msg.sessionId, newName: msg.newName.trim() });
      await postFirstSessionPage(ctx.host);
    },

    tagSession: async (msg, ctx) => {
      if (msg.type !== "tagSession") return;
      const result = await sessionCatalog.tag(msg.sessionId, msg.tag);
      if (!result.ok) {
        await reportFailure(ctx.reply, result, (detail) => t("Failed to tag session: {0}", detail));
        return;
      }
      postMessage(ctx.host, { type: "sessionTagged", sessionId: msg.sessionId, tag: msg.tag === null ? null : msg.tag.trim() });
    },

    deleteSession: async (msg, ctx) => {
      if (msg.type !== "deleteSession") return;
      const result = await sessionCatalog.delete(msg.sessionId);
      if (!result.ok) {
        await reportFailure(ctx.reply, result, (detail) => t("Failed to delete session: {0}", detail));
        return;
      }
      postMessage(ctx.host, { type: "sessionDeleted", sessionId: msg.sessionId });
      await postFirstSessionPage(ctx.host);
    },
  };
}
