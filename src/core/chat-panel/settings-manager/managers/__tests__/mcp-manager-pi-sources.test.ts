import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * The pi config sources, the value format each source hands the connect path, pi's path rules, the
 * error rows a file's unusable entries become, and the owned-file migrations `loadConfig` runs first.
 * Driven over real files through the real `loadConfig()` in a redirected home.
 */
const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-pi-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => { throw new Error("fatal: not a git repository"); }));
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import { installFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";
import { McpManager } from "../mcp-manager";
import { folderTarget } from "./mcp-folder-fixtures";

const WS = folderTarget(fakeWorkspace);
const USER_PI = () => path.join(fakeHome, ".pi", "agent", "mcp.json");
const PROJECT_PI = () => path.join(fakeWorkspace, ".pi", "mcp.json");
const USER_DAMOCLES = () => path.join(fakeHome, ".damocles", "mcp.json");
const LOCAL_DAMOCLES = () => path.join(fakeWorkspace, ".damocles", "mcp.local.json");

let platform: FakePlatform;

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

async function loaded(trusted = true): Promise<McpManager> {
  platform.trust.setTrusted(trusted);
  const manager = new McpManager(platform, () => [WS]);
  await manager.loadConfig();
  return manager;
}

beforeEach(() => {
  platform = installFakePlatform();
  fs.rmSync(fakeHome, { recursive: true, force: true });
  fs.rmSync(fakeWorkspace, { recursive: true, force: true });
  fs.mkdirSync(fakeWorkspace, { recursive: true });
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe("pi config sources", () => {
  it("lists ~/.pi/agent/mcp.json servers with the pi badge, read-only, as user servers in pi's value format", async () => {
    writeJson(USER_PI(), { mcpServers: { fromPi: { command: "pi-cmd" } } });
    const manager = await loaded();

    expect(manager.getServersForUI(WS.key).find((s) => s.name === "fromPi")).toMatchObject({ source: "pi", readonly: true });
    expect(manager.getEnabledServers(WS.key).userUnion["fromPi"]).toEqual({
      config: { command: "pi-cmd", cwd: fakeHome },
      valueFormat: "pi",
      folderScoped: false,
      trusted: true,
    });
  });

  it("reads .pi/mcp.json only in a trusted folder", async () => {
    writeJson(PROJECT_PI(), { mcpServers: { fromProjectPi: { command: "project-pi" } } });

    const untrusted = await loaded(false);
    expect(untrusted.getServersForUI(WS.key).map((s) => s.name)).not.toContain("fromProjectPi");
    expect(untrusted.getEnabledServers(WS.key).folder).toEqual({});

    const trusted = await loaded(true);
    expect(trusted.getServersForUI(WS.key).find((s) => s.name === "fromProjectPi")?.source).toBe("pi-project");
    expect(trusted.getEnabledServers(WS.key).folder["fromProjectPi"]).toMatchObject({
      valueFormat: "pi",
      folderScoped: true,
      trusted: true,
    });
  });

  it("ranks .pi/mcp.json above ~/.pi/agent/mcp.json and below ~/.damocles/mcp.json", async () => {
    writeJson(USER_PI(), { mcpServers: { a: { command: "user-pi" }, b: { command: "user-pi" } } });
    writeJson(PROJECT_PI(), { mcpServers: { a: { command: "project-pi" }, b: { command: "project-pi" } } });
    writeJson(USER_DAMOCLES(), { mcpServers: { b: { command: "damocles" } } });
    const manager = await loaded();

    const sources = Object.fromEntries(manager.getServersForUI(WS.key).map((s) => [s.name, s.source]));
    expect(sources).toEqual({ a: "pi-project", b: "damocles" });
  });

  it("keeps .mcp.json and Claude files in the legacy value format", async () => {
    writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { repo: { command: "r" } } });
    const manager = await loaded();
    expect(manager.getEnabledServers(WS.key).folder["repo"]).toMatchObject({ valueFormat: "legacy", folderScoped: true });
  });

  it("watches both pi files", async () => {
    const manager = await loaded();
    const before = platform.fileWatchers.watchers.length;
    manager.setupWatcher();
    const created = platform.fileWatchers.watchers.slice(before);

    expect(created.some((w) => w.base === fakeWorkspace && w.glob === ".pi/mcp.json")).toBe(true);
    expect(created.some((w) => w.base === path.dirname(USER_PI()) && w.glob === "mcp.json")).toBe(true);
    manager.dispose();
  });
});

describe("pi's path rules for pi-format entries", () => {
  it("expands ~ in command, args and cwd, and resolves a relative cwd against the folder", async () => {
    writeJson(LOCAL_DAMOCLES(), { mcpServers: { local: { command: "~/bin/srv", args: ["~/data", "plain"], cwd: "sub/dir" } } });
    const manager = await loaded();

    expect(manager.getEnabledServers(WS.key).folder["local"]?.config).toEqual({
      command: path.join(fakeHome, "bin/srv"),
      args: [path.join(fakeHome, "data"), "plain"],
      cwd: path.resolve(fakeWorkspace, "sub/dir"),
    });
  });

  it("resolves a user server's relative cwd against the home directory", async () => {
    writeJson(USER_PI(), { mcpServers: { user: { command: "srv", cwd: "work" } } });
    const manager = await loaded();
    expect(manager.getEnabledServers(WS.key).userUnion["user"]?.config).toMatchObject({ cwd: path.resolve(fakeHome, "work") });
  });

  it("runs a pi-format entry with no cwd in the folder, or in the home directory for a user server", async () => {
    writeJson(LOCAL_DAMOCLES(), { mcpServers: { local: { command: "srv", args: ["."] } } });
    writeJson(USER_PI(), { mcpServers: { user: { command: "srv" } } });
    const manager = await loaded();

    const servers = manager.getEnabledServers(WS.key);
    expect(servers.folder["local"]?.config).toEqual({ command: "srv", args: ["."], cwd: fakeWorkspace });
    expect(servers.userUnion["user"]?.config).toEqual({ command: "srv", cwd: fakeHome });
  });

  it("leaves a legacy entry's command as written and resolves its cwd against the folder, the stored file untouched", async () => {
    writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { repo: { command: "~/bin/srv", cwd: "sub" } } });
    const before = fs.readFileSync(path.join(fakeWorkspace, ".mcp.json"), "utf-8");
    const manager = await loaded();
    expect(manager.getEnabledServers(WS.key).folder["repo"]?.config).toEqual({ command: "~/bin/srv", cwd: path.resolve(fakeWorkspace, "sub") });
    expect(fs.readFileSync(path.join(fakeWorkspace, ".mcp.json"), "utf-8")).toBe(before);
  });

  it("runs a legacy entry with no cwd in the folder, or in the home directory for a user server", async () => {
    writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { repo: { command: "srv", args: ["."] } } });
    writeJson(path.join(fakeHome, ".claude", "claude_desktop_config.json"), { mcpServers: { desktop: { command: "srv" } } });
    const manager = await loaded();

    const servers = manager.getEnabledServers(WS.key);
    expect(servers.folder["repo"]?.config).toEqual({ command: "srv", args: ["."], cwd: fakeWorkspace });
    expect(servers.userUnion["desktop"]?.config).toEqual({ command: "srv", cwd: fakeHome });
  });

  it("still expands ${VAR} and $env:VAR in a legacy entry's cwd", async () => {
    const outside = path.join(tmpRoot, "outside");
    vi.stubEnv("DAMOCLES_TEST_MCP_DIR", outside);
    writeJson(path.join(fakeWorkspace, ".mcp.json"), {
      mcpServers: { braces: { command: "srv", cwd: "${DAMOCLES_TEST_MCP_DIR}/a" }, powershell: { command: "srv", cwd: "$env:DAMOCLES_TEST_MCP_DIR/b" } },
    });
    const manager = await loaded();

    const folder = manager.getEnabledServers(WS.key).folder;
    vi.unstubAllEnvs();
    expect(folder["braces"]?.config).toMatchObject({ cwd: path.resolve(outside, "a") });
    expect(folder["powershell"]?.config).toMatchObject({ cwd: path.resolve(outside, "b") });
  });

  it("fails a pi-format entry whose cwd holds ${VAR} or $env:VAR, which pi does not expand, naming cwd", async () => {
    writeJson(LOCAL_DAMOCLES(), { mcpServers: { braces: { command: "srv", cwd: "${HOME}/proj" } } });
    writeJson(USER_PI(), { mcpServers: { powershell: { command: "srv", cwd: "$env:USERPROFILE\\proj" } } });
    const manager = await loaded();

    const rows = Object.fromEntries(manager.getServersForUI(WS.key).map((s) => [s.name, s]));
    for (const name of ["braces", "powershell"]) {
      expect(rows[name]).toMatchObject({ status: "failed", errorInfo: { code: "invalidConfig" } });
      expect(rows[name]?.error).toMatch(/^cwd /);
    }
    const servers = manager.getEnabledServers(WS.key);
    expect(servers.folder).toEqual({});
    expect(servers.userUnion).toEqual({});
  });
});

