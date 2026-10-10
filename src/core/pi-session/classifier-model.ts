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

/** The environment variables pi reads as each provider's key (pi-ai `env-api-keys.js`). */
export const CLASSIFIER_ENV_KEYS: Readonly<Record<ClassifierProvider, string>> = {
  typesafe: 'TYPESAFE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
};

const CLASSIFIER_MODEL_BY_PROVIDER: Readonly<Record<ClassifierProvider, ClassifierModelRef>> = {
  typesafe: JEV_VIA_TYPESAFE,
  openrouter: JEV_VIA_OPENROUTER,
  openai: GPT_6_LUNA_CLASSIFIER,
};

/** In Automatic's order, which `MEMORY_JUDGE_CLASSIFIERS` follows. */
export const CLASSIFIER_MODELS: readonly ClassifierModelRef[] = [JEV_VIA_TYPESAFE, JEV_VIA_OPENROUTER, GPT_6_LUNA_CLASSIFIER];

export function classifierModelOf(provider: ClassifierProvider): ClassifierModelRef {
  return CLASSIFIER_MODEL_BY_PROVIDER[provider];
}

/** The first classifier in preference order that is usable (credential, breaker and catalog model), else none. */
export function pickClassifierModel(isUsable: (ref: ClassifierModelRef) => boolean): ClassifierModelRef | null {
  return CLASSIFIER_MODELS.find(isUsable) ?? null;
}

/**
 * Whether `provider`'s credential can serve a classifier. `configured` is pi's `hasConfiguredAuth` (or its
 * pre-start stand-in). OpenAI counts only while its request credential is an API key.
 */
export function classifierCredential(
  provider: ClassifierProvider,
  configured: (provider: ClassifierProvider) => boolean,
  openai: { status: Pick<OpenAIAuthStatus, 'apiKey' | 'chatgpt'>; preferApiKey: boolean },
): ClassifierCredential {
  if (provider !== 'openai') return configured(provider) ? 'ok' : 'no-key';
  if (openaiRequestCredentialIsKey(openai.status, openai.preferApiKey, configured('openai'))) return 'ok';
  return openai.status.chatgpt ? 'chatgpt-active' : 'no-key';
}

/** OpenRouter's `error_type` values for a 403 that declined the content, not the key. */
const CONTENT_REFUSAL_ERROR_TYPES: ReadonlySet<unknown> = new Set(['content_policy_violation', 'refusal']);

/**
 * Whether a failed Jev request is OpenRouter refusing this one input rather than the credential: a 403
 * whose body carries moderation `reasons`, guardrail `patterns`, or a content-policy or refusal
 * `error_type` in `error.metadata` (openrouter.ai/docs/api-reference/errors). The body is parsed here
 * and never kept.
 */
export function isInputRefusal(errorMessage: string | undefined): boolean {
  const body = errorMessage ? /^[^(]*\(403\):\s*([\s\S]*)$/.exec(errorMessage)?.[1] : undefined;
  if (!body) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const metadata = (parsed as { error?: { metadata?: { reasons?: unknown; patterns?: unknown; error_type?: unknown } } } | null)?.error?.metadata;
  return Array.isArray(metadata?.reasons) || Array.isArray(metadata?.patterns) || CONTENT_REFUSAL_ERROR_TYPES.has(metadata?.error_type);
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
