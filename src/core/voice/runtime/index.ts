import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { detectGpu } from "./gpu-detect";
import type { CpuInfo, GpuDetection } from "./gpu-detect";
import { checkDiskSpace, INSTALL_SIZE_BYTES } from "./disk-check";
import type { DiskCheck } from "./disk-check";
import { runImportSmokeCheck } from "./smoke-check";
import type { SmokeCheckOptions, SmokeCheckResult } from "./smoke-check";
import {
  CancelledError,
  downloadAndExtractPython,
  createVenv,
  installPipRequirements,
  pickTorchWheelChannel,
} from "./python-installer";
import { executablePathForm } from "../../executable-path";
import { errorTextOf, l, withDetail } from "../../l10n";
import type { LocalizedText } from "../../../shared/localized-text";
import type { ExtractWorkerFactory, RuntimeInstallProgressCallback } from "./python-installer";
import {
  cxxToolchainEnv,
  ensureCxxToolchain,
  MissingCxxToolchainError,
} from "./compiler-check";
import { ensurePortAudio, MissingSystemLibraryError } from "./system-libs-check";
import { requireVoiceRuntimePlatform } from "./supported-platforms";
import { detectInstalledRuntime, detectInstalledTorchChannel } from "./installed-runtime";
import { modelBytes, type VoiceModels } from "../models/provision";

export type RuntimeMode = "auto" | "cuda" | "cpu";
export type TorchChannel = "cu121" | "cu118" | "cpu";

export type RuntimeStage =
  | "detecting"
  | "checking-disk"
  | "downloading-python"
  | "extracting-python"
  | "creating-venv"
  | "installing-pip"
  | "smoke-check"
  | "downloading-models"
  | "done"
  | "error";

export type RuntimeProgress = {
  stage: RuntimeStage;
  pct: number;
  message: LocalizedText;
};

export type RuntimeProgressCallback = (p: RuntimeProgress) => void;

export type RuntimePaths = {
  rootDir: string;
  pythonExe: string;
  venvDir: string;
  modelsDir: string;
};

export const DEFAULT_RUNTIME_DIR: string = join(homedir(), ".damocles", "voice");

export function getDefaultRuntimePaths(rootDir: string = DEFAULT_RUNTIME_DIR): RuntimePaths {
  const venvDir = join(rootDir, "runtime", "venv");
  const pythonExe = platform() === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
  return {
    rootDir,
    venvDir,
    pythonExe,
    modelsDir: join(rootDir, "models"),
  };
}

export type InstallAllOptions = {
  paths?: RuntimePaths;
  userSpecifiedPython?: string;
  onProgress?: RuntimeProgressCallback;
  signal?: AbortSignal;
  requirementsFile?: string;
  extensionRoot?: string;
  /**
   * User's `damocles.voice.localGpu` setting. The installer compares this
   * against GPU detection to decide which torch wheel channel to install
   * AND to fail-fast when the user requested cuda but no GPU was found —
   * preventing the silent install/runtime mismatch where the installer
   * commits to `+cpu` torch but the sidecar is later spawned with
   * `--runtime-mode=cuda`, producing the cryptic `<runtime_mode=cuda but
   * CUDA unavailable>` ModelLoadFailed at engine load time. Defaults to
   * `"auto"` (install matches detection; sidecar lets the engine choose).
   */
  runtimeMode?: RuntimeMode;
  /** Whether a missing or broken runtime may be downloaded, repaired or reinstalled; when false, only verified. */
  allowInstall: boolean;
};

export type InstallAllResult = {
  ok: boolean;
  pythonExe: string;
  device: GpuDetection;
  errorMessage?: LocalizedText;
  /** Set when the start may not install and a download would fix the failure: the runtime, or only the models. */
  missing?: "runtime" | "models";
};

export class VoiceRuntimeInstaller {
  private readonly paths: RuntimePaths;
  private readonly createExtractWorker: ExtractWorkerFactory;
  private readonly models: VoiceModels;
  private initialized = false;
  private detection: GpuDetection | null = null;
  private installRun: { allowInstall: boolean; promise: Promise<InstallAllResult> } | null = null;

