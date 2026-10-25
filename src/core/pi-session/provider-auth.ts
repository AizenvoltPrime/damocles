import type { KeyValueState } from '../../platform/key-value-state';
import type { ExternalKeySource, KeyProviderId, ProviderCredentialActive } from '../../shared/settings-sections';
import { planModelIdsOf } from '../../shared/remote-user';
import { logAuthReadFailure, readAuthFile } from './auth-file';

/** A provider's credential in pi's auth.json: a sign-in (`oauth`) or a stored key (`api_key`). */
export interface StoredProviderCredential {
  type: 'oauth' | 'api_key';
  expires?: number;
  availableModelIds?: readonly string[];
}

/** Each provider's auth.json credential, by pi provider id. */
export type ProviderSignIns = Readonly<Record<string, StoredProviderCredential>>;

/**
 * Global-state key: prefer the key saved in Damocles over a stored sign-in for a key provider. Global, as the OpenAI
 * flag is, and the client's on a daemon's core (`CLIENT_STATE_KEYS`).
 */
export function providerPreferApiKeyState(provider: KeyProviderId): string {
  return `damocles.${provider}.preferApiKey`;
}

export function readPreferProviderApiKey(state: Pick<KeyValueState, 'global'>, provider: KeyProviderId): boolean {
  return state.global.get<boolean>(providerPreferApiKeyState(provider), false);
}

/** Whether the key saved in Damocles is applied as pi's runtime key, which overrides a stored sign-in. */
export function providerRuntimeKeyWanted(state: { key: boolean; signedIn: boolean }, preferApiKey: boolean): boolean {
  return state.key && (preferApiKey || !state.signedIn);
}

/** The credential pi sends. pi resolves a stored sign-in before an environment or models.json key, so `external` never outranks one. */
export function providerCredentialActive(state: { key: boolean; signedIn: boolean; external: ExternalKeySource | null }, preferApiKey: boolean): ProviderCredentialActive {
  if (providerRuntimeKeyWanted(state, preferApiKey)) return 'apiKey';
  if (state.signedIn) return 'signIn';
  return state.external !== null ? 'external' : 'none';
}

/** Every provider's auth.json credential type, expiry and model list, read without loading pi; undefined when auth.json is unreadable. */
export function readProviderSignIns(agentDir: string): ProviderSignIns | undefined {
  let auth: Record<string, unknown> | undefined;
  try {
    auth = readAuthFile(agentDir);
  } catch (err) {
    logAuthReadFailure('provider-auth', err, 'reading every key provider as signed out');
    return undefined;
  }
  const signIns: Record<string, StoredProviderCredential> = {};
  for (const [provider, entry] of Object.entries(auth ?? {})) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { type, expires, availableModelIds } = entry as Record<string, unknown>;
    if (type !== 'oauth' && type !== 'api_key') continue;
    const plan = planModelIdsOf(availableModelIds);
    signIns[provider] = {
      type,
      ...(typeof expires === 'number' ? { expires } : {}),
      ...(plan ? { availableModelIds: plan } : {}),
    };
  }
  return signIns;
}

/** Each provider's stored sign-in model list (`availableModelIds`) as a set; a provider whose sign-in lists none is absent. */
export function planModelsOf(signIns: ProviderSignIns | undefined): ReadonlyMap<string, ReadonlySet<string>> {
  const plans = new Map<string, ReadonlySet<string>>();
  for (const [provider, credential] of Object.entries(signIns ?? {})) {
    if (credential.type === 'oauth' && credential.availableModelIds) plans.set(provider, new Set(credential.availableModelIds));
  }
  return plans;
}
