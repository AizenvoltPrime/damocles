import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Disposable } from "../../platform/disposable";
import type { Platform } from "../../platform/platform";
import { log } from "../logger";
import { t } from "../l10n";
import { DEFAULT_WAKE_PHRASE, parseWakePhrase } from "../../shared/wake-phrase";
import { VoiceRuntimeInstaller, getDefaultRuntimePaths, DEFAULT_RUNTIME_DIR } from "./runtime";
import type { RuntimePaths } from "./runtime";
import { unsupportedVoicePlatformMessage } from "./runtime/supported-platforms";
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
  platform: Platform;
  rootDir?: string;
};

const VSCODE_SPEECH_EXTENSION_ID = "ms-vscode.vscode-speech";

export class VoiceService extends EventEmitter<VoiceServiceEvents> {
  private readonly installer: VoiceRuntimeInstaller;
  private readonly paths: RuntimePaths;
  private readonly platform: Platform;
  private manager: VoiceSidecarManager | null = null;
  private modeWatcher: Disposable | null = null;
  private pythonExe: string | null = null;
  private speechConflictWarned: boolean = false;
  // The start or stop in flight, which never rejects; see enqueue.
  private pending: Promise<void> | null = null;
  private pendingAbort: AbortController | null = null;
  // Why the last start, or the sidecar it left running, failed, by the settings it ran under; see ensureStarted.
  // `verifyOnly` marks a start that was not allowed to install, which a caller that may install still tries.
  private failure: { settings: string; verifyOnly: boolean; message: string } | null = null;
  private latestReply = 0;

  constructor(opts: VoiceServiceOptions) {
    super();
    this.platform = opts.platform;
    const root = opts.rootDir ?? DEFAULT_RUNTIME_DIR;
    this.paths = getDefaultRuntimePaths(root);
    this.installer = new VoiceRuntimeInstaller(this.paths);
  }

  private warnIfSpeechExtensionConflicts(): void {
    if (this.speechConflictWarned) return;
    const editor = this.platform.editor;
    if (!this.platform.capabilities.hostSpeechExtensions || !editor.isHostExtensionActive(VSCODE_SPEECH_EXTENSION_ID)) return;
    this.speechConflictWarned = true;
    void this.platform.notifications.warn(
      "VS Code Speech extension is active and may compete for the microphone. Disable it for best Jarvis performance.",
      "Open extension",
      "Dismiss",
    ).then((choice) => {
      if (choice === "Open extension") {
        void editor.searchHostExtensions(`@id:${VSCODE_SPEECH_EXTENSION_ID}`);
      }
    });
  }

  registerWithExtension(subscriptions: Disposable[]): void {
    this.modeWatcher = this.platform.settings.onDidChange("damocles.voice", (e) => {
      // tts.voice intentionally NOT here — voice changes go via the
      // hot-swap path (set_voice protocol message) so the user doesn't
      // pay the 7-8 s smoke-check + model-reload cost on every pick.
      // Reaching this branch would force a full sidecar restart.
      const modeChanged = e.affects("damocles.voice.mode");
      const ttsChanged = e.affects("damocles.voice.tts.enabled");
      const cfg = this.platform.settings;
      const wakeWordEnabled = cfg.get<string>("damocles.voice.mode", "push-to-talk") === "wake-word";
      // The sidecar builds its keyword spotter from the --wake-word argument at startup.
      const phraseChanged = wakeWordEnabled && e.affects("damocles.voice.wakeWord");
      if (!modeChanged && !ttsChanged && !phraseChanged) return;
      const ttsEnabled = cfg.get<boolean>("damocles.voice.tts.enabled", false);
      if (!wakeWordEnabled && !ttsEnabled) {
        this.stop().catch((err) => log("[VoiceService] stop on config change failed:", err));
        return;
      }
      this.restart().catch((err) => log("[VoiceService] restart on config change failed:", err));
    });
    subscriptions.push(this.modeWatcher);
    subscriptions.push({ dispose: () => this.dispose() });
  }

  /**
   * Replaces the sidecar with one started under the current settings, installing the runtime if needed: the path for a
   * settings change or an explicit user action. It supersedes the start in flight, whose long steps (smoke check, pip
   * install, sidecar spawn) would otherwise finish against stale settings.
   */
  async restart(): Promise<void> {
    this.failure = null;
    await this.launch(true);
  }

