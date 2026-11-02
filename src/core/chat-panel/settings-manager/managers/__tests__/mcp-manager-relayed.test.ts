import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-relayed-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

const execMock = vi.hoisted(() => vi.fn(async () => { throw new Error("fatal: not a git repository"); }));
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import { createFakePlatform } from "../../../../../__mocks__/fake-platform";
import { createFakeRemoteHost } from "../../../../../__mocks__/fake-remote-host";
import { installPlatform } from "../../../../platform-host";
import { MCP_REMOTE_AVAILABLE_SETTING } from "@shared/types/mcp";
import type { RelayedMcpServer } from "@shared/remote-user";
import { McpManager } from "../mcp-manager";
import { folderTarget } from "./mcp-folder-fixtures";
import { asClient } from "../../../../client-snapshots";

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

const WS = folderTarget(fakeWorkspace);
const relayed = (name: string): RelayedMcpServer => ({ name, tools: [{ name: "search" }], resources: false });

writeJson(path.join(fakeHome, ".damocles", "mcp.json"), { mcpServers: { machine: { command: "machine-server" }, shared: { command: "target-shared" } } });
writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { project: { command: "project-server" } } });

afterEach(() => installPlatform(createFakePlatform()));
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

async function remoteManager() {
  const fake = createFakeRemoteHost();
  fake.set("clientMcp", "client-a", [relayed("notes"), relayed("shared")]);
  const platform = { ...createFakePlatform({ host: "desktop", trusted: true }), remote: fake.remote };
  installPlatform(platform);
  const manager = new McpManager(platform, () => [WS]);
  await manager.loadConfig();
  return { manager, fake };
}

describe("a remote host's core", () => {
  it("lists the acting client's relayed servers read-only, every row with where it runs", async () => {
    const { manager } = await remoteManager();
    const rows = new Map(manager.getServersForUI(WS.key).map((row) => [row.name, row]));
    expect(rows.get("notes")).toMatchObject({ source: "relayed", readonly: true, placement: "client" });
    expect(rows.get("machine")).toMatchObject({ source: "damocles", placement: "host" });
    expect(rows.get("project")).toMatchObject({ source: "workspace", placement: "project" });
    expect([...rows.values()].every((row) => row.remoteAvailable === undefined)).toBe(true);
  });

  it("lets a server the target configures win a name it shares with a relayed one", async () => {
    const { manager } = await remoteManager();
    const union = manager.getEnabledServers(WS.key).userUnion;
    expect(union["shared"]?.relay).toBeUndefined();
    expect(union["shared"]?.config).toMatchObject({ command: "target-shared" });
    expect(union["notes"]?.relay).toEqual(relayed("notes"));
  });

  it("feeds a relayed server as its client's schemas only, with a config that opens nothing", async () => {
    const { manager } = await remoteManager();
    const notes = manager.getEnabledServers(WS.key).userUnion["notes"]!;
    expect(notes.config).toEqual({ type: "http", url: "relayed://notes", auth: false });
  });
});

describe("this computer's desktop core", () => {
  it("marks each personal server with whether it is available on remote hosts, and no project server", async () => {
    const platform = createFakePlatform({ host: "desktop", trusted: true, settings: { user: { [MCP_REMOTE_AVAILABLE_SETTING]: ["machine"] } } });
    installPlatform(platform);
    const manager = new McpManager(platform, () => [WS]);
    await manager.loadConfig();
    const rows = new Map(manager.getServersForUI(WS.key).map((row) => [row.name, row]));
    expect(rows.get("machine")?.remoteAvailable).toBe(true);
    expect(rows.get("shared")?.remoteAvailable).toBe(false);
    expect(rows.get("project")?.remoteAvailable).toBeUndefined();
    expect([...rows.values()].every((row) => row.placement === undefined)).toBe(true);
  });

  it("marks nothing in the VS Code extension", async () => {
    const platform = createFakePlatform({ host: "vscode", trusted: true, settings: { user: { [MCP_REMOTE_AVAILABLE_SETTING]: ["machine"] } } });
    installPlatform(platform);
    const manager = new McpManager(platform, () => [WS]);
    await manager.loadConfig();
    expect(manager.getServersForUI(WS.key).every((row) => row.remoteAvailable === undefined)).toBe(true);
  });
});

