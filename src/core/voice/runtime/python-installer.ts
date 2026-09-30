import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { extract as tarExtract } from "tar";
import type { GpuDetection } from "./gpu-detect";
import tarballChecksums from "./tarball-checksums.json";

/** Auth env vars that must never leak into a Damocles-spawned subprocess (they belong to the Claude CLI). */
const STRIPPED_ENV_KEYS: readonly string[] = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"];

/**
 * A sanitized copy of `process.env` for a Damocles subprocess: strips shell-level CLI auth vars and
 * force-enables the PowerShell tool on Windows. Never mutates `process.env` (it is shared across
 * extensions in the host).
 */
function cleanSubprocessEnv(): Record<string, string> {
  const stripped = new Set<string>(STRIPPED_ENV_KEYS);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (stripped.has(key) || value === undefined) continue;
    result[key] = value;
  }
  if (process.platform === "win32" && !("CLAUDE_CODE_USE_POWERSHELL_TOOL" in result)) {
    result["CLAUDE_CODE_USE_POWERSHELL_TOOL"] = "1";
  }
  return result;
}

export const PBS_RELEASE_20241016: string = "20241016";
export const PBS_PYTHON_VERSION: string = "3.11.10";

const PBS_BASE_URL: string = "https://github.com/indygreg/python-build-standalone/releases/download";

export type RuntimeInstallStage =
  | "downloading-python"
  | "extracting-python"
  | "creating-venv"
  | "installing-pip";

export type RuntimeInstallProgress = {
  stage: RuntimeInstallStage;
  pct: number;
  message: string;
  bytesReceived?: number;
  bytesTotal?: number;
};

export type RuntimeInstallProgressCallback = (p: RuntimeInstallProgress) => void;

export class UnsupportedPlatformError extends Error {
  constructor(platform: NodeJS.Platform, arch: string) {
    super(
      `Voice runtime auto-install is not supported on ${platform}/${arch}. ` +
        `Set damocles.voice.runtimePath to an existing CUDA-PyTorch venv to bypass.`,
    );
    this.name = "UnsupportedPlatformError";
  }
}

export class ChecksumMismatchError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly url: string;
  constructor(url: string, expected: string, actual: string) {
    super(
      `SHA-256 mismatch for ${url}: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`,
    );
    this.name = "ChecksumMismatchError";
    this.expected = expected;
    this.actual = actual;
    this.url = url;
  }
}

export class CancelledError extends Error {
  constructor() {
    super("Operation cancelled");
    this.name = "CancelledError";
  }
}

type PbsRelease = {
  release: string;
  python_version: string;
  checksums: Record<string, string>;
};

type ChecksumsFile = {
  releases: PbsRelease[];
};

const CHECKSUMS: ChecksumsFile = tarballChecksums as ChecksumsFile;

export type PbsTriple =
  | "x86_64-pc-windows-msvc"
  | "x86_64-apple-darwin"
  | "aarch64-apple-darwin"
  | "x86_64-unknown-linux-gnu";

export function pickPbsTriple(platform: NodeJS.Platform, arch: string): PbsTriple {
  if (platform === "win32" && arch === "x64") return "x86_64-pc-windows-msvc";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  throw new UnsupportedPlatformError(platform, arch);
}

export type PbsCandidate = {
  release: string;
  pythonVersion: string;
  url: string;
  expectedSha256: string;
};

/**
 * Return all known-good PBS download candidates in preference order.
 *
 * indygreg has yanked PBS releases historically; with a single release
 * hardcoded, a yank breaks every new install until we ship a patch. The
 * installer should try the primary release first and fall through to
 * fallbacks on 404. Maintainers add fallbacks by appending to
 * ``tarball-checksums.json``'s ``releases`` array.
 */
