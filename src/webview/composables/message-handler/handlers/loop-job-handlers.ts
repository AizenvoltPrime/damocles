import type { HandlerRegistry } from "../types";

export function createLoopJobHandlers(): Partial<HandlerRegistry> {
  return {
    loopJobsLoaded: (msg, ctx) => {
      ctx.stores.loopJobsStore.handleJobsLoaded(msg.jobs);
    },
    loopJobCreated: (msg, ctx) => {
      ctx.stores.loopJobsStore.handleJobCreated(msg.job);
    },
    loopJobUpdated: (msg, ctx) => {
      ctx.stores.loopJobsStore.handleJobUpdated(msg.taskId, msg.updates);
    },
    loopJobRemoved: (msg, ctx) => {
      ctx.stores.loopJobsStore.handleJobRemoved(msg.taskId);
    },
  };
}
