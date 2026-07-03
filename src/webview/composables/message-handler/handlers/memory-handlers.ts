import { toast } from "vue-sonner";
import type { HandlerRegistry } from "../types";

export function createMemoryHandlers(): Partial<HandlerRegistry> {
  return {
    memoriesUpdate: (msg, ctx) => {
      ctx.stores.memoryStore.setMemories(msg.memories, msg.hasMoreObservations, msg.observationCursor);
    },

    moreObservationsLoaded: (msg, ctx) => {
      ctx.stores.memoryStore.appendObservations(msg.observations, msg.hasMore, msg.nextCursor);
    },

    memoryCreated: (msg, ctx) => {
      ctx.stores.memoryStore.addMemory(msg.memory);
      // Only a panel-originated create (carries requestId) settles the panel's pending-create token;
      // a chat /remember has no requestId and must not clear the panel's in-progress add input.
      if (msg.requestId) ctx.stores.memoryStore.settleCreate(msg.requestId, true);
      toast.success(`${msg.memory.tier} memory saved`);
    },

    memoryUpdated: (msg, ctx) => {
      const store = ctx.stores.memoryStore;
      // A version-chain edit retires the old id and creates a new one: splice the new latest into the
      // old row's slot so it keeps its list position. An in-place edit keeps its id, so replace it.
      if (msg.replacedId && msg.replacedId !== msg.memory.id) {
        store.replaceMemoryChain(msg.replacedId, msg.memory);
      } else {
        store.replaceMemory(msg.memory);
      }
    },

    memoryDeleted: (msg, ctx) => {
      ctx.stores.memoryStore.removeMemory(msg.id);
    },

    searchResults: (msg, ctx) => {
      ctx.stores.memoryStore.setSearchResults(msg.results, msg.query);
    },

    openMemoryPanel: (_msg, ctx) => {
      ctx.stores.uiStore.openMemoryPanel();
      ctx.vscode.postMessage({ type: "requestMemories" });
    },

    memoryPinned: (msg, ctx) => {
      ctx.stores.memoryStore.setPinned(msg.id, true);
      toast.success("Memory pinned");
    },

    memoryUnpinned: (msg, ctx) => {
      ctx.stores.memoryStore.setPinned(msg.id, false);
      toast.success("Memory unpinned");
    },

    memoryForgotten: (msg, ctx) => {
      ctx.stores.memoryStore.setForgotten(msg.id, true);
      toast.success(`Forgot ${msg.count} ${msg.count === 1 ? "memory" : "memories"}`);
    },

    memoryUnforgotten: (msg, ctx) => {
      ctx.stores.memoryStore.setForgotten(msg.id, false);
      toast.success(`Restored ${msg.count} ${msg.count === 1 ? "memory" : "memories"}`);
    },

    memoryHistory: (msg, ctx) => {
      ctx.stores.memoryStore.setVersionHistory(msg.id, msg.entries);
    },

    relatedMemories: (msg, ctx) => {
      ctx.stores.memoryStore.setRelatedMemories(msg.id, msg.entries);
    },

    profileData: (msg, ctx) => {
      ctx.stores.memoryStore.setProfile(msg.project, msg.global, msg.savedSection);
    },

    profileSectionError: (msg, ctx) => {
      // Signal the failed section so the panel clears its pending flag (keeping the draft).
      ctx.stores.memoryStore.setProfileSectionError(msg.scope, msg.section);
      toast.error(msg.message);
    },

    memoryError: (msg, ctx) => {
      const store = ctx.stores.memoryStore;
      store.loadingObservations = false;
      // A failed search never posts searchResults, so clear any pending-search state here or the
      // panel would show "Searching…" forever.
      store.setPendingSearchQuery(null);
      // A panel create failure settles only its own request (requestId), re-enabling the input while
      // preserving the typed text; a panel pin/delete/forget failure carries no requestId, so it must
      // NOT clear an in-flight create. Neither aborts a live consolidation run.
      if (msg.source === "panel" && msg.requestId) store.settleCreate(msg.requestId, false);
      // Only a consolidation-sourced error is a terminal signal for the run stepper: the "Run now"
      // path returns ONLY a memoryError (no terminal consolidationResult), so without this the
      // optimistic stepper spins forever and "Run now" stays disabled. abortRun() settles the phase
      // machine to idle, re-enabling "Run now".
      if (msg.source === "consolidation") ctx.stores.consolidationStore.abortRun();
      toast.error(msg.message);
    },
  };
}
