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
 */

import * as vscode from 'vscode';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { log } from '../logger';
import type { ModelLookup } from './pi-models';
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
}

/**
 * Last key applied per provider on each live runtime — change detection so an unchanged key skips the
 * refresh-triggering re-apply (`setRuntimeApiKey` refreshes the whole runtime every call; without this,
 * every session start pays up to one full refresh per configured provider). Keyed by runtime instance
 * (WeakMap) so a disposed runtime's entries vanish with it and a recreated runtime re-syncs from scratch.
 */
const syncedKeys = new WeakMap<ModelRuntime, Map<string, string>>();

/**
 * Deauthenticate a custom provider whose secret is absent. Scoped strictly to what Damocles itself
 * supplied: the in-memory runtime override and/or a STORED auth.json credential (which includes the
 * legacy plaintext keys Damocles ≤2.6 persisted — this doubles as the migration sweep). Ambient
 * environment configuration (`source: 'environment'`) is deliberately left alone. Idempotent.
 */
async function deauthCustomProvider(runtime: ModelRuntime, def: CustomProviderDef, cache: Map<string, string>): Promise<void> {
  const hadOverride = cache.delete(def.provider);
  const status = runtime.getProviderAuthStatus(def.provider);
  const damoclesSupplied = status.configured && (status.source === 'runtime' || status.source === 'stored');
  if (!hadOverride && !damoclesSupplied) return;
  // Fresh-registered providers (StepFun) are dropped entirely — the register config carries the key.
  if (def.mode === 'register') runtime.unregisterProvider(def.provider);
  await runtime.removeRuntimeApiKey(def.provider);
  // Delete any stored credential: today a no-op, for ≤2.6 upgraders the plaintext-key sweep.
  await runtime.logout(def.provider);
  log('[custom-providers] deauthenticated %s (secret absent)', def.provider);
}

/**
 * Register/authenticate the explore-key-backed providers on the SHARED runtime. StepFun is registered
 * fresh (its key in the provider config); OpenRouter + Gemini are existing pi providers that only need
 * their API key. Keys are applied as in-memory `ModelRuntime` runtime overrides (`setRuntimeApiKey`),
 * never persisted to auth.json and never `process.env`. A provider whose secret is ABSENT is
 * deauthenticated (see `deauthCustomProvider`), and an unchanged key is skipped entirely — so the
 * common session-start path with stable keys triggers zero runtime refreshes. Idempotent — safe to
 * call on every session start and on secret change. Returns the configured provider names (for
 * logging). `registerProvider` and `setRuntimeApiKey` self-refresh, so no trailing `refresh()` is
 * needed.
 */
export async function syncCustomProviders(deps: SyncCustomProvidersDeps): Promise<string[]> {
  const wired: string[] = [];
  let cache = syncedKeys.get(deps.modelRuntime);
  if (!cache) {
    cache = new Map();
    syncedKeys.set(deps.modelRuntime, cache);
  }
  for (const def of CUSTOM_PROVIDER_DEFS) {
    let key: string | undefined;
    try {
      key = await deps.getSecret(def.secretKey);
    } catch {
      key = undefined;
    }
    try {
      if (!key) {
        await deauthCustomProvider(deps.modelRuntime, def, cache);
        continue;
      }
      if (cache.get(def.provider) === key) {
        wired.push(def.provider); // already live with this exact key — skip the refresh-triggering re-apply
        continue;
      }
      if (def.mode === 'register' && def.registerConfig) {
        deps.modelRuntime.registerProvider(def.provider, { ...def.registerConfig, apiKey: key });
      }
      // Apply the key as an in-memory runtime override so request-auth resolution + availability checks
      // see it (the auth mechanism for `mode: 'authenticate'` providers; harmless belt-and-braces for
      // `register` ones). `setRuntimeApiKey` refreshes internally and runs last per provider.
      await deps.modelRuntime.setRuntimeApiKey(def.provider, key);
      cache.set(def.provider, key);
      wired.push(def.provider);
    } catch (err) {
      log('[custom-providers] failed to wire %s: %O', def.provider, err);
    }
  }
  return wired;
}

/**
 * The model chosen in the Settings → Explore section, resolved to a pi `Model`, or undefined when the
 * section is set to "default" (interception off) so the caller falls back to the provider-matched cheap
 * model. This is the SINGLE source of truth for the Explore/Plan subagent model — the same
 * `damocles.explore.*` config the Explore settings UI writes (provider + per-provider model + key). The
 * provider is registered only when its key is present, so a `getModel` hit implies it is authed.
 */
export function resolveExploreSectionModel(registry: ModelLookup): Model<Api> | undefined {
  const cfg = vscode.workspace.getConfiguration('damocles.explore');
  if (!cfg.get<boolean>('enabled', false)) return undefined;
  const exploreProvider = cfg.get<string>('provider', 'openrouter');
  if (!EXPLORE_THIRD_PARTY_PROVIDERS.includes(exploreProvider as ExploreThirdPartyProvider)) return undefined;
  const def = CUSTOM_PROVIDER_DEFS.find((d) => d.secretKey === EXPLORE_SECRET_KEYS[exploreProvider as ExploreThirdPartyProvider]);
  if (!def) return undefined;
  const map = cfg.get<Record<string, string>>('modelByProvider', {});
  const modelId = map[exploreProvider]?.trim() || DEFAULT_EXPLORE_MODELS[exploreProvider as ExploreThirdPartyProvider];
  if (!modelId) return undefined;
  return registry.getModel(def.provider, modelId);
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
