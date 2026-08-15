import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * `editableConfig` (contract §2.1) is what lets the Edit form pre-populate. These tests drive the real
 * `McpManager.loadConfig()` over real fixture files in a redirected home plus a workspace `.mcp.json`,
 * because the whole point of the field is that it is populated for exactly one source and exactly one
 * class of config — a mocked merge would prove nothing about that.
 */
const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-editable-"));
  return {
    tmpRoot: root,
    fakeHome: nodePath.join(root, "home"),
    fakeWorkspace: nodePath.join(root, "workspace"),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

import * as vscode from "vscode";
import type { McpServerStatusInfo } from "../../../../../shared/types/mcp";
import { McpManager } from "../mcp-manager";

/** The disabled-server set lives in workspaceState; nothing here disables anything. */
const workspaceState = {
  get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
  update: (): Promise<void> => Promise.resolve(),
  keys: (): readonly string[] => [],
} as unknown as vscode.Memento;

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

let servers: Map<string, McpServerStatusInfo>;

beforeAll(async () => {
  writeJson(path.join(fakeHome, ".damocles", "mcp.json"), {
    mcpServers: {
      plainStdio: { command: "docs-server", args: ["--stdio"], env: { LOG: "debug" } },
      plainRemote: { type: "http", url: "https://api.example.invalid/mcp", bearerTokenEnv: "EXAMPLE_TOKEN" },
      hasBearerToken: { type: "http", url: "https://api.example.invalid/mcp", bearerToken: "sk-live-SECRET" },
      hasLifecycle: { command: "legacy", lifecycle: "lazy" },
    },
  });
  // A Claude import whose config IS form-representable — proving the gate is provenance, not shape.
  writeJson(path.join(fakeHome, ".claude.json"), { mcpServers: { fromClaude: { command: "claude-server" } } });
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"), '[mcp_servers.fromCodex]\ncommand = "codex-server"\n', "utf-8");
  writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { fromWorkspace: { command: "ws-server" } } });

  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: fakeWorkspace } }];

  const manager = new McpManager(workspaceState);
  await manager.loadConfig();
  servers = new Map(manager.getServersForUI().map(s => [s.name, s]));
});

afterAll(() => {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("McpManager — editableConfig", () => {
  it("loads every source, so the gate is being tested against a real merge", () => {
    expect([...servers.keys()].sort()).toEqual([
      "fromClaude", "fromCodex", "fromWorkspace", "hasBearerToken", "hasLifecycle", "plainRemote", "plainStdio",
    ]);
  });

  it("sends the stored definition for a form-representable Damocles stdio server", () => {
    expect(servers.get("plainStdio")?.editableConfig).toEqual({
      command: "docs-server",
      args: ["--stdio"],
      env: { LOG: "debug" },
    });
  });

  it("sends the stored definition for a form-representable Damocles remote server", () => {
    expect(servers.get("plainRemote")?.editableConfig).toEqual({
      type: "http",
      url: "https://api.example.invalid/mcp",
      bearerTokenEnv: "EXAMPLE_TOKEN",
    });
  });

  it("omits it entirely for a Damocles server storing a raw bearerToken, so no token reaches the webview", () => {
    const entry = servers.get("hasBearerToken");
    expect(entry?.editableConfig).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain("sk-live-SECRET");
  });

  it("omits it entirely for a Damocles server storing a non-form key, rather than stripping the key", () => {
    // Hiding Edit is the honest outcome: pre-populating a form that cannot show `lifecycle` would
    // silently drop it on save.
    expect(servers.get("hasLifecycle")?.editableConfig).toBeUndefined();
    expect(servers.get("hasLifecycle")?.source).toBe("damocles");
  });

  it.each(["fromClaude", "fromCodex", "fromWorkspace"])(
    "omits it for the %s server regardless of how simple its config is",
    (name) => {
      expect(servers.get(name)?.editableConfig).toBeUndefined();
    },
  );

  it("still reports source and readonly for every entry, so the UI gate has both halves", () => {
    expect(servers.get("plainStdio")).toMatchObject({ source: "damocles", readonly: false });
    expect(servers.get("fromClaude")).toMatchObject({ source: "claude", readonly: true });
    expect(servers.get("fromCodex")).toMatchObject({ source: "codex", readonly: true });
    expect(servers.get("fromWorkspace")).toMatchObject({ source: "workspace", readonly: false });
  });
});

describe("McpManager — getWorkspaceServerNames", () => {
  it("returns only the names the workspace .mcp.json defines, which is what the write path rejects", async () => {
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    const names = manager.getWorkspaceServerNames();
    expect([...names]).toEqual(["fromWorkspace"]);
    // Claude/Codex names are deliberately absent: `damocles` outranks them, so overriding is allowed.
    expect(names.has("fromClaude")).toBe(false);
    expect(names.has("fromCodex")).toBe(false);
  });
});
