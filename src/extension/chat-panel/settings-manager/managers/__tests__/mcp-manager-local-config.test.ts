import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

/**
 * What a hand-edited `<ws>/.damocles/mcp.local.json` does to the rest of the panel.
 *
 * The file is personal, gitignored and hand-authored, so a stray comma in it is the ordinary case
 * rather than the exotic one. Driven over real files through the real `loadConfig()`, because the
 * property under test is that ONE broken file costs you only its own servers.
 */
const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-mcp-local-"));
  return {
    tmpRoot: root,
    fakeHome: nodePath.join(root, "home"),
    // Inside the fake home on purpose: `displayPath` only collapses to `~` for a path under it, and
    // the collapse is what keeps the OS username out of a screenshotted panel.
    fakeWorkspace: nodePath.join(root, "home", "workspace"),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

const logMock = vi.hoisted(() => vi.fn());
vi.mock("../../../../logger", () => ({ log: logMock }));

/**
 * The real leak guard runs; only the git call is faked, so `loadConfig()`'s wiring to it is exercised
 * without a subprocess and without depending on whether the temp directory sits inside a repository.
 */
const execMock = vi.hoisted(() => vi.fn(async () => ({ stdout: "!! .damocles/mcp.local.json\n", stderr: "" })));
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import * as vscode from "vscode";
import { McpManager } from "../mcp-manager";
import { localMcpConfigPath } from "../mcp-config-import";

const workspaceState = {
  get: <T>(_key: string, defaultValue?: T): T => defaultValue as T,
  update: (): Promise<void> => Promise.resolve(),
  keys: (): readonly string[] => [],
} as unknown as vscode.Memento;

const LOCAL_MCP_PATH = localMcpConfigPath(fakeWorkspace);

/** A trailing comma, the mistake a hand-edit actually makes, beside a value shaped like a token. */
const BROKEN_LOCAL_FILE = [
  "{",
  '  "mcpServers": {',
  '    "personal": { "command": "node", "env": { "TOKEN": "sk-live-SUPERSECRET" } },',
  "  }",
  "}",
].join("\n");

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

function writeLocalFile(content: string): void {
  fs.mkdirSync(path.dirname(LOCAL_MCP_PATH), { recursive: true });
  fs.writeFileSync(LOCAL_MCP_PATH, content, "utf-8");
}

async function loadedManager(): Promise<McpManager> {
  const manager = new McpManager(workspaceState);
  await manager.loadConfig();
  return manager;
}

beforeAll(() => {
  writeJson(path.join(fakeHome, ".damocles", "mcp.json"), { mcpServers: { fromDamocles: { command: "dm" } } });
  writeJson(path.join(fakeHome, ".claude.json"), {
    mcpServers: { fromClaude: { command: "cl" } },
    projects: { [fakeWorkspace]: { mcpServers: { fromClaudeLocal: { command: "cl-local" } } } },
  });
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"), '[mcp_servers.fromCodex]\ncommand = "cx"\n', "utf-8");
  writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { fromWorkspace: { command: "ws" } } });

  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: fakeWorkspace } }];
});

