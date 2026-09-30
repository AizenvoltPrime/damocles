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
const { tmpRoot, fakeHome, fakeWorkspace, fakeWorkspaceB } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-trust-grant-"));
  return {
    tmpRoot: root,
    fakeHome: nodePath.join(root, "home"),
    fakeWorkspace: nodePath.join(root, "home", "workspace"),
    fakeWorkspaceB: nodePath.join(root, "home", "workspace-b"),
  };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

/** Git reports the personal config as committable, so a check that RUNS produces a warning. */
const execMock = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => ({ stdout: "?? .damocles/mcp.local.json\n", stderr: "" })));
vi.mock("../../pi-session/checkpoints/exec", () => ({ exec: execMock }));

import { ChatPanelProvider } from "../index";
import { installLogSink } from "../../logger";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { folderKey } from "../../workspace-folders/folder-key";
import type { McpScope } from "../../session-types";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

type Posted = ExtensionToWebviewMessage;

let platform: FakePlatform;

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify(value, null, 2), "utf-8");
}

const KEY_A = folderKey(fakeWorkspace);
const KEY_B = folderKey(fakeWorkspaceB);

interface Harness {
  provider: ChatPanelProvider;
  /** What the folder A panel received. */
  posted: Posted[];
  fedToClient: McpScope[];
  /** What the folder B panel received. */
  postedB: Posted[];
  fedToClientB: McpScope[];
}

/**
 * A provider with one panel attached per folder. The panels are injected into the live map
 * `getPanels()` returns rather than opened, because a real webview is not what is under test here.
 */
