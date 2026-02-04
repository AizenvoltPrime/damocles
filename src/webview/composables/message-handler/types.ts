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
}

export interface RefContext {
  messageContainerRef: Ref<HTMLElement | null>;
  chatInputRef: Ref<ComponentPublicInstance<{ focus: () => void; setInput: (value: string) => void }> | null>;
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
  chatInputRef: Ref<ComponentPublicInstance<{ focus: () => void; setInput: (value: string) => void }> | null>;
}
