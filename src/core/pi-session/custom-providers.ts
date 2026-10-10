/**
 * custom-providers.ts — Native multi-provider registration for subagents (Phase 5, US-018.8).
 *
 * Replaces the explore proxy's purpose with native pi providers (no loopback). Keys come from
 * SecretStorage entries and are applied to the live `ModelRuntime` as
 * in-memory runtime API keys (`setRuntimeApiKey`) — never `process.env`. StepFun is registered fresh
 * against its step-plan SUBSCRIPTION endpoint
 * (`api.stepfun.ai/step_plan`, Anthropic-shaped, Bearer auth, model `step-5-preview`); DeepSeek, OpenRouter
 * and TypeSafe are existing pi providers that only need their key.
 *
 * This module owns the provider table and the cheap-model lookup (provider-matched Explore default, §4.9).
 *
 * SEMANTIC NOTE: custom-provider keys are NOT persisted into pi's `auth.json`. They are applied as
 * in-memory `ModelRuntime` runtime overrides (`setRuntimeApiKey`) and re-synced from VS Code
 * SecretStorage on every session start and on secret change — so they live only for the process
 * lifetime and never leak into pi's on-disk credential store. When a secret is ABSENT, the sync
 * deauthenticates the provider (drops the runtime override, unregisters a fresh-registered provider,
 * and deletes any stored credential) — this both makes secret deletion take effect immediately and
 * sweeps legacy plaintext keys that Damocles ≤2.6 wrote into auth.json.
 *
 * pi 0.85 credential semantics: `setRuntimeApiKey` / `removeRuntimeApiKey` / `logout` serialize per
 * provider, and after committing the credential run an OFFLINE single-provider refresh plus an
 * availability probe that reads `auth.json` under a file lock — not 0.83's whole-runtime networked
 * refresh. All three honor `AuthOperationOptions.signal`, which truly cancels rather than orphaning an
 * operation still holding the lock; `deps.signal` threads that through.
 */

import type { Api, AuthOperationOptions } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';
import { describeAuthError, isCredentialSyncError } from './describe-error';
import type { ModelLookup } from './pi-models';
import { PROVIDER_SECRET_KEYS } from './explore-providers';

/** pi's `registerProvider` config shape (`ProviderConfigInput` is not re-exported from the package root). */
type ProviderConfigInput = Parameters<ModelRuntime['registerProvider']>[1];

/** A custom provider Damocles can register/authenticate from a stored secret. */
export interface CustomProviderDef {
  /** pi provider name. */
  provider: string;
  /** SecretStorage key holding the API key. */
  secretKey: string;
  /** Whether pi already ships this provider (only auth needed) or it must be registered fresh. */
  mode: 'register' | 'authenticate';
  /** The provider's designated cheap model id (used for the provider-matched Explore default). Absent for
   *  a provider with no chat models (TypeSafe serves only classifiers). */
  cheapModelId?: string;
  /** Full `registerProvider` config for `mode: 'register'` providers (StepFun). */
  registerConfig?: ProviderConfigInput;
}

/**
 * StepFun's "step-plan" SUBSCRIPTION base URL. The official Anthropic SDK (pi's anthropic-messages path)
 * appends `/v1/messages`, giving `…/step_plan/v1/messages` — the documented step-plan endpoint. This is
 * the subscription product (flat fee), NOT the pay-per-token standard API at `…/v1`.
 */
const STEPFUN_BASE_URL = 'https://api.stepfun.ai/step_plan';

export const TYPESAFE_SECRET_KEY = 'damocles.typesafe.apiKey';

/**
 * The key-backed providers, registered/authenticated only when their secret is present. StepFun is
 * registered fresh (pi has no first-party StepFun provider); the others are pi providers that only need
 * their key set.
 */
