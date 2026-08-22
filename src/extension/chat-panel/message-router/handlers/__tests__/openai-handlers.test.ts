import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenAIAuthStatus } from "../../../../pi-session/openai-auth";

const H = vi.hoisted(() => {
  const fakePi = {
    createAgentSessionServices: vi.fn(),
    DefaultPackageManager: class {
      getInstalledPath(): string | undefined {
        return undefined;
      }
    },
  };
  // Disk-truth mirror the stubbed `readOpenAIAuthFromDisk` returns. login/logout on the modelRuntime
  // mock mutate this to model "auth.json persisted before resolve" — the contract PiRuntime relies on.
  const disk: { value: OpenAIAuthStatus } = { value: { apiKey: false, codex: false } };
  return { fakePi, ctrl: { loadable: true }, disk };
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

// Status reads unify on the disk reader; stub it so tests drive OpenAI auth state deterministically.
// Everything else (provider ids, prefer-api-key state key) comes from the real module.
vi.mock("../../../../pi-session/openai-auth", async (importActual) => {
  const actual = await importActual<typeof import("../../../../pi-session/openai-auth")>();
  return { ...actual, readOpenAIAuthFromDisk: vi.fn(() => H.disk.value) };
});

vi.mock("vscode", () => {
  const watcher = () => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  });
  return {
    env: { openExternal: vi.fn(() => Promise.resolve(true)) },
    Uri: {
      parse: (str: string) => ({ toString: () => str }),
      // PiRuntime's asset watchers anchor their user-scope patterns on a Uri.
      file: (p: string) => ({ fsPath: p, path: p, scheme: "file" }),
    },
    RelativePattern: class {
      base: unknown;
      pattern: string;
      constructor(base: unknown, pattern: string) { this.base = base; this.pattern = pattern; }
    },
    window: {
      createOutputChannel: () => ({ appendLine: () => {}, show: () => {}, dispose: () => {} }),
      showInputBox: vi.fn(() => Promise.resolve(undefined)),
      showInformationMessage: vi.fn(() => Promise.resolve(undefined)),
    },
    CancellationTokenSource: class {
      private listeners: (() => void)[] = [];
      token = {
        isCancellationRequested: false,
        onCancellationRequested: (cb: () => void) => {
          this.listeners.push(cb);
          return { dispose: () => {} };
        },
      };
      cancel(): void {
        this.token.isCancellationRequested = true;
        for (const cb of this.listeners) cb();
      }
      dispose(): void {}
    },
    workspace: {
      isTrusted: true,
      createFileSystemWatcher: watcher,
      onDidGrantWorkspaceTrust: () => ({ dispose: () => {} }),
      getConfiguration: () => ({ get: (_key: string, defaultValue?: unknown) => defaultValue }),
    },
  };
});

import { PiRuntime } from "../../../../pi-session/pi-runtime";
import { createOpenAIHandlers } from "../openai-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";

interface AuthPrompt {
  type: "text" | "secret" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  options?: readonly { id: string; label: string }[];
  signal?: AbortSignal;
}
interface AuthInteractionLike {
  signal?: AbortSignal;
  prompt(p: AuthPrompt): Promise<string>;
  notify(event: unknown): void;
}

type Cred = { type: string; key?: string; expires?: number };

/**
 * One modelRuntime-backed mock of the services the PiRuntime facade owns. login/logout persist into an
 * internal cred map AND refresh the stubbed disk mirror, mirroring pi's "write auth.json, then resolve".
 * `login('openai','api_key',<interaction>)` reads the key back from the interaction's prompt (the way
 * PiRuntime.setOpenAIApiKey passes `keyInteraction(key)`), so assertions can verify the key flows through.
 */
