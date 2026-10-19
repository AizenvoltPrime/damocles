import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import type { RuntimePaths, TorchChannel } from "./index";

export async function detectInstalledRuntime(paths: RuntimePaths): Promise<{ present: boolean; pythonExe: string }> {
  try {
    await fs.access(paths.pythonExe);
    return { present: true, pythonExe: paths.pythonExe };
  } catch {
    return { present: false, pythonExe: paths.pythonExe };
  }
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
