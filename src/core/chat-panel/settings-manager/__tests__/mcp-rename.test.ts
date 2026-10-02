import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

/**
 * Per-tool MCP disables move from `damocles.tools.disabled` into `damocles.mcp.toolExposure` on load, and
 * renaming a `~/.damocles/mcp.json` server moves its toolExposure key, driven through the real
 * `SettingsManager` over a real file in a redirected home.
 */
const { tmpRoot, fakeHome, folder } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-rename-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), folder: nodePath.join(root, "ws") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => { throw new Error("fatal: not a git repository"); }));
vi.mock("../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import { SettingsManager } from "..";
import { installFakePlatform } from "../../../../__mocks__/fake-platform";
import type { Memento } from "../../../../platform/key-value-state";
import { MCP_DISABLED_SERVERS_KEY, MCP_DISABLED_SPLIT_MIGRATED_KEY } from "../managers/mcp-manager";
import { MCP_TOOL_EXPOSURE_SETTING } from "../../../../shared/types/mcp";
import { folderTarget } from "../managers/__tests__/mcp-folder-fixtures";

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

function memento(initial: Record<string, unknown>): Memento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
  } as Memento;
}

function writeUserServers(servers: Record<string, unknown>): void {
  fs.mkdirSync(path.join(fakeHome, ".damocles"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".damocles", "mcp.json"), JSON.stringify({ mcpServers: servers }), "utf-8");
}

function settingsManager(init: Parameters<typeof installFakePlatform>[0]) {
  fs.mkdirSync(folder, { recursive: true });
  const target = folderTarget(folder);
  const platform = installFakePlatform(init);
  const settings = new SettingsManager({
    postMessage: () => {},
    platform: {
      ...platform,
      state: { global: platform.state.global, workspace: memento({ [MCP_DISABLED_SPLIT_MIGRATED_KEY]: true }) },
    },
    folders: () => [target],
  });
  return { platform, settings, target };
}

beforeEach(() => fs.rmSync(fakeHome, { recursive: true, force: true }));

