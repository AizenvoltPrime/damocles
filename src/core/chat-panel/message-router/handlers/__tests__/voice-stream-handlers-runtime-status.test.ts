import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../../__mocks__/fake-platform";
import type { HandlerDependencies } from "../../types";
import type { PanelHost } from "../../../../../platform/window-service";
import type { VoiceRuntimeStatus } from "../../../../../shared/types/voice";
import { createVoiceStreamHandlers, postVoiceRuntimeStatus } from "../voice-stream-handlers";

function setup() {
  const platform = installFakePlatform({ settings: { user: { "damocles.voice.mode": "off", "damocles.voice.tts.enabled": true } } });
  const calls: string[] = [];
  const voiceService = Object.assign(new EventEmitter(), {
    runtimeStatus: (): VoiceRuntimeStatus => ({ kind: "needs-install", message: { message: "The voice runtime is not installed." }, consentRequired: true }),
    install: vi.fn(async () => {}),
    cancelStart: vi.fn(),
    calls,
    recordDownloadConsent: vi.fn(async () => void calls.push("consent")),
    ensureStarted: vi.fn(async () => {}),
    missingModels: vi.fn(async () => []),
    getPaths: () => ({ rootDir: "/voice", modelsDir: "/voice/models" }),
    isReady: () => false,
    failureMessage: (): string | null => "pip install failed",
  });
  const hosts = ["a", "b", "c"].map((name) => ({ name }) as unknown as PanelHost);
  const panels = new Map(hosts.map((host, index) => [`panel-${index}`, { host }]));
  const posted: { host: PanelHost; message: unknown }[] = [];
  const subscriptions: { dispose(): void }[] = [];
  const deps = {
    postMessage: (host: PanelHost, message: unknown) => void posted.push({ host, message }),
    getPanels: () => panels,
    voiceService,
    platform,
    subscriptions,
  } as unknown as HandlerDependencies;
  const { handlers } = createVoiceStreamHandlers(deps);
  return { deps, handlers, voiceService, hosts, posted, subscriptions, ctx: { host: hosts[0] } as never };
}

describe("voice runtime status", () => {
  it("reaches every panel, not only the one that turned voice on", () => {
    const { voiceService, hosts, posted } = setup();
    const status: VoiceRuntimeStatus = { kind: "starting", stage: "installing-pip", pct: 80, installing: true };
    voiceService.emit("runtimeStatus", status);
    expect(posted).toEqual(hosts.map((host) => ({ host, message: { type: "voiceRuntimeStatus", status } })));
  });

  it("stops reaching panels once its handlers are disposed", () => {
    const { voiceService, posted, subscriptions } = setup();
    for (const subscription of subscriptions) subscription.dispose();
    voiceService.emit("runtimeStatus", { kind: "ready" });
    expect(posted).toEqual([]);
  });

  it("posts the current status to a panel that loads", () => {
    const { deps, hosts, posted } = setup();
    postVoiceRuntimeStatus(deps, hosts[1]!);
    expect(posted).toEqual([{ host: hosts[1], message: { type: "voiceRuntimeStatus", status: { kind: "needs-install", message: { message: "The voice runtime is not installed." }, consentRequired: true } } }]);
  });

  it("installs and cancels on request, and shows a failed install in the chat input", async () => {
    const { handlers, voiceService, ctx, hosts, posted } = setup();
    await handlers.voiceRuntimeInstall!({ type: "voiceRuntimeInstall" }, ctx);
    expect(voiceService.install).toHaveBeenCalledOnce();
    expect(voiceService.recordDownloadConsent).not.toHaveBeenCalled();
    expect(posted).toEqual([{ host: hosts[0], message: { type: "voiceSidecarStatus", state: "error", message: "pip install failed" } }]);
    await handlers.voiceRuntimeCancel!({ type: "voiceRuntimeCancel" }, ctx);
    expect(voiceService.cancelStart).toHaveBeenCalledOnce();
  });

  it("records the consent the Settings dialog asked for before it installs", async () => {
    const { handlers, voiceService, ctx } = setup();
    voiceService.install.mockImplementation(async () => void voiceService.calls.push("install"));
    await handlers.voiceRuntimeInstall!({ type: "voiceRuntimeInstall", consent: true }, ctx);
    expect(voiceService.calls).toEqual(["consent", "install"]);
  });

  it("records the consent when the first-run dialog is accepted, then downloads what the settings need and starts", async () => {
    const { handlers, voiceService, ctx } = setup();
    await handlers.voiceAcceptFirstRunModal!({ type: "voiceAcceptFirstRunModal" }, ctx);
    expect(voiceService.calls).toEqual(["consent"]);
    expect(voiceService.missingModels).toHaveBeenCalledOnce();
    expect(voiceService.ensureStarted).toHaveBeenCalledWith({ install: true, retry: true });
  });
});
