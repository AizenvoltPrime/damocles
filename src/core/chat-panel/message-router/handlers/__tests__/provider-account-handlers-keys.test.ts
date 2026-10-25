import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createProviderAccountHandlers } from "../provider-account-handlers";
import { createSettingsHandlers } from "../settings-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import { installFakePlatform } from "../../../../../__mocks__/fake-platform";
import { PiRuntime } from "../../../../pi-session/pi-runtime";
import { customProviderDef } from "../../../../pi-session/custom-providers";
import { KEY_PROVIDER_IDS } from "../../../../../shared/settings-sections";

/** The key provider handlers: what they store, what they acknowledge, what card they clear, and what they leave alone. */
function setup(user: Record<string, unknown> = {}) {
  const platform = installFakePlatform({ settings: { user } });
  const posted: ExtensionToWebviewMessage[] = [];
  const host = {};
  const session = { getToolStatus: () => ({}), publishAccountInfo: () => {}, publishAvailableModels: () => {} };
  const deps = {
    postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); },
    settingsManager: {},
    platform,
    getPanels: () => new Map([["a", { host, session, folder: { key: "a" } }]]),
    subscriptions: [],
  } as unknown as HandlerDependencies;
  const ctx = { host, session, folder: { key: "a", fsPath: "/ws/a" } } as unknown as HandlerContext;
  const { handlers } = createProviderAccountHandlers(deps);
  const settings = createSettingsHandlers(deps);
  const send = (msg: WebviewToExtensionMessage) => (handlers[msg.type] ?? settings[msg.type])!(msg as never, ctx);
  return { platform, posted, send };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await PiRuntime.disposeInstance();
});

describe.each(KEY_PROVIDER_IDS)("%s key handlers", (provider) => {
  const secretName = customProviderDef(provider).key.secretKey;

  it("stores the trimmed key and acknowledges without echoing it, then clears it, each time clearing only that account's card", async () => {
    const { platform, posted, send } = setup({ "damocles.explore.model": "claude-sonnet-5-5" });
    await send({ type: "setProviderApiKey", provider, key: "  the-secret  ", requestId: "r1" });
    expect(await platform.secrets.get(secretName)).toBe("the-secret");
    expect(platform.settings.get("damocles.explore.model", "")).toBe("claude-sonnet-5-5");
    expect(posted).toEqual([
      { type: "setProviderApiKeyAck", provider, requestId: "r1", ok: true },
      { type: "authFailureCleared", account: provider },
    ]);
    expect(JSON.stringify(posted)).not.toContain("the-secret");

    await send({ type: "clearProviderApiKey", provider, requestId: "r2" });
    expect(await platform.secrets.get(secretName)).toBeUndefined();
    expect(posted.slice(-2)).toEqual([
      { type: "clearProviderApiKeyAck", provider, requestId: "r2", ok: true },
      { type: "authFailureCleared", account: provider },
    ]);
  });

  it("rejects an empty key with a localized error and stores nothing", async () => {
    const { platform, posted, send } = setup();
    vi.spyOn(platform.localization, "t").mockImplementation((message: string) => `[el] ${message}`);
    await send({ type: "setProviderApiKey", provider, key: "   ", requestId: "r1" });
    expect(posted).toEqual([{ type: "setProviderApiKeyAck", provider, requestId: "r1", ok: false, error: "[el] API key cannot be empty" }]);
    expect(await platform.secrets.get(secretName)).toBeUndefined();
  });

  it("acknowledges a failed save with the localized message, never the store's error text", async () => {
    const { platform, posted, send } = setup();
    vi.spyOn(platform.localization, "t").mockImplementation((message: string) => `[el] ${message}`);
    vi.spyOn(platform.secrets, "store").mockRejectedValue(new Error("keyring locked at /run/user/1000/keyring"));

    await send({ type: "setProviderApiKey", provider, key: "k", requestId: "r1" });

    expect(posted.at(-1)).toEqual({ type: "setProviderApiKeyAck", provider, requestId: "r1", ok: false, error: "[el] Failed to store API key" });
  });

  it("acknowledges a failed clear with the localized message, never the store's error text", async () => {
    const { platform, posted, send } = setup();
    vi.spyOn(platform.localization, "t").mockImplementation((message: string) => `[el] ${message}`);
    vi.spyOn(platform.secrets, "delete").mockRejectedValue(new Error("keyring locked at /run/user/1000/keyring"));

    await send({ type: "clearProviderApiKey", provider, requestId: "r2" });

    expect(posted.at(-1)).toEqual({ type: "clearProviderApiKeyAck", provider, requestId: "r2", ok: false, error: "[el] Failed to clear API key" });
  });
});

describe("an unknown key provider", () => {
  it("throws for the router to report and stores nothing", async () => {
    const { platform, posted, send } = setup();
    await expect(send({ type: "setProviderApiKey", provider: "nope", key: "k", requestId: "r1" } as never)).rejects.toThrow("Unknown key provider");
    await expect(send({ type: "clearProviderApiKey", provider: "constructor", requestId: "r2" } as never)).rejects.toThrow("Unknown key provider");
    await expect(send({ type: "setProviderApiKey", provider: "typesafe", key: 42, requestId: "r3" } as never)).rejects.toThrow("Malformed API key");
    expect(await platform.secrets.keys()).toEqual([]);
    expect(posted).toEqual([]);
  });
});

describe("the Prefer API key toggle", () => {
  it("clears the account's rejected-credential card once the toggle applied, and not when it failed", async () => {
    const { posted, send } = setup();
    const apply = vi.spyOn(PiRuntime.get(), "setProviderPreferApiKey").mockResolvedValueOnce(undefined);
    await send({ type: "setProviderPreferApiKey", provider: "xai", preferApiKey: true, requestId: "r1" });
    expect(apply).toHaveBeenCalledWith("xai", true);
    expect(posted).toEqual([
      { type: "setProviderPreferApiKeyAck", provider: "xai", requestId: "r1", ok: true },
      { type: "authFailureCleared", account: "xai" },
    ]);

    posted.length = 0;
    apply.mockRejectedValueOnce(new Error("pi failed to load"));
    await send({ type: "setProviderPreferApiKey", provider: "xai", preferApiKey: false, requestId: "r2" });
    expect(posted).toEqual([{ type: "setProviderPreferApiKeyAck", provider: "xai", requestId: "r2", ok: false, error: "Failed to apply the preference" }]);
  });
});
