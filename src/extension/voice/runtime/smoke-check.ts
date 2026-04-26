import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";

const SMOKE_MODULES = [
  "torch",
  "torchaudio",
  "openwakeword",
  "silero_vad",
  "nemo.collections.asr",
  "websockets.asyncio.server",
  "diffusers",
  "accelerate",
  "transformers",
] as const;
const SMOKE_TIMEOUT_MS = 60_000;

const SMOKE_SCRIPT = `
import sys, traceback
modules = ${JSON.stringify(SMOKE_MODULES)}
for name in modules:
    try:
        __import__(name)
    except BaseException:
        sys.stderr.write("FAILED_MODULE=" + name + "\\n")
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        sys.exit(1)

# CUDA 12.x channel verification: python-installer.ts installs cuda-python
# whenever torch was built against a CUDA 12.x wheel (the cu121 channel).
# Detecting the channel via torch.version.cuda keeps this smoke check in
# sync with the install logic without threading channel info through args.
# A missing cuda module here means the install pipeline regressed and the
# RNNT decoder will silently fall back to a slower path at runtime.
try:
    import torch
    cuda_ver = getattr(torch.version, "cuda", None)
except BaseException:
    cuda_ver = None
if cuda_ver is not None and cuda_ver.startswith("12."):
    try:
        __import__("cuda")
    except BaseException:
        sys.stderr.write("FAILED_MODULE=cuda\\n")
        traceback.print_exc(file=sys.stderr)
        sys.stderr.flush()
        sys.exit(1)
print("ok")
`;

export type SmokeCheckResult =
  | { ok: true }
  | {
      ok: false;
      stderr: string;
      exitCode: number | null;
      failedModule?: string;
      logPath?: string;
    };

export type SmokeCheckOptions = {
  logPath?: string;
};

export async function runImportSmokeCheck(
  venvPython: string,
  opts: SmokeCheckOptions = {},
): Promise<SmokeCheckResult> {
  const raw = await spawnSmoke(venvPython);
  if (raw.exitCode === 0 && raw.stdout.trim() === "ok") return { ok: true };

  const failedModule = parseFailedModule(raw.stderr);
  const logPath = await persistFailureLog(opts.logPath, raw, failedModule);
  const failure: {
    ok: false;
    stderr: string;
    exitCode: number | null;
    failedModule?: string;
    logPath?: string;
  } = {
    ok: false,
    stderr: raw.stderr,
    exitCode: raw.exitCode,
  };
  if (failedModule !== undefined) failure.failedModule = failedModule;
  if (logPath !== undefined) failure.logPath = logPath;
  return failure;
}

type RawSmokeOutput = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
};

function spawnSmoke(venvPython: string): Promise<RawSmokeOutput> {
  return new Promise((resolve) => {
    const child = spawn(venvPython, ["-c", SMOKE_SCRIPT], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr: stderr + "\n[smoke check timed out]", exitCode: null, timedOut: true });
    }, SMOKE_TIMEOUT_MS);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: false });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + err.message, exitCode: null, timedOut: false });
    });
  });
}

function parseFailedModule(stderr: string): string | undefined {
  const match = stderr.match(/^FAILED_MODULE=(\S+)/m);
  return match !== null ? match[1] : undefined;
}

async function persistFailureLog(
  logPath: string | undefined,
  raw: RawSmokeOutput,
  failedModule: string | undefined,
): Promise<string | undefined> {
  if (logPath === undefined || logPath.length === 0) return undefined;
  const header = [
    `timestamp=${new Date().toISOString()}`,
    `exitCode=${raw.exitCode}`,
    `timedOut=${raw.timedOut}`,
    `failedModule=${failedModule ?? "unknown"}`,
    "",
    "--- stdout ---",
    raw.stdout,
    "--- stderr ---",
    raw.stderr,
  ].join("\n");
  try {
    await fs.mkdir(dirname(logPath), { recursive: true });
    await fs.writeFile(logPath, header, "utf8");
    return logPath;
  } catch {
    return undefined;
  }
}
