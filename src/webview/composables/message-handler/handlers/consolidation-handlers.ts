import type { HandlerRegistry } from "../types";

export function createConsolidationHandlers(): Partial<HandlerRegistry> {
  return {
    consolidationPendingCount: (msg, ctx) => {
      ctx.stores.consolidationStore.setPendingCount(msg.count);
    },

    consolidationPreview: (msg, ctx) => {
      ctx.stores.consolidationStore.setPreview(msg.candidates);
    },

    consolidationRunning: (msg, ctx) => {
      ctx.stores.consolidationStore.setRunning(msg.running);
    },

    consolidationProgress: (msg, ctx) => {
      ctx.stores.consolidationStore.applyProgress(msg.event);
    },

    consolidationResult: (msg, ctx) => {
      ctx.stores.consolidationStore.setResult(msg.result);
    },
  };
}
