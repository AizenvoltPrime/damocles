import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OpenAIDiskAuth } from "../../../../pi-session/openai-auth";

const H = vi.hoisted(() => {
  const fakePi = {
    createAgentSessionServices: vi.fn(),
    ModelRuntime: { create: vi.fn() },
    SettingsManager: { create: vi.fn(() => ({ getOrCreateDeviceId: () => "0b9c2f2e-6a0c-4c5e-9d41-3f1f0e6c2a11" })) },
    DefaultPackageManager: class {
      getInstalledPath(): string | undefined {
        return undefined;
      }
    },
  };
  // Disk mirror the stubbed `readOpenAIAuthFromDisk` returns. login/logout on the modelRuntime mock
  // mutate it to model "auth.json persisted before resolve", the contract PiRuntime relies on.
  const disk: { value: OpenAIDiskAuth } = { value: { chatgpt: false, codex: false, storedApiKey: false } };
  return { fakePi, ctrl: { loadable: true }, disk };
});

vi.mock("../../../../pi-session/pi-loader", () => ({
  initPiLoader: vi.fn(async () => (H.ctrl.loadable ? H.fakePi : null)),
  getPiCodingAgent: vi.fn(() => (H.ctrl.loadable ? H.fakePi : null)),
  PI_MIN_NODE_MAJOR: 22,
  nodeSupportsPi: () => true,
}));

// Only the fs-touching seed is stubbed; `cacheWarmingSetting` stays real, since `PiRuntime.init` passes
// its result to `ensurePiAgentDir`.
vi.mock("../../../../pi-session/agent-dir", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../pi-session/agent-dir")>()),
  ensurePiAgentDir: (dir: string) => dir,
  PI_AGENT_DIR: "/fake/agent",
}));

// Status reads unify on the disk reader; stub it so tests drive OpenAI auth state deterministically.
vi.mock("../../../../pi-session/openai-auth", async (importActual) => {
  const actual = await importActual<typeof import("../../../../pi-session/openai-auth")>();
  return { ...actual, readOpenAIAuthFromDisk: vi.fn(() => H.disk.value) };
});

import { PiRuntime } from "../../../../pi-session/pi-runtime";
import { OPENAI_API_KEY_SECRET } from "../../../../pi-session/openai-auth";
import { createOpenAIHandlers } from "../openai-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage } from "../../../../../shared/types/messages";
import { installFakePlatform, type FakePlatform } from "../../../../../__mocks__/fake-platform";

interface AuthPrompt {
  type: "text" | "secret" | "manual_code" | "select";
  message: string;
  placeholder?: string;
  signal?: AbortSignal;
}
interface AuthInteractionLike {
  signal?: AbortSignal;
  prompt(p: AuthPrompt): Promise<string>;
  notify(event: unknown): void;
}

type Cred = { type: string; expires?: number };