afterAll(() => {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [];
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("McpManager: an unparseable <ws>/.damocles/mcp.local.json", () => {
  it("reports it exactly once, with the ~-collapsed path and the line to fix", async () => {
    writeLocalFile(BROKEN_LOCAL_FILE);
    const errors = (await loadedManager()).getConfigErrors();

    expect(errors).toHaveLength(1);
    expect(errors[0]!.path).toBe(LOCAL_MCP_PATH);
    expect(errors[0]!.displayPath).toBe("~/workspace/.damocles/mcp.local.json");
    expect(errors[0]!.kind).toBe("parse");
    // A location, not a guess: the panel offers "Open file" at this line.
    expect(errors[0]!.line).toBe(4);
    expect(errors[0]!.column).toBe(3);
  });

  it("keeps every other source loading, so one bad file is not a blackout", async () => {
    writeLocalFile(BROKEN_LOCAL_FILE);
    const manager = await loadedManager();

    expect(Object.keys(manager.getEnabledServers()).sort()).toEqual([
      "fromClaude", "fromClaudeLocal", "fromCodex", "fromDamocles", "fromWorkspace",
    ]);
  });

  it("carries no file content into the error or the log, which is written to disk", async () => {
    logMock.mockClear();
    writeLocalFile(BROKEN_LOCAL_FILE);
    const errors = (await loadedManager()).getConfigErrors();

    // This file is the one place the brief expects plaintext credentials, and V8 embeds a window of
    // the source in some JSON.parse messages. Only the location may cross.
    expect(JSON.stringify(errors)).not.toContain("SUPERSECRET");
    expect(logMock.mock.calls.flat().join(" ")).not.toContain("SUPERSECRET");
  });

  it("reports nothing once the file parses, and folds its servers in highest", async () => {
    writeLocalFile(JSON.stringify({ mcpServers: { fromWorkspace: { command: "local-wins" } } }));
    const manager = await loadedManager();

    expect(manager.getConfigErrors()).toEqual([]);
    expect(manager.getEnabledServers()["fromWorkspace"]).toEqual({ command: "local-wins" });
    expect(manager.getServersForUI().find(s => s.name === "fromWorkspace")?.source).toBe("damocles-local");
  });

  it("treats an absent file as no servers rather than an error", async () => {
    fs.rmSync(LOCAL_MCP_PATH, { force: true });
    const manager = await loadedManager();

    expect(manager.getConfigErrors()).toEqual([]);
    expect(manager.getEnabledServers()["fromWorkspace"]).toEqual({ command: "ws" });
  });
});

describe("McpManager: the gitignore leak flag reaches the panel payload", () => {
  it("stays false while git reports the file ignored", async () => {
    writeLocalFile(JSON.stringify({ mcpServers: {} }));
    execMock.mockResolvedValue({ stdout: "!! .damocles/mcp.local.json\n", stderr: "" });

    expect((await loadedManager()).getLocalMcpUnignored()).toBe(false);
  });

  it("goes true when git reports it committable, which is what the panel warning renders", async () => {
    writeLocalFile(JSON.stringify({ mcpServers: {} }));
    execMock.mockResolvedValue({ stdout: "?? .damocles/mcp.local.json\n", stderr: "" });

    expect((await loadedManager()).getLocalMcpUnignored()).toBe(true);
  });

  it("stays false with no file on disk, and never asks git", async () => {
    fs.rmSync(LOCAL_MCP_PATH, { force: true });
    execMock.mockClear();

    expect((await loadedManager()).getLocalMcpUnignored()).toBe(false);
    expect(execMock).not.toHaveBeenCalled();
  });
});

describe("McpManager: what the watchers cover", () => {
  /** A watcher whose change event a test can fire, standing in for the one the manager creates. */
  class DrivableWatcher {
    private changeCbs: (() => void)[] = [];
    onDidChange(cb: () => void) { this.changeCbs.push(cb); return { dispose: () => { this.changeCbs = []; } }; }
    onDidCreate() { return { dispose: () => {} }; }
    onDidDelete() { return { dispose: () => {} }; }
    dispose() { this.changeCbs = []; }
    emitChange() { for (const cb of [...this.changeCbs]) cb(); }
  }

  /** Capture the pattern each watcher was created for, alongside the watcher itself. */
  function recordWatchers(): { patterns: string[]; watchers: DrivableWatcher[]; restore: () => void } {
    const original = vscode.workspace.createFileSystemWatcher;
    const patterns: string[] = [];
    const watchers: DrivableWatcher[] = [];
    (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = (pattern: { pattern: string }) => {
      patterns.push(pattern.pattern);
      const watcher = new DrivableWatcher();
      watchers.push(watcher);
      return watcher;
    };
    return {
      patterns,
      watchers,
      restore: () => {
        (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = original;
      },
    };
  }

  it("re-reads the config when .gitignore changes, which is the only thing that clears the leak warning", async () => {
    // Adding the line the panel asks for touches no MCP config file, so without this watcher the
    // warning stays up until something unrelated moves.
    writeLocalFile(JSON.stringify({ mcpServers: {} }));
    execMock.mockResolvedValue({ stdout: "?? .damocles/mcp.local.json\n", stderr: "" });

    const manager = await loadedManager();
    expect(manager.getLocalMcpUnignored()).toBe(true);

    const recorder = recordWatchers();
    try {
      manager.setupWatcher(fakeWorkspace);
      const index = recorder.patterns.indexOf(".gitignore");
      expect(index, `no watcher for .gitignore, only ${recorder.patterns.join(", ")}`).toBeGreaterThanOrEqual(0);

      // The user adds the line, so git now reports the file ignored.
      execMock.mockResolvedValue({ stdout: "!! .damocles/mcp.local.json\n", stderr: "" });
      let reloaded = false;
      manager.setOnConfigChange(() => { reloaded = true; });
      recorder.watchers[index]!.emitChange();
      await vi.waitFor(() => expect(reloaded).toBe(true));

      expect(manager.getLocalMcpUnignored()).toBe(false);
    } finally {
      recorder.restore();
      manager.dispose();
    }
  });

  it("watches both project MCP files and both user-global ones, and not ~/.claude.json", async () => {
    // Claude Code rewrites `~/.claude.json` continuously, and every event here re-drives
    // `setMcpServers()` on the live client. Reload config is how a change there is picked up.
    const manager = new McpManager(workspaceState);
    const recorder = recordWatchers();
    try {
      manager.setupWatcher(fakeWorkspace);

      expect(recorder.patterns).toContain(".mcp.json");
      expect(recorder.patterns).toContain(".damocles/mcp.local.json");
      expect(recorder.patterns).toContain(".gitignore");
      expect(recorder.patterns).toContain("mcp.json");
      expect(recorder.patterns).toContain("config.toml");
      expect(recorder.patterns).not.toContain(".claude.json");
    } finally {
      recorder.restore();
      manager.dispose();
    }
  });
});