describe("two devices on a remote host's core", () => {
  async function twoDevices() {
    const fake = createFakeRemoteHost();
    fake.set("clientAuth", "client-b", { providers: {} });
    fake.set("clientMcp", "client-a", [relayed("notes")]);
    fake.set("clientMcp", "client-b", [relayed("diary")]);
    const platform = { ...createFakePlatform({ host: "desktop", trusted: true }), remote: fake.remote };
    installPlatform(platform);
    const manager = new McpManager(platform, () => [WS]);
    await manager.loadConfig();
    manager.setupWatcher();
    const reloads = vi.spyOn(manager, "loadConfig");
    const refeeds = vi.fn();
    manager.setOnConfigChange(refeeds);
    return { fake, manager, reloads, refeeds };
  }
  const relayedNames = (manager: McpManager) => Object.values(manager.getEnabledServers(WS.key).userUnion).flatMap((spec) => (spec.relay ? [spec.relay.name] : []));
  const relayedRows = (fake: ReturnType<typeof createFakeRemoteHost>, manager: McpManager, clientId: string) =>
    asClient(fake.remote, clientId, () => manager.getServersForUI(WS.key).filter((row) => row.source === "relayed").map((row) => row.name));

  it("holds both devices' servers, and shows each device only its own as on its computer", async () => {
    const { fake, manager } = await twoDevices();
    expect(relayedNames(manager).sort()).toEqual(["diary", "notes"]);
    expect(relayedRows(fake, manager, "client-a")).toEqual(["notes"]);
    expect(relayedRows(fake, manager, "client-b")).toEqual(["diary"]);
    const status = asClient(fake.remote, "client-b", () => manager.buildRuntimeStatus(WS.key, []));
    expect(status.filter((row) => row.placement === "client").map((row) => row.name)).toEqual(["diary"]);
  });

  it("reloads nothing when another device acts or an unrelated mirror changes", async () => {
    const { fake, manager, reloads, refeeds } = await twoDevices();
    fake.setActing("client-b");
    fake.set("clientEditor", "client-a", {});
    fake.set("clientLanguage", "client-b", { language: "el" });
    expect(reloads).not.toHaveBeenCalled();
    expect(refeeds).not.toHaveBeenCalled();
    expect(manager.getConfigLoaded()).toBe(true);
  });

  it("re-sends the rows without a reload when a device relays a server another already relays", async () => {
    const { fake, reloads, refeeds } = await twoDevices();
    fake.set("clientMcp", "client-b", [relayed("diary"), relayed("notes")]);
    expect(reloads).not.toHaveBeenCalled();
    expect(refeeds).toHaveBeenCalledTimes(1);
  });

  it("reloads when a device's servers change what the core holds, an empty list after a reattach included", async () => {
    const { fake, manager, reloads } = await twoDevices();
    fake.set("clientMcp", "client-a", undefined);
    expect(reloads).not.toHaveBeenCalled();
    fake.set("clientMcp", "client-a", []);
    await vi.waitFor(() => expect(reloads).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(relayedNames(manager)).toEqual(["diary"]));
  });
});

describe("this computer's core judging a personal server relayable", () => {
  it("reads the user scope's own entry, which a same-named project server in one folder does not hide", async () => {
    const other = folderTarget(path.join(tmpRoot, "other"));
    fs.mkdirSync(other.fsPath, { recursive: true });
    const platform = createFakePlatform({ host: "desktop", trusted: true });
    installPlatform(platform);
    // WS's .mcp.json defines "project"; the personal file defines the same name below
    writeJson(path.join(fakeHome, ".damocles", "mcp.json"), { mcpServers: { machine: { command: "machine-server" }, shared: { command: "target-shared" }, project: { command: "personal-project" } } });
    try {
      const manager = new McpManager(platform, () => [WS, other]);
      await manager.loadConfig();
      expect(manager.getServersForUI(WS.key).find((row) => row.name === "project")?.source).toBe("workspace");
      expect(manager.userServerSource("project")).toBe("damocles");
      expect(manager.userServerSource("nowhere")).toBeUndefined();
    } finally {
      writeJson(path.join(fakeHome, ".damocles", "mcp.json"), { mcpServers: { machine: { command: "machine-server" }, shared: { command: "target-shared" } } });
    }
  });
});
