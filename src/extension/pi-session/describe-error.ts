/**
 * describe-error.ts — the redactor for every log line that can receive an auth/credential-shaped error.
 *
 * pi's `CredentialSynchronizationError` (`@earendil-works/pi-coding-agent`) carries the credential it
 * failed to synchronize as an own enumerable `credential` property — `{ type: 'api_key', key }`. The
 * Damocles logger formats with `node:util` `format`, so a `%O`/`%o`/`%j` on such an error inspects the
 * raw API key straight into the output channel, which users routinely paste into bug reports. Errors out
 * of `registerProvider`, `setRuntimeApiKey`, `logout` and `ModelRuntime.refresh` are all reachable from
 * the same credential paths, so they are described, never inspected.
 */

/** Name + message (plus one level of cause), with no property inspection — so no credential can ride along. */
export function describeAuthError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as { cause?: unknown }).cause;
  return `${err.name}: ${err.message}${cause instanceof Error ? ` (cause: ${cause.name}: ${cause.message})` : ''}`;
}
