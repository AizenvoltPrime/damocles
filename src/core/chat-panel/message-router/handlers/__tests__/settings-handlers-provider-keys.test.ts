import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../../../../logger", () => ({ log: vi.fn() }));

import { createSettingsHandlers } from "../settings-handlers";
import type { HandlerDependencies, HandlerContext } from "../../types";
import type { ExtensionToWebviewMessage, WebviewToExtensionMessage } from "../../../../../shared/types/messages";
import { installFakePlatform } from "../../../../../__mocks__/fake-platform";
import { PiRuntime } from "../../../../pi-session/pi-runtime";

/** The TypeSafe and OpenRouter key handlers: what they store, what they acknowledge, and what they leave alone. */
function setup(user: Record<string, unknown> = {}) {
  const platform = installFakePlatform({ settings: { user } });
  const posted: ExtensionToWebviewMessage[] = [];
  const host = {};
  const session = { getToolStatus: () => ({}) };
  const settingsManager = {
    sendImageGenerationSettings: vi.fn(),
  };
  const deps = {
    postMessage: (_host: unknown, msg: ExtensionToWebviewMessage) => { posted.push(msg); },
    settingsManager,
    platform,
    getPanels: () => new Map([["a", { host, session, folder: { key: "a" } }]]),
  } as unknown as HandlerDependencies;
  const ctx = { host, session, folder: { key: "a", fsPath: "/ws/a" } } as unknown as HandlerContext;
  const handlers = createSettingsHandlers(deps);
  const send = (msg: WebviewToExtensionMessage) => handlers[msg.type]!(msg as never, ctx);
  return { platform, posted, send, settingsManager };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await PiRuntime.disposeInstance();
});

describe("TypeSafe key handlers", () => {
  it("rejects an empty key with a localized error and stores nothing", async () => {
    const { platform, posted, send } = setup();
    vi.spyOn(platform.localization, "t").mockImplementation((message: string) => `[el] ${message}`);
    await send({ type: "setTypesafeApiKey", key: "   ", requestId: "r1" });
    expect(posted).toEqual([{ type: "setTypesafeApiKeyAck", requestId: "r1", ok: false, error: "[el] API key cannot be empty" }]);
    expect(await platform.secrets.get("damocles.typesafe.apiKey")).toBeUndefined();
  });

  it("stores the trimmed key and acknowledges without echoing it, then clears it", async () => {
    const { platform, posted, send } = setup();
    await send({ type: "setTypesafeApiKey", key: "  ts-secret  ", requestId: "r1" });
    expect(await platform.secrets.get("damocles.typesafe.apiKey")).toBe("ts-secret");
    expect(posted).toEqual([{ type: "setTypesafeApiKeyAck", requestId: "r1", ok: true }]);
    expect(JSON.stringify(posted)).not.toContain("ts-secret");

    await send({ type: "clearTypesafeApiKey", requestId: "r2" });
    expect(await platform.secrets.get("damocles.typesafe.apiKey")).toBeUndefined();
    expect(posted.at(-1)).toEqual({ type: "clearTypesafeApiKeyAck", requestId: "r2", ok: true });
  });

  it("acknowledges a failed clear with the localized message, never the store's error text", async () => {
    const { platform, posted, send } = setup();
    vi.spyOn(platform.localization, "t").mockImplementation((message: string) => `[el] ${message}`);
    vi.spyOn(platform.secrets, "delete").mockRejectedValue(new Error("keyring locked at /run/user/1000/keyring"));

    await send({ type: "clearTypesafeApiKey", requestId: "r2" });

    expect(posted.at(-1)).toEqual({ type: "clearTypesafeApiKeyAck", requestId: "r2", ok: false, error: "[el] Failed to clear API key" });
  });
});

describe("OpenRouter key handlers", () => {
  it("stores the key under its stored name for image generation and Jev, and leaves the Explore model alone", async () => {
    const { platform, posted, send, settingsManager } = setup({ "damocles.explore.model": "claude-sonnet-5-5" });
    await send({ type: "setOpenrouterApiKey", key: " sk-or-1 ", requestId: "r1" });

    expect(await platform.secrets.get("damocles.explore.apiKey.openrouter")).toBe("sk-or-1");
    expect(platform.settings.get("damocles.explore.model", "")).toBe("claude-sonnet-5-5");
    expect(posted).toContainEqual({ type: "setOpenrouterApiKeyAck", requestId: "r1", ok: true });
    expect(posted).toContainEqual({ type: "openrouterAuthStatusChanged", configured: true });
    expect(settingsManager.sendImageGenerationSettings).toHaveBeenCalled();
    expect(JSON.stringify(posted)).not.toContain("sk-or-1");
  });

  it("clears the key and reports OpenRouter signed out", async () => {
    const { platform, posted, send } = setup();
    await send({ type: "setOpenrouterApiKey", key: "sk-or-1", requestId: "r1" });

    await send({ type: "clearOpenrouterApiKey", requestId: "r2" });
    expect(await platform.secrets.get("damocles.explore.apiKey.openrouter")).toBeUndefined();
    expect(posted).toContainEqual({ type: "clearOpenrouterApiKeyAck", requestId: "r2", ok: true });
    expect(posted.filter((m) => m.type === "openrouterAuthStatusChanged").at(-1)).toEqual({ type: "openrouterAuthStatusChanged", configured: false });
  });

  it("rejects an empty key", async () => {
    const { platform, posted, send } = setup();
    await send({ type: "setOpenrouterApiKey", key: "", requestId: "r1" });
    expect(posted).toEqual([{ type: "setOpenrouterApiKeyAck", requestId: "r1", ok: false, error: "API key cannot be empty" }]);
    expect(await platform.secrets.get("damocles.explore.apiKey.openrouter")).toBeUndefined();
  });
});