  /**
   * Starts the service unless it runs or a start is in flight, which the caller joins. Only `install` lets the start
   * download and install the runtime. Unless `retry` is set, a sidecar restarting itself is left alone, and a start that
   * failed, or a sidecar that failed after it was ready, is not tried again under the same settings, so a caller that
   * fires on every reply cannot loop a failing install or a crashing sidecar.
   */
  async ensureStarted(opts: { install: boolean; retry?: boolean }): Promise<void> {
    // Loops because a caller woken by the same step may already have queued the next one.
    while (this.pending !== null) await this.pending;
    if (this.isReady()) return;
    if (opts.retry !== true) {
      if (this.isRecovering()) return;
      const failure = this.failure;
      // A start that could not install does not stop a caller that may.
      if (failure?.settings === this.settingsKey() && (!failure.verifyOnly || !opts.install)) return;
    }
    await this.launch(opts.install);
  }

  /**
   * Speaks an assistant reply once the sidecar runs, never installing the runtime. A reply overtaken by a newer one while
   * it waited for a start is dropped, so a long start ends with the latest reply spoken, not every reply in turn.
   */
  async speakReply(text: string): Promise<void> {
    const reply = ++this.latestReply;
    await this.ensureStarted({ install: false });
    if (reply !== this.latestReply) {
      log("[VoiceService] reply not spoken: a newer reply arrived while voice was starting");
      return;
    }
    if (!this.isReady()) {
      log("[VoiceService] reply not spoken: voice is not running");
      return;
    }
    const requestId = randomUUID();
    log(`[VoiceService] speaking reply: req=${requestId} chars=${text.length}`);
    this.ttsRequest(requestId, text);
  }

  /** Why the last start under the current settings, or the sidecar it left running, failed, or null. */
  failureMessage(): string | null {
    return this.failure?.settings === this.settingsKey() ? this.failure.message : null;
  }

  private settingsKey(): string {
    const cfg = this.platform.settings;
    return JSON.stringify([
      cfg.get<string>("damocles.voice.mode", "off"),
      cfg.get<boolean>("damocles.voice.tts.enabled", false),
      cfg.get<string>("damocles.voice.wakeWord", DEFAULT_WAKE_PHRASE),
      cfg.get<string>("damocles.voice.localGpu", "auto"),
      cfg.get<string>("damocles.voice.runtimePath", ""),
    ]);
  }

  private isRecovering(): boolean {
    const kind = this.manager?.getStatus().kind;
    return kind === "loading" || kind === "restarting" || kind === "cpu-fallback";
  }

  /**
   * Runs `step` after every earlier step has ended and aborts the one in flight, so at most one start or stop runs at a
   * time and every sidecar spawned is the one `this.manager` holds.
   */
  private enqueue(step: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const previous = this.pending;
    this.pendingAbort?.abort();
    const abort = new AbortController();
    this.pendingAbort = abort;
    const run = (async (): Promise<void> => {
      try {
        if (previous !== null) await previous;
        await step(abort.signal);
      } finally {
        if (this.pendingAbort === abort) {
          this.pendingAbort = null;
          this.pending = null;
        }
      }
    })();
    this.pending = run.catch(() => undefined);
    return run;
  }

