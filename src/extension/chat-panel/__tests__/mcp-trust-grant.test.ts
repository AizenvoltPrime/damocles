import * as fs from "fs";
import * as path from "path";
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * What reaches the webview when the user grants trust to an already-open workspace.
 *
 * Two MCP properties are sampled once per `loadMcpConfig()` rather than read live: whether git
 * ignores the personal config, and which sources outrank `~/.damocles/mcp.json` in the fold that
 * actually ran. Neither recovers on its own when trust arrives, so the grant handler has to reload
 * BEFORE it broadcasts. Asserting the reload happened is not enough, because a handler that
 * broadcasts first and reloads afterwards also ends up with correct state a moment later. The
 * assertion here is on the payload the panel receives.
 */
const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-trust-grant-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

/** Git reports the personal config as committable, so a check that RUNS produces a warning. */
const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ stdout: "?? .damocles/mcp.local.json\n", stderr: "" })));
vi.mock("../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import * as vscode from "vscode";
import { ChatPanelProvider } from "../index";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

type Posted = ExtensionToWebviewMessage;

// `__trustEmitter` exists only on the test double, so it is read off the namespace rather than
// imported by name, which `@types/vscode` would reject.
const trustEmitter = (vscode as unknown as {
  __trustEmitter: { fire: () => void; clear: () => void };
}).__trustEmitter;

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

function setTrusted(trusted: boolean): void {
  vscode.__setTrusted(trusted);
}

/** The two APIs `ChatPanelProvider`'s constructor reaches for that the shared mock does not define. */
function stubConstructorDependencies(): void {
  (vscode.workspace as unknown as Record<string, unknown>)["registerTextDocumentContentProvider"] = () => ({ dispose: () => {} });
  const win = vscode.window as unknown as Record<string, unknown>;
  if (!win["tabGroups"]) win["tabGroups"] = { onDidChangeTabs: () => ({ dispose: () => {} }), all: [] };
}

interface Harness {
  provider: ChatPanelProvider;
  posted: Posted[];
  fedToClient: Record<string, unknown>[];
}

/**
 * A provider with one panel attached. The panel is injected into the live map `getPanels()` returns
 * rather than opened, because a real webview is not what is under test here.
 */
async function harness(): Promise<Harness> {
  const context = {
    subscriptions: [],
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {}, onDidChange: () => ({ dispose: () => {} }) },
    workspaceState: { get: <T>(_k: string, d?: T) => d as T, update: async () => {}, keys: () => [] },
    globalState: { get: <T>(_k: string, d?: T) => d as T, update: async () => {}, keys: () => [], setKeysForSync: () => {} },
    extensionUri: vscode.Uri.file(tmpRoot),
    extensionPath: tmpRoot,
    globalStorageUri: vscode.Uri.file(path.join(tmpRoot, "gs")),
    storageUri: vscode.Uri.file(path.join(tmpRoot, "s")),
    logUri: vscode.Uri.file(path.join(tmpRoot, "l")),
  } as unknown as vscode.ExtensionContext;

  const provider = new ChatPanelProvider(vscode.Uri.file(tmpRoot), context);
  const internals = provider as unknown as {
    settingsManager: { loadMcpConfig: () => Promise<void>; getLocalMcpUnignored?: () => boolean };
    panelManager: { getPanels: () => Map<string, unknown> };
  };

  const posted: Posted[] = [];
  const fedToClient: Record<string, unknown>[] = [];
  internals.panelManager.getPanels().set("p1", {
    host: { webview: { postMessage: (m: Posted) => { posted.push(m); } } },
    session: { setMcpServers: (servers: Record<string, unknown>) => { fedToClient.push(servers); } },
    permissionHandler: {},
    ideContextManager: {},
    disposables: [],
  });

  // The first load happens while the workspace is untrusted, which is what leaves the two sampled
  // properties stale.
  await internals.settingsManager.loadMcpConfig();
  posted.length = 0;
  fedToClient.length = 0;
  execMock.mockClear();

  return { provider, posted, fedToClient };
}

const configUpdates = (posted: Posted[]): Extract<Posted, { type: "mcpConfigUpdate" }>[] =>
  posted.filter((m): m is Extract<Posted, { type: "mcpConfigUpdate" }> => m.type === "mcpConfigUpdate");

beforeAll(() => {
  // `github` is defined by both the user-global file and the repo, so the fold decides which wins.
  writeJson(path.join(fakeHome, ".damocles", "mcp.json"), {
    mcpServers: { github: { command: "user-github" } },
  });
  writeJson(path.join(fakeWorkspace, ".mcp.json"), {
    mcpServers: { github: { command: "repo-github" }, repoOnly: { command: "repo-only" } },
  });
  writeJson(path.join(fakeWorkspace, ".damocles", "mcp.local.json"), { mcpServers: {} });
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: fakeWorkspace } }];
  stubConstructorDependencies();
});

beforeEach(() => {
  trustEmitter.clear();
  setTrusted(false);
  execMock.mockClear();
});

afterAll(() => {
  trustEmitter.clear();
  (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [];
  setTrusted(true);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("granting trust to an open workspace", () => {
  it("broadcasts the leak warning sampled AFTER the reload, not the stale one", async () => {
    // An untrusted load skips the git check entirely, so the flag starts false for a file that is in
    // fact committable. Broadcasting before the reload would send that false to the panel and leave
    // the user unwarned about their own credential file until some unrelated config edit.
    const { posted } = await harness();
    expect(execMock).not.toHaveBeenCalled();

    setTrusted(true);
    trustEmitter.fire();
    await vi.waitFor(() => expect(configUpdates(posted).length).toBeGreaterThan(0));

    expect(execMock).toHaveBeenCalledTimes(1);
    expect(configUpdates(posted)[0]!.localMcpUnignored).toBe(true);
  });

  it("re-feeds the live client with the repo definition that now outranks the user-global one", async () => {
    // Untrusted folds repo-authored sources lowest, so `github` resolved to the user's copy. After
    // the grant the repo's copy wins, and the client has to be told.
    const { fedToClient } = await harness();

    setTrusted(true);
    trustEmitter.fire();
    await vi.waitFor(() => expect(fedToClient.length).toBeGreaterThan(0));

    expect(fedToClient[0]!["github"]).toEqual({ command: "repo-github" });
    expect(fedToClient[0]!["repoOnly"]).toEqual({ command: "repo-only" });
  });

  it("withholds the repo servers before the grant, so the test above is not vacuous", async () => {
    const { provider } = await harness();
    const settings = provider as unknown as { settingsManager: { getEnabledMcpServers: () => Record<string, unknown> } };

    expect(settings.settingsManager.getEnabledMcpServers()["github"]).toEqual({ command: "user-github" });
    expect(settings.settingsManager.getEnabledMcpServers()).not.toHaveProperty("repoOnly");
  });
});
