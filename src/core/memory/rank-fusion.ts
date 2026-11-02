/** The reciprocal rank fusion constant of Cormack, Clarke and Buettcher (SIGIR 2009); it damps the weight of the first ranks. */
export const RRF_K = 60;

/**
 * Fuses ranked id lists by reciprocal rank fusion: each id scores the sum of 1 / (RRF_K + rank) over the lists that hold it,
 * ranks counted from 1. Only positions are compared, because bm25 scores from two databases are not comparable. Ties keep
 * the order of first appearance, earlier lists first.
 */
export function fuseRankedLists(lists: ReadonlyArray<readonly string[]>): string[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, index) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }
  const order = [...scores.keys()];
  return order
    .map((id, position) => ({ id, position, score: scores.get(id)! }))
    .sort((a, b) => b.score - a.score || a.position - b.position)
    .map(({ id }) => id);
}
