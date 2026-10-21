// The models the voice sidecar loads, as the runtime install provisions them: what is missing, and its download.
import type { SettingsStore } from "../../../platform/settings-store";
import { downloadModel } from "./downloader";
import { compareInstalled, loadManifest, type ModelEntry } from "./manifest";

// Mirrors engines/loader.py: wake-word mode loads the VAD and ASR models (the keyword spotter ships with the app), and
// spoken replies load VibeVoice.
const WAKE_WORD_MODEL_IDS: readonly string[] = ["silero_vad", "parakeet_tdt_0_6b_v2"];
const TTS_MODEL_IDS: readonly string[] = ["vibevoice_realtime_0_5b"];

/** The manifest model ids the sidecar loads with wake-word mode and spoken replies on or off. */
export function modelIdsLoadedBy(modes: { wakeWord: boolean; tts: boolean }): Set<string> {
  return new Set([...(modes.wakeWord ? WAKE_WORD_MODEL_IDS : []), ...(modes.tts ? TTS_MODEL_IDS : [])]);
}

export interface VoiceModels {
  /**
   * The models the sidecar loads under the current settings that are not on disk at the manifest version, which is the
   * only version it reads: an older version on disk counts as missing.
   */
  missing(): Promise<ModelEntry[]>;
  /** Downloads and verifies one model, reporting its bytes so far across its files; throws when it fails, `CancelledError` on abort. */
  download(entry: ModelEntry, signal: AbortSignal | undefined, onBytes: (received: number) => void): Promise<void>;
}

export function voiceModelsAt(unpackedRoot: string, modelsDir: string, settings: SettingsStore): VoiceModels {
  return {
    async missing() {
      const loaded = modelIdsLoadedBy({
        wakeWord: settings.get<string>("damocles.voice.mode", "off") === "wake-word",
        tts: settings.get<boolean>("damocles.voice.tts.enabled", false),
      });
      const manifest = await loadManifest(unpackedRoot);
      const { missing, outdated } = await compareInstalled(modelsDir, { ...manifest, models: manifest.models.filter((entry) => loaded.has(entry.id)) });
      return [...missing, ...outdated];
    },
    async download(entry, signal, onBytes) {
      // The downloader counts per file.
      const received = new Map<string, number>();
      // Nothing listed is gated; the first-run dialog states every model's license.
      await downloadModel({
        entry,
        modelsRoot: modelsDir,
        acceptLicense: true,
        ...(signal !== undefined ? { signal } : {}),
        onProgress: (p) => {
          received.set(p.filename, p.bytesReceived);
          onBytes([...received.values()].reduce((sum, bytes) => sum + bytes, 0));
        },
      });
    },
  };
}

export const modelBytes = (entry: ModelEntry): number => entry.files.reduce((sum, file) => sum + file.bytes, 0);
