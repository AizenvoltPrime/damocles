import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { detectGpu } from "./gpu-detect";
import type { CpuInfo, GpuDetection } from "./gpu-detect";
import { checkDiskSpace, INSTALL_SIZE_BYTES } from "./disk-check";
import type { DiskCheck } from "./disk-check";
import { runImportSmokeCheck } from "./smoke-check";
import type { SmokeCheckResult } from "./smoke-check";
import {
  downloadAndExtractPython,
  createVenv,
  installPipRequirements,
  pickTorchWheelChannel,
} from "./python-installer";
import type { RuntimeInstallProgressCallback } from "./python-installer";
import {
  cxxToolchainEnv,
  ensureCxxToolchain,
  MissingCxxToolchainError,
} from "./compiler-check";
import { ensurePortAudio, MissingSystemLibraryError } from "./system-libs-check";

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
  | "done"
  | "error";

export type RuntimeProgress = {
  stage: RuntimeStage;
  pct: number;
  message: string;
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

export async function detectInstalledRuntime(paths: RuntimePaths): Promise<{ present: boolean; pythonExe: string }> {
  try {
    await fs.access(paths.pythonExe);
    return { present: true, pythonExe: paths.pythonExe };
  } catch {
    return { present: false, pythonExe: paths.pythonExe };
  }
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
};

export type InstallAllResult = {
  ok: boolean;
  pythonExe: string;
  device: GpuDetection;
  errorMessage?: string;
};

export class VoiceRuntimeInstaller {
  private readonly paths: RuntimePaths;
  private initialized = false;
  private detection: GpuDetection | null = null;
  private installPromise: Promise<InstallAllResult> | null = null;

  constructor(paths: RuntimePaths = getDefaultRuntimePaths()) {
    this.paths = paths;
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

  async installAll(opts: InstallAllOptions = {}): Promise<InstallAllResult> {
    if (this.installPromise !== null) return this.installPromise;
    this.installPromise = (async (): Promise<InstallAllResult> => {
      try {
        return await this.doInstallAll(opts);
      } finally {
        this.installPromise = null;
      }
    })();
    return this.installPromise;
  }

  private async doInstallAll(opts: InstallAllOptions): Promise<InstallAllResult> {
    await this.ensureInitialized();
    const onProgress = opts.onProgress ?? ((): void => {});
    const requestedMode: RuntimeMode = opts.runtimeMode ?? "auto";

    onProgress({ stage: "detecting", pct: 0, message: "Detecting GPU..." });
    const detection = await this.detectDevice();

    const compat = checkRuntimeModeCompatibility(detection, requestedMode);
    if (!compat.ok) {
      onProgress({ stage: "error", pct: 2, message: compat.message });
      return { ok: false, pythonExe: this.paths.pythonExe, device: detection, errorMessage: compat.message };
    }
    const effective = applyUserPreference(detection, requestedMode);
    const installSize = pickInstallSize(effective);
    const smokeLogPath = join(this.paths.rootDir, "smoke-check-failure.log");

    // Power-user path: skip the install-time system-dep pre-flights. The user
    // owns this venv — they may have a conda env that bundles libportaudio in
    // the env's lib dir (where ldconfig won't see it), or a venv with
    // texterrors already built (no compiler needed). Running the probes here
    // would either waste work or false-positive. Smoke check imports the full
    // SMOKE_MODULES list (including sounddevice) against their Python, which
    // is the authoritative way to validate that env.
    if (opts.userSpecifiedPython !== undefined && opts.userSpecifiedPython.length > 0) {
      onProgress({ stage: "smoke-check", pct: 90, message: "Verifying user-supplied Python..." });
      const smoke = await runImportSmokeCheck(opts.userSpecifiedPython, { logPath: smokeLogPath });
      if (!smoke.ok) {
        const msg = formatSmokeError(smoke);
        onProgress({ stage: "error", pct: 90, message: msg });
        return { ok: false, pythonExe: opts.userSpecifiedPython, device: effective, errorMessage: msg };
      }
      onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
      return { ok: true, pythonExe: opts.userSpecifiedPython, device: effective };
    }

    onProgress({ stage: "detecting", pct: 3, message: "Checking C++ toolchain..." });
    let cxxEnv: Record<string, string> | undefined;
    try {
      const toolchain = await ensureCxxToolchain(
        opts.signal !== undefined ? { signal: opts.signal } : {},
      );
      if (toolchain !== null) cxxEnv = cxxToolchainEnv(toolchain);
    } catch (err) {
      if (err instanceof MissingCxxToolchainError) {
        onProgress({ stage: "error", pct: 3, message: err.message });
        return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: err.message };
      }
      throw err;
    }

    onProgress({ stage: "detecting", pct: 4, message: "Checking system libraries (PortAudio)..." });
    try {
      await ensurePortAudio(opts.signal !== undefined ? { signal: opts.signal } : {});
    } catch (err) {
      if (err instanceof MissingSystemLibraryError) {
        onProgress({ stage: "error", pct: 4, message: err.message });
        return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: err.message };
      }
      throw err;
    }

    onProgress({ stage: "checking-disk", pct: 5, message: "Checking disk space..." });
    const disk = await this.checkDisk(installSize);
    if (!disk.ok) {
      const need = formatGb(disk.requiredBytes);
      const have = formatGb(disk.freeBytes);
      const msg = `Need ~${need} GB free, have ${have} GB. Free disk or set damocles.voice.runtimePath to a different filesystem.`;
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
          message:
            `Installed torch wheel is ${installedChannel} but ${expectedChannel} is required ` +
            `(GPU detection: ${detection.kind}, user setting: ${requestedMode}); reinstalling...`,
        });
        await this.wipeRuntime();
      } else {
        onProgress({ stage: "smoke-check", pct: 10, message: "Verifying existing runtime..." });
        const initial = await runImportSmokeCheck(this.paths.pythonExe, { logPath: smokeLogPath });
        if (initial.ok) {
          onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
          return { ok: true, pythonExe: this.paths.pythonExe, device: effective };
        }
        const repaired = await this.tryRepairRequirements(effective, opts, onProgress, cxxEnv);
        if (repaired) {
          const recheck = await runImportSmokeCheck(this.paths.pythonExe, { logPath: smokeLogPath });
          if (recheck.ok) {
            onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
            return { ok: true, pythonExe: this.paths.pythonExe, device: effective };
          }
        }
        onProgress({
          stage: "detecting",
          pct: 10,
          message: "Existing runtime is incomplete; reinstalling...",
        });
        await this.wipeRuntime();
      }
    }

    const installResult = await this.tryFullInstall(effective, opts, onProgress, cxxEnv);
    if (!installResult.ok) {
      return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: installResult.errorMessage };
    }

    onProgress({ stage: "smoke-check", pct: 90, message: "Verifying installed runtime..." });
    const smoke = await runImportSmokeCheck(this.paths.pythonExe, { logPath: smokeLogPath });
    if (!smoke.ok) {
      const msg = formatSmokeError(smoke);
      onProgress({ stage: "error", pct: 90, message: msg });
      return { ok: false, pythonExe: this.paths.pythonExe, device: effective, errorMessage: msg };
    }

    onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
    return { ok: true, pythonExe: this.paths.pythonExe, device: effective };
  }

  private async tryFullInstall(
    detection: GpuDetection,
    opts: InstallAllOptions,
    onProgress: RuntimeProgressCallback,
    cxxEnv: Record<string, string> | undefined,
  ): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    try {
      await this.runFullInstall(detection, opts, onProgress, cxxEnv);
      return { ok: true };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      onProgress({ stage: "error", pct: 80, message: errorMessage });
      return { ok: false, errorMessage };
    }
  }

  private async wipeRuntime(): Promise<void> {
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
      message: "Existing runtime missing packages; running pip install -r requirements.txt...",
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
      onProgress({
        stage: "installing-pip",
        pct: 20,
        message: `Repair install failed: ${err instanceof Error ? err.message : String(err)}`,
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
): { ok: true } | { ok: false; message: string } {
  if (requested !== "cuda") return { ok: true };
  if (detection.kind === "cuda") return { ok: true };
  return { ok: false, message: formatCudaUnavailableMessage(detection) };
}

function formatCudaUnavailableMessage(detection: CpuInfo): string {
  const reason: Record<CpuInfo["reason"], string> = {
    "no-smi": "nvidia-smi was not found on PATH and not at /usr/lib/wsl/lib/nvidia-smi",
    "driver-too-old": "your NVIDIA driver is older than 525.x (minimum for the cu118 torch wheel)",
    "parse-failed": "nvidia-smi output could not be parsed for a driver version",
    "macos": "macOS does not support CUDA",
    "no-gpu": "nvidia-smi reported no GPUs",
    "user-opted-out": "you set Voice GPU to 'cpu' (this branch should not be reachable)",
  };
  return (
    `Voice GPU is set to "cuda" but ${reason[detection.reason]}. ` +
    `Either install/update NVIDIA drivers (and ensure nvidia-smi is reachable) ` +
    `or change the Damocles setting "voice.localGpu" to "auto" (recommended) or "cpu".`
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

/**
 * Read `torch.version.cuda` from the installed venv to discover which torch
 * wheel was installed previously. Used to detect channel mismatch between an
 * existing runtime and what the current (detection, user-setting) tuple would
 * install — when they disagree, the installer wipes and reinstalls instead of
 * letting the sidecar crash at engine load.
 *
 * Returns:
 *   - `cu121` / `cu118` / `cpu`: matching the wheel that's installed
 *   - `missing`: torch isn't importable (use full reinstall path)
 *   - `unknown`: torch is present but the version string didn't parse
 */
export async function detectInstalledTorchChannel(
  pythonExe: string,
): Promise<TorchChannel | "missing" | "unknown"> {
  const script =
    "import sys\n" +
    "try:\n" +
    "    import torch\n" +
    "except Exception:\n" +
    "    sys.stdout.write('missing'); sys.exit(0)\n" +
    "v = getattr(torch.version, 'cuda', None)\n" +
    "if v is None:\n" +
    "    sys.stdout.write('cpu')\n" +
    "elif v.startswith('12.'):\n" +
    "    sys.stdout.write('cu121')\n" +
    "elif v.startswith('11.'):\n" +
    "    sys.stdout.write('cu118')\n" +
    "else:\n" +
    "    sys.stdout.write('unknown')\n";
  return await new Promise((resolve) => {
    const child = spawn(pythonExe, ["-c", script], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let out = "";
    let settled = false;
    const settle = (val: TorchChannel | "missing" | "unknown"): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle("unknown");
    }, 30_000);
    child.stdout?.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); settle("missing"); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return settle("missing");
      const trimmed = out.trim();
      if (trimmed === "cu121" || trimmed === "cu118" || trimmed === "cpu") return settle(trimmed);
      if (trimmed === "missing") return settle("missing");
      return settle("unknown");
    });
  });
}

function formatGb(bytes: number): string {
  return (bytes / 1024 / 1024 / 1024).toFixed(1);
}

function formatSmokeError(result: SmokeCheckResult): string {
  if (result.ok) return "";
  const lines = result.stderr.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const tail = lines.slice(-25).join("\n");
  const moduleClause = result.failedModule !== undefined
    ? ` while importing \`${result.failedModule}\``
    : "";
  const logClause = result.logPath !== undefined
    ? `\nFull traceback written to: ${result.logPath}`
    : "";
  return `Voice runtime smoke check failed${moduleClause}.\n${tail}${logClause}`;
}

export { detectGpu, runImportSmokeCheck, checkDiskSpace, INSTALL_SIZE_BYTES };
export type { GpuDetection, DiskCheck, SmokeCheckResult };
