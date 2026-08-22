import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";

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

/** `loadConfig()` asks git whether `mcp.local.json` is ignored; faked so no suite spawns a process. */
const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => { throw new Error("fatal: not a git repository"); }));
vi.mock("../../../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

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
  vscode.__setTrusted(trusted);
}

beforeAll(() => {
  // Every source defines `github`. The user's own is the trusted one.
  writeJson(path.join(fakeHome, ".damocles", "mcp.json"), {
    mcpServers: { github: { command: "my-github" }, mine: { command: "mine" } },
  });
  writeJson(path.join(fakeWorkspace, ".mcp.json"), {
    mcpServers: {
      github: { command: "repo-github" },
      repoOnly: { command: "repo-only" },
      bothRepoFiles: { command: "from-mcp-json" },
    },
  });
  // The repo-authored personal file. Gitignored in real use, but the working tree is still where it
  // lives, so a cloned repo could ship one and the trust gate must cover it.
  writeJson(path.join(fakeWorkspace, ".damocles", "mcp.local.json"), {
    mcpServers: {
      github: { command: "local-github" },
      localOnly: { command: "local-only" },
      bothRepoFiles: { command: "from-mcp-local-json" },
    },
  });
  // Claude Code's two scopes. Neither is repo-authored: a clone cannot write `~/.claude.json`.
  writeJson(path.join(fakeHome, ".claude.json"), {
    mcpServers: { github: { command: "claude-user-github" }, claudeBoth: { command: "claude-user" } },
    projects: {
      [fakeWorkspace]: {
        mcpServers: {
          github: { command: "claude-local-github" },
          claudeLocalOnly: { command: "claude-local-only" },
          claudeBoth: { command: "claude-local" },
        },
      },
    },
  });
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: fakeWorkspace } }];
});

afterEach(() => setTrusted(true));

