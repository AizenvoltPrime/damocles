import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createSettingsHandlers } from "../settings-handlers";
import { SettingsManager } from "../../../settings-manager";
import { platform } from "../../../../platform-host";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { McpServerStatusInfo, McpToolExposureScope, McpToolExposureSetting } from "../../../../../shared/types/mcp";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";

const KEY = "damocles.mcp.toolExposure";

/**
 * `mcpSetToolExposure`: one tool's Off / On / Always loaded choice, saved at one scope. The handler
 * reads only that scope's map from `inspect()`, sets or removes the one entry, and writes the map back;
 * every panel gets fresh status. Re-applying the tools is the runtime's setting listener, not the handler's.
 */
function setup(opts: {
  layers?: { user?: unknown; project?: unknown; local?: unknown };
  scopes?: McpToolExposureScope[];
  configExposure?: McpToolExposureSetting;
  trusted?: boolean;
  tools?: string[];
  /** The write lands a tick after `update()` is called, as a host's file write does. */
  slowWrites?: boolean;
} = {}) {
  const settings: Record<string, Record<string, unknown>> = {};
  for (const scope of ["user", "project", "local"] as const) {
    const value = opts.layers?.[scope];
    if (value !== undefined) settings[scope] = { [KEY]: value };
  }
  const platform = createFakePlatform({ settings, trusted: opts.trusted ?? true });
  const realUpdate = platform.settings.update.bind(platform.settings);
  const update = vi.spyOn(platform.settings, "update");
  if (opts.slowWrites) {
    update.mockImplementation(async (key, value, scope) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await realUpdate(key, value, scope);
    });
  }
  const posted: ExtensionToWebviewMessage[] = [];
  const statuses: McpServerStatusInfo[] = [{
    name: "context7",
    status: "connected",
    enabled: true,
    tools: (opts.tools ?? ["query-docs"]).map((name) => ({ name, configExposure: opts.configExposure ?? "deferred" })),
  }];
  const refreshA = vi.fn();
  const refreshB = vi.fn();
  const sessionA = { getMcpServerStatus: vi.fn(async () => statuses), refreshActiveTools: refreshA };
  const sessionB = { getMcpServerStatus: vi.fn(async () => statuses), refreshActiveTools: refreshB };
  const hostA = {};
  const hostB = {};
  // The real manager, for the write serialization the handler relies on.
  const settingsManager = Object.assign(new SettingsManager({ postMessage: () => undefined, platform, folders: () => [] }), {
    getMcpToolExposureScopes: vi.fn(() => opts.scopes ?? ["user", "project", "local"]),
    sendMcpStatus: vi.fn(async () => {}),
  });
  const deps = {
    postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); },
    settingsManager,
    platform,
    getPanels: () => new Map([
      ["a", { host: hostA, session: sessionA, folder: { key: "a" } }],
      ["b", { host: hostB, session: sessionB, folder: { key: "b" } }],
    ]),
  } as unknown as HandlerDependencies;
  const ctx = { host: hostA, session: sessionA, folder: { key: "a", fsPath: "/ws/a" } } as unknown as HandlerContext;
  const handlers = createSettingsHandlers(deps);
  const run = (exposure: McpToolExposureSetting, scope: McpToolExposureScope, toolName = "query-docs") =>
    handlers["mcpSetToolExposure"]!({ type: "mcpSetToolExposure", serverName: "context7", toolName, exposure, scope } as WebviewToExtensionMessage, ctx);
  return { run, platform, update, posted, refreshA, refreshB, settingsManager, hostA, hostB };
}

