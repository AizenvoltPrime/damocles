/**
 * The status and body of a failed request's error text: a provider SDK's own message (`529 body`), pi-ai's
 * `formatProviderError` with no label (`529: body`) or with one (`<label> error (529): body`). The body can
 * echo the request text, so callers keep only the status or a field parsed from it.
 */
function httpErrorOf(errorMessage: string | undefined): { status: number; body: string } | undefined {
  if (!errorMessage) return undefined;
  const match = /^(\d{3})(?::\s*|\s+)([\s\S]*)$/.exec(errorMessage) ?? /^[^(]*\((\d{3})\):\s*([\s\S]*)$/.exec(errorMessage);
  return match ? { status: Number(match[1]), body: match[2] ?? '' } : undefined;
}

/** The HTTP status of a failed request, in any form `httpErrorOf` reads. */
export function httpStatusOf(errorMessage: string | undefined): number | undefined {
  return httpErrorOf(errorMessage)?.status;
}

/** OpenRouter's `error_type` values for a 403 that declined the content, not the key. */
const CONTENT_REFUSAL_ERROR_TYPES: ReadonlySet<unknown> = new Set(['content_policy_violation', 'refusal']);

type RefusalMetadata = { reasons?: unknown; patterns?: unknown; error_type?: unknown };

/**
 * Whether a failed request is OpenRouter refusing this one input rather than the credential: a 403
 * whose body carries moderation `reasons`, guardrail `patterns`, or a content-policy or refusal
 * `error_type` in its `metadata` (openrouter.ai/docs/api-reference/errors). The metadata sits under
 * `error` in the full body and at the top level when the openai SDK reports only the inner `error`
 * object. The body is parsed here and never kept.
 */
export function isInputRefusal(errorMessage: string | undefined): boolean {
  const failure = httpErrorOf(errorMessage);
  if (failure?.status !== 403) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(failure.body);
  } catch {
    return false;
  }
  const root = parsed as { error?: { metadata?: RefusalMetadata }; metadata?: RefusalMetadata } | null;
  const metadata = root?.error?.metadata ?? root?.metadata;
  return Array.isArray(metadata?.reasons) || Array.isArray(metadata?.patterns) || CONTENT_REFUSAL_ERROR_TYPES.has(metadata?.error_type);
}
