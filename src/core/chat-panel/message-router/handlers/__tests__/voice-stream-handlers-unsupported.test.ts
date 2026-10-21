import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../../../__mocks__/fake-platform";
import type { HandlerDependencies } from "../../types";
import type { PanelHost } from "../../../../../platform/window-service";

const OUTDATED = {
  id: "parakeet",
  version: "2",
  installedVersion: "1",
  description: "ASR",
  license: "CC-BY-4.0",
  license_url: "https://example.invalid/license",
  huggingface_repo: "example/parakeet",
  files: [{ bytes: 10 }],
  gated: false,
};

vi.mock("../../../../voice/models", () => ({
  loadManifest: vi.fn(async () => ({ models: [OUTDATED] })),
  cleanupOldVersions: vi.fn(),
  downloadModel: vi.fn(),
}));

const { createVoiceStreamHandlers } = await import("../voice-stream-handlers");

const original = { platform: process.platform, arch: process.arch };

function hostAs(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

async function enableVoiceStream(consented = true): Promise<string[]> {
  const platform = installFakePlatform();
  const posted: string[] = [];
  const voiceService = {
    on: vi.fn(),
    off: vi.fn(),
    attachClient: () => () => {},
    isReady: () => false,
    ensureStarted: vi.fn(async () => {}),
    failureMessage: () => null,
    downloadConsentGiven: async () => consented,
    missingModels: async () => [OUTDATED],
    getPaths: () => ({ rootDir: "/fake/voice", modelsDir: "/fake/voice/models", pythonExe: "/fake/python", venvDir: "/fake/venv" }),
  };
  const deps = {
    postMessage: (_host: PanelHost, message: { type: string }) => void posted.push(message.type),
    voiceService,
    platform,
    subscriptions: [],
  } as unknown as HandlerDependencies;
  const { handlers } = createVoiceStreamHandlers(deps);
  await handlers.voiceStreamEnable!({ type: "voiceStreamEnable" }, { host: {} as PanelHost } as never);
  expect(voiceService.ensureStarted).toHaveBeenCalledWith({ install: true });
  return posted;
}

describe("voiceStreamEnable model upgrade notice", () => {
  afterEach(() => {
    hostAs(original.platform, original.arch);
  });

  it("offers no model upgrade on a platform the runtime cannot install on", async () => {
    hostAs("win32", "arm64");
    expect(await enableVoiceStream()).not.toContain("voiceModelUpgradeAvailable");
  });

  it("offers the upgrade on a supported platform", async () => {
    hostAs("win32", "x64");
    expect(await enableVoiceStream()).toContain("voiceModelUpgradeAvailable");
  });

  it("leaves an outdated model to the first-run dialog until the user consented to downloads", async () => {
    hostAs("win32", "x64");
    expect(await enableVoiceStream(false)).not.toContain("voiceModelUpgradeAvailable");
  });
});
