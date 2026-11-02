import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createSettingsHandlers } from "../settings-handlers";
import { SettingsManager } from "../../../settings-manager";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { McpServerSource, McpServerStatusInfo } from "../../../../../shared/types/mcp";
import { MCP_REMOTE_AVAILABLE_SETTING } from "../../../../../shared/types/mcp";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import { createFakeRemoteHost } from "../../../../../__mocks__/fake-remote-host";
import { installPlatform } from "../../../../platform-host";
import { withSettingsViewScope } from "../../../settings-view-scope";

function setup(opts: { host?: "vscode" | "desktop"; remote?: boolean; source?: McpServerSource; marked?: string[] } = {}) {
  const base = createFakePlatform({ host: opts.host ?? "desktop", settings: opts.marked ? { user: { [MCP_REMOTE_AVAILABLE_SETTING]: opts.marked } } : {} });
  const platform = opts.remote ? { ...base, remote: createFakeRemoteHost().remote } : base;
  installPlatform(platform);
  const update = vi.spyOn(platform.settings, "update");
  const posted: ExtensionToWebviewMessage[] = [];
  const statuses: McpServerStatusInfo[] = [{ name: "docs", status: "connected", enabled: true, source: opts.source ?? "damocles" }];
  const session = { getMcpServerStatus: vi.fn(async () => statuses) };
  const host = {};
  const settingsManager = Object.assign(new SettingsManager({ postMessage: () => undefined, platform, folders: () => [] }), {
    getMcpServersForUI: vi.fn(() => statuses),
    getMcpToolExposureScopes: vi.fn(() => ["user"]),
    sendMcpStatus: vi.fn(async () => {}),
    addMcpServer: vi.fn(async () => {}),
  });
  const deps = {
    postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); },
    settingsManager,
    platform,
    getPanels: () => new Map(),
  } as unknown as HandlerDependencies;
  const ctx = { host, reply: host, session, folder: { key: "a", fsPath: "/ws/a" } } as unknown as HandlerContext;
  const handlers = createSettingsHandlers(deps);
  const send = (message: WebviewToExtensionMessage) => handlers[message.type]!(message as never, ctx);
  return { send, platform, update, posted, settingsManager };
}

afterEach(() => {
  vi.restoreAllMocks();
  installPlatform(createFakePlatform());
});

describe("MCP writes on a remote host's core", () => {
  const add: WebviewToExtensionMessage = { type: "mcpAddServer", requestId: "r1", serverName: "notes", config: { command: "notes" } };

  it("refuses adding a machine server outside the settings overlay's host tab, and writes nothing", async () => {
    const t = setup({ remote: true });
    await t.send(add);
    expect(t.settingsManager.addMcpServer).not.toHaveBeenCalled();
    expect(t.posted).toContainEqual({ type: "mcpWriteResult", requestId: "r1", ok: false, error: { code: "hostTabOnly" } });
  });

  it("writes the target's ~/.damocles/mcp.json from the host tab", async () => {
    const t = setup({ remote: true });
    await withSettingsViewScope("machine", () => t.send(add));
    expect(t.settingsManager.addMcpServer).toHaveBeenCalledWith("a", "notes", { command: "notes" });
  });

  it("refuses an exposure write outside the host tab", async () => {
    const t = setup({ remote: true });
    await t.send({ type: "mcpSetResourceExposure", serverName: "docs", exposure: "off", scope: "user" });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted).toContainEqual(expect.objectContaining({ type: "notification", notificationType: "error" }));
  });

  it("refuses turning MCP on or off outside the host tab with the other MCP writes' reason, and writes it from the host tab", async () => {
    const t = setup({ remote: true });
    await t.send({ type: "setMcpEnabled", enabled: false });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted).toContainEqual(expect.objectContaining({
      type: "settingWriteResult", key: "damocles.mcp.enabled", ok: false, error: expect.objectContaining({ message: "On a remote host, MCP settings change in Settings, on the host's tab." }),
    }));
    expect(t.settingsManager.sendMcpStatus).toHaveBeenCalled();
    await withSettingsViewScope("machine", () => t.send({ type: "setMcpEnabled", enabled: false }));
    expect(t.update.mock.calls.map((call) => call.slice(0, 2))).toEqual([["damocles.mcp.enabled", false]]);
  });

  it("lets this computer's core write anywhere, as before", async () => {
    const t = setup();
    await t.send(add);
    expect(t.settingsManager.addMcpServer).toHaveBeenCalled();
  });
});

describe("mcpSetRemoteAvailable", () => {
  it("marks and unmarks a personal server in the desktop setting", async () => {
    const t = setup({ marked: ["other"] });
    await t.send({ type: "mcpSetRemoteAvailable", serverName: "docs", available: true });
    expect(t.update).toHaveBeenLastCalledWith(MCP_REMOTE_AVAILABLE_SETTING, ["docs", "other"], "user");
    await t.send({ type: "mcpSetRemoteAvailable", serverName: "docs", available: false });
    expect(t.update).toHaveBeenLastCalledWith(MCP_REMOTE_AVAILABLE_SETTING, ["other"], "user");
    expect(t.settingsManager.sendMcpStatus).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the VS Code extension", { host: "vscode" as const }],
    ["a remote host's core", { remote: true }],
    ["a project server", { source: "workspace" as const }],
    ["a relayed server", { source: "relayed" as const }],
  ])("is refused by %s", async (_name, opts) => {
    const t = setup(opts);
    await t.send({ type: "mcpSetRemoteAvailable", serverName: "docs", available: true });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted).toContainEqual(expect.objectContaining({ type: "notification", notificationType: "error" }));
  });
});
