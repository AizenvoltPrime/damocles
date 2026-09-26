import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { createChatHandlers } from "../chat-handlers";
import { createSessionHandlers } from "../session-handlers";
import { findStoredSessionHolder } from "../../../session-ownership";
import { renamePiSession, tagPiSession } from "../../../../pi-session/session-store";
import type { FolderTarget } from "../../../../workspace-folders/folder-registry";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { HostInstance } from "../../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";

vi.mock("../../../../pi-session/session-store", () => ({ renamePiSession: vi.fn(), deletePiSession: vi.fn(), tagPiSession: vi.fn() }));
vi.mock("../../../../pi-session/pi-runtime", () => ({ PiRuntime: { exists: false, get: vi.fn() } }));
vi.mock("../../../../logger", () => ({ log: vi.fn() }));

const MESSAGE = "This conversation is already open in another panel.";

const target = (fsPath: string): FolderTarget => ({ key: fsPath, fsPath, name: fsPath, label: fsPath, projectScope: true });
const FOLDER_A = target("/a");
const FOLDER_B = target("/b");

/** A session that tracks its stored-session target the way PiSession does. */
function makeSession(holding: string | null) {
  let resumeTarget = holding;
  return {
    holdsSession: (id: string) => resumeTarget === id,
    setResumeSession: vi.fn((id: string | null) => { resumeTarget = id; }),
    initializeEarly: vi.fn(async () => undefined),
    onWebviewReady: () => undefined,
    getToolStatus: () => ({}),
    seedCheckpoints: vi.fn(),
    target: () => resumeTarget,
  };
}

/** A panel on folder A. Its `instance` is what the panel manager mutates when the panel switches folder. */
function makePanel(panelId: string, holding: string | null) {
  const session = makeSession(holding);
  const host = { id: panelId, reveal: vi.fn() };
  const instance = { host, session, folder: FOLDER_A } as unknown as HostInstance;
  const ctx = { host, session, panelId, permissionHandler: {}, folder: FOLDER_A } as unknown as HandlerContext;
  return { panelId, session, host, instance, ctx, target: () => session.target() };
}

type Panel = ReturnType<typeof makePanel>;

