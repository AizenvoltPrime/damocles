// Line-level hunk staging and revert, ported from VS Code's extensions/git/src/staging.ts (applyLineChanges,
// intersectDiffWithRange, invertLineChange, compareLineChanges). Used by core's index staging and the shell's revert.

// VS Code's LineChange: 1-based lines; an empty side has end 0 and start the line it follows (0 before the first line).
export interface LineChange {
  readonly originalStartLineNumber: number;
  readonly originalEndLineNumber: number;
  readonly modifiedStartLineNumber: number;
  readonly modifiedEndLineNumber: number;
}

// 1-based, inclusive, whole lines (VS Code's toLineRanges of a selection).
export interface LineRange {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
}

// Each line's start offset and the offset where its content ends (before its line break); line breaks are \r\n, \n or \r,
// as in VS Code's and Monaco's text models.
interface Lines {
  readonly text: string;
  readonly starts: readonly number[];
  readonly contentEnds: readonly number[];
}

function linesOf(text: string): Lines {
  const starts = [0];
  const contentEnds: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code !== 10 && code !== 13) continue;
    contentEnds.push(i);
    if (code === 13 && text.charCodeAt(i + 1) === 10) i++;
    starts.push(i + 1);
  }
  contentEnds.push(text.length);
  return { text, starts, contentEnds };
}

/** Lines a text model of text holds: one more than its line breaks. */
export function lineCountOf(text: string): number {
  return linesOf(text).starts.length;
}

// The offset of a 0-based (line, character) position, character 0 or 'end'; a line past the last clamps to the text's end,
// as VS Code validates a position.
function offsetAt(lines: Lines, line: number, character: 0 | 'end'): number {
  if (line >= lines.starts.length) return lines.text.length;
  return character === 0 ? lines.starts[line]! : lines.contentEnds[line]!;
}

function textBetween(lines: Lines, fromLine: number, fromCharacter: 0 | 'end', toLine: number, toCharacter: 0 | 'end'): string {
  return lines.text.slice(offsetAt(lines, fromLine, fromCharacter), offsetAt(lines, toLine, toCharacter));
}

/**
 * original with the given changes of original → modified applied, in order. Lines taken from either side keep that side's
 * line breaks; a missing final newline is handled as VS Code does (microsoft/vscode#59670).
 */
export function applyLineChanges(original: string, modified: string, diffs: readonly LineChange[]): string {
  const o = linesOf(original);
  const m = linesOf(modified);
  const originalLineCount = o.starts.length;
  const result: string[] = [];
  let currentLine = 0;
  for (const diff of diffs) {
    const isInsertion = diff.originalEndLineNumber === 0;
    const isDeletion = diff.modifiedEndLineNumber === 0;
    let endLine = isInsertion ? diff.originalStartLineNumber : diff.originalStartLineNumber - 1;
    let endCharacter: 0 | 'end' = 0;
    // a deletion at the very end also takes the line break before it, which the last line no longer needs
    if (isDeletion && diff.originalEndLineNumber === originalLineCount) {
      endLine -= 1;
      endCharacter = 'end';
    }
    result.push(textBetween(o, currentLine, 0, endLine, endCharacter));
    if (!isDeletion) {
      let fromLine = diff.modifiedStartLineNumber - 1;
      let fromCharacter: 0 | 'end' = 0;
      // an insertion at the very end starts after the previous line's content, to take the right line break
      if (isInsertion && diff.originalStartLineNumber === originalLineCount) {
        fromLine -= 1;
        fromCharacter = 'end';
      }
      result.push(textBetween(m, fromLine, fromCharacter, diff.modifiedEndLineNumber, 0));
    }
    currentLine = isInsertion ? diff.originalStartLineNumber : diff.originalEndLineNumber;
  }
  result.push(textBetween(o, currentLine, 0, originalLineCount, 0));
  return result.join('');
}

/** The change seen from the other side: unstaging applies a change of HEAD → index inverted, onto the index. */
export function invertLineChange(diff: LineChange): LineChange {
  return {
    modifiedStartLineNumber: diff.originalStartLineNumber,
    modifiedEndLineNumber: diff.originalEndLineNumber,
    originalStartLineNumber: diff.modifiedStartLineNumber,
    originalEndLineNumber: diff.modifiedEndLineNumber,
  };
}

export function compareLineChanges(a: LineChange, b: LineChange): number {
  return (
    a.modifiedStartLineNumber - b.modifiedStartLineNumber ||
    a.modifiedEndLineNumber - b.modifiedEndLineNumber ||
    a.originalStartLineNumber - b.originalStartLineNumber ||
    a.originalEndLineNumber - b.originalEndLineNumber
  );
}

/**
 * Whether a whole-line range of the modified text touches the change's modified side (VS Code's getModifiedRange plus
 * Range.intersection, which counts a touching empty range). A pure deletion sits between lines s and s+1, so a range holding
 * either line touches it; at the start it is line 1, at the end the last line. modifiedLineCount: lines of the modified text.
 */
export function touchesModifiedSide(diff: LineChange, range: LineRange, modifiedLineCount: number): boolean {
  if (diff.modifiedEndLineNumber === 0) {
    const s = diff.modifiedStartLineNumber;
    const first = s === 0 ? 1 : s;
    const last = s === 0 || s === modifiedLineCount ? first : s + 1;
    return range.startLineNumber <= last && range.endLineNumber >= first;
  }
  return range.startLineNumber <= diff.modifiedEndLineNumber && range.endLineNumber >= diff.modifiedStartLineNumber;
}

/**
 * VS Code's intersectDiffWithRange over whole lines: the part of diff whose modified lines the range covers, or null. A
 * deletion is taken whole; a change with equal line counts on both sides is cut line by line, any other keeps its whole
 * original side.
 */
export function intersectDiffWithRange(diff: LineChange, range: LineRange, modifiedLineCount: number): LineChange | null {
  if (!touchesModifiedSide(diff, range, modifiedLineCount)) return null;
  if (diff.modifiedEndLineNumber === 0) return diff;
  const modifiedStartLineNumber = Math.max(range.startLineNumber, diff.modifiedStartLineNumber);
  const modifiedEndLineNumber = Math.min(range.endLineNumber, diff.modifiedEndLineNumber);
  if (diff.originalEndLineNumber - diff.originalStartLineNumber === diff.modifiedEndLineNumber - diff.modifiedStartLineNumber) {
    const delta = modifiedStartLineNumber - diff.modifiedStartLineNumber;
    const length = modifiedEndLineNumber - modifiedStartLineNumber;
    return {
      originalStartLineNumber: diff.originalStartLineNumber + delta,
      originalEndLineNumber: diff.originalStartLineNumber + delta + length,
      modifiedStartLineNumber,
      modifiedEndLineNumber,
    };
  }
  return { originalStartLineNumber: diff.originalStartLineNumber, originalEndLineNumber: diff.originalEndLineNumber, modifiedStartLineNumber, modifiedEndLineNumber };
}

/** The selected parts of changes: each change cut to the first range that touches it (VS Code's stageSelectedRanges). */
export function selectedLineChanges(changes: readonly LineChange[], ranges: readonly LineRange[], modifiedLineCount: number): LineChange[] {
  const selected: LineChange[] = [];
  for (const change of changes) {
    for (const range of ranges) {
      const part = intersectDiffWithRange(change, range, modifiedLineCount);
      if (part) {
        selected.push(part);
        break;
      }
    }
  }
  return selected;
}