describe("damocles.tools.disabled → damocles.mcp.toolExposure", () => {
  it("moves each legacy MCP name that resolves to one server into toolExposure as off, at the scope it came from", async () => {
    writeUserServers({ "my.docs": { command: "docs" }, context7: { command: "c7" } });
    const { platform, settings } = settingsManager({
      settings: {
        user: { "damocles.tools.disabled": ["mcp__my_docs__web-search", "mcp__other__run-it", "Bash"] },
        local: { "damocles.tools.disabled": ["mcp__context7__resolve-library-id"] },
      },
    });

    await settings.loadMcpConfig();

    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING)).toEqual({
      userValue: { "my.docs": { "web-search": "off" } },
      localValue: { context7: { "resolve-library-id": "off" } },
    });
    // Names no server resolves stay, so a server that is absent for now keeps the user's choice.
    expect(platform.settings.inspect("damocles.tools.disabled")).toEqual({
      userValue: ["mcp__other__run-it", "Bash"],
      localValue: [],
    });
    settings.dispose();
  });

  it("is idempotent, and migrates a server's entry once that server appears", async () => {
    writeUserServers({ docs: { command: "docs" } });
    const { platform, settings } = settingsManager({
      settings: { user: { "damocles.tools.disabled": ["mcp__docs__a-b", "mcp__later__c-d"] } },
    });
    await settings.loadMcpConfig();
    await settings.loadMcpConfig();
    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING).userValue).toEqual({ docs: { "a-b": "off" } });
    expect(platform.settings.inspect("damocles.tools.disabled").userValue).toEqual(["mcp__later__c-d"]);

    writeUserServers({ docs: { command: "docs" }, later: { command: "later" } });
    await settings.loadMcpConfig();

    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING).userValue).toEqual({ docs: { "a-b": "off" }, later: { "c-d": "off" } });
    expect(platform.settings.inspect("damocles.tools.disabled").userValue).toEqual([]);
    settings.dispose();
  });

  // damocles.tools.disabled still matches current names exactly; moving one would key toolExposure on the sanitized tool name.
  it("leaves an entry that is already the tool's current name where it is", async () => {
    writeUserServers({ context7: { command: "c7" }, docs: { command: "docs" } });
    const { platform, settings } = settingsManager({
      settings: { user: { "damocles.tools.disabled": ["mcp__context7__resolve_library_id", "mcp__docs__search"] } },
    });
    await settings.loadMcpConfig();
    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING)).toEqual({});
    expect(platform.settings.inspect("damocles.tools.disabled").userValue).toEqual(["mcp__context7__resolve_library_id", "mcp__docs__search"]);
    settings.dispose();
  });

  it("lets no server of an untrusted folder's repository files decide where a user-scope entry goes", async () => {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, ".mcp.json"), JSON.stringify({ mcpServers: { repo: { command: "r" } } }), "utf-8");
    const { platform, settings } = settingsManager({
      trusted: false,
      settings: { user: { "damocles.tools.disabled": ["mcp__repo__do-it"] } },
    });
    await settings.loadMcpConfig();
    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING)).toEqual({});
    expect(platform.settings.inspect("damocles.tools.disabled").userValue).toEqual(["mcp__repo__do-it"]);
    fs.rmSync(path.join(folder, ".mcp.json"));
    settings.dispose();
  });

  it("moves nothing while a config file cannot be read", async () => {
    writeUserServers({ docs: { command: "docs" } });
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, ".mcp.json"), "{ not json", "utf-8");
    const { platform, settings } = settingsManager({ settings: { user: { "damocles.tools.disabled": ["mcp__docs__a-b"] } } });
    await settings.loadMcpConfig();
    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING)).toEqual({});
    expect(platform.settings.inspect("damocles.tools.disabled").userValue).toEqual(["mcp__docs__a-b"]);
    fs.rmSync(path.join(folder, ".mcp.json"));
    settings.dispose();
  });

  it("rebuilds legacy prefixes over the enabled servers only, as the legacy managers assigned them", async () => {
    // With `a--b` switched off, the legacy manager held only `a.b`, which took the base prefix `a_b`.
    writeUserServers({ "a--b": { command: "x", enabled: false }, "a.b": { command: "y" } });
    const { platform, settings } = settingsManager({ settings: { user: { "damocles.tools.disabled": ["mcp__a_b__t-x"] } } });
    await settings.loadMcpConfig();
    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING).userValue).toEqual({ "a.b": { "t-x": "off" } });
    settings.dispose();
  });

  it("never rewrites the project scope, which is the repository's committed file", async () => {
    writeUserServers({ docs: { command: "docs" } });
    const { platform, settings } = settingsManager({
      settings: { project: { "damocles.tools.disabled": ["mcp__docs__a-b"] } },
    });
    await settings.loadMcpConfig();
    expect(platform.settings.inspect("damocles.tools.disabled")).toEqual({ projectValue: ["mcp__docs__a-b"] });
    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING)).toEqual({});
    settings.dispose();
  });

  it("leaves an entry two servers share a legacy prefix for alone", async () => {
    // `my--server` and `my.server` both had the base prefix `my_server`; the second got `my_server_2`.
    writeUserServers({ "my--server": { command: "a" }, "my.server": { command: "b" } });
    const { platform, settings } = settingsManager({
      settings: { user: { "damocles.tools.disabled": ["mcp__my_server_2__x"] } },
    });
    await settings.loadMcpConfig();
    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING).userValue).toEqual({ "my.server": { x: "off" } });
    settings.dispose();
  });
});

