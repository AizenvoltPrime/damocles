import { mergeWithMarkers, trimmedMerge, type MergeLabels } from '@shared/scm/merge-markers';
import { splitLines } from '../quick-diff/quick-diff-compute';
import { parseConflicts, type Conflict } from './conflict-parser';

export { MERGE_ALIGN_MAX_LINES, mergeWithMarkers, type MergeLabels } from '@shared/scm/merge-markers';

// The merge editor's model (B28): node-diff3 aligns base, current and incoming into regions, so each conflict of the Result
// shows where it sits in the Current and Incoming panes; the Result's own conflicts are its marker blocks, which accepting a
// side, an edit by hand or Compute Conflicts With Git change. The alignment runs in merge.worker.ts, off the shell's main
// thread (docs/invariants.md names the worker).

// 1-based first line and line count of one conflict on each side; lines 0 means the side is empty there, after line start - 1
export interface SideSpan {
  readonly start: number;
  readonly lines: number;
}

export interface ConflictRegion {
  readonly current: SideSpan;
  readonly incoming: SideSpan;
  readonly base: SideSpan;
  readonly currentText: readonly string[];
  readonly incomingText: readonly string[];
}

/** The conflicting regions of a three-way merge, in order (diff3Merge without false conflicts); null past the line cap. */
export function alignConflicts(base: string, current: string, incoming: string): ConflictRegion[] | null {
  const merged = trimmedMerge(base, current, incoming);
  if (!merged) return null;
  const offset = merged.prefix.length;
  const regions: ConflictRegion[] = [];
  for (const region of merged.regions) {
    const conflict = region.conflict;
    if (!conflict) continue;
    regions.push({
      current: { start: offset + conflict.aIndex + 1, lines: conflict.a.length },
      incoming: { start: offset + conflict.bIndex + 1, lines: conflict.b.length },
      base: { start: offset + conflict.oIndex + 1, lines: conflict.o.length },
      currentText: conflict.a,
      incomingText: conflict.b,
    });
  }
  return regions;
}

// The merge worker's messages, each answered under its id.
export type MergeRequest =
  | { readonly id: number; readonly kind: 'align'; readonly base: string; readonly current: string; readonly incoming: string }
  | { readonly id: number; readonly kind: 'markers'; readonly base: string; readonly current: string; readonly incoming: string; readonly labels: MergeLabels; readonly eol: string };

export type MergeReply =
  | { readonly id: number; readonly kind: 'align'; readonly regions: ConflictRegion[] | null }
  | { readonly id: number; readonly kind: 'markers'; readonly text: string | null };

/** The worker's handler. */
export function handleMergeRequest(request: MergeRequest): MergeReply {
  if (request.kind === 'align') return { id: request.id, kind: 'align', regions: alignConflicts(request.base, request.current, request.incoming) };
  return { id: request.id, kind: 'markers', text: mergeWithMarkers(request.base, request.current, request.incoming, request.labels, request.eol) };
}

const sameLines = (text: string, block: Conflict['current'], lines: readonly string[]): boolean => {
  const own = block.lineCount === 0 ? [] : splitLines(text.slice(block.contentStart, block.contentEnd)).slice(0, block.lineCount);
  return own.length === lines.length && own.every((line, index) => line === lines[index]);
};

/**
 * Which aligned region each of the Result's marker conflicts is: the first region left whose two sides hold the same lines,
 * else the region at the same position when both lists have the same length, else none (a conflict the Result holds that
 * the inputs do not, such as one typed by hand).
 */
export function matchRegions(resultText: string, conflicts: readonly Conflict[], regions: readonly ConflictRegion[]): Array<ConflictRegion | null> {
  const used = new Set<ConflictRegion>();
  const matched = conflicts.map((conflict) => {
    const region = regions.find((candidate) => !used.has(candidate) && sameLines(resultText, conflict.current, candidate.currentText) && sameLines(resultText, conflict.incoming, candidate.incomingText));
    if (region) used.add(region);
    return region ?? null;
  });
  if (conflicts.length === regions.length) return matched.map((region, index) => region ?? (used.has(regions[index]!) ? null : regions[index]!));
  return matched;
}

export interface MergeProgress {
  // conflicts the Result still holds
  readonly left: number;
  // conflicts it held when the editor opened, or when its Result was last rebuilt
  readonly total: number;
}

/** The live count: the total never falls below what is left, as a conflict typed by hand adds one. */
export function mergeProgress(resultText: string, total: number): MergeProgress {
  const left = parseConflicts(resultText).length;
  return { left, total: Math.max(total, left) };
}