describe("mcpSetToolExposure", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets the one entry at the chosen scope, keeping that scope's other entries", async () => {
    const t = setup({ layers: { user: { context7: { "resolve-library-id": "off" }, git: { push: "off" } } } });

    await t.run("direct", "user");

    expect(t.platform.settings.inspect(KEY).userValue).toEqual({
      context7: { "resolve-library-id": "off", "query-docs": "direct" },
      git: { push: "off" },
    });
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.update.mock.calls[0]![2]).toBe("user");
  });

  it("writes only the chosen scope, never the merged value", async () => {
    const t = setup({ layers: { user: { context7: { a: "off" } }, project: { context7: { b: "direct" } } } });

    await t.run("off", "local");

    expect(t.platform.settings.inspect(KEY)).toEqual({
      userValue: { context7: { a: "off" } },
      projectValue: { context7: { b: "direct" } },
      localValue: { context7: { "query-docs": "off" } },
    });
  });

  it("removes the entry when the scopes below already give the chosen value", async () => {
    const t = setup({ layers: { user: { context7: { "query-docs": "off" } }, project: { context7: { "query-docs": "direct", x: "off" } } } });

    await t.run("off", "project");

    expect(t.platform.settings.inspect(KEY).projectValue).toEqual({ context7: { x: "off" } });
  });

  it("removes the key at that scope when the config already gives the value and nothing else is left", async () => {
    const t = setup({ layers: { user: { context7: { "query-docs": "off" } } }, configExposure: "direct" });

    await t.run("direct", "user");

    expect(t.platform.settings.inspect(KEY)).toEqual({});
    expect(t.update.mock.calls[0]).toEqual([KEY, undefined, "user"]);
  });

  it("choosing On over a config Always loaded writes the entry, since On is not what the config gives", async () => {
    const t = setup({ configExposure: "direct" });

    await t.run("deferred", "user");

    expect(t.platform.settings.inspect(KEY).userValue).toEqual({ context7: { "query-docs": "deferred" } });
  });

  it("answers the requesting panel and leaves every other panel and the tools to the setting's listener", async () => {
    const t = setup();

    await t.run("direct", "user");

    expect(t.refreshA).not.toHaveBeenCalled();
    expect(t.refreshB).not.toHaveBeenCalled();
    expect(t.settingsManager.sendMcpStatus.mock.calls.map((call) => [(call as unknown[])[1], (call as unknown[])[2]])).toEqual([[t.hostA, "a"]]);
  });

  it("quick changes to two tools both land: each write reads the map the previous one wrote", async () => {
    const t = setup({ tools: ["query-docs", "resolve-library-id"], slowWrites: true });

    await Promise.all([t.run("off", "user", "query-docs"), t.run("off", "user", "resolve-library-id")]);

    expect(t.platform.settings.inspect(KEY).userValue).toEqual({ context7: { "query-docs": "off", "resolve-library-id": "off" } });
  });

  it("a failed write does not stop the next one", async () => {
    const t = setup({ tools: ["query-docs"] });

    await Promise.all([t.run("off", "user", "nonexistent"), t.run("off", "user", "query-docs")]);

    expect(t.platform.settings.inspect(KEY).userValue).toEqual({ context7: { "query-docs": "off" } });
  });

  it("says so when a higher scope's entry for the tool still decides it", async () => {
    const t = setup({ layers: { project: { context7: { "query-docs": "off" } } } });

    await t.run("direct", "user");

    expect(t.platform.settings.inspect(KEY).userValue).toEqual({ context7: { "query-docs": "direct" } });
    expect(t.posted).toContainEqual({
      type: "notification",
      notificationType: "info",
      message: "Saved at the User scope, but this tool's Project setting takes precedence, so it did not change. Save to Project to change it.",
    });
  });

  it("says nothing when the higher scope already gives the chosen value, or when no higher scope holds an entry", async () => {
    const agreeing = setup({ layers: { project: { context7: { "query-docs": "direct" } } } });
    await agreeing.run("direct", "user");
    expect(agreeing.posted.filter((m) => m.type === "notification")).toEqual([]);

    const plain = setup({ layers: { user: { context7: { "query-docs": "off" } } } });
    await plain.run("direct", "project");
    expect(plain.posted.filter((m) => m.type === "notification")).toEqual([]);
  });

  it("refuses an exposure or scope value the host does not know, writing nothing", async () => {
    const t = setup();

    await t.run("bogus" as McpToolExposureSetting, "user");
    await t.run("off", "bogus" as McpToolExposureScope);

    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted.filter((m) => m.type === "notification")).toEqual([
      { type: "notification", notificationType: "error", message: "Failed to save MCP tool setting: Invalid MCP tool setting." },
      { type: "notification", notificationType: "error", message: "Failed to save MCP tool setting: Invalid MCP tool setting." },
    ]);
  });

  it("localizes the reason inside the failure notice", async () => {
    const t = setup({ scopes: ["user"] });
    vi.spyOn(platform().localization, "t").mockImplementation((message: string, ...args: Array<string | number | boolean>) =>
      `<${message.replace(/\{(\d+)\}/g, (_match, i: string) => String(args[Number(i)]))}>`);

    await t.run("off", "project");
    await t.run("off", "user", "nonexistent");

    expect(t.posted.filter((m) => m.type === "notification").map((m) => (m as { message: string }).message)).toEqual([
      "<Failed to save MCP tool setting: <This folder cannot save MCP tool settings at the <Project> scope.>>",
      '<Failed to save MCP tool setting: <MCP server "context7" has no tool "nonexistent".>>',
    ]);
  });

  it("refuses a scope this folder cannot write, writing nothing and saying why", async () => {
    const t = setup({ scopes: ["user"] });

    await t.run("off", "project");

    expect(t.update).not.toHaveBeenCalled();
    expect(t.refreshA).not.toHaveBeenCalled();
    const notice = t.posted.find((m) => m.type === "notification");
    expect(notice).toMatchObject({ notificationType: "error" });
    expect(t.settingsManager.sendMcpStatus.mock.calls.map((call) => (call as unknown[])[1])).toEqual([t.hostA]);
  });

  it("refuses a tool the server does not list", async () => {
    const t = setup();

    await t.run("off", "user", "nonexistent");

    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted.some((m) => m.type === "notification" && m.message.includes("nonexistent"))).toBe(true);
  });
});
