import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { Disposable } from "../../platform/disposable";
import type { Platform } from "../../platform/platform";
import { log } from "../logger";
import { t } from "../l10n";
import { DEFAULT_WAKE_PHRASE, parseWakePhrase } from "../../shared/wake-phrase";
import type { VoiceRuntimeStage, VoiceRuntimeStatus } from "../../shared/types/voice";
import { VoiceRuntimeInstaller, getDefaultRuntimePaths, DEFAULT_RUNTIME_DIR } from "./runtime";
import { extractWorkerAt } from "./runtime/python-installer";
import { voiceModelsAt, type VoiceModels } from "./models/provision";
import { loadManifest, type ModelEntry } from "./models/manifest";
import { voiceDownloadConsentIn, type VoiceDownloadConsent } from "./consent";
import type { RuntimePaths, RuntimeProgressCallback, RuntimeStage } from "./runtime";
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
  runtimeStatus: [VoiceRuntimeStatus];
  /** Once per failed or cancelled start; `origin` is the caller's tag for the reply's chat. */
  replyNotSpoken: [{ reason: string; origin: string }];
};

export type VoiceServiceOptions = {
  platform: Platform;
  rootDir?: string;
};

const VSCODE_SPEECH_EXTENSION_ID = "ms-vscode.vscode-speech";

// At most 4 runtimeStatus events a second within one stage; a new stage or state emits at once.
const RUNTIME_STATUS_INTERVAL_MS = 250;

// The stages that download or install something; a start shows a progress bar only once it reaches one.
const INSTALL_STAGES: ReadonlySet<VoiceRuntimeStage> = new Set(["downloading-python", "extracting-python", "creating-venv", "installing-pip", "downloading-models"]);
// Stages that report every network chunk or pip output line log at most one line a second.
const CHATTY_STAGES: ReadonlySet<RuntimeStage> = new Set(["downloading-python", "installing-pip"]);
const CHATTY_LOG_INTERVAL_MS = 1000;

type StartProgress = { stage: VoiceRuntimeStage; pct: number; installing: boolean };
type StartOutcome = { settings: string; message: string };
/** Why a start left no sidecar; `consentRequired` when a download would fix it and the user has not consented to one. */
type StartFailure = { message: string; consentRequired: boolean };

const startFailure = (message: string): StartFailure => ({ message, consentRequired: false });

export class VoiceService extends EventEmitter<VoiceServiceEvents> {
  private readonly installer: VoiceRuntimeInstaller;
  private readonly models: VoiceModels;
  private readonly consent: VoiceDownloadConsent;
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
  private failure: (StartOutcome & StartFailure & { verifyOnly: boolean }) | null = null;
  // A start the user cancelled, which no caller repeats under the same settings until an install or a retry.
  private cancelled: StartOutcome | null = null;
  private starting: StartProgress | null = null;
  // The failure or cancel a replyNotSpoken already reported; a new start that fails is a new record.
  private reportedNotSpoken: StartOutcome | null = null;
  private emittedStatus: string | null = null;
  private emittedStage: VoiceRuntimeStage | null = null;
  private emittedAt = 0;
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private latestReply = 0;

  constructor(opts: VoiceServiceOptions) {
    super();
    this.platform = opts.platform;
    const root = opts.rootDir ?? DEFAULT_RUNTIME_DIR;
    this.paths = getDefaultRuntimePaths(root);
    this.models = voiceModelsAt(this.platform.paths.unpackedRoot, this.paths.modelsDir, this.platform.settings);
    this.consent = voiceDownloadConsentIn(this.platform.state.global, () => loadManifest(this.platform.paths.unpackedRoot));
    this.installer = new VoiceRuntimeInstaller(this.paths, extractWorkerAt(this.platform.paths.workerEntry("voiceExtract")), this.models);
  }

  /** The models the sidecar needs under the current settings that are not on disk at the version it loads. */
  missingModels(): Promise<ModelEntry[]> {
    return this.models.missing();
  }

  /** Whether the user accepted the first-run dialog as it discloses the shipped models; until then no start downloads. */
  downloadConsentGiven(): Promise<boolean> {
    return this.consent.given();
  }

  recordDownloadConsent(): Promise<void> {
    return this.consent.record();
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
      this.emitRuntimeStatus();
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
    this.cancelled = null;
    await this.launch(true, true);
  }

