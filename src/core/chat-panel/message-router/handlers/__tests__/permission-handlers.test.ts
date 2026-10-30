import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared ordered event log + recorded writes, populated by the fs mock and the session mock so the test
// can assert the continuation plan file is written right after the swap and BEFORE the turn runs.
const H = vi.hoisted(() => ({ events: [] as string[], writes: [] as { path: string; content: string }[] }));

vi.mock("fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async (p: unknown, content: unknown) => {
    H.events.push(`write:${String(p)}`);
    H.writes.push({ path: String(p), content: String(content) });
  }),
}));

vi.mock("../../../session-file-path", () => ({ resolveSessionFilePath: vi.fn(async () => null) }));

const syncRules = vi.hoisted(() => vi.fn(async (): Promise<LocalizedText[]> => []));
vi.mock("../../../settings-manager/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../settings-manager/utils")>()),
  syncPermissionRulesToSettings: syncRules,
}));

import { createPermissionHandlers } from "../permission-handlers";
import { ApprovalManager } from "../../../../permission-handler/managers/approval-manager";
import { PermissionState } from "../../../../permission-handler/state";
import type { DiffManager } from "../../../../permission-handler/diff-manager";
import type { PermissionUpdate } from "../../../../../shared/types/permissions";
import type { LocalizedText } from "../../../../../shared/localized-text";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import { l } from "../../../../l10n";
import { buildPlanImplementationMessage } from "../../utils";
import { computePlanFilePath } from "../../../../paths";
import type { HandlerContext, HandlerDependencies } from "../../types";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";

function setup() {
  H.events.length = 0;
  H.writes.length = 0;
  let sessionId = "old-1aaaaaaa";
  const session = {
    getPlanFilePath: vi.fn(() => "/old-plan.md"),
    getPlanContent: vi.fn<() => Promise<string | null>>(async () => "# Plan: do X"),
    persistenceSessionId: "old-1aaaaaaa",
    get currentSessionId() {
      return sessionId;
    },
    clear: vi.fn(() => {
      H.events.push("clear");
    }),
    whenReplaced: vi.fn(async () => {
      H.events.push("swap");
      sessionId = "new-2bbbbbbb";
    }),
    sendMessage: vi.fn(async () => {
      H.events.push("send-start");
      await new Promise((r) => setTimeout(r, 5));
      H.events.push("send-resolve");
    }),
  };
  const permissionHandler = { resolvePlanApproval: vi.fn() };
  const settingsManager = {
    handleSetPermissionMode: vi.fn(async () => undefined),
    sendCurrentSettings: vi.fn(async () => undefined),
    sendModelForPanel: vi.fn(),
  };
  const platform = createFakePlatform();
  const deps = {
    postMessage: vi.fn((_host: unknown, message: { type: string }) => {
      H.events.push(`post:${message.type}`);
    }),
    settingsManager,
    platform,
  } as unknown as HandlerDependencies;
  const ctx = { folder: { key: "/ws", fsPath: "/ws", name: "ws", label: "ws", projectScope: true }, host: {}, session, permissionHandler, panelId: "p1" } as unknown as HandlerContext;
  return { session, permissionHandler, settingsManager, deps, ctx, platform };
}

