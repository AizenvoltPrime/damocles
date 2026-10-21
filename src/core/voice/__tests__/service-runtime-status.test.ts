import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../__mocks__/fake-platform";
import type { RuntimeProgress } from "../runtime";
import type { SidecarManagerStatus } from "../sidecar";
import type { VoiceRuntimeStatus } from "../../../shared/types/voice";

type InstallResult = { ok: boolean; pythonExe: string; errorMessage?: string; missing?: "runtime" | "models" };
type InstallOpts = { allowInstall: boolean; signal: AbortSignal; onProgress: (p: RuntimeProgress) => void };

const consent = vi.hoisted(() => ({ given: true }));
const logged = vi.hoisted(() => [] as string[]);

vi.mock("../consent", () => ({
  voiceDownloadConsentIn: () => ({
    given: async () => consent.given,
    record: async () => void (consent.given = true),
  }),
}));

vi.mock("../../logger", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  log: (...args: unknown[]) => void logged.push(args.map(String).join(" ")),
}));

const runtime = vi.hoisted(() => ({
  calls: [] as { allowInstall: boolean }[],
  results: [] as InstallResult[],
  // Runs inside installAll before it answers; an install that sees its signal abort answers as the installer does.
  script: null as ((opts: InstallOpts) => Promise<void>) | null,
}));

vi.mock("../runtime", () => ({
  DEFAULT_RUNTIME_DIR: "/fake/voice",
  getDefaultRuntimePaths: (rootDir: string) => ({ rootDir, pythonExe: `${rootDir}/python`, venvDir: `${rootDir}/venv`, modelsDir: `${rootDir}/models` }),
  VoiceRuntimeInstaller: class {
    async installAll(opts: InstallOpts): Promise<InstallResult> {
      runtime.calls.push({ allowInstall: opts.allowInstall });
      const script = runtime.script;
      runtime.script = null;
      if (script) await script(opts);
      if (opts.signal.aborted) return { ok: false, pythonExe: "/fake/voice/python", errorMessage: "The operation was cancelled." };
      return runtime.results.shift() ?? { ok: true, pythonExe: "/fake/voice/python" };
    }
  },
}));

vi.mock("../sidecar", () => ({
  VoiceSidecarManager: class extends EventEmitter {
    private status: SidecarManagerStatus = { kind: "stopped" };
    async start(): Promise<void> {
      this.setStatus({ kind: "ready", device: "cpu", vramMbFree: 0, modelsLoaded: [], cpuFallbackActive: false });
    }
    async stop(): Promise<void> {
      this.setStatus({ kind: "stopped" });
    }
    isAlive(): boolean {
      return this.status.kind === "ready";
    }
    getStatus(): SidecarManagerStatus {
      return this.status;
    }
    send(): void {}
    setStatus(status: SidecarManagerStatus): void {
      this.status = status;
      this.emit("status", status);
    }
  },
}));

const { VoiceService } = await import("../service");

const failed = (errorMessage: string): InstallResult => ({ ok: false, pythonExe: "/fake/voice/python", errorMessage });
const notInstalled = (missing: "runtime" | "models" = "runtime"): InstallResult => ({ ...failed("The voice runtime is not installed."), missing });

function ttsService(settings: Record<string, unknown> = { "damocles.voice.mode": "off", "damocles.voice.tts.enabled": true }) {
  const platform = installFakePlatform({ settings: { user: settings } });
  const service = new VoiceService({ platform, rootDir: "/fake/voice" });
  const statuses: VoiceRuntimeStatus[] = [];
  service.on("runtimeStatus", (status) => statuses.push(status));
  const notices: { reason: string; origin: string }[] = [];
  service.on("replyNotSpoken", (notice) => notices.push(notice));
  return { platform, service, statuses, notices };
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
}