describe("error rows", () => {
  it("shows an SSE entry, an auth.provider entry and a broken entry as failed rows that never connect", async () => {
    writeJson(USER_PI(), {
      mcpServers: {
        legacy: { type: "sse", url: "https://x.example.com/sse" },
        provider: { url: "https://x.example.com/mcp", auth: { provider: "anthropic" } },
        broken: { type: "http", url: "https://x.example.com/mcp", timeout: 0 },
      },
    });
    const manager = await loaded();
    const rows = Object.fromEntries(manager.getServersForUI(WS.key).map((s) => [s.name, s]));

    expect(rows["legacy"]).toMatchObject({ status: "failed", errorInfo: { code: "sseUnsupported" } });
    expect(rows["legacy"]?.error).toBe("legacy SSE transport is not supported; use the server's streamable HTTP URL");
    expect(rows["provider"]).toMatchObject({ status: "failed", errorInfo: { code: "authProviderUnsupported" } });
    expect(rows["broken"]).toMatchObject({ status: "failed", errorInfo: { code: "invalidConfig" } });
    expect(manager.getEnabledServers(WS.key).userUnion).toEqual({});
  });

  it("never puts a config value into an error row", async () => {
    writeJson(USER_PI(), { mcpServers: { bad: { type: "http", url: "https://x.example.com/mcp", headers: { Authorization: 42 }, timeout: "sk-live-SECRET" } } });
    const manager = await loaded();
    expect(JSON.stringify(manager.getServersForUI(WS.key))).not.toContain("sk-live-SECRET");
  });

  it("loads one of two servers whose tool names would collide and names the kept one on the other row", async () => {
    writeJson(USER_PI(), { mcpServers: { "my-server": { command: "a" } } });
    writeJson(USER_DAMOCLES(), { mcpServers: { "my.server": { command: "b" } } });
    const manager = await loaded();

    expect(Object.keys(manager.getEnabledServers(WS.key).userUnion)).toEqual(["my.server"]);
    expect(manager.getServersForUI(WS.key).find((s) => s.name === "my-server")).toMatchObject({
      status: "failed",
      errorInfo: { code: "nameCollision", params: { kept: "my.server", keptSource: "damocles" } },
    });
  });

  it("carries a config description to the row, sanitized and capped", async () => {
    writeJson(USER_PI(), { mcpServers: { docs: { command: "d", description: `Docs\u0007 ${"x".repeat(200)}` } } });
    const manager = await loaded();
    const description = manager.getServersForUI(WS.key).find((s) => s.name === "docs")?.description ?? "";
    expect(description.length).toBeLessThanOrEqual(120);
    expect(description.startsWith("Docs")).toBe(true);
    expect(description).not.toContain("\u0007");
  });
});

