import * as fs from "fs";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";

const { tmpRoot, fakeHome, fakeWorkspace } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const nodeFs = require("fs") as typeof import("fs");
  const nodeOs = require("os") as typeof import("os");
  const nodePath = require("path") as typeof import("path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "dam-memory-judge-"));
  return { tmpRoot: root, fakeHome: nodePath.join(root, "home"), fakeWorkspace: nodePath.join(root, "home", "workspace") };
});

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("os")>();
  return { ...actual, homedir: () => fakeHome };
});

import { ChatPanelProvider } from "../index";
import { installLogSink } from "../../logger";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import { PiRuntime } from "../../pi-session/pi-runtime";
import { CUSTOM_PROVIDER_DEFS, KEYED_PROVIDER_DEFS } from "../../pi-session/custom-providers";
import { republishAccountInfo } from "../message-router/handlers/account-info";
import { folderKey } from "../../workspace-folders/folder-key";
import { PI_AGENT_DIR } from "../../pi-session/agent-dir";
import { createFakeRemoteHost } from "../../../__mocks__/fake-remote-host";
import * as path from "path";
import type { Disposable } from "../../../platform/disposable";
import type { ExtensionToWebviewMessage } from "../../../shared/types/messages";

type Posted = ExtensionToWebviewMessage;

let platform: FakePlatform;
let subscriptions: Disposable[];

function addPanel(panels: Map<string, unknown>, id: string): Posted[] {
  const posted: Posted[] = [];
  panels.set(id, {
    host: { postMessage: async (m: Posted) => { posted.push(m); return true; } },
    session: { publishAccountInfo: vi.fn(), publishAvailableModels: vi.fn(), getToolStatus: () => ({ panel: id }) },
    folder: { key: folderKey(fakeWorkspace), fsPath: fakeWorkspace, name: "workspace", label: "workspace", projectScope: true },
    permissionHandler: {},
    ideContextManager: {},
    disposables: [],
  });
  return posted;
}

function harness(): { posted: Posted[]; panels: Map<string, unknown> } {
  const provider = new ChatPanelProvider(platform, {
    subscriptions,
    createCompassViews: () => ({ register: () => {}, setActive: () => {}, dispose: () => {} }),
  });
  const panels = (provider as unknown as { panelManager: { getPanels: () => Map<string, unknown> } }).panelManager.getPanels();
  return { posted: addPanel(panels, "p1"), panels };
}

const judgeUpdates = (posted: Posted[]) =>
  posted.filter((m): m is Extract<Posted, { type: "memoryJudgeStatus" }> => m.type === "memoryJudgeStatus");
const keyStatuses = (posted: Posted[]) =>
  posted.filter((m): m is Extract<Posted, { type: "providerAuthStatusChanged" }> => m.type === "providerAuthStatusChanged");

