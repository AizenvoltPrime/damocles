import { describe, it, expect, vi } from "vitest";
import { createChatHandlers } from "../chat-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import { TerminalAttachmentManager } from "../../../terminal-attachment-manager";

/** An opted-in chat's first prompt is held for its worktree only when it is a prompt: never an empty send or a local command. */
function harness() {
  const sent: ExtensionToWebviewMessage[] = [];
  const interceptSend = vi.fn((_panelId: string, _message: WebviewToExtensionMessage) => true);
  const preApproveSkill = vi.fn();
  const revokeSkillPreApproval = vi.fn();
  const deps = {
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    storageManager: { broadcastPromptHistoryEntry: vi.fn() },
    workspaceManager: { findSkill: async (name: string) => (name === "fix" ? { name } : undefined), findCommand: async () => undefined },
    markUserTypedDuringTurn: vi.fn(),
    worktrees: () => ({ interceptSend }),
  } as unknown as HandlerDependencies;
  const session = { sendMessage: vi.fn(async () => "sent"), compact: vi.fn(async () => undefined), turnRunning: false, currentPromptIndex: 0 };
  const ctx = {
    panelId: "p1",
    host: { id: "panel-1" },
    session,
    permissionHandler: { preApproveSkill, revokeSkillPreApproval },
    ideContextManager: { getDisplayInfo: () => null },
    terminalAttachments: new TerminalAttachmentManager(() => undefined),
  } as unknown as HandlerContext;
  const handlers = createChatHandlers(deps);
  const send = (content: string) => handlers.sendMessage!({ type: "sendMessage", content } as WebviewToExtensionMessage, ctx);
  return { sent, interceptSend, session, preApproveSkill, revokeSkillPreApproval, send };
}

describe("sendMessage of a chat whose first prompt waits for its worktree", () => {
  it("holds a prompt, and never an empty send or a command handled here", async () => {
    const h = harness();
    await h.send("   ");
    await h.send("/compact");
    expect(h.interceptSend).not.toHaveBeenCalled();
    expect(h.session.compact).toHaveBeenCalledOnce();
    await h.send("Fix the login page");
    expect(h.interceptSend).toHaveBeenCalledOnce();
    expect(h.session.sendMessage).not.toHaveBeenCalled();
  });

  it("holds a skill invocation without keeping its pre-approval, which its release grants again", async () => {
    const h = harness();
    await h.send("/fix the login page");
    expect(h.interceptSend).toHaveBeenCalledOnce();
    expect(h.preApproveSkill).toHaveBeenCalledWith("fix");
    expect(h.revokeSkillPreApproval).toHaveBeenCalledWith("fix");
    expect(h.session.sendMessage).not.toHaveBeenCalled();
  });
});
