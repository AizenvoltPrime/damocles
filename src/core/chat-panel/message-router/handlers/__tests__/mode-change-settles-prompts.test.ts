import { describe, it, expect, vi, afterAll, beforeEach } from "vitest";
import type { ToolCallEvent } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPermissionHandlers } from "../permission-handlers";
import { createSettingsHandlers } from "../settings-handlers";
import { ConfigManager } from "../../../settings-manager/managers/config-manager";
import { PermissionHandler } from "../../../../permission-handler";
import { runPermissionGate, type GatePermissionContext } from "../../../../pi-session/permission-gate";
import { ShellCancelStore } from "../../../../pi-session/tools/shell-cancel-registry";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import { TOOL_ASK_USER_QUESTION, TOOL_BROWSER_REQUEST_INPUT, TOOL_EXIT_PLAN_MODE } from "../../../../../shared/tool-names";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { HandlerContext, HandlerDependencies } from "../../types";

/**
 * A permission mode or YOLO change re-decides every open approval with the gate's own decision and
 * approves the ones the new state would not ask about. pi gates a whole parallel batch before running
 * any of it, so several prompts are open at once. Every test pairs what must stay open with a prompt
 * the same change approves.
 */

const SUBAGENT = "agent-call-1";

const workspace = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dam-recheck-ws-")));
const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "dam-recheck-out-")));
afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});
beforeEach(() => fs.rmSync(path.join(workspace, ".damocles"), { recursive: true, force: true }));

const canLink = (() => {
  const probe = path.join(workspace, "link-probe");
  try {
    fs.symlinkSync(outside, probe, "junction");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
})();

const file = (target: string): string => {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, "a");
  return target;
};
const editEvent = (toolCallId: string, filePath: string): ToolCallEvent =>
  ({ type: "tool_call", toolName: "Edit", toolCallId, input: { file_path: filePath, old_string: "a", new_string: "b" } }) as unknown as ToolCallEvent;
const bashEvent = (toolCallId: string, command = "npm install"): ToolCallEvent =>
  ({ type: "tool_call", toolName: "bash", toolCallId, input: { command } }) as unknown as ToolCallEvent;
const skillEvent = (toolCallId: string): ToolCallEvent =>
  ({ type: "tool_call", toolName: "Skill", toolCallId, input: { skill: "simplify" } }) as unknown as ToolCallEvent;

const QUESTION = {
  questions: [{ question: "Which?", header: "Pick", multiSelect: false, options: [{ label: "a", description: "first" }, { label: "b", description: "second" }] }],
};
const FORM = { title: "Log in", fields: [{ id: "user", label: "User", selector: "#user", type: "text" }] };

function chat() {
  const platform = createFakePlatform();
  const handler = new PermissionHandler(platform);
  handler.setWorkspacePath(workspace);
  handler.setCwd(workspace);
  const posted: ExtensionToWebviewMessage[] = [];
  handler.setPostMessage((msg) => posted.push(msg));
  handler.setPlanContentResolver(async () => "the plan");
  // Subagents are gated through the chat's own handler and its live plan-mode reader.
  const gate: GatePermissionContext = {
    permissionHandler: handler,
    isPlanMode: () => handler.getPermissionMode() === "plan",
    shellCancel: new ShellCancelStore().forContext(() => undefined),
    postMessage: (msg) => posted.push(msg),
  };
  const configManager = new ConfigManager(vi.fn(), platform);
  const deps = {
    postMessage: vi.fn(),
    platform,
    settingsManager: {
      handleSetPermissionMode: configManager.handleSetPermissionMode.bind(configManager),
      handleSetDangerouslySkipPermissions: configManager.handleSetDangerouslySkipPermissions.bind(configManager),
      sendCurrentSettings: vi.fn(async () => undefined),
    },
  } as unknown as HandlerDependencies;
  const ctx = { session: { setPermissionMode: vi.fn(async () => undefined) }, permissionHandler: handler, host: {}, panelId: "p1" } as unknown as HandlerContext;
  const routes = { ...createSettingsHandlers(deps), ...createPermissionHandlers(deps) };
  const send = async (msg: WebviewToExtensionMessage): Promise<void> => { await routes[msg.type]!(msg, ctx); };
  const raise = (event: ToolCallEvent, parentToolUseId: string | null = null) => runPermissionGate(event, gate, undefined, parentToolUseId);
  const ask = (toolName: string, input: Record<string, unknown>, toolUseID: string) =>
    handler.canUseTool(toolName, input, { signal: new AbortController().signal, toolUseID, parentToolUseId: null });
  const open = (): string[] => handler.pendingPrompts().map((prompt) => prompt.id).sort();
  const approvedUnasked = () => posted.filter((msg) => msg.type === "permissionAutoResolved");
  const running = (): string[] => posted.flatMap((msg) => (msg.type === "toolPending" ? [msg.toolUseId] : []));
  return { handler, send, raise, ask, open, approvedUnasked, running };
}