describe("approvePlan — clear context", () => {
  beforeEach(() => {
    H.events.length = 0;
    H.writes.length = 0;
  });

  it("writes the continuation plan file right after the swap, before the implementation turn runs", async () => {
    const { deps, ctx } = setup();
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true } as never,
      ctx,
    );

    // The full plan handed to the continuation comes from the on-disk file (getPlanContent), not a
    // webview-echoed summary.
    const newMessage = buildPlanImplementationMessage("# Plan: do X", null);
    const continuationPath = computePlanFilePath("new-2bbbbbbb", newMessage);

    // The continuation plan was written, to the SAME path resolvePlanFilePath would compute (id + first
    // message = the implementation prompt), with the on-disk plan content.
    const written = H.writes.find((w) => w.path === continuationPath);
    expect(written?.content).toBe("# Plan: do X");

    // Crux: the continuation write happens after the swap and BEFORE the turn even starts — so "view
    // session plan" works the moment the new session is created, not only after streaming ends.
    const writeIdx = H.events.indexOf(`write:${continuationPath}`);
    const swapIdx = H.events.indexOf("swap");
    const sendStartIdx = H.events.indexOf("send-start");
    expect(swapIdx).toBeGreaterThanOrEqual(0);
    expect(writeIdx).toBeGreaterThan(swapIdx);
    expect(writeIdx).toBeLessThan(sendStartIdx);
  });

  it("clears the session before the webview drops the conversation, so the queue the clear returns reaches the composer", async () => {
    const { deps, ctx } = setup();
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true } as never,
      ctx,
    );

    // A queueCancelled that lands after sessionCleared finds no chip or echo left to return.
    expect(H.events.indexOf("clear")).toBeGreaterThanOrEqual(0);
    expect(H.events.indexOf("clear")).toBeLessThan(H.events.indexOf("post:sessionCleared"));
  });

  it("sources the continuation plan from getPlanContent (the on-disk file), not the webview", async () => {
    const { session, deps, ctx } = setup();
    session.getPlanContent.mockResolvedValueOnce("# Plan: from disk");
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true } as never,
      ctx,
    );

    const newMessage = buildPlanImplementationMessage("# Plan: from disk", null);
    const continuationPath = computePlanFilePath("new-2bbbbbbb", newMessage);
    const written = H.writes.find((w) => w.path === continuationPath);
    expect(written?.content).toBe("# Plan: from disk");
  });

  it("does NOT write/overwrite the planning session's own plan file", async () => {
    const { deps, ctx } = setup();
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true } as never,
      ctx,
    );
    expect(H.events).not.toContain("write:/old-plan.md");
    expect(H.writes.some((w) => w.path === "/old-plan.md")).toBe(false);
  });

  describe("refused as busy, because a send, a turn or a compaction took the new session first", () => {
    function refused(turnRunning: boolean) {
      const h = setup();
      const toPanel: ExtensionToWebviewMessage[] = [];
      const toApprover: ExtensionToWebviewMessage[] = [];
      const host = { id: "panel" };
      const reply = { id: "approving view" };
      Object.assign(h.session, { turnRunning, sendMessage: vi.fn(async () => "busy" as const) });
      Object.assign(h.deps, { postMessage: (target: unknown, message: ExtensionToWebviewMessage) => (target === reply ? toApprover : toPanel).push(message) });
      Object.assign(h.ctx, { host, reply });
      return { ...h, toPanel, toApprover };
    }
    /** A view's spinner: raised by the clear's pending message, then set by each `processing` core posts it. */
    const spinnerAfter = (posted: readonly ExtensionToWebviewMessage[]): boolean =>
      posted.reduce((shown, m) => (m.type === "sessionCleared" && m.pendingMessage ? true : m.type === "processing" ? m.isProcessing : shown), false);

    it.each([true, false])("lowers every view's spinner unless a turn runs (a turn running: %s)", async (turnRunning) => {
      const h = refused(turnRunning);
      await createPermissionHandlers(h.deps).approvePlan!({ type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true } as never, h.ctx);
      expect(spinnerAfter(h.toPanel)).toBe(turnRunning);
    });

    it("tells the approving view the plan was not sent, with no feedback typed", async () => {
      const h = refused(false);
      await createPermissionHandlers(h.deps).approvePlan!({ type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true } as never, h.ctx);
      expect(h.toPanel.filter((m) => m.type === "promptReturned")).toEqual([{ type: "promptReturned", content: [], reason: "sendInProgress", correlationId: expect.stringMatching(/^plan-impl-/) }]);
      expect(h.toApprover).toEqual([{ type: "notification", message: l("The approved plan was not sent, because this chat started working on something else first."), notificationType: "warning" }]);
    });

    it("gives the typed feedback back to the approving view with the same notice", async () => {
      const h = refused(false);
      await createPermissionHandlers(h.deps).approvePlan!({ type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true, feedback: " keep the tests " } as never, h.ctx);
      expect(h.toApprover).toEqual([{
        type: "promptReturned",
        content: [{ type: "text", text: "keep the tests" }],
        reason: "sendInProgress",
        detail: l("The approved plan was not sent, because this chat started working on something else first."),
      }]);
    });
  });

  it("skips the swap and persists nothing when the plan file is gone (defensive)", async () => {
    const { session, permissionHandler, deps, ctx, platform } = setup();
    session.getPlanContent.mockResolvedValueOnce(null);
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, clearContext: true } as never,
      ctx,
    );
    expect(H.writes).toHaveLength(0);
    expect(H.events).not.toContain("clear");
    expect(session.sendMessage).not.toHaveBeenCalled();
    expect(permissionHandler.resolvePlanApproval).toHaveBeenCalledWith("t1", false, expect.anything());
    expect(platform.notifications.calls.map((c) => c.level)).toEqual(["info"]);
  });
});

