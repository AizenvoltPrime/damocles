import type { HandlerDependencies, HandlerRegistry } from "../types";
import { log } from "../../../logger";

export function createHistoryHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, historyManager } = deps;

  return {
    rewindToMessage: async (msg, ctx) => {
      if (msg.type !== "rewindToMessage") return;
      if (msg.option === "cancel") return;
      await ctx.session.rewindFiles(msg.userMessageId, msg.option, msg.promptContent);
    },

    requestRewindHistory: async (_msg, ctx) => {
      const canFork = !ctx.session.recallService?.isEnabled;
      const currentSessionId = ctx.session.currentSessionId;
      if (!currentSessionId) {
        postMessage(ctx.host, { type: "rewindHistory", prompts: [], canFork });
        return;
      }

      try {
        const conversationHead = ctx.session.conversationHead;
        const history = await historyManager.extractRewindHistory(currentSessionId, conversationHead);
        postMessage(ctx.host, { type: "rewindHistory", prompts: history, canFork });
      } catch (err) {
        log("[MessageRouter] Error extracting rewind history:", err);
        postMessage(ctx.host, { type: "rewindHistory", prompts: [], canFork });
      }
    },

    requestMoreSessions: async (msg, ctx) => {
      if (msg.type !== "requestMoreSessions") return;
      const { sessions, hasMore, nextOffset } = await storageManager.getStoredSessions(
        msg.offset,
        undefined,
        msg.selectedSessionId
      );
      postMessage(ctx.host, {
        type: "storedSessions",
        sessions,
        hasMore,
        nextOffset,
        isFirstPage: msg.offset === 0,
      });
    },

    searchSessions: async (msg, ctx) => {
      if (msg.type !== "searchSessions") return;
      const offset = msg.offset ?? 0;
      try {
        const { sessions, hasMore, nextOffset } = await storageManager.searchSessions(
          msg.query,
          offset,
          msg.selectedSessionId
        );
        postMessage(ctx.host, {
          type: "storedSessions",
          sessions,
          hasMore,
          nextOffset,
          isFirstPage: offset === 0,
        });
      } catch (err) {
        log("[MessageRouter] Error searching sessions:", err);
        postMessage(ctx.host, {
          type: "storedSessions",
          sessions: [],
          hasMore: false,
          nextOffset: 0,
          isFirstPage: true,
        });
      }
    },

    requestPromptHistory: async (msg, ctx) => {
      if (msg.type !== "requestPromptHistory") return;
      try {
        const offset = msg.offset ?? 0;
        const { history, hasMore } = await storageManager.getPromptHistory(offset);
        postMessage(ctx.host, { type: "promptHistory", history, hasMore });
      } catch (err) {
        log("Failed to extract prompt history:", err);
        postMessage(ctx.host, { type: "promptHistory", history: [], hasMore: false });
      }
    },
  };
}
