import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const H = vi.hoisted(() => {
  const fakePi = {
    createAgentSessionServices: vi.fn(),
    DefaultPackageManager: class {
      getInstalledPath(): string | undefined {
        return undefined;
      }
    },
  };
  return { fakePi, ctrl: { loadable: true } };
});

vi.mock("../../../../pi-session/pi-loader", () => ({
  initPiLoader: vi.fn(async () => (H.ctrl.loadable ? H.fakePi : null)),
  getPiCodingAgent: vi.fn(() => (H.ctrl.loadable ? H.fakePi : null)),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));

vi.mock("../../../../pi-session/agent-dir", () => ({
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: "/fake/agent",
}));

vi.mock("vscode", () => {
  const watcher = () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  });
  return {
    env: { openExternal: vi.fn(() => Promise.resolve(true)) },
    Uri: { parse: (str: string) => ({ toString: () => str }) },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
      showInputBox: vi.fn(() => Promise.resolve(undefined)),
    },
    workspace: {
      isTrusted: true,
      createFileSystemWatcher: watcher,
      onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
    },
  };
});

import { PiRuntime } from "../../../../pi-session/pi-runtime";
import { createOpenAIHandlers } from "../openai-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";

type Cred = { type: string; key?: string; expires?: number };

function makeServices() {
  const state: Record<string, Cred> = {};
  const authStorage = {
    set: vi.fn((provider: string, cred: Cred) => { state[provider] = cred; }),
    remove: vi.fn((provider: string) => { delete state[provider]; }),
    logout: vi.fn((provider: string) => { delete state[provider]; }),
    login: vi.fn(async (provider: string) => { state[provider] = { type: "oauth", expires: 123 }; }),
    get: vi.fn((provider: string) => state[provider]),
    has: vi.fn((provider: string) => provider in state),
    hasAuth: vi.fn((provider: string) => provider in state),
  };
  const modelRegistry = { refresh: vi.fn(), getAvailable: () => [] };
  return {
    state,
    authStorage,
    modelRegistry,
    services: { cwd: "/cwd", agentDir: "/agent", authStorage, settingsManager: {}, modelRegistry, resourceLoader: {}, diagnostics: [] },
  };
}

function makeDeps(sent: ExtensionToWebviewMessage[]): { deps: HandlerDependencies; ctx: HandlerContext } {
  const host = { id: "panel-1" } as unknown as HandlerContext["host"];
  const workspaceState = new Map<string, unknown>();
  const deps = {
    workspacePath: "/cwd",
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    getPanels: () => new Map([["panel-1", { host }]]) as unknown as Map<string, never>,
    context: {
      workspaceState: {
        get: (key: string, fallback?: unknown) => (workspaceState.has(key) ? workspaceState.get(key) : fallback),
        update: async (key: string, value: unknown) => { workspaceState.set(key, value); },
      },
    },
  } as unknown as HandlerDependencies;
  return { deps, ctx: { host } as HandlerContext };
}