describe("approvePlan — normal approve (no clear context)", () => {
  beforeEach(() => {
    H.events.length = 0;
    H.writes.length = 0;
  });

  it("writes NO plan file — the model's own plan file is already authoritative", async () => {
    const { session, permissionHandler, deps, ctx } = setup();
    const handlers = createPermissionHandlers(deps);
    await handlers.approvePlan!(
      { type: "approvePlan", toolUseId: "t1", approved: true, approvalMode: "acceptEdits" } as never,
      ctx,
    );
    // No overwrite of the planning session's plan file (the old "guaranteed write" was removed); and the
    // handler must not even read the plan on this path.
    expect(H.writes).toHaveLength(0);
    expect(session.getPlanContent).not.toHaveBeenCalled();
    expect(session.getPlanFilePath).not.toHaveBeenCalled();
    expect(permissionHandler.resolvePlanApproval).toHaveBeenCalledWith("t1", true, expect.anything());
  });
});

describe("approveEdit — saving an always-allow rule", () => {
  const RULE: PermissionUpdate[] = [{
    type: "addRules",
    rules: [{ toolName: "Bash", ruleContent: "git:*" }],
    behavior: "allow",
    destination: "localSettings",
  }];

  function approvalSetup() {
    syncRules.mockClear();
    const state = new PermissionState();
    const diffManager = { closeDiffView: async () => undefined } as unknown as DiffManager;
    const manager = new ApprovalManager(state, diffManager, () => vi.fn());
    const { deps, ctx, platform } = setup();
    const permissionHandler = {
      resolveApproval: manager.resolveApproval.bind(manager),
      savingPermissionRules: vi.fn(),
    };
    const approveEdit = createPermissionHandlers(deps).approveEdit!;
    const answer = (toolUseId: string) => approveEdit(
      { type: "approveEdit", toolUseId, approved: true, updatedPermissions: RULE } as never,
      { ...ctx, permissionHandler } as unknown as HandlerContext,
    );
    return { state, manager, answer, platform, permissionHandler };
  }

  const shellCall = (toolUseID: string) => ({ signal: new AbortController().signal, toolUseID, parentToolUseId: null });

  it("saves to the folder the prompt was raised in, not the one the panel shows when the click lands", async () => {
    const { state, manager, answer, permissionHandler } = approvalSetup();
    state.workspacePath = "/folder-a";
    const toolCall = manager.handleShellPermission("Bash", { command: "git status" }, shellCall("t1"));
    state.workspacePath = "/folder-b";

    await answer("t1");

    expect((await toolCall).behavior).toBe("allow");
    expect(syncRules).toHaveBeenCalledWith(RULE, "/folder-a");
    // the chat's next call waits for this write, not the evaluator's cached files
    expect(permissionHandler.savingPermissionRules).toHaveBeenCalledExactlyOnceWith(syncRules.mock.results[0]!.value);
  });

  it("hands the evaluator the write before it lands, since the approved call already runs", async () => {
    const { state, manager, answer, permissionHandler } = approvalSetup();
    let land!: (failures: LocalizedText[]) => void;
    syncRules.mockReturnValueOnce(new Promise((resolve) => (land = resolve)));
    state.workspacePath = "/folder-a";
    const toolCall = manager.handleShellPermission("Bash", { command: "git status" }, shellCall("t1"));

    const answered = answer("t1");
    expect((await toolCall).behavior).toBe("allow");
    await vi.waitFor(() => expect(permissionHandler.savingPermissionRules).toHaveBeenCalledOnce());
    land([]);
    await answered;
  });

  it("tells the user about each rule that was not saved", async () => {
    const { state, manager, answer, platform } = approvalSetup();
    syncRules.mockResolvedValueOnce([{ message: "Could not save {0}: {1}", args: ["a.json", "EACCES"] }, { message: "Could not save {0}: {1}", args: ["b.json", "EACCES"] }]);
    state.workspacePath = "/folder-a";
    const toolCall = manager.handleShellPermission("Bash", { command: "git status" }, shellCall("t1"));

    await answer("t1");

    expect((await toolCall).behavior).toBe("allow");
    expect(platform.notifications.calls).toEqual([
      { level: "warn", message: "Could not save a.json: EACCES", text: { message: "Could not save {0}: {1}", args: ["a.json", "EACCES"] }, actions: [] },
      { level: "warn", message: "Could not save b.json: EACCES", text: { message: "Could not save {0}: {1}", args: ["b.json", "EACCES"] }, actions: [] },
    ]);
  });

  it("saves nothing for a click that matches no pending approval", async () => {
    const { answer } = approvalSetup();

    await answer("gone");

    expect(syncRules).not.toHaveBeenCalled();
  });
});