function harness(...panels: Panel[]) {
  const sent = new Map<unknown, ExtensionToWebviewMessage[]>(panels.map((p) => [p.host, []]));
  const order: string[] = [];
  const loadSessionHistory = vi.fn(async (cwd: string, sessionId: string) => { order.push(`load:${cwd}:${sessionId}`); });
  const folderOfSession = new Map<string, FolderTarget>();
  const byId = new Map(panels.map((p) => [p.panelId, p]));
  /** Mirrors PanelManager: a fresh session in the target folder on the same instance. */
  const switchPanelFolder = vi.fn(async (
    panelId: string,
    key: string,
    _reason: string,
    afterSwitch?: (instance: HostInstance) => Promise<boolean>,
  ): Promise<HostInstance | undefined> => {
    const panel = byId.get(panelId)!;
    const instance = panel.instance as unknown as { session: unknown; folder: FolderTarget };
    if (instance.folder.key !== key) {
      order.push(`switch:${key}`);
      instance.session = makeSession(null);
      instance.folder = key === FOLDER_B.key ? FOLDER_B : FOLDER_A;
    }
    await afterSwitch?.(panel.instance);
    order.push("gate-open");
    return panel.instance;
  });
  const deps = {
    getPanels: () => new Map(panels.map((p) => [p.panelId, p.instance])),
    switchPanelFolder,
    postWorkspaceFolderState: vi.fn(),
    folderRegistry: { resolve: (key: string) => [FOLDER_A, FOLDER_B].find((f) => f.key === key) },
    postMessage: (host: unknown, message: ExtensionToWebviewMessage) => {
      sent.get(host)!.push(message);
      order.push(message.type);
    },
    historyManager: { loadSessionHistory, extractRewindableUserIds: async () => [] },
    storageManager: {
      folderOf: async (id: string) => folderOfSession.get(id),
      getStoredSessions: async () => ({ sessions: [], hasMore: false, nextOffset: 0 }),
      getPromptHistory: async () => ({ history: [], hasMore: false }),
      broadcastPromptHistoryEntry: vi.fn(),
      invalidateSessionsCache: vi.fn(),
      updateSessionTagInCache: vi.fn(),
    },
    settingsManager: {
      sendCurrentSettings: async () => undefined,
      sendAvailableModels: () => undefined,
      sendMcpConfig: () => undefined,
      sendModelForPanel: () => undefined,
      sendThinkingForPanel: () => undefined,
    },
    getLanguagePreference: () => "en",
  } as unknown as HandlerDependencies;
  return { deps, sent, order, loadSessionHistory, folderOfSession, switchPanelFolder, chat: createChatHandlers(deps), session: createSessionHandlers(deps) };
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
    expect(h.order).toEqual(["resumeAccepted", "load:/a:sess-x", "sessionStarted", "gate-open"]);
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

describe("findStoredSessionHolder", () => {
  it("names the other panel holding the session and changes nothing", () => {
    const mine = makePanel("host-1", "sess-mine");
    const other = makePanel("host-2", "sess-x");
    const panels = new Map([[mine.panelId, mine.instance], [other.panelId, other.instance]]);

    expect(findStoredSessionHolder(panels, mine.ctx, "sess-x")).toBe(other.instance);
    expect(findStoredSessionHolder(panels, mine.ctx, "sess-mine")).toBeUndefined();
    expect(findStoredSessionHolder(panels, mine.ctx, "sess-none")).toBeUndefined();
    expect(mine.session.setResumeSession).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});

describe("resuming a conversation stored under another folder", () => {
  it("switches the panel to that folder first, then claims and replays it on the new session", async () => {
    const mine = makePanel("host-1", "sess-mine");
    const h = harness(mine);
    h.folderOfSession.set("sess-b", FOLDER_B);

    await h.chat.resumeSession!(resume("sess-b"), mine.ctx);

    expect(h.switchPanelFolder).toHaveBeenCalledWith("host-1", FOLDER_B.key, "resume", expect.any(Function));
    const now = mine.instance.session as unknown as ReturnType<typeof makeSession>;
    expect(now).not.toBe(mine.session);
    expect(now.target()).toBe("sess-b");
    expect(mine.session.setResumeSession).not.toHaveBeenCalled();
    // Claimed and replayed inside the switch, before queued webview messages are let through.
    expect(h.order).toEqual([`switch:${FOLDER_B.key}`, "resumeAccepted", "load:/b:sess-b", "sessionStarted", "gate-open"]);
  });

  it("refuses the claim when another panel took the session during the switch", async () => {
    const mine = makePanel("host-1", null);
    const other = makePanel("host-2", null);
    const h = harness(mine, other);
    h.folderOfSession.set("sess-b", FOLDER_B);
    h.switchPanelFolder.mockImplementationOnce(async (_panelId, _key, _reason, afterSwitch) => {
      other.session.setResumeSession("sess-b");
      (mine.instance as unknown as { session: unknown }).session = makeSession(null);
      (mine.instance as unknown as { folder: FolderTarget }).folder = FOLDER_B;
      await afterSwitch?.(mine.instance);
      return mine.instance;
    });

    await h.chat.resumeSession!(resume("sess-b"), mine.ctx);

    expect(other.host.reveal).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(MESSAGE);
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
  });

  it("stops when the switch did not happen", async () => {
    const mine = makePanel("host-1", "sess-mine");
    const h = harness(mine);
    h.folderOfSession.set("sess-b", FOLDER_B);
    h.switchPanelFolder.mockResolvedValueOnce(undefined);

    await h.chat.resumeSession!(resume("sess-b"), mine.ctx);

    expect(mine.target()).toBe("sess-mine");
    expect(h.loadSessionHistory).not.toHaveBeenCalled();
    expect(h.sent.get(mine.host)).toEqual([]);
  });

  it("resumes a session in no open folder on the panel's folder as it is now, not as it was at dispatch", async () => {
    const mine = makePanel("host-1", null);
    const h = harness(mine);
    // The panel moved to B after the message was dispatched from A.
    (mine.instance as unknown as { folder: FolderTarget }).folder = FOLDER_B;

    await h.chat.resumeSession!(resume("sess-x"), mine.ctx);

    expect(h.switchPanelFolder).toHaveBeenCalledWith("host-1", FOLDER_B.key, "resume", expect.any(Function));
    expect(h.order).not.toContain(`switch:${FOLDER_A.key}`);
    expect(h.loadSessionHistory).toHaveBeenCalledWith("/b", "sess-x", mine.host, mine.session);
  });

  it("reports the claim to the switch, so the resumed session is not started early", async () => {
    const mine = makePanel("host-1", null);
    const h = harness(mine);
    h.folderOfSession.set("sess-b", FOLDER_B);
    let claimed: boolean | undefined;
    h.switchPanelFolder.mockImplementationOnce(async (_panelId, _key, _reason, afterSwitch) => {
      claimed = await afterSwitch?.(mine.instance);
      return mine.instance;
    });

    await h.chat.resumeSession!(resume("sess-b"), mine.ctx);

    expect(claimed).toBe(true);
  });

  it("reveals the holder before any switch when the session is already open elsewhere", async () => {
    const mine = makePanel("host-1", null);
    const other = makePanel("host-2", "sess-b");
    const h = harness(mine, other);
    h.folderOfSession.set("sess-b", FOLDER_B);

    await h.chat.resumeSession!(resume("sess-b"), mine.ctx);

    expect(other.host.reveal).toHaveBeenCalledTimes(1);
    expect(h.switchPanelFolder).not.toHaveBeenCalled();
  });

  it("once one panel resumed it across folders, a second panel asking for it is shown the first", async () => {
    const first = makePanel("host-1", null);
    const second = makePanel("host-2", null);
    const h = harness(first, second);
    h.folderOfSession.set("sess-b", FOLDER_B);

    await h.chat.resumeSession!(resume("sess-b"), first.ctx);
    await h.chat.resumeSession!(resume("sess-b"), second.ctx);

    // Ownership follows the session the switch installed, not the one the first panel started with.
    expect(first.host.reveal).toHaveBeenCalledTimes(1);
    expect(h.switchPanelFolder).toHaveBeenCalledTimes(1);
    expect(second.instance.folder).toBe(FOLDER_A);
    expect(h.loadSessionHistory).toHaveBeenCalledTimes(1);
  });
});

describe("rename and tag of a conversation stored under another folder", () => {
  it("writes to that folder's store from a panel on folder A, without moving the panel", async () => {
    const mine = makePanel("host-1", "sess-mine");
    const h = harness(mine);
    h.folderOfSession.set("sess-b", FOLDER_B);

    await h.session.renameSession!({ type: "renameSession", sessionId: "sess-b", newName: "Beta work" } as WebviewToExtensionMessage, mine.ctx);
    await h.session.tagSession!({ type: "tagSession", sessionId: "sess-b", tag: "api" } as WebviewToExtensionMessage, mine.ctx);

    expect(renamePiSession).toHaveBeenCalledWith(FOLDER_B.fsPath, "sess-b", "Beta work");
    expect(tagPiSession).toHaveBeenCalledWith(FOLDER_B.fsPath, "sess-b", "api");
    expect(h.switchPanelFolder).not.toHaveBeenCalled();
    expect(mine.instance.folder).toBe(FOLDER_A);
  });
});