export const CUSTOM_PROVIDER_DEFS: readonly CustomProviderDef[] = [
  {
    provider: 'stepfun',
    secretKey: PROVIDER_SECRET_KEYS.stepfun,
    mode: 'register',
    cheapModelId: 'step-5-preview',
    registerConfig: {
      baseUrl: STEPFUN_BASE_URL,
      api: 'anthropic-messages' as Api,
      // step-plan authenticates `Authorization: Bearer <key>`, which `authHeader: true` makes pi add beside the
      // Anthropic SDK's own `x-api-key`. Step 5 Preview is a 1M-context multimodal reasoning model. Cost is 0: the
      // step-plan subscription is a flat fee, so there's no per-token dollar metering (token usage still
      // shows, mirroring how the Anthropic subscription mode is treated).
      authHeader: true,
      models: [
        {
          id: 'step-5-preview',
          name: 'StepFun Step 5 Preview',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 1_000_000,
          maxTokens: 64_000,
          // step_plan takes reasoning effort as adaptive `output_config.effort` and REJECTS the
          // token-budget `thinking.budget_tokens` shape; `forceAdaptiveThinking` makes pi-ai's
          // anthropic-messages path emit the adaptive shape.
          compat: { forceAdaptiveThinking: true },
          // StepFun offers only low|medium|high and cannot disable thinking, so pi clamps `off` up to `low`.
          thinkingLevelMap: { off: null, minimal: null, xhigh: null, max: null },
        },
      ],
    },
  },
  {
    // DeepSeek is a pi BUILT-IN provider (api.deepseek.com, openai-completions). It only needs its key
    // applied as a runtime override; `registry.getModel('deepseek', …)` always resolves. Its key lives
    // in its own SecretStorage entry.
    provider: 'deepseek',
    secretKey: 'damocles.deepseek.apiKey',
    mode: 'authenticate',
    cheapModelId: 'deepseek-flash',
  },
  {
    // Image generation, Jev on OpenRouter and template `model:` pins; no cheap model, so the Explore default never picks it.
    provider: 'openrouter',
    secretKey: PROVIDER_SECRET_KEYS.openrouter,
    mode: 'authenticate',
  },
  {
    // Classifier-only (Jev) for the memory judges.
    provider: 'typesafe',
    secretKey: TYPESAFE_SECRET_KEY,
    mode: 'authenticate',
  },
];

/** Find the custom-provider def for a pi provider name. */
export function customProviderDef(provider: string): CustomProviderDef | undefined {
  return CUSTOM_PROVIDER_DEFS.find((d) => d.provider === provider);
}

/** Resolves a provider's secret value, or undefined when unset. PromiseLike so VS Code's
 *  `SecretStorage.get` (a `Thenable`) can be passed directly. */
export type SecretResolver = (key: string) => PromiseLike<string | undefined>;

export interface SyncCustomProvidersDeps {
  modelRuntime: ModelRuntime;
  getSecret: SecretResolver;
  /** Cancels the sync — checked between providers and forwarded as `AuthOperationOptions.signal`. */
  signal?: AbortSignal;
}

export interface SyncCustomProvidersResult {
  /** Providers whose key is live on the runtime. */
  wired: string[];
  /** The signal fired before every provider had been processed. */
  aborted: boolean;
  /** Configured, but not live: failed to apply, its secret could not be read, or it was never reached
   *  because the signal fired AND it is known-configured. A provider with no secret is deauthenticated
   *  rather than "not wired", so it appears in neither list. Disjoint from `wired`. */
  notWired: string[];
  /** Providers whose live credential this sync replaced or removed. */
  changed: string[];
}

/**
 * Last key applied per provider, so an unchanged key skips the re-apply. That re-apply no longer
 * refreshes the whole runtime under 0.85, but still enqueues a credential operation taking the
 * cross-process `auth.json` lock and re-probing availability — so the cache still earns its place, and
 * must NOT be deleted on the grounds that "the refresh is gone now". Keyed by runtime (WeakMap) so a
 * recreated runtime re-syncs from scratch.
 */
const syncedKeys = new WeakMap<ModelRuntime, Map<string, string>>();

/**
 * Deauthenticate a custom provider whose secret is absent. Scoped strictly to what Damocles itself
 * supplied: the in-memory runtime override and/or a STORED auth.json credential (which includes the
 * legacy plaintext keys Damocles ≤2.6 persisted — this doubles as the migration sweep). Ambient
 * environment configuration (`source: 'environment'`) is deliberately left alone. Idempotent.
 */
