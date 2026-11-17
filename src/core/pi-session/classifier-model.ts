import type { ClassifierCredential, ClassifierProvider, MemoryJudge, MemoryJudgeUnavailable } from '../../shared/types/settings';
import { openaiRequestCredentialIsKey, type OpenAIAuthStatus } from './openai-auth';
import { httpStatusOf } from './http-status';

/** A classifier model in pi's catalog, addressed as `getModelOfType('classifier', provider, id)`. */
export interface ClassifierModelRef {
  provider: ClassifierProvider;
  id: string;
}

export const JEV_VIA_TYPESAFE: ClassifierModelRef = { provider: 'typesafe', id: 'jev-latest' };
export const JEV_VIA_OPENROUTER: ClassifierModelRef = { provider: 'openrouter', id: '~typesafe/jev-latest' };
/** On OpenAI's Decisions API (pi-ai `openai-decisions`), which accepts only an API key. */
export const GPT_6_LUNA_CLASSIFIER: ClassifierModelRef = { provider: 'openai', id: 'gpt-6-luna' };
/** Through a GitHub Copilot sign-in (pi-ai providers/data/github-copilot.json, API `typesafe-system-one`). */
export const DECISION_1_VIA_COPILOT: ClassifierModelRef = { provider: 'github-copilot', id: 'microsoft-decision-1' };

/** The environment variables pi reads as each provider's key (pi-ai 1.5.2 `env-api-keys.js`). */
export const CLASSIFIER_ENV_KEYS: Readonly<Record<ClassifierProvider, string>> = {
  typesafe: 'TYPESAFE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  'github-copilot': 'COPILOT_GITHUB_TOKEN',
};

const CLASSIFIER_MODEL_BY_PROVIDER: Readonly<Record<ClassifierProvider, ClassifierModelRef>> = {
  typesafe: JEV_VIA_TYPESAFE,
  openrouter: JEV_VIA_OPENROUTER,
  openai: GPT_6_LUNA_CLASSIFIER,
  'github-copilot': DECISION_1_VIA_COPILOT,
};

/**
 * In Automatic's order, a prefix of `MEMORY_JUDGE_CLASSIFIERS`. Microsoft-Decision-1 is only ever chosen: GitHub does not
 * price it, so Automatic never spends a Copilot quota on it unasked.
 */
export const CLASSIFIER_MODELS: readonly ClassifierModelRef[] = [JEV_VIA_TYPESAFE, JEV_VIA_OPENROUTER, GPT_6_LUNA_CLASSIFIER];

/** Every classifier provider, Automatic's first. */
export const CLASSIFIER_PROVIDERS: readonly ClassifierProvider[] = [...CLASSIFIER_MODELS.map((ref) => ref.provider), DECISION_1_VIA_COPILOT.provider];

export function classifierModelOf(provider: ClassifierProvider): ClassifierModelRef {
  return CLASSIFIER_MODEL_BY_PROVIDER[provider];
}

/** The first classifier in preference order that is usable (credential, breaker and catalog model), else none. */
export function pickClassifierModel(isUsable: (ref: ClassifierModelRef) => boolean): ClassifierModelRef | null {
  return CLASSIFIER_MODELS.find(isUsable) ?? null;
}

/**
 * Whether `provider`'s credential can serve a classifier. `configured` is pi's `hasConfiguredAuth` (or its
 * pre-start stand-in). OpenAI counts only while its request credential is an API key; GitHub Copilot takes a sign-in.
 */
export function classifierCredential(
  provider: ClassifierProvider,
  configured: (provider: ClassifierProvider) => boolean,
  openai: { status: Pick<OpenAIAuthStatus, 'apiKey' | 'chatgpt'>; preferApiKey: boolean },
): ClassifierCredential {
  if (provider === 'github-copilot') return configured(provider) ? 'ok' : 'signed-out';
  if (provider !== 'openai') return configured(provider) ? 'ok' : 'no-key';
  if (openaiRequestCredentialIsKey(openai.status, openai.preferApiKey, configured('openai'))) return 'ok';
  return openai.status.chatgpt ? 'chatgpt-active' : 'no-key';
}

/** A loggable cause for a failed classifier request, never including the response body. */
export function classifierFailureCause(errorMessage: string | undefined): string {
  if (!errorMessage) return 'no error message';
  const status = httpStatusOf(errorMessage);
  if (status !== undefined) return `HTTP ${status}`;
  if (/timed out/i.test(errorMessage)) return 'timeout';
  if (/did not return|returned an? (unexpected|invalid)/.test(errorMessage)) return 'malformed answers';
  return 'no HTTP response';
}

/** The model the memory judges run on: a classifier when one is usable, else the judge model; `forced` names a chosen judge that cannot run. */
export function memoryJudgeOf(
  classifier: ClassifierModelRef | null,
  judgeModel: { provider: string; id: string } | null,
  rejected: NonNullable<MemoryJudge['rejected']> = [],
  forced?: { choice: string; reason: MemoryJudgeUnavailable },
): MemoryJudge {
  const extra = rejected.length > 0 ? { rejected } : {};
  if (classifier) return { kind: 'classifier', via: classifier.provider, ...extra };
  if (judgeModel) return { kind: 'model', model: `${judgeModel.provider}/${judgeModel.id}`, ...extra };
  return { kind: 'none', ...(forced ? { forced } : {}), ...extra };
}