  private launch(install: boolean): Promise<void> {
    return this.enqueue(async (signal) => {
      const settings = this.settingsKey();
      let failure: string | null;
      try {
        failure = await this.doStart(signal, install, settings);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      if (signal.aborted) return;
      this.failure = failure === null ? null : { settings, verifyOnly: !install, message: failure };
      if (failure !== null) log(`[VoiceService] start failed; not retried under these settings until a retry: ${failure}`);
    });
  }

  /** Why the start left no running sidecar, or null when it runs or the settings ask for none. */
  private async doStart(signal: AbortSignal, install: boolean, settings: string): Promise<string | null> {
    if (this.manager !== null) {
      const previous = this.manager;
      this.manager = null;
      await previous.stop();
    }
    if (signal.aborted) return null;

    const config = this.platform.settings;
    const mode = config.get<string>("damocles.voice.mode", "off");
    const wakeWordEnabled = mode === "wake-word";
    const ttsEnabled = config.get<boolean>("damocles.voice.tts.enabled", false);
    if (!wakeWordEnabled && !ttsEnabled) return null;

    const unsupported = unsupportedVoicePlatformMessage(process.platform, process.arch);
    if (unsupported !== null) {
      log(`[VoiceService] ${unsupported}`);
      this.emit("status", { kind: "error", code: "unsupported-platform", message: unsupported });
      return unsupported;
    }

    if (wakeWordEnabled) this.warnIfSpeechExtensionConflicts();

    if (this.wakePhraseFor(wakeWordEnabled) === undefined) return "invalid wake phrase";

    const userPython = config.get<string>("damocles.voice.runtimePath", "");
    const userRuntimeMode = config.get<"auto" | "cuda" | "cpu">("damocles.voice.localGpu", "auto");
    let loggedStage: string | null = null;
    const installOpts: {
      userSpecifiedPython?: string;
      extensionRoot: string;
      signal: AbortSignal;
      onProgress: (p: { stage: string; message: string }) => void;
      runtimeMode: "auto" | "cuda" | "cpu";
      allowInstall: boolean;
    } = {
      extensionRoot: this.platform.paths.unpackedRoot,
      signal,
      // A download reports every network chunk; the log keeps its first line per stage.
      onProgress: (p) => {
        if (p.stage === "downloading-python" && loggedStage === p.stage) return;
        loggedStage = p.stage;
        log(`[VoiceService] runtime ${p.stage}: ${p.message}`);
      },
      runtimeMode: userRuntimeMode,
      allowInstall: install,
    };
    if (userPython.length > 0) installOpts.userSpecifiedPython = userPython;
    const result = await this.installer.installAll(installOpts);
    if (signal.aborted) return null;
    if (!result.ok) {
      // A verify-only start runs for a reply, which must never open the first-run modal and its install.
      if (install) this.emit("firstRunRequired", { reason: "missing-runtime" });
      return result.errorMessage ?? "the voice runtime is not ready";
    }
    this.pythonExe = result.pythonExe;

    // Re-read mode/tts AFTER the slow installAll returns: smoke-check
    // can take 10+ s and the user may have toggled mode in the meantime.
    // Without this re-read, doStart would spawn a sidecar matching the
    // user's *prior* intent.
    const liveCfg = this.platform.settings;
    const liveMode = liveCfg.get<string>("damocles.voice.mode", "off");
    const liveWakeWordEnabled = liveMode === "wake-word";
    const liveTtsEnabled = liveCfg.get<boolean>("damocles.voice.tts.enabled", false);
    if (!liveWakeWordEnabled && !liveTtsEnabled) return null;
    const wakePhrase = this.wakePhraseFor(liveWakeWordEnabled);
    if (wakePhrase === undefined) return "invalid wake phrase";

    const managerCfg: ManagerConfig = {
      pythonExe: this.pythonExe,
      pythonSourceDir: join(this.platform.paths.unpackedRoot, "python", "damocles_voice_sidecar"),
      modelsDir: this.paths.modelsDir,
      runtimeMode: liveCfg.get<"auto" | "cuda" | "cpu">("damocles.voice.localGpu", "auto"),
      diagnostics: liveCfg.get<boolean>("damocles.voice.diagnostics", false),
      wakePhrase,
      initPayload: {
        wakeSensitivity: liveCfg.get<number>("damocles.voice.wakeWordSensitivity", 0.5),
        endOfTurnSilenceMs: liveCfg.get<number>("damocles.voice.endOfTurnSilenceMs", 800),
        maxUtteranceMs: liveCfg.get<number>("damocles.voice.maxUtteranceMs", 30000),
        ttsEnabled: liveTtsEnabled,
        ttsVoice: liveCfg.get<string>("damocles.voice.tts.voice", "en-Carter_man"),
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

    let startError: unknown = null;
    try {
      await next.start();
    } catch (err) {
      startError = err;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    if (signal.aborted) {
      if (this.manager === next) this.manager = null;
      // The next start may run only once this sidecar is gone and its lock released.
      await next.stop();
      return null;
    }
    if (startError !== null) {
      log("[VoiceService] start failed:", startError);
      return startError instanceof Error ? startError.message : String(startError);
    }
    // The manager reports an error status only once it has given up restarting itself.
    next.on("status", (s) => {
      if (s.kind === "error" && this.manager === next) this.failure = { settings, verifyOnly: false, message: s.message };
    });
    return null;
  }

  /** The normalized phrase in wake mode and null outside it; undefined, after reporting the error, when the stored phrase is invalid. */
  private wakePhraseFor(wakeWordEnabled: boolean): string | null | undefined {
    if (!wakeWordEnabled) return null;
    const setting = this.platform.settings.get<string>("damocles.voice.wakeWord", DEFAULT_WAKE_PHRASE);
    const words = parseWakePhrase(setting);
    if (words !== null) return words.join(" ");
    const message = t("The damocles.voice.wakeWord setting is not a valid wake phrase: \"{0}\". Use 1 to 4 English words of letters only, such as \"hey jarvis\".", setting);
    log(`[VoiceService] ${message}`);
    this.emit("status", { kind: "error", code: "fatal", message });
    return undefined;
  }

  /** Aborts the start in flight and stops the sidecar once that start has ended. */
  async stop(): Promise<void> {
    await this.enqueue(async () => {
      const manager = this.manager;
      this.manager = null;
      if (manager !== null) await manager.stop();
    });
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
