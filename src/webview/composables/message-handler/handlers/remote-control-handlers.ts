import type { HandlerRegistry } from "../types";

export function createRemoteControlHandlers(): Partial<HandlerRegistry> {
  return {
    remoteControlStatusChanged: (msg, ctx) => {
      ctx.stores.remoteControlStore.handleStatusChanged(msg.status);
    },
  };
}
