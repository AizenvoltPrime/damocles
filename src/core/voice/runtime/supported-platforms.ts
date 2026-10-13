import { t } from "../../l10n";

export type PbsTriple = "x86_64-pc-windows-msvc" | "x86_64-unknown-linux-gnu" | "aarch64-apple-darwin";

export type VoiceRuntimePlatform = { platform: NodeJS.Platform; arch: NodeJS.Architecture; pbsTriple: PbsTriple };

// Each pair needs a checksum per release in tarball-checksums.json and wheels for every pin in requirements.txt; see docs/voice-jarvis-mode.md "Python and platforms".
export const VOICE_RUNTIME_PLATFORMS: readonly VoiceRuntimePlatform[] = [
  { platform: "win32", arch: "x64", pbsTriple: "x86_64-pc-windows-msvc" },
  { platform: "linux", arch: "x64", pbsTriple: "x86_64-unknown-linux-gnu" },
  { platform: "darwin", arch: "arm64", pbsTriple: "aarch64-apple-darwin" },
];

export class UnsupportedPlatformError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPlatformError";
  }
}

const OS_NAMES: Partial<Record<NodeJS.Platform, string>> = { win32: "Windows", linux: "Linux", darwin: "macOS" };

function platformName(platform: NodeJS.Platform, arch: string): string {
  return `${OS_NAMES[platform] ?? platform} ${arch}`;
}

function findVoiceRuntimePlatform(platform: NodeJS.Platform, arch: string): VoiceRuntimePlatform | undefined {
  return VOICE_RUNTIME_PLATFORMS.find((supported) => supported.platform === platform && supported.arch === arch);
}

function refusal(platform: NodeJS.Platform, arch: string): string {
  const supported = VOICE_RUNTIME_PLATFORMS.map((entry) => platformName(entry.platform, entry.arch)).join(", ");
  return t(
    "Jarvis voice mode (wake word and spoken replies) is not available on {0}. Its local speech runtime supports only {1}. Push-to-talk with cloud speech-to-text (Whisper, Deepgram or Google) still works.",
    platformName(platform, arch),
    supported,
  );
}

/** The localized refusal on a host the voice runtime cannot install on, null on a supported one. */
export function unsupportedVoicePlatformMessage(platform: NodeJS.Platform, arch: string): string | null {
  return findVoiceRuntimePlatform(platform, arch) === undefined ? refusal(platform, arch) : null;
}

export function requireVoiceRuntimePlatform(platform: NodeJS.Platform, arch: string): VoiceRuntimePlatform {
  const supported = findVoiceRuntimePlatform(platform, arch);
  if (supported === undefined) throw new UnsupportedPlatformError(refusal(platform, arch));
  return supported;
}
