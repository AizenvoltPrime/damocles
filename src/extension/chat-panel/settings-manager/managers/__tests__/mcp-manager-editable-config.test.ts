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

/** `loadConfig()` asks git whether `mcp.local.json` is ignored; faked so no suite spawns a process. */
const execMock = vi.hoisted(() => vi.fn(async () => { throw new Error("fatal: not a git repository"); }));
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import * as vscode from "vscode";
import { mcpSourceOrder, SHADOWING_SOURCES } from "@shared/types/mcp";
import type { McpServerSource, McpServerStatusInfo } from "@shared/types/mcp";
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

/**
 * Exactly one uniquely-named server per source, so a name identifies the source it came from. The
 * shadowing assertion below maps `mcpSourceOrder` through this rather than listing names, which is
 * the whole point: a precedence change has to move the expectation with it.
 */
const SERVER_BY_SOURCE: Record<McpServerSource, string> = {
  workspace: "fromWorkspace",
  damocles: "plainStdio",
  claude: "fromClaude",
  codex: "fromCodex",
  "claude-local": "fromClaudeLocal",
  "damocles-local": "fromLocalDamocles",
};

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
  // Both Claude scopes live in this one file; `projects[<ws>]` is the local scope.
  writeJson(path.join(fakeHome, ".claude.json"), {
    mcpServers: { fromClaude: { command: "claude-server" } },
    projects: { [fakeWorkspace]: { mcpServers: { fromClaudeLocal: { command: "claude-local-server" } } } },
  });
  fs.mkdirSync(path.join(fakeHome, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, ".codex", "config.toml"), '[mcp_servers.fromCodex]\ncommand = "codex-server"\n', "utf-8");
  writeJson(path.join(fakeWorkspace, ".mcp.json"), { mcpServers: { fromWorkspace: { command: "ws-server" } } });
  writeJson(path.join(fakeWorkspace, ".damocles", "mcp.local.json"), {
    mcpServers: { fromLocalDamocles: { command: "local-server" } },
  });

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
      "fromClaude", "fromClaudeLocal", "fromCodex", "fromLocalDamocles", "fromWorkspace",
      "hasBearerToken", "hasLifecycle", "plainRemote", "plainStdio",
    ]);
    // Every member of the union really is represented, or the assertions below prove nothing.
    expect(Object.values(SERVER_BY_SOURCE).every(name => servers.has(name))).toBe(true);
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

  it.each(["fromClaude", "fromClaudeLocal", "fromCodex", "fromWorkspace", "fromLocalDamocles"])(
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

  it("marks both new sources readonly with nothing for the form to pre-populate from", () => {
    // Neither file has a write path, so `readonly: true` and an absent `editableConfig` are what keep
    // Edit and Delete off those rows.
    for (const name of ["fromClaudeLocal", "fromLocalDamocles"]) {
      expect(servers.get(name)?.readonly).toBe(true);
      expect(servers.get(name)?.editableConfig).toBeUndefined();
    }
    expect(servers.get("fromClaudeLocal")?.source).toBe("claude-local");
    expect(servers.get("fromLocalDamocles")?.source).toBe("damocles-local");
  });
});

describe("McpManager: getShadowingServerNames", () => {
  /**
   * Recomputed from the precedence order rather than read off `SHADOWING_SOURCES`. The set and the
   * manager both consume that one export now, so comparing them to each other would be comparing a
   * value to itself; only the recomputation says the set follows the declared ordering.
   */
  function sourcesAboveDamocles(): McpServerSource[] {
    const order = mcpSourceOrder("claude");
    return [...order.slice(order.indexOf("damocles") + 1)];
  }

  it("derives the shared shadowing set from the precedence order", () => {
    const expected = sourcesAboveDamocles();

    expect(expected.length).toBe(2);
    expect([...SHADOWING_SOURCES].sort()).toEqual([...expected].sort());
  });

  it("returns the names of every source that outranks ~/.damocles/mcp.json, and nothing else", async () => {
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    const shadowing = manager.getShadowingServerNames();
    const expected = sourcesAboveDamocles();

    // The write path rejects these names, so if the manager and the shared set ever disagreed
    // Damocles would persist a server the merge immediately hides.
    expect(expected.length).toBe(2);
    expect([...shadowing.keys()].sort()).toEqual(expected.map(source => SERVER_BY_SOURCE[source]).sort());
    expect([...shadowing.entries()].sort()).toEqual(
      expected.map(source => [SERVER_BY_SOURCE[source], source] as const).sort(),
    );
  });

  it("returns the same names when assetSourcePrecedence flips, since the tie-break sits below damocles", async () => {
    // A hardcoded `['workspace','damocles-local']` would also pass the test above. Flipping the setting
    // reorders `mcpSourceOrder`'s bottom half, so only a derivation that actually reads the array
    // survives both runs, and only the derived one moves if a seventh source ever lands above
    // `damocles`.
    const original = vscode.workspace.getConfiguration;
    const withPrecedence = async (precedence: string): Promise<string[]> => {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = (section?: string) => ({
        get: (key: string, defaultValue?: unknown) =>
          section === "damocles" && key === "assetSourcePrecedence" ? precedence : defaultValue,
        update: () => Promise.resolve(),
      });
      const manager = new McpManager(workspaceState);
      await manager.loadConfig();
      return [...manager.getShadowingServerNames().keys()].sort();
    };

    try {
      const asClaude = await withPrecedence("claude");
      const asCodex = await withPrecedence("codex");
      expect(asCodex).toEqual(asClaude);
      expect(asClaude).toEqual(["fromLocalDamocles", "fromWorkspace"]);
    } finally {
      (vscode.workspace as { getConfiguration: unknown }).getConfiguration = original;
    }
  });

  it("leaves every overridable source out, since damocles outranks them", async () => {
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    const shadowing = manager.getShadowingServerNames();
    const order = mcpSourceOrder("claude");
    const overridable = order.slice(0, order.indexOf("damocles") + 1);

    for (const source of overridable) {
      expect(shadowing.has(SERVER_BY_SOURCE[source])).toBe(false);
    }
    // `claude-local` in particular: it is project-SCOPED, but still ranks below `damocles`, so
    // overriding it from the panel stays allowed.
    expect(overridable).toContain("claude-local");
  });
});
