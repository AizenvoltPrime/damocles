import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createSettingsHandlers } from "../settings-handlers";
import { SettingsManager } from "../../../settings-manager";
import type { HandlerContext, HandlerDependencies } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import type { McpServerStatusInfo } from "../../../../../shared/types/mcp";
import { MCP_RESOURCE_EXPOSURE_SETTING, MCP_TOOL_EXPOSURE_SETTING } from "../../../../../shared/types/mcp";
import type { SettingInspection, SettingsScope, SettingsStore } from "../../../../../platform/settings-store";
import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import { createFakeRemoteHost } from "../../../../../__mocks__/fake-remote-host";
import { installPlatform } from "../../../../platform-host";
import { withSettingsViewScope } from "../../../settings-view-scope";
import { FolderMcpView } from "../../../../pi-session/mcp/folder-mcp-view";
import { managerWithFake, specOf } from "../../../../pi-session/mcp/__tests__/fake-server-manager";

/**
 * A daemon's core's store: the user layer is the acting device's own settings, the machine layer the host's
 * ~/.damocles/settings.json, and a user-scope write lands in that host file.
 */
function remoteShapedStore(client: Record<string, unknown>, host: Record<string, unknown>) {
  const update = vi.fn(async (key: string, value: unknown, scope: SettingsScope) => {
    if (scope !== "user") throw new Error(`a daemon's core has no ${scope} file here`);
    if (value === undefined) delete host[key];
    else host[key] = structuredClone(value);
  });
  const store: SettingsStore = {
    get: ((key: string, defaultValue?: unknown) => host[key] ?? client[key] ?? defaultValue) as SettingsStore["get"],
    inspect: <T>(key: string): SettingInspection<T> => ({
      ...(Object.hasOwn(client, key) ? { userValue: client[key] as T } : {}),
      ...(Object.hasOwn(host, key) ? { machineValue: host[key] as T } : {}),
    }),
    update,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: () => undefined,
  };
  return { store, update };
}

const disposables: Array<{ dispose(): unknown }> = [];

afterEach(async () => {
  for (const disposable of disposables.splice(0)) await disposable.dispose();
  vi.restoreAllMocks();
  installPlatform(createFakePlatform());
});

async function hostTab() {
  const client = {
    [MCP_TOOL_EXPOSURE_SETTING]: { db: { query: "off" }, personal: { x: "off" } },
    [MCP_RESOURCE_EXPOSURE_SETTING]: { personal: "off" },
  };
  const host: Record<string, unknown> = {
    [MCP_TOOL_EXPOSURE_SETTING]: { db: { drop: "off" }, other: { y: "direct" } },
    [MCP_RESOURCE_EXPOSURE_SETTING]: { other: "direct" },
  };
  const { store, update } = remoteShapedStore(client, host);
  const fake = createFakeRemoteHost();
  const platform = { ...createFakePlatform({ host: "desktop" }), remote: fake.remote, settings: store };
  installPlatform(platform);

  // the host's own server db and a project server, behind one folder view that reads the store as the folder runtime does
  const user = managerWithFake({ db: [{ name: "query" }, { name: "drop" }] }, undefined, { db: { resources: [] } });
  const folder = managerWithFake({ repo: [{ name: "lint" }] });
  disposables.push(user.manager, folder.manager);
  const view = new FolderMcpView(user.manager, folder.manager, () => ({
    inspection: store.inspect<unknown>(MCP_TOOL_EXPOSURE_SETTING),
    resourceInspection: store.inspect<unknown>(MCP_RESOURCE_EXPOSURE_SETTING),
    trusted: true,
  }));
  disposables.push(view);
  user.manager.initialize({ db: specOf({ command: "db" }) });
  folder.manager.initialize({ repo: specOf({ command: "repo" }, { folderScoped: true }) });
  await Promise.all([user.manager.whenReady(), folder.manager.whenReady()]);
  view.setUserVisible(["db"]);

  const rows: McpServerStatusInfo[] = [
    { name: "db", status: "connected", enabled: true, source: "damocles", placement: "host" },
    { name: "repo", status: "connected", enabled: true, source: "workspace", placement: "project" },
  ];
  const posted: ExtensionToWebviewMessage[] = [];
  const settingsManager = Object.assign(new SettingsManager({ postMessage: () => undefined, platform, folders: () => [] }), {
    getMcpServersForUI: vi.fn(() => rows),
    sendMcpStatus: vi.fn(async () => {}),
  });
  const deps = {
    postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); },
    settingsManager,
    platform,
    getPanels: () => new Map(),
  } as unknown as HandlerDependencies;
  const ctx = { host: {}, reply: {}, session: { getMcpServerStatus: async () => view.getServerStatuses() }, folder: { key: "a", fsPath: "/ws/a" } } as unknown as HandlerContext;
  const handlers = createSettingsHandlers(deps);
  const fromHostTab = (message: WebviewToExtensionMessage) => withSettingsViewScope("machine", () => handlers[message.type]!(message as never, ctx));
  const tool = (name: string) => view.getServerStatuses().find((status) => status.name === "db")!.tools!.find((candidate) => candidate.name === name);
  return { host, client, update, posted, fromHostTab, tool, view };
}