describe.each([
  ["the main agent's", "e1", "e2"],
  ["the subagent's", "e2", "e1"],
])("Yes, and accept all edits on %s Edit prompt", (_label, answered, other) => {
  it("approves the other agent's open Edit prompt, which runs and leaves the pending prompts", async () => {
    const { handler, send, raise, open, approvedUnasked, running } = chat();
    const main = raise(editEvent("e1", file(path.join(workspace, "main.ts"))));
    const sub = raise(editEvent("e2", file(path.join(workspace, "sub.ts"))), SUBAGENT);
    await expect.poll(open).toEqual(["e1", "e2"]);

    await send({ type: "setPermissionMode", mode: "acceptEdits" });
    await send({ type: "approveEdit", toolUseId: answered, approved: true });

    expect(await main).toBeUndefined();
    expect(await sub).toBeUndefined();
    expect(open()).toEqual([]);
    expect(approvedUnasked()).toContainEqual({
      type: "permissionAutoResolved",
      toolUseId: other,
      parentToolUseId: other === "e2" ? SUBAGENT : null,
      approvedBy: "acceptEdits",
    });
    expect(running()).toEqual(expect.arrayContaining(["e1", "e2"]));
    await handler.dispose();
  });
});

describe("a switch to acceptEdits", () => {
  it("leaves an open shell prompt open while it approves an open Edit", async () => {
    const { handler, send, raise, open, approvedUnasked } = chat();
    const shell = raise(bashEvent("b1"));
    const edit = raise(editEvent("e1", file(path.join(workspace, "edit.ts"))));
    await expect.poll(open).toEqual(["b1", "e1"]);

    await send({ type: "setPermissionMode", mode: "acceptEdits" });

    expect(await edit).toBeUndefined();
    expect(open()).toEqual(["b1"]);
    expect(approvedUnasked().map((msg) => msg.toolUseId)).toEqual(["e1"]);
    await send({ type: "approveEdit", toolUseId: "b1", approved: false });
    expect((await shell)?.block).toBe(true);
    await handler.dispose();
  });

  it.runIf(canLink)("leaves open an Edit whose path a link carries outside the cwd", async () => {
    const { handler, send, raise, open } = chat();
    const linked = path.join(workspace, "linked");
    fs.symlinkSync(outside, linked, "junction");
    try {
      file(path.join(outside, "target.ts"));
      void raise(editEvent("out", path.join(linked, "target.ts")));
      const inside = raise(editEvent("in", file(path.join(workspace, "inside.ts"))));
      await expect.poll(open).toEqual(["in", "out"]);

      await send({ type: "setPermissionMode", mode: "acceptEdits" });

      expect(await inside).toBeUndefined();
      expect(open()).toEqual(["out"]);
      await handler.dispose();
    } finally {
      fs.unlinkSync(linked);
    }
  });

  it("leaves open an Edit a settings ask rule names, which YOLO then approves", async () => {
    const { handler, send, raise, open, approvedUnasked } = chat();
    fs.mkdirSync(path.join(workspace, ".damocles"), { recursive: true });
    fs.writeFileSync(path.join(workspace, ".damocles", "settings.json"), JSON.stringify({ permissions: { ask: ["Edit(guarded.ts)"] } }));
    const guarded = raise(editEvent("g1", file(path.join(workspace, "guarded.ts"))));
    const plain = raise(editEvent("e1", file(path.join(workspace, "plain.ts"))));
    await expect.poll(open).toEqual(["e1", "g1"]);

    await send({ type: "setPermissionMode", mode: "acceptEdits" });
    expect(await plain).toBeUndefined();
    expect(open()).toEqual(["g1"]);

    await send({ type: "setDangerouslySkipPermissions", enabled: true });
    expect(await guarded).toBeUndefined();
    expect(open()).toEqual([]);
    expect(approvedUnasked().map((msg) => [msg.toolUseId, msg.approvedBy])).toEqual([["e1", "acceptEdits"], ["g1", "yolo"]]);
    await handler.dispose();
  });
});

