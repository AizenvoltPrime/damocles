// The provider table, kept out of custom-providers.ts, which the ES-module e2e loader imports and so must not reach the link-policy stack.
import type { Api } from '@earendil-works/pi-ai';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PROVIDER_SECRET_KEYS } from './explore-providers';
import type { AccountProviderId, KeyProviderId, SignInProviderId } from '../../shared/settings-sections';

/** pi's `registerProvider` config shape (`ProviderConfigInput` is not re-exported from the package root). */
type ProviderConfigInput = Parameters<ModelRuntime['registerProvider']>[1];

/** A provider with an Accounts row of its own: a key Damocles stores, a pi OAuth sign-in, or both. */
export interface CustomProviderDef {
  /** pi provider name. */
  provider: AccountProviderId;
  key?: ProviderKeyDef;
  /** pi's OAuth sign-in for the provider. */
  signIn?: ProviderSignInDef;
  /** The catalog value of the provider's designated cheap model: the Explore default of a chat on this provider, and one
   *  of Automatic's background candidates unless `pickedOnly` is set. */
  cheapModel?: string;
  /** Damocles never chooses this provider's models on its own: a new chat's fallback and Automatic skip them, and its
   *  cheap model serves only a chat the user already put on the provider. */
  pickedOnly?: true;
  /** The provider limits its models per account plan, and its stored sign-in lists them (`availableModelIds`). */
  plan?: boolean;
  /** Every credential bills a flat subscription, so none of its models bills dollars, in the catalog or not. Its catalog entries set `flatFee`. */
  flatFee?: true;
}

/** A key Damocles stores in the host secret store and applies to pi only in memory. */
export interface ProviderKeyDef {
  /** SecretStorage key holding the API key. */
  secretKey: string;
  /** Whether pi already ships this provider (only auth needed) or it must be registered fresh. */
  mode: 'register' | 'authenticate';
  /** Full `registerProvider` config for `mode: 'register'` providers (StepFun). */
  registerConfig?: ProviderConfigInput;
  /** Whether a key bills a flat subscription rather than per token. A pure prefix test that never logs,
   *  applied only to the key Damocles stored, never to an environment or `auth.json` credential. */
  flatFeeKey?: (key: string) => boolean;
  /** Damocles 2.6 and earlier also wrote this key into auth.json in plain text, which the one-time sweep logs out.
   *  Only those providers: a stored `api_key` of any other is the user's own. */
  legacySweep?: true;
}

/** A def of a key provider, whose key def is always set. */
export type KeyedProviderDef = CustomProviderDef & { readonly provider: KeyProviderId; readonly key: ProviderKeyDef };

/** A provider's pi OAuth sign-in. `textPrompt` names what pi's `text` prompt asks for; a provider without one gets no text prompt answered. */
export interface ProviderSignInDef {
  textPrompt?: 'enterpriseDomain';
}

// Exactly the KEY_PROVIDER_IDS providers have a key def, and exactly the SIGN_IN_PROVIDER_IDS ones a sign-in def.
type AccountProviderDefOf<P extends AccountProviderId> = CustomProviderDef & { readonly provider: P }
  & (P extends KeyProviderId ? { readonly key: ProviderKeyDef } : { readonly key?: never })
  & (P extends SignInProviderId ? { readonly signIn: ProviderSignInDef } : { readonly signIn?: never });

/**
 * StepFun's "step-plan" SUBSCRIPTION base URL. The official Anthropic SDK (pi's anthropic-messages path)
 * appends `/v1/messages`, giving `…/step_plan/v1/messages` — the documented step-plan endpoint. This is
 * the subscription product (flat fee), NOT the pay-per-token standard API at `…/v1`.
 */
const STEPFUN_BASE_URL = 'https://api.stepfun.ai/step_plan';

export const TYPESAFE_SECRET_KEY = 'damocles.typesafe.apiKey';

/**
 * The account providers. A key provider is registered/authenticated only when its secret is present: StepFun is
 * registered fresh (pi has no first-party StepFun provider); the others are pi providers that only need their key set.
 * Key order is the sync order and Automatic's background-model priority (`AUTOMATIC_BACKGROUND_MODELS`).
 */
