import type { WebviewToExtensionMessage } from "@shared/types/messages";
import type { GpuPreference, VoiceMode } from "@shared/types/voice";

export function buildSetModeMessage(mode: VoiceMode): WebviewToExtensionMessage {
  return { type: "setVoiceMode", mode };
}

export function buildSensitivityMessage(value: number): WebviewToExtensionMessage {
  return { type: "setVoiceWakeWordSensitivity", sensitivity: value };
}

export function buildEndOfTurnMessage(ms: number): WebviewToExtensionMessage {
  return { type: "setVoiceEndOfTurnSilenceMs", ms: Math.round(ms) };
}

export function buildMaxUtteranceMessage(ms: number): WebviewToExtensionMessage {
  return { type: "setVoiceMaxUtteranceMs", ms: Math.round(ms) };
}

export function buildGpuMessage(preference: GpuPreference): WebviewToExtensionMessage {
  return { type: "setVoiceLocalGpu", preference };
}

/**
 * Format the on-disk voice-files byte count into a localizable size string.
 * Returns ``null`` when there's nothing on disk; the caller picks the
 * "Remove all voice files" / "Remove all voice files (X)" copy via i18n.
 */
export function formatVoiceFilesBytes(bytes: number): string | null {
  if (bytes <= 0) return null;
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  return `${(bytes / 1_000_000).toFixed(0)} MB`;
}
