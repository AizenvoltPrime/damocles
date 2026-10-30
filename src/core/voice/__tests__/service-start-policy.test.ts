import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installFakePlatform } from "../../../__mocks__/fake-platform";
import type { SidecarInbound, SidecarManagerStatus } from "../sidecar";
import type { LocalizedText } from "../../../shared/localized-text";
import { verbatim } from "../../l10n";

type InstallResult = { ok: boolean; pythonExe: string; errorMessage?: LocalizedText; missing?: "runtime" | "models" };

const consent = vi.hoisted(() => ({ given: true }));

vi.mock("../consent", () => ({
  voiceDownloadConsentIn: () => ({
    given: async () => consent.given,
    record: async () => void (consent.given = true),
  }),
}));

const runtime = vi.hoisted(() => ({
  calls: [] as { allowInstall: boolean }[],
  // one result per installAll call, in order; a call past the end succeeds
  results: [] as (InstallResult | Error)[],
  gate: null as Promise<void> | null,
  active: 0,
  maxActive: 0,
}));

const sidecars = vi.hoisted(() => ({
  all: [] as {
    started: boolean;
    stopped: boolean;
    sent: unknown[];
    setStatus(status: unknown): void;
  }[],
  // a sidecar started while another still ran
  overlaps: 0,
  startGate: null as Promise<void> | null,
  stopGate: null as Promise<void> | null,
}));

vi.mock("../runtime", () => ({
  DEFAULT_RUNTIME_DIR: "/fake/voice",
  getDefaultRuntimePaths: (rootDir: string) => ({ rootDir, pythonExe: `${rootDir}/python`, venvDir: `${rootDir}/venv`, modelsDir: `${rootDir}/models` }),
  VoiceRuntimeInstaller: class {
    async installAll(opts: { allowInstall: boolean }): Promise<InstallResult> {
      runtime.calls.push({ allowInstall: opts.allowInstall });
      runtime.active++;
      runtime.maxActive = Math.max(runtime.maxActive, runtime.active);
      try {
        const result = runtime.results.shift() ?? { ok: true, pythonExe: "/fake/voice/python" };
        const gate = runtime.gate;
        runtime.gate = null;
        if (gate) await gate;
        if (result instanceof Error) throw result;
        return result;
      } finally {
        runtime.active--;
      }
    }
  },
}));

vi.mock("../sidecar", () => ({
  // Mirrors VoiceSidecarManager: not alive from the moment a stop begins, and concurrent stops share one run.
  VoiceSidecarManager: class extends EventEmitter {
    started = false;
    stopped = false;
    sent: unknown[] = [];
    private stopping = false;
    private status: SidecarManagerStatus = { kind: "stopped" };
    private stopRun: Promise<void> | null = null;
    constructor() {
      super();
      sidecars.all.push(this);
    }
    async start(): Promise<void> {
      if (sidecars.all.some((other) => other !== this && other.started && !other.stopped)) sidecars.overlaps++;
      this.started = true;
      const gate = sidecars.startGate;
      sidecars.startGate = null;
      if (gate) await gate;
      this.setStatus({ kind: "ready", device: "cpu", vramMbFree: 0, modelsLoaded: [], cpuFallbackActive: false });
    }
    stop(): Promise<void> {
      this.stopRun ??= (async () => {
        this.stopping = true;
        const gate = sidecars.stopGate;
        if (gate) await gate;
        this.stopped = true;
        this.setStatus({ kind: "stopped" });
      })();
      return this.stopRun;
    }
    isAlive(): boolean {
      return !this.stopping && this.status.kind === "ready";
    }
    getStatus(): SidecarManagerStatus {
      return this.status;
    }
    send(msg: SidecarInbound): void {
      this.sent.push(msg);
    }
    setStatus(status: SidecarManagerStatus): void {
      this.status = status;
      this.emit("status", status);
    }
  },
}));

const { VoiceService } = await import("../service");

const failed = (errorMessage: LocalizedText): InstallResult => ({ ok: false, pythonExe: "/fake/voice/python", errorMessage });

function ttsService() {
  const platform = installFakePlatform({ settings: { user: { "damocles.voice.mode": "off", "damocles.voice.tts.enabled": true } } });
  return { platform, service: new VoiceService({ platform, rootDir: "/fake/voice" }) };
}

function gate(): { promise: Promise<void>; open: () => void } {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}

const running = () => sidecars.all.filter((s) => s.started && !s.stopped);
const spoken = () => sidecars.all.flatMap((s) => s.sent).map((m) => (m as { text?: string }).text);

