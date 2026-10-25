import type { Platform } from "../../../../platform/platform";
import type { KeyProviderId } from "../../../../shared/settings-sections";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { customProviderDef, providerKeyStored } from "../../../pi-session/custom-providers";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { log } from "../../../logger";
import { clientHasKey } from "../../../client-snapshots";

/** Awaited, so a status read next (memory judge, image generation's OpenRouter check) sees the new key. */
async function resyncCustomProvidersNow(platform: Platform): Promise<void> {
  if (!PiRuntime.exists) return;
  await PiRuntime.get().syncCustomProviders((k) => platform.secrets.get(k));
}

/** Saving a key, even the same one, is the user saying its classifier refusal is resolved (a 402 can clear with the same key). */
export async function storeProviderKey(platform: Platform, provider: KeyProviderId, key: string): Promise<void> {
  await platform.secrets.store(customProviderDef(provider).secretKey, key.trim());
  log("[ProviderKeys] stored the %s key", provider);
  await resyncCustomProvidersNow(platform);
  if (PiRuntime.exists) PiRuntime.get().resetClassifierBreaker(provider);
}

export async function deleteProviderKey(platform: Platform, provider: KeyProviderId): Promise<void> {
  await platform.secrets.delete(customProviderDef(provider).secretKey);
  log("[ProviderKeys] deleted the %s key", provider);
  await resyncCustomProvidersNow(platform);
}

/** Undefined when the secret store failed or did not answer in time, so the last status posted stands. */
export async function providerAuthStatus(
  platform: Platform,
  provider: KeyProviderId,
): Promise<Extract<ExtensionToWebviewMessage, { type: "providerAuthStatusChanged" }> | undefined> {
  // a daemon's core: the key is the client's, known from its clientAuth, never read
  if (platform.remote) return { type: "providerAuthStatusChanged", provider, configured: clientHasKey(platform.remote, customProviderDef(provider).provider), external: null };
  const stored = await providerKeyStored((k) => platform.secrets.get(k), customProviderDef(provider).secretKey);
  if (stored === undefined) {
    log("[ProviderKeys] the secret store did not answer for the %s key; its status is unchanged", provider);
    return undefined;
  }
  // Before pi starts, nothing says which credentials it reads; the first custom-provider sync posts this again.
  const external = PiRuntime.exists ? PiRuntime.get().externalKeySource(provider) : null;
  return { type: "providerAuthStatusChanged", provider, configured: stored, external };
}