  /**
   * The user's Start, Install or Retry in Settings > Voice: forgets the failed or cancelled start and starts once,
   * installing what is missing once the user consented. Settings asks for that consent itself, so this never emits
   * firstRunRequired.
   */
  async install(): Promise<void> {
    this.failure = null;
    this.cancelled = null;
    this.emitRuntimeStatus();
    await this.ensureStarted({ install: true, retry: true, askConsent: false });
  }

  /**
   * Aborts the start in flight (download, extraction, pip, sidecar spawn) and records no failure: a later install
   * verifies whatever the abort left and repairs or reinstalls it.
   */
  cancelStart(): void {
    if (this.starting === null && !this.isRecovering()) return;
    this.cancelled = { settings: this.settingsKey(), message: t("Starting the voice runtime was cancelled.") };
    this.emitRuntimeStatus();
    this.stop().catch((err) => log("[VoiceService] stop on cancel failed:", err));
  }

  /** The runtime's state for Settings > Voice, derived from the settings, the start in flight and the last outcome. */
  runtimeStatus(): VoiceRuntimeStatus {
    const unsupported = unsupportedVoicePlatformMessage(process.platform, process.arch);
    if (unsupported !== null) return { kind: "unsupported", message: unsupported };
    const cfg = this.platform.settings;
    const needed = cfg.get<string>("damocles.voice.mode", "off") === "wake-word" || cfg.get<boolean>("damocles.voice.tts.enabled", false);
    if (!needed) return { kind: "not-needed" };
    if (this.isReady()) return { kind: "ready" };
    const settings = this.settingsKey();
    if (this.cancelled?.settings === settings) return { kind: "cancelled" };
    if (this.starting !== null) return { kind: "starting", ...this.starting };
    if (this.isRecovering()) return { kind: "starting", stage: "launching", pct: 100, installing: false };
    const failure = this.failure?.settings === settings ? this.failure : null;
    if (failure === null) return { kind: "idle" };
    return failure.verifyOnly
      ? { kind: "needs-install", message: failure.message, consentRequired: failure.consentRequired }
      : { kind: "failed", message: failure.message };
  }

  private emitRuntimeStatus(): void {
    const status = this.runtimeStatus();
    const serialized = JSON.stringify(status);
    if (serialized === this.emittedStatus) return;
    const now = Date.now();
    const sameStage = status.kind === "starting" && status.stage === this.emittedStage;
    if (sameStage && now - this.emittedAt < RUNTIME_STATUS_INTERVAL_MS) {
      this.statusTimer ??= setTimeout(() => {
        this.statusTimer = null;
        this.emitRuntimeStatus();
      }, RUNTIME_STATUS_INTERVAL_MS - (now - this.emittedAt));
      return;
    }
    this.clearStatusTimer();
    this.emittedStatus = serialized;
    this.emittedStage = status.kind === "starting" ? status.stage : null;
    this.emittedAt = now;
    this.emit("runtimeStatus", status);
  }

  private clearStatusTimer(): void {
    if (this.statusTimer === null) return;
    clearTimeout(this.statusTimer);
    this.statusTimer = null;
  }

  /**
   * Starts the service unless it runs or a start is in flight, which the caller joins. Only `install` lets the start
   * download and install the runtime and models, and only once the user consented; without that consent the start only
   * verifies, and when a download would fix it, emits firstRunRequired unless `askConsent` is false. Unless `retry` is
   * set, a sidecar restarting itself is left alone, and a start that failed, or a sidecar that failed after it was ready,
   * is not tried again under the same settings, so a caller that fires on every reply cannot loop a failing install or a
   * crashing sidecar.
   */
  async ensureStarted(opts: { install: boolean; retry?: boolean; askConsent?: boolean }): Promise<void> {
    // Loops because a caller woken by the same step may already have queued the next one.
    while (this.pending !== null) await this.pending;
    if (this.isReady()) return;
    if (opts.retry !== true) {
      if (this.isRecovering()) return;
      if (this.cancelled?.settings === this.settingsKey()) return;
      const failure = this.failure;
      // A start that could not install does not stop a caller that may.
      if (failure?.settings === this.settingsKey() && (!failure.verifyOnly || !opts.install)) return;
    }
    await this.launch(opts.install, opts.askConsent ?? opts.install);
  }

