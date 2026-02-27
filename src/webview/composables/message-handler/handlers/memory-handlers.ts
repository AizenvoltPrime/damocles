import { toast } from "vue-sonner";
import type { HandlerRegistry } from "../types";

export function createMemoryHandlers(): Partial<HandlerRegistry> {
  return {
    memoriesUpdate: (msg, ctx) => {
      ctx.stores.memoryStore.setMemories(msg.memories);
    },

    memoryCreated: (msg, ctx) => {
      ctx.stores.memoryStore.addMemory(msg.memory);
      toast.success(`${msg.memory.tier} memory saved`);
    },

    memoryDeleted: (msg, ctx) => {
      ctx.stores.memoryStore.removeMemory(msg.id);
    },

    searchResults: (msg, ctx) => {
      ctx.stores.memoryStore.setSearchResults(msg.results);
    },

    openMemoryPanel: (_msg, ctx) => {
      ctx.stores.uiStore.openMemoryPanel();
      ctx.vscode.postMessage({ type: "requestMemories" });
    },

    memoryPinned: (_msg) => {
      toast.success("Memory pinned");
    },

    memoryUnpinned: (_msg) => {
      toast.success("Memory unpinned");
    },

    memoryError: (msg) => {
      toast.error(msg.message);
    },
  };
}