describe("tool and resource exposure from a remote host's settings tab", () => {
  it("saves the host's machine settings, keeping the host file's other entries and copying nothing of the device's own", async () => {
    const t = await hostTab();
    expect(t.tool("query")).toMatchObject({ exposure: "off", exposureSource: "user" });
    await t.fromHostTab({ type: "mcpSetToolExposure", serverName: "db", toolName: "query", exposure: "direct", scope: "machine" });
    expect(t.update).toHaveBeenCalledTimes(1);
    expect(t.update).toHaveBeenCalledWith(MCP_TOOL_EXPOSURE_SETTING, { db: { drop: "off", query: "direct" }, other: { y: "direct" } }, "user");
    expect(t.host[MCP_TOOL_EXPOSURE_SETTING]).toEqual({ db: { drop: "off", query: "direct" }, other: { y: "direct" } });
    expect(JSON.stringify(t.host)).not.toContain("personal");
    // the host's servers read the machine layer above the device's own
    expect(t.tool("query")).toMatchObject({ exposure: "direct", exposureSource: "machine" });
    expect(t.posted.filter((message) => message.type === "notification")).toEqual([]);
  });

  it("saves a server's resources the same way", async () => {
    const t = await hostTab();
    await t.fromHostTab({ type: "mcpSetResourceExposure", serverName: "db", exposure: "off", scope: "machine" });
    expect(t.host[MCP_RESOURCE_EXPOSURE_SETTING]).toEqual({ other: "direct", db: "off" });
    expect(t.view.getServerStatuses().find((status) => status.name === "db")).toMatchObject({ resourceExposure: "off", resourceExposureSource: "machine" });
  });

  it("removes the host's entry when the device's own layer and the config already give the choice, and keeps it over the device's own", async () => {
    const t = await hostTab();
    await t.fromHostTab({ type: "mcpSetToolExposure", serverName: "db", toolName: "drop", exposure: "deferred", scope: "machine" });
    expect(t.host[MCP_TOOL_EXPOSURE_SETTING]).toEqual({ other: { y: "direct" } });
    // the device's own Off is below the host's settings, so an On there is kept and wins
    await t.fromHostTab({ type: "mcpSetToolExposure", serverName: "db", toolName: "query", exposure: "deferred", scope: "machine" });
    expect(t.host[MCP_TOOL_EXPOSURE_SETTING]).toEqual({ other: { y: "direct" }, db: { query: "deferred" } });
    expect(t.tool("query")).toMatchObject({ exposure: "deferred", exposureSource: "machine" });
  });

  it("refuses the device's own user scope and a project server, writing nothing", async () => {
    const t = await hostTab();
    await t.fromHostTab({ type: "mcpSetToolExposure", serverName: "db", toolName: "query", exposure: "direct", scope: "user" });
    await t.fromHostTab({ type: "mcpSetToolExposure", serverName: "repo", toolName: "lint", exposure: "off", scope: "machine" });
    expect(t.update).not.toHaveBeenCalled();
    expect(t.posted.filter((message) => message.type === "notification").map((message) => (message as { notificationType?: string }).notificationType)).toEqual(["error", "error"]);
  });
});
