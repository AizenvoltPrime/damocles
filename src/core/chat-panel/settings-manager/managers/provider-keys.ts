import type { Platform } from "../../../../platform/platform";
import { isKeyProviderId, type AccountProviderId, type KeyProviderId } from "../../../../shared/settings-sections";
import type { ExtensionToWebviewMessage } from "../../../../shared/types/messages";
import { customProviderDef, providerKeyStored } from "../../../pi-session/custom-providers";
import { PiRuntime } from "../../../pi-session/pi-runtime";
import { log } from "../../../logger";
import { clientKeySaved, clientPrefersApiKey } from "../../../client-snapshots";
import { PI_AGENT_DIR } from "../../../pi-session/agent-dir";
import { providerCredentialActive, readPreferProviderApiKey, readProviderSignIns } from "../../../pi-session/provider-auth";

// Neither syncs the keys: the secret's change event, which this window's own writes raise too, runs the runtime's one key sync.

/**
 * Saving a key, even the same one, is the user saying its classifier refusal is resolved (a 402 can clear with the same key).
 * The reset may precede the key sync: a changed key resets the breaker again once pi holds it.
 */
export async function storeProviderKey(platform: Platform, provider: KeyProviderId, key: string): Promise<void> {
  await platform.secrets.store(customProviderDef(provider).key.secretKey, key.trim());
  log("[ProviderKeys] stored the %s key", provider);
  if (PiRuntime.exists) PiRuntime.get().resetClassifierBreaker(provider);
}

export async function deleteProviderKey(platform: Platform, provider: KeyProviderId): Promise<void> {
  await platform.secrets.delete(customProviderDef(provider).key.secretKey);
  log("[ProviderKeys] deleted the %s key", provider);
}

/** Undefined when the secret store failed or did not answer in time, so the last status posted stands. */
export async function providerAuthStatus(
  platform: Platform,
  provider: AccountProviderId,
): Promise<Extract<ExtensionToWebviewMessage, { type: "providerAuthStatusChanged" }> | undefined> {
  // on a daemon's core auth.json reads as the pinned (else acting) client's sign-ins
  const signIns = readProviderSignIns(PI_AGENT_DIR);
  const signIn = signIns?.[provider];
  const signedIn = signIn?.type === "oauth";
  const signInFields = { signedIn, ...(signedIn && signIn.expires !== undefined ? { signedInExpiresAt: signIn.expires } : {}) };
  // Before pi starts, nothing says which credentials it reads; the first custom-provider sync posts this again.
  const runtime = PiRuntime.exists ? PiRuntime.get() : undefined;
  // a sign-in-only provider has no key; a daemon's core leaves external and active to the client
  if (!isKeyProviderId(provider)) {
    if (platform.remote) return { type: "providerAuthStatusChanged", provider, configured: false, external: null, ...signInFields, preferApiKey: false };
    const external = runtime ? runtime.externalKeySource(provider, signIns) : null;
    const active = providerCredentialActive({ key: false, signedIn, external }, false);
    return { type: "providerAuthStatusChanged", provider, configured: false, external, ...signInFields, preferApiKey: false, active };
  }
  // a daemon's core: the key is the client's, known from its clientAuth, never read; which credential is active is the client's to say
  if (platform.remote) {
    const preferApiKey = clientPrefersApiKey(platform.remote, provider);
    return { type: "providerAuthStatusChanged", provider, configured: clientKeySaved(platform.remote, customProviderDef(provider).provider), external: null, ...signInFields, preferApiKey };
  }
  const stored = await providerKeyStored((k) => platform.secrets.get(k), customProviderDef(provider).key.secretKey);
  if (stored === undefined) {
    log("[ProviderKeys] the secret store did not answer for the %s key; its status is unchanged", provider);
    return undefined;
  }
  const preferApiKey = runtime ? runtime.preferProviderApiKey(provider) : readPreferProviderApiKey(platform.state, provider);
  const external = runtime ? runtime.externalKeySource(provider, signIns) : null;
  const active = providerCredentialActive({ key: stored, signedIn, external }, preferApiKey);
  return { type: "providerAuthStatusChanged", provider, configured: stored, external, ...signInFields, preferApiKey, active };
}

/** Prefer the saved key over a stored sign-in for `provider`, or not; a daemon's core refuses, since the flag is the client's. */
export async function setProviderPreferApiKey(provider: KeyProviderId, preferApiKey: boolean): Promise<void> {
  await PiRuntime.get().setProviderPreferApiKey(provider, preferApiKey);
  log("[ProviderKeys] %s the saved %s key over a sign-in", preferApiKey ? "preferring" : "not preferring", provider);
}