export function getPbsCandidates(platform: NodeJS.Platform, arch: string): PbsCandidate[] {
  const triple = pickPbsTriple(platform, arch);
  const candidates: PbsCandidate[] = [];
  for (const rel of CHECKSUMS.releases) {
    const sha = rel.checksums[triple];
    if (sha === undefined) continue;
    const filename = `cpython-${rel.python_version}+${rel.release}-${triple}-install_only.tar.gz`;
    candidates.push({
      release: rel.release,
      pythonVersion: rel.python_version,
      url: `${PBS_BASE_URL}/${rel.release}/${filename}`,
      expectedSha256: sha,
    });
  }
  if (candidates.length === 0) {
    throw new UnsupportedPlatformError(platform, arch);
  }
  return candidates;
}

export function getPbsTarballUrl(
  platform: NodeJS.Platform,
  arch: string,
  _gpuKind: GpuDetection["kind"],
): string {
  return getPbsCandidates(platform, arch)[0]!.url;
}

export function getPbsExpectedSha256(platform: NodeJS.Platform, arch: string): string {
  return getPbsCandidates(platform, arch)[0]!.expectedSha256;
}

export function isPlaceholderChecksum(sha: string): boolean {
  return sha.startsWith("PLACEHOLDER_");
}

export type DownloadOptions = {
  url: string;
  destFile: string;
  expectedSha256: string;
  signal?: AbortSignal;
  onProgress?: RuntimeInstallProgressCallback;
  fetchImpl?: typeof fetch;
};

export async function downloadWithResumeAndVerify(opts: DownloadOptions): Promise<void> {
  const partialFile = `${opts.destFile}.partial`;
  await fs.mkdir(dirname(opts.destFile), { recursive: true });
  const fetchImpl = opts.fetchImpl ?? fetch;

  let resumeFrom = 0;
  try {
    const stat = await fs.stat(partialFile);
    resumeFrom = stat.size;
  } catch {
    resumeFrom = 0;
  }

  const headers: Record<string, string> = {};
  if (resumeFrom > 0) headers["Range"] = `bytes=${resumeFrom}-`;

  const response = await fetchImpl(opts.url, {
    headers,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
  });
  if (!(response.ok || response.status === 206)) {
    throw new Error(`Download failed (${response.status} ${response.statusText}): ${opts.url}`);
  }
  if (resumeFrom > 0 && response.status === 200) {
    await fs.rm(partialFile, { force: true });
    resumeFrom = 0;
  }

  const totalHeader = response.headers.get("content-length");
  const contentLength = totalHeader === null ? 0 : Number(totalHeader);
  const totalBytes = resumeFrom + contentLength;

  const flag = resumeFrom > 0 ? "a" : "w";
  const writeStream = createWriteStream(partialFile, { flags: flag });
  let receivedSinceStart = 0;

  if (response.body === null) {
    writeStream.end();
    throw new Error(`Empty response body for ${opts.url}`);
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      if (opts.signal?.aborted === true) {
        await new Promise<void>((resolve) => writeStream.end(resolve));
        throw new CancelledError();
      }
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBuffer);
      const ok = writeStream.write(chunk);
      if (!ok) await new Promise<void>((resolve) => writeStream.once("drain", () => resolve()));
      receivedSinceStart += chunk.byteLength;
      if (opts.onProgress !== undefined) {
        const totalReceived = resumeFrom + receivedSinceStart;
        const pct = totalBytes > 0 ? Math.min(60, Math.floor((totalReceived / totalBytes) * 60)) : 30;
        const args: RuntimeInstallProgress = {
          stage: "downloading-python",
          pct,
          message: `Downloaded ${formatMb(totalReceived)} MB of ${formatMb(totalBytes)} MB`,
          bytesReceived: totalReceived,
          bytesTotal: totalBytes,
        };
        opts.onProgress(args);
      }
    }
  } finally {
    await new Promise<void>((resolve) => writeStream.end(resolve));
  }

  if (!isPlaceholderChecksum(opts.expectedSha256)) {
    const actual = await sha256OfFile(partialFile);
    if (actual.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
      await fs.rm(partialFile, { force: true });
      throw new ChecksumMismatchError(opts.url, opts.expectedSha256, actual);
    }
  }

  await fs.rename(partialFile, opts.destFile);
}

