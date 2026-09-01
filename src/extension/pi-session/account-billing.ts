import type { AccountInfo, ModelInfo } from '../../shared/types/settings';
import type { OpenAIAuthStatus } from './openai-auth';
import { isDollarBilled } from './pi-models';

/**
 * Account/billing credential resolution for the adapter callbacks (US-008/account chip). Pure over a
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
  /** Whether the user prefers the OpenAI API key over Codex OAuth (`PiSession.preferOpenAIApiKey()`). */
  preferApiKey: boolean;
}

/** The active OpenAI credential path, honoring the prefer-API-key toggle when a key is configured. */
export function openaiTokenSource(deps: AccountBillingDeps): 'codex-oauth' | 'openai-api-key' {
  const status = deps.openaiAuthStatus;
  if (deps.preferApiKey && status.apiKey) return 'openai-api-key';
  return status.codex ? 'codex-oauth' : 'openai-api-key';
}

/** The credential label for the active model (OpenAI token source / piProvider / Claude auth mode). */
export function apiKeySource(deps: AccountBillingDeps): string {
  const mi = deps.modelInfo;
  if (mi?.backend === 'openai') return openaiTokenSource(deps);
  if (mi?.piProvider) return mi.piProvider;
  return deps.claudeAuthMode;
}

/** The account chip: model + the active backend's credential/subscription source. */
export function buildAccountInfo(deps: AccountBillingDeps): AccountInfo {
  const info: AccountInfo = { model: deps.modelValue, dollarBilled: dollarBilled(deps) };
  const mi = deps.modelInfo;
  if (mi?.backend === 'openai') {
    info.tokenSource = openaiTokenSource(deps);
  } else if (mi?.piProvider) {
    info.tokenSource = mi.piProvider; // no Claude subscriptionType chip for custom providers
  } else {
    info.subscriptionType = deps.claudeAuthMode;
  }
  return info;
}

/** Whether the active credential is dollar-metered (API key or extra-usage), vs a flat subscription. */
export function dollarBilled(deps: AccountBillingDeps): boolean {
  return isDollarBilled(deps.modelInfo, apiKeySource(deps));
}
