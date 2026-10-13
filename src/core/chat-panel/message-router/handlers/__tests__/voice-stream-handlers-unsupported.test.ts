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
  compareInstalled: vi.fn(async () => ({ ok: false, missing: [], outdated: [OUTDATED] })),
  cleanupOldVersions: vi.fn(),
  downloadModel: vi.fn(),
}));

const { createVoiceStreamHandlers } = await import("../voice-stream-handlers");

const original = { platform: process.platform, arch: process.arch };

function hostAs(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

async function enableVoiceStream(): Promise<string[]> {
  const platform = installFakePlatform();
  const posted: string[] = [];
  const voiceService = {
    on: vi.fn(),
    off: vi.fn(),
    attachClient: () => () => {},
    isReady: () => false,
    start: vi.fn(async () => {}),
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
  expect(voiceService.start).toHaveBeenCalled();
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
});
