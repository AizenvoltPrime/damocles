import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * MCP servers per workspace folder, driven over real files through the real `loadConfig()`: each
 * folder merges the user sources with its own files, and nothing one folder defines may reach
 * another folder's scope, list or disabled state.
 */
const { tmpRoot, fakeHome, folderA, folderB } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-multi-root-"));
  return {
    tmpRoot: root,
    fakeHome: nodePath.join(root, "home"),
    folderA: nodePath.join(root, "a"),
    folderB: nodePath.join(root, "b"),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

/** `loadConfig()` asks git whether `mcp.local.json` is ignored; faked so no suite spawns a process. */
const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => { throw new Error("fatal: not a git repository"); }));
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import { installFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";
import type { Memento } from "../../../../../platform/key-value-state";
import {
  McpManager,
  MCP_DISABLED_PROJECT_SERVERS_KEY,
  MCP_DISABLED_SERVERS_KEY,
  MCP_DISABLED_SPLIT_MIGRATED_KEY,
  MCP_DISABLED_SPLIT_PENDING_KEY,
} from "../mcp-manager";
import type { FolderTarget } from "../../../../workspace-folders/folder-registry";
import type { McpServerConfig } from "../../../../../shared/types/mcp";
import { connectedIn, enabledConfigs, folderTarget } from "./mcp-folder-fixtures";

const A = folderTarget(folderA);
const B = folderTarget(folderB);

type Servers = Record<string, McpServerConfig>;

let platform: FakePlatform;

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

function writeMcpJson(folder: string, servers: Servers): void {
  writeJson(path.join(folder, ".mcp.json"), { mcpServers: servers });
}

/** A workspaceState that keeps what is written, so the disabled lists survive a reload. */
function memento(initial: Record<string, unknown> = {}): Memento & { store: Map<string, unknown> } {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: <T>(key: string, defaultValue?: T): T => (store.has(key) ? store.get(key) : defaultValue) as T,
    update: async (key: string, value: unknown): Promise<void> => { store.set(key, value); },
  } as Memento & { store: Map<string, unknown> };
}

async function loaded(state: Memento, folders: () => readonly FolderTarget[] = () => [A, B]): Promise<McpManager> {
  const manager = new McpManager({ ...platform, state: { global: platform.state.global, workspace: state } }, folders);
  await manager.loadConfig();
  return manager;
}

const uiNames = (manager: McpManager, key: string): string[] => manager.getServersForUI(key).map(s => s.name).sort();

