import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../__mocks__/fake-platform";
import type { SidecarManagerStatus } from "../sidecar";

const counts = vi.hoisted(() => ({ installs: 0, managers: 0 }));

vi.mock("../runtime", () => ({
  DEFAULT_RUNTIME_DIR: "/fake/voice",
  getDefaultRuntimePaths: (rootDir: string) => ({
    rootDir,
    pythonExe: `${rootDir}/python`,
    venvDir: `${rootDir}/venv`,
    modelsDir: `${rootDir}/models`,
  }),
  VoiceRuntimeInstaller: class {
    async installAll(): Promise<{ ok: false; pythonExe: string; errorMessage: string }> {
      counts.installs++;
      return { ok: false, pythonExe: "/fake/voice/python", errorMessage: "install failed" };
    }
  },
}));

vi.mock("../sidecar", () => ({
  VoiceSidecarManager: class extends EventEmitter {
    constructor() {
      super();
      counts.managers++;
    }
    async start(): Promise<void> {}
    async stop(): Promise<void> {}
  },
}));

const { VoiceService } = await import("../service");

const WINDOWS_ARM64_REFUSAL =
  "Jarvis voice mode (wake word and spoken replies) is not available on Windows arm64. Its local speech runtime supports only Windows x64, Linux x64, macOS arm64. Push-to-talk with cloud speech-to-text (Whisper, Deepgram or Google) still works.";

const original = { platform: process.platform, arch: process.arch };

function hostAs(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  Object.defineProperty(process, "arch", { value: arch, configurable: true });
}

function setup(settings: Record<string, unknown>): { service: InstanceType<typeof VoiceService>; statuses: SidecarManagerStatus[]; firstRuns: unknown[] } {
  const platform = installFakePlatform({ settings: { user: settings } });
  const service = new VoiceService({ platform, rootDir: "/fake/voice" });
  const statuses: SidecarManagerStatus[] = [];
  const firstRuns: unknown[] = [];
  service.on("status", (status) => statuses.push(status));
  service.on("firstRunRequired", (info) => firstRuns.push(info));
  return { service, statuses, firstRuns };
}

describe("VoiceService on an unsupported platform", () => {
  beforeEach(() => {
    counts.installs = 0;
    counts.managers = 0;
  });

  afterEach(() => {
    hostAs(original.platform, original.arch);
  });

  it.each([
    [{ "damocles.voice.mode": "wake-word" }],
    [{ "damocles.voice.mode": "push-to-talk", "damocles.voice.tts.enabled": true }],
    [{ "damocles.voice.mode": "wake-word", "damocles.voice.runtimePath": "C:\\venv\\python.exe" }],
  ])("reports the refusal and never installs or offers the first-run install (%o)", async (settings) => {
    const { service, statuses, firstRuns } = setup(settings);
    hostAs("win32", "arm64");
    await service.ensureStarted({ install: true });
    expect(statuses).toEqual([{ kind: "error", code: "unsupported-platform", message: WINDOWS_ARM64_REFUSAL }]);
    expect(firstRuns).toEqual([]);
    expect(counts.installs).toBe(0);
    expect(counts.managers).toBe(0);
  });

  it("still offers the first-run install when the install fails on a supported platform", async () => {
    const { service, statuses, firstRuns } = setup({ "damocles.voice.mode": "wake-word" });
    hostAs("win32", "x64");
    await service.ensureStarted({ install: true });
    expect(statuses).toEqual([]);
    expect(firstRuns).toEqual([{ reason: "missing-runtime" }]);
    expect(counts.installs).toBe(1);
  });
});
