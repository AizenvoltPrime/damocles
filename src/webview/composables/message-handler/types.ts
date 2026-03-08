import type { Ref, ComponentPublicInstance } from "vue";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "@shared/types/messages";
import type { useUIStore } from "@/stores/useUIStore";
import type { useSettingsStore } from "@/stores/useSettingsStore";
import type { useSessionStore } from "@/stores/useSessionStore";
import type { usePermissionStore } from "@/stores/usePermissionStore";
import type { useStreamingStore } from "@/stores/useStreamingStore";
import type { useSubagentStore } from "@/stores/useSubagentStore";
import type { useQuestionStore } from "@/stores/useQuestionStore";
import type { usePlanViewStore } from "@/stores/usePlanViewStore";
import type { useTaskStore } from "@/stores/useTaskStore";
import type { useMemoryStore } from "@/stores/useMemoryStore";
import type { useHaikuObserverStore } from "@/stores/useHaikuObserverStore";
import type { useContextInjectionStore } from "@/stores/useContextInjectionStore";
import type { useContextUsageStore } from "@/stores/useContextUsageStore";
import type { useRemoteControlStore } from "@/stores/useRemoteControlStore";
import type { useLoopJobsStore } from "@/stores/useLoopJobsStore";

export interface StoreContext {
  uiStore: ReturnType<typeof useUIStore>;
  settingsStore: ReturnType<typeof useSettingsStore>;
  sessionStore: ReturnType<typeof useSessionStore>;
  permissionStore: ReturnType<typeof usePermissionStore>;
  streamingStore: ReturnType<typeof useStreamingStore>;
  subagentStore: ReturnType<typeof useSubagentStore>;
  questionStore: ReturnType<typeof useQuestionStore>;
  planViewStore: ReturnType<typeof usePlanViewStore>;
  taskStore: ReturnType<typeof useTaskStore>;
  memoryStore: ReturnType<typeof useMemoryStore>;
  haikuObserverStore: ReturnType<typeof useHaikuObserverStore>;
  contextInjectionStore: ReturnType<typeof useContextInjectionStore>;
  contextUsageStore: ReturnType<typeof useContextUsageStore>;
  remoteControlStore: ReturnType<typeof useRemoteControlStore>;
  loopJobsStore: ReturnType<typeof useLoopJobsStore>;
}

export interface RefContext {
  messageContainerRef: Ref<HTMLElement | null>;
  chatInputRef: Ref<ComponentPublicInstance<{ focus: () => void; setInput: (value: string) => void; appendTranscription: (text: string) => void; voiceSetRecording: () => void; voiceSetDone: () => void; voiceSetError: (msg: string) => void }> | null>;
}

export interface VSCodeContext {
  postMessage: (message: WebviewToExtensionMessage) => void;
  getState: <T>() => T | undefined;
  setState: <T>(state: T) => void;
}

export interface HandlerContext {
  stores: StoreContext;
  refs: RefContext;
  vscode: VSCodeContext;
}

export interface ScrollBehavior {
  forceScrollToBottom?: boolean;
  skipScroll?: boolean;
}

export type MessageHandler<T extends ExtensionToWebviewMessage = ExtensionToWebviewMessage> = (
  message: T,
  ctx: HandlerContext
) => ScrollBehavior | void;

export type HandlerRegistry = {
  [K in ExtensionToWebviewMessage["type"]]?: MessageHandler<Extract<ExtensionToWebviewMessage, { type: K }>>;
};

export interface MessageHandlerOptions {
  messageContainerRef: Ref<HTMLElement | null>;
  chatInputRef: Ref<ComponentPublicInstance<{ focus: () => void; setInput: (value: string) => void; appendTranscription: (text: string) => void; voiceSetRecording: () => void; voiceSetDone: () => void; voiceSetError: (msg: string) => void }> | null>;
}
