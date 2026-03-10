import { onMounted, nextTick } from "vue";
import { useVSCode } from "../useVSCode";
import { useUIStore } from "@/stores/useUIStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { usePermissionStore } from "@/stores/usePermissionStore";
import { useStreamingStore } from "@/stores/useStreamingStore";
import { useSubagentStore } from "@/stores/useSubagentStore";
import { useQuestionStore } from "@/stores/useQuestionStore";
import { usePlanViewStore } from "@/stores/usePlanViewStore";
import { useTaskStore } from "@/stores/useTaskStore";
import { useMemoryStore } from "@/stores/useMemoryStore";
import { useContextInjectionStore } from "@/stores/useContextInjectionStore";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useRemoteControlStore } from "@/stores/useRemoteControlStore";
import { useLoopJobsStore } from "@/stores/useLoopJobsStore";
import { createHandlerRegistry } from "./handler-registry";
import type { MessageHandlerOptions, HandlerContext, StoreContext } from "./types";

export type { MessageHandlerOptions } from "./types";

export function useMessageHandler(options: MessageHandlerOptions): void {
  const { postMessage, onMessage, setState, getState } = useVSCode();
  const { messageContainerRef, chatInputRef } = options;

  const uiStore = useUIStore();
  const settingsStore = useSettingsStore();
  const sessionStore = useSessionStore();
  const permissionStore = usePermissionStore();
  const streamingStore = useStreamingStore();
  const subagentStore = useSubagentStore();
  const questionStore = useQuestionStore();
  const planViewStore = usePlanViewStore();
  const taskStore = useTaskStore();
  const memoryStore = useMemoryStore();
  const contextInjectionStore = useContextInjectionStore();
  const contextUsageStore = useContextUsageStore();
  const remoteControlStore = useRemoteControlStore();
  const loopJobsStore = useLoopJobsStore();

  const stores: StoreContext = {
    uiStore,
    settingsStore,
    sessionStore,
    permissionStore,
    streamingStore,
    subagentStore,
    questionStore,
    planViewStore,
    taskStore,
    memoryStore,
    contextInjectionStore,
    contextUsageStore,
    remoteControlStore,
    loopJobsStore,
  };

  const context: HandlerContext = {
    stores,
    refs: { messageContainerRef, chatInputRef },
    vscode: { postMessage, getState, setState },
  };

  const registry = createHandlerRegistry();

  onMounted(() => {
    onMessage((message) => {
      const handler = registry[message.type];
      const result = handler?.(message as never, context);

      const forceScrollToBottom = result?.forceScrollToBottom ?? false;
      const skipScroll = result?.skipScroll ?? false;

      if (!skipScroll) {
        nextTick(() => {
          const container = messageContainerRef.value;
          if (container && (forceScrollToBottom || uiStore.isAtBottom)) {
            container.scrollTop = container.scrollHeight;
          }
        });
      }
    });

    const savedState = getState<{ sessionId?: string; sessionName?: string }>();
    if (savedState?.sessionId) {
      sessionStore.setSelectedSession(savedState.sessionId, savedState.sessionName ?? null);
      sessionStore.setResumedSession(savedState.sessionId);
    }
    postMessage({ type: "ready", savedSessionId: savedState?.sessionId });
    postMessage({ type: "requestVoiceConfig" });
    postMessage({ type: "requestRemoteControlStatus" });

    nextTick(() => {
      chatInputRef.value?.focus();
    });
  });
}
