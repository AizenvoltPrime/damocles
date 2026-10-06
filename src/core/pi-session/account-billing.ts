import type { AccountInfo, ModelInfo } from '../../shared/types/settings';
import { OPENAI_API_PROVIDER, OPENAI_CODEX_PROVIDER, openaiRuntimeKeyWanted, type OpenAIAuthStatus } from './openai-auth';
import { isDollarBilled, resolvePiModel, type ModelLookup } from './pi-models';
import type { SubscriptionProvider } from './usage-thresholds';

/**
 * Account/billing credential resolution for the adapter callbacks and the account state (US-008). Pure over a
 * snapshot of live auth state assembled by `PiSession` — the modules never capture `this`. Both
 * auth-status getters are side-effect-free pure reads, so eager assembly of `claudeAuthMode` and
 * `openaiAuthStatus` is behavior-identical to the original lazy reads.
 */
export interface AccountBillingDeps {
  /** The active panel model value (`PiSession.modelValue`). */
  modelValue: string;
  /** The active model's catalog entry (`PiSession.getModelInfo(modelValue)`). */
  modelInfo: ModelInfo | undefined;
  /** The Claude auth mode (`PiRuntime.getClaudeAuthStatus().mode`). */
  claudeAuthMode: string;
  /** The OpenAI auth state (`PiRuntime.getOpenAIAuthStatus()`). */
  openaiAuthStatus: OpenAIAuthStatus;
  /** Whether the user prefers the OpenAI API key over a ChatGPT or Codex sign-in (`PiSession.preferOpenAIApiKey()`). */
  preferApiKey: boolean;
  /** The pi provider the active model resolved to; undefined when it resolved to none. */
  resolvedProvider?: string | undefined;
}

/** The subscription the active credential bills, or undefined for an API key or a custom provider. */
export function subscriptionProvider(deps: AccountBillingDeps): SubscriptionProvider | undefined {
  const mi = deps.modelInfo;
  if (mi?.backend === 'openai') return openaiTokenSource(deps) === 'openai-api-key' ? undefined : 'openai';
  if (mi?.piProvider) return undefined;
  return deps.claudeAuthMode === 'allowance' || deps.claudeAuthMode === 'extra' ? 'anthropic' : undefined;
}

/**
 * The active OpenAI credential. A resolved provider names it: `openai-codex` is the Codex grant, and `openai`
 * is the key while the runtime key rule wants it, else ChatGPT. Unresolved, it follows `resolvePiModel`'s order.
 */
export function openaiTokenSource(deps: AccountBillingDeps): 'chatgpt-oauth' | 'codex-oauth' | 'openai-api-key' {
  const status = deps.openaiAuthStatus;
  if (deps.resolvedProvider === OPENAI_CODEX_PROVIDER) return 'codex-oauth';
  if (deps.resolvedProvider === OPENAI_API_PROVIDER) {
    return status.chatgpt && !openaiRuntimeKeyWanted(status, deps.preferApiKey) ? 'chatgpt-oauth' : 'openai-api-key';
  }
  if (deps.preferApiKey && status.apiKey) return 'openai-api-key';
  if (status.chatgpt) return 'chatgpt-oauth';
  return status.codex ? 'codex-oauth' : 'openai-api-key';
}

/** The credential label for the active model (OpenAI token source / piProvider / Claude auth mode). */
export function apiKeySource(deps: AccountBillingDeps): string {
  const mi = deps.modelInfo;
  if (mi?.backend === 'openai') return openaiTokenSource(deps);
  if (mi?.piProvider) return mi.piProvider;
  return deps.claudeAuthMode;
}

/** The account state the webview reads: the active model and whether its credential is dollar-metered. */
export function buildAccountInfo(deps: AccountBillingDeps): AccountInfo {
  return { model: deps.modelValue, dollarBilled: dollarBilled(deps) };
}

/** Whether the active credential is dollar-metered (API key or extra-usage), vs a flat subscription. */
export function dollarBilled(deps: AccountBillingDeps): boolean {
  return isDollarBilled(deps.modelInfo, apiKeySource(deps));
}

/** The live auth state that decides whether a model other than the panel's bills dollars. */
export interface ModelBillingDeps {
  supportedModels: readonly ModelInfo[];
  claudeAuthMode: string;
  openai: OpenAIAuthStatus;
  preferApiKey: boolean;
  /** Decides which OpenAI provider a GPT model resolves to; undefined before pi's model runtime exists. */
  registry: ModelLookup | undefined;
}

/** Whether a catalog model value bills dollars, by the account state's rule: the provider `resolvePiModel` picks names the credential. */
export function modelDollarBilled(value: string, deps: ModelBillingDeps): boolean {
  return dollarBilled({
    modelValue: value,
    modelInfo: deps.supportedModels.find((m) => m.value === value),
    claudeAuthMode: deps.claudeAuthMode,
    openaiAuthStatus: deps.openai,
    preferApiKey: deps.preferApiKey,
    resolvedProvider: resolvedProviderOf(value, deps.registry, deps.openai, deps.preferApiKey),
  });
}

/** The pi provider `resolvePiModel` picks for a model value, which names the OpenAI credential it bills. */
export function resolvedProviderOf(
  value: string,
  registry: ModelLookup | undefined,
  openai: OpenAIAuthStatus,
  preferApiKey: boolean,
): string | undefined {
  return registry ? resolvePiModel(value, registry, openai, preferApiKey).model?.provider : undefined;
}

/**
 * Whether a resolved pi model bills dollars. A direct `provider/modelId` pin can choose a provider against
 * the panel's preference, so the provider decides first. `openai` bills the subscription only while ChatGPT
 * is its credential and the runtime key does not override it. A provider outside the catalog, or `openai`
 * with neither credential, has unknown billing, which reads as a charge.
 */
export function piModelDollarBilled(model: { provider: string; id: string }, deps: ModelBillingDeps): boolean {
  if (model.provider === OPENAI_CODEX_PROVIDER) return false;
  if (model.provider === OPENAI_API_PROVIDER) return !deps.openai.chatgpt || openaiRuntimeKeyWanted(deps.openai, deps.preferApiKey);
  if (model.provider === 'anthropic') return isDollarBilled(undefined, deps.claudeAuthMode);
  const info = deps.supportedModels.find((m) => m.piProvider === model.provider && m.value === model.id);
  return info ? modelDollarBilled(info.value, deps) : true;
}