async function harness(): Promise<Harness> {
  const provider = new ChatPanelProvider(platform, {
    subscriptions: [],
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const internals = provider as unknown as {
    settingsManager: { loadMcpConfig: () => Promise<void>; getLocalMcpUnignored?: () => boolean };
    panelManager: { getPanels: () => Map<string, unknown> };
  };

  const attach = (panelId: string, fsPath: string): { posted: Posted[]; fed: McpScope[] } => {
    const posted: Posted[] = [];
    const fed: McpScope[] = [];
    internals.panelManager.getPanels().set(panelId, {
      host: { postMessage: async (m: Posted) => { posted.push(m); return true; } },
      session: {
        setMcpServers: (scope: McpScope) => { fed.push(scope); },
        getMcpServerStatus: async () => [],
      },
      folder: { key: folderKey(fsPath), fsPath, name: path.basename(fsPath), label: path.basename(fsPath), projectScope: true },
      permissionHandler: {},
      ideContextManager: {},
      disposables: [],
    });
    return { posted, fed };
  };
  const panelA = attach("p1", fakeWorkspace);
  const panelB = attach("p2", fakeWorkspaceB);

  // The first load happens while the workspace is untrusted, which is what leaves the two sampled
  // properties stale.
  await internals.settingsManager.loadMcpConfig();
  for (const panel of [panelA, panelB]) {
    panel.posted.length = 0;
    panel.fed.length = 0;
  }
  execMock.mockClear();

  return { provider, posted: panelA.posted, fedToClient: panelA.fed, postedB: panelB.posted, fedToClientB: panelB.fed };
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
  writeJson(path.join(fakeWorkspaceB, ".mcp.json"), { mcpServers: { betaOnly: { command: "beta-only" } } });
});

beforeEach(() => {
  platform = installFakePlatform({
    trusted: false,
    folders: [{ fsPath: fakeWorkspace, name: "workspace" }, { fsPath: fakeWorkspaceB, name: "workspace-b" }],
  });
  execMock.mockClear();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("granting trust to an open workspace", () => {
  it("broadcasts the leak warning sampled AFTER the reload, not the stale one", async () => {
    // An untrusted load skips the git check entirely, so the flag starts false for a file that is in
    // fact committable. Broadcasting before the reload would send that false to the panel and leave
    // the user unwarned about their own credential file until some unrelated config edit.
    const { posted, postedB } = await harness();
    expect(execMock).not.toHaveBeenCalled();

    platform.trust.grantTrust();
    await vi.waitFor(() => expect(configUpdates(posted).length).toBeGreaterThan(0));

    // Only A has a personal config, so only A's directory is asked, and only A's panels are warned.
    expect(execMock).toHaveBeenCalledTimes(1);
    expect(configUpdates(posted)[0]!.localMcpUnignored).toBe(true);
    await vi.waitFor(() => expect(configUpdates(postedB).length).toBeGreaterThan(0));
    expect(configUpdates(postedB)[0]!.localMcpUnignored).toBe(false);
  });

  it("re-feeds the live client with the repo definition that now outranks the user-global one", async () => {
    // Untrusted folds repo-authored sources lowest, so `github` resolved to the user's copy. After
    // the grant the repo's copy wins, and the client has to be told.
    const { fedToClient } = await harness();

    platform.trust.grantTrust();
    await vi.waitFor(() => expect(fedToClient.length).toBeGreaterThan(0));

    expect(fedToClient[0]!.folder["github"]).toEqual({ command: "repo-github" });
    expect(fedToClient[0]!.folder["repoOnly"]).toEqual({ command: "repo-only" });
    // The repo's `github` now shadows the user one in this folder only.
    expect(fedToClient[0]!.userVisible).not.toContain("github");
  });

  it("re-feeds each panel its own folder's scope and list, never another folder's", async () => {
    const { posted, fedToClient, postedB, fedToClientB } = await harness();

    platform.trust.grantTrust();
    await vi.waitFor(() => expect(fedToClientB.length).toBeGreaterThan(0));

    expect(Object.keys(fedToClient[0]!.folder).sort()).toEqual(["github", "repoOnly"]);
    expect(Object.keys(fedToClientB[0]!.folder)).toEqual(["betaOnly"]);
    // B defines no `github`, so the user one stays visible there and is shared through the union.
    expect(fedToClientB[0]!.userVisible).toEqual(["github"]);
    expect(fedToClientB[0]!.userUnion["github"]).toEqual({ command: "user-github" });

    const namesIn = (messages: Posted[]) => configUpdates(messages)[0]!.servers.map(server => server.name).sort();
    expect(namesIn(posted)).toEqual(["github", "repoOnly"]);
    expect(namesIn(postedB)).toEqual(["betaOnly", "github"]);
  });

  it("withholds the repo servers before the grant, so the test above is not vacuous", async () => {
    const { provider } = await harness();
    const settings = provider as unknown as { settingsManager: { getEnabledMcpServers: (key: string) => McpScope } };
    const scope = settings.settingsManager.getEnabledMcpServers(KEY_A);

    expect(scope.userVisible).toContain("github");
    expect(scope.userUnion["github"]).toEqual({ command: "user-github" });
    expect(scope.folder).toEqual({});
    expect(settings.settingsManager.getEnabledMcpServers(KEY_B).folder).toEqual({});
  });
});

describe("provider notices and listeners", () => {
  it("logs a reload that fails after a trust grant instead of leaving the rejection unhandled", async () => {
    const { provider } = await harness();
    const logged: string[] = [];
    installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    const internals = provider as unknown as { settingsManager: { loadMcpConfig: () => Promise<void> } };
    vi.spyOn(internals.settingsManager, "loadMcpConfig").mockRejectedValue(new Error("mcp.json unreadable"));

    platform.trust.grantTrust();

    await vi.waitFor(() => expect(logged.join("\n")).toContain("MCP reload after a trust grant failed"));
  });

  it("localizes the warning for an element picked with no chat panel open", async () => {
    const { provider } = await harness();
    const internals = provider as unknown as {
      panelManager: { getPanels: () => Map<string, unknown> };
      browserService: { broadcastToChat: (element: unknown) => void };
    };
    internals.panelManager.getPanels().clear();
    vi.spyOn(platform.localization, "t").mockImplementation((message: string) => `[el] ${message}`);

    internals.browserService.broadcastToChat({ selector: "#a" });

    expect(platform.notifications.calls.map((c) => c.message)).toEqual([
      "[el] Damocles: No chat panel is open. Open one to receive picked elements.",
    ]);
    vi.restoreAllMocks();
  });
});