function makeServices() {
  const creds: Record<string, Cred> = {};
  const syncDisk = () => {
    const codexCred = creds["openai-codex"];
    H.disk.value = {
      apiKey: creds["openai"]?.type === "api_key",
      codex: codexCred?.type === "oauth",
      ...(codexCred?.type === "oauth" && typeof codexCred.expires === "number"
        ? { codexExpires: codexCred.expires }
        : {}),
    };
  };

  const modelRuntime = {
    login: vi.fn(async (provider: string, type: "api_key" | "oauth", interaction: AuthInteractionLike) => {
      if (type === "api_key") {
        const key = await interaction.prompt({ type: "secret", message: "" });
        creds[provider] = { type: "api_key", key };
      } else {
        // OAuth flow: PiRuntime's wrapper answers the login-method select with 'browser'; a text/
        // manual_code prompt (e.g. paste-the-code fallback) still delegates to the caller's interaction.
        creds[provider] = { type: "oauth", expires: 123 };
      }
      syncDisk();
      return { provider };
    }),
    logout: vi.fn(async (provider: string) => {
      delete creds[provider];
      syncDisk();
    }),
    setRuntimeApiKey: vi.fn(async () => {}),
    getAuth: vi.fn(async () => undefined),
    getModel: vi.fn(() => undefined),
    hasConfiguredAuth: vi.fn(() => false),
    getAvailableSnapshot: vi.fn(() => []),
    getModels: vi.fn(() => []),
    registerProvider: vi.fn(),
    registerNativeProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    refresh: vi.fn(async () => ({})),
    completeSimple: vi.fn(async () => ({})),
  };

  return {
    creds,
    modelRuntime,
    services: {
      cwd: "/cwd",
      agentDir: "/agent",
      modelRuntime,
      settingsManager: { getPackages: () => [] },
      resourceLoader: {},
      diagnostics: [],
    },
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

describe("createOpenAIHandlers (modelRuntime-backed)", () => {
  let mock: ReturnType<typeof makeServices>;
  let sent: ExtensionToWebviewMessage[];
  let handlers: ReturnType<typeof createOpenAIHandlers>;
  let ctx: HandlerContext;

  beforeEach(() => {
    H.ctrl.loadable = true;
    H.disk.value = { apiKey: false, codex: false };
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

  it("setOpenAIApiKey logs in via api_key and broadcasts openaiAuthStatusChanged + ack", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      json: async () => ({ data: [{}, {}, {}] }),
    })));

    await handlers.setOpenAIApiKey!(
      { type: "setOpenAIApiKey", key: "sk-test", requestId: "r1" },
      ctx,
    );

    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(1);
    const [provider, type] = mock.modelRuntime.login.mock.calls[0] as unknown as [string, string, unknown];
    expect(provider).toBe("openai");
    expect(type).toBe("api_key");
    expect(mock.creds["openai"]).toEqual({ type: "api_key", key: "sk-test" });

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

    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(1);
    const [provider, type] = mock.modelRuntime.login.mock.calls[0] as unknown as [string, string, unknown];
    expect(provider).toBe("openai-codex");
    expect(type).toBe("oauth");

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

  it("setOpenAIApiKey rejects a 401 key WITHOUT logging in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, json: async () => null })));

    await handlers.setOpenAIApiKey!(
      { type: "setOpenAIApiKey", key: "sk-bad", requestId: "r2" },
      ctx,
    );

    expect(mock.modelRuntime.login).not.toHaveBeenCalled();
    const ack = sent.find((m) => m.type === "setOpenAIApiKeyAck");
    expect(ack).toMatchObject({ type: "setOpenAIApiKeyAck", requestId: "r2", ok: false });
    expect((ack as { error?: string }).error).toContain("rejected");
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(false);
  });

  it("startCodexOAuth rejects a concurrent second call (single-flight)", async () => {
    const p1 = handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);
    const p2 = handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);
    await Promise.all([p1, p2]);

    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(1);
    const failed = sent.find((m) => m.type === "openaiCodexAuthFailed");
    expect(failed).toEqual({ type: "openaiCodexAuthFailed", error: "A sign-in flow is already in progress." });
  });

  it("startCodexOAuth surfaces a benign cancel when the interaction prompt is dismissed", async () => {
    // Simulate pi driving the paste-the-code fallback: it invokes the caller's interaction.prompt,
    // which calls showInputBox → undefined (dismiss) → throws CODEX_SIGN_IN_CANCELLED.
    mock.modelRuntime.login.mockImplementationOnce(
      async (_provider: string, _type: string, interaction: AuthInteractionLike) => {
        await interaction.prompt({ type: "manual_code", message: "Paste the code" });
        return { provider: "openai-codex" };
      },
    );

    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);

    const failed = sent.find((m) => m.type === "openaiCodexAuthFailed");
    expect(failed).toEqual({ type: "openaiCodexAuthFailed", error: "Sign-in cancelled." });
  });

  it("startCodexOAuth completes successfully when pi aborts the manual prompt after the callback wins", async () => {
    // pi races the manual_code prompt against its loopback callback server. When the callback wins,
    // pi fires AuthPrompt.signal; the interaction must dismiss the input box (bridged cancellation
    // token) and reject with the abort reason — NOT the user-cancel sentinel — which pi discards
    // because the race is already won. The login then resolves normally.
    const vscode = await import("vscode");
    let inputBoxCancelled = false;
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_opts: unknown, token: { onCancellationRequested: (cb: () => void) => void }) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => {
            inputBoxCancelled = true;
            resolve(undefined); // VS Code resolves undefined when the token cancels the input box
          });
        }),
    );
    mock.modelRuntime.login.mockImplementationOnce(
      async (provider: string, _type: string, interaction: AuthInteractionLike) => {
        const abort = new AbortController();
        const manualPromise = interaction.prompt({ type: "manual_code", message: "Paste the code", signal: abort.signal });
        abort.abort(new Error("prompt superseded by callback"));
        // pi swallows the losing prompt's rejection; assert it is NOT the benign-cancel sentinel.
        await expect(manualPromise).rejects.toThrow("prompt superseded by callback");
        return { provider };
      },
    );

    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);

    expect(inputBoxCancelled).toBe(true);
    expect(sent.some((m) => m.type === "openaiCodexAuthCompleted")).toBe(true);
    expect(sent.some((m) => m.type === "openaiCodexAuthFailed")).toBe(false);
  });

  it("startCodexOAuth surfaces a generic login failure and resets busy for the next attempt", async () => {
    mock.modelRuntime.login.mockRejectedValueOnce(new Error("token exchange failed"));

    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);

    const failed = sent.find((m) => m.type === "openaiCodexAuthFailed");
    expect(failed).toEqual({ type: "openaiCodexAuthFailed", error: "token exchange failed" });

    // busy must have been reset — a second attempt reaches login again instead of "already in progress".
    sent.length = 0;
    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);
    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(2);
    expect(sent.some((m) => m.type === "openaiCodexAuthCompleted")).toBe(true);
  });

  it("signOutCodex during a stalled sign-in aborts the flow, dismisses the prompt, and unlatches busy", async () => {
    // Simulate a stalled browser login: pi is parked awaiting the manual_code prompt (the user never
    // completed the browser flow). signOutCodex fires the handler's flow-level AbortController; the
    // interaction must bridge that signal into the open input box so the prompt dismisses, the login
    // promise settles (benign cancel), and codexBusy unlatches for the next attempt.
    const vscode = await import("vscode");
    let promptOpened!: () => void;
    const promptOpen = new Promise<void>((resolve) => { promptOpened = resolve; });
    (vscode.window.showInputBox as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (_opts: unknown, token: { onCancellationRequested: (cb: () => void) => void }) =>
        new Promise((resolve) => {
          token.onCancellationRequested(() => resolve(undefined));
          promptOpened();
        }),
    );
    mock.modelRuntime.login.mockImplementationOnce(
      async (provider: string, _type: string, interaction: AuthInteractionLike) => {
        // pi's login rejects when the manual prompt rejects and no callback code arrived.
        await interaction.prompt({ type: "manual_code", message: "Paste the code" });
        return { provider };
      },
    );

    const signInPromise = handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);
    await promptOpen; // login has reached the parked prompt
    await handlers.signOutCodex!({ type: "signOutCodex" }, ctx);
    await signInPromise;

    const failed = sent.find((m) => m.type === "openaiCodexAuthFailed");
    expect(failed).toEqual({ type: "openaiCodexAuthFailed", error: "Sign-in cancelled." });

    // busy unlatched — a fresh sign-in reaches login again.
    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);
    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(2);
  });

  it("startCodexOAuth opens the browser on an auth_url notification", async () => {
    const vscode = await import("vscode");
    mock.modelRuntime.login.mockImplementationOnce(
      async (_provider: string, _type: string, interaction: AuthInteractionLike) => {
        interaction.notify({ type: "auth_url", url: "https://auth.openai.test/authorize" });
        return { provider: "openai-codex" };
      },
    );

    await handlers.startCodexOAuth!({ type: "startCodexOAuth" }, ctx);

    expect(vscode.env.openExternal).toHaveBeenCalledTimes(1);
    const arg = (vscode.env.openExternal as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0];
    expect(String(arg)).toBe("https://auth.openai.test/authorize");
    expect(sent.some((m) => m.type === "openaiCodexAuthCompleted")).toBe(true);
  });

  it("clearOpenAIApiKey logs out 'openai' only and acks", async () => {
    await PiRuntime.get("/cwd", "/fake/agent").init();
    mock.creds["openai"] = { type: "api_key", key: "sk-stored" };
    mock.creds["openai-codex"] = { type: "oauth", expires: 1 };

    await handlers.clearOpenAIApiKey!(
      { type: "clearOpenAIApiKey", requestId: "r3" },
      ctx,
    );

    expect(mock.modelRuntime.logout).toHaveBeenCalledWith("openai");
    expect(mock.modelRuntime.logout).not.toHaveBeenCalledWith("openai-codex");
    const ack = sent.find((m) => m.type === "clearOpenAIApiKeyAck");
    expect(ack).toEqual({ type: "clearOpenAIApiKeyAck", requestId: "r3", ok: true });
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(true);
  });

  it("signOutCodex logs out the codex grant and re-broadcasts", async () => {
    await PiRuntime.get("/cwd", "/fake/agent").init();
    mock.creds["openai-codex"] = { type: "oauth", expires: 1 };

    await handlers.signOutCodex!({ type: "signOutCodex" }, ctx);

    expect(mock.modelRuntime.logout).toHaveBeenCalledWith("openai-codex");
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(true);
  });
});