describe("config enabled:false", () => {
  it("lists the server as disabled until the panel enables it, without editing the file", async () => {
    writeJson(USER_PI(), { mcpServers: { off: { command: "x", enabled: false } } });
    const before = fs.readFileSync(USER_PI(), "utf-8");
    const manager = await loaded();
    expect(manager.getServersForUI(WS.key).find((s) => s.name === "off")?.status).toBe("disabled");
    expect(manager.getEnabledServers(WS.key).userUnion).toEqual({});

    await manager.setServerEnabled(WS.key, "off", true);
    await manager.loadConfig();

    expect(Object.keys(manager.getEnabledServers(WS.key).userUnion)).toEqual(["off"]);
    expect(fs.readFileSync(USER_PI(), "utf-8")).toBe(before);
  });

  async function enabledDespiteConfig(): Promise<McpManager> {
    writeJson(USER_DAMOCLES(), { mcpServers: { off: { command: "x", enabled: false } } });
    const manager = await loaded();
    await manager.setServerEnabled(WS.key, "off", true);
    return manager;
  }

  it("carries the override through a rename", async () => {
    const manager = await enabledDespiteConfig();
    await manager.carryDisabledServerThroughRename("off", "renamed");
    writeJson(USER_DAMOCLES(), { mcpServers: { renamed: { command: "x", enabled: false } } });
    await manager.loadConfig();
    expect(Object.keys(manager.getEnabledServers(WS.key).userUnion)).toEqual(["renamed"]);
  });

  it("drops the override when the server is deleted, so a re-added enabled:false server stays off", async () => {
    const manager = await enabledDespiteConfig();
    await manager.pruneDisabledServer("off");
    await manager.loadConfig();
    expect(manager.getEnabledServers(WS.key).userUnion).toEqual({});
  });

  it("drops the override once the config no longer says enabled:false, so setting it again applies", async () => {
    const manager = await enabledDespiteConfig();
    writeJson(USER_DAMOCLES(), { mcpServers: { off: { command: "x" } } });
    await manager.loadConfig();

    writeJson(USER_DAMOCLES(), { mcpServers: { off: { command: "x", enabled: false } } });
    await manager.loadConfig();
    expect(manager.getEnabledServers(WS.key).userUnion).toEqual({});
  });

  it("drops a folder server's override once its config no longer says enabled:false", async () => {
    writeJson(LOCAL_DAMOCLES(), { mcpServers: { local: { command: "x", enabled: false } } });
    const manager = await loaded();
    await manager.setServerEnabled(WS.key, "local", true);
    writeJson(LOCAL_DAMOCLES(), { mcpServers: { local: { command: "x" } } });
    await manager.loadConfig();

    writeJson(LOCAL_DAMOCLES(), { mcpServers: { local: { command: "x", enabled: false } } });
    await manager.loadConfig();
    expect(manager.getEnabledServers(WS.key).folder).toEqual({});
  });
});