const ACCOUNT_PROVIDER_DEFS: { readonly [P in AccountProviderId]: AccountProviderDefOf<P> } = {
  stepfun: {
    provider: 'stepfun',
    cheapModel: 'step-5-preview',
    flatFee: true,
    key: {
      secretKey: PROVIDER_SECRET_KEYS.stepfun,
      mode: 'register',
      legacySweep: true,
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
  },
  deepseek: {
    // DeepSeek is a pi BUILT-IN provider (api.deepseek.com, openai-completions). It only needs its key
    // applied as a runtime override; `registry.getModel('deepseek', …)` always resolves. Its key lives
    // in its own SecretStorage entry.
    provider: 'deepseek',
    cheapModel: 'deepseek-flash',
    key: { secretKey: 'damocles.deepseek.apiKey', mode: 'authenticate', legacySweep: true },
  },
  minimax: {
    // pi built-in (api.minimax.io, the international platform). `sk-cp-` is a Token Plan subscription key;
    // MiniMax charges the account balance only for a pay-as-you-go key.
    provider: 'minimax',
    cheapModel: 'MiniMax-M3.1-Flash',
    key: { secretKey: 'damocles.minimax.apiKey', mode: 'authenticate', flatFeeKey: (key) => key.startsWith('sk-cp-') },
  },
  xai: {
    provider: 'xai',
    cheapModel: 'grok-4.7',
    key: { secretKey: 'damocles.xai.apiKey', mode: 'authenticate' },
    signIn: {},
  },
  'kimi-coding': {
    provider: 'kimi-coding',
    cheapModel: 'kimi-for-coding',
    flatFee: true,
    key: { secretKey: 'damocles.kimi-coding.apiKey', mode: 'authenticate' },
    signIn: {},
  },
  meta: {
    provider: 'meta',
    cheapModel: 'muse-spark-1.3',
    key: { secretKey: 'damocles.meta.apiKey', mode: 'authenticate' },
    signIn: {},
  },
  openrouter: {
    // Image generation, Jev on OpenRouter and template `model:` pins; no cheap model, so the Explore default never picks it.
    provider: 'openrouter',
    key: { secretKey: PROVIDER_SECRET_KEYS.openrouter, mode: 'authenticate', legacySweep: true },
    signIn: {},
  },
  typesafe: {
    // Classifier-only (Jev) for the memory judges.
    provider: 'typesafe',
    key: { secretKey: TYPESAFE_SECRET_KEY, mode: 'authenticate' },
  },
  'github-copilot': {
    // Sign-in only.
    provider: 'github-copilot',
    cheapModel: 'github-copilot/claude-haiku-5.5',
    pickedOnly: true,
    signIn: { textPrompt: 'enterpriseDomain' },
    plan: true,
    flatFee: true,
  },
};

export const CUSTOM_PROVIDER_DEFS: readonly CustomProviderDef[] = Object.values(ACCOUNT_PROVIDER_DEFS);

/** The defs with a key, in sync order. */
export const KEYED_PROVIDER_DEFS: readonly KeyedProviderDef[] = CUSTOM_PROVIDER_DEFS.filter((def): def is KeyedProviderDef => def.key !== undefined);

export function customProviderDef(provider: KeyProviderId): KeyedProviderDef {
  return ACCOUNT_PROVIDER_DEFS[provider];
}

export function accountProviderDef(provider: AccountProviderId): CustomProviderDef {
  return ACCOUNT_PROVIDER_DEFS[provider];
}

export function providerSignInDef(provider: SignInProviderId): ProviderSignInDef {
  return ACCOUNT_PROVIDER_DEFS[provider].signIn;
}

/** Whether a pi provider limits its models per account plan, so a model outside its sign-in's list is refused. */
export function providerLimitsModelsByPlan(provider: string): boolean {
  return CUSTOM_PROVIDER_DEFS.some((def) => def.provider === provider && def.plan === true);
}

/** Whether Damocles never chooses a pi provider's models on its own (`CustomProviderDef.pickedOnly`). */
export function providerPickedOnly(provider: string): boolean {
  return CUSTOM_PROVIDER_DEFS.some((def) => def.provider === provider && def.pickedOnly === true);
}

/** Whether every credential of a pi provider bills a flat subscription (`CustomProviderDef.flatFee`). */
export function providerBillsFlat(provider: string): boolean {
  return CUSTOM_PROVIDER_DEFS.some((def) => def.provider === provider && def.flatFee === true);
}

/** The key provider whose key is stored under `secretKey`, if any. */
export function keyProviderOfSecret(secretKey: string): KeyProviderId | undefined {
  return KEYED_PROVIDER_DEFS.find((d) => d.key.secretKey === secretKey)?.provider;
}
