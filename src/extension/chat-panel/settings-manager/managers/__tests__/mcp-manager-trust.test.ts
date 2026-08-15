import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";

/**
 * Where the workspace `.mcp.json` folds, and what that means for a same-named user-global server.
 *
 * Driven over real files through the real `loadConfig()`, because the defect being pinned is a
 * precedence-vs-trust interaction: a mocked merge would prove nothing about it.
 */
const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-trust-"));
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
import { McpManager } from "../mcp-manager";

const workspaceState = {
  get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
  update: (): Promise<void> => Promise.resolve(),
  keys: (): readonly string[] => [],
} as unknown as vscode.Memento;

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

function setTrusted(trusted: boolean): void {
  (vscode.workspace as { isTrusted: boolean }).isTrusted = trusted;
}

beforeAll(() => {
  // Both files define `github`. The user's own is the trusted one.
  writeJson(path.join(fakeHome, ".damocles", "mcp.json"), {
    mcpServers: { github: { command: "my-github" }, mine: { command: "mine" } },
  });
  writeJson(path.join(fakeWorkspace, ".mcp.json"), {
    mcpServers: { github: { command: "repo-github" }, repoOnly: { command: "repo-only" } },
  });
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: fakeWorkspace } }];
});

afterEach(() => setTrusted(true));

afterAll(() => {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [];
  setTrusted(true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("McpManager — workspace precedence under trust", () => {
  it("lets a TRUSTED workspace .mcp.json override a user-global server", async () => {
    setTrusted(true);
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    expect(manager.getEnabledServers()["github"]).toEqual({ command: "repo-github" });
  });

  it("does not let an UNTRUSTED workspace .mcp.json disable a user-global server", async () => {
    // Folded highest, the untrusted repo's `github` would overwrite the user's, and the trust filter
    // would then withhold the merged entry for being workspace-sourced — so opening an untrusted repo
    // that happens to name a server `github` silently stops your own `github` from connecting. That is
    // attacker-controllable denial of a tool, and the panel would blame your config for it.
    setTrusted(false);
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    expect(manager.getEnabledServers()["github"]).toEqual({ command: "my-github" });
    expect(manager.getEnabledServers()["mine"]).toEqual({ command: "mine" });
  });

  it("still withholds a server only the untrusted workspace defines, and shows it as untrusted", async () => {
    setTrusted(false);
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    expect(manager.getEnabledServers()).not.toHaveProperty("repoOnly");
    const row = manager.getServersForUI().find(s => s.name === "repoOnly");
    expect(row?.source).toBe("workspace");
    expect(row?.untrusted).toBe(true);
  });
});

describe("McpManager — concurrent loadConfig", () => {
  it("keeps the newest snapshot when an older read finishes last", async () => {
    const manager = new McpManager(workspaceState);

    // Three triggers reach loadConfig (panel write, watcher, session startup) and it awaits five reads
    // before assigning. Without a generation stamp an older one can land last — and since
    // getEnabledServers() feeds the live client, a stale snapshot disconnects servers rather than
    // merely showing stale rows.
    const stale = manager.loadConfig();
    const fresh = manager.loadConfig();
    await Promise.all([stale, fresh]);

    expect(Object.keys(manager.getEnabledServers()).sort()).toEqual(["github", "mine", "repoOnly"]);
    expect(manager.getConfigLoaded()).toBe(true);
  });

  it("hands out a copy of the config errors rather than its own array", async () => {
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    const errors = manager.getConfigErrors();
    errors.push({ path: "injected", kind: "parse", line: null, column: null });

    expect(manager.getConfigErrors()).toHaveLength(0);
  });
});
