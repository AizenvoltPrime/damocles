import { access, constants as fsConstants } from "node:fs/promises";
import * as path from "node:path";
import { executablePathForm } from "../../executable-path";
import { runProcess } from "../../process-launcher";
import { findOnAbsolutePath, windowsSystemDirectory } from "../../system-tools";

export type CudaInfo = {
  kind: "cuda";
  driverVersion: string;
  torchWheelChannel: "cu121" | "cu118";
  /**
   * Absolute path that successfully returned the driver version (see
   * nvidiaSmiCandidates). Surfaced for log diagnostics.
   */
  smiPath: string;
};

export type CpuInfo = {
  kind: "cpu";
  reason:
    | "no-smi"
    | "driver-too-old"
    | "parse-failed"
    | "macos"
    | "no-gpu"
    | "user-opted-out";
};

export type GpuDetection = CudaInfo | CpuInfo;

const SMI_TIMEOUT_MS = 5_000;

/**
 * WSL2 ships nvidia-smi at this path as part of the GPU passthrough package.
 * vscode-server can launch the extension host with a PATH that doesn't include
 * `/usr/lib/wsl/lib`, even when the user's interactive shell does (where
 * `which nvidia-smi` resolves correctly). Probing this canonical path as a
 * fallback makes detection robust against that environment quirk — without it,
 * detection silently falls through to `kind: "cpu", reason: "no-smi"` and the
 * installer commits to the CPU torch wheel even though the user has a GPU.
 */
export const WSL_NVIDIA_SMI_PATH: string = "/usr/lib/wsl/lib/nvidia-smi";

export async function detectGpu(): Promise<GpuDetection> {
  if (process.platform === "darwin") {
    return { kind: "cpu", reason: "macos" };
  }
  const found = await findWorkingNvidiaSmi();
  if (found === null) {
    return { kind: "cpu", reason: "no-smi" };
  }
  const driverVersion = found.stdout.trim().split(/[\r\n]+/)[0]?.trim();
  if (driverVersion === undefined || driverVersion.length === 0) {
    return { kind: "cpu", reason: "no-gpu" };
  }
  const major = parseDriverMajor(driverVersion);
  if (major === null) {
    return { kind: "cpu", reason: "parse-failed" };
  }
  if (major >= 535) {
    return { kind: "cuda", driverVersion, torchWheelChannel: "cu121", smiPath: found.smiPath };
  }
  if (major >= 525) {
    return { kind: "cuda", driverVersion, torchWheelChannel: "cu118", smiPath: found.smiPath };
  }
  return { kind: "cpu", reason: "driver-too-old" };
}

function parseDriverMajor(version: string): number | null {
  const match = version.match(/^(\d+)/);
  if (match === null) return null;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return null;
  return major;
}

/**
 * Where nvidia-smi may be, in order, every one absolute: the first absolute PATH
 * folder holding it, then on Windows System32 (current drivers) and NVSMI (older
 * drivers), and on Linux the WSL2 passthrough binary.
 */
export function nvidiaSmiCandidates(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): string[] {
  const windows = platform === "win32";
  const onPath = findOnAbsolutePath(windows ? "nvidia-smi.exe" : "nvidia-smi", platform, env);
  const programFiles = env["ProgramFiles"];
  const installed = windows
    ? [
        path.win32.join(windowsSystemDirectory(env), "nvidia-smi.exe"),
        ...(programFiles !== undefined && executablePathForm(programFiles, "win32").kind === "absolute"
          ? [path.win32.join(programFiles, "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe")]
          : []),
      ]
    : platform === "linux" ? [WSL_NVIDIA_SMI_PATH] : [];
  return [...new Set([...(onPath !== undefined ? [onPath] : []), ...installed])];
}

async function findWorkingNvidiaSmi(): Promise<{ stdout: string; smiPath: string } | null> {
  for (const smiPath of nvidiaSmiCandidates(process.platform, process.env)) {
    if (!(await isExecutable(smiPath))) continue;
    const stdout = await runSpecificNvidiaSmi(smiPath);
    if (stdout !== null) return { stdout, smiPath };
  }
  return null;
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function runSpecificNvidiaSmi(cmd: string): Promise<string | null> {
  try {
    const { exit, stdout } = await runProcess(
      { file: cmd, args: ["--query-gpu=driver_version", "--format=csv,noheader"], stdio: ["ignore", "pipe", "pipe"] },
      { timeoutMs: SMI_TIMEOUT_MS },
    );
    return exit?.code === 0 ? stdout.toString("utf8") : null;
  } catch {
    return null;
  }
}