async function deauthCustomProvider(
  runtime: ModelRuntime,
  def: CustomProviderDef,
  cache: Map<string, string>,
  authOptions: AuthOperationOptions,
): Promise<boolean> {
  const hadOverride = cache.delete(def.provider);
  const status = runtime.getProviderAuthStatus(def.provider);
  const damoclesSupplied = status.configured && (status.source === 'runtime' || status.source === 'stored');
  if (!hadOverride && !damoclesSupplied) return false;
  // Fresh-registered providers (StepFun) are dropped entirely — the register config carries the key.
  // `unregisterProvider` is synchronous and takes no options, so it gets no signal.
  if (def.mode === 'register') runtime.unregisterProvider(def.provider);
  await runtime.removeRuntimeApiKey(def.provider, authOptions);
  // Delete any stored credential: today a no-op, for ≤2.6 upgraders the plaintext-key sweep.
  await runtime.logout(def.provider, authOptions);
  log('[custom-providers] deauthenticated %s (secret absent)', def.provider);
  return true;
}

/** The outcome of one secret read. `failed` and `aborted` are deliberately distinct from a successful
 *  read of `undefined`: only the latter means the user removed the key. */
type SecretRead =
  | { status: 'read'; key: string | undefined }
  | { status: 'failed'; err: unknown }
  | { status: 'aborted' };

/**
 * VS Code's `SecretStorage.get` takes no signal and is backed by the OS keyring (libsecret /
 * gnome-keyring / DPAPI), which can wedge indefinitely — and this sync gates all user input at startup.
 * The abort listener is removed on settle because the caller's signal is the long-lived `_syncAbort`
 * one, which every subsequent sync would otherwise keep adding to.
 */
async function readSecret(getSecret: SecretResolver, secretKey: string, signal: AbortSignal | undefined): Promise<SecretRead> {
  const read = Promise.resolve(getSecret(secretKey)).then(
    (key): SecretRead => ({ status: 'read', key }),
    (err): SecretRead => ({ status: 'failed', err }),
  );
  if (!signal) return read;
  if (signal.aborted) return { status: 'aborted' };
  const settled = new AbortController();
  try {
    return await Promise.race([
      read,
      new Promise<SecretRead>((resolve) => {
        signal.addEventListener('abort', () => resolve({ status: 'aborted' }), { once: true, signal: settled.signal });
      }),
    ]);
  } finally {
    settled.abort();
  }
}

const KEY_PRESENCE_TIMEOUT_MS = 3000;

