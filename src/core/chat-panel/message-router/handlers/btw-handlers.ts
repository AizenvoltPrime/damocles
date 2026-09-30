import type { HandlerDependencies, HandlerRegistry } from "../types";

export function createBtwHandlers(
  _deps: HandlerDependencies,
): Partial<HandlerRegistry> {
  return {
    sendBtw: async (msg, ctx) => {
      if (msg.type !== "sendBtw") return;
      await ctx.session.sendBtw(msg.btwId, msg.question);
    },

    cancelBtw: (msg, ctx) => {
      if (msg.type !== "cancelBtw") return;
      ctx.session.cancelBtw(msg.btwId);
    },
  };
}
