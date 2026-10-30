import { describe, expect, it, vi } from "vitest";
import { createChatHandlers } from "../chat-handlers";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { SendOutcome } from "../../../../chat-session";
import type { PanelHost } from "../../../../../platform/window-service";
import { makeMultiViewHost } from "../../../__tests__/panel-manager-harness";
import { postToSenders } from "../../../send-senders";

// A send from view-2 of a panel two views show; `routedTo` says where a later give-back naming it would go.
function setUp(session: Record<string, unknown>) {
  const panel = makeMultiViewHost();
  const ids: string[] = [];
  const deps = {
    postMessage: vi.fn(),
    storageManager: { broadcastPromptHistoryEntry: vi.fn() },
    worktrees: () => ({ interceptSend: () => false }),
    platform: {},
  } as unknown as HandlerDependencies;
  const ctx = {
    host: panel,
    reply: panel.viewHost!("view-2"),
    viewKey: "view-2",
    session: {
      turnRunning: false,
      beginSend: (correlationId: string) => {
        ids.push(correlationId);
        return session.ticket === null ? null : { signal: new AbortController().signal, end: () => undefined };
      },
      sendMessage: async () => session.outcome,
      queueInput: (_content: unknown, id: string) => {
        ids.push(id);
        return session.disposition;
      },
      mcpUserResources: () => undefined,
    },
    permissionHandler: { mcpResourceRuleFilter: async () => ({}), revokeSkillPreApproval: vi.fn() },
    ideContextManager: { getDisplayInfo: () => null },
    terminalAttachments: { displayInfo: () => [], restore: () => 0, take: () => [] },
    folder: { key: "/w", fsPath: "/w", projectScope: true },
    panelId: "p1",
  } as unknown as HandlerContext;
  const routedTo = (id: string): string => {
    let to = "";
    // the give-back's first post: its sender's view, or every view; a sender's other views then only drop the echo
    postToSenders(panel, { type: "promptReturned", content: [], reason: "promptRejected", correlationId: id } as ExtensionToWebviewMessage, (host: PanelHost) => {
      if (to === "") to = host === panel ? "every view" : "view-2";
    });
    return to;
  };
  const handlers = createChatHandlers(deps);
  const send = (type: "sendMessage" | "queueMessage", content = "hi") => handlers[type]!({ type, content } as WebviewToExtensionMessage, ctx);
  return { ids, routedTo, send };
}

describe("a send that ends with nothing more to give back", () => {
  it.each<[string, Record<string, unknown>]>([
    ["a send the session refuses to begin", { ticket: null }],
    ["a send pi never took", { outcome: "unsent" satisfies SendOutcome }],
    ["a send withdrawn before pi took it", { outcome: "withdrawn" satisfies SendOutcome }],
  ])("forgets the view of %s", async (_name, session) => {
    const h = setUp(session);
    await h.send("sendMessage");
    expect(h.routedTo(h.ids[0]!)).toBe("every view");
  });

  it("keeps the view of a prompt pi took, whose commit or return comes later", async () => {
    const h = setUp({ outcome: "sent" });
    await h.send("sendMessage");
    expect(h.routedTo(h.ids[0]!)).toBe("view-2");
  });

  it.each([["otherConversation"], [false]])("forgets the view of a queued message the session answered %s", async (disposition) => {
    const h = setUp({ disposition });
    await h.send("queueMessage");
    expect(h.routedTo(h.ids[0]!)).toBe("every view");
  });

  it("keeps the view of a queued message whose chip is answered later", async () => {
    const h = setUp({ disposition: "queued" });
    await h.send("queueMessage");
    expect(h.routedTo(h.ids[0]!)).toBe("view-2");
  });
});