function formatMb(bytes: number): string {
  return (bytes / 1024 / 1024).toFixed(1);
}

async function sha256OfFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", (err) => reject(err));
  });
}

export type DownloadAndExtractOptions = {
  targetDir: string;
  signal?: AbortSignal;
  onProgress?: RuntimeInstallProgressCallback;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  gpuKind: GpuDetection["kind"];
};

export type DownloadAndExtractResult = {
  pythonExe: string;
  pythonHomeDir: string;
};

export async function downloadAndExtractPython(
  opts: DownloadAndExtractOptions,
): Promise<DownloadAndExtractResult> {
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  const candidates = getPbsCandidates(platform, arch);

  await fs.mkdir(opts.targetDir, { recursive: true });

  // Try each PBS release in preference order. On 404 (yanked release),
  // fall through to the next candidate. ChecksumMismatchError on any
  // candidate is fatal — that means the tarball is wrong, not missing.
  let lastError: unknown = null;
  let chosen: PbsCandidate | null = null;
  for (const candidate of candidates) {
    const tarballPath = join(opts.targetDir, `python-${candidate.release}.tar.gz`);
    try {
      await downloadWithResumeAndVerify({
        url: candidate.url,
        destFile: tarballPath,
        expectedSha256: candidate.expectedSha256,
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
        ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
      });
      chosen = candidate;
      break;
    } catch (err) {
      if (err instanceof ChecksumMismatchError) throw err;
      if (err instanceof CancelledError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/\b404\b|Not Found/i.test(message)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  if (chosen === null) {
    throw new Error(
      `All ${candidates.length} python-build-standalone release(s) failed to download. ` +
        `Most recent error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }
  const tarballPath = join(opts.targetDir, `python-${chosen.release}.tar.gz`);

  if (opts.onProgress !== undefined) {
    opts.onProgress({ stage: "extracting-python", pct: 65, message: "Extracting Python runtime..." });
  }

  await tarExtract({
    file: tarballPath,
    cwd: opts.targetDir,
    strict: true,
    filter: (path) => {
      // Defense-in-depth alongside the SHA-256 verification above. The tar
      // npm package already rejects absolute paths and parent-dir traversal
      // by default, but we re-assert here so a future supply-chain
      // compromise of the indygreg tarball cannot extract outside the
      // target dir even if someone disables the default safeguards.
      if (path.length === 0) return false;
      if (path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;
      if (path === ".." || path.startsWith("../") || path.includes("/../") || path.endsWith("/..")) return false;
      if (path.includes("\\..\\") || path.startsWith("..\\") || path.endsWith("\\..")) return false;
      return true;
    },
  });
  await fs.rm(tarballPath, { force: true });

  const pythonHomeDir = join(opts.targetDir, "python");
  const pythonExe = platform === "win32"
    ? join(pythonHomeDir, "python.exe")
    : join(pythonHomeDir, "bin", "python3");
  await fs.access(pythonExe);

  return { pythonExe, pythonHomeDir };
}

export type SpawnLineCallback = (line: string) => void;

export type SpawnCaptureResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

async function spawnAndCapture(
  cmd: string,
  args: string[],
  options: {
    cwd?: string;
    signal?: AbortSignal;
    onLine?: SpawnLineCallback;
    envOverride?: Record<string, string>;
  },
): Promise<SpawnCaptureResult> {
  return new Promise((resolve, reject) => {
    const env = cleanSubprocessEnv();
    if (options.envOverride !== undefined) {
      for (const [key, value] of Object.entries(options.envOverride)) {
        env[key] = value;
      }
    }
    const spawnOpts: Parameters<typeof spawn>[2] = {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    };
    const child = spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    let stdoutBuf = "";
    let stderrBuf = "";

    const onAbort = (): void => {
      child.kill("SIGTERM");
    };
    if (options.signal !== undefined) options.signal.addEventListener("abort", onAbort, { once: true });

    if (child.stdout === null || child.stderr === null) {
      reject(new Error(`Failed to attach stdio for ${cmd}`));
      return;
    }
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    childStdout.setEncoding("utf8");
    childStderr.setEncoding("utf8");
    childStdout.on("data", (chunk: string) => {
      stdout += chunk;
      stdoutBuf += chunk;
      const lines = stdoutBuf.split(/\r?\n/);
      stdoutBuf = lines.pop() ?? "";
      if (options.onLine !== undefined) for (const l of lines) if (l.length > 0) options.onLine(l);
    });
    childStderr.on("data", (chunk: string) => {
      stderr += chunk;
      stderrBuf += chunk;
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() ?? "";
      if (options.onLine !== undefined) for (const l of lines) if (l.length > 0) options.onLine(l);
    });
    child.on("error", (err) => {
      if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
      reject(err);
    });
    child.on("exit", (code) => {
      if (options.signal !== undefined) options.signal.removeEventListener("abort", onAbort);
      if (options.onLine !== undefined) {
        if (stdoutBuf.length > 0) options.onLine(stdoutBuf);
        if (stderrBuf.length > 0) options.onLine(stderrBuf);
      }
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

export type CreateVenvOptions = {
  pythonExe: string;
  venvDir: string;
  signal?: AbortSignal;
  onProgress?: RuntimeInstallProgressCallback;
};

export async function createVenv(opts: CreateVenvOptions): Promise<string> {
  if (opts.onProgress !== undefined) {
    opts.onProgress({ stage: "creating-venv", pct: 75, message: "Creating Python virtualenv..." });
  }
  await fs.mkdir(dirname(opts.venvDir), { recursive: true });
  const venvResult = await spawnAndCapture(
    opts.pythonExe,
    ["-m", "venv", opts.venvDir],
    {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
  );
  if (venvResult.exitCode !== 0) {
    throw new Error(`python -m venv failed (${venvResult.exitCode}): ${venvResult.stderr}`);
  }
  const venvPython = process.platform === "win32"
    ? join(opts.venvDir, "Scripts", "python.exe")
    : join(opts.venvDir, "bin", "python");
  await fs.access(venvPython);

  const ensurepip = await spawnAndCapture(
    venvPython,
    ["-m", "ensurepip", "--upgrade"],
    {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    },
  );
  if (ensurepip.exitCode !== 0) {
    throw new Error(`ensurepip failed (${ensurepip.exitCode}): ${ensurepip.stderr}`);
  }
  return venvPython;
}

export type InstallPipOptions = {
  venvPython: string;
  requirementsFile: string;
  gpuKind: GpuDetection["kind"];
  torchWheelChannel?: "cu121" | "cu118" | "cpu";
  signal?: AbortSignal;
  onProgress?: RuntimeInstallProgressCallback;
  /**
   * Compiler env overrides (CC/CXX) for source-built packages like texterrors.
   * Resolved by `ensureCxxToolchain()` in `index.ts` before any pip work runs,
   * so a missing toolchain fails fast instead of after the 2 GB torch download.
   */
  envOverride?: Record<string, string>;
};

export function pickTorchWheelChannel(
  gpuKind: GpuDetection["kind"],
  cudaChannel: "cu121" | "cu118" | undefined,
): "cu121" | "cu118" | "cpu" {
  if (gpuKind === "cpu") return "cpu";
  return cudaChannel ?? "cu121";
}

const BUILD_TOOLS_PINS: readonly string[] = [
  "pip>=25.0,<26",
  "setuptools>=75,<76",
  "wheel>=0.45,<1",
];

const TORCH_VERSION: string = "2.4.1";
const TORCH_FAMILY_PINS: readonly string[] = [
  `torch==${TORCH_VERSION}`,
  `torchaudio==${TORCH_VERSION}`,
];

async function runPip(
  venvPython: string,
  args: string[],
  opts: {
    signal?: AbortSignal;
    onProgress?: RuntimeInstallProgressCallback;
    pct: number;
    message: string;
    envOverride?: Record<string, string>;
  },
): Promise<SpawnCaptureResult> {
  if (opts.onProgress !== undefined) {
    opts.onProgress({ stage: "installing-pip", pct: opts.pct, message: opts.message });
  }
  return spawnAndCapture(venvPython, args, {
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.envOverride !== undefined ? { envOverride: opts.envOverride } : {}),
    onLine: (line) => {
      if (opts.onProgress === undefined) return;
      opts.onProgress({ stage: "installing-pip", pct: opts.pct, message: line.slice(0, 240) });
    },
  });
}

function pipFailureMessage(result: SpawnCaptureResult, label: string): string {
  const lines = `${result.stdout}\n${result.stderr}`
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-30).join("\n");
  return `${label} failed (exit ${result.exitCode}):\n${tail}`;
}

export async function installPipRequirements(opts: InstallPipOptions): Promise<void> {
  const channel = pickTorchWheelChannel(opts.gpuKind, opts.torchWheelChannel === "cpu" ? undefined : opts.torchWheelChannel);
  const torchIndexUrl = `https://download.pytorch.org/whl/${channel}`;
  const envOverride = opts.envOverride;

  const bootstrap = await runPip(
    opts.venvPython,
    ["-m", "pip", "install", "--upgrade", "--prefer-binary", ...BUILD_TOOLS_PINS],
    {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(envOverride !== undefined ? { envOverride } : {}),
      pct: 78,
      message: "Pinning build tools (pip, setuptools, wheel)...",
    },
  );
  if (bootstrap.exitCode !== 0) {
    throw new Error(pipFailureMessage(bootstrap, "pip bootstrap"));
  }

  const torchInstall = await runPip(
    opts.venvPython,
    [
      "-m", "pip", "install",
      "--prefer-binary",
      // --index-url <pytorch> + --extra-index-url <pypi>: pip prefers the
      // PyTorch CDN for torch wheels (the CUDA-tagged ones only live there)
      // but falls back to PyPI for transitive deps the PyTorch mirror
      // doesn't carry. Without the PyPI fallback, indirect packages
      // (sympy, networkx, fsspec, etc.) periodically 404 on the PyTorch
      // CDN and the install collapses.
      "--index-url", torchIndexUrl,
      "--extra-index-url", "https://pypi.org/simple",
      ...TORCH_FAMILY_PINS,
    ],
    {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(envOverride !== undefined ? { envOverride } : {}),
      pct: 82,
      message: `Installing torch family from ${channel} channel...`,
    },
  );
  if (torchInstall.exitCode !== 0) {
    throw new Error(pipFailureMessage(torchInstall, "torch install"));
  }

  if (channel === "cu121") {
    // cu121 only: cuda-python wheels track the CUDA toolkit major
    // version and NeMo requires >=12.3. cu118 drivers cannot load
    // cuda-python 12.x at runtime, so we don't install it there.
    // Without this NeMo emits "No conditional node support for Cuda"
    // and the RNNT decoder falls back to a slower path.
    const cudaPython = await runPip(
      opts.venvPython,
      [
        "-m", "pip", "install",
        "--prefer-binary",
        "cuda-python>=12.3,<13",
      ],
      {
        ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
        ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
        ...(envOverride !== undefined ? { envOverride } : {}),
        pct: 84,
        message: "Installing cuda-python (NeMo CUDA-graph decoder)...",
      },
    );
    if (cudaPython.exitCode !== 0) {
      throw new Error(pipFailureMessage(cudaPython, "cuda-python install"));
    }
  }

  const result = await runPip(
    opts.venvPython,
    [
      "-m", "pip", "install",
      "--prefer-binary",
      "-r", opts.requirementsFile,
    ],
    {
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      ...(opts.onProgress !== undefined ? { onProgress: opts.onProgress } : {}),
      ...(envOverride !== undefined ? { envOverride } : {}),
      pct: 85,
      message: "Installing Python packages...",
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(pipFailureMessage(result, "pip install"));
  }
}