describe("turning YOLO on", () => {
  it("approves the open Edit, shell and skill prompts and leaves the question and the form open", async () => {
    const { handler, send, raise, ask, open, approvedUnasked } = chat();
    const edit = raise(editEvent("e1", file(path.join(workspace, "yolo.ts"))), SUBAGENT);
    const shell = raise(bashEvent("b1"));
    const skill = raise(skillEvent("k1"));
    void ask(TOOL_ASK_USER_QUESTION, QUESTION, "q1");
    void ask(TOOL_BROWSER_REQUEST_INPUT, FORM, "f1");
    await expect.poll(open).toEqual(["b1", "e1", "f1", "k1", "q1"]);

    await send({ type: "setDangerouslySkipPermissions", enabled: true });

    expect(await edit).toBeUndefined();
    expect(await shell).toBeUndefined();
    expect(await skill).toBeUndefined();
    expect(open()).toEqual(["f1", "q1"]);
    expect(approvedUnasked().map((msg) => [msg.toolUseId, msg.approvedBy]).sort()).toEqual([["b1", "yolo"], ["e1", "yolo"], ["k1", "yolo"]]);
    await handler.dispose();
  });

  it("in plan mode leaves open the plan approval and an Edit raised before plan mode, which plan mode blocks", async () => {
    const { handler, send, raise, ask, open, approvedUnasked } = chat();
    void raise(editEvent("e1", file(path.join(workspace, "before-plan.ts"))));
    await expect.poll(open).toEqual(["e1"]);
    await send({ type: "setPermissionMode", mode: "plan" });
    const shell = raise(bashEvent("b1"));
    void ask(TOOL_EXIT_PLAN_MODE, {}, "p1");
    await expect.poll(open).toEqual(["b1", "e1", "p1"]);

    await send({ type: "setDangerouslySkipPermissions", enabled: true });

    expect(await shell).toBeUndefined();
    expect(open()).toEqual(["e1", "p1"]);
    expect(approvedUnasked().map((msg) => msg.toolUseId)).toEqual(["b1"]);
    await handler.dispose();
  });
});

describe("a switch to plan mode", () => {
  it("runs an open provably read-only command, which plan mode does not ask about, and leaves any other open", async () => {
    const { handler, send, raise, open, approvedUnasked } = chat();
    const status = raise(bashEvent("r1", "git status"));
    void raise(bashEvent("w1"));
    await expect.poll(open).toEqual(["r1", "w1"]);

    await send({ type: "setPermissionMode", mode: "plan" });

    expect(await status).toBeUndefined();
    expect(open()).toEqual(["w1"]);
    expect(approvedUnasked()).toEqual([{ type: "permissionAutoResolved", toolUseId: "r1", parentToolUseId: null, approvedBy: "plan" }]);
    await handler.dispose();
  });
});

describe("a switch back to default", () => {
  it("approves nothing, while YOLO afterwards approves every open approval", async () => {
    const { handler, send, raise, open, approvedUnasked } = chat();
    await send({ type: "setPermissionMode", mode: "acceptEdits" });
    const first = raise(bashEvent("b1"));
    const second = raise(bashEvent("b2"), SUBAGENT);
    await expect.poll(open).toEqual(["b1", "b2"]);

    await send({ type: "setPermissionMode", mode: "default" });
    expect(open()).toEqual(["b1", "b2"]);
    expect(approvedUnasked()).toEqual([]);

    await send({ type: "setDangerouslySkipPermissions", enabled: true });
    expect(await first).toBeUndefined();
    expect(await second).toBeUndefined();
    expect(open()).toEqual([]);
    await handler.dispose();
  });
});