beforeEach(() => {
  for (const dir of [fakeHome, folderA, folderB]) fs.rmSync(dir, { recursive: true, force: true });
  writeJson(path.join(fakeHome, ".damocles", "mcp.json"), { mcpServers: { shared: { command: "user-shared" } } });
  writeMcpJson(folderA, { alpha: { command: "a-alpha" } });
  writeMcpJson(folderB, { beta: { command: "b-beta" } });
  platform = installFakePlatform();
  execMock.mockClear();
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("each folder lists its own servers plus the user ones", () => {
  it("gives A alpha+shared and B beta+shared, in the scope and in the UI list", async () => {
    const manager = await loaded(memento());

    expect(enabledConfigs(manager, A.key)).toEqual({
      userUnion: { shared: { command: "user-shared" } },
      userVisible: ["shared"],
      folder: { alpha: { command: "a-alpha" } },
    });
    expect(enabledConfigs(manager, B.key)).toEqual({
      userUnion: { shared: { command: "user-shared" } },
      userVisible: ["shared"],
      folder: { beta: { command: "b-beta" } },
    });
    expect(uiNames(manager, A.key)).toEqual(["alpha", "shared"]);
    expect(uiNames(manager, B.key)).toEqual(["beta", "shared"]);
  });

  it("reads Claude Code's local scope per folder, keyed by that folder's path", async () => {
    writeJson(path.join(fakeHome, ".claude.json"), {
      projects: {
        [folderA]: { mcpServers: { claudeA: { command: "claude-a" } } },
        [folderB]: { mcpServers: { claudeB: { command: "claude-b" } } },
      },
    });

    const manager = await loaded(memento());

    expect(Object.keys(enabledConfigs(manager, A.key).folder).sort()).toEqual(["alpha", "claudeA"]);
    expect(Object.keys(enabledConfigs(manager, B.key).folder).sort()).toEqual(["beta", "claudeB"]);
    expect(manager.getServersForUI(A.key).find(s => s.name === "claudeA")?.source).toBe("claude-local");
  });

  it("reports a folder's broken file only to that folder's panels", async () => {
    fs.writeFileSync(path.join(folderB, ".mcp.json"), "{ not json", "utf-8");

    const manager = await loaded(memento());

    expect(manager.getConfigErrors(A.key)).toEqual([]);
    expect(manager.getConfigErrors(B.key).map(e => e.path)).toEqual([path.join(folderB, ".mcp.json")]);
  });
});

describe("a folder redefining a user server", () => {
  beforeEach(() => writeMcpJson(folderB, { beta: { command: "b-beta" }, shared: { command: "b-shared" } }));

  it("uses B's definition in B, keeps the user one in A, and still connects the user one once", async () => {
    const manager = await loaded(memento());
    const scopeA = enabledConfigs(manager, A.key);
    const scopeB = enabledConfigs(manager, B.key);

    expect(scopeB.folder["shared"]).toEqual({ command: "b-shared" });
    expect(scopeB.userVisible).not.toContain("shared");
    expect(scopeA.userVisible).toContain("shared");
    expect(scopeA.folder).not.toHaveProperty("shared");
    expect(scopeA.userUnion["shared"]).toEqual({ command: "user-shared" });
    expect(scopeB.userUnion["shared"]).toEqual({ command: "user-shared" });
    expect(connectedIn(manager, A.key)["shared"]).toEqual({ command: "user-shared" });
    expect(connectedIn(manager, B.key)["shared"]).toEqual({ command: "b-shared" });
  });

  it("keeps the user server hidden in B while B's own copy is disabled there", async () => {
    // The folder entry still owns the name in B; unhiding the user one would connect a server the
    // folder replaced.
    const state = memento();
    const manager = await loaded(state);

    await manager.setServerEnabled(B.key, "shared", false);

    const scopeB = enabledConfigs(manager, B.key);
    expect(scopeB.folder).not.toHaveProperty("shared");
    expect(scopeB.userVisible).not.toContain("shared");
    expect(enabledConfigs(manager, A.key).userVisible).toContain("shared");
  });

  it("refuses the name from the folder whose file wins it, and accepts it from the other folder", async () => {
    const manager = await loaded(memento());

    expect(manager.getShadowingServerNames(B.key).get("shared")).toBe("workspace");
    expect(manager.getShadowingServerNames(A.key).has("shared")).toBe(false);
  });

  it("refuses the name in a single-folder window, where the written server could never connect", async () => {
    const manager = await loaded(memento(), () => [B]);

    expect(Object.fromEntries(manager.getShadowingServerNames(B.key))).toEqual({ beta: "workspace", shared: "workspace" });
  });

  it("does not refuse in an untrusted folder, whose files fold below ~/.damocles/mcp.json", async () => {
    platform.trust.setTrusted(false);
    const manager = await loaded(memento());

    expect(manager.getShadowingServerNames(B.key).size).toBe(0);
    expect(connectedIn(manager, B.key)["shared"]).toEqual({ command: "user-shared" });
  });

  it("drops a user server from the union once the only folder it was visible in closes", async () => {
    writeMcpJson(folderA, { shared: { command: "a-shared" } });
    let folders: readonly FolderTarget[] = [A, B];
    const manager = await loaded(memento(), () => folders);
    writeMcpJson(folderB, { beta: { command: "b-beta" } });
    await manager.loadConfig();
    expect(enabledConfigs(manager, A.key).userUnion).toHaveProperty("shared");

    folders = [A];
    await manager.handleFoldersChanged();

    expect(enabledConfigs(manager, A.key).userUnion).toEqual({});
    expect(enabledConfigs(manager, B.key)).toEqual({ userUnion: {}, userVisible: [], folder: {} });
  });
});

describe("editing one folder's file", () => {
  it("leaves the other folder's scope and list deep-equal, through the folder's own watcher", async () => {
    const manager = await loaded(memento());
    const before = platform.fileWatchers.watchers.length;
    manager.setupWatcher();
    const created = platform.fileWatchers.watchers.slice(before);
    const scopeA = enabledConfigs(manager, A.key);
    const listA = manager.getServersForUI(A.key);

    const watcherFor = (folder: string, file: string) => created.find(w => w.base === folder && w.glob === file);
    expect(watcherFor(folderA, ".mcp.json")).toBeDefined();
    expect(watcherFor(folderA, ".gitignore")).toBeDefined();
    expect(watcherFor(folderB, ".damocles/mcp.local.json")).toBeDefined();

    let reloaded = false;
    manager.setOnConfigChange(() => { reloaded = true; });
    writeMcpJson(folderB, { beta: { command: "b-beta-v2" }, gamma: { command: "b-gamma" } });
    watcherFor(folderB, ".mcp.json")!.fireChange(path.join(folderB, ".mcp.json"));
    await vi.waitFor(() => expect(reloaded).toBe(true));

    expect(enabledConfigs(manager, A.key)).toEqual(scopeA);
    expect(manager.getServersForUI(A.key)).toEqual(listA);
    expect(enabledConfigs(manager, B.key).folder).toEqual({ beta: { command: "b-beta-v2" }, gamma: { command: "b-gamma" } });
    manager.dispose();
  });

  it("disposes a removed folder's watchers and keeps the others", async () => {
    let folders: readonly FolderTarget[] = [A, B];
    const manager = await loaded(memento(), () => folders);
    const before = platform.fileWatchers.watchers.length;
    manager.setupWatcher();
    const created = platform.fileWatchers.watchers.slice(before);
    const inFolder = (folder: string) => created.filter(w => w.base === folder);

    folders = [A];
    await manager.handleFoldersChanged();

    // Four files per folder: .mcp.json, .pi/mcp.json, .damocles/mcp.local.json and its .gitignore.
    expect(inFolder(folderB).map(w => w.disposed)).toEqual([true, true, true, true]);
    expect(inFolder(folderA).map(w => w.disposed)).toEqual([false, false, false, false]);
    manager.dispose();
  });
});

describe("disabling is per folder for project servers and window-wide for user servers", () => {
  beforeEach(() => writeMcpJson(folderB, { alpha: { command: "b-alpha" }, beta: { command: "b-beta" } }));

  it("disables A's alpha without touching B's same-named alpha, and survives a reload", async () => {
    const state = memento();
    const manager = await loaded(state);

    await manager.setServerEnabled(A.key, "alpha", false);

    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");
    expect(enabledConfigs(manager, B.key).folder["alpha"]).toEqual({ command: "b-alpha" });
    expect(state.store.get(MCP_DISABLED_PROJECT_SERVERS_KEY)).toEqual({ [A.key]: ["alpha"] });
    expect(state.store.get(MCP_DISABLED_SERVERS_KEY)).toBeUndefined();

    await manager.loadConfig();
    expect(manager.getServersForUI(A.key).find(s => s.name === "alpha")?.enabled).toBe(false);
    expect(manager.getServersForUI(B.key).find(s => s.name === "alpha")?.enabled).toBe(true);
  });

  it("disables a user server in every folder at once", async () => {
    const state = memento();
    const manager = await loaded(state);

    await manager.setServerEnabled(A.key, "shared", false);

    for (const key of [A.key, B.key]) {
      const scope = enabledConfigs(manager, key);
      expect(scope.userUnion).not.toHaveProperty("shared");
      expect(scope.userVisible).not.toContain("shared");
      expect(manager.getServersForUI(key).find(s => s.name === "shared")?.enabled).toBe(false);
    }
    expect(state.store.get(MCP_DISABLED_SERVERS_KEY)).toEqual(["shared"]);
  });

  it("keeps pre-upgrade disabled names disabled: in the user list and copied to folders defining them", async () => {
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["alpha", "shared"] });
    writeMcpJson(folderB, { beta: { command: "b-beta" } });

    const manager = await loaded(state);

    expect(state.store.get(MCP_DISABLED_SERVERS_KEY)).toEqual(["alpha", "shared"]);
    expect(state.store.get(MCP_DISABLED_PROJECT_SERVERS_KEY)).toEqual({ [A.key]: ["alpha"] });
    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBe(true);
    expect(enabledConfigs(manager, A.key)).toEqual({ userUnion: {}, userVisible: [], folder: {} });
    expect(enabledConfigs(manager, B.key)).toEqual({ userUnion: {}, userVisible: [], folder: { beta: { command: "b-beta" } } });
  });

  it("runs the migration once, so a later re-enable in one folder is not undone", async () => {
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["alpha"] });
    const manager = await loaded(state);
    expect(enabledConfigs(manager, B.key).folder).not.toHaveProperty("alpha");

    await manager.setServerEnabled(B.key, "alpha", true);
    await manager.loadConfig();

    expect(enabledConfigs(manager, B.key).folder["alpha"]).toEqual({ command: "b-alpha" });
    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");
  });

  it("copies from the raw folder files, so an untrusted fold cannot hide a name from the migration", async () => {
    // Untrusted, the user `shared` wins B's fold. Deciding from the merge would skip B, and granting
    // trust would then bring B's own `shared` up enabled although the user had switched it off.
    writeMcpJson(folderB, { shared: { command: "b-shared" } });
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["shared"] });
    platform.trust.setTrusted(false);
    const manager = await loaded(state);

    platform.trust.setTrusted(true);
    await manager.loadConfig();

    expect(state.store.get(MCP_DISABLED_PROJECT_SERVERS_KEY)).toEqual({ [B.key]: ["shared"] });
    expect(enabledConfigs(manager, B.key).folder).not.toHaveProperty("shared");
    expect(manager.getServersForUI(B.key).find(s => s.name === "shared")).toMatchObject({ source: "workspace", enabled: false });
  });

  it("ignores a toggle for a name the folder does not list, writing nothing", async () => {
    writeMcpJson(folderA, { onlyA: { command: "a-only" } });
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["onlyA"] });
    const manager = await loaded(state);
    const before = structuredClone([...state.store]);

    await manager.setServerEnabled(B.key, "onlyA", true);

    expect([...state.store]).toEqual(before);
    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("onlyA");
  });

  it("retries the migration for a folder whose file could not be read, so a pre-upgrade disable holds", async () => {
    fs.writeFileSync(path.join(folderA, ".mcp.json"), '{ "mcpServers": { "alpha": ', "utf-8");
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["alpha"] });
    const manager = await loaded(state);
    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBeUndefined();

    writeMcpJson(folderA, { alpha: { command: "a-alpha" } });
    await manager.loadConfig();

    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");
    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBe(true);
    expect(state.store.get(MCP_DISABLED_SPLIT_PENDING_KEY)).toBeUndefined();
  });

  it("retries while ~/.claude.json cannot be parsed, since the Claude local scope is then unknown", async () => {
    fs.writeFileSync(path.join(fakeHome, ".claude.json"), "{ not json", "utf-8");
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["claudeA"] });
    const manager = await loaded(state);
    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBeUndefined();

    writeJson(path.join(fakeHome, ".claude.json"), { projects: { [folderA]: { mcpServers: { claudeA: { command: "claude-a" } } } } });
    await manager.loadConfig();

    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("claudeA");
    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBe(true);
  });

  it("keeps a pending folder's pre-upgrade disables in force while ~/.claude.json is unreadable", async () => {
    // A's own files read fine, but its Claude local scope is unknown, so A stays pending. Its `alpha`
    // must not connect in the meantime.
    fs.writeFileSync(path.join(fakeHome, ".claude.json"), "{ torn", "utf-8");
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["alpha"] });
    const manager = await loaded(state);

    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBeUndefined();
    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");
    expect(manager.getServersForUI(A.key).find(s => s.name === "alpha")?.enabled).toBe(false);
  });

  it("keeps a pre-upgrade disable from a readable file in force while a sibling file is broken", async () => {
    fs.writeFileSync(path.join(folderA, ".mcp.json"), '{ "mcpServers": ', "utf-8");
    writeJson(path.join(folderA, ".damocles", "mcp.local.json"), { mcpServers: { alpha: { command: "a-local-alpha" } } });
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["alpha"] });
    const manager = await loaded(state);

    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBeUndefined();
    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");
  });

  it("finishes a retried migration with the pre-upgrade names, never undoing later choices", async () => {
    // B migrates on the first load; A retries. Between the two, the user re-enables B's alpha and
    // disables the user `shared`, which A also defines. Neither later choice may be overwritten.
    fs.writeFileSync(path.join(folderA, ".mcp.json"), '{ "mcpServers": { "alpha": ', "utf-8");
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["alpha"] });
    const manager = await loaded(state);
    expect(enabledConfigs(manager, B.key).folder).not.toHaveProperty("alpha");

    await manager.setServerEnabled(B.key, "alpha", true);
    await manager.setServerEnabled(B.key, "shared", false);
    writeMcpJson(folderA, { alpha: { command: "a-alpha" }, shared: { command: "a-shared" } });
    await manager.loadConfig();

    expect(enabledConfigs(manager, B.key).folder["alpha"]).toEqual({ command: "b-alpha" });
    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");
    expect(enabledConfigs(manager, A.key).folder["shared"]).toEqual({ command: "a-shared" });
    expect(state.store.get(MCP_DISABLED_PROJECT_SERVERS_KEY)).toEqual({ [A.key]: ["alpha"] });
  });

  it("applies a folder toggle to the state a reload installed while the toggle waited for its write", async () => {
    const state = memento({ [MCP_DISABLED_SPLIT_MIGRATED_KEY]: true });
    const manager = await loaded(state);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const write = state.update.bind(state);
    state.update = async (key: string, value: unknown) => { await write(key, value); await held; };

    // The first write holds the toggle lock, so the reload below reads the lists before alpha's write.
    const first = manager.setServerEnabled(B.key, "beta", false);
    const second = manager.setServerEnabled(A.key, "alpha", false);
    await manager.loadConfig();
    release();
    await Promise.all([first, second]);

    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");
    expect(manager.getServersForUI(A.key).find(s => s.name === "alpha")?.enabled).toBe(false);
  });

  it("keeps a re-enable in a folder the split has not reached, through that folder's later migration", async () => {
    fs.writeFileSync(path.join(fakeHome, ".claude.json"), "{ torn", "utf-8");
    const state = memento({ [MCP_DISABLED_SERVERS_KEY]: ["alpha"] });
    const manager = await loaded(state);
    expect(enabledConfigs(manager, A.key).folder).not.toHaveProperty("alpha");

    await manager.setServerEnabled(A.key, "alpha", true);
    await manager.loadConfig();
    expect(enabledConfigs(manager, A.key).folder["alpha"]).toEqual({ command: "a-alpha" });
    expect(enabledConfigs(manager, B.key).folder).not.toHaveProperty("alpha");

    writeJson(path.join(fakeHome, ".claude.json"), {});
    await manager.loadConfig();

    expect(state.store.get(MCP_DISABLED_SPLIT_MIGRATED_KEY)).toBe(true);
    expect(enabledConfigs(manager, A.key).folder["alpha"]).toEqual({ command: "a-alpha" });
    expect(enabledConfigs(manager, B.key).folder).not.toHaveProperty("alpha");
    expect(state.store.get(MCP_DISABLED_PROJECT_SERVERS_KEY)).toEqual({ [B.key]: ["alpha"] });
  });

  it("ignores a toggle for a folder that is not open, writing nothing", async () => {
    const state = memento();
    const manager = await loaded(state);
    const before = structuredClone([...state.store]);

    await manager.setServerEnabled("/not/open", "alpha", false);

    expect([...state.store]).toEqual(before);
    expect(enabledConfigs(manager, A.key).folder).toHaveProperty("alpha");
  });
});