function makeServices() {
  const creds: Record<string, Cred> = {};
  const runtimeKeys = new Map<string, string>();
  const syncDisk = () => {
    const chatgpt = creds["openai"];
    const codex = creds["openai-codex"];
    H.disk.value = {
      chatgpt: chatgpt?.type === "oauth",
      ...(chatgpt?.type === "oauth" && typeof chatgpt.expires === "number" ? { chatgptExpires: chatgpt.expires } : {}),
      codex: codex?.type === "oauth",
      ...(codex?.type === "oauth" && typeof codex.expires === "number" ? { codexExpires: codex.expires } : {}),
      storedApiKey: false,
    };
  };

  const modelRuntime = {
    login: vi.fn(async (provider: string, _type: "oauth", _interaction: AuthInteractionLike, _options?: unknown) => {
      creds[provider] = { type: "oauth", expires: 123 };
      syncDisk();
      return { provider };
    }),
    logout: vi.fn(async (provider: string) => {
      delete creds[provider];
      runtimeKeys.delete(provider);
      syncDisk();
    }),
    setRuntimeApiKey: vi.fn(async (provider: string, key: string) => { runtimeKeys.set(provider, key); }),
    removeRuntimeApiKey: vi.fn(async (provider: string) => { runtimeKeys.delete(provider); }),
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

  return { creds, runtimeKeys, modelRuntime, syncDisk };
}

function makeDeps(sent: ExtensionToWebviewMessage[], platform: FakePlatform): {
  deps: HandlerDependencies;
  ctx: HandlerContext;
  publishAccountInfo: ReturnType<typeof vi.fn>;
} {
  const host = { id: "panel-1" } as unknown as HandlerContext["host"];
  const publishAccountInfo = vi.fn();
  const deps = {
    postMessage: (_host: unknown, message: ExtensionToWebviewMessage) => { sent.push(message); },
    getPanels: () => new Map([["panel-1", { host, session: { publishAccountInfo } }]]) as unknown as Map<string, never>,
    platform,
  } as unknown as HandlerDependencies;
  return { deps, ctx: { host, folder: { fsPath: "/work" } } as unknown as HandlerContext, publishAccountInfo };
}

/** Every string any message posted to the webview carries, to prove no key reaches it. */
function postedText(sent: ExtensionToWebviewMessage[]): string {
  return JSON.stringify(sent);
}

describe("createOpenAIHandlers", () => {
  let mock: ReturnType<typeof makeServices>;
  let sent: ExtensionToWebviewMessage[];
  let handlers: ReturnType<typeof createOpenAIHandlers>;
  let ctx: HandlerContext;
  let publishAccountInfo: ReturnType<typeof vi.fn>;
  let platform: FakePlatform;

  beforeEach(() => {
    H.ctrl.loadable = true;
    H.disk.value = { chatgpt: false, codex: false, storedApiKey: false };
    platform = installFakePlatform();
    mock = makeServices();
    H.fakePi.ModelRuntime.create = vi.fn().mockResolvedValue(mock.modelRuntime);
    sent = [];
    const built = makeDeps(sent, platform);
    handlers = createOpenAIHandlers(built.deps);
    ctx = built.ctx;
    publishAccountInfo = built.publishAccountInfo;
  });

  afterEach(async () => {
    await PiRuntime.disposeInstance();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("setOpenAIApiKey stores the secret, broadcasts presence only, and acks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      status: 200,
      json: async () => ({ data: [{}, {}, {}] }),
    })));

    await handlers.setOpenAIApiKey!({ type: "setOpenAIApiKey", key: "sk-test", requestId: "r1" }, ctx);

    expect(platform.secrets.entries.get(OPENAI_API_KEY_SECRET)).toBe("sk-test");
    expect(mock.modelRuntime.login).not.toHaveBeenCalled();
    expect(mock.runtimeKeys.get("openai")).toBe("sk-test");
    expect(sent.find((m) => m.type === "openaiAuthStatusChanged")).toEqual({
      type: "openaiAuthStatusChanged",
      status: { chatgpt: { signedIn: false }, codex: { signedIn: false }, apikey: { configured: true } },
      preferApiKey: false,
    });
    expect(sent.find((m) => m.type === "setOpenAIApiKeyAck")).toEqual({
      type: "setOpenAIApiKeyAck",
      requestId: "r1",
      ok: true,
      validated: true,
      modelCount: 3,
    });
    expect(postedText(sent)).not.toContain("sk-test");
  });

  it("setOpenAIApiKey rejects a 401 key without storing it", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 401, json: async () => null })));

    await handlers.setOpenAIApiKey!({ type: "setOpenAIApiKey", key: "sk-bad", requestId: "r2" }, ctx);

    expect(platform.secrets.entries.has(OPENAI_API_KEY_SECRET)).toBe(false);
    const ack = sent.find((m) => m.type === "setOpenAIApiKeyAck");
    expect(ack).toMatchObject({ type: "setOpenAIApiKeyAck", requestId: "r2", ok: false });
    expect((ack as { error?: string }).error).toContain("rejected");
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(false);
  });

  it("startChatGPTOAuth signs in on openai, removes the Codex grant, and broadcasts started -> completed -> status", async () => {
    mock.creds["openai-codex"] = { type: "oauth", expires: 1 };
    mock.syncDisk();

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    const [provider, type] = mock.modelRuntime.login.mock.calls[0]!;
    expect([provider, type]).toEqual(["openai", "oauth"]);
    expect(mock.modelRuntime.logout).toHaveBeenCalledWith("openai-codex");
    const types = sent.map((m) => m.type);
    expect(types.indexOf("openaiChatGPTAuthStarted")).toBeLessThan(types.indexOf("openaiChatGPTAuthCompleted"));
    expect(sent.find((m) => m.type === "openaiChatGPTAuthCompleted")).toEqual({ type: "openaiChatGPTAuthCompleted" });
    expect(sent.filter((m) => m.type === "openaiAuthStatusChanged").at(-1)).toEqual({
      type: "openaiAuthStatusChanged",
      status: { chatgpt: { signedIn: true, expiresAt: 123 }, codex: { signedIn: false }, apikey: { configured: false } },
      preferApiKey: false,
    });
    expect(publishAccountInfo).toHaveBeenCalled();
  });

  it("startChatGPTOAuth answers a concurrent second call with the running flow's state, not a failure", async () => {
    const otherHost = { id: "panel-2" } as unknown as HandlerContext["host"];
    const toHost = new Map<unknown, ExtensionToWebviewMessage[]>();
    const deps = {
      postMessage: (target: unknown, message: ExtensionToWebviewMessage) => {
        toHost.set(target, [...(toHost.get(target) ?? []), message]);
      },
      getPanels: () =>
        new Map([
          ["panel-1", { host: ctx.host, session: { publishAccountInfo } }],
          ["panel-2", { host: otherHost, session: { publishAccountInfo } }],
        ]) as unknown as Map<string, never>,
      platform,
    } as unknown as HandlerDependencies;
    const twoPanels = createOpenAIHandlers(deps);

    const p1 = twoPanels.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);
    const p2 = twoPanels.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);
    await Promise.all([p1, p2]);

    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(1);
    const types = (host: unknown) => (toHost.get(host) ?? []).map((m) => m.type);
    expect(types(ctx.host)).not.toContain("openaiChatGPTAuthFailed");
    expect(types(otherHost)).not.toContain("openaiChatGPTAuthFailed");
    expect(types(ctx.host).filter((t) => t === "openaiChatGPTAuthStarted")).toHaveLength(2);
    expect(types(otherHost).filter((t) => t === "openaiChatGPTAuthStarted")).toHaveLength(1);
  });

  it("startChatGPTOAuth surfaces a benign cancel when the paste prompt is dismissed", async () => {
    mock.modelRuntime.login.mockImplementationOnce(
      async (_provider: string, _type: string, interaction: AuthInteractionLike) => {
        await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
        return { provider: "openai" };
      },
    );

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    expect(sent.find((m) => m.type === "openaiChatGPTAuthFailed")).toEqual({ type: "openaiChatGPTAuthFailed", error: "Sign-in cancelled." });
  });

  it("startChatGPTOAuth completes when pi aborts the paste prompt after the callback wins", async () => {
    platform.dialogs.answerInputBox(() => new Promise<undefined>(() => {}));
    mock.modelRuntime.login.mockImplementationOnce(
      async (provider: string, _type: string, interaction: AuthInteractionLike) => {
        const abort = new AbortController();
        const manualPromise = interaction.prompt({ type: "manual_code", message: "Paste the redirect URL", signal: abort.signal });
        abort.abort(new Error("prompt superseded by callback"));
        await expect(manualPromise).rejects.toThrow("prompt superseded by callback");
        return { provider };
      },
    );

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    expect(platform.dialogs.inputBoxCalls).toHaveLength(1);
    expect(platform.dialogs.inputBoxCalls[0]?.signal?.aborted).toBe(true);
    expect(sent.some((m) => m.type === "openaiChatGPTAuthCompleted")).toBe(true);
    expect(sent.some((m) => m.type === "openaiChatGPTAuthFailed")).toBe(false);
  });

  it("startChatGPTOAuth surfaces a login failure and resets busy for the next attempt", async () => {
    mock.modelRuntime.login.mockRejectedValueOnce(new Error("token exchange failed"));

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);
    expect(sent.find((m) => m.type === "openaiChatGPTAuthFailed")).toEqual({ type: "openaiChatGPTAuthFailed", error: "token exchange failed" });

    sent.length = 0;
    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);
    expect(mock.modelRuntime.login).toHaveBeenCalledTimes(2);
    expect(sent.some((m) => m.type === "openaiChatGPTAuthCompleted")).toBe(true);
  });

  it.each(["signOutChatGPT", "signOutCodex"] as const)(
    "%s during a stalled sign-in aborts the flow without queuing behind it, and unlatches busy",
    async (signOut) => {
      let promptOpened!: () => void;
      const promptOpen = new Promise<void>((resolve) => { promptOpened = resolve; });
      platform.dialogs.answerInputBox(() => {
        promptOpened();
        return new Promise<undefined>(() => {});
      });
      mock.modelRuntime.login.mockImplementationOnce(
        async (provider: string, _type: string, interaction: AuthInteractionLike) => {
          await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
          return { provider };
        },
      );

      const signInPromise = handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);
      await promptOpen;
      await handlers[signOut]!({ type: signOut }, ctx);
      await signInPromise;

      expect(sent.find((m) => m.type === "openaiChatGPTAuthFailed")).toEqual({ type: "openaiChatGPTAuthFailed", error: "Sign-in cancelled." });
      await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);
      expect(mock.modelRuntime.login).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    ["setOpenAIApiKey", { type: "setOpenAIApiKey", key: "sk-new", requestId: "k1" }, "setOpenAIApiKeyAck"],
    ["clearOpenAIApiKey", { type: "clearOpenAIApiKey", requestId: "k2" }, "clearOpenAIApiKeyAck"],
    ["setOpenAIPreferApiKey", { type: "setOpenAIPreferApiKey", preferApiKey: true, requestId: "k3" }, "setOpenAIPreferApiKeyAck"],
  ] as const)("%s during a stalled sign-in aborts the flow and acks instead of waiting behind it", async (name, msg, ackType) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ data: [] }) })));
    let promptOpened!: () => void;
    const promptOpen = new Promise<void>((resolve) => { promptOpened = resolve; });
    platform.dialogs.answerInputBox(() => {
      promptOpened();
      return new Promise<undefined>(() => {});
    });
    mock.modelRuntime.login.mockImplementationOnce(
      async (provider: string, _type: string, interaction: AuthInteractionLike) => {
        await interaction.prompt({ type: "manual_code", message: "Paste the redirect URL" });
        return { provider };
      },
    );

    const signInPromise = handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);
    await promptOpen;
    await (handlers[name] as (m: typeof msg, c: HandlerContext) => Promise<void>)(msg, ctx);
    await signInPromise;

    expect(sent.find((m) => m.type === ackType)).toMatchObject({ ok: true });
    expect(sent.find((m) => m.type === "openaiChatGPTAuthFailed")).toEqual({ type: "openaiChatGPTAuthFailed", error: "Sign-in cancelled." });
  });

  it("acks a key save that pi committed before a CredentialSynchronizationError as saved", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, json: async () => ({ data: [{}] }) })));
    mock.modelRuntime.setRuntimeApiKey.mockImplementationOnce(async (provider: string, key: string) => {
      mock.runtimeKeys.set(provider, key);
      throw Object.assign(new Error("Credential setRuntimeApiKey committed for openai, but local synchronization failed"), {
        name: "CredentialSynchronizationError",
      });
    });

    await handlers.setOpenAIApiKey!({ type: "setOpenAIApiKey", key: "sk-test", requestId: "r9" }, ctx);

    expect(sent.find((m) => m.type === "setOpenAIApiKeyAck")).toMatchObject({ requestId: "r9", ok: true, validated: true });
    expect(mock.runtimeKeys.get("openai")).toBe("sk-test");
  });

  it("startChatGPTOAuth reports a sign-in that pi stored before a CredentialSynchronizationError as completed", async () => {
    mock.modelRuntime.login.mockImplementationOnce(async (provider: string) => {
      mock.creds[provider] = { type: "oauth", expires: 123 };
      mock.syncDisk();
      throw Object.assign(new Error("Credential login committed for openai, but local synchronization failed"), {
        name: "CredentialSynchronizationError",
      });
    });

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    expect(sent.some((m) => m.type === "openaiChatGPTAuthCompleted")).toBe(true);
    expect(sent.some((m) => m.type === "openaiChatGPTAuthFailed")).toBe(false);
  });

  it("reads the key secret for the status until init's first key sync has run", async () => {
    await platform.secrets.store(OPENAI_API_KEY_SECRET, "sk-stored");
    let releaseSync!: () => void;
    const syncReleased = new Promise<void>((resolve) => { releaseSync = resolve; });
    const realGet = platform.secrets.get;
    let reads = 0;
    platform.secrets.get = async (name: string) => {
      if (name === OPENAI_API_KEY_SECRET && reads++ === 0) await syncReleased;
      return realGet(name);
    };
    const init = PiRuntime.get("/fake/agent").init();
    try {
      await vi.waitFor(() => expect(reads).toBe(1));

      await handlers.getOpenAIAuthStatus!({ type: "getOpenAIAuthStatus" }, ctx);

      expect(sent.at(-1)).toMatchObject({ status: { apikey: { configured: true } } });
    } finally {
      releaseSync();
      await init;
    }
  });

  it("startChatGPTOAuth opens the browser on an auth_url notification", async () => {
    mock.modelRuntime.login.mockImplementationOnce(
      async (_provider: string, _type: string, interaction: AuthInteractionLike) => {
        interaction.notify({ type: "auth_url", url: "https://auth.openai.test/authorize" });
        return { provider: "openai" };
      },
    );

    await handlers.startChatGPTOAuth!({ type: "startChatGPTOAuth" }, ctx);

    expect(platform.shell.openedExternal).toEqual(["https://auth.openai.test/authorize"]);
    expect(sent.some((m) => m.type === "openaiChatGPTAuthCompleted")).toBe(true);
  });

  it("clearOpenAIApiKey deletes the secret, never logs out, and acks", async () => {
    await platform.secrets.store(OPENAI_API_KEY_SECRET, "sk-stored");
    mock.creds["openai"] = { type: "oauth", expires: 1 };
    mock.syncDisk();

    await handlers.clearOpenAIApiKey!({ type: "clearOpenAIApiKey", requestId: "r3" }, ctx);

    expect(platform.secrets.entries.has(OPENAI_API_KEY_SECRET)).toBe(false);
    expect(mock.modelRuntime.logout).not.toHaveBeenCalled();
    expect(sent.find((m) => m.type === "clearOpenAIApiKeyAck")).toEqual({ type: "clearOpenAIApiKeyAck", requestId: "r3", ok: true });
    expect(sent.filter((m) => m.type === "openaiAuthStatusChanged").at(-1)).toMatchObject({
      status: { chatgpt: { signedIn: true }, apikey: { configured: false } },
    });
  });

  it("signOutChatGPT logs out openai and re-broadcasts", async () => {
    mock.creds["openai"] = { type: "oauth", expires: 1 };
    mock.syncDisk();

    await handlers.signOutChatGPT!({ type: "signOutChatGPT" }, ctx);

    expect(mock.modelRuntime.logout).toHaveBeenCalledWith("openai");
    expect(sent.filter((m) => m.type === "openaiAuthStatusChanged").at(-1)).toMatchObject({ status: { chatgpt: { signedIn: false } } });
  });

  it("signOutCodex logs out the codex grant and re-broadcasts", async () => {
    mock.creds["openai-codex"] = { type: "oauth", expires: 1 };
    mock.syncDisk();

    await handlers.signOutCodex!({ type: "signOutCodex" }, ctx);

    expect(mock.modelRuntime.logout).toHaveBeenCalledWith("openai-codex");
    expect(mock.modelRuntime.logout).not.toHaveBeenCalledWith("openai");
    expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(true);
  });

  it("setOpenAIPreferApiKey applies the runtime key with no login", async () => {
    await platform.secrets.store(OPENAI_API_KEY_SECRET, "sk-stored");
    mock.creds["openai"] = { type: "oauth", expires: 1 };
    mock.syncDisk();
    await PiRuntime.get("/fake/agent").init();
    expect(mock.runtimeKeys.has("openai")).toBe(false);

    await handlers.setOpenAIPreferApiKey!({ type: "setOpenAIPreferApiKey", preferApiKey: true, requestId: "r4" }, ctx);
    expect(mock.runtimeKeys.get("openai")).toBe("sk-stored");

    await handlers.setOpenAIPreferApiKey!({ type: "setOpenAIPreferApiKey", preferApiKey: false, requestId: "r5" }, ctx);
    expect(mock.runtimeKeys.has("openai")).toBe(false);
    expect(mock.modelRuntime.login).not.toHaveBeenCalled();
    expect(mock.modelRuntime.logout).not.toHaveBeenCalled();
  });

  it("reports a key still in auth.json as configured before the runtime exists", async () => {
    await PiRuntime.disposeInstance();
    H.disk.value = { chatgpt: false, codex: false, storedApiKey: true };

    await handlers.getOpenAIAuthStatus!({ type: "getOpenAIAuthStatus" }, ctx);

    expect(sent.at(-1)).toMatchObject({ status: { apikey: { configured: true } } });
  });

  /**
   * The account chip is derived from the OpenAI credential state and the prefer-API-key flag. Nothing
   * republishes it on its own, so each mutation here has to ask every panel's session to publish.
   */
  describe("account state republication", () => {
    it("setOpenAIPreferApiKey republishes to every panel", async () => {
      await handlers.setOpenAIPreferApiKey!({ type: "setOpenAIPreferApiKey", preferApiKey: true, requestId: "r4" }, ctx);
      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("clearOpenAIApiKey republishes to every panel", async () => {
      await handlers.clearOpenAIApiKey!({ type: "clearOpenAIApiKey", requestId: "r5" }, ctx);
      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("signOutChatGPT republishes to every panel", async () => {
      await handlers.signOutChatGPT!({ type: "signOutChatGPT" }, ctx);
      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("signOutCodex republishes to every panel", async () => {
      await handlers.signOutCodex!({ type: "signOutCodex" }, ctx);
      expect(publishAccountInfo).toHaveBeenCalledTimes(1);
    });

    it("reading the auth status changes nothing, so it does not republish", async () => {
      await handlers.getOpenAIAuthStatus!({ type: "getOpenAIAuthStatus" }, ctx);
      expect(sent.some((m) => m.type === "openaiAuthStatusChanged")).toBe(true);
      expect(publishAccountInfo).not.toHaveBeenCalled();
    });
  });
});
