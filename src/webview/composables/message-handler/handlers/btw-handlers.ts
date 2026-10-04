import { useBtwStore } from '@/stores/useBtwStore';
import type { HandlerRegistry } from "../types";

export function createBtwHandlers(): Partial<HandlerRegistry> {
  return {
    btwStreaming: (msg) => {
      useBtwStore().updateStreaming(msg.btwId, msg.text);
    },
    btwComplete: (msg) => {
      useBtwStore().completeAside(msg.btwId, msg.text);
    },
    btwError: (msg) => {
      useBtwStore().setError(msg.btwId, msg.message);
    },
  };
}
