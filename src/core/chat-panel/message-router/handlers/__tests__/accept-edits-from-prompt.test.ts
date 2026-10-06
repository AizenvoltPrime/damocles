import { describe, it, expect, vi, afterAll } from "vitest";
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
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { HandlerContext, HandlerDependencies } from "../../types";

/**
 * "Yes, and accept all edits this session" posts `setPermissionMode` then `approveEdit` from any agent's edit
 * prompt. These route both through the real handlers into the real gate every nested agent shares.
 */

const SUBAGENT = "agent-call-1";
const TEAM_AGENT = "team-agent-1";

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "dam-accept-edits-"));
afterAll(() => fs.rmSync(workspace, { recursive: true, force: true }));
const file = (name: string): string => {
  const target = path.join(workspace, name);
  fs.writeFileSync(target, "a");
  return target;
};

const editEvent = (toolCallId: string, name: string): ToolCallEvent =>
  ({ type: "tool_call", toolName: "Edit", toolCallId, input: { file_path: file(name), old_string: "a", new_string: "b" } }) as unknown as ToolCallEvent;
const bashEvent = (toolCallId: string): ToolCallEvent =>
  ({ type: "tool_call", toolName: "bash", toolCallId, input: { command: "npm install" } }) as unknown as ToolCallEvent;

function chat() {
  const platform = createFakePlatform();
  const handler = new PermissionHandler(platform);
  handler.setWorkspacePath(workspace);
  handler.setCwd(workspace);
  handler.setPermissionMode("default");
  const prompts: Array<Extract<ExtensionToWebviewMessage, { type: "requestPermission" }>> = [];
  handler.setPostMessage((msg) => { if (msg.type === "requestPermission") prompts.push(msg); });
  // Subagents and team agents are gated through the chat's own handler and its live plan-mode reader.
  const gate: GatePermissionContext = {
    permissionHandler: handler,
    isPlanMode: () => handler.getPermissionMode() === "plan",
    shellCancel: new ShellCancelStore().forContext(() => undefined),
  };
  const configManager = new ConfigManager(vi.fn(), platform);
  const deps = {
    postMessage: vi.fn(),
    platform,
    settingsManager: {
      handleSetPermissionMode: configManager.handleSetPermissionMode.bind(configManager),
      sendCurrentSettings: vi.fn(async () => undefined),
    },
  } as unknown as HandlerDependencies;
  const ctx = { session: { setPermissionMode: vi.fn(async () => undefined) }, permissionHandler: handler, host: {}, panelId: "p1" } as unknown as HandlerContext;
  const routes = { ...createSettingsHandlers(deps), ...createPermissionHandlers(deps) };
  const send = async (msg: WebviewToExtensionMessage): Promise<void> => { await routes[msg.type]!(msg, ctx); };
  return { handler, prompts, gate, send };
}

describe.each([
  ["a subagent", SUBAGENT],
  ["a team agent", TEAM_AGENT],
])("Yes, and accept all edits on %s's Edit prompt", (_label, promptingAgent) => {
  it("switches the chat to acceptEdits, so every agent's later edit runs unasked while its shell command still asks", async () => {
    const { handler, prompts, gate, send } = chat();
    const prompted = runPermissionGate(editEvent("e1", "first.ts"), gate, undefined, promptingAgent);
    await expect.poll(() => prompts.length).toBe(1);
    expect(prompts[0]).toMatchObject({ toolUseId: "e1", toolName: "Edit", parentToolUseId: promptingAgent });

    await send({ type: "setPermissionMode", mode: "acceptEdits" });
    await send({ type: "approveEdit", toolUseId: "e1", approved: true });

    expect(await prompted).toBeUndefined();
    expect(handler.getPermissionMode()).toBe("acceptEdits");
    expect(await runPermissionGate(editEvent("e2", "same-agent.ts"), gate, undefined, promptingAgent)).toBeUndefined();
    expect(await runPermissionGate(editEvent("e3", "other-subagent.ts"), gate, undefined, "agent-call-2")).toBeUndefined();
    expect(await runPermissionGate(editEvent("e4", "other-team-agent.ts"), gate, undefined, "team-agent-2")).toBeUndefined();
    expect(await runPermissionGate(editEvent("e5", "main.ts"), gate, undefined, null)).toBeUndefined();
    expect(prompts).toHaveLength(1);

    const shell = runPermissionGate(bashEvent("s1"), gate, undefined, promptingAgent);
    await expect.poll(() => prompts.length).toBe(2);
    expect(prompts[1]).toMatchObject({ toolUseId: "s1", toolName: "Bash", parentToolUseId: promptingAgent });
    await send({ type: "approveEdit", toolUseId: "s1", approved: false });
    expect((await shell)?.block).toBe(true);
  });
});