  /**
   * Speaks an assistant reply once the sidecar runs, never installing the runtime. A reply overtaken by a newer one while
   * it waited for a start is dropped, so a long start ends with the latest reply spoken, not every reply in turn.
   * A reply a failed or cancelled start leaves unspoken emits replyNotSpoken, once per such start.
   */
  async speakReply(text: string, origin: string): Promise<void> {
    const reply = ++this.latestReply;
    await this.ensureStarted({ install: false });
    if (reply !== this.latestReply) {
      log("[VoiceService] reply not spoken: a newer reply arrived while voice was starting");
      return;
    }
    if (!this.isReady()) {
      log("[VoiceService] reply not spoken: voice is not running");
      const settings = this.settingsKey();
      const outcome = this.cancelled?.settings === settings ? this.cancelled : this.failure?.settings === settings ? this.failure : null;
      if (outcome !== null && outcome !== this.reportedNotSpoken) {
        this.reportedNotSpoken = outcome;
        this.emit("replyNotSpoken", { reason: outcome.message, origin });
      }
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

  private launch(install: boolean, askConsent: boolean): Promise<void> {
    return this.enqueue(async (signal) => {
      // A start that runs supersedes the cancel; one a later step already aborted leaves it for that step.
      if (!signal.aborted) this.cancelled = null;
      const settings = this.settingsKey();
      const progress: StartProgress = { stage: "detecting", pct: 0, installing: false };
      this.starting = progress;
      this.emitRuntimeStatus();
      let failure: StartFailure | null;
      let mayDownload = false;
      try {
        const consented = await this.consent.given();
        mayDownload = install && consented;
        failure = await this.doStart(signal, { install, consented, askConsent, settings }, progress);
      } catch (err) {
        failure = startFailure(err instanceof Error ? err.message : String(err));
      } finally {
        if (this.starting === progress) this.starting = null;
      }
      if (signal.aborted) {
        // A step queued after this one reports the state once it has run.
        if (this.pendingAbort?.signal === signal) this.emitRuntimeStatus();
        return;
      }
      this.failure = failure === null ? null : { settings, verifyOnly: !mayDownload, ...failure };
      if (failure !== null) log(`[VoiceService] start failed; not retried under these settings until a retry: ${failure.message}`);
      this.emitRuntimeStatus();
    });
  }

  /**
   * Why the start left no running sidecar, or null when it runs or the settings ask for none. `install` is the caller's
   * leave to install, which lets the installer download only with the user's consent.
   */
  private async doStart(
    signal: AbortSignal,
    opts: { install: boolean; consented: boolean; askConsent: boolean; settings: string },
    progress: StartProgress,
  ): Promise<StartFailure | null> {
    const advance = (stage: VoiceRuntimeStage, pct: number): void => {
      progress.stage = stage;
      progress.pct = pct;
      if (INSTALL_STAGES.has(stage)) progress.installing = true;
      if (this.starting === progress) this.emitRuntimeStatus();
    };
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
      return startFailure(unsupported);
    }

    if (wakeWordEnabled) this.warnIfSpeechExtensionConflicts();

    const phrase = this.wakePhraseFor(wakeWordEnabled);
    if ("invalid" in phrase) return startFailure(phrase.invalid);

    const userPython = config.get<string>("damocles.voice.runtimePath", "");
    const userRuntimeMode = config.get<"auto" | "cuda" | "cpu">("damocles.voice.localGpu", "auto");
    let logged: { stage: RuntimeStage; message: string; at: number } | null = null;
    // Downloads report every network chunk and pip every output line: those stages log a line a second, the rest each new message.
    const logProgress = (stage: RuntimeStage, message: string): void => {
      const now = Date.now();
      if (logged?.stage === stage && (CHATTY_STAGES.has(stage) ? now - logged.at < CHATTY_LOG_INTERVAL_MS : logged.message === message)) return;
      logged = { stage, message, at: now };
      log(`[VoiceService] runtime ${stage}: ${message}`);
    };
    const installOpts: {
      userSpecifiedPython?: string;
      extensionRoot: string;
      signal: AbortSignal;
      onProgress: RuntimeProgressCallback;
      runtimeMode: "auto" | "cuda" | "cpu";
      allowInstall: boolean;
    } = {
      extensionRoot: this.platform.paths.unpackedRoot,
      signal,
      onProgress: (p) => {
        if (p.stage !== "done" && p.stage !== "error") advance(p.stage, p.pct);
        logProgress(p.stage, p.message);
      },
      runtimeMode: userRuntimeMode,
      allowInstall: opts.install && opts.consented,
    };
    if (userPython.length > 0) installOpts.userSpecifiedPython = userPython;
    const result = await this.installer.installAll(installOpts);
    if (signal.aborted) return null;
    if (!result.ok) {
      const message = result.errorMessage ?? t("The voice runtime is not ready.");
      if (result.missing === undefined || opts.consented) return startFailure(message);
      // A start that may not install runs for a reply, which must never open the first-run dialog.
      if (opts.install && opts.askConsent) this.emit("firstRunRequired", { reason: result.missing === "runtime" ? "missing-runtime" : "missing-models" });
      return { message, consentRequired: true };
    }
    this.pythonExe = result.pythonExe;
    advance("launching", 100);

    // Re-read mode/tts AFTER the slow installAll returns: smoke-check
    // can take 10+ s and the user may have toggled mode in the meantime.
    // Without this re-read, doStart would spawn a sidecar matching the
    // user's *prior* intent.
    const liveCfg = this.platform.settings;
    const liveMode = liveCfg.get<string>("damocles.voice.mode", "off");
    const liveWakeWordEnabled = liveMode === "wake-word";
    const liveTtsEnabled = liveCfg.get<boolean>("damocles.voice.tts.enabled", false);
    if (!liveWakeWordEnabled && !liveTtsEnabled) return null;
    const livePhrase = this.wakePhraseFor(liveWakeWordEnabled);
    if ("invalid" in livePhrase) return startFailure(livePhrase.invalid);

    const managerCfg: ManagerConfig = {
      pythonExe: this.pythonExe,
      pythonSourceDir: join(this.platform.paths.unpackedRoot, "python", "damocles_voice_sidecar"),
      modelsDir: this.paths.modelsDir,
      runtimeMode: liveCfg.get<"auto" | "cuda" | "cpu">("damocles.voice.localGpu", "auto"),
      diagnostics: liveCfg.get<boolean>("damocles.voice.diagnostics", false),
      wakePhrase: livePhrase.phrase,
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
    let started = false;
    next.on("status", (s) => {
      // The manager reports an error status only once it has given up restarting itself.
      if (started && s.kind === "error" && this.manager === next) this.failure = { settings: opts.settings, verifyOnly: false, ...startFailure(s.message) };
      this.emit("status", s);
      this.emitRuntimeStatus();
    });
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
      return startFailure(startError instanceof Error ? startError.message : String(startError));
    }
    started = true;
    return null;
  }

  /** The normalized phrase in wake mode and null outside it; `invalid`, after reporting it, when the stored phrase is invalid. */
  private wakePhraseFor(wakeWordEnabled: boolean): { phrase: string | null } | { invalid: string } {
    if (!wakeWordEnabled) return { phrase: null };
    const setting = this.platform.settings.get<string>("damocles.voice.wakeWord", DEFAULT_WAKE_PHRASE);
    const words = parseWakePhrase(setting);
    if (words !== null) return { phrase: words.join(" ") };
    const message = t("The damocles.voice.wakeWord setting is not a valid wake phrase: \"{0}\". Use 1 to 4 English words of letters only, such as \"hey jarvis\".", setting);
    log(`[VoiceService] ${message}`);
    this.emit("status", { kind: "error", code: "fatal", message });
    return { invalid: message };
  }

  /** Aborts the start in flight and stops the sidecar once that start has ended. */
  async stop(): Promise<void> {
    await this.enqueue(async () => {
      const manager = this.manager;
      this.manager = null;
      if (manager !== null) await manager.stop();
      this.emitRuntimeStatus();
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
    // eslint-disable-next-line damocles/no-sync -- VS Code's deactivate does not await
    this.manager?.killChildSync();
    void this.stop().finally(() => this.clearStatusTimer());
  }

  /** Async graceful shutdown for callers that can await (e.g. tests). */
  async shutdown(): Promise<void> {
    if (this.modeWatcher !== null) {
      this.modeWatcher.dispose();
      this.modeWatcher = null;
    }
    await this.stop();
    this.clearStatusTimer();
  }
}