describe("SettingsManager.updateMcpServer rename", () => {
  it("moves the server's toolExposure entry to its new name at user, project and local scope", async () => {
    writeUserServers({ "my.docs": { command: "docs" } });
    const { platform, settings, target } = settingsManager({
      settings: {
        user: { [MCP_TOOL_EXPOSURE_SETTING]: { "my.docs": { search: "off" }, other: { run: "off" } } },
        local: { [MCP_TOOL_EXPOSURE_SETTING]: { "my.docs": { fetch: "off" } } },
        project: { [MCP_TOOL_EXPOSURE_SETTING]: { "my.docs": { list: "off" } } },
      },
    });
    await settings.loadMcpConfig();

    await settings.updateMcpServer(target.key, "my.docs", "handbook", { command: "docs" });

    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING)).toEqual({
      userValue: { other: { run: "off" }, handbook: { search: "off" } },
      localValue: { handbook: { fetch: "off" } },
      projectValue: { handbook: { list: "off" } },
    });
    settings.dispose();
  });

  it("reports the save as done when a scope's setting cannot be carried, and still carries the others", async () => {
    writeUserServers({ "my.docs": { command: "docs" } });
    const { platform, settings, target } = settingsManager({
      settings: {
        user: { [MCP_TOOL_EXPOSURE_SETTING]: { "my.docs": { search: "off" } } },
        project: { [MCP_TOOL_EXPOSURE_SETTING]: { "my.docs": { list: "off" } } },
        local: { [MCP_TOOL_EXPOSURE_SETTING]: { "my.docs": { fetch: "off" } } },
      },
    });
    await settings.loadMcpConfig();
    const update = platform.settings.update.bind(platform.settings);
    // The desktop store rejects a project write when the default project is untrusted.
    platform.settings.update = async (key, value, scope) => {
      if (scope === "project") throw new Error("the project is not trusted");
      return update(key, value, scope);
    };

    await expect(settings.updateMcpServer(target.key, "my.docs", "handbook", { command: "docs" })).resolves.toBeUndefined();

    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING)).toMatchObject({
      userValue: { handbook: { search: "off" } },
      localValue: { handbook: { fetch: "off" } },
    });
    expect(JSON.parse(fs.readFileSync(path.join(fakeHome, ".damocles", "mcp.json"), "utf-8")).mcpServers).toEqual({ handbook: { command: "docs" } });
    settings.dispose();
  });

  it("reports the save as done when the enabled state cannot follow the rename, and still carries the tool exposure", async () => {
    writeUserServers({ "my.docs": { command: "docs" } });
    fs.mkdirSync(folder, { recursive: true });
    const target = folderTarget(folder);
    const platform = installFakePlatform({ settings: { user: { [MCP_TOOL_EXPOSURE_SETTING]: { "my.docs": { search: "off" } } } } });
    const workspace = memento({ [MCP_DISABLED_SPLIT_MIGRATED_KEY]: true });
    const settings = new SettingsManager({
      postMessage: () => {},
      platform: { ...platform, state: { global: platform.state.global, workspace } },
      folders: () => [target],
    });
    await settings.loadMcpConfig();
    workspace.update = async () => { throw new Error("workspace state is unavailable"); };

    await expect(settings.updateMcpServer(target.key, "my.docs", "handbook", { command: "docs" })).resolves.toBeUndefined();

    expect(platform.settings.inspect(MCP_TOOL_EXPOSURE_SETTING).userValue).toEqual({ handbook: { search: "off" } });
    settings.dispose();
  });

  it("keeps a disabled server disabled under its new name", async () => {
    writeUserServers({ "my.docs": { command: "docs" } });
    fs.mkdirSync(folder, { recursive: true });
    const target = folderTarget(folder);
    const platform = installFakePlatform();
    const workspace = memento({ [MCP_DISABLED_SPLIT_MIGRATED_KEY]: true, [MCP_DISABLED_SERVERS_KEY]: ["my.docs"] });
    const settings = new SettingsManager({
      postMessage: () => {},
      platform: { ...platform, state: { global: platform.state.global, workspace } },
      folders: () => [target],
    });
    await settings.loadMcpConfig();

    await settings.updateMcpServer(target.key, "my.docs", "handbook", { command: "docs" });

    expect(workspace.get(MCP_DISABLED_SERVERS_KEY)).toEqual(["handbook"]);
    settings.dispose();
  });
});
