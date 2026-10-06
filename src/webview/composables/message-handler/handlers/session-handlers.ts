import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useBackgroundTaskStore } from "@/stores/useBackgroundTaskStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { useConsolidationStore } from "@/stores/useConsolidationStore";
import type { HandlerContext, HandlerRegistry, ScrollBehavior } from "../types";
import { beginReplayIngest } from "@/utils/perf";
import { settingsViewHandlers } from "./settings-handlers";

/** Every path that drops the conversation runs this, so a store added here is cleared on all of them. */
function resetConversationStores(ctx: HandlerContext): void {
  const { uiStore, streamingStore, sessionStore, subagentStore, questionStore, formStore, permissionStore, planViewStore, contextInjectionStore, contextUsageStore, subscriptionUsageStore, elicitationStore, btwStore } = ctx.stores;

  streamingStore.$reset();
  subagentStore.$reset();
  questionStore.$reset();
  formStore.$reset();
  permissionStore.$reset();
  planViewStore.$reset();
  contextInjectionStore.$reset();
  contextUsageStore.$reset();
  subscriptionUsageStore.$reset();
  elicitationStore.$reset();
  btwStore.$reset();
  useBackgroundTaskStore().$reset();
  useTeamStore().$reset();
  useConsolidationStore().$reset();
  uiStore.collapseTool();
  sessionStore.clearSessionData();
  sessionStore.setCurrentSession(null);
}

function resetConversationState(ctx: HandlerContext): void {
  const { uiStore, sessionStore } = ctx.stores;
  const { bridge } = ctx;

  resetConversationStores(ctx);
  sessionStore.setResumedSession(null);
  sessionStore.setSelectedSession(null);
  bridge.setState({ ...bridge.getState<{ sessionId?: string; sessionName?: string }>(), sessionId: undefined, sessionName: undefined });
  uiStore.setProcessing(false);
}

export function createSessionHandlers(): Partial<HandlerRegistry> {
  return {
    sessionStarted: (msg, ctx) => {
      const { sessionStore } = ctx.stores;
      const { bridge } = ctx;
      sessionStore.setCurrentSession(msg.sessionId);
      sessionStore.setResumedSession(msg.sessionId);
      if (sessionStore.selectedSessionId !== msg.sessionId) sessionStore.setSelectedSession(msg.sessionId);
      // The persisted id is what a restart or reload asks the host to replay from disk, so it names only a stored conversation.
      const saved = bridge.getState<{ sessionId?: string; sessionName?: string }>();
      const restorable = msg.stored ? msg.sessionId : undefined;
      if (saved?.sessionId !== restorable) {
        bridge.setState({ ...saved, sessionId: restorable, ...(restorable ? {} : { sessionName: undefined }) });
      }
    },

    resumeAccepted: (msg, ctx) => {
      const { sessionStore, streamingStore, teamStore } = ctx.stores;
      const { bridge } = ctx;
      const session = sessionStore.storedSessions.find((s) => s.id === msg.sessionId);
      const sessionName = session?.customTitle || session?.aiTitle || session?.preview || null;
      streamingStore.$reset();
      teamStore.$reset();
      sessionStore.clearSessionData();
      sessionStore.setResumedSession(msg.sessionId);
      sessionStore.setSelectedSession(msg.sessionId, sessionName);
      bridge.setState({ ...bridge.getState<{ sessionId?: string; sessionName?: string | null }>(), sessionId: msg.sessionId, sessionName });
    },

    // The panel owns one session and `running` can arrive before `sessionStarted`, so no session id filter here.
    sessionStateChanged: (msg, ctx) => {
      ctx.stores.sessionStore.setSessionState(msg.state, msg.pendingPrompts);
    },

    storedSessions: (msg, ctx) => {
      const { sessionStore } = ctx.stores;
      const isFirstPage = msg.isFirstPage ?? sessionStore.storedSessions.length === 0;
      sessionStore.updateStoredSessions(
        msg.sessions,
        isFirstPage,
        msg.hasMore ?? false,
        msg.nextOffset ?? msg.sessions.length
      );
    },

    sessionCleared: (msg, ctx): ScrollBehavior => {
      const { uiStore, streamingStore, sessionStore } = ctx.stores;
      const { bridge } = ctx;

      resetConversationStores(ctx);

      if (!sessionStore.currentResumedSessionId) {
        sessionStore.setSelectedSession(null);
        bridge.setState({ ...bridge.getState<{ sessionId?: string; sessionName?: string }>(), sessionId: undefined, sessionName: undefined });
      }
      sessionStore.setResumedSession(null);

      // Another session's transcript starts at its bottom, wherever the reader left the last one.
      if (msg.pendingMessage) {
        streamingStore.addUserMessage(msg.pendingMessage.content, false, undefined, undefined, msg.pendingMessage.correlationId);
        uiStore.setProcessing(true);
      } else {
        beginReplayIngest();
      }
      return { forceScrollToBottom: true };
    },

    conversationCleared: (_msg, ctx) => {
      resetConversationState(ctx);
      toast.success(i18n.global.t("toast.conversationCleared"));
    },

    workspaceFolderUpdate: (msg, ctx) => {
      const { bridge } = ctx;
      settingsViewHandlers.workspaceFolderUpdate(msg, ctx);
      if (msg.switched) {
        resetConversationState(ctx);
        // Project memories and the project profile belong to the folder, so reload them for the new one.
        ctx.stores.memoryStore.clearFolderData();
        // The extension re-sends the new folder's Compass status after this update.
        ctx.stores.compassStore.clearFolderData();
        if (ctx.stores.uiStore.showMemoryPanel) {
          bridge.postMessage({ type: "requestMemories" });
          bridge.postMessage({ type: "getProfile" });
        }
        const folder = msg.folders.find((f) => f.key === msg.panelFolderKey);
        toast.success(i18n.global.t("toast.workspaceFolderSwitched", { folder: folder?.label ?? msg.panelFolderKey }));
      }
      bridge.setState({ ...bridge.getState<{ workspaceFolderKey?: string }>(), workspaceFolderKey: msg.panelFolderKey });
    },

    sessionCancelled: (_msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, questionStore, formStore, permissionStore, elicitationStore } = ctx.stores;

      uiStore.setProcessing(false);
      if (streamingStore.streamingMessageId) {
        streamingStore.finalizeStreamingMessage();
      }
      subagentStore.cancelRunningSubagents();
      questionStore.$reset();
      formStore.$reset();
      permissionStore.$reset();
      elicitationStore.$reset();
    },

    sessionRenamed: () => {},

    sessionDeleted: () => {},

    sessionTagged: () => {},

    stopInfo: (msg, ctx) => {
      if (msg.lastAssistantMessage) {
        ctx.stores.sessionStore.setLastAssistantMessage(msg.lastAssistantMessage);
      }
    },
  };
}
