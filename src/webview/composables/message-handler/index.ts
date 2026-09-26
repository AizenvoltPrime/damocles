import { onMounted, nextTick } from "vue";
import { useVSCode } from "../useVSCode";
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
import { useExtensionUiStore } from "@/stores/useExtensionUiStore";
import { createHandlerRegistry } from "./handler-registry";
import { QUEUED_REPLAY_TYPES } from "./handlers/history-handlers";
import { logSinceNavigation } from "@/utils/perf";
import type { ExtensionToWebviewMessage } from "@shared/types/messages";
import type { MessageHandlerOptions, HandlerContext, HandlerRegistry, StoreContext } from "./types";

export type { MessageHandlerOptions } from "./types";

/**
 * Runs each host message through `registry` and scrolls the transcript at most once per animation frame,
 * so a burst of messages costs one `scrollHeight` layout read.
 */
export function createMessageDispatcher(
  registry: HandlerRegistry,
  context: HandlerContext,
): (message: ExtensionToWebviewMessage) => void {
  const { streamingStore, uiStore } = context.stores;
  let scrollFrame: number | null = null;
  let forceScroll = false;
  let followScroll = false;

  function scrollOnce(): void {
    scrollFrame = null;
    const force = forceScroll;
    const follow = followScroll;
    forceScroll = false;
    followScroll = false;
    streamingStore.flushReplayQueue();
    void nextTick(() => {
      const container = context.refs.messageContainerRef.value;
      // A follow re-checks isAtBottom, so a scroll-up between the message and the frame is kept.
      if (container && (force || (follow && uiStore.isAtBottom))) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  return (message) => {
    // Handlers that read or truncate the transcript must see every replay item that arrived before them.
    if (!QUEUED_REPLAY_TYPES.has(message.type)) streamingStore.flushReplayQueue();
    const handler = registry[message.type];
    const result = handler?.(message as never, context);

    if (result?.skipScroll) return;
    if (result?.forceScrollToBottom) forceScroll = true;
    else if (uiStore.isAtBottom) followScroll = true;
    else return;
    scrollFrame ??= requestAnimationFrame(scrollOnce);
  };
}

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
    extensionUiStore,
  };

  const context: HandlerContext = {
    stores,
    refs: { messageContainerRef, chatInputRef },
    vscode: { postMessage, getState, setState },
  };

  const registry = createHandlerRegistry();

  const dispatch = createMessageDispatcher(registry, context);

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
