import { describe, it, expect, vi } from "vitest";
import { createChatHandlers } from "../chat-handlers";
import { TerminalAttachmentManager } from "../../../terminal-attachment-manager";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { QueueRefusal, SendOutcome, SendTicket } from "../../../../chat-session";

/**
 * The composer clears as it sends, before core answers. A send core refuses because a turn, a send or a compaction took the
 * session meanwhile, or a queued message core refused, has to come back to the composer that sent it, or it is lost.
 */
function makeHarness(session: { turnRunning: boolean; beginSend?: () => SendTicket | null; sendMessage?: () => Promise<SendOutcome>; queueInput?: () => QueueRefusal }) {
  const toSender: ExtensionToWebviewMessage[] = [];
  const toPanel: ExtensionToWebviewMessage[] = [];
  const reply = { id: "view-a" };
  const host = { id: "panel-1" };
  const storageManager = { broadcastPromptHistoryEntry: vi.fn() };
  const deps = {
    postMessage: (target: unknown, message: ExtensionToWebviewMessage) => { (target === reply ? toSender : toPanel).push(message); },
    storageManager,
    markUserTypedDuringTurn: vi.fn(),
    worktrees: () => ({ interceptSend: () => false }),
    workspaceManager: { findSkill: async () => undefined, findCommand: async () => undefined },
    platform: {},
  } as unknown as HandlerDependencies;
  const terminalAttachments = new TerminalAttachmentManager(() => {});
  const ctx = {
    folder: { key: "/cwd", fsPath: "/cwd", name: "ws", label: "ws", projectScope: true },
    host,
    reply,
    terminalAttachments,
    ideContextManager: { getDisplayInfo: () => null },
    permissionHandler: { revokeSkillPreApproval: vi.fn() },
    session: {
      memorySessionId: "sess-1",
      currentPromptIndex: 0,
      resolveSlashInvocation: vi.fn(async () => ({ kind: "command" as const })),
      // a session another send, a turn or a compaction holds refuses every claim
      sendMessage: vi.fn(async (): Promise<SendOutcome> => "busy"),
      ...session,
    },
  } as unknown as HandlerContext;
  return { toSender, toPanel, ctx, handlers: createChatHandlers(deps), terminalAttachments, storageManager };
}

/** The sender's spinner: armed by its send, then set by each `processing` core posts it. */
function spinnerAfter(posted: readonly ExtensionToWebviewMessage[]): boolean {
  return posted.reduce((shown, m) => (m.type === "processing" ? m.isProcessing : shown), true);
}

const IMAGE = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" } };

