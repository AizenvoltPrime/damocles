import type { HandlerRegistry } from "../types";

export function createHaikuObserverHandlers(): Partial<HandlerRegistry> {
  return {
    haikuIterationStart: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleIterationStart(msg.promptIndex, msg.iteration);
    },
    haikuStreamDelta: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleStreamDelta(msg.promptIndex, msg.deltaType, msg.delta);
    },
    haikuIterationComplete: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleIterationComplete(
        msg.promptIndex, msg.iteration, msg.thinking, msg.text, msg.isFinal, msg.contextSnapshot
      );
    },
    haikuActivityLoaded: (msg, ctx) => {
      ctx.stores.haikuObserverStore.handleActivitiesLoaded(msg.activities);
    },
  };
}
