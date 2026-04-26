import { promises as fs } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { detectGpu } from "./gpu-detect";
import type { GpuDetection } from "./gpu-detect";
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

    onProgress({ stage: "detecting", pct: 0, message: "Detecting GPU..." });
    const detection = await this.detectDevice();
    const installSize = pickInstallSize(detection);

    onProgress({ stage: "checking-disk", pct: 5, message: "Checking disk space..." });
    const disk = await this.checkDisk(installSize);
    if (!disk.ok) {
      const need = formatGb(disk.requiredBytes);
      const have = formatGb(disk.freeBytes);
      const msg = `Need ~${need} GB free, have ${have} GB. Free disk or set damocles.voice.runtimePath to a different filesystem.`;
      onProgress({ stage: "error", pct: 5, message: msg });
      return { ok: false, pythonExe: this.paths.pythonExe, device: detection, errorMessage: msg };
    }

    const smokeLogPath = join(this.paths.rootDir, "smoke-check-failure.log");

    if (opts.userSpecifiedPython !== undefined && opts.userSpecifiedPython.length > 0) {
      onProgress({ stage: "smoke-check", pct: 90, message: "Verifying user-supplied Python..." });
      const smoke = await runImportSmokeCheck(opts.userSpecifiedPython, { logPath: smokeLogPath });
      if (!smoke.ok) {
        const msg = formatSmokeError(smoke);
        onProgress({ stage: "error", pct: 90, message: msg });
        return { ok: false, pythonExe: opts.userSpecifiedPython, device: detection, errorMessage: msg };
      }
      onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
      return { ok: true, pythonExe: opts.userSpecifiedPython, device: detection };
    }

    const installed = await detectInstalledRuntime(this.paths);
    if (installed.present) {
      onProgress({ stage: "smoke-check", pct: 10, message: "Verifying existing runtime..." });
      const initial = await runImportSmokeCheck(this.paths.pythonExe, { logPath: smokeLogPath });
      if (initial.ok) {
        onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
        return { ok: true, pythonExe: this.paths.pythonExe, device: detection };
      }
      const repaired = await this.tryRepairRequirements(detection, opts, onProgress);
      if (repaired) {
        const recheck = await runImportSmokeCheck(this.paths.pythonExe, { logPath: smokeLogPath });
        if (recheck.ok) {
          onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
          return { ok: true, pythonExe: this.paths.pythonExe, device: detection };
        }
      }
      onProgress({
        stage: "detecting",
        pct: 10,
        message: "Existing runtime is incomplete; reinstalling...",
      });
      await this.wipeRuntime();
    }

    const installResult = await this.tryFullInstall(detection, opts, onProgress);
    if (!installResult.ok) {
      return { ok: false, pythonExe: this.paths.pythonExe, device: detection, errorMessage: installResult.errorMessage };
    }

    onProgress({ stage: "smoke-check", pct: 90, message: "Verifying installed runtime..." });
    const smoke = await runImportSmokeCheck(this.paths.pythonExe, { logPath: smokeLogPath });
    if (!smoke.ok) {
      const msg = formatSmokeError(smoke);
      onProgress({ stage: "error", pct: 90, message: msg });
      return { ok: false, pythonExe: this.paths.pythonExe, device: detection, errorMessage: msg };
    }

    onProgress({ stage: "done", pct: 100, message: "Voice runtime ready." });
    return { ok: true, pythonExe: this.paths.pythonExe, device: detection };
  }

  private async tryFullInstall(
    detection: GpuDetection,
    opts: InstallAllOptions,
    onProgress: RuntimeProgressCallback,
  ): Promise<{ ok: true } | { ok: false; errorMessage: string }> {
    try {
      await this.runFullInstall(detection, opts, onProgress);
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
