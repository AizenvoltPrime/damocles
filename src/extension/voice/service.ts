import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import * as vscode from "vscode";
import { log } from "../logger";
import { VoiceRuntimeInstaller, getDefaultRuntimePaths, DEFAULT_RUNTIME_DIR } from "./runtime";
import type { RuntimePaths } from "./runtime";
import { VoiceSidecarManager } from "./sidecar";
import type {
  CpuFallbackEvent,
  IncomingTtsChunk,
  ManagerConfig,
  SidecarManagerStatus,
  SidecarOutbound,
  TtsUnloadedEvent,
} from "./sidecar";

export type VoiceServiceEvents = {
  status: [SidecarManagerStatus];
  message: [SidecarOutbound];
  ttsChunk: [IncomingTtsChunk];
  firstRunRequired: [{ reason: "missing-runtime" | "missing-models" | "first-time" }];
  cpuFallback: [CpuFallbackEvent];
  ttsUnloaded: [TtsUnloadedEvent];
};

export type VoiceServiceOptions = {
  extensionRoot: string;
  rootDir?: string;
};

const VSCODE_SPEECH_EXTENSION_ID = "ms-vscode.vscode-speech";

export class VoiceService extends EventEmitter<VoiceServiceEvents> {
  private readonly installer: VoiceRuntimeInstaller;
  private readonly paths: RuntimePaths;
  private readonly extensionRoot: string;
  private manager: VoiceSidecarManager | null = null;
  private modeWatcher: vscode.Disposable | null = null;
  private pythonExe: string | null = null;
  private speechConflictWarned: boolean = false;
  private startPromise: Promise<void> | null = null;
  private startAbort: AbortController | null = null;

  constructor(opts: VoiceServiceOptions) {
    super();
    this.extensionRoot = opts.extensionRoot;
    const root = opts.rootDir ?? DEFAULT_RUNTIME_DIR;
    this.paths = getDefaultRuntimePaths(root);
    this.installer = new VoiceRuntimeInstaller(this.paths);
  }

  private warnIfSpeechExtensionConflicts(): void {
    if (this.speechConflictWarned) return;
    const speech = vscode.extensions.getExtension(VSCODE_SPEECH_EXTENSION_ID);
    if (speech === undefined || !speech.isActive) return;
    this.speechConflictWarned = true;
    void vscode.window.showWarningMessage(
      "VS Code Speech extension is active and may compete for the microphone. Disable it for best Jarvis performance.",
      "Open extension",
      "Dismiss",
    ).then((choice) => {
      if (choice === "Open extension") {
        void vscode.commands.executeCommand("workbench.extensions.search", `@id:${VSCODE_SPEECH_EXTENSION_ID}`);
      }
    });
  }

  registerWithExtension(context: vscode.ExtensionContext): void {
    this.modeWatcher = vscode.workspace.onDidChangeConfiguration((e) => {
      // tts.voice intentionally NOT here — voice changes go via the
      // hot-swap path (set_voice protocol message) so the user doesn't
      // pay the 7-8 s smoke-check + model-reload cost on every pick.
      // Reaching this branch would force a full sidecar restart.
      const modeChanged = e.affectsConfiguration("damocles.voice.mode");
      const ttsChanged = e.affectsConfiguration("damocles.voice.tts.enabled");
      if (!modeChanged && !ttsChanged) return;
      const cfg = vscode.workspace.getConfiguration("damocles");
      const wakeWordEnabled = cfg.get<string>("voice.mode", "push-to-talk") === "wake-word";
      const ttsEnabled = cfg.get<boolean>("voice.tts.enabled", false);
      if (!wakeWordEnabled && !ttsEnabled) {
        this.stop().catch((err) => log("[VoiceService] stop on config change failed:", err));
        return;
      }
      this.restart().catch((err) => log("[VoiceService] restart on config change failed:", err));
    });
    context.subscriptions.push(this.modeWatcher);
    context.subscriptions.push({ dispose: () => this.dispose() });
  }