/** Whether a non-empty key is stored under `secretKey`; undefined when the store failed or did not answer in time. */
export async function providerKeyStored(getSecret: SecretResolver, secretKey: string): Promise<boolean | undefined> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), KEY_PRESENCE_TIMEOUT_MS);
  try {
    const read = await readSecret(getSecret, secretKey, timeout.signal);
    return read.status === 'read' ? (read.key ?? '').length > 0 : undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a provider the abort cut short is known to be configured, decided WITHOUT I/O — asking
 * `getSecret` again here would reintroduce the very unbounded read the abort exists to cut short.
 * Providers that fail this are not "not wired", they have no key at all, and reporting them would turn
 * every timeout log and every user-facing fallback warning on a single-provider machine into noise.
 */
function isKnownConfigured(
  runtime: ModelRuntime,
  def: CustomProviderDef,
  cache: Map<string, string>,
  sawSecret: ReadonlySet<string>,
): boolean {
  return sawSecret.has(def.provider) || cache.has(def.provider) || runtime.getProviderAuthStatus(def.provider).configured;
}

/**
 * Register/authenticate the key-backed providers on the SHARED runtime. StepFun is registered
 * fresh (its key in the provider config); the others are existing pi providers that only need their
 * API key. Keys are applied as in-memory `ModelRuntime` runtime overrides (`setRuntimeApiKey`),
 * never persisted to auth.json and never `process.env`. A provider whose secret is ABSENT is
 * deauthenticated (see `deauthCustomProvider`), and an unchanged key is skipped entirely — so the
 * common session-start path with stable keys enqueues zero credential operations. Idempotent — safe to
 * call on every session start and on secret change. `registerProvider` needs no trailing `refresh()`;
 * `setRuntimeApiKey` runs its own offline, single-provider one. Cancellable via `deps.signal`, and what
 * it did and did not reach is reported rather than swallowed — see `SyncCustomProvidersResult`.
 */
export async function syncCustomProviders(deps: SyncCustomProvidersDeps): Promise<SyncCustomProvidersResult> {
  const wired: string[] = [];
  const notWired: string[] = [];
  const changed: string[] = [];
  /** Read this sync and non-empty — the only evidence that the provider cut short mid-apply is configured. */
  const sawSecret = new Set<string>();
  let cutShortAt = -1;
  // `exactOptionalPropertyTypes` forbids `{ signal: undefined }` against pi's `signal?: AbortSignal`.
  const authOptions: AuthOperationOptions = deps.signal ? { signal: deps.signal } : {};
  let cache = syncedKeys.get(deps.modelRuntime);
  if (!cache) {
    cache = new Map();
    syncedKeys.set(deps.modelRuntime, cache);
  }
  for (const [i, def] of CUSTOM_PROVIDER_DEFS.entries()) {
    if (deps.signal?.aborted) {
      cutShortAt = i;
      break;
    }
    const read = await readSecret(deps.getSecret, def.secretKey, deps.signal);
    if (read.status === 'aborted') {
      cutShortAt = i;
      break;
    }
    if (read.status === 'failed') {
      // A read failure is NOT an absent secret. Deauthenticating here would delete a stored auth.json
      // credential the user may have created outside Damocles (`pi login <provider>`), unrecoverably
      // from the UI, because a keyring happened to be locked.
      notWired.push(def.provider);
      log('[custom-providers] could not read the stored secret for %s; leaving it untouched: %s', def.provider, describeAuthError(read.err));
      continue;
    }
    const key = read.key;
    if (key) sawSecret.add(def.provider);
    try {
      if (!key) {
        if (await deauthCustomProvider(deps.modelRuntime, def, cache, authOptions)) changed.push(def.provider);
        continue;
      }
      if (cache.get(def.provider) === key) {
        wired.push(def.provider); // already live with this exact key — skip the re-apply
        continue;
      }
      if (def.mode === 'register' && def.registerConfig) {
        deps.modelRuntime.registerProvider(def.provider, { ...def.registerConfig, apiKey: key });
      }
      // Apply the key as an in-memory runtime override so request-auth resolution + availability checks
      // see it (the auth mechanism for `mode: 'authenticate'` providers; harmless belt-and-braces for
      // `register` ones). Runs last per provider.
      await deps.modelRuntime.setRuntimeApiKey(def.provider, key, authOptions);
      cache.set(def.provider, key);
      wired.push(def.provider);
      changed.push(def.provider);
    } catch (err) {
      // Abort first: a cancelled operation is not a provider failure, and its key must NOT be cached
      // because it may never have been applied.
      if (deps.signal?.aborted) {
        cutShortAt = i;
        break;
      }
      // pi commits the runtime key BEFORE the snapshot sync that failed, so the provider IS usable —
      // cache it and report it wired; rolling back would leave a live key with no record of it. Apply
      // path only: the same error from `deauthCustomProvider` means the credential was removed.
      if (key && isCredentialSyncError(err)) {
        cache.set(def.provider, key);
        wired.push(def.provider);
        changed.push(def.provider);
        log('[custom-providers] %s is wired, but pi could not resynchronize its local model snapshot (it may be stale): %s', def.provider, describeAuthError(err));
        continue;
      }
      if (!key && isCredentialSyncError(err)) changed.push(def.provider);
      notWired.push(def.provider);
      log('[custom-providers] failed to wire %s: %s', def.provider, describeAuthError(err));
    }
  }
  if (cutShortAt >= 0) {
    const unreached = CUSTOM_PROVIDER_DEFS.slice(cutShortAt)
      .filter((d) => isKnownConfigured(deps.modelRuntime, d, cache, sawSecret))
      .map((d) => d.provider);
    notWired.push(...unreached);
    log('[custom-providers] sync cut short (aborted); not wired: %s', unreached.join(', ') || '(none configured)');
  }
  return { wired, aborted: cutShortAt >= 0, notWired, changed };
}

/**
 * When `mainModelValue` resolves to a custom-provider model, return that provider's cheap-model id
 * (so a custom-provider main agent's Explore default matches the provider). The MAIN dropdown is curated
 * (Anthropic/OpenAI), so this returns undefined in the common case and the caller falls back to the
 * first-party cheap model.
 */
export function cheapModelValueForProvider(mainModelValue: string, registry: ModelLookup): string | undefined {
  for (const def of CUSTOM_PROVIDER_DEFS) {
    if (!def.cheapModelId) continue;
    const model = registry.getModel(def.provider, mainModelValue);
    if (model) return def.cheapModelId;
    if (mainModelValue === def.cheapModelId) return def.cheapModelId;
  }
  return undefined;
}
