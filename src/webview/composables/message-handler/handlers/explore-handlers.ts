import { useExploreStore } from '@/stores/useExploreStore';
import type { HandlerRegistry } from "../types";

export function createExploreHandlers(): Partial<HandlerRegistry> {
  return {
    exploreStarted: (msg) => {
      useExploreStore().handleExploreStarted(msg);
    },
    exploreToolCall: (msg) => {
      useExploreStore().handleExploreToolCall(msg);
    },
    exploreCompleted: (msg) => {
      useExploreStore().handleExploreCompleted(msg);
    },
    exploreMessagesUpdate: (msg) => {
      useExploreStore().handleExploreMessagesUpdate(msg);
    },
  };
}
