/** Settles once every promise `pending()` lists has settled, asking again after each round so work queued meanwhile is waited for too; never rejects. */
export async function settlePending(pending: () => Iterable<Promise<unknown>>): Promise<void> {
  const awaited = new Set<Promise<unknown>>();
  for (;;) {
    const round = [...pending()].filter((promise) => !awaited.has(promise));
    if (round.length === 0) return;
    for (const promise of round) awaited.add(promise);
    await Promise.allSettled(round);
  }
}
