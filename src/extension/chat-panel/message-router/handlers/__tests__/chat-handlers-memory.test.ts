import { describe, it, expect, vi } from "vitest";
import { createChatHandlers } from "../chat-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import type { MemoryEntry } from "../../../../../shared/types/memory";

function makeHarness(memoryOverrides: Record<string, unknown>) {
  const sent: ExtensionToWebviewMessage[] = [];
  const memoryService = {
    isEnabled: true,
    ensureInitialized: vi.fn(async () => {}),
    saveMemory: vi.fn(async () => null),
    addNote: vi.fn(async () => null),
    ...memoryOverrides,
  };
  const deps = {
    workspacePath: "/cwd",
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    memoryService,
    storageManager: { broadcastPromptHistoryEntry: vi.fn() },
    markUserTypedDuringTurn: vi.fn(),
  } as unknown as HandlerDependencies;
  const ctx = {
    host: { id: "panel-1" },
    session: { memorySessionId: "sess-1", currentPromptIndex: 0, sendMessage: vi.fn() },
  } as unknown as HandlerContext;
  const handlers = createChatHandlers(deps);
  return { sent, memoryService, handlers, ctx };
}

const FACT: MemoryEntry = {
  id: "m1", tier: "session", kind: "fact", scope: "session", content: "x",
  sessionId: "sess-1", workspace: "/cwd", createdAt: 1, updatedAt: 1, tags: [],
} as unknown as MemoryEntry;

async function send(h: ReturnType<typeof makeHarness>, content: string) {
  await h.handlers.sendMessage!({ type: "sendMessage", content }, h.ctx);
}

describe("chat /remember + /note null-save feedback (M1)", () => {
  it("posts memoryError (no source) when /remember save returns null", async () => {
    const h = makeHarness({ saveMemory: vi.fn(async () => null) });
    await send(h, "/remember something important");
    expect(h.sent).toContainEqual({ type: "memoryError", message: "Failed to save memory." });
    expect(h.sent.some((m) => m.type === "memoryCreated")).toBe(false);
  });

  it("posts memoryCreated when /remember save succeeds", async () => {
    const h = makeHarness({ saveMemory: vi.fn(async () => FACT) });
    await send(h, "/remember something important");
    expect(h.sent).toContainEqual({ type: "memoryCreated", memory: FACT });
    expect(h.sent.some((m) => m.type === "memoryError")).toBe(false);
  });

  it("posts memoryError (no source) when /note save returns null", async () => {
    const h = makeHarness({ addNote: vi.fn(async () => null) });
    await send(h, "/note a knowledge base entry");
    expect(h.sent).toContainEqual({ type: "memoryError", message: "Failed to save note." });
    expect(h.sent.some((m) => m.type === "memoryCreated")).toBe(false);
  });
});
