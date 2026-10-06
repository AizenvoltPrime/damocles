import type { HandlerDependencies, HandlerRegistry } from "../types";
import type { SkippedFile, SkippedFilesTarget, ToolResultOwner } from "../../../../shared/types/session";
import type { ImageBlock } from "../../../../shared/types/content";
import { log } from "../../../logger";
import { isSafeAgentPathId } from "../../../pi-session/agent-records";
import { loadToolResultImages } from "../../../pi-session/session-store/tool-result-images";
import { isSafeRefId } from "../../../pi-session/checkpoints";

const MAX_REQUEST_ID_LENGTH = 128;
const MAX_TOOL_USE_ID_LENGTH = 512;
const MAX_OWNER_ID_LENGTH = 128;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const isSafeId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_OWNER_ID_LENGTH && isSafeAgentPathId(value);

function parseToolResultOwner(value: unknown): ToolResultOwner | null {
  if (typeof value !== "object" || value === null) return null;
  const owner = value as { kind?: unknown; agentId?: unknown; teamId?: unknown };
  switch (owner.kind) {
    case "session":
      return { kind: "session" };
    case "subagent":
      return isSafeId(owner.agentId) ? { kind: "subagent", agentId: owner.agentId } : null;
    case "team":
      return isSafeId(owner.teamId) && isSafeId(owner.agentId) ? { kind: "team", teamId: owner.teamId, agentId: owner.agentId } : null;
    default:
      return null;
  }
}

/** The target in the shape the webview keys its answer by; its id is checked separately before any read. */
function parseSkippedFilesTarget(value: unknown): SkippedFilesTarget | null {
  if (typeof value !== "object" || value === null) return null;
  const target = value as { kind?: unknown; userEntryId?: unknown; id?: unknown };
  if (target.kind === "turn" && typeof target.userEntryId === "string") return { kind: "turn", userEntryId: target.userEntryId };
  if (target.kind === "restore-point" && typeof target.id === "string") return { kind: "restore-point", id: target.id };
  return null;
}

const isToolUseId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= MAX_TOOL_USE_ID_LENGTH && !CONTROL_CHARS.test(value);

export function createHistoryHandlers(deps: HandlerDependencies): Partial<HandlerRegistry> {
  const { postMessage, storageManager, historyManager } = deps;

  return {
    rewindToMessage: async (msg, ctx) => {
      if (msg.type !== "rewindToMessage") return;
      if (msg.option === "cancel") return;
      await ctx.session.rewindFiles(msg.userMessageId, msg.option, msg.promptContent);
    },

    undoRewind: async (msg, ctx) => {
      if (msg.type !== "undoRewind") return;
      if (typeof msg.preRewindId !== "string" || !isSafeRefId(msg.preRewindId)) {
        log("[HistoryHandlers] undoRewind dropped: invalid restore point id");
        return;
      }
      await ctx.session.undoRewind(msg.preRewindId);
    },

    requestRewindHistory: async (_msg, ctx) => {
      const currentSessionId = ctx.session.currentSessionId;
      if (!currentSessionId) {
        postMessage(ctx.host, { type: "rewindHistory", prompts: [], restorePoints: [], canFork: true });
        return;
      }

      try {
        const history = await historyManager.extractRewindHistory(ctx.folder.fsPath, currentSessionId, ctx.session.fileCheckpoints);
        postMessage(ctx.host, { type: "rewindHistory", prompts: history.items, restorePoints: history.restorePoints, canFork: true });
      } catch (err) {
        log("[MessageRouter] Error extracting rewind history:", err);
        postMessage(ctx.host, { type: "rewindHistory", prompts: [], restorePoints: [], canFork: true });
      }
    },

    requestSkippedFiles: async (msg, ctx) => {
      if (msg.type !== "requestSkippedFiles") return;
      const target = parseSkippedFilesTarget(msg.target);
      if (!target) {
        log("[HistoryHandlers] requestSkippedFiles dropped: invalid target");
        return;
      }
      const sessionId = ctx.session.currentSessionId;
      let files: SkippedFile[] | null = null;
      if (!isSafeRefId(target.kind === "turn" ? target.userEntryId : target.id)) {
        log("[HistoryHandlers] no skipped list for %o: not a checkpoint id", target);
      } else if (!sessionId) {
        log("[HistoryHandlers] no skipped list for %o: the panel has no session", target);
      } else {
        const read = await historyManager.readSkippedFiles(ctx.folder.fsPath, sessionId, target);
        if (read.ok) files = read.value;
        else log("[HistoryHandlers] reading the skipped list for %o failed: %s", target, read.error);
      }
      postMessage(ctx.host, { type: "skippedFiles", target, files });
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

    requestToolResultImages: async (msg, ctx) => {
      if (msg.type !== "requestToolResultImages") return;
      const { requestId, toolUseId } = msg as { requestId: unknown; toolUseId: unknown };
      if (typeof requestId !== "string" || requestId.length === 0 || requestId.length > MAX_REQUEST_ID_LENGTH) {
        log("[HistoryHandlers] requestToolResultImages dropped: invalid requestId");
        return;
      }
      const reply = (images: readonly ImageBlock[]) => postMessage(ctx.host, { type: "toolResultImages", requestId, images: [...images] });
      const owner = parseToolResultOwner(msg.owner);
      if (!isToolUseId(toolUseId) || !owner) {
        reply([]);
        return;
      }
      let images: readonly ImageBlock[] = [];
      try {
        const cached = ctx.session.unpersistedToolResultImages(toolUseId);
        if (cached) {
          images = cached;
        } else {
          const sessionId = ctx.session.persistenceSessionId;
          if (sessionId) images = await loadToolResultImages(ctx.folder.fsPath, sessionId, toolUseId, owner);
        }
      } catch (err) {
        log("[HistoryHandlers] Reading tool result images for %s failed: %O", toolUseId, err);
      }
      reply(images);
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
