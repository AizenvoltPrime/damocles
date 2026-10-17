import { diffArrays, type ChangeObject } from 'diff';
import { touchesModifiedSide, type LineChange, type LineRange } from '@shared/scm/apply-line-changes';

// The quick diff's line diffs, as VS Code's quickDiffModel computes them (quickDiffModel.ts diff, quickDiffDecorator.ts):
// the primary diff is the buffer against the index; the secondary is the buffer against HEAD, shown only where no primary
// change touches it; staged is HEAD against the index, which Unstage needs in the index's own lines.

// ms and line edits after which jsdiff gives up and the file shows no marks, so a huge rewrite never blocks the worker
// (VS Code's dirty diff stops after its own maxComputationTimeMs).
export const QUICK_DIFF_TIMEOUT_MS = 1000;
export const QUICK_DIFF_MAX_EDIT_LENGTH = 5000;

/** A text's lines as a Monaco model holds them: split at \r\n, \n and \r, so line numbers match the editor's. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/);
}

/**
 * jsdiff's change objects over lines as VS Code's LineChanges (staging.ts toLineChanges): each run of removed and added
 * lines is one change, and an empty side has end 0 and start the line before it.
 */
export function lineChangesOf(parts: ReadonlyArray<ChangeObject<string[]>>): LineChange[] {
  const changes: LineChange[] = [];
  let original = 1;
  let modified = 1;
  let index = 0;
  while (index < parts.length) {
    const part = parts[index]!;
    if (!part.added && !part.removed) {
      original += part.count;
      modified += part.count;
      index++;
      continue;
    }
    let removed = 0;
    let added = 0;
    while (index < parts.length && (parts[index]!.added || parts[index]!.removed)) {
      if (parts[index]!.added) added += parts[index]!.count;
      else removed += parts[index]!.count;
      index++;
    }
    changes.push({
      originalStartLineNumber: removed === 0 ? original - 1 : original,
      originalEndLineNumber: removed === 0 ? 0 : original + removed - 1,
      modifiedStartLineNumber: added === 0 ? modified - 1 : modified,
      modifiedEndLineNumber: added === 0 ? 0 : modified + added - 1,
    });
    original += removed;
    modified += added;
  }
  return changes;
}

/** The line changes of original → modified, or null when the diff gave up (timeout or edit length). */
export function diffLineChanges(original: string, modified: string): LineChange[] | null {
  const parts = diffArrays(splitLines(original), splitLines(modified), { timeout: QUICK_DIFF_TIMEOUT_MS, maxEditLength: QUICK_DIFF_MAX_EDIT_LENGTH });
  return parts === undefined ? null : lineChangesOf(parts);
}

export type ChangeKind = 'added' | 'deleted' | 'modified';

// VS Code's getChangeType.
export function changeKind(change: LineChange): ChangeKind {
  if (change.originalEndLineNumber === 0) return 'added';
  if (change.modifiedEndLineNumber === 0) return 'deleted';
  return 'modified';
}

// VS Code's getModifiedEndLineNumber: a deletion ends where it starts, or on line 1 before the first line.
export function modifiedEndLine(change: LineChange): number {
  if (change.modifiedEndLineNumber === 0) return change.modifiedStartLineNumber === 0 ? 1 : change.modifiedStartLineNumber;
  return change.modifiedEndLineNumber;
}

// The modified side as a [start, endExclusive) line range (VS Code's change2.modified): a deletion is empty after its line.
function modifiedRange(change: LineChange): readonly [number, number] {
  return change.modifiedEndLineNumber === 0 ? [change.modifiedStartLineNumber + 1, change.modifiedStartLineNumber + 1] : [change.modifiedStartLineNumber, change.modifiedEndLineNumber + 1];
}

// VS Code's LineRange.intersectsOrTouches.
export function touches(a: LineChange, b: LineChange): boolean {
  const [aStart, aEnd] = modifiedRange(a);
  const [bStart, bEnd] = modifiedRange(b);
  return aStart <= bEnd && bStart <= aEnd;
}

export interface QuickDiffBase {
  readonly indexText: string;
  // null without staged changes: the secondary diff shows only for a file with staged changes
  readonly headText: string | null;
}

export interface QuickDiffResult {
  // index → buffer; null when the diff gave up, and then nothing shows
  readonly primary: readonly LineChange[] | null;
  // HEAD → buffer, only the changes no primary change touches (quickDiffDecorator.ts onDidChange)
  readonly secondary: readonly LineChange[];
  // HEAD → index
  readonly staged: readonly LineChange[];
  // HEAD → buffer, every change; blame maps lines through it (the primary diff when nothing is staged)
  readonly head: readonly LineChange[];
}

/** HEAD → index, which depends on the base alone; null when the diff gave up. */
export function stagedChanges(base: QuickDiffBase): LineChange[] | null {
  return base.headText === null ? [] : diffLineChanges(base.headText, base.indexText);
}

// staged: stagedChanges(base), which the worker computes once per base rather than on every keystroke
export function computeQuickDiff(base: QuickDiffBase, buffer: string, staged: readonly LineChange[] | null = stagedChanges(base)): QuickDiffResult {
  const primary = diffLineChanges(base.indexText, buffer);
  if (primary === null) return { primary: null, secondary: [], staged: [], head: [] };
  if (base.headText === null) return { primary, secondary: [], staged: [], head: primary };
  const head = diffLineChanges(base.headText, buffer);
  if (head === null || staged === null) return { primary: null, secondary: [], staged: [], head: [] };
  return { primary, secondary: head.filter((change) => !primary.some((other) => touches(other, change))), staged, head };
}