describe("owned-file migrations on load", () => {
  it("rewrites $env:NAME and oauth.redirectUri in ~/.damocles/mcp.json before reading it", async () => {
    writeJson(USER_DAMOCLES(), {
      mcpServers: {
        api: { type: "http", url: "https://x.example.com/mcp", headers: { Authorization: "Bearer $env:API_KEY" }, oauth: { redirectUri: "http://127.0.0.1:3118/callback" } },
      },
    });
    const manager = await loaded();

    expect(manager.getEnabledServers(WS.key).userUnion["api"]?.config).toEqual({
      type: "http",
      url: "https://x.example.com/mcp",
      headers: { Authorization: "Bearer ${API_KEY}" },
      oauth: { callbackUrl: "http://127.0.0.1:3118/callback" },
    });
  });

  it("migrates .damocles/mcp.local.json only in a trusted folder", async () => {
    writeJson(LOCAL_DAMOCLES(), { mcpServers: { local: { command: "x", env: { K: "$env:K" } } } });
    const original = fs.readFileSync(LOCAL_DAMOCLES(), "utf-8");

    await loaded(false);
    expect(fs.readFileSync(LOCAL_DAMOCLES(), "utf-8")).toBe(original);

    await loaded(true);
    expect(JSON.parse(fs.readFileSync(LOCAL_DAMOCLES(), "utf-8"))).toEqual({ mcpServers: { local: { command: "x", env: { K: "${K}" } } } });
  });

  it("never rewrites another tool's file", async () => {
    writeJson(USER_PI(), { mcpServers: { p: { command: "x", env: { K: "$env:K" } } } });
    writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { w: { command: "x", env: { K: "$env:K" } } } });
    const pi = fs.readFileSync(USER_PI(), "utf-8");
    const workspace = fs.readFileSync(path.join(fakeWorkspace, ".mcp.json"), "utf-8");

    await loaded();

    expect(fs.readFileSync(USER_PI(), "utf-8")).toBe(pi);
    expect(fs.readFileSync(path.join(fakeWorkspace, ".mcp.json"), "utf-8")).toBe(workspace);
  });
});
