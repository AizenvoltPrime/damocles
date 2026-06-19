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
