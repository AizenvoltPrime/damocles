import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import { useBackgroundTaskStore } from "@/stores/useBackgroundTaskStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { useConsolidationStore } from "@/stores/useConsolidationStore";
import type { HandlerContext, HandlerRegistry, ScrollBehavior } from "../types";

/** Every path that drops the conversation runs this, so a store added here is cleared on all of them. */
function resetConversationStores(ctx: HandlerContext): void {
  const { uiStore, streamingStore, sessionStore, subagentStore, questionStore, formStore, permissionStore, planViewStore, taskStore, contextInjectionStore, contextUsageStore, subscriptionUsageStore, elicitationStore, btwStore } = ctx.stores;

  streamingStore.$reset();
  subagentStore.$reset();
  questionStore.$reset();
  formStore.$reset();
  permissionStore.$reset();
  planViewStore.$reset();
  taskStore.$reset();
  contextInjectionStore.$reset();
  contextUsageStore.$reset();
  subscriptionUsageStore.$reset();
  elicitationStore.$reset();
  btwStore.$reset();
  useBackgroundTaskStore().$reset();
  useTeamStore().$reset();
  useConsolidationStore().$reset();
  uiStore.collapseTool();
  uiStore.setTasksPanelCollapsed(true);
  sessionStore.clearSessionData();
  sessionStore.setCurrentSession(null);
}

function resetConversationState(ctx: HandlerContext): void {
  const { uiStore, sessionStore } = ctx.stores;
  const { vscode } = ctx;

  resetConversationStores(ctx);
  sessionStore.setResumedSession(null);
  sessionStore.setSelectedSession(null);
  vscode.setState({ ...vscode.getState<{ sessionId?: string; sessionName?: string }>(), sessionId: undefined, sessionName: undefined });
  uiStore.setProcessing(false);
}

export function createSessionHandlers(): Partial<HandlerRegistry> {
  return {
    sessionStarted: (msg, ctx) => {
      const { sessionStore } = ctx.stores;
      const { vscode } = ctx;
      sessionStore.setCurrentSession(msg.sessionId);
      sessionStore.setResumedSession(msg.sessionId);
      if (sessionStore.selectedSessionId !== msg.sessionId) {
        sessionStore.setSelectedSession(msg.sessionId);
        vscode.setState({ ...vscode.getState<{ sessionId?: string; sessionName?: string }>(), sessionId: msg.sessionId });
      }
    },

    resumeAccepted: (msg, ctx) => {
      const { sessionStore, streamingStore, teamStore } = ctx.stores;
      const { vscode } = ctx;
      const session = sessionStore.storedSessions.find((s) => s.id === msg.sessionId);
      const sessionName = session?.customTitle || session?.aiTitle || session?.preview || null;
      streamingStore.$reset();
      teamStore.$reset();
      sessionStore.clearSessionData();
      sessionStore.setResumedSession(msg.sessionId);
      sessionStore.setSelectedSession(msg.sessionId, sessionName);
      vscode.setState({ ...vscode.getState<{ sessionId?: string; sessionName?: string | null }>(), sessionId: msg.sessionId, sessionName });
    },

    // The panel owns one session and `running` can arrive before `sessionStarted`, so no session id filter here.
    sessionStateChanged: (msg, ctx) => {
      ctx.stores.sessionStore.setSessionState(msg.state);
    },

    storedSessions: (msg, ctx): ScrollBehavior => {
      const { sessionStore } = ctx.stores;
      const isFirstPage = msg.isFirstPage ?? sessionStore.storedSessions.length === 0;
      sessionStore.updateStoredSessions(
        msg.sessions,
        isFirstPage,
        msg.hasMore ?? false,
        msg.nextOffset ?? msg.sessions.length
      );
      return { skipScroll: true };
    },

    sessionCleared: (msg, ctx): ScrollBehavior => {
      const { uiStore, streamingStore, sessionStore } = ctx.stores;
      const { vscode } = ctx;

      resetConversationStores(ctx);

      if (!sessionStore.currentResumedSessionId) {
        sessionStore.setSelectedSession(null);
        vscode.setState({ ...vscode.getState<{ sessionId?: string; sessionName?: string }>(), sessionId: undefined, sessionName: undefined });
      }
      sessionStore.setResumedSession(null);

      if (msg.pendingMessage) {
        streamingStore.addUserMessage(msg.pendingMessage.content, false, undefined, undefined, msg.pendingMessage.correlationId);
        uiStore.setProcessing(true);
        return { forceScrollToBottom: true };
      }

      return {};
    },

    conversationCleared: (_msg, ctx) => {
      resetConversationState(ctx);
      toast.success(i18n.global.t("toast.conversationCleared"));
    },

    workspaceFolderUpdate: (msg, ctx) => {
      const { vscode } = ctx;
      ctx.stores.settingsStore.setWorkspaceFolders(msg.folders, msg.panelFolderKey, msg.defaultFolderKey);
      if (msg.switched) {
        resetConversationState(ctx);
        // Project memories and the project profile belong to the folder, so reload them for the new one.
        ctx.stores.memoryStore.clearFolderData();
        // The extension re-sends the new folder's Compass status after this update.
        ctx.stores.compassStore.clearFolderData();
        if (ctx.stores.uiStore.showMemoryPanel) {
          vscode.postMessage({ type: "requestMemories" });
          vscode.postMessage({ type: "getProfile" });
        }
        const folder = msg.folders.find((f) => f.key === msg.panelFolderKey);
        toast.success(i18n.global.t("toast.workspaceFolderSwitched", { folder: folder?.label ?? msg.panelFolderKey }));
      }
      vscode.setState({ ...vscode.getState<{ workspaceFolderKey?: string }>(), workspaceFolderKey: msg.panelFolderKey });
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
