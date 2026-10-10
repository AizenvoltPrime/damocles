/**
 * The HTTP status of a failed request. pi formats an HTTP failure as `<label> error (<status>): <body>`
 * (pi-ai `formatProviderError`); the body can echo the request text, so callers keep only the status.
 */
export function httpStatusOf(errorMessage: string | undefined): number | undefined {
  const status = errorMessage ? /^[^(]*\((\d{3})\):/.exec(errorMessage)?.[1] : undefined;
  return status === undefined ? undefined : Number(status);
}
