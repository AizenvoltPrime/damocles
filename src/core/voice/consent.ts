// The user's consent to the voice downloads, given in the first-run dialog: docs/voice-jarvis-mode.md "Install and status".
import { createHash } from "node:crypto";
import type { Memento } from "../../platform/key-value-state";
import type { VoiceModelManifest } from "./models/manifest";

/** Host global state, never a setting: a settings file a repository ships must not be able to consent for the user. */
const CONSENT_STATE_KEY = "damocles.voice.downloadConsent";

// Bump when the first-run dialog discloses something the fingerprint does not read from the manifest (its size notes, the
// microphone and privacy points), so a consent given to the old text asks again.
const DISCLOSURE_VERSION = 1;

/**
 * What the dialog disclosed, as a hash: the disclosure version, each model's id and license, the wake model's, and the
 * model download rounded up to whole gigabytes. A manifest that adds a model, changes a license or grows the download past
 * the next gigabyte changes it; a new version of a model under the same license does not.
 */
export function disclosureFingerprint(manifest: VoiceModelManifest): string {
  const models = manifest.models.map((entry) => [entry.id, entry.license, entry.license_url]).sort((a, b) => a.join("\n").localeCompare(b.join("\n")));
  const bytes = manifest.models.reduce((sum, entry) => sum + entry.files.reduce((total, file) => total + file.bytes, 0), 0);
  const disclosed = {
    version: DISCLOSURE_VERSION,
    models,
    wake: [manifest.wakeModel.id, manifest.wakeModel.license, manifest.wakeModel.license_url],
    gigabytes: Math.ceil(bytes / 1e9),
  };
  return createHash("sha256").update(JSON.stringify(disclosed)).digest("hex");
}

export interface VoiceDownloadConsent {
  /** Whether the user accepted the dialog as it discloses the current manifest. */
  given(): Promise<boolean>;
  record(): Promise<void>;
}

export function voiceDownloadConsentIn(state: Memento, manifest: () => Promise<VoiceModelManifest>): VoiceDownloadConsent {
  let fingerprint: Promise<string> | null = null;
  // The manifest ships with the app, so one read serves the process.
  const current = (): Promise<string> => (fingerprint ??= manifest().then(disclosureFingerprint));
  return {
    async given() {
      return state.get<string>(CONSENT_STATE_KEY) === (await current());
    },
    async record() {
      await state.update(CONSENT_STATE_KEY, await current());
    },
  };
}
