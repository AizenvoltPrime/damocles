import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { HandlerRegistry, ScrollBehavior } from "../types";

export function createSessionHandlers(): Partial<HandlerRegistry> {
  return {
    sessionStarted: (msg, ctx) => {
      const { sessionStore } = ctx.stores;
      const { vscode } = ctx;
      sessionStore.setCurrentSession(msg.sessionId);
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
      const { uiStore, streamingStore, sessionStore, subagentStore, questionStore, permissionStore, planViewStore, taskStore, contextViewStore } = ctx.stores;
      const { vscode } = ctx;

      streamingStore.$reset();
      subagentStore.$reset();
      questionStore.$reset();
      permissionStore.$reset();
      planViewStore.$reset();
      taskStore.$reset();
      contextViewStore.$reset();
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
      const { uiStore, streamingStore, sessionStore, subagentStore, questionStore, permissionStore, planViewStore, taskStore, contextViewStore } = ctx.stores;

      streamingStore.$reset();
      subagentStore.$reset();
      questionStore.$reset();
      permissionStore.$reset();
      planViewStore.$reset();
      taskStore.$reset();
      contextViewStore.$reset();
      sessionStore.clearSessionData();
      uiStore.setProcessing(false);
      uiStore.setTasksPanelCollapsed(true);
      toast.success(i18n.global.t("toast.conversationCleared"));
    },

    sessionCancelled: (_msg, ctx) => {
      const { uiStore, streamingStore, subagentStore, questionStore, permissionStore } = ctx.stores;

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
    },

    sessionRenamed: () => {},

    sessionDeleted: () => {},
  };
}
