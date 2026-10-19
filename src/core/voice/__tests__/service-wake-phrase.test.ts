import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform, type FakePlatform } from "../../../__mocks__/fake-platform";
import type { ManagerConfig, SidecarManagerStatus } from "../sidecar";

const installs = vi.hoisted(() => ({ count: 0 }));
const managers = vi.hoisted(() => [] as { cfg: ManagerConfig; started: boolean; stopped: boolean }[]);

vi.mock("../runtime", () => ({
  DEFAULT_RUNTIME_DIR: "/fake/voice",
  getDefaultRuntimePaths: (rootDir: string) => ({
    rootDir,
    pythonExe: `${rootDir}/python`,
    venvDir: `${rootDir}/venv`,
    modelsDir: `${rootDir}/models`,
  }),
  VoiceRuntimeInstaller: class {
    async installAll(): Promise<{ ok: true; pythonExe: string }> {
      installs.count++;
      return { ok: true, pythonExe: "/fake/voice/python" };
    }
  },
}));

vi.mock("../sidecar", () => ({
  VoiceSidecarManager: class extends EventEmitter {
    private readonly record: { cfg: ManagerConfig; started: boolean; stopped: boolean };
    constructor(cfg: ManagerConfig) {
      super();
      this.record = { cfg, started: false, stopped: false };
      managers.push(this.record);
    }
    async start(): Promise<void> {
      this.record.started = true;
    }
    async stop(): Promise<void> {
      this.record.stopped = true;
    }
  },
}));

const { VoiceService } = await import("../service");

function setup(settings: Record<string, unknown>): { platform: FakePlatform; service: InstanceType<typeof VoiceService>; statuses: SidecarManagerStatus[] } {
  const platform = installFakePlatform({ settings: { user: settings } });
  const service = new VoiceService({ platform, rootDir: "/fake/voice" });
  const statuses: SidecarManagerStatus[] = [];
  service.on("status", (status) => statuses.push(status));
  return { platform, service, statuses };
}

describe("VoiceService wake phrase", () => {
  beforeEach(() => {
    installs.count = 0;
    managers.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("starts wake mode with the normalized phrase", async () => {
    const { service } = setup({ "damocles.voice.mode": "wake-word", "damocles.voice.wakeWord": "  OK_house Robot " });
    await service.ensureStarted({ install: true });
    expect(managers).toHaveLength(1);
    expect(managers[0]!.cfg.wakePhrase).toBe("ok house robot");
    expect(managers[0]!.started).toBe(true);
  });

  it("refuses wake mode with an invalid phrase before installing the runtime", async () => {
    const { service, statuses } = setup({ "damocles.voice.mode": "wake-word", "damocles.voice.wakeWord": "hey-jarvis" });
    await service.ensureStarted({ install: true });
    expect(installs.count).toBe(0);
    expect(managers).toHaveLength(0);
    expect(statuses).toEqual([
      {
        kind: "error",
        code: "fatal",
        message: "The damocles.voice.wakeWord setting is not a valid wake phrase: \"hey-jarvis\". Use 1 to 4 English words of letters only, such as \"hey jarvis\".",
      },
    ]);
  });

  it.each(["push-to-talk", "off"])("starts TTS in %s mode without a phrase, ignoring an invalid one", async (mode) => {
    const { service, statuses } = setup({
      "damocles.voice.mode": mode,
      "damocles.voice.tts.enabled": true,
      "damocles.voice.wakeWord": "hey-jarvis",
    });
    await service.ensureStarted({ install: true });
    expect(statuses).toEqual([]);
    expect(managers).toHaveLength(1);
    expect(managers[0]!.cfg.wakePhrase).toBeNull();
    expect(managers[0]!.started).toBe(true);
  });

  it("restarts the sidecar with the new phrase when the phrase changes in wake mode", async () => {
    const { platform, service } = setup({ "damocles.voice.mode": "wake-word", "damocles.voice.wakeWord": "hey jarvis" });
    service.registerWithExtension([]);
    await service.ensureStarted({ install: true });
    await platform.settings.update("damocles.voice.wakeWord", "computer", "user");
    await vi.waitFor(() => expect(managers).toHaveLength(2));
    expect(managers[0]!.stopped).toBe(true);
    expect(managers[1]!.cfg.wakePhrase).toBe("computer");
    await service.shutdown();
  });

  it("keeps the sidecar running when the phrase changes outside wake mode", async () => {
    const { platform, service } = setup({ "damocles.voice.mode": "push-to-talk", "damocles.voice.tts.enabled": true });
    service.registerWithExtension([]);
    await service.ensureStarted({ install: true });
    await platform.settings.update("damocles.voice.wakeWord", "computer", "user");
    // A restart would settle within this macrotask, since the fakes resolve on microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(managers).toHaveLength(1);
    expect(managers[0]!.stopped).toBe(false);
    await service.shutdown();
  });
});
