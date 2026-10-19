import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createSettingsHandlers } from "../settings-handlers";
import { SettingsManager } from "../../../settings-manager";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { McpServerStatusInfo, McpToolExposureScope, McpToolExposureSetting } from "../../../../../shared/types/mcp";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";

const KEY = "damocles.mcp.resourceExposure";

/** `mcpSetResourceExposure`: one server's Resources choice, saved at one scope, the way the tool rows save theirs. */
function setup(opts: {
  layers?: { user?: unknown; project?: unknown; local?: unknown };
  scopes?: McpToolExposureScope[];
  configResourceExposure?: McpToolExposureSetting;
  trusted?: boolean;
} = {}) {
  const settings: Record<string, Record<string, unknown>> = {};
  for (const scope of ["user", "project", "local"] as const) {
    const value = opts.layers?.[scope];
    if (value !== undefined) settings[scope] = { [KEY]: value };
  }
  const platform = createFakePlatform({ settings, trusted: opts.trusted ?? true });
  const update = vi.spyOn(platform.settings, "update");
  const posted: ExtensionToWebviewMessage[] = [];
  const statuses: McpServerStatusInfo[] = [{
    name: "docs",
    status: "connected",
    enabled: true,
    hasResources: true,
    configResourceExposure: opts.configResourceExposure ?? "deferred",
  }];
  const session = { getMcpServerStatus: vi.fn(async () => statuses), refreshActiveTools: vi.fn() };
  const host = {};
  const settingsManager = Object.assign(new SettingsManager({ postMessage: () => undefined, platform, folders: () => [] }), {
    getMcpToolExposureScopes: vi.fn(() => opts.scopes ?? ["user", "project", "local"]),
    sendMcpStatus: vi.fn(async () => {}),
  });
  const deps = {
    postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); },
    settingsManager,
    platform,
    getPanels: () => new Map([["a", { host, session, folder: { key: "a" } }]]),
  } as unknown as HandlerDependencies;
  const ctx = { host, session, folder: { key: "a", fsPath: "/ws/a" } } as unknown as HandlerContext;
  const handlers = createSettingsHandlers(deps);
  const run = (exposure: McpToolExposureSetting, scope: McpToolExposureScope, serverName = "docs") =>
    handlers["mcpSetResourceExposure"]!({ type: "mcpSetResourceExposure", serverName, exposure, scope } as WebviewToExtensionMessage, ctx);
  return { run, platform, update, posted, settingsManager, host };
}

describe("mcpSetResourceExposure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes the server's entry of damocles.mcp.resourceExposure at the requested scope, keeping other servers", async () => {
    const t = setup({ layers: { project: { wiki: "off" } } });

    await t.run("direct", "project");

    expect(t.platform.settings.inspect(KEY)).toEqual({ projectValue: { wiki: "off", docs: "direct" } });
    expect(t.update.mock.calls).toEqual([[KEY, { wiki: "off", docs: "direct" }, "project"]]);
    expect(t.settingsManager.sendMcpStatus.mock.calls.map((call) => (call as unknown[])[1])).toEqual([t.host]);
  });

  it("turns on a server whose config default is Off with an explicit entry", async () => {
    const t = setup({ configResourceExposure: "off" });

    await t.run("deferred", "user");

    expect(t.platform.settings.inspect(KEY).userValue).toEqual({ docs: "deferred" });
  });

  it("removes the key at that scope when the config already gives the value and nothing else is left", async () => {
    const t = setup({ layers: { local: { docs: "off" } } });

    await t.run("deferred", "local");

    expect(t.update.mock.calls[0]).toEqual([KEY, undefined, "local"]);
  });

  it("says so when a higher scope's entry for the server still decides it", async () => {
    const t = setup({ layers: { local: { docs: "off" } } });

    await t.run("direct", "user");

    expect(t.posted).toContainEqual({
      type: "notification",
      notificationType: "info",
      message: "Saved at the User scope, but this server's Local resource setting takes precedence, so it did not change. Save to Local to change it.",
    });
  });

  it("refuses an unknown server, an unknown value and a scope this folder cannot write, writing nothing", async () => {
    const t = setup({ scopes: ["user"] });

    await t.run("off", "user", "nope");
    await t.run("bogus" as McpToolExposureSetting, "user");
    await t.run("off", "project");

    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted.filter((m) => m.type === "notification").map((m) => (m as { message: string }).message)).toEqual([
      'Failed to save MCP resource setting: MCP server "nope" is not available in this folder.',
      "Failed to save MCP resource setting: Invalid MCP resource setting.",
      "Failed to save MCP resource setting: This folder cannot save MCP resource settings at the Project scope.",
    ]);
  });
});
