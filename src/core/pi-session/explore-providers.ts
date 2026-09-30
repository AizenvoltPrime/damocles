/**
 * Provider constants for the native Explore multi-provider subagent (US-018.8). Keys live in
 * `damocles.explore.apiKey.*` SecretStorage entries and flow through pi's provider config.
 */

export type ExploreThirdPartyProvider = 'openrouter' | 'gemini' | 'stepfun';

export const EXPLORE_THIRD_PARTY_PROVIDERS: readonly ExploreThirdPartyProvider[] = ['openrouter', 'gemini', 'stepfun'] as const;

export const EXPLORE_SECRET_KEYS: Record<ExploreThirdPartyProvider, string> = {
  openrouter: 'damocles.explore.apiKey.openrouter',
  gemini: 'damocles.explore.apiKey.gemini',
  stepfun: 'damocles.explore.apiKey.stepfun',
};

export const DEFAULT_EXPLORE_MODELS: Record<ExploreThirdPartyProvider, string> = {
  openrouter: 'deepseek/deepseek-v4-flash',
  gemini: 'gemini-3-flash-preview',
  stepfun: 'step-3.7-flash',
};
