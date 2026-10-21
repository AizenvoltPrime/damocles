import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { delimiter } from "node:path";
import { processLauncher, type LaunchedProcess } from "../../process-launcher";

const SDK_STRIPPED_ENV_KEYS: readonly string[] = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
] as const;

export type SpawnOptions = {
  pythonExe: string;
  pythonSourceDir: string;
  modelsDir: string;
  runtimeMode: "cuda" | "cpu" | "auto";
  diagnostics: boolean;
  /** The normalized `damocles.voice.wakeWord` phrase; null when wake detection is off. */
  wakePhrase: string | null;
  ttsEnabled: boolean;
};

export type SpawnResult = {
  child: LaunchedProcess;
  pid: number;
  port: number;
  token: string;
};

export async function pickEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("failed to allocate ephemeral port"));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export function buildSidecarEnv(token: string, pythonSourceDir: string): Record<string, string> {
  const result: Record<string, string> = {};
  const stripped = new Set(SDK_STRIPPED_ENV_KEYS);
  for (const [k, v] of Object.entries(process.env)) {
    if (stripped.has(k)) continue;
    if (v === undefined) continue;
    result[k] = v;
  }
  const existingPath = process.env["PYTHONPATH"];
  result["PYTHONPATH"] = existingPath !== undefined && existingPath.length > 0
    ? `${pythonSourceDir}${delimiter}${existingPath}`
    : pythonSourceDir;
  result["DAMOCLES_VOICE_TOKEN"] = token;
  result["PYTHONUNBUFFERED"] = "1";
  return result;
}

export function buildSidecarArgs(opts: SpawnOptions, port: number): string[] {
  const args = [
    "-m",
    "damocles_voice_sidecar",
    "--port",
    String(port),
    "--models-dir",
    opts.modelsDir,
    "--runtime-mode",
    opts.runtimeMode,
  ];
  if (opts.diagnostics) args.push("--diagnostics");
  if (opts.wakePhrase !== null) args.push("--wake-word-enabled", "--wake-word", opts.wakePhrase);
  if (opts.ttsEnabled) args.push("--tts-enabled");
  return args;
}

export async function spawnSidecar(opts: SpawnOptions): Promise<SpawnResult> {
  const port = await pickEphemeralPort();
  const token = randomBytes(32).toString("hex");
  const args = buildSidecarArgs(opts, port);
  // A tree kill reaches the sidecar's python workers: on Windows through the job object the launcher starts it in, on
  // POSIX through the process group a detached start makes it lead.
  const child = processLauncher().launch({
    file: opts.pythonExe,
    args,
    env: buildSidecarEnv(token, opts.pythonSourceDir),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  return { child, pid: await child.pid, port, token };
}
