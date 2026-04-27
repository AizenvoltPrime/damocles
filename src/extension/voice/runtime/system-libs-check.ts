import { spawn } from "node:child_process";
import { access, constants as fsConstants } from "node:fs/promises";

/**
 * sounddevice (the wake-word microphone driver) is a thin Python wrapper around
 * PortAudio. Its Linux/macOS wheels do NOT bundle the PortAudio shared library —
 * it must come from the OS package manager (`libportaudio2` on Debian/Ubuntu,
 * `portaudio` on Fedora/Arch, `brew install portaudio` on macOS). Without it,
 * the sidecar boots through engine load (Parakeet on GPU, VibeVoice TTS) and
 * crashes only at `mic.start()` with the cryptic `OSError: PortAudio library
 * not found`, wasting the entire 5–10 minute install + model-load cycle.
 *
 * The Windows wheel ships PortAudio bundled, so this check is a no-op there.
 *
 * `ensurePortAudio` runs at install start (right after the C++ toolchain check),
 * before any download, and fails with per-distro install commands on missing.
 */

export class MissingSystemLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingSystemLibraryError";
  }
}

const LINUX_LIBPORTAUDIO_KNOWN_PATHS: readonly string[] = [
  "/usr/lib/x86_64-linux-gnu/libportaudio.so.2",
  "/usr/lib/aarch64-linux-gnu/libportaudio.so.2",
  "/usr/lib64/libportaudio.so.2",
  "/usr/lib/libportaudio.so.2",
  "/lib/x86_64-linux-gnu/libportaudio.so.2",
  "/lib/aarch64-linux-gnu/libportaudio.so.2",
  "/lib/libportaudio.so.2",
];

const MACOS_LIBPORTAUDIO_KNOWN_PATHS: readonly string[] = [
  // Homebrew on Apple Silicon
  "/opt/homebrew/lib/libportaudio.dylib",
  "/opt/homebrew/lib/libportaudio.2.dylib",
  // Homebrew on Intel
  "/usr/local/lib/libportaudio.dylib",
  "/usr/local/lib/libportaudio.2.dylib",
  // MacPorts
  "/opt/local/lib/libportaudio.dylib",
  "/opt/local/lib/libportaudio.2.dylib",
];

export function getPortAudioInstallInstructions(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return (
      "Voice runtime needs PortAudio for microphone input (sounddevice's macOS wheel " +
      "does not bundle it). Install via Homebrew:\n" +
      "  brew install portaudio"
    );
  }
  return (
    "Voice runtime needs PortAudio for microphone input (sounddevice's Linux wheel " +
    "does not bundle it). Install your distro's PortAudio runtime:\n" +
    "  Debian / Ubuntu / WSL:  sudo apt update && sudo apt install libportaudio2\n" +
    "  Fedora / RHEL:          sudo dnf install portaudio\n" +
    "  Arch:                   sudo pacman -S --needed portaudio"
  );
}

export type LibraryProbe = (signal?: AbortSignal) => Promise<boolean>;

async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function knownPathsContainPortAudio(paths: readonly string[]): Promise<boolean> {
  for (const path of paths) {
    if (await isReadable(path)) return true;
  }
  return false;
}

async function ldconfigListsPortAudio(signal?: AbortSignal): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const child = spawn("ldconfig", ["-p"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      ...(signal !== undefined ? { signal } : {}),
    });
    let stdout = "";
    let settled = false;
    const settle = (val: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(val);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      settle(false);
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", () => { clearTimeout(timer); settle(false); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) return settle(false);
      settle(/\blibportaudio\.so\.2\b/.test(stdout));
    });
  });
}

async function defaultLinuxProbe(signal?: AbortSignal): Promise<boolean> {
  if (await ldconfigListsPortAudio(signal)) return true;
  return await knownPathsContainPortAudio(LINUX_LIBPORTAUDIO_KNOWN_PATHS);
}

async function defaultDarwinProbe(_signal?: AbortSignal): Promise<boolean> {
  return await knownPathsContainPortAudio(MACOS_LIBPORTAUDIO_KNOWN_PATHS);
}

export type EnsurePortAudioOptions = {
  platform?: NodeJS.Platform;
  signal?: AbortSignal;
  probe?: LibraryProbe;
};

export async function ensurePortAudio(opts: EnsurePortAudioOptions = {}): Promise<void> {
  const platform = opts.platform ?? process.platform;
  if (platform === "win32") return;

  const probe = opts.probe ?? (platform === "darwin" ? defaultDarwinProbe : defaultLinuxProbe);
  if (await probe(opts.signal)) return;
  throw new MissingSystemLibraryError(getPortAudioInstallInstructions(platform));
}