afterAll(() => {
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [];
  setTrusted(true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function loadedManager(trusted: boolean): Promise<McpManager> {
  setTrusted(trusted);
  const manager = new McpManager(workspaceState);
  await manager.loadConfig();
  return manager;
}

describe("McpManager — workspace precedence under trust", () => {
  it("lets a TRUSTED workspace tree outrank a user-global server, personal file highest", async () => {
    const manager = await loadedManager(true);

    expect(manager.getEnabledServers()["github"]).toEqual({ command: "local-github" });
    expect(manager.getServersForUI().find(s => s.name === "github")?.source).toBe("damocles-local");
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

describe("McpManager: the two new sources under trust", () => {
  it.each(["repoOnly", "localOnly"])(
    "withholds %s in an untrusted workspace and tags the row, since a clone could have authored it",
    async (name) => {
      const manager = await loadedManager(false);

      expect(manager.getEnabledServers()).not.toHaveProperty(name);
      expect(manager.getServersForUI().find(s => s.name === name)?.untrusted).toBe(true);
    },
  );

  it("connects both repo-authored sources once the workspace IS trusted", async () => {
    const manager = await loadedManager(true);

    expect(manager.getEnabledServers()["repoOnly"]).toEqual({ command: "repo-only" });
    expect(manager.getEnabledServers()["localOnly"]).toEqual({ command: "local-only" });
    expect(manager.getServersForUI().find(s => s.name === "localOnly")?.untrusted).toBeUndefined();
  });

  it("keeps a Claude local-scope server connected in an untrusted workspace", async () => {
    // `claude-local` is project-SCOPED but lives in `~/.claude.json`, which a repository you cloned
    // cannot write. Trust-gating it would withhold a server the user configured themselves because of
    // a repo that had no hand in it. Scope and repo-authorship are not the same question.
    const manager = await loadedManager(false);

    expect(manager.getEnabledServers()["claudeLocalOnly"]).toEqual({ command: "claude-local-only" });
    const row = manager.getServersForUI().find(s => s.name === "claudeLocalOnly");
    expect(row?.source).toBe("claude-local");
    expect(row?.untrusted).toBeUndefined();
  });

  it("keeps claude-local at its ranked position whether or not the workspace is trusted", async () => {
    // Above `claude` (Claude Code's own local > user ordering) and below `damocles`, in both states.
    for (const trusted of [true, false]) {
      const manager = await loadedManager(trusted);
      expect(manager.getEnabledServers()["claudeBoth"]).toEqual({ command: "claude-local" });
    }
  });

  it("folds the repo-authored sources lowest when untrusted, preserving their relative order", async () => {
    // Untrusted moves `workspace` and `damocles-local` to the front of the fold as a pair. If their
    // order flipped on the way down, `.mcp.json` would start beating the personal file that outranks
    // it everywhere else, so a name defined only by those two pins the pair's internal order.
    const untrusted = await loadedManager(false);
    expect(untrusted.getServersForUI().find(s => s.name === "bothRepoFiles")?.source).toBe("damocles-local");

    const trusted = await loadedManager(true);
    expect(trusted.getEnabledServers()["bothRepoFiles"]).toEqual({ command: "from-mcp-local-json" });
  });

  it("hands the user's own github back when neither repo file may override it", async () => {
    // Folded lowest, both repo files lose to `~/.damocles/mcp.json`; folded highest they would
    // overwrite it and then be withheld, silently taking the user's server down with them.
    const manager = await loadedManager(false);

    expect(manager.getEnabledServers()["github"]).toEqual({ command: "my-github" });
    expect(manager.getServersForUI().find(s => s.name === "github")?.untrusted).toBeUndefined();
  });
});

describe("McpManager: getShadowingServerNames under trust", () => {
  /** The names the write path would refuse, because a source above `~/.damocles/mcp.json` holds them. */
  const shadowed = (manager: McpManager): string[] => [...manager.getShadowingServerNames().keys()].sort();

  it("reports the repo files as shadowing while the workspace is trusted", async () => {
    const manager = await loadedManager(true);

    expect(shadowed(manager)).toEqual(["bothRepoFiles", "github", "localOnly", "repoOnly"]);
  });

  it("reports nothing from the repo files while the workspace is untrusted", async () => {
    // Untrusted folds them below `~/.damocles/mcp.json`, so they no longer take precedence. Claiming
    // otherwise refuses a valid write with a reason that is not true.
    const manager = await loadedManager(false);

    expect(shadowed(manager)).toEqual([]);
  });

  it("lets the user write a name the untrusted repo also defines", async () => {
    // The concrete cost: without this, adding your own `repoOnly` is rejected as already defined by
    // `.mcp.json`, a file whose servers are being withheld anyway.
    const manager = await loadedManager(false);

    expect(manager.getShadowingServerNames().has("repoOnly")).toBe(false);
    expect(manager.getShadowingServerNames().has("localOnly")).toBe(false);
  });
});

describe("McpManager: the gitignore leak check and workspace trust", () => {
  it("spawns nothing in an untrusted workspace, rather than running git and dropping the answer", async () => {
    // `git status` runs the repository's own `.git/config`, and `core.fsmonitor` in it is a command
    // git executes, so an archive can get code run by being opened. Discarding the result afterwards
    // would be too late: the process has already started.
    execMock.mockClear();

    const manager = await loadedManager(false);

    expect(execMock).not.toHaveBeenCalled();
    expect(manager.getLocalMcpUnignored()).toBe(false);
  });

  it("does ask git once the workspace is trusted, in the workspace's own directory", async () => {
    // Pins the skip to trust alone. A guard that never asked would pass the test above too.
    execMock.mockClear();

    await loadedManager(true);

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(execMock.mock.calls[0]![0]).toBe("git");
    expect(execMock.mock.calls[0]![3]).toBe(fakeWorkspace);
  });
});

describe("McpManager: state sampled at load time does not recover on a bare trust grant", () => {
  /** Git reports the personal config as committable, so a check that RUNS raises the warning. */
  beforeEach(() => {
    execMock.mockClear();
    execMock.mockImplementation(async () => ({ stdout: "?? .damocles/mcp.local.json\n", stderr: "" }) as never);
  });

  afterEach(() => {
    execMock.mockImplementation(async () => { throw new Error("fatal: not a git repository"); });
  });

  it("leaves both sampled properties stale until something reloads", async () => {
    // `localMcpUnignored` and the shadowing set are decided during `loadConfig`, unlike the trust
    // filter on `getEnabledServers`, which reads `isTrusted` live. Flipping the flag alone therefore
    // fixes the server list and nothing else, which is what makes a reload mandatory on the grant.
    const manager = await loadedManager(false);
    expect(execMock).not.toHaveBeenCalled();
    expect(manager.getLocalMcpUnignored()).toBe(false);
    expect([...manager.getShadowingServerNames().keys()]).toEqual([]);

    setTrusted(true);

    // Nothing re-read anything, so both are still wrong.
    expect(manager.getLocalMcpUnignored()).toBe(false);
    expect([...manager.getShadowingServerNames().keys()]).toEqual([]);

    await manager.loadConfig();

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(manager.getLocalMcpUnignored()).toBe(true);
    expect(manager.getShadowingServerNames().get("repoOnly")).toBe("workspace");
  });

  it("keeps all three properties consistent across concurrent loads", async () => {
    // A half-applied snapshot would pair a trusted server list with an untrusted shadowing set, and
    // the write path would then refuse a name for a precedence the merge did not grant.
    setTrusted(true);
    const manager = new McpManager(workspaceState);

    await Promise.all([manager.loadConfig(), manager.loadConfig(), manager.loadConfig()]);

    expect(manager.getConfigLoaded()).toBe(true);
    expect(manager.getLocalMcpUnignored()).toBe(true);
    expect(manager.getShadowingServerNames().get("repoOnly")).toBe("workspace");
    expect(manager.getEnabledServers()["repoOnly"]).toEqual({ command: "repo-only" });
    expect(execMock).toHaveBeenCalledTimes(3);
  });

  it("does not let a slow untrusted load un-warn the panel after a trusted one", async () => {
    // The grant handler reloads while a watcher-driven load may already be in flight. Without the
    // generation stamp the older untrusted result lands last and takes the warning back down.
    const manager = new McpManager(workspaceState);

    setTrusted(false);
    const untrusted = manager.loadConfig();
    setTrusted(true);
    const trusted = manager.loadConfig();
    await Promise.all([untrusted, trusted]);

    expect(manager.getLocalMcpUnignored()).toBe(true);
    expect(manager.getShadowingServerNames().get("repoOnly")).toBe("workspace");
    expect(manager.getEnabledServers()["repoOnly"]).toEqual({ command: "repo-only" });
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

    expect(Object.keys(manager.getEnabledServers()).sort()).toEqual([
      "bothRepoFiles", "claudeBoth", "claudeLocalOnly", "github", "localOnly", "mine", "repoOnly",
    ]);
    expect(manager.getConfigLoaded()).toBe(true);
  });

  it("hands out a copy of the config errors rather than its own array", async () => {
    const manager = new McpManager(workspaceState);
    await manager.loadConfig();

    const errors = manager.getConfigErrors();
    errors.push({ path: "injected", displayPath: "injected", kind: "parse", line: null, column: null });

    expect(manager.getConfigErrors()).toHaveLength(0);
  });
});
