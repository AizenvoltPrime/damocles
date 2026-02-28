import type { HandlerDependencies, HandlerRegistry } from "../types";

export function createRemoteControlHandlers(
  deps: HandlerDependencies,
): Partial<HandlerRegistry> {
  const { postMessage } = deps;

  return {
    remoteControlEnable: async (_msg, ctx) => {
      await ctx.session.enableRemoteControl();
    },

    remoteControlDisable: async (_msg, ctx) => {
      await ctx.session.disableRemoteControl();
    },

    requestRemoteControlStatus: (_msg, ctx) => {
      postMessage(ctx.host, {
        type: 'remoteControlStatusChanged',
        status: ctx.session.remoteControlStatus,
      });
    },
  };
}