describe("createOpenAIHandlers (PiRuntime-backed)", () => {
  let mock: ReturnType<typeof makeServices>;
  let sent: ExtensionToWebviewMessage[];
  let handlers: ReturnType<typeof createOpenAIHandlers>;
  let ctx: HandlerContext;

  beforeEach(() => {
    H.ctrl.loadable = true;
    mock = makeServices();
    H.fakePi.createAgentSessionServices = vi.fn().mockResolvedValue(mock.services);
    PiRuntime.get("/cwd", "/fake/agent");
    sent = [];
    const built = makeDeps(sent);
    handlers = createOpenAIHandlers(built.deps);
    ctx = built.ctx;
  });

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("setOpenAIApiKey stores the key and broadcasts openaiAuthStatusChanged + ack", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      json: async () => ({ data: [{}, {}, {}] }),
    })));

    await handlers.setOpenAIApiKey!(
      { type: "setOpenAIApiKey", key: "sk-test", requestId: "r1" },
      ctx,
    );

    expect(mock.authStorage.set).toHaveBeenCalledWith("openai", { type: "api_key", key: "sk-test" });

    const status = sent.find((m) => m.type === "openaiAuthStatusChanged");
    expect(status).toEqual({
      type: "openaiAuthStatusChanged",
      status: { codex: { signedIn: false }, apikey: { configured: true } },
      preferApiKey: false,
    });

    const ack = sent.find((m) => m.type === "setOpenAIApiKeyAck");
    expect(ack).toEqual({
      type: "setOpenAIApiKeyAck",
      requestId: "r1",
      ok: true,
      validated: true,
      modelCount: 3,
    });
  });

  it("startCodexOAuth drives started -> completed and broadcasts auth status", async () => {
    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);

    expect(mock.authStorage.login).toHaveBeenCalledTimes(1);
    expect((mock.authStorage.login.mock.calls[0] as unknown[])[0]).toBe("openai-codex");

    const types = sent.map((m) => m.type);
    expect(types).toContain("openaiCodexAuthStarted");
    expect(types).toContain("openaiCodexAuthCompleted");
    expect(types.indexOf("openaiCodexAuthStarted")).toBeLessThan(types.indexOf("openaiCodexAuthCompleted"));

    const completed = sent.find((m) => m.type === "openaiCodexAuthCompleted");
    expect(completed).toEqual({ type: "openaiCodexAuthCompleted", accountId: null });

    const status = sent.find((m) => m.type === "openaiAuthStatusChanged");
    expect(status).toEqual({
      type: "openaiAuthStatusChanged",
      status: { codex: { signedIn: true, expiresAt: 123 }, apikey: { configured: false } },
      preferApiKey: false,
    });
  });

  it("setOpenAIApiKey rejects a 401 key WITHOUT storing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, json: async () => null })));

    await handlers.setOpenAIApiKey!(
      { type: "setOpenAIApiKey", key: "sk-bad", requestId: "r2" },
      ctx,
    );

    expect(mock.authStorage.set).not.toHaveBeenCalled();
    const ack = sent.find((m) => m.type === "setOpenAIApiKeyAck");
    expect(ack).toMatchObject({ type: "setOpenAIApiKeyAck", requestId: "r2", ok: false });
    expect((ack as { error?: string }).error).toContain("rejected");
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(false);
  });

  it("startCodexOAuth rejects a concurrent second call (single-flight)", async () => {
    const p1 = handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);
    const p2 = handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);
    await Promise.all([p1, p2]);

    expect(mock.authStorage.login).toHaveBeenCalledTimes(1);
    const failed = sent.find((m) => m.type === "openaiCodexAuthFailed");
    expect(failed).toEqual({ type: "openaiCodexAuthFailed", error: "A sign-in flow is already in progress." });
  });

  it("startCodexOAuth surfaces a benign cancel when the prompt is dismissed", async () => {
    mock.authStorage.login.mockImplementationOnce(
      async (_provider: string, cb: { onPrompt: (p: { message: string }) => Promise<string> }) => {
        await cb.onPrompt({ message: "Paste the code" });
      },
    );

    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);

    const failed = sent.find((m) => m.type === "openaiCodexAuthFailed");
    expect(failed).toEqual({ type: "openaiCodexAuthFailed", error: "Sign-in cancelled." });
  });

  it("clearOpenAIApiKey removes the stored key and acks", async () => {
    await PiRuntime.get("/cwd", "/fake/agent").setOpenAIApiKey("sk-stored");

    await handlers.clearOpenAIApiKey!(
      { type: "clearOpenAIApiKey", requestId: "r3" },
      ctx,
    );

    expect(mock.authStorage.remove).toHaveBeenCalledWith("openai");
    const ack = sent.find((m) => m.type === "clearOpenAIApiKeyAck");
    expect(ack).toEqual({ type: "clearOpenAIApiKeyAck", requestId: "r3", ok: true });
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(true);
  });

  it("signOutCodex logs out the codex grant and re-broadcasts", async () => {
    await PiRuntime.get("/cwd", "/fake/agent").init();
    mock.state["openai-codex"] = { type: "oauth", expires: 1 };

    await handlers.signOutCodex!({ type: "signOutCodex" }, ctx);

    expect(mock.authStorage.logout).toHaveBeenCalledWith("openai-codex");
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(true);
  });
});
