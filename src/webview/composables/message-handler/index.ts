import { onMounted, nextTick } from "vue";
import { usePlatformBridge } from "../usePlatformBridge";
import { useUIStore } from "@/stores/useUIStore";
import { useSettingsStore } from "@/stores/useSettingsStore";
import { useSessionStore } from "@/stores/useSessionStore";
import { usePermissionStore } from "@/stores/usePermissionStore";
import { useStreamingStore } from "@/stores/useStreamingStore";
import { useSubagentStore } from "@/stores/useSubagentStore";
import { useQuestionStore } from "@/stores/useQuestionStore";
import { useFormStore } from "@/stores/useFormStore";
import { usePlanViewStore } from "@/stores/usePlanViewStore";
import { useTaskStore } from "@/stores/useTaskStore";
import { useMemoryStore } from "@/stores/useMemoryStore";
import { useContextInjectionStore } from "@/stores/useContextInjectionStore";
import { useContextUsageStore } from "@/stores/useContextUsageStore";
import { useSubscriptionUsageStore } from "@/stores/useSubscriptionUsageStore";
import { useElicitationStore } from "@/stores/useElicitationStore";
import { useBtwStore } from "@/stores/useBtwStore";
import { useBackgroundTaskStore } from "@/stores/useBackgroundTaskStore";
import { useCompassStore } from "@/stores/useCompassStore";
import { useTeamStore } from "@/stores/useTeamStore";
import { useVoiceJarvisStore } from "@/stores/useVoiceJarvisStore";
import { usePromptNavigatorStore } from "@/stores/usePromptNavigatorStore";
import { useConsolidationStore } from "@/stores/useConsolidationStore";
import { useMemoryAuditStore } from "@/stores/useMemoryAuditStore";
import { useExtensionUiStore } from "@/stores/useExtensionUiStore";
import { createHandlerRegistry } from "./handler-registry";
import { QUEUED_REPLAY_TYPES } from "./handlers/history-handlers";
import { logSinceNavigation } from "@/utils/perf";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";
import type { MessageHandlerOptions, HandlerContext, HandlerRegistry, StoreContext } from "./types";

export type { MessageHandlerOptions } from "./types";

/**
 * Runs each host message through `registry`. The transcript follows its own growth
 * (`useStickToBottom`); a handler only asks it to follow again, for another session's transcript.
 */
export function createMessageDispatcher(
  registry: HandlerRegistry,
  context: HandlerContext,
  followTranscript: () => void,
): (message: ExtensionToWebviewMessage) => void {
  const { streamingStore } = context.stores;

  return (message) => {
    // Handlers that read or truncate the transcript must see every replay item that arrived before them.
    if (!QUEUED_REPLAY_TYPES.has(message.type)) streamingStore.flushReplayQueue();
    const handler = registry[message.type];
    const result = handler?.(message as never, context);
    if (result?.forceScrollToBottom) followTranscript();
  };
}

export function useMessageHandler(options: MessageHandlerOptions): void {
  const { postMessage, onMessage, setState, getState } = usePlatformBridge();
  const { chatInputRef, followTranscript } = options;

  const uiStore = useUIStore();
  const settingsStore = useSettingsStore();
  const sessionStore = useSessionStore();
  const permissionStore = usePermissionStore();
  const streamingStore = useStreamingStore();
  const subagentStore = useSubagentStore();
  const questionStore = useQuestionStore();
  const formStore = useFormStore();
  const planViewStore = usePlanViewStore();
  const taskStore = useTaskStore();
  const memoryStore = useMemoryStore();
  const contextInjectionStore = useContextInjectionStore();
  const contextUsageStore = useContextUsageStore();
  const subscriptionUsageStore = useSubscriptionUsageStore();
  const elicitationStore = useElicitationStore();
  const btwStore = useBtwStore();
  const backgroundTaskStore = useBackgroundTaskStore();
  const compassStore = useCompassStore();
  const teamStore = useTeamStore();
  const voiceJarvisStore = useVoiceJarvisStore();
  const promptNavigatorStore = usePromptNavigatorStore();
  const consolidationStore = useConsolidationStore();
  const memoryAuditStore = useMemoryAuditStore();
  const extensionUiStore = useExtensionUiStore();

  const stores: StoreContext = {
    uiStore,
    settingsStore,
    sessionStore,
    permissionStore,
    streamingStore,
    subagentStore,
    questionStore,
    formStore,
    planViewStore,
    taskStore,
    memoryStore,
    contextInjectionStore,
    contextUsageStore,
    subscriptionUsageStore,
    elicitationStore,
    btwStore,
    backgroundTaskStore,
    compassStore,
    teamStore,
    voiceJarvisStore,
    promptNavigatorStore,
    consolidationStore,
    memoryAuditStore,
    extensionUiStore,
  };

  const context: HandlerContext = {
    stores,
    refs: { chatInputRef },
    bridge: { postMessage, getState, setState },
  };

  const registry = createHandlerRegistry();

  const dispatch = createMessageDispatcher(registry, context, followTranscript);

  onMounted(() => {
    onMessage(dispatch);

    const savedState = getState<{ sessionId?: string; sessionName?: string; workspaceFolderKey?: string }>();
    if (savedState?.sessionId) {
      sessionStore.setSelectedSession(savedState.sessionId, savedState.sessionName ?? null);
      sessionStore.setResumedSession(savedState.sessionId);
    }
    postMessage({
      type: "ready",
      ...(savedState?.sessionId !== undefined && { savedSessionId: savedState.sessionId }),
      ...(savedState?.workspaceFolderKey !== undefined && { savedWorkspaceFolderKey: savedState.workspaceFolderKey }),
    });
    logSinceNavigation("boot.readySent");
    postMessage({ type: "requestVoiceConfig" });
    postMessage({ type: "requestExploreKeyStatus" });
    postMessage({ type: "requestExploreConfig" });
    postMessage({ type: "getOpenAIAuthStatus" });

    nextTick(() => {
      chatInputRef.value?.focus();
    });
  });
}
