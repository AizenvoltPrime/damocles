import { describe, expect, it, vi } from "vitest";
import { createChatHandlers } from "../chat-handlers";
import { TerminalAttachmentManager } from "../../../terminal-attachment-manager";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { QueueDisposition, SendOutcome } from "../../../../chat-session";

// PD-40: an image from the design preview's Screenshot carries its origin into core's handling of the user's message, so a
// later reference rule can leave it out; an origin core does not know never gets that far.
function harness() {
  const sendMessage = vi.fn(async (): Promise<SendOutcome> => "sent");
  const queueInput = vi.fn((): QueueDisposition => "queued");
  const deps = {
    postMessage: (_target: unknown, _message: ExtensionToWebviewMessage) => undefined,
    storageManager: { broadcastPromptHistoryEntry: vi.fn() },
    markUserTypedDuringTurn: vi.fn(),
    worktrees: () => ({ interceptSend: () => false }),
    workspaceManager: { findSkill: async () => undefined, findCommand: async () => undefined },
    platform: {},
  } as unknown as HandlerDependencies;
  const ctx = {
    folder: { key: "/cwd", fsPath: "/cwd", name: "ws", label: "ws", projectScope: true },
    host: { id: "panel-1" },
    reply: { id: "view-a" },
    terminalAttachments: new TerminalAttachmentManager(() => {}),
    ideContextManager: { getDisplayInfo: () => null },
    permissionHandler: { revokeSkillPreApproval: vi.fn() },
    session: {
      memorySessionId: "sess-1",
      currentPromptIndex: 0,
      turnRunning: false,
      beginSend: () => ({ signal: new AbortController().signal, end: () => undefined }),
      resolveSlashInvocation: vi.fn(),
      sendMessage,
      queueInput,
    },
  } as unknown as HandlerContext;
  return { handlers: createChatHandlers(deps), ctx, sendMessage, queueInput };
}

const image = (origin?: string) => ({ type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" }, ...(origin !== undefined ? { origin } : {}) });

describe("the preview origin marker of a sent image", () => {
  it("reaches the session's send with the image", async () => {
    const h = harness();
    const content = [{ type: "text" as const, text: "make the header shorter" }, image("designPreview"), image()];
    await h.handlers.sendMessage!({ type: "sendMessage", content, sessionId: null } as WebviewToExtensionMessage, h.ctx);
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const [sent, , , broadcast] = h.sendMessage.mock.calls[0] as unknown as [unknown, unknown, unknown, { contentBlocks?: unknown[] }];
    expect(sent).toEqual(content);
    expect(broadcast.contentBlocks).toEqual(content);
  });

  it("drops an origin core does not know and keeps the image", async () => {
    const h = harness();
    await h.handlers.sendMessage!({ type: "sendMessage", content: [image("reference"), image("designPreview")], sessionId: null } as unknown as WebviewToExtensionMessage, h.ctx);
    expect((h.sendMessage.mock.calls[0] as unknown as [unknown[]])[0]).toEqual([image(), image("designPreview")]);
  });

  it("reaches the session's queue with a message sent mid-turn, an unknown origin dropped", async () => {
    const h = harness();
    await h.handlers.queueMessage!({ type: "queueMessage", content: [{ type: "text", text: "and the footer" }, image("designPreview"), image("reference")], sessionId: null } as unknown as WebviewToExtensionMessage, h.ctx);
    expect(h.queueInput).toHaveBeenCalledTimes(1);
    expect((h.queueInput.mock.calls[0] as unknown as [unknown[]])[0]).toEqual([{ type: "text", text: "and the footer" }, image("designPreview"), image()]);
  });
});
