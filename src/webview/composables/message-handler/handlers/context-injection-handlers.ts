import type { HandlerRegistry } from "../types";

export function createContextInjectionHandlers(): Partial<HandlerRegistry> {
  return {
    contextInjectionLoaded: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleInjectionLoaded(msg.promptIndex, msg.data, msg.memoryData);
    },
    contextInjectionStarted: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleContextInjectionStarted(msg.promptIndex);
    },
    recallIterationUpdate: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleRecallIterationUpdate(msg.promptIndex, msg.iteration);
    },
    recallCompleted: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleRecallCompleted(msg.promptIndex, msg.trajectory);
    },
    memoryInjectionUpdate: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleMemoryInjectionUpdate(msg.promptIndex, msg.data);
    },
    contextInjectionComplete: (msg, ctx) => {
      ctx.stores.contextInjectionStore.handleContextInjectionComplete(msg.promptIndex);
    },
  };
}