/**
 * The staged changes (HEAD → index) behind a secondary mark: outside every primary change the buffer and the index hold the
 * same lines, shifted by the primary changes above, so a secondary change maps to index lines exactly.
 */
export function stagedChangesFor(secondary: LineChange, primary: readonly LineChange[], staged: readonly LineChange[]): LineChange[] {
  const start = bufferToOriginalLine(secondary.modifiedStartLineNumber, primary);
  const end = bufferToOriginalLine(modifiedEndLine(secondary), primary);
  if (start === null || end === null) return [];
  return staged.filter((change) => {
    const [from, to] = modifiedRange(change);
    const first = Math.min(start, end);
    const last = Math.max(start, end);
    return from <= last + 1 && first <= to;
  });
}

/**
 * The original side's line for a modified (buffer) line, through line changes original → modified, as VS Code's blame maps
 * a line (blame.ts mapModifiedLineNumberToOriginalLineNumber): null for a line inside a change, which has no original line.
 */
export function bufferToOriginalLine(line: number, changes: readonly LineChange[]): number | null {
  let delta = 0;
  for (const change of changes) {
    const added = change.modifiedEndLineNumber === 0 ? 0 : change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
    const removed = change.originalEndLineNumber === 0 ? 0 : change.originalEndLineNumber - change.originalStartLineNumber + 1;
    if (added > 0 && line >= change.modifiedStartLineNumber && line <= change.modifiedEndLineNumber) return null;
    const after = added > 0 ? change.modifiedEndLineNumber : change.modifiedStartLineNumber;
    if (line <= after) break;
    delta += removed - added;
  }
  return line + delta;
}

/** The index of the change at or after line (VS Code's findNextClosestChange), wrapping to the first. */
export function nextChangeIndex(changes: readonly LineChange[], line: number, inclusive: boolean): number {
  const index = changes.findIndex((change) => (inclusive ? modifiedEndLine(change) >= line : change.modifiedStartLineNumber > line));
  return index < 0 ? 0 : index;
}

/** The index of the change at or before line (VS Code's findPreviousClosestChange), wrapping to the last. */
export function previousChangeIndex(changes: readonly LineChange[], line: number, inclusive: boolean): number {
  for (let index = changes.length - 1; index >= 0; index--) {
    const change = changes[index]!;
    if (inclusive ? change.modifiedStartLineNumber <= line : modifiedEndLine(change) < line) return index;
  }
  return changes.length - 1;
}

// The worker's messages. A base is posted once per index or HEAD change and kept by key (one per editor model), so each
// keystroke's diff sends only the buffer.
export type QuickDiffRequest =
  | { readonly kind: 'base'; readonly key: string; readonly base: QuickDiffBase }
  | { readonly kind: 'diff'; readonly key: string; readonly id: number; readonly buffer: string }
  | { readonly kind: 'drop'; readonly key: string };

// result null: the worker holds no base for the key (dropped meanwhile), so nothing shows
export interface QuickDiffReply {
  readonly key: string;
  readonly id: number;
  readonly result: QuickDiffResult | null;
}

/** The worker's handler: keeps each key's base and answers a diff request, or nothing for a base or drop. */
export function createQuickDiffHandler(): (request: QuickDiffRequest) => QuickDiffReply | undefined {
  const bases = new Map<string, { readonly base: QuickDiffBase; readonly staged: readonly LineChange[] | null }>();
  return (request) => {
    if (request.kind === 'base') bases.set(request.key, { base: request.base, staged: stagedChanges(request.base) });
    else if (request.kind === 'drop') bases.delete(request.key);
    else {
      const held = bases.get(request.key);
      return { key: request.key, id: request.id, result: held === undefined ? null : computeQuickDiff(held.base, request.buffer, held.staged) };
    }
    return undefined;
  };
}

// VS Code's toLineRanges: each selection as whole lines, merged where they touch. A selection ending at the start of a line
// (a triple click, Shift+Down) leaves that line out, as the editor's own line commands do.
export function selectionLineRanges(selections: ReadonlyArray<{ readonly startLineNumber: number; readonly endLineNumber: number; readonly endColumn?: number }>): LineRange[] {
  const sorted = [...selections]
    .map((selection) => ({ startLineNumber: selection.startLineNumber, endLineNumber: selection.endLineNumber > selection.startLineNumber && selection.endColumn === 1 ? selection.endLineNumber - 1 : selection.endLineNumber }))
    .sort((a, b) => a.startLineNumber - b.startLineNumber);
  const merged: LineRange[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.startLineNumber <= last.endLineNumber + 1) merged[merged.length - 1] = { startLineNumber: last.startLineNumber, endLineNumber: Math.max(last.endLineNumber, range.endLineNumber) };
    else merged.push(range);
  }
  return merged;
}

/** The changes Revert Selected Ranges keeps: VS Code's revertSelectedRanges reverts every change a selection touches. */
export function changesKeptByRevert(changes: readonly LineChange[], ranges: readonly LineRange[], lineCount: number): LineChange[] {
  return changes.filter((change) => !ranges.some((range) => touchesModifiedSide(change, range, lineCount)));
}

export const sameChange = (a: LineChange, b: LineChange): boolean =>
  a.originalStartLineNumber === b.originalStartLineNumber && a.originalEndLineNumber === b.originalEndLineNumber && a.modifiedStartLineNumber === b.modifiedStartLineNumber && a.modifiedEndLineNumber === b.modifiedEndLineNumber;
