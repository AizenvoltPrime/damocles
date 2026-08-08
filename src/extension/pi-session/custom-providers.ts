/**
 * custom-providers.ts — Native multi-provider registration for subagents (Phase 5, US-018.8).
 *
 * Replaces the explore proxy's purpose with native pi providers (no loopback). Keys come from the EXISTING
 * `damocles.explore.apiKey.*` SecretStorage entries and are applied to the live `ModelRuntime` as
 * in-memory runtime API keys (`setRuntimeApiKey`) — never `process.env`. StepFun is registered fresh
 * against its step-plan SUBSCRIPTION endpoint
 * (`api.stepfun.ai/step_plan`, Anthropic-shaped, Bearer auth, model `step-3.7-flash`); OpenRouter
 * (`openai-completions`) and Gemini (`google-generative-ai`) are existing pi providers that only need
 * their key. Subagents reach these models by explicit id or via the Explore-section selection; the MAIN
 * model dropdown stays curated.
 *
 * This module owns the provider table, the cheap-model lookup (provider-matched Explore default, §4.9),
 * and the Explore-section model resolution (`resolveExploreSectionModel`).
 *
 * SEMANTIC NOTE: custom-provider keys are NOT persisted into pi's `auth.json`. They are applied as
 * in-memory `ModelRuntime` runtime overrides (`setRuntimeApiKey`) and re-synced from VS Code
 * SecretStorage on every session start and on secret change — so they live only for the process
 * lifetime and never leak into pi's on-disk credential store. When a secret is ABSENT, the sync
 * deauthenticates the provider (drops the runtime override, unregisters a fresh-registered provider,
 * and deletes any stored credential) — this both makes secret deletion take effect immediately and
 * sweeps legacy plaintext keys that Damocles ≤2.6 wrote into auth.json.
 *
 * pi 0.84 credential semantics: `setRuntimeApiKey` / `removeRuntimeApiKey` / `logout` serialize per
 * provider, and after committing the credential run an OFFLINE single-provider refresh plus an
 * availability probe that reads `auth.json` under a file lock — not 0.83's whole-runtime networked
 * refresh. All three honor `AuthOperationOptions.signal`, which truly cancels rather than orphaning an
 * operation still holding the lock; `deps.signal` threads that through.
 */

