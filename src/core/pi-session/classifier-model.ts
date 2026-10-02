import type { ClassifierProvider, MemoryJudge } from '../../shared/types/settings';

/** A classifier model in pi's catalog, addressed as `getModelOfType('classifier', provider, id)`. */
export interface ClassifierModelRef {
  provider: ClassifierProvider;
  id: string;
}

export const JEV_VIA_TYPESAFE: ClassifierModelRef = { provider: 'typesafe', id: 'jev-latest' };
export const JEV_VIA_OPENROUTER: ClassifierModelRef = { provider: 'openrouter', id: '~typesafe/jev-latest' };

/** The environment variables pi reads as each provider's key (pi-ai `env-api-keys.js`). */
export const CLASSIFIER_ENV_KEYS: Readonly<Record<ClassifierProvider, string>> = {
  typesafe: 'TYPESAFE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

/** In preference order. */
export const CLASSIFIER_MODELS: readonly ClassifierModelRef[] = [JEV_VIA_TYPESAFE, JEV_VIA_OPENROUTER];

/** Jev on TypeSafe when that provider is usable, else Jev on OpenRouter, else none. */
export function pickClassifierModel(isUsable: (provider: ClassifierProvider) => boolean): ClassifierModelRef | null {
  return CLASSIFIER_MODELS.find((ref) => isUsable(ref.provider)) ?? null;
}

/**
 * The HTTP status of a failed Jev request. pi formats an HTTP failure as `<label> error (<status>): <body>`
 * (pi-ai `formatProviderError`); the body can echo the request's memory text, so callers keep only the status.
 */
export function httpStatusOf(errorMessage: string | undefined): number | undefined {
  const status = errorMessage ? /^[^(]*\((\d{3})\):/.exec(errorMessage)?.[1] : undefined;
  return status === undefined ? undefined : Number(status);
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

/** A loggable cause for a failed Jev request, never including the response body. */
export function classifierFailureCause(errorMessage: string | undefined): string {
  if (!errorMessage) return 'no error message';
  const status = httpStatusOf(errorMessage);
  if (status !== undefined) return `HTTP ${status}`;
  if (/timed out/i.test(errorMessage)) return 'timeout';
  if (/did not return|returned an? (unexpected|invalid)/.test(errorMessage)) return 'malformed answers';
  return 'no HTTP response';
}

/** The model the memory judges run on: Jev when a classifier is usable, else the sub-call model. */
export function memoryJudgeOf(
  classifier: ClassifierModelRef | null,
  subCallModel: { provider: string; id: string } | null,
  rejected: NonNullable<MemoryJudge['rejected']> = [],
): MemoryJudge {
  const extra = rejected.length > 0 ? { rejected } : {};
  if (classifier) return { kind: 'jev', via: classifier.provider, ...extra };
  if (subCallModel) return { kind: 'model', model: `${subCallModel.provider}/${subCallModel.id}`, ...extra };
  return { kind: 'none', ...extra };
}