  constructor(paths: RuntimePaths, createExtractWorker: ExtractWorkerFactory, models: VoiceModels) {
    this.paths = paths;
    this.createExtractWorker = createExtractWorker;
    this.models = models;
  }

  getPaths(): RuntimePaths {
    return this.paths;
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await fs.mkdir(this.paths.rootDir, { recursive: true });
    await fs.mkdir(this.paths.modelsDir, { recursive: true });
    this.initialized = true;
  }

  async detectDevice(): Promise<GpuDetection> {
    if (this.detection !== null) return this.detection;
    this.detection = await detectGpu();
    return this.detection;
  }

  /**
   * Joins the run in flight when it serves this caller: any run serves a verify-only caller, and only an installing run
   * serves one that may install. Otherwise the new run starts after it, so two runs never touch the venv at once.
   */
  async installAll(opts: InstallAllOptions): Promise<InstallAllResult> {
    const inFlight = this.installRun;
    if (inFlight !== null && (inFlight.allowInstall || !opts.allowInstall)) return inFlight.promise;
    const promise = (async (): Promise<InstallAllResult> => {
      if (inFlight !== null) await inFlight.promise.catch(() => undefined);
      return this.doInstallAll(opts);
    })();
    this.installRun = { allowInstall: opts.allowInstall, promise };
    const clear = (): void => {
      if (this.installRun?.promise === promise) this.installRun = null;
    };
    promise.then(clear, clear);
    return promise;
  }

  // The runtime, then the models the sidecar loads: a runtime with no models is not ready to start.
  private async doInstallAll(opts: InstallAllOptions): Promise<InstallAllResult> {
    const onProgress = opts.onProgress ?? ((): void => {});
    const runtime = await this.installRuntime({
      ...opts,
      onProgress: (p) => {
        if (p.stage !== "done") onProgress(p);
      },
    });
    if (!runtime.ok) return runtime;
    const missingModels = await this.ensureModels(opts, onProgress);
    if (missingModels !== null) {
      onProgress({ stage: "error", pct: 100, message: missingModels });
      return { ...runtime, ok: false, errorMessage: missingModels, missing: "models" };
    }
    onProgress({ stage: "done", pct: 100, message: l("Voice runtime ready.") });
    return runtime;
  }

  /** Downloads the missing models; verify-only, it names them instead. Null once every one is on disk. */
  private async ensureModels(opts: InstallAllOptions, onProgress: RuntimeProgressCallback): Promise<LocalizedText | null> {
    const missing = await this.models.missing();
    if (missing.length === 0) return null;
    if (!opts.allowInstall) return l("The voice models are not downloaded ({0}).", missing.map((entry) => entry.id).join(", "));
    const total = missing.reduce((sum, entry) => sum + modelBytes(entry), 0);
    let done = 0;
    for (const entry of missing) {
      const report = (received: number): void => {
        const pct = total > 0 ? Math.min(99, Math.floor(((done + received) / total) * 100)) : 0;
        onProgress({ stage: "downloading-models", pct, message: l("Downloading the {0} model...", entry.id) });
      };
      report(0);
      await this.models.download(entry, opts.signal, report);
      done += modelBytes(entry);
    }
    return null;
  }