beforeEach(() => {
  for (const name of ["TYPESAFE_API_KEY", "OPENROUTER_API_KEY", "OPENAI_API_KEY"]) vi.stubEnv(name, "");
  fs.mkdirSync(fakeWorkspace, { recursive: true });
  platform = installFakePlatform({ folders: [{ fsPath: fakeWorkspace, name: "workspace" }] });
  subscriptions = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const subscription of subscriptions) subscription.dispose();
  await PiRuntime.disposeInstance();
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("memory judge status in open panels", () => {
  it("subscribes without creating the pi runtime", () => {
    harness();
    expect(PiRuntime.exists).toBe(false);
  });

  it("rebroadcasts when a judge input changes, before pi starts saying the sub-call model is not known yet", async () => {
    const { posted } = harness();
    PiRuntime.notifyMemoryJudgeChange();
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
    expect(judgeUpdates(posted)[0]).toEqual({
      type: "memoryJudgeStatus",
      memoryJudge: { kind: "unknown" },
      classifierCredentials: { typesafe: "no-key", openrouter: "no-key", openai: "no-key" },
    });
  });

  it("rebroadcasts when a classifier key is stored, here or in another window", async () => {
    const { posted } = harness();
    await platform.secrets.store("damocles.openai.apiKey", "sk-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "classifier", via: "openai" }));
    await platform.secrets.store("damocles.explore.apiKey.openrouter", "or-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "classifier", via: "openrouter" }));
    await platform.secrets.store("damocles.typesafe.apiKey", "ts-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)).toMatchObject({ memoryJudge: { kind: "classifier", via: "typesafe" } }));
  });

  it("rebroadcasts when the Memory judge setting changes, before pi starts", async () => {
    const { posted } = harness();
    await platform.settings.update("damocles.memory.judge", "jev-typesafe", "user");
    await vi.waitFor(() =>
      expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "none", forced: { choice: "jev-typesafe", reason: "no-key" } }),
    );
  });

  it("rebroadcasts the judge and the Anthropic row when auth.json changes before pi starts", async () => {
    const { posted } = harness();
    await platform.secrets.store("damocles.openai.apiKey", "sk-key");
    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.memoryJudge).toEqual({ kind: "classifier", via: "openai" }));

    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(path.join(PI_AGENT_DIR, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: 9_999_999_999_999 } }));
    platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(path.join(PI_AGENT_DIR, "auth.json"));

    await vi.waitFor(() => expect(judgeUpdates(posted).at(-1)?.classifierCredentials.openai).toBe("chatgpt-active"));
    expect(posted.some((m) => m.type === "claudeAuthStatusChanged")).toBe(true);
    expect(PiRuntime.exists).toBe(false);
    fs.rmSync(path.join(PI_AGENT_DIR, "auth.json"), { force: true });
  });

  it("rebroadcasts when a Claude or OpenAI credential change republishes the account", async () => {
    const { posted, panels } = harness();
    republishAccountInfo(() => panels as never);
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
  });

  it("logs a status read that fails instead of leaving the rejection unhandled", async () => {
    const { posted } = harness();
    const logged: string[] = [];
    installLogSink({ appendLine: (line) => void logged.push(line), show: () => undefined, dispose: () => undefined });
    vi.spyOn(platform.secrets, "get").mockRejectedValue(new Error("keyring locked"));

    PiRuntime.notifyMemoryJudgeChange();

    await vi.waitFor(() => expect(logged.join("\n")).toContain("reading the memory judge status failed: the secret store did not answer for"));
    expect(judgeUpdates(posted)).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

describe("key provider status in open panels", () => {
  it.each(KEYED_PROVIDER_DEFS)("broadcasts $provider's status when its secret is stored or deleted, here or in another window", async ({ provider, key: { secretKey } }) => {
    const { posted } = harness();
    await platform.secrets.store(secretKey, "the-key");
    const signedOut = { type: "providerAuthStatusChanged", provider, external: null, signedIn: false, preferApiKey: false };
    await vi.waitFor(() => expect(keyStatuses(posted)).toEqual([{ ...signedOut, configured: true, active: "apiKey" }]));
    await platform.secrets.delete(secretKey);
    await vi.waitFor(() => expect(keyStatuses(posted).at(-1)).toEqual({ ...signedOut, configured: false, active: "none" }));
    expect(keyStatuses(posted)).toHaveLength(2);
    expect(JSON.stringify(posted)).not.toContain("the-key");
  });

  it("broadcasts nothing for an unrelated secret", async () => {
    const { posted } = harness();
    await platform.secrets.store("damocles.openai.apiKey", "sk-key");
    await vi.waitFor(() => expect(judgeUpdates(posted)).toHaveLength(1));
    expect(keyStatuses(posted)).toEqual([]);
  });

  it("refreshes image generation and the Tools status in every panel after a key sync", async () => {
    const { posted, panels } = harness();
    const second = addPanel(panels, "p2");
    const runtime = PiRuntime.get();
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      hasConfiguredAuth: () => false,
      getModelsOfType: () => [],
    };

    await runtime.syncCustomProviders(() => Promise.resolve(undefined));

    for (const [id, messages] of [["p1", posted], ["p2", second]] as const) {
      expect(messages).toContainEqual({ type: "toolStatus", data: { panel: id } });
      expect(messages).toContainEqual(expect.objectContaining({ type: "imageGenerationSettings", settings: expect.objectContaining({ openRouterConfigured: false }) }));
    }
  });

  /** A model runtime that keeps the runtime keys applied to it and reports them first, as pi's does (model-runtime.js:424-450). */
  function keyedModelRuntime(environment: ReadonlySet<string> = new Set()) {
    const runtimeKeys = new Map<string, string>();
    return {
      getProviderAuthStatus: (provider: string) =>
        runtimeKeys.has(provider) ? { configured: true, source: "runtime" } : environment.has(provider) ? { configured: true, source: "environment" } : { configured: false },
      hasConfiguredAuth: (provider: string) => runtimeKeys.has(provider) || environment.has(provider),
      getModelsOfType: () => [],
      setRuntimeApiKey: async (provider: string, key: string) => void runtimeKeys.set(provider, key),
      removeRuntimeApiKey: async (provider: string) => void runtimeKeys.delete(provider),
      logout: async () => {},
      registerProvider: () => {},
      unregisterProvider: () => {},
    };
  }

  it("broadcasts every key status after a sync, marking a credential pi holds that Damocles did not apply", async () => {
    const { posted } = harness();
    const runtime = PiRuntime.get();
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = keyedModelRuntime(new Set(["minimax", "xai"]));
    await platform.secrets.store("damocles.xai.apiKey", "xai-key");
    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(1));
    posted.length = 0;

    await runtime.syncCustomProviders((key) => platform.secrets.get(key));

    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    const byProvider = new Map(keyStatuses(posted).map((status) => [status.provider, status]));
    const signedOut = { type: "providerAuthStatusChanged", signedIn: false, preferApiKey: false };
    expect(byProvider.get("minimax")).toEqual({ ...signedOut, provider: "minimax", configured: false, external: 'environment', active: "external" });
    expect(byProvider.get("xai")).toEqual({ ...signedOut, provider: "xai", configured: true, external: null, active: "apiKey" });
    expect(byProvider.get("deepseek")).toEqual({ ...signedOut, provider: "deepseek", configured: false, external: null, active: "none" });
  });

  it("republishes the account state in every panel, one whose session has not started included, when a sync changes it", async () => {
    const { panels } = harness();
    addPanel(panels, "p2");
    const publishes = () => [...panels.values()].map((panel) => (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo.mock.calls.length);
    const runtime = PiRuntime.get();
    (runtime as unknown as { _modelRuntime: unknown })._modelRuntime = keyedModelRuntime();
    const secrets = (key: string) => Promise.resolve(key === "damocles.minimax.apiKey" ? "sk-cp-plan" : undefined);

    await runtime.syncCustomProviders(secrets);
    expect(publishes()).toEqual([1, 1]);

    await runtime.syncCustomProviders(secrets);
    expect(publishes()).toEqual([1, 1]);
  });
});

describe("account state in panels that have not started", () => {
  const publishes = (panels: Map<string, unknown>) =>
    [...panels.values()].map((panel) => (panel as { session: { publishAccountInfo: ReturnType<typeof vi.fn> } }).session.publishAccountInfo.mock.calls.length);
  const authPath = path.join(PI_AGENT_DIR, "auth.json");
  afterEach(() => {
    fs.rmSync(authPath, { force: true });
  });

  it("follows a sign-in made outside Damocles before pi starts: every account-provider status and every panel's account state", async () => {
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 9_000 } }));
    platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(authPath);

    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    expect(keyStatuses(posted).find((status) => status.provider === "github-copilot")).toMatchObject({ signedIn: true, signedInExpiresAt: 9_000, active: "signIn" });
    expect(publishes(panels)).toEqual([1, 1]);
    expect(PiRuntime.exists).toBe(false);
  });

  it("follows a sign-in made outside Damocles once the runtime holds the watch, though the key sync changed nothing", async () => {
    const { posted, panels } = harness();
    addPanel(panels, "p2");
    const runtime = PiRuntime.get();
    const internals = runtime as unknown as { _modelRuntime: unknown; _initPromise: Promise<void>; _customProvidersSynced: boolean; _authWatch: Disposable | null };
    internals._initPromise = Promise.resolve();
    // past its first sync, which republishes every panel on its own
    internals._customProvidersSynced = true;
    internals._modelRuntime = {
      getProviderAuthStatus: () => ({ configured: false }),
      hasConfiguredAuth: () => false,
      getModelsOfType: () => [],
      getAvailable: async () => [],
    };
    internals._authWatch = (PiRuntime as unknown as { _holdAuthFileWatch: (factory: unknown, dir: string) => Disposable })._holdAuthFileWatch(platform.fileWatchers, PI_AGENT_DIR);
    fs.mkdirSync(PI_AGENT_DIR, { recursive: true });
    fs.writeFileSync(authPath, JSON.stringify({ "github-copilot": { type: "oauth", access: "a", refresh: "r", expires: 9_000 } }));
    platform.fileWatchers.watcher(PI_AGENT_DIR, "auth.json").fireChange(authPath);

    await vi.waitFor(() => expect(publishes(panels)).toEqual([1, 1]));
    await vi.waitFor(() => expect(keyStatuses(posted).find((status) => status.provider === "github-copilot")).toMatchObject({ signedIn: true }));
  });

  it("follows a new acting client on a daemon's core, whose credentials and prefer flags the panels read", async () => {
    const host = createFakeRemoteHost();
    Object.assign(platform, { remote: host.remote });
    host.set("clientAuth", "client-a", { providers: {} });
    host.set("clientAuth", "client-b", { providers: { xai: { type: "oauth", hasKey: false, keySaved: true, flatFee: false, expires: 5_000 } } });
    const { posted, panels } = harness();
    addPanel(panels, "p2");

    host.setActing("client-b");

    expect(publishes(panels)).toEqual([1, 1]);
    await vi.waitFor(() => expect(keyStatuses(posted)).toHaveLength(CUSTOM_PROVIDER_DEFS.length));
    expect(keyStatuses(posted).find((status) => status.provider === "xai")).toEqual({
      type: "providerAuthStatusChanged", provider: "xai", configured: true, external: null, signedIn: true, signedInExpiresAt: 5_000, preferApiKey: false,
    });
  });

  // A sign-in on the client changes no key the daemon applies, so the key sync alone would not republish unstarted panels.
  it("follows the acting client's sign-in on a daemon's core, before pi starts", async () => {
    const host = createFakeRemoteHost();
    Object.assign(platform, { remote: host.remote });
    host.set("clientAuth", "client-a", { providers: {} });
    host.setActing("client-a");
    const { posted, panels } = harness();
    addPanel(panels, "p2");

    host.set("clientAuth", "client-a", { providers: { "github-copilot": { type: "oauth", hasKey: false, flatFee: false, expires: 7_000 } } });

    expect(publishes(panels)).toEqual([1, 1]);
    await vi.waitFor(() => expect(keyStatuses(posted).find((status) => status.provider === "github-copilot")).toMatchObject({ signedIn: true, signedInExpiresAt: 7_000 }));
    expect(PiRuntime.exists).toBe(false);
  });
});