describe("VoiceService start policy", () => {
  beforeEach(() => {
    consent.given = true;
    runtime.calls.length = 0;
    runtime.results.length = 0;
    runtime.gate = null;
    runtime.active = 0;
    runtime.maxActive = 0;
    sidecars.all.length = 0;
    sidecars.overlaps = 0;
    sidecars.startGate = null;
    sidecars.stopGate = null;
  });

  it("only verifies the runtime for a start that may not install", async () => {
    const { service } = ttsService();
    await service.ensureStarted({ install: false });
    expect(runtime.calls).toEqual([{ allowInstall: false }]);
    expect(service.isReady()).toBe(true);
  });

  it("joins the start in flight instead of cancelling it", async () => {
    const { service } = ttsService();
    const install = gate();
    runtime.gate = install.promise;
    const first = service.ensureStarted({ install: true });
    const second = service.ensureStarted({ install: false });
    install.open();
    await Promise.all([first, second]);
    expect(runtime.calls).toEqual([{ allowInstall: true }]);
    expect(service.isReady()).toBe(true);
  });

  it("does not repeat a failed start under the same settings until a retry or a settings change", async () => {
    const { platform, service } = ttsService();
    runtime.results.push(failed({ message: "The voice runtime is not installed." }), failed(verbatim("pip install failed")), failed(verbatim("pip install failed")));
    await service.ensureStarted({ install: false });
    await service.ensureStarted({ install: false });
    expect(runtime.calls).toEqual([{ allowInstall: false }]);

    // A verify failure does not stop a caller that may install; an install failure stops both.
    await service.ensureStarted({ install: true });
    await service.ensureStarted({ install: true });
    await service.ensureStarted({ install: false });
    expect(runtime.calls).toEqual([{ allowInstall: false }, { allowInstall: true }]);
    expect(service.failureMessage()).toEqual(verbatim("pip install failed"));

    await service.ensureStarted({ install: true, retry: true });
    expect(runtime.calls).toHaveLength(3);

    await platform.settings.update("damocles.voice.localGpu", "cpu", "user");
    expect(service.failureMessage()).toBeNull();
    await service.ensureStarted({ install: false });
    expect(runtime.calls).toHaveLength(4);
    expect(service.isReady()).toBe(true);
  });

  it("installs after a joined start that could not, when the caller may install", async () => {
    const { service } = ttsService();
    const verify = gate();
    runtime.gate = verify.promise;
    runtime.results.push(failed({ message: "The voice runtime is not installed." }));
    const reply = service.ensureStarted({ install: false });
    const enable = service.ensureStarted({ install: true });
    verify.open();
    await Promise.all([reply, enable]);
    expect(runtime.calls).toEqual([{ allowInstall: false }, { allowInstall: true }]);
    expect(service.isReady()).toBe(true);
  });

  describe("one start at a time", () => {
    it("restarts once when a reply waits on the start that restart cancels", async () => {
      const { service } = ttsService();
      const verify = gate();
      runtime.gate = verify.promise;
      const first = service.ensureStarted({ install: false });
      const waiting = service.ensureStarted({ install: false });
      await vi.waitFor(() => expect(runtime.calls).toHaveLength(1));
      const restart = service.restart();
      verify.open();
      await Promise.all([first, waiting, restart]);

      expect(runtime.maxActive).toBe(1);
      expect(runtime.calls).toEqual([{ allowInstall: false }, { allowInstall: true }]);
      expect(sidecars.overlaps).toBe(0);
      expect(running()).toHaveLength(1);
      expect(service.isReady()).toBe(true);
      await service.stop();
      expect(running()).toEqual([]);
    });

    it("lets no reply start a sidecar while restart stops the old one", async () => {
      const { service } = ttsService();
      await service.ensureStarted({ install: true });
      const stopping = gate();
      sidecars.stopGate = stopping.promise;
      const restart = service.restart();
      // The old sidecar is no longer alive while its stop runs.
      await vi.waitFor(() => expect(service.isReady()).toBe(false));
      const reply = service.ensureStarted({ install: false });
      stopping.open();
      sidecars.stopGate = null;
      await Promise.all([restart, reply]);

      expect(runtime.maxActive).toBe(1);
      expect(runtime.calls).toEqual([{ allowInstall: true }, { allowInstall: true }]);
      expect(sidecars.all).toHaveLength(2);
      expect(sidecars.overlaps).toBe(0);
      expect(service.isReady()).toBe(true);
      await service.stop();
      expect(running()).toEqual([]);
    });

    it("spawns the next sidecar only once the one a restart aborted mid-spawn has stopped", async () => {
      const { service } = ttsService();
      const spawn = gate();
      sidecars.startGate = spawn.promise;
      const first = service.ensureStarted({ install: false });
      await vi.waitFor(() => expect(sidecars.all).toHaveLength(1));
      const stopping = gate();
      sidecars.stopGate = stopping.promise;
      const restart = service.restart();
      spawn.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sidecars.all).toHaveLength(1);
      stopping.open();
      sidecars.stopGate = null;
      await Promise.all([first, restart]);

      expect(sidecars.overlaps).toBe(0);
      expect(sidecars.all).toHaveLength(2);
      expect(running()).toEqual([sidecars.all[1]]);
      expect(service.isReady()).toBe(true);
    });

    it("keeps only the latest of several restarts and leaves no sidecar behind", async () => {
      const { service } = ttsService();
      const install = gate();
      runtime.gate = install.promise;
      const starts = [service.restart(), service.ensureStarted({ install: false }), service.restart(), service.restart()];
      install.open();
      await Promise.all(starts);

      expect(runtime.maxActive).toBe(1);
      expect(sidecars.overlaps).toBe(0);
      expect(running()).toHaveLength(1);
      await service.stop();
      expect(running()).toEqual([]);
    });
  });

  it("records a start that throws as its failure, so its callers resolve and none launches it again", async () => {
    const { service } = ttsService();
    const install = gate();
    runtime.gate = install.promise;
    runtime.results.push(new Error("EACCES: permission denied, mkdir '/fake/voice'"));
    const enable = service.ensureStarted({ install: true });
    const reply = service.ensureStarted({ install: false });
    install.open();
    await expect(Promise.all([enable, reply])).resolves.toBeDefined();
    expect(service.failureMessage()).toEqual(verbatim("EACCES: permission denied, mkdir '/fake/voice'"));

    await service.ensureStarted({ install: true });
    await service.ensureStarted({ install: false });
    expect(runtime.calls).toHaveLength(1);
  });

  describe("a sidecar that fails after it became ready", () => {
    it("is not started again under the same settings until a retry", async () => {
      const { service } = ttsService();
      await service.ensureStarted({ install: false });
      sidecars.all[0]!.setStatus({ kind: "error", code: "crash-loop", message: { message: "The voice helper process stopped unexpectedly too many times, so Damocles no longer restarts it." } });

      await service.ensureStarted({ install: false });
      await service.ensureStarted({ install: true });
      expect(runtime.calls).toHaveLength(1);
      expect(sidecars.all).toHaveLength(1);
      expect(service.failureMessage()).toEqual({ message: "The voice helper process stopped unexpectedly too many times, so Damocles no longer restarts it." });

      await service.ensureStarted({ install: true, retry: true });
      expect(sidecars.all).toHaveLength(2);
      expect(service.isReady()).toBe(true);
      expect(service.failureMessage()).toBeNull();
    });

    it("is left to restart itself instead of being replaced by a reply", async () => {
      const { service } = ttsService();
      await service.ensureStarted({ install: false });
      sidecars.all[0]!.setStatus({ kind: "restarting", attempt: 1 });
      await service.ensureStarted({ install: false });
      expect(runtime.calls).toHaveLength(1);
      expect(sidecars.all).toHaveLength(1);
      expect(sidecars.all[0]!.stopped).toBe(false);
    });
  });

  it("offers the first-run install only for a start that could have installed", async () => {
    consent.given = false;
    const { service } = ttsService();
    const firstRuns: unknown[] = [];
    service.on("firstRunRequired", (info) => firstRuns.push(info));
    const notInstalled = { ...failed({ message: "The voice runtime is not installed." }), missing: "runtime" as const };
    runtime.results.push(notInstalled, notInstalled);
    await service.ensureStarted({ install: false });
    expect(firstRuns).toEqual([]);
    await service.ensureStarted({ install: true });
    expect(firstRuns).toEqual([{ reason: "missing-runtime" }]);
  });

  describe("speakReply", () => {
    it("speaks only the latest of the replies that waited on a start", async () => {
      const { service } = ttsService();
      const verify = gate();
      runtime.gate = verify.promise;
      const replies = [service.speakReply("first", "chat"), service.speakReply("second", "chat"), service.speakReply("third", "chat")];
      verify.open();
      await Promise.all(replies);
      expect(spoken()).toEqual(["third"]);

      await service.speakReply("fourth", "chat");
      expect(spoken()).toEqual(["third", "fourth"]);
      expect(runtime.calls).toEqual([{ allowInstall: false }]);
    });

    it("never installs the runtime", async () => {
      const { service } = ttsService();
      runtime.results.push(failed({ message: "The voice runtime is not installed." }));
      await service.speakReply("hello", "chat");
      expect(runtime.calls).toEqual([{ allowInstall: false }]);
      expect(spoken()).toEqual([]);
    });
  });
});
