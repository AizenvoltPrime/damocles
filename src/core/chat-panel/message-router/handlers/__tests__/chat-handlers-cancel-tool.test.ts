import { describe, it, expect, vi } from "vitest";
import { createChatHandlers } from "../chat-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";

/**
 * The webview marks the card "Stopping..." on the way in and has no other way to learn the cancel found
 * nothing, so a dropped `false` leaves that state stuck for the rest of the session.
 */
function makeHarness(cancelResult: boolean) {
  const sent: ExtensionToWebviewMessage[] = [];
  const cancelToolCall = vi.fn(() => cancelResult);
  const deps = {
    workspacePath: "/cwd",
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    storageManager: { broadcastPromptHistoryEntry: vi.fn() },
    markUserTypedDuringTurn: vi.fn(),
  } as unknown as HandlerDependencies;
  const ctx = {
    host: { id: "panel-1" },
    session: { cancelToolCall },
  } as unknown as HandlerContext;
  return { sent, cancelToolCall, handlers: createChatHandlers(deps), ctx };
}

function cancel(h: ReturnType<typeof makeHarness>, msg: Partial<WebviewToExtensionMessage> & { toolUseId: string }): void {
  void h.handlers.cancelToolCall!({ type: "cancelToolCall", ...msg } as WebviewToExtensionMessage, h.ctx);
}

describe("cancelToolCall reports a cancel that found no live call", () => {
  it("posts toolCancelRejected carrying the requestId when the session returns false", () => {
    const h = makeHarness(false);
    cancel(h, { toolUseId: "call-1", requestId: "req-9" });

    expect(h.cancelToolCall).toHaveBeenCalledWith("call-1", undefined);
    expect(h.sent).toEqual([{ type: "toolCancelRejected", toolUseId: "call-1", requestId: "req-9" }]);
  });

  it("posts nothing when the session returns true, so a successful stop cannot clear the wrong card", () => {
    const h = makeHarness(true);
    cancel(h, { toolUseId: "call-1", requestId: "req-9" });

    expect(h.cancelToolCall).toHaveBeenCalledTimes(1);
    expect(h.sent).toEqual([]);
  });

  it("omits requestId entirely when the request had none, rather than sending it undefined", () => {
    const h = makeHarness(false);
    cancel(h, { toolUseId: "call-2" });

    const rejected = h.sent[0]!;
    expect(rejected).toEqual({ type: "toolCancelRejected", toolUseId: "call-2" });
    expect("requestId" in rejected).toBe(false);
  });

  it("still forwards the note to the session before reporting the rejection", () => {
    const h = makeHarness(false);
    cancel(h, { toolUseId: "call-3", note: "wrong loop" });

    expect(h.cancelToolCall).toHaveBeenCalledWith("call-3", "wrong loop");
    expect(h.sent).toEqual([{ type: "toolCancelRejected", toolUseId: "call-3" }]);
  });
});
