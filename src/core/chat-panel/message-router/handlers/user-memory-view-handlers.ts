import type { HandlerDependencies, ViewHandlerContext, ViewHandlerRegistry } from "../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../shared/types/messages";
import type { PanelHost } from "../../../../platform/window-service";
import { MAX_MEMORY_CONTENT_CHARS } from "../../../../shared/types/memory";
import {
  MAX_GLOBAL_MEMORY_ID_CHARS,
  MAX_GLOBAL_MEMORY_LABEL_CHARS,
  MAX_GLOBAL_MEMORY_TAGS,
  remoteChatLocalFailure,
  viewRequestIdOf,
  type UserMemoryViewRequest,
} from "../../../../shared/remote-user";
import type { LocalizedText } from "../../../../shared/localized-text";
import type { MemoryService } from "../../../memory";
import { l } from "../../../l10n";
import { log } from "../../../logger";

type Message<T extends UserMemoryViewRequest> = Extract<WebviewToExtensionMessage, { type: T }>;

const isString = (value: unknown, min: number, max: number): value is string => typeof value === "string" && value.length >= min && value.length <= max;
const isOneOf = <T extends string>(value: unknown, allowed: readonly T[]): value is T => typeof value === "string" && (allowed as readonly string[]).includes(value);
const isTags = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= MAX_GLOBAL_MEMORY_TAGS && value.every((tag) => isString(tag, 0, MAX_GLOBAL_MEMORY_LABEL_CHARS));

const LIST_OFF: ExtensionToWebviewMessage = { type: "userMemoriesUpdate", memories: [], available: false };
const PROFILE_OFF: ExtensionToWebviewMessage = { type: "userProfileData", global: { static: "", dynamic: "" }, available: false };
const listOf = (memory: MemoryService): ExtensionToWebviewMessage => ({ type: "userMemoriesUpdate", memories: memory.userScopeMemories(), available: true });
const profileOf = (memory: MemoryService): ExtensionToWebviewMessage => ({ type: "userProfileData", global: memory.getProfile("global", ""), available: true });

/**
 * A remote chat page's reads and changes of this computer's notes and global memories (USER_MEMORY_VIEW_SOURCES), which main
 * sends here and never to the chat's own core. Each message is checked before any write, and an id names one of this store's
 * global rows (`isUserScopeRow`) before any other lookup, so a crafted message reaches no project or session row and no relayed
 * id. A daemon's core refuses them all: its global memory is its clients'. Memory turning on or off here answers each page
 * that asked again with its list and profile.
 */
