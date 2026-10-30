import { diff3Merge } from 'node-diff3';

// Lines of the largest side, after the lines all three share at either end, past which nothing is aligned: node-diff3's
// LCS grows much faster than the line count on repetitive text (a lockfile's 5,000 lines took 6 s, measured).
export const MERGE_ALIGN_MAX_LINES = 2500;

export interface MergeLabels {
  readonly current: string;
  readonly incoming: string;
  readonly base: string;
}

/** Reset Result's marker names: each input's own marker, never its title, which the view shows in its language. */
export function markerNames(labels: { readonly current: { readonly marker: string }; readonly incoming: { readonly marker: string }; readonly base: { readonly marker: string } }): MergeLabels {
  return { current: labels.current.marker, incoming: labels.incoming.marker, base: labels.base.marker };
}

type Diff3Region = ReturnType<typeof diff3Merge<string>>[number];

// Split as a Monaco model splits, so line numbers match the editor's.
function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

// diff3Merge of the three texts' lines, over only what lies between the lines all three share at the start and at the end
// (git's xdiff trims the same way); null past MERGE_ALIGN_MAX_LINES.
export function trimmedMerge(base: string, current: string, incoming: string): { readonly prefix: readonly string[]; readonly regions: readonly Diff3Region[]; readonly suffix: readonly string[] } | null {
  const sides = [splitLines(base), splitLines(current), splitLines(incoming)] as const;
  const shortest = Math.min(...sides.map((lines) => lines.length));
  let head = 0;
  while (head < shortest && sides[0][head] === sides[1][head] && sides[0][head] === sides[2][head]) head++;
  let tail = 0;
  const at = (lines: readonly string[]): string | undefined => lines[lines.length - 1 - tail];
  while (tail < shortest - head && at(sides[0]) === at(sides[1]) && at(sides[0]) === at(sides[2])) tail++;
  const [o, a, b] = sides.map((lines) => lines.slice(head, lines.length - tail));
  if (Math.max(o!.length, a!.length, b!.length) > MERGE_ALIGN_MAX_LINES) return null;
  return { prefix: sides[0].slice(0, head), regions: diff3Merge(a!, o!, b!, { excludeFalseConflicts: true }), suffix: sides[0].slice(sides[0].length - tail) };
}

/**
 * The Result as Reset Result rebuilds it: every change both sides agree on merged, each conflict as marker blocks (git's
 * merge style, or diff3 with the base block), joined with the document's line break; null past the line cap.
 */
export function mergeWithMarkers(base: string, current: string, incoming: string, labels: MergeLabels, eol: string, diff3 = false): string | null {
  const merged = trimmedMerge(base, current, incoming);
  if (!merged) return null;
  const lines: string[] = [...merged.prefix];
  for (const region of merged.regions) {
    if (region.ok) lines.push(...region.ok);
    else if (region.conflict) {
      lines.push(`<<<<<<< ${labels.current}`, ...region.conflict.a);
      if (diff3) lines.push(`||||||| ${labels.base}`, ...region.conflict.o);
      lines.push('=======', ...region.conflict.b, `>>>>>>> ${labels.incoming}`);
    }
  }
  lines.push(...merged.suffix);
  return lines.join(eol);
}