  private async installRuntime(opts: InstallAllOptions): Promise<InstallAllResult> {
    // First, runtimePath included: the sidecar targets the pinned requirements.txt, which installs on no other host.
    requireVoiceRuntimePlatform(process.platform, process.arch);
    await this.ensureInitialized();
    const onProgress = opts.onProgress ?? ((): void => {});
    const requestedMode: RuntimeMode = opts.runtimeMode ?? "auto";

    onProgress({ stage: "detecting", pct: 0, message: l("Detecting GPU...") });
    const detection = await this.detectDevice();

    const compat = checkRuntimeModeCompatibility(detection, requestedMode);
    if (!compat.ok) {
      onProgress({ stage: "error", pct: 2, message: compat.message });
      return { ok: false, pythonExe: this.paths.pythonExe, device: detection, errorMessage: compat.message };
    }
    const effective = applyUserPreference(detection, requestedMode);
    const installSize = pickInstallSize(effective);
    const smokeOpts = {
      logPath: join(this.paths.rootDir, "smoke-check-failure.log"),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    };

    // Power-user path: skip the install-time system-dep pre-flights. The user
    // owns this venv — they may have a conda env that bundles libportaudio in
    // the env's lib dir (where ldconfig won't see it), or a venv with
    // texterrors already built (no compiler needed). Running the probes here
    // would either waste work or false-positive. Smoke check imports the full
    // SMOKE_MODULES list (including sounddevice) against their Python, which
    // is the authoritative way to validate that env.
    if (opts.userSpecifiedPython !== undefined && opts.userSpecifiedPython.length > 0) {
      // A relative path would resolve against the working folder of whatever starts it, a repository included.
      if (executablePathForm(opts.userSpecifiedPython, process.platform).kind !== "absolute") {
        const msg = l("damocles.voice.runtimePath must be the absolute path of a Python executable on this computer: \"{0}\".", opts.userSpecifiedPython);
        onProgress({ stage: "error", pct: 90, message: msg });
        return { ok: false, pythonExe: opts.userSpecifiedPython, device: effective, errorMessage: msg };
      }
      onProgress({ stage: "smoke-check", pct: 90, message: l("Verifying user-supplied Python...") });
      const smoke = await runImportSmokeCheck(opts.userSpecifiedPython, smokeOpts);
      if (!smoke.ok) {
        const msg = smokeFailureText(smoke);
        onProgress({ stage: "error", pct: 90, message: msg });
        return { ok: false, pythonExe: opts.userSpecifiedPython, device: effective, errorMessage: msg };
      }
      onProgress({ stage: "done", pct: 100, message: l("Voice runtime ready.") });
      return { ok: true, pythonExe: opts.userSpecifiedPython, device: effective };
    }

    if (!opts.allowInstall) return this.verifyInstalled(effective, smokeOpts, onProgress);

    onProgress({ stage: "detecting", pct: 3, message: l("Checking C++ toolchain...") });
    let cxxEnv: Record<string, string> | undefined;
    try {
      const toolchain = await ensureCxxToolchain(
        opts.signal !== undefined ? { signal: opts.signal } : {},
      );
      if (toolchain !== null) cxxEnv = cxxToolchainEnv(toolchain);
    } catch (err) {
      if (err instanceof MissingCxxToolchainError) {
        onProgress({ stage: "error", pct: 3, message: err.text });
        return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: err.text };
      }
      throw err;
    }

