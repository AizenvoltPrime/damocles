import type { HandlerRegistry } from "../types";

export function createContextInjectionHandlers(): Partial<HandlerRegistry> {
  return {
    contextInjectionLoaded: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleInjectionLoaded(msg.promptIndex, msg.data);
    },
  };
}