describe("an untrusted window", () => {
  it("lists alpha and beta as untrusted and withholds them, while the user server connects", async () => {
    platform.trust.setTrusted(false);
    const manager = await loaded(memento());

    for (const [key, name] of [[A.key, "alpha"], [B.key, "beta"]] as const) {
      const scope = enabledConfigs(manager, key);
      expect(scope.folder).toEqual({});
      expect(scope.userVisible).toEqual(["shared"]);
      expect(scope.userUnion).toEqual({ shared: { command: "user-shared" } });
      expect(manager.getServersForUI(key).find(s => s.name === name)?.untrusted).toBe(true);
      expect(manager.buildRuntimeStatus(key, []).find(s => s.name === name)).toMatchObject({ status: "disabled", untrusted: true });
    }
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("a single-folder window", () => {
  it("connects and lists exactly the merged servers", async () => {
    const manager = await loaded(memento(), () => [A]);

    expect(connectedIn(manager, A.key)).toEqual({ shared: { command: "user-shared" }, alpha: { command: "a-alpha" } });
    expect(manager.getServersForUI(A.key).map(s => [s.name, s.source])).toEqual([["shared", "damocles"], ["alpha", "workspace"]]);
  });
});

describe("a disabled user server", () => {
  it("is left out of the union every folder connects", async () => {
    const state = memento({ [MCP_DISABLED_SPLIT_MIGRATED_KEY]: true, [MCP_DISABLED_SERVERS_KEY]: ["shared"] });
    const manager = await loaded(state);

    expect(enabledConfigs(manager, A.key).userUnion).toEqual({});
    expect(manager.getServersForUI(A.key).find(s => s.name === "shared")?.status).toBe("disabled");
  });
});

describe("keys and edge cases", () => {
  it("gives an unknown folder key nothing of any folder, but keeps the user union", async () => {
    const manager = await loaded(memento());

    expect(enabledConfigs(manager, "/not/open")).toEqual({
      userUnion: { shared: { command: "user-shared" } },
      userVisible: [],
      folder: {},
    });
    expect(manager.getServersForUI("/not/open")).toEqual([]);
    expect(manager.buildRuntimeStatus("/not/open", [])).toEqual([]);
    expect(manager.getConfigErrors("/not/open")).toEqual([]);
  });

  it("serves user servers to the home target of a window with no folder, reading no project files there", async () => {
    // With no folder open the panel targets home, which has no project layer: a `.mcp.json` in the
    // home directory is not a folder source.
    writeMcpJson(fakeHome, { homeRepo: { command: "home-repo" } });
    const home = folderTarget(fakeHome, false);
    const manager = await loaded(memento(), () => [home]);

    expect(enabledConfigs(manager, home.key)).toEqual({
      userUnion: { shared: { command: "user-shared" } },
      userVisible: ["shared"],
      folder: {},
    });
    expect(uiNames(manager, home.key)).toEqual(["shared"]);
  });

  it("gives every folder an empty scope when the master switch is off", async () => {
    const manager = await loaded(memento());
    await platform.settings.update("damocles.mcp.enabled", false, "user");
    for (const key of [A.key, B.key]) {
      expect(enabledConfigs(manager, key)).toEqual({ userUnion: {}, userVisible: [], folder: {} });
    }
  });
});
