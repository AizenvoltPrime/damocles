import type { SecretsStore } from "../../platform/secrets-store";
import { log } from "../logger";

/** Stored credentials Damocles no longer reads. Append a key here when a credential is retired; never remove one. */
export const RETIRED_SECRET_KEYS: readonly string[] = ["damocles.explore.apiKey.gemini"];

/**
 * Deletes every retired credential. Unconditional, because the desktop store's `get` answers undefined for an entry it
 * could not decrypt, which `delete` still removes. Best-effort per key; logs key names only.
 */
export async function deleteRetiredSecrets(secrets: Pick<SecretsStore, "delete">, keys: readonly string[] = RETIRED_SECRET_KEYS): Promise<void> {
  for (const key of keys) {
    try {
      await secrets.delete(key);
    } catch (err) {
      log(`[Migration] Could not delete the retired secret ${key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