describe("VoiceService runtime status", () => {
  beforeEach(() => {
    consent.given = true;
    logged.length = 0;
    runtime.calls.length = 0;
    runtime.results.length = 0;
    runtime.script = null;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is not-needed with neither the wake word nor spoken replies on, and idle before any start", () => {
    expect(ttsService({ "damocles.voice.mode": "push-to-talk", "damocles.voice.tts.enabled": false }).service.runtimeStatus()).toEqual({ kind: "not-needed" });
    expect(ttsService().service.runtimeStatus()).toEqual({ kind: "idle" });
  });

  it("reports each install stage, then ready", async () => {
    const { service, statuses } = ttsService();
    runtime.script = async ({ onProgress }) => {
      onProgress({ stage: "detecting", pct: 0, message: "" });
      onProgress({ stage: "downloading-python", pct: 30, message: "" });
      onProgress({ stage: "extracting-python", pct: 65, message: "" });
      onProgress({ stage: "installing-pip", pct: 80, message: "" });
      onProgress({ stage: "done", pct: 100, message: "" });
    };
    await service.install();
    expect(statuses).toEqual([
      { kind: "idle" },
      { kind: "starting", stage: "detecting", pct: 0, installing: false },
      { kind: "starting", stage: "downloading-python", pct: 30, installing: true },
      { kind: "starting", stage: "extracting-python", pct: 65, installing: true },
      { kind: "starting", stage: "installing-pip", pct: 80, installing: true },
      { kind: "starting", stage: "launching", pct: 100, installing: true },
      { kind: "ready" },
    ]);
    expect(runtime.calls).toEqual([{ allowInstall: true }]);
  });

  it("emits at most four times a second within a stage", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { service, statuses } = ttsService();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    runtime.script = async ({ onProgress }) => {
      for (let pct = 1; pct <= 50; pct++) onProgress({ stage: "downloading-python", pct, message: "" });
      await held;
    };
    const start = service.install();
    // vi.waitFor would advance the fake clock past the throttle.
    while (runtime.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    expect(statuses.filter((s) => s.kind === "starting" && s.stage === "downloading-python")).toEqual([
      { kind: "starting", stage: "downloading-python", pct: 1, installing: true },
    ]);
    vi.advanceTimersByTime(250);
    expect(statuses.at(-1)).toEqual({ kind: "starting", stage: "downloading-python", pct: 50, installing: true });
    release();
    await start;
    expect(statuses.at(-1)).toEqual({ kind: "ready" });
  });

  it("gives needs-install for a failed start that could not install, and failed for one that could", async () => {
    const { service } = ttsService();
    runtime.results.push(failed("The voice runtime is not installed."), failed("pip install failed"));
    await service.ensureStarted({ install: false });
    expect(service.runtimeStatus()).toEqual({ kind: "needs-install", message: "The voice runtime is not installed.", consentRequired: false });
    await service.install();
    expect(service.runtimeStatus()).toEqual({ kind: "failed", message: "pip install failed" });
    await service.install();
    expect(service.runtimeStatus()).toEqual({ kind: "ready" });
  });

  describe("cancelling the start in flight", () => {
    it("gives cancelled, records no failure, and starts nothing more until an install", async () => {
      const { service, statuses } = ttsService();
      runtime.script = async ({ onProgress, signal }) => {
        onProgress({ stage: "downloading-python", pct: 12, message: "" });
        await untilAborted(signal);
      };
      const start = service.install();
      await vi.waitFor(() => expect(service.runtimeStatus()).toMatchObject({ kind: "starting", stage: "downloading-python" }));
      service.cancelStart();
      expect(statuses.at(-1)).toEqual({ kind: "cancelled" });
      await start;
      await vi.waitFor(() => expect(service.runtimeStatus()).toEqual({ kind: "cancelled" }));
      expect(service.failureMessage()).toBeNull();

      await service.ensureStarted({ install: false });
      await service.ensureStarted({ install: true });
      expect(runtime.calls).toEqual([{ allowInstall: true }]);

      await service.install();
      expect(runtime.calls).toEqual([{ allowInstall: true }, { allowInstall: true }]);
      expect(service.runtimeStatus()).toEqual({ kind: "ready" });
    });

    it("does nothing when no start is in flight", async () => {
      const { service } = ttsService();
      await service.install();
      service.cancelStart();
      expect(service.runtimeStatus()).toEqual({ kind: "ready" });
    });
  });

  it("shows no progress bar for a start that installs nothing", async () => {
    const { service, statuses } = ttsService();
    runtime.script = async ({ onProgress }) => {
      onProgress({ stage: "detecting", pct: 0, message: "" });
      onProgress({ stage: "smoke-check", pct: 10, message: "" });
    };
    await service.ensureStarted({ install: true });
    expect(statuses.filter((s) => s.kind === "starting").every((s) => s.kind === "starting" && !s.installing)).toBe(true);
    expect(statuses.at(-1)).toEqual({ kind: "ready" });
  });

  it("logs pip's output at most once a second, and each model's download once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service } = ttsService();
    runtime.script = async ({ onProgress }) => {
      for (let line = 0; line < 500; line++) onProgress({ stage: "installing-pip", pct: 85, message: `Downloading torch ${line}` });
      vi.advanceTimersByTime(1000);
      onProgress({ stage: "installing-pip", pct: 85, message: "Installing collected packages" });
      for (const model of ["asr", "asr", "vad", "vad"]) onProgress({ stage: "downloading-models", pct: 50, message: `Downloading the ${model} model...` });
    };
    await service.install();
    expect(logged.filter((line) => line.includes("runtime installing-pip"))).toEqual([
      "[VoiceService] runtime installing-pip: Downloading torch 0",
      "[VoiceService] runtime installing-pip: Installing collected packages",
    ]);
    expect(logged.filter((line) => line.includes("runtime downloading-models"))).toEqual([
      "[VoiceService] runtime downloading-models: Downloading the asr model...",
      "[VoiceService] runtime downloading-models: Downloading the vad model...",
    ]);
  });

  describe("the download consent", () => {
    it("downloads nothing before the user consented, and asks through the first-run dialog", async () => {
      consent.given = false;
      const { service } = ttsService({ "damocles.voice.mode": "wake-word" });
      const asked: string[] = [];
      service.on("firstRunRequired", ({ reason }) => asked.push(reason));
      runtime.results.push(notInstalled("models"));

      await service.ensureStarted({ install: true });

      expect(runtime.calls).toEqual([{ allowInstall: false }]);
      expect(asked).toEqual(["missing-models"]);
      expect(service.runtimeStatus()).toEqual({ kind: "needs-install", message: "The voice runtime is not installed.", consentRequired: true });
    });

    it("installs once the consent is recorded", async () => {
      consent.given = false;
      const { service } = ttsService();
      runtime.results.push(notInstalled());
      await service.ensureStarted({ install: true });

      await service.recordDownloadConsent();
      await service.install();

      expect(runtime.calls).toEqual([{ allowInstall: false }, { allowInstall: true }]);
      expect(service.runtimeStatus()).toEqual({ kind: "ready" });
    });

    it("starts an installed runtime without asking", async () => {
      consent.given = false;
      const { service } = ttsService();
      const asked: string[] = [];
      service.on("firstRunRequired", ({ reason }) => asked.push(reason));

      await service.ensureStarted({ install: true });

      expect(runtime.calls).toEqual([{ allowInstall: false }]);
      expect(asked).toEqual([]);
      expect(service.runtimeStatus()).toEqual({ kind: "ready" });
    });

    it("never asks from a reply, from Settings' own Install, or for a failure no download fixes", async () => {
      consent.given = false;
      const { service } = ttsService();
      const asked: string[] = [];
      service.on("firstRunRequired", ({ reason }) => asked.push(reason));
      runtime.results.push(notInstalled(), notInstalled(), failed("Voice GPU is set to \"cuda\" but no GPU was found."));

      await service.speakReply("hello", "chat-1");
      await service.install();
      await service.restart();

      expect(asked).toEqual([]);
      expect(runtime.calls).toEqual([{ allowInstall: false }, { allowInstall: false }, { allowInstall: false }]);
      expect(service.runtimeStatus()).toEqual({ kind: "needs-install", message: "Voice GPU is set to \"cuda\" but no GPU was found.", consentRequired: false });
    });
  });

  describe("a start after a cancel", () => {
    it("shows its own progress and reports its own failure, once", async () => {
      const { service, notices } = ttsService();
      runtime.script = async ({ onProgress, signal }) => {
        onProgress({ stage: "downloading-python", pct: 12, message: "" });
        await untilAborted(signal);
      };
      const cancelled = service.install();
      await vi.waitFor(() => expect(service.runtimeStatus()).toMatchObject({ kind: "starting" }));
      service.cancelStart();
      await cancelled;
      await vi.waitFor(() => expect(service.runtimeStatus()).toEqual({ kind: "cancelled" }));
      await service.speakReply("while cancelled", "chat-1");

      let release!: () => void;
      runtime.script = async ({ onProgress }) => {
        onProgress({ stage: "installing-pip", pct: 80, message: "" });
        await new Promise<void>((resolve) => (release = resolve));
      };
      runtime.results.push(failed("pip install failed"));
      const retried = service.ensureStarted({ install: true, retry: true });
      await vi.waitFor(() => expect(service.runtimeStatus()).toEqual({ kind: "starting", stage: "installing-pip", pct: 80, installing: true }));
      release();
      await retried;

      expect(service.runtimeStatus()).toEqual({ kind: "failed", message: "pip install failed" });
      await service.speakReply("after the retry", "chat-1");
      expect(notices).toEqual([
        { reason: "Starting the voice runtime was cancelled.", origin: "chat-1" },
        { reason: "pip install failed", origin: "chat-1" },
      ]);
    });
  });

  describe("a reply that cannot be spoken", () => {
    it("is reported once across five failed replies, and again after a settings change", async () => {
      const { platform, service, notices } = ttsService();
      runtime.results.push(failed("The voice runtime is not installed."), failed("The voice runtime is not installed."));
      for (let reply = 0; reply < 5; reply++) await service.speakReply(`reply ${reply}`, "chat-1");
      expect(notices).toEqual([{ reason: "The voice runtime is not installed.", origin: "chat-1" }]);
      expect(runtime.calls).toEqual([{ allowInstall: false }]);

      await platform.settings.update("damocles.voice.localGpu", "cpu", "user");
      await service.speakReply("after the change", "chat-2");
      await service.speakReply("and again", "chat-2");
      expect(notices).toEqual([
        { reason: "The voice runtime is not installed.", origin: "chat-1" },
        { reason: "The voice runtime is not installed.", origin: "chat-2" },
      ]);
    });

    it("is reported again for a failure after the runtime was ready", async () => {
      const { service, notices } = ttsService();
      runtime.results.push(failed("The voice runtime is not installed."));
      await service.speakReply("first", "chat-1");
      await service.install();
      await service.speakReply("spoken", "chat-1");
      expect(notices).toHaveLength(1);

      runtime.results.push(failed("smoke check failed"));
      await service.stop();
      await service.install();
      await service.speakReply("second", "chat-1");
      expect(notices).toEqual([
        { reason: "The voice runtime is not installed.", origin: "chat-1" },
        { reason: "smoke check failed", origin: "chat-1" },
      ]);
    });
  });
});
