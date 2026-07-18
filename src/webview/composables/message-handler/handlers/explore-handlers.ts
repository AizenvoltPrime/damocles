import { useExploreStore } from '@/stores/useExploreStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { HandlerRegistry } from "../types";

export function createExploreHandlers(): Partial<HandlerRegistry> {
  return {
    exploreApiKeyUpdate: (msg) => {
      if (msg.type !== "exploreApiKeyUpdate") return;
      useSettingsStore().setExploreHasApiKey(msg.hasApiKey);
    },
    exploreConfigUpdate: (msg) => {
      if (msg.type !== "exploreConfigUpdate") return;
      useSettingsStore().setExploreConfig(msg.provider, msg.model, msg.effort);
    },
    exploreStarted: (msg) => {
      useExploreStore().handleExploreStarted(msg);
      return { skipScroll: true };
    },
    exploreDelta: () => {
      return { skipScroll: true };
    },
    exploreToolCall: (msg) => {
      useExploreStore().handleExploreToolCall(msg);
      return { skipScroll: true };
    },
    exploreToolResult: () => {
      return { skipScroll: true };
    },
    exploreCompleted: (msg) => {
      useExploreStore().handleExploreCompleted(msg);
      return { skipScroll: true };
    },
    exploreMessagesUpdate: (msg) => {
      useExploreStore().handleExploreMessagesUpdate(msg);
      return { skipScroll: true };
    },
  };
}