describe("a send core refuses goes back to the composer", () => {
  it("a composer send refused as busy returns its text to the sender's composer with sendInProgress", async () => {
    const h = makeHarness({ turnRunning: true, beginSend: () => null });
    h.terminalAttachments.add({ kind: "terminal", source: "selection", commandLine: null, exitCode: null, terminalTitle: "bash", text: "ok", omittedLines: 0 });
    const content = [{ type: "text" as const, text: "please fix the build" }, IMAGE];
    await h.handlers.sendMessage!({ type: "sendMessage", content, sessionId: null, terminalAttachmentIds: h.terminalAttachments.displayInfo().map((a) => a.id) } as WebviewToExtensionMessage, h.ctx);

    const returned = h.toSender.filter((m) => m.type === "promptReturned");
    expect(returned).toEqual([{ type: "promptReturned", content, reason: "sendInProgress", correlationId: expect.stringMatching(/^corr-/) }]);
    expect(h.toPanel.some((m) => m.type === "promptReturned")).toBe(false);
    // the chips were never taken, so they stay in the composer
    expect(h.terminalAttachments.displayInfo()).toHaveLength(1);
    expect(h.toSender.some((m) => m.type === "error")).toBe(false);
    // never sent, so no view's prompt history records it
    expect(h.storageManager.broadcastPromptHistoryEntry).not.toHaveBeenCalled();
  });

  // pi's extension command, resolved first because terminal output is attached, claims the session's send as a message does
  it("a slash command refused as busy comes back the same way, with the refusal its one notice", async () => {
    const h = makeHarness({ turnRunning: false, beginSend: () => null });
    h.terminalAttachments.add({ kind: "terminal", source: "selection", commandLine: null, exitCode: null, terminalTitle: "bash", text: "ok", omittedLines: 0 });
    const terminalAttachmentIds = h.terminalAttachments.displayInfo().map((a) => a.id);
    await h.handlers.sendMessage!({ type: "sendMessage", content: "/todos", sessionId: null, terminalAttachmentIds } as WebviewToExtensionMessage, h.ctx);
    expect(h.toSender.filter((m) => m.type === "promptReturned")).toEqual([
      { type: "promptReturned", content: [{ type: "text", text: "/todos" }], reason: "sendInProgress", correlationId: expect.stringMatching(/^corr-/) },
    ]);
    // the attached output stays in the composer with the message, so no notice says it stays for the next one
    expect([...h.toSender, ...h.toPanel].some((m) => m.type === "notification")).toBe(false);
    expect(h.storageManager.broadcastPromptHistoryEntry).not.toHaveBeenCalled();
    expect(h.ctx.session.sendMessage).not.toHaveBeenCalled();
  });

  it("a send or a slash command the session took is recorded once in every view's prompt history, and the command says its chips stay", async () => {
    const ticket = { signal: new AbortController().signal, end: () => undefined } as unknown as SendTicket;
    const h = makeHarness({ turnRunning: false, beginSend: () => ticket, sendMessage: async () => "sent" });
    await h.handlers.sendMessage!({ type: "sendMessage", content: "please fix the build", sessionId: null } as WebviewToExtensionMessage, h.ctx);
    h.terminalAttachments.add({ kind: "terminal", source: "selection", commandLine: null, exitCode: null, terminalTitle: "bash", text: "ok", omittedLines: 0 });
    const terminalAttachmentIds = h.terminalAttachments.displayInfo().map((a) => a.id);
    await h.handlers.sendMessage!({ type: "sendMessage", content: "/todos", sessionId: null, terminalAttachmentIds } as WebviewToExtensionMessage, h.ctx);

    expect(h.storageManager.broadcastPromptHistoryEntry.mock.calls).toEqual([["please fix the build"], ["/todos"]]);
    expect(h.toSender.filter((m) => m.type === "notification")).toHaveLength(1);
    expect(h.terminalAttachments.displayInfo()).toHaveLength(1);
  });

  it.each([
    ["runEnded", "queueRunEnded"],
    ["budgetStopped", "queueBudgetStopped"],
    ["noRuntime", "queueNoRuntime"],
  ] as const)("a queued message core refused as %s comes back with %s, so its note says why", async (refusal, reason) => {
    const h = makeHarness({ turnRunning: false, queueInput: () => refusal });
    await h.handlers.queueMessage!({ type: "queueMessage", content: "and add a test", sessionId: null } as WebviewToExtensionMessage, h.ctx);
    expect(h.toSender.filter((m) => m.type === "promptReturned")).toEqual([{ type: "promptReturned", content: [{ type: "text", text: "and add a test" }], reason }]);
    expect([...h.toSender, ...h.toPanel].some((m) => m.type === "notification")).toBe(false);
  });

  it.each([true, false])("after either refusal the view's processing state matches core's run state (a turn running: %s)", async (turnRunning) => {
    const busy = makeHarness({ turnRunning, beginSend: () => null });
    await busy.handlers.sendMessage!({ type: "sendMessage", content: "please fix the build", sessionId: null } as WebviewToExtensionMessage, busy.ctx);
    expect(spinnerAfter(busy.toSender)).toBe(turnRunning);

    const queued = makeHarness({ turnRunning, queueInput: () => "runEnded" });
    await queued.handlers.queueMessage!({ type: "queueMessage", content: "and add a test", sessionId: null } as WebviewToExtensionMessage, queued.ctx);
    expect(spinnerAfter(queued.toSender)).toBe(turnRunning);
  });
});
