import type { HandlerRegistry } from "../types";

export function createContextInjectionHandlers(): Partial<HandlerRegistry> {
  return {
    contextInjectionLoaded: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleInjectionLoaded(msg.promptIndex, msg.data, msg.memoryData, msg.graphData ?? null);
    },
    graphExecutionUpdate: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleGraphExecutionUpdate(msg.promptIndex, msg.snapshot);
    },
  };
}
