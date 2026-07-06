/** Normalize any thrown value to a message string. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** True when `err` is (or reads as) an abort — used to report a clean "Aborted" instead of a raw message. */
export function isAbortError(err: unknown): boolean {
  return errorMessage(err).toLowerCase().includes('abort');
}

/**
 * Run `fn` with a signal that aborts after `timeoutMs` OR when the caller's `signal` aborts, cleaning up
 * the timer and listener afterward. Consolidates the identical timeout/abort scaffold the web-access
 * fetchers each need. `fn` receives the combined signal to pass to its fetch; it owns its own error
 * handling (this helper only manages the lifetime of the timeout + linked abort).
 */
export async function withTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = (): void => controller.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timeoutId);
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, preserving input order in the result.
 * Replaces the `p-limit` dependency the upstream used (one fewer bundled package + its transitive
 * `yocto-queue`). Each task settles independently — `fn` is responsible for its own error handling so
 * one rejection never aborts the batch.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!, index);
    }
  };
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
