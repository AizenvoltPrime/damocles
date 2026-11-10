import type { HandlerRegistry } from "../types";
import type { ChatMessage } from "@shared/types/session";
import { useDesignStore } from "@/stores/useDesignStore";

// The dispatcher flushes queued replay rows first, so the last message is the one the entry follows on the branch.
function placement(messages: readonly ChatMessage[]): { afterMessageId: string | null; afterTimestamp: number } {
  const last = messages.at(-1);
  return { afterMessageId: last?.id ?? null, afterTimestamp: last?.timestamp ?? 0 };
}

export function createDesignHandlers(): Partial<HandlerRegistry> {
  return {
    designState: (msg) => {
      const store = useDesignStore();
      store.setState(msg.design, msg.link);
      store.setOpenInBrowser(msg.openInBrowser === true);
      store.setOpenPreview(msg.openPreview === true);
    },

    designResult: (msg, ctx) => {
      useDesignStore().addCard({
        kind: "result",
        entryId: msg.entryId,
        ...placement(ctx.stores.streamingStore.messages),
        live: msg.replayed !== true,
        result: msg.result,
      });
    },

    designBrief: (msg, ctx) => {
      useDesignStore().addCard({
        kind: "brief",
        entryId: msg.entryId,
        ...placement(ctx.stores.streamingStore.messages),
        live: msg.replayed !== true,
        brief: msg.brief,
      });
    },

    designFiles: (msg) => {
      useDesignStore().setFiles(msg.designId, msg.files, msg.failed === true);
    },

    requestDesignVersionDecision: (msg) => {
      useDesignStore().addVersionPrompt({
        promptId: msg.promptId,
        designId: msg.designId,
        fromVersion: msg.fromVersion,
        toVersion: msg.toVersion,
        changes: msg.changes,
      });
    },

    designVersionDecisionClosed: (msg) => {
      useDesignStore().removeVersionPrompt(msg.promptId);
    },

    requestDesignApproval: (msg) => {
      useDesignStore().addApprovalPrompt({
        promptId: msg.promptId,
        designId: msg.designId,
        summary: msg.summary,
        previousVersion: msg.previousVersion,
        changes: msg.changes,
        warnings: msg.warnings,
        decisions: msg.decisions,
        screens: msg.screens,
        hasParent: msg.hasParent,
        ...(msg.uncheckedDecisions ? { uncheckedDecisions: msg.uncheckedDecisions } : {}),
      });
    },

    designApprovalClosed: (msg) => {
      useDesignStore().removeApprovalPrompt(msg.promptId);
    },

    designJourneyReplayed: (msg) => {
      useDesignStore().replayEnded(msg.toolCallId, msg.ok, msg.error);
    },
  };
}
