import { toast } from "vue-sonner";
import { i18n } from "@/i18n";
import type { UserContentBlock } from "@shared/types/content";
import type { HandlerRegistry } from "../types";

export function createQueueHandlers(): Partial<HandlerRegistry> {
  return {
    messageQueued: (msg, ctx) => {
      ctx.stores.streamingStore.addQueuedMessage(msg.message);
    },

    queueProcessed: (msg, ctx) => {
      ctx.stores.streamingStore.markQueueProcessed(msg.messageId);
    },

    queueBatchProcessed: (msg, ctx) => {
      ctx.stores.streamingStore.combineQueuedMessages(msg.messageIds, msg.combinedContent, msg.contentBlocks);
    },

    queueCancelled: (msg, ctx) => {
      const removed = ctx.stores.streamingStore.removeQueuedMessage(msg.messageId);
      if (!msg.returnToInput || !removed) return;
      const blocks: UserContentBlock[] = removed.contentBlocks
        ? removed.contentBlocks.filter((block): block is UserContentBlock => block.type === "text" || block.type === "image")
        : [{ type: "text", text: removed.content }];
      ctx.refs.chatInputRef.value?.restoreQueued(blocks);
      // One toast however many chips one stop returns.
      toast.info(i18n.global.t("toast.queueReturned"), { id: "queue-returned" });
    },

    flushedMessagesAssigned: (msg, ctx) => {
      ctx.stores.streamingStore.assignSdkIdToFlushedMessage(msg.queueMessageIds, msg.sdkMessageId);
    },
  };
}
