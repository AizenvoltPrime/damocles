import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { createChatHandlers } from "../chat-handlers";
import { createSessionHandlers } from "../session-handlers";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { HostInstance } from "../../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";

vi.mock("../../../../pi-session/session-store", () => ({ renamePiSession: vi.fn(), deletePiSession: vi.fn(), tagPiSession: vi.fn() }));
vi.mock("../../../../pi-session/pi-runtime", () => ({ PiRuntime: { exists: false, get: vi.fn() } }));
vi.mock("../../../../logger", () => ({ log: vi.fn() }));

const MESSAGE = "This conversation is already open in another panel.";

/** A panel whose session tracks its stored-session target the way PiSession does. */
function makePanel(panelId: string, holding: string | null) {
  let target = holding;
  const session = {
    holdsSession: (id: string) => target === id,
    setResumeSession: vi.fn((id: string | null) => { target = id; }),
    initializeEarly: vi.fn(async () => undefined),
    onWebviewReady: () => undefined,
    getToolStatus: () => ({}),
    seedCheckpoints: vi.fn(),
  };
  const host = { id: panelId, reveal: vi.fn() };
  const instance = { host, session } as unknown as HostInstance;
  const ctx = { host, session, panelId, permissionHandler: {} } as unknown as HandlerContext;
  return { panelId, session, host, instance, ctx, target: () => target };
}

function harness(...panels: ReturnType<typeof makePanel>[]) {
  const sent = new Map<unknown, ExtensionToWebviewMessage[]>(panels.map((p) => [p.host, []]));
  const order: string[] = [];
  const loadSessionHistory = vi.fn(async (sessionId: string) => { order.push(`load:${sessionId}`); });
  const deps = {
    workspacePath: "/ws",
    getPanels: () => new Map(panels.map((p) => [p.panelId, p.instance])),
    postMessage: (host: unknown, message: ExtensionToWebviewMessage) => {
      sent.get(host)!.push(message);
      order.push(message.type);
    },
    historyManager: { loadSessionHistory, extractRewindableUserIds: async () => [] },
    storageManager: {
      getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
      getPromptHistory: async () => ({ history: [], hasMore: false }),
      broadcastPromptHistoryEntry: vi.fn(),
    },
    settingsManager: {
      sendCurrentSettings: async () => undefined,
      sendAvailableModels: () => undefined,
      sendOpenAIModelPricing: () => undefined,
      sendMcpConfig: () => undefined,
      sendModelForPanel: () => undefined,
      sendThinkingForPanel: () => undefined,
    },
    getLanguagePreference: () => "en",
  } as unknown as HandlerDependencies;
  return { deps, sent, order, loadSessionHistory, chat: createChatHandlers(deps), session: createSessionHandlers(deps) };
}

let info: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  info = vi.spyOn(vscode.window, "showInformationMessage");
});
afterEach(() => {
  info.mockRestore();
});

const resume = (sessionId: string) => ({ type: "resumeSession", sessionId }) as WebviewToExtensionMessage;
const ready = (savedSessionId: string) => ({ type: "ready", savedSessionId }) as WebviewToExtensionMessage;

describe("one panel per stored conversation: history open", () => {
  it("reveals the panel that holds it, says so, and leaves the requesting panel's conversation alone", async () => {
    const mine = makePanel("host-1", "sess-mine");
    const other = makePanel("host-2", "sess-x");
    const h = harness(mine, other);

    await h.chat.resumeSession!(resume("sess-x"), mine.ctx);

    expect(other.host.reveal).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(MESSAGE);
    expect(mine.session.setResumeSession).not.toHaveBeenCalled();
    expect(mine.target()).toBe("sess-mine");
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
    // No resumeAccepted, so the webview never clears what it shows.
    expect(h.sent.get(mine.host)).toEqual([]);
  });

  it("reopening the conversation the same panel already holds loads it as before", async () => {
    const mine = makePanel("host-1", "sess-x");
    const other = makePanel("host-2", "sess-y");
    const h = harness(mine, other);

    await h.chat.resumeSession!(resume("sess-x"), mine.ctx);

    expect(mine.session.setResumeSession).toHaveBeenCalledWith("sess-x");
    expect(h.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(other.host.reveal).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("a conversation no panel holds is bound, and the webview hears resumeAccepted before the replay", async () => {
    const mine = makePanel("host-1", "sess-mine");
    const h = harness(mine, makePanel("host-2", "sess-y"));

    await h.chat.resumeSession!(resume("sess-x"), mine.ctx);

    expect(mine.target()).toBe("sess-x");
    expect(h.order).toEqual(["resumeAccepted", "load:sess-x", "sessionStarted"]);
  });
});

describe("one panel per stored conversation: panel restore", () => {
  it("two restored panels claiming one conversation: one resumes it, the other opens empty", async () => {
    const first = makePanel("host-1", null);
    const second = makePanel("host-2", null);
    const h = harness(first, second);

    await Promise.all([h.session.ready!(ready("sess-x"), first.ctx), h.session.ready!(ready("sess-x"), second.ctx)]);

    const resumed = [first, second].filter((p) => p.target() === "sess-x");
    const empty = [first, second].filter((p) => p.target() === null);
    expect(resumed).toHaveLength(1);
    expect(empty).toHaveLength(1);
    expect(h.loadSessionHistory).toHaveBeenCalledTimes(1);
    expect(empty[0]!.session.initializeEarly).toHaveBeenCalledTimes(1);
    expect(resumed[0]!.session.initializeEarly).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(MESSAGE);
    // A restore never pulls focus to the other panel.
    expect(first.host.reveal).not.toHaveBeenCalled();
    expect(second.host.reveal).not.toHaveBeenCalled();
  });
});