export function createUserMemoryViewHandlers(deps: Pick<HandlerDependencies, "postMessage" | "memoryService" | "platform" | "subscriptions">): ViewHandlerRegistry {
  const { postMessage, platform } = deps;
  const askers = new Set<PanelHost>();

  const track = (host: PanelHost): void => {
    if (askers.has(host)) return;
    askers.add(host);
    host.onDispose(() => askers.delete(host));
  };

  const fail = (ctx: ViewHandlerContext, msg: Message<UserMemoryViewRequest>, message: LocalizedText): void => {
    postMessage(ctx.host, remoteChatLocalFailure(msg.type, msg, message));
  };

  /**
   * Runs `answer` with the open store once the message is for this computer's store and memory is on and open here; `off`
   * answers instead while memory is off.
   */
  function handle<T extends UserMemoryViewRequest>(
    type: T,
    answer: (msg: Message<T>, ctx: ViewHandlerContext, memory: MemoryService) => Promise<void> | void,
    off?: (ctx: ViewHandlerContext) => void,
  ): ViewHandlerRegistry[string] {
    return async (raw, ctx) => {
      if (raw.type !== type) return;
      const msg = raw as Message<T>;
      if (platform.remote) {
        fail(ctx, msg, l("Your notes and global memories are on your computer, not on this host."));
        return;
      }
      track(ctx.host);
      const memory = deps.memoryService;
      if (!memory.isEnabled) {
        if (off) off(ctx);
        else fail(ctx, msg, l("Memory system is not available"));
        return;
      }
      await memory.ensureInitialized();
      if (!memory.isAvailable) {
        fail(ctx, msg, l("Memory system is not available"));
        return;
      }
      await answer(msg, ctx, memory);
    };
  }

  /** The id when it names a global row of this store; otherwise the message is refused before any other lookup. */
  const globalRowOf = (msg: Message<UserMemoryViewRequest> & { id: unknown }, ctx: ViewHandlerContext, memory: MemoryService): string | undefined => {
    if (isString(msg.id, 1, MAX_GLOBAL_MEMORY_ID_CHARS) && memory.isUserScopeRow(msg.id)) return msg.id;
    fail(ctx, msg, l("This memory is not one of your global memories."));
    return undefined;
  };

  const malformed = (): LocalizedText => l("The memory panel sent a change this computer does not accept.");

  const handlers: ViewHandlerRegistry = {
    requestUserMemories: handle(
      "requestUserMemories",
      (_msg, ctx, memory) => postMessage(ctx.host, listOf(memory)),
      (ctx) => postMessage(ctx.host, LIST_OFF),
    ),

    getUserMemoryHistory: handle("getUserMemoryHistory", (msg, ctx, memory) => {
      const id = globalRowOf(msg, ctx, memory);
      if (id !== undefined) postMessage(ctx.host, { type: "userMemoryHistory", id, entries: memory.userScopeHistory(id) });
    }),

    getUserRelatedMemories: handle("getUserRelatedMemories", (msg, ctx, memory) => {
      const id = globalRowOf(msg, ctx, memory);
      if (id !== undefined) postMessage(ctx.host, { type: "userRelatedMemories", id, entries: memory.userScopeRelated(id) });
    }),

    getUserProfile: handle(
      "getUserProfile",
      (_msg, ctx, memory) => postMessage(ctx.host, profileOf(memory)),
      (ctx) => postMessage(ctx.host, PROFILE_OFF),
    ),

    createUserMemory: handle("createUserMemory", async (msg, ctx, memory) => {
      const { tier, kind, content, tags } = msg as { tier: unknown; kind: unknown; content: unknown; tags: unknown };
      if (!isString(content, 1, MAX_MEMORY_CONTENT_CHARS)) {
        fail(ctx, msg, typeof content === "string" && content.length > 0 ? l("A memory holds at most {0} characters.", MAX_MEMORY_CONTENT_CHARS) : malformed());
        return;
      }
      const requestId = viewRequestIdOf(msg);
      const tagList = tags === undefined ? undefined : isTags(tags) ? tags : null;
      const factKind = kind === undefined ? "fact" : tier === "global" && isOneOf(kind, ["fact", "preference", "episode"] as const) ? kind : null;
      if (!isOneOf(tier, ["global", "note"] as const) || factKind === null || tagList === null || (msg.requestId !== undefined && requestId === undefined)) {
        fail(ctx, msg, malformed());
        return;
      }
      const created = tier === "note"
        ? await memory.addNote(content, tagList)
        : await memory.saveMemory({ content, kind: factKind, scope: "global", ...(tagList !== undefined ? { tags: tagList } : {}) });
      if (created) postMessage(ctx.host, { type: "userMemoryCreated", memory: created, ...(requestId !== undefined ? { requestId } : {}) });
      else fail(ctx, msg, l("Failed to create memory."));
    }),

    deleteUserMemory: handle("deleteUserMemory", async (msg, ctx, memory) => {
      const id = globalRowOf(msg, ctx, memory);
      if (id === undefined) return;
      if (await memory.deleteMemory(id)) postMessage(ctx.host, { type: "userMemoryDeleted", id });
      else fail(ctx, msg, l("Failed to delete memory."));
    }),

    pinUserMemory: handle("pinUserMemory", async (msg, ctx, memory) => {
      const id = globalRowOf(msg, ctx, memory);
      if (id === undefined) return;
      if (await memory.pinMemory(id)) postMessage(ctx.host, { type: "userMemoryPinned", id });
      else fail(ctx, msg, l("Failed to pin memory: the ID may not exist."));
    }),

    unpinUserMemory: handle("unpinUserMemory", async (msg, ctx, memory) => {
      const id = globalRowOf(msg, ctx, memory);
      if (id === undefined) return;
      if (await memory.unpinMemory(id)) postMessage(ctx.host, { type: "userMemoryUnpinned", id });
      else fail(ctx, msg, l("Failed to unpin memory: the ID may not exist."));
    }),

    forgetUserMemory: handle("forgetUserMemory", async (msg, ctx, memory) => {
      const id = globalRowOf(msg, ctx, memory);
      if (id === undefined) return;
      const scope: unknown = msg.scope;
      if (scope !== undefined && !isOneOf(scope, ["version", "chain"] as const)) {
        fail(ctx, msg, malformed());
        return;
      }
      // exactId: a clicked row whose id went stale reports nothing found instead of forgetting a content match
      const { forgotten } = await memory.forgetMemory(id, scope ?? "chain", true);
      if (forgotten > 0) postMessage(ctx.host, { type: "userMemoryForgotten", id, count: forgotten });
      else fail(ctx, msg, l("No matching memory found to forget."));
    }),

    unforgetUserMemory: handle("unforgetUserMemory", async (msg, ctx, memory) => {
      const id = globalRowOf(msg, ctx, memory);
      if (id === undefined) return;
      const scope: unknown = msg.scope;
      if (scope !== undefined && !isOneOf(scope, ["version", "chain"] as const)) {
        fail(ctx, msg, malformed());
        return;
      }
      const { restored } = await memory.unforgetMemory(id, scope ?? "chain");
      if (restored > 0) postMessage(ctx.host, { type: "userMemoryUnforgotten", id, count: restored });
      else fail(ctx, msg, l("No matching memory found to unforget."));
    }),

    setUserProfileSection: handle("setUserProfileSection", async (msg, ctx, memory) => {
      const { section, content } = msg as { section: unknown; content: unknown };
      if (!isOneOf(section, ["static", "dynamic"] as const) || !isString(content, 0, MAX_MEMORY_CONTENT_CHARS)) {
        fail(ctx, msg, typeof content === "string" && content.length > MAX_MEMORY_CONTENT_CHARS ? l("A memory holds at most {0} characters.", MAX_MEMORY_CONTENT_CHARS) : malformed());
        return;
      }
      if (!(await memory.setProfileSection("global", "", section, content))) {
        fail(ctx, msg, l("Failed to save profile section."));
        return;
      }
      postMessage(ctx.host, { type: "userProfileData", global: memory.getProfile("global", ""), available: true, savedSection: { scope: "global", section } });
    }),
  };

  if (!platform.remote) {
    deps.subscriptions.push(platform.settings.onDidChange("damocles.memory", (change) => {
      if (!change.affects("damocles.memory.enabled")) return;
      for (const host of askers) {
        for (const type of ["requestUserMemories", "getUserProfile"] as const) {
          Promise.resolve(handlers[type]!({ type }, { host })).catch((err) => log("[UserMemoryView] answering a remote chat page after memory turned on or off failed:", err));
        }
      }
    }));
  }
  return handlers;
}