    onProgress({ stage: "detecting", pct: 4, message: l("Checking system libraries (PortAudio)...") });
    try {
      await ensurePortAudio(opts.signal !== undefined ? { signal: opts.signal } : {});
    } catch (err) {
      if (err instanceof MissingSystemLibraryError) {
        onProgress({ stage: "error", pct: 4, message: err.text });
        return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: err.text };
      }
      throw err;
    }

    onProgress({ stage: "checking-disk", pct: 5, message: l("Checking disk space...") });
    const disk = await this.checkDisk(installSize);
    if (!disk.ok) {
      const need = gigabytes(disk.requiredBytes);
      const have = gigabytes(disk.freeBytes);
      const msg = l("The voice runtime needs about {0} GB free on the disk holding {1}, and {2} GB is free. Free disk space and try again.", need, this.paths.rootDir, have);
      onProgress({ stage: "error", pct: 5, message: msg });
      return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: msg };
    }

    const expectedChannel = expectedTorchChannel(effective);
    const installed = await detectInstalledRuntime(this.paths);
    if (installed.present) {
      const installedChannel = await detectInstalledTorchChannel(this.paths.pythonExe);
      if (
        (installedChannel === "cu121" || installedChannel === "cu118" || installedChannel === "cpu") &&
        installedChannel !== expectedChannel
      ) {
        onProgress({
          stage: "detecting",
          pct: 8,
          message: l("Installed torch wheel is {0} but {1} is required (GPU detection: {2}, user setting: {3}); reinstalling...", installedChannel, expectedChannel, detection.kind, requestedMode),
        });
        await this.wipeRuntime(opts.signal);
      } else {
        onProgress({ stage: "smoke-check", pct: 10, message: l("Verifying existing runtime...") });
        const initial = await runImportSmokeCheck(this.paths.pythonExe, smokeOpts);
        if (initial.ok) {
          onProgress({ stage: "done", pct: 100, message: l("Voice runtime ready.") });
          return { ok: true, pythonExe: this.paths.pythonExe, device: effective };
        }
        const repaired = await this.tryRepairRequirements(effective, opts, onProgress, cxxEnv);
        if (repaired) {
          const recheck = await runImportSmokeCheck(this.paths.pythonExe, smokeOpts);
          if (recheck.ok) {
            onProgress({ stage: "done", pct: 100, message: l("Voice runtime ready.") });
            return { ok: true, pythonExe: this.paths.pythonExe, device: effective };
          }
        }
        onProgress({
          stage: "detecting",
          pct: 10,
          message: l("Existing runtime is incomplete; reinstalling..."),
        });
        await this.wipeRuntime(opts.signal);
      }
    }

    const installResult = await this.tryFullInstall(effective, opts, onProgress, cxxEnv);
    if (!installResult.ok) {
      return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: installResult.errorMessage };
    }

    onProgress({ stage: "smoke-check", pct: 90, message: l("Verifying installed runtime...") });
    const smoke = await runImportSmokeCheck(this.paths.pythonExe, smokeOpts);
    if (!smoke.ok) {
      const msg = smokeFailureText(smoke);
      onProgress({ stage: "error", pct: 90, message: msg });
      return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: msg };
    }

    onProgress({ stage: "done", pct: 100, message: l("Voice runtime ready.") });
    return { ok: true, pythonExe: this.paths.pythonExe, device: effective };
  }

  /** The installed runtime, verified; every failure here is one a runtime install fixes. */
  private async verifyInstalled(
    effective: GpuDetection,
    smokeOpts: SmokeCheckOptions,
    onProgress: RuntimeProgressCallback,
  ): Promise<InstallAllResult> {
    const fail = (errorMessage: LocalizedText): InstallAllResult => {
      onProgress({ stage: "error", pct: 10, message: errorMessage });
      return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage, missing: "runtime" };
    };
    if (!(await detectInstalledRuntime(this.paths)).present) return fail(l("The voice runtime is not installed."));
    const expectedChannel = expectedTorchChannel(effective);
    const installedChannel = await detectInstalledTorchChannel(this.paths.pythonExe);
    if ((installedChannel === "cu121" || installedChannel === "cu118" || installedChannel === "cpu") && installedChannel !== expectedChannel) {
      return fail(l("The installed torch wheel is {0} but {1} is required; reinstall the voice runtime.", installedChannel, expectedChannel));
    }
    onProgress({ stage: "smoke-check", pct: 10, message: l("Verifying existing runtime...") });
    const smoke = await runImportSmokeCheck(this.paths.pythonExe, smokeOpts);
    if (!smoke.ok) return fail(smokeFailureText(smoke));
    onProgress({ stage: "done", pct: 100, message: l("Voice runtime ready.") });
    return { ok: true, pythonExe: this.paths.pythonExe, device: effective };
  }

  private async tryFullInstall(
    detection: GpuDetection,
    opts: InstallAllOptions,
    onProgress: RuntimeProgressCallback,
    cxxEnv: Record<string, string> | undefined,
  ): Promise<{ ok: true } | { ok: false; errorMessage: LocalizedText }> {
    try {
      await this.runFullInstall(detection, opts, onProgress, cxxEnv);
      return { ok: true };
    } catch (err) {
      if (opts.signal?.aborted === true) throw err;
      const errorMessage = errorTextOf(err);
      onProgress({ stage: "error", pct: 80, message: errorMessage });
      return { ok: false, errorMessage };
    }
  }

  /** Removes the installed runtime for a reinstall, unless the start was cancelled: a later install repairs what is there. */
  private async wipeRuntime(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted === true) throw new CancelledError();
    const runtimeDir = dirname(this.paths.venvDir);
    await fs.rm(runtimeDir, { recursive: true, force: true });
  }

  private async tryRepairRequirements(
    detection: GpuDetection,
    opts: InstallAllOptions,
    onProgress: RuntimeProgressCallback,
    cxxEnv: Record<string, string> | undefined,
  ): Promise<boolean> {
    let requirementsFile: string;
    try {
      requirementsFile = opts.requirementsFile ?? defaultRequirementsPath(opts.extensionRoot);
      await assertReadable(requirementsFile);
    } catch {
      return false;
    }
    onProgress({
      stage: "installing-pip",
      pct: 20,
      message: l("Existing runtime missing packages; running pip install -r requirements.txt..."),
    });
    const torchChannel = detection.kind === "cuda"
      ? pickTorchWheelChannel(detection.kind, detection.torchWheelChannel)
      : pickTorchWheelChannel(detection.kind, undefined);
    try {
      await installPipRequirements({
        venvPython: this.paths.pythonExe,
        requirementsFile,
        gpuKind: detection.kind,
        torchWheelChannel: torchChannel,
        onProgress: (p) => onProgress({ stage: p.stage, pct: p.pct, message: p.message }),
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(cxxEnv !== undefined ? { envOverride: cxxEnv } : {}),
      });
      return true;
    } catch (err) {
      if (opts.signal?.aborted === true) throw err;
      onProgress({
        stage: "installing-pip",
        pct: 20,
        message: l("Repair install failed: {0}", errorTextOf(err)),
      });
      return false;
    }
  }

  async checkDisk(installSizeBytes: number): Promise<DiskCheck> {
    return checkDiskSpace(this.paths.rootDir, installSizeBytes);
  }

  private async runFullInstall(
    detection: GpuDetection,
    opts: InstallAllOptions,
    onProgress: RuntimeProgressCallback,
    cxxEnv: Record<string, string> | undefined,
  ): Promise<void> {
    const installerProgress: RuntimeInstallProgressCallback = (p) => {
      onProgress({ stage: p.stage, pct: p.pct, message: p.message });
    };
    const runtimeDir = dirname(this.paths.venvDir);
    await fs.mkdir(runtimeDir, { recursive: true });

    const extractResult = await downloadAndExtractPython({
      targetDir: runtimeDir,
      createExtractWorker: this.createExtractWorker,
      gpuKind: detection.kind,
      onProgress: installerProgress,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const venvPython = await createVenv({
      pythonExe: extractResult.pythonExe,
      venvDir: this.paths.venvDir,
      onProgress: installerProgress,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });

    const requirementsFile = opts.requirementsFile ?? defaultRequirementsPath(opts.extensionRoot);
    await assertReadable(requirementsFile);
    const torchChannel = detection.kind === "cuda"
      ? pickTorchWheelChannel(detection.kind, detection.torchWheelChannel)
      : pickTorchWheelChannel(detection.kind, undefined);

    await installPipRequirements({
      venvPython,
      requirementsFile,
      gpuKind: detection.kind,
      torchWheelChannel: torchChannel,
      onProgress: installerProgress,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(cxxEnv !== undefined ? { envOverride: cxxEnv } : {}),
    });
  }
}

function defaultRequirementsPath(extensionRoot: string | undefined): string {
  if (extensionRoot === undefined || extensionRoot.length === 0) {
    throw new Error(
      "VoiceRuntimeInstaller.installAll requires `extensionRoot` (or `requirementsFile`). " +
      "process.cwd() is not safe inside the VS Code extension host — it resolves to the VS Code install directory.",
    );
  }
  return join(extensionRoot, "python", "damocles_voice_sidecar", "requirements.txt");
}

async function assertReadable(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Voice sidecar requirements file not found at ${filePath}. Reinstall the extension.`);
  }
}

function pickInstallSize(detection: GpuDetection): number {
  if (detection.kind === "cpu") return INSTALL_SIZE_BYTES.cpuAny;
  return process.platform === "win32" ? INSTALL_SIZE_BYTES.cudaWindows : INSTALL_SIZE_BYTES.cudaLinux;
}

/**
 * Verify the user's `localGpu` setting can be honored by the detected hardware.
 * `cuda` is strict — the user explicitly opted IN to GPU and the engine loader
 * (`asr_parakeet.py:71-76`) refuses to fall back to CPU for that mode. Without
 * this gate the installer would commit to the `+cpu` torch wheel and the
 * sidecar would later crash with the cryptic
 * `<runtime_mode=cuda but CUDA unavailable>` ModelLoadFailed at engine load.
 * `auto` and `cpu` are always compatible (auto downgrades to CPU at runtime;
 * cpu opts out of GPU regardless of detection).
 */
export function checkRuntimeModeCompatibility(
  detection: GpuDetection,
  requested: RuntimeMode,
): { ok: true } | { ok: false; message: LocalizedText } {
  if (requested !== "cuda") return { ok: true };
  if (detection.kind === "cuda") return { ok: true };
  return { ok: false, message: formatCudaUnavailableMessage(detection) };
}

function cudaUnavailableReason(reason: CpuInfo["reason"]): LocalizedText {
  switch (reason) {
    case "no-smi": return l("nvidia-smi was not found on PATH or at /usr/lib/wsl/lib/nvidia-smi.");
    case "driver-too-old": return l("The NVIDIA driver is older than 525.x, the minimum for the cu118 torch package.");
    case "parse-failed": return l("The driver version could not be read from the output of nvidia-smi.");
    case "macos": return l("macOS does not support CUDA.");
    case "no-gpu": return l("nvidia-smi reported no GPU.");
    case "user-opted-out": return l("Voice was set to run on the CPU.");
  }
}

function formatCudaUnavailableMessage(detection: CpuInfo): LocalizedText {
  return l(
    "The GPU preference for voice is \"cuda\", but CUDA cannot be used here. {0} Install or update the NVIDIA driver and make sure nvidia-smi can be found, or set the GPU preference (damocles.voice.localGpu) to \"auto\" (recommended) or \"cpu\".",
    cudaUnavailableReason(detection.reason),
  );
}

/**
 * Convert raw GPU detection into the *effective* device we'll install for,
 * given the user's preference. `cpu` request when CUDA was detected returns a
 * synthetic `cpu` detection so the installer commits to the `+cpu` torch wheel
 * (avoiding a wasted 2 GB CUDA download). `cuda` request when CUDA is missing
 * is rejected upstream by `checkRuntimeModeCompatibility`, so we never need to
 * promote `cpu` to `cuda` here.
 */
export function applyUserPreference(detection: GpuDetection, requested: RuntimeMode): GpuDetection {
  if (requested === "cpu" && detection.kind === "cuda") {
    return { kind: "cpu", reason: "user-opted-out" };
  }
  return detection;
}

export function expectedTorchChannel(detection: GpuDetection): TorchChannel {
  if (detection.kind === "cuda") return detection.torchWheelChannel;
  return "cpu";
}

// Gigabytes to a tenth, which the renderer formats in its locale.
function gigabytes(bytes: number): { number: number } {
  return { number: Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10 };
}

/** A failed import check: Damocles' headline over the last lines Python wrote and where its whole traceback is. */
export function smokeFailureText(result: Extract<SmokeCheckResult, { ok: false }>): LocalizedText {
  const tail = result.stderr.split(/\r?\n/).filter((line) => line.trim().length > 0).slice(-25).join("\n");
  const headline = result.failedModule !== undefined
    ? l("The voice runtime check failed while importing {0}.", result.failedModule)
    : l("The voice runtime check failed.");
  return withDetail(headline, result.logPath !== undefined ? l("{0}\nThe full traceback was written to {1}", tail, result.logPath) : tail);
}

export { detectGpu, runImportSmokeCheck, checkDiskSpace, INSTALL_SIZE_BYTES, detectInstalledRuntime, detectInstalledTorchChannel };
export type { GpuDetection, DiskCheck, SmokeCheckResult };
