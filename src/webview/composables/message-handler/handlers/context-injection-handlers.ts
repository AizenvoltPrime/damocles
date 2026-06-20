import type { HandlerRegistry } from "../types";

export function createContextInjectionHandlers(): Partial<HandlerRegistry> {
  return {
    contextInjectionLoaded: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleInjectionLoaded(msg.promptIndex, msg.memoryData);
    },
    contextInjectionStarted: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleContextInjectionStarted(msg.promptIndex);
    },
    memoryInjectionUpdate: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleMemoryInjectionUpdate(msg.promptIndex, msg.data);
    },
    contextInjectionComplete: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleContextInjectionComplete(msg.promptIndex);
    },
  };
}
