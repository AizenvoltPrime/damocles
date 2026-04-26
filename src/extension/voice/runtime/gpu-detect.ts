import { spawn } from "node:child_process";

export type CudaInfo = {
  kind: "cuda";
  driverVersion: string;
  torchWheelChannel: "cu121" | "cu118";
};

export type CpuInfo = {
  kind: "cpu";
  reason: "no-smi" | "driver-too-old" | "parse-failed" | "macos" | "no-gpu";
};

export type GpuDetection = CudaInfo | CpuInfo;

const SMI_TIMEOUT_MS = 5_000;

export async function detectGpu(): Promise<GpuDetection> {
  if (process.platform === "darwin") {
    return { kind: "cpu", reason: "macos" };
  }
  const stdout = await runNvidiaSmi();
  if (stdout === null) {
    return { kind: "cpu", reason: "no-smi" };
  }
  const driverVersion = stdout.trim().split(/[\r\n]+/)[0]?.trim();
  if (driverVersion === undefined || driverVersion.length === 0) {
    return { kind: "cpu", reason: "no-gpu" };
  }
  const major = parseDriverMajor(driverVersion);
  if (major === null) {
    return { kind: "cpu", reason: "parse-failed" };
  }
  if (major >= 535) return { kind: "cuda", driverVersion, torchWheelChannel: "cu121" };
  if (major >= 525) return { kind: "cuda", driverVersion, torchWheelChannel: "cu118" };
  return { kind: "cpu", reason: "driver-too-old" };
}

function parseDriverMajor(version: string): number | null {
  const match = version.match(/^(\d+)/);
  if (match === null) return null;
  const major = Number(match[1]);
  if (!Number.isFinite(major)) return null;
  return major;
}

function runNvidiaSmi(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(
      "nvidia-smi",
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
    child.stdout.on("data", (chunk: Buffer) => {
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
