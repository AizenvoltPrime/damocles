import { spawn } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";

export type CudaInfo = {
  kind: "cuda";
  driverVersion: string;
  torchWheelChannel: "cu121" | "cu118";
  /**
   * Path that successfully returned the driver version. Either `"nvidia-smi"`
   * (resolved through PATH) or the WSL2 canonical passthrough binary at
   * `/usr/lib/wsl/lib/nvidia-smi`. Surfaced for log diagnostics.
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

async function findWorkingNvidiaSmi(): Promise<{ stdout: string; smiPath: string } | null> {
  const pathStdout = await runSpecificNvidiaSmi("nvidia-smi");
  if (pathStdout !== null) return { stdout: pathStdout, smiPath: "nvidia-smi" };
  if (process.platform === "linux") {
    const wslExists = await isExecutable(WSL_NVIDIA_SMI_PATH);
    if (wslExists) {
      const wslStdout = await runSpecificNvidiaSmi(WSL_NVIDIA_SMI_PATH);
      if (wslStdout !== null) return { stdout: wslStdout, smiPath: WSL_NVIDIA_SMI_PATH };
    }
  }
  return null;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runSpecificNvidiaSmi(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      cmd,
      ["--query-gpu=driver_version", "--format=csv,noheader"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let stdout = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        resolve(null);
      }
    }, SMI_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(null);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? stdout : null);
    });
  });
}