  private async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async start(): Promise<void> {
    // Latest-wins: a new start supersedes any in-flight start. We abort
    // the previous start's signal so its long-running steps (smoke check,
    // pip install, sidecar spawn) unwind cleanly instead of completing
    // against stale config and leaving an orphan sidecar that the next
    // restart() must SIGTERM. Without this, a rapid mode-toggle
    // (wake-word → push-to-talk → wake-word) would race the slow first
    // start against the second restart's stop() and surface as
    // "sidecar exited before binding port (signal=SIGTERM)".
    await this.cancelInFlightStart();
    const abort = new AbortController();
    this.startAbort = abort;
    this.startPromise = (async (): Promise<void> => {
      try {
        await this.doStart(abort.signal);
      } finally {
        if (this.startAbort === abort) this.startAbort = null;
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  private async cancelInFlightStart(): Promise<void> {
    if (this.startAbort !== null) this.startAbort.abort();
    if (this.startPromise !== null) {
      try {
        await this.startPromise;
      } catch {
        // doStart catches its own errors; any throw reaching here is the
        // abort path and is expected.
      }
    }
  }

  private async doStart(signal: AbortSignal): Promise<void> {
    const config = vscode.workspace.getConfiguration("damocles");
    const mode = config.get<string>("voice.mode", "off");
    const wakeWordEnabled = mode === "wake-word";
    const ttsEnabled = config.get<boolean>("voice.tts.enabled", false);
    if (!wakeWordEnabled && !ttsEnabled) return;

    if (wakeWordEnabled) this.warnIfSpeechExtensionConflicts();

    if (this.manager !== null) {
      const previous = this.manager;
      this.manager = null;
      await previous.stop();
    }
    if (signal.aborted) return;

    const userPython = config.get<string>("voice.runtimePath", "");
    const userRuntimeMode = config.get<"auto" | "cuda" | "cpu">("voice.localGpu", "auto");
    const installOpts: {
      userSpecifiedPython?: string;
      extensionRoot: string;
      signal: AbortSignal;
      onProgress: (p: { stage: string; message: string }) => void;
      runtimeMode: "auto" | "cuda" | "cpu";
    } = {
      extensionRoot: this.extensionRoot,
      signal,
      onProgress: (p) => log(`[VoiceService] runtime ${p.stage}: ${p.message}`),
      runtimeMode: userRuntimeMode,
    };
    if (userPython.length > 0) installOpts.userSpecifiedPython = userPython;
    const result = await this.installer.installAll(installOpts);
    if (signal.aborted) return;
    if (!result.ok) {
      this.emit("firstRunRequired", { reason: "missing-runtime" });
      return;
    }
    this.pythonExe = result.pythonExe;

    // Re-read mode/tts AFTER the slow installAll returns: smoke-check
    // can take 10+ s and the user may have toggled mode in the meantime.
    // Without this re-read, doStart would spawn a sidecar matching the
    // user's *prior* intent.
    const liveCfg = vscode.workspace.getConfiguration("damocles");
    const liveMode = liveCfg.get<string>("voice.mode", "off");
    const liveWakeWordEnabled = liveMode === "wake-word";
    const liveTtsEnabled = liveCfg.get<boolean>("voice.tts.enabled", false);
    if (!liveWakeWordEnabled && !liveTtsEnabled) return;

    const managerCfg: ManagerConfig = {
      pythonExe: this.pythonExe,
      pythonSourceDir: join(this.extensionRoot, "python", "damocles_voice_sidecar"),
      modelsDir: this.paths.modelsDir,
      runtimeMode: liveCfg.get<"auto" | "cuda" | "cpu">("voice.localGpu", "auto"),
      diagnostics: liveCfg.get<boolean>("voice.diagnostics", false),
      wakeWordEnabled: liveWakeWordEnabled,
      initPayload: {
        wakeWord: liveCfg.get<string>("voice.wakeWord", "hey_jarvis"),
        wakeSensitivity: liveCfg.get<number>("voice.wakeWordSensitivity", 0.5),
        endOfTurnSilenceMs: liveCfg.get<number>("voice.endOfTurnSilenceMs", 800),
        maxUtteranceMs: liveCfg.get<number>("voice.maxUtteranceMs", 30000),
        ttsEnabled: liveTtsEnabled,
        ttsVoice: liveCfg.get<string>("voice.tts.voice", "en-Carter_man"),
      },
      lockDir: join(homedir(), ".damocles", "voice", "sidecar.lock"),
    };

    const next = new VoiceSidecarManager(managerCfg);
    next.on("status", (s) => this.emit("status", s));
    next.on("message", (m) => this.emit("message", m));
    next.on("ttsChunk", (c) => this.emit("ttsChunk", c));
    next.on("cpuFallback", (e) => this.emit("cpuFallback", e));
    next.on("ttsUnloaded", (e) => this.emit("ttsUnloaded", e));
    next.on("error", (e) => log("[VoiceService] sidecar error:", e));
    this.manager = next;

    // Propagate abort into manager.start() by triggering next.stop() —
    // this SIGTERMs the spawning child so waitForReady's polling loop
    // sees childExitInfo and unblocks immediately, instead of running
    // its 60 s cold-start timeout.
    const onAbort = (): void => {
      void next.stop().catch((err) => log("[VoiceService] abort-stop failed:", err));
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    try {
      await next.start();
    } catch (err) {
      if (signal.aborted) return;
      log("[VoiceService] start failed:", err);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    if (signal.aborted) {
      if (this.manager === next) this.manager = null;
    }
  }

  async stop(): Promise<void> {
    // Abort any in-flight start first — without this, stop()'s
    // contract ("voice service is no longer running") is violated when
    // a doStart kicked off seconds earlier completes after stop()
    // returns and leaves a manager dangling.
    await this.cancelInFlightStart();
    if (this.manager === null) return;
    await this.manager.stop();
    this.manager = null;
  }

  isReady(): boolean {
    return this.manager !== null && this.manager.isAlive();
  }

  ttsRequest(requestId: string, text: string): void {
    if (this.manager === null) return;
    this.manager.send({ type: "tts_request", request_id: requestId, text });
  }

  ttsCancel(requestId: string | null): void {
    if (this.manager === null) return;
    this.manager.send({ type: "cancel_tts", request_id: requestId });
  }

  setMuted(muted: boolean): void {
    if (this.manager === null) return;
    this.manager.send({ type: "set_muted", muted });
  }

  setTtsVoice(voiceId: string): boolean {
    if (this.manager === null || !this.manager.isAlive()) return false;
    this.manager.send({ type: "set_voice", voice_id: voiceId });
    return true;
  }

  attachClient(): () => void {
    if (this.manager === null) return (): void => {};
    return this.manager.attachClient();
  }

  getStatus(): SidecarManagerStatus {
    if (this.manager === null) return { kind: "stopped" };
    return this.manager.getStatus();
  }

  getPaths(): RuntimePaths {
    return this.paths;
  }

  getInstaller(): VoiceRuntimeInstaller {
    return this.installer;
  }

  dispose(): void {
    if (this.modeWatcher !== null) {
      this.modeWatcher.dispose();
      this.modeWatcher = null;
    }
    // Synchronous force-kill before firing the async stop. VS Code's
    // deactivate() unloads the host without awaiting our async work,
    // so without a sync kill the Python sidecar + NeMo workers + VRAM
    // allocations leak as orphans across extension reloads. The async
    // stop still runs to clean up the WebSocket and lockfile.
    this.manager?.killChildSync();
    void this.stop();
  }

  /** Async graceful shutdown for callers that can await (e.g. tests). */
  async shutdown(): Promise<void> {
    if (this.modeWatcher !== null) {
      this.modeWatcher.dispose();
      this.modeWatcher = null;
    }
    await this.stop();
  }
}
