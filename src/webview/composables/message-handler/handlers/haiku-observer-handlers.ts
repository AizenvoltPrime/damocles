import type { HandlerRegistry } from "../types";

export function createHaikuObserverHandlers(): Partial<HandlerRegistry> {
  return {
    haikuObservationStart: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleObservationStart(msg.promptIndex);
    },
    haikuStreamDelta: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleStreamDelta(msg.promptIndex, msg.deltaType, msg.delta);
    },
    haikuObservationComplete: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleObservationComplete(
        msg.promptIndex, msg.thinking, msg.text, msg.contextSnapshot
      );
    },
    haikuActivityLoaded: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleActivitiesLoaded(msg.activities);
    },
  };
}
