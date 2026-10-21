import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../../__mocks__/fake-platform";
import type { HandlerDependencies } from "../../types";
import type { PanelHost } from "../../../../../platform/window-service";

const PARAKEET = {
  id: "parakeet",
  version: "2",
  description: "ASR",
  license: "CC-BY-4.0",
  license_url: "https://example.invalid/license",
  huggingface_repo: "example/parakeet",
  files: [{ bytes: 10 }],
  gated: false,
};

const models = vi.hoisted(() => ({
  missing: [] as unknown[],
  downloadModel: async (): Promise<{ status: string }> => ({ status: "downloaded" }),
}));

vi.mock("../../../../voice/models", () => ({
  loadManifest: async () => ({ models: [PARAKEET] }),
  cleanupOldVersions: async () => ({ removed: [], bytesFreed: 0 }),
  downloadModel: () => models.downloadModel(),
}));

const { createVoiceStreamHandlers } = await import("../voice-stream-handlers");

type Posted = { type: string; state?: string; message?: string };

// Answers as VoiceService does when every start under the current settings fails with `reason`.
function failingVoiceService(reason: string) {
  return {
    on: vi.fn(),
    off: vi.fn(),
    attachClient: () => () => {},
    isReady: () => false,
    ensureStarted: vi.fn(async (_opts: { install: boolean; retry?: boolean }) => {}),
    recordDownloadConsent: vi.fn(async () => {}),
    missingModels: async () => models.missing,
    failureMessage: () => reason,
    ttsRequest: vi.fn(),
    getPaths: () => ({ rootDir: "/fake/voice", modelsDir: "/fake/voice/models", pythonExe: "/fake/python", venvDir: "/fake/venv" }),
  };
}

function setup(reason: string) {
  const platform = installFakePlatform({ settings: { user: { "damocles.voice.mode": "wake-word", "damocles.voice.tts.enabled": true } } });
  const posted: Posted[] = [];
  const voiceService = failingVoiceService(reason);
  const deps = {
    postMessage: (_host: PanelHost, message: Posted) => void posted.push(message),
    voiceService,
    platform,
    subscriptions: [],
  } as unknown as HandlerDependencies;
  const { handlers } = createVoiceStreamHandlers(deps);
  const ctx = { host: {} as PanelHost } as never;
  return { handlers, voiceService, posted, ctx };
}

const REASON = "The voice runtime needs about 16.5 GB free on the disk holding /fake/voice, and 4.0 GB is free. Free disk space and try again.";

describe("voice start failures reach the user", () => {
  beforeEach(() => {
    models.missing = [];
    models.downloadModel = async () => ({ status: "downloaded" });
  });

  it("Test voice reports why the runtime did not start", async () => {
    const { handlers, voiceService, posted, ctx } = setup(REASON);
    await handlers.voiceTestVoice!({ type: "voiceTestVoice" }, ctx);
    expect(voiceService.ensureStarted).toHaveBeenCalledWith({ install: true, retry: true });
    expect(posted).toEqual([{ type: "voiceSidecarStatus", state: "error", message: REASON }]);
    expect(voiceService.ttsRequest).not.toHaveBeenCalled();
  });

  it("enabling wake-word mode reports why the runtime did not start", async () => {
    const { handlers, voiceService, posted, ctx } = setup(REASON);
    await handlers.voiceStreamEnable!({ type: "voiceStreamEnable" }, ctx);
    expect(voiceService.ensureStarted).toHaveBeenCalledWith({ install: true });
    expect(posted).toContainEqual({ type: "voiceSidecarStatus", state: "error", message: REASON });
  });

  describe("accepting the first-run modal", () => {
    it("installs the runtime and starts voice once the models are in place", async () => {
      const { handlers, voiceService, posted, ctx } = setup(REASON);
      models.missing = [PARAKEET];
      await handlers.voiceAcceptFirstRunModal!({ type: "voiceAcceptFirstRunModal" }, ctx);
      expect(posted.map((m) => m.type)).toContain("voiceModelDownloadAllDone");
      expect(voiceService.ensureStarted).toHaveBeenCalledWith({ install: true, retry: true });
      expect(posted).toContainEqual({ type: "voiceSidecarStatus", state: "error", message: REASON });
    });

    it("does not start voice when a model download failed", async () => {
      const { handlers, voiceService, ctx } = setup(REASON);
      models.missing = [PARAKEET];
      models.downloadModel = async () => {
        throw new Error("HTTP 503");
      };
      await handlers.voiceAcceptFirstRunModal!({ type: "voiceAcceptFirstRunModal" }, ctx);
      expect(voiceService.recordDownloadConsent).toHaveBeenCalledOnce();
      expect(voiceService.ensureStarted).not.toHaveBeenCalled();
    });
  });
});
