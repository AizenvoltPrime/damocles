import type { HandlerRegistry } from "../types";
import { isForegroundOverlayOpen } from "@/composables/useOverlayPriority";

export function createNavigatorHandlers(): Partial<HandlerRegistry> {
  return {
    togglePromptNavigator: (_msg, ctx) => {
      if (isForegroundOverlayOpen()) return;
      ctx.stores.promptNavigatorStore.toggle();
    },
  };
}
