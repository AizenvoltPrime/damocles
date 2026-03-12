import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { HandlerRegistry, ScrollBehavior } from "../types";

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
      const { uiStore, streamingStore, sessionStore, subagentStore, questionStore, permissionStore, planViewStore, taskStore, contextInjectionStore, contextUsageStore, elicitationStore } = ctx.stores;
      const { vscode } = ctx;

      streamingStore.$reset();
      subagentStore.$reset();
      questionStore.$reset();
      permissionStore.$reset();
      planViewStore.$reset();
      taskStore.$reset();
      contextInjectionStore.$reset();
      contextUsageStore.$reset();
      elicitationStore.$reset();
      sessionStore.clearSessionData();
      sessionStore.setCurrentSession(null);

      if (!sessionStore.currentResumedSessionId) {
        sessionStore.setSelectedSession(null);
        vscode.setState({ ...vscode.getState<{ sessionId?: string; sessionName?: string }>(), sessionId: undefined, sessionName: undefined });
      }
      sessionStore.setResumedSession(null);
      uiStore.setTasksPanelCollapsed(true);

      if (msg.pendingMessage) {
        streamingStore.addUserMessage(msg.pendingMessage.content, false, undefined, undefined, msg.pendingMessage.correlationId);
        uiStore.setProcessing(true);
        return { forceScrollToBottom: true };
      }

      return {};
    },

    conversationCleared: (_msg, ctx) => {
      const { uiStore, streamingStore, sessionStore, subagentStore, questionStore, permissionStore, planViewStore, taskStore, contextInjectionStore, contextUsageStore, elicitationStore } = ctx.stores;
      const { vscode } = ctx;

      streamingStore.$reset();
      subagentStore.$reset();
      questionStore.$reset();
      permissionStore.$reset();
      planViewStore.$reset();
      taskStore.$reset();
      contextInjectionStore.$reset();
      contextUsageStore.$reset();
      elicitationStore.$reset();
      sessionStore.clearSessionData();
      sessionStore.setCurrentSession(null);
      sessionStore.setResumedSession(null);
      sessionStore.setSelectedSession(null);
      vscode.setState({ ...vscode.getState<{ sessionId?: string; sessionName?: string }>(), sessionId: undefined, sessionName: undefined });
      uiStore.setProcessing(false);
      uiStore.setTasksPanelCollapsed(true);
      toast.success(i18n.global.t("toast.conversationCleared"));
    },

    sessionCancelled: (_msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, questionStore, permissionStore, elicitationStore } = ctx.stores;

      if (!uiStore.isProcessing && !streamingStore.streamingMessageId) {
        return;
      }
      uiStore.setProcessing(false);
      if (streamingStore.streamingMessageId) {
        streamingStore.finalizeStreamingMessage();
      }
      subagentStore.cancelRunningSubagents();
      questionStore.$reset();
      permissionStore.$reset();
      elicitationStore.$reset();
    },

    sessionRenamed: () => {},

    sessionDeleted: () => {},

    stopInfo: (msg, ctx) => {
      if (msg.lastAssistantMessage) {
        ctx.stores.sessionStore.setLastAssistantMessage(msg.lastAssistantMessage);
      }
    },

    fastModeStateUpdate: (msg, ctx) => {
      ctx.stores.settingsStore.setFastModeState(msg.state);
    },
  };
}