import * as vscode from 'vscode';
import type { Api, AuthOperationOptions, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import { log } from '../logger';
import { describeAuthError } from './describe-error';
import type { ModelLookup } from './pi-models';
import { effortToPiThinking } from './pi-models';
import { DEFAULT_MODELS, parseEffortLevel } from '../../shared/types/constants';
import {
  DEFAULT_EXPLORE_MODELS,
  EXPLORE_SECRET_KEYS,
  EXPLORE_THIRD_PARTY_PROVIDERS,
  type ExploreThirdPartyProvider,
} from './explore-providers';

/** pi's `registerProvider` config shape (`ProviderConfigInput` is not re-exported from the package root). */
type ProviderConfigInput = Parameters<ModelRuntime['registerProvider']>[1];

/** A custom provider Damocles can register/authenticate from a `damocles.explore.apiKey.*` secret. */
export interface CustomProviderDef {
  /** pi provider name. */
  provider: string;
  /** SecretStorage key holding the API key. */
  secretKey: string;
  /** Whether pi already ships this provider (only auth needed) or it must be registered fresh. */
  mode: 'register' | 'authenticate';
  /** The provider's designated cheap model id (used for the provider-matched Explore default). */
  cheapModelId: string;
  /** Full `registerProvider` config for `mode: 'register'` providers (StepFun). */
  registerConfig?: ProviderConfigInput;
}

/**
 * StepFun's "step-plan" SUBSCRIPTION base URL. The official Anthropic SDK (pi's anthropic-messages path)
 * appends `/v1/messages`, giving `…/step_plan/v1/messages` — the documented step-plan endpoint. This is
 * the subscription product (flat fee), NOT the pay-per-token standard API at `…/v1`.
 */
const STEPFUN_BASE_URL = 'https://api.stepfun.ai/step_plan';

/**
 * The three explore-key-backed providers, registered/authenticated only when their secret is present.
 * StepFun is registered fresh (pi has no first-party StepFun provider); OpenRouter + Gemini are existing
 * pi providers that only need their key set.
 */
export const CUSTOM_PROVIDER_DEFS: readonly CustomProviderDef[] = [
  {
    provider: 'stepfun',
    secretKey: 'damocles.explore.apiKey.stepfun',
    mode: 'register',
    cheapModelId: 'step-3.7-flash',
    registerConfig: {
      baseUrl: STEPFUN_BASE_URL,
      api: 'anthropic-messages' as Api,
      // step-plan expects `Authorization: Bearer <key>` (not x-api-key) — `authHeader: true` makes pi
      // send exactly that. Step 3.7 Flash is a 256K-context multimodal reasoning model. Cost is 0: the
      // step-plan subscription is a flat fee, so there's no per-token dollar metering (token usage still
      // shows, mirroring how the Anthropic subscription mode is treated).
      authHeader: true,
      models: [
        {
          id: 'step-3.7-flash',
          name: 'StepFun Step 3.7 Flash',
          reasoning: true,
          input: ['text', 'image'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 256_000,
          maxTokens: 64_000,
          // step_plan takes reasoning effort as adaptive `output_config.effort` and REJECTS the
          // token-budget `thinking.budget_tokens` shape; `forceAdaptiveThinking` makes pi-ai's
          // anthropic-messages path emit the adaptive shape. pi-ai's default mapThinkingLevelToEffort
          // (anthropic-messages.ts) maps minimal/low→low, medium→medium, high/xhigh/max→high, so no
          // `thinkingLevelMap` is needed for the low|medium|high cap.
          compat: { forceAdaptiveThinking: true },
        },
      ],
    },
  },
  {
    // DeepSeek is a pi BUILT-IN provider (api.deepseek.com, openai-completions). It only needs its key
    // applied as a runtime override; `registry.getModel('deepseek', …)` always resolves. Its key lives
    // in a dedicated SecretStorage entry — deliberately NOT under `damocles.explore.apiKey.*`, so it never
    // appears in the Explore provider dropdown and is never picked up by `resolveExploreSectionModel`.
    provider: 'deepseek',
    secretKey: 'damocles.deepseek.apiKey',
    mode: 'authenticate',
    cheapModelId: 'deepseek-v4-flash',
  },
  {
    provider: 'openrouter',
    secretKey: 'damocles.explore.apiKey.openrouter',
    mode: 'authenticate',
    cheapModelId: 'deepseek/deepseek-v4-flash',
  },
  {
    provider: 'google',
    secretKey: 'damocles.explore.apiKey.gemini',
    mode: 'authenticate',
    cheapModelId: 'gemini-3-flash-preview',
  },
];

/** Find the custom-provider def for a pi provider name. */
export function customProviderDef(provider: string): CustomProviderDef | undefined {
  return CUSTOM_PROVIDER_DEFS.find((d) => d.provider === provider);
}

/** Resolves a `damocles.explore.apiKey.*` secret value, or undefined when unset. PromiseLike so VS Code's
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
}

/**
 * Last key applied per provider, so an unchanged key skips the re-apply. That re-apply no longer
 * refreshes the whole runtime under 0.84, but still enqueues a credential operation taking the
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
): Promise<void> {
  const hadOverride = cache.delete(def.provider);
  const status = runtime.getProviderAuthStatus(def.provider);
  const damoclesSupplied = status.configured && (status.source === 'runtime' || status.source === 'stored');
  if (!hadOverride && !damoclesSupplied) return;
  // Fresh-registered providers (StepFun) are dropped entirely — the register config carries the key.
  // `unregisterProvider` is synchronous and takes no options, so it gets no signal.
  if (def.mode === 'register') runtime.unregisterProvider(def.provider);
  await runtime.removeRuntimeApiKey(def.provider, authOptions);
  // Delete any stored credential: today a no-op, for ≤2.6 upgraders the plaintext-key sweep.
  await runtime.logout(def.provider, authOptions);
  log('[custom-providers] deauthenticated %s (secret absent)', def.provider);
}

/** Matched by `name`, never `instanceof`: importing the class value would turn this module's type-only
 *  `pi-coding-agent` import into a runtime one, and the package is an esbuild external. */
function isCredentialSyncError(err: unknown): boolean {
  return err instanceof Error && err.name === 'CredentialSynchronizationError';
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
 * Register/authenticate the explore-key-backed providers on the SHARED runtime. StepFun is registered
 * fresh (its key in the provider config); OpenRouter + Gemini are existing pi providers that only need
 * their API key. Keys are applied as in-memory `ModelRuntime` runtime overrides (`setRuntimeApiKey`),
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
        await deauthCustomProvider(deps.modelRuntime, def, cache, authOptions);
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
        log('[custom-providers] %s is wired, but pi could not resynchronize its local model snapshot (it may be stale): %s', def.provider, describeAuthError(err));
        continue;
      }
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
  return { wired, aborted: cutShortAt >= 0, notWired };
}

/** The Explore-section model resolution result: the pi model plus the pi thinking level derived from
 *  the user's `damocles.explore.effort` setting (present only when it resolves to a supported level). */
export interface ResolvedExploreModel {
  model: Model<Api>;
  thinkingLevel?: ThinkingLevel;
}

/**
 * The pi thinking level for the Explore SUBAGENT given a resolved model and a raw stored effort
 * string. Returns undefined unless the effort parses to a valid level AND the model matches a
 * DEFAULT_MODELS catalog entry (by value AND piProvider) whose supportedEffortLevels includes it.
 * The provider+value double match prevents a false positive when a user types a free-text model id
 * that collides with a catalog value under a different provider (e.g. `deepseek-v4-flash` on OpenRouter).
 */
export function exploreThinkingLevel(model: Model<Api>, rawEffort: string): ThinkingLevel | undefined {
  const effort = parseEffortLevel(rawEffort);
  if (!effort) return undefined;
  const entry = DEFAULT_MODELS.find((m) => m.value === model.id && m.piProvider === model.provider);
  if (!entry?.supportedEffortLevels?.includes(effort)) return undefined;
  return effortToPiThinking(effort);
}

/**
 * The model chosen in the Settings → Explore section, resolved to a pi `Model`, or undefined when the
 * section is set to "default" (interception off) so the caller falls back to the provider-matched cheap
 * model. This is the SINGLE source of truth for the Explore/Plan subagent model — the same
 * `damocles.explore.*` config the Explore settings UI writes (provider + per-provider model + key). The
 * provider is registered only when its key is present, so a `getModel` hit implies it is authed.
 *
 * The returned `thinkingLevel` is for the SUBAGENT path only — it reflects the user's
 * `damocles.explore.effort` setting. The memory background path consumes `.model` only and deliberately
 * does NOT apply the user's effort setting (it re-derives a fixed `medium` at its call site).
 */
export function resolveExploreSectionModel(registry: ModelLookup): ResolvedExploreModel | undefined {
  const cfg = vscode.workspace.getConfiguration('damocles.explore');
  if (!cfg.get<boolean>('enabled', false)) return undefined;
  const exploreProvider = cfg.get<string>('provider', 'openrouter');
  if (!EXPLORE_THIRD_PARTY_PROVIDERS.includes(exploreProvider as ExploreThirdPartyProvider)) return undefined;
  const def = CUSTOM_PROVIDER_DEFS.find((d) => d.secretKey === EXPLORE_SECRET_KEYS[exploreProvider as ExploreThirdPartyProvider]);
  if (!def) return undefined;
  const map = cfg.get<Record<string, string>>('modelByProvider', {});
  const modelId = map[exploreProvider]?.trim() || DEFAULT_EXPLORE_MODELS[exploreProvider as ExploreThirdPartyProvider];
  if (!modelId) return undefined;
  const model = registry.getModel(def.provider, modelId);
  if (!model) return undefined;
  const thinkingLevel = exploreThinkingLevel(model, cfg.get<string>('effort', ''));
  return { model, ...(thinkingLevel ? { thinkingLevel } : {}) };
}

/**
 * When `mainModelValue` resolves to a custom-provider model, return that provider's cheap-model id
 * (so a custom-provider main agent's Explore default matches the provider). The MAIN dropdown is curated
 * (Anthropic/OpenAI), so this returns undefined in the common case and the caller falls back to the
 * first-party cheap model.
 */
export function cheapModelValueForProvider(mainModelValue: string, registry: ModelLookup): string | undefined {
  for (const def of CUSTOM_PROVIDER_DEFS) {
    const model = registry.getModel(def.provider, mainModelValue);
    if (model) return def.cheapModelId;
    if (mainModelValue === def.cheapModelId) return def.cheapModelId;
  }
  return undefined;
}
