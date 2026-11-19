/**
 * Ports of pi's `applyReplacementsToOriginal` and of the patch half of its `generateEditDiff` (pi-coding-agent 1.5.2
 * `dist/core/tools/edit-diff.js:18` and `:452`), which its package does not export. The patch is split in two: the windows
 * around the replacements, linear, which a host thread computes, and their line diffs, which only the diff worker runs
 * (`windowedEditPatch`, `src/core/diff/jobs.ts`).
 */

/** Replacement of `matchLength` characters at `matchIndex` with `newText`. */
export type TextReplacement = { matchIndex: number; matchLength: number; newText: string };

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * Apply replacements matched in `normalizeToLF(originalContent)` to `originalContent` itself.
 * Text outside the replaced ranges keeps its bytes, including its line endings. Line breaks in
 * the new text get the line ending of the line where the replaced range starts. The result,
 * normalized to LF, equals the replacements applied to the normalized content.
 */
export function applyReplacementsToOriginal(originalContent: string, replacements: readonly TextReplacement[]): string {
  // Only CRLF changes length when normalizing: the LF of the n-th CRLF (at original offset p) is at
  // p - n in the normalized text, and a range that covers that LF covers the whole CRLF.
  let crlfBefore = 0;
  let nextCrlf = originalContent.indexOf('\r\n');
  const toOriginal = (offset: number): number => {
    while (nextCrlf !== -1 && nextCrlf - crlfBefore < offset) {
      crlfBefore++;
      nextCrlf = originalContent.indexOf('\r\n', nextCrlf + 2);
    }
    return offset + crlfBefore;
  };

  const parts: string[] = [];
  let endsWithCr = false;
  const push = (part: string): void => {
    if (part.length === 0) return;
    // A CR before a seam and an LF after it would merge into one CRLF; the added LF keeps the line breaks the diff shows.
    if (endsWithCr && part[0] === '\n') parts.push('\n');
    parts.push(part);
    endsWithCr = part[part.length - 1] === '\r';
  };
  const getLineEndingAt = lineEndingsAt(originalContent);
  let position = 0;
  for (const replacement of replacements) {
    const start = toOriginal(replacement.matchIndex);
    push(originalContent.slice(position, start));
    const ending = getLineEndingAt(start);
    push(ending === '\n' ? replacement.newText : replacement.newText.replaceAll('\n', ending));
    position = toOriginal(replacement.matchIndex + replacement.matchLength);
  }
  push(originalContent.slice(position));
  return parts.join('');
}

/**
 * Line ending of the line containing each offset: its own LF or CRLF, or that of the line before
 * for an unterminated last line. A lone CR only counts in files without any LF.
 * Offsets must come in ascending order, so the whole content is scanned once.
 */
function lineEndingsAt(content: string): (offset: number) => '\r\n' | '\n' | '\r' {
  const lastLineFeed = content.lastIndexOf('\n');
  if (lastLineFeed === -1) {
    const ending = content.includes('\r') ? '\r' : '\n';
    return () => ending;
  }
  let nextLineFeed = content.indexOf('\n');
  return (offset) => {
    while (nextLineFeed !== -1 && nextLineFeed < offset) nextLineFeed = content.indexOf('\n', nextLineFeed + 1);
    const lineFeed = nextLineFeed === -1 ? lastLineFeed : nextLineFeed;
    return content[lineFeed - 1] === '\r' ? '\r\n' : '\n';
  };
}

/** Offsets of every LF in `text`, ascending. */
function lineFeedOffsets(text: string): Int32Array {
  const offsets = new Int32Array(countLineFeeds(text, 0, text.length));
  let count = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) offsets[count++] = index;
  return offsets;
}

/** Number of LF offsets before `offset`, which is the 0-based line of `offset`. */
function lineFeedsBefore(lineFeeds: Int32Array, offset: number): number {
  let low = 0;
  let high = lineFeeds.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lineFeeds[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function countLineFeeds(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = text.indexOf('\n', start); index !== -1 && index < end; index = text.indexOf('\n', index + 1)) {
    count++;
  }
  return count;
}

/**
 * The 1-based line of `newContent` holding the first character where the texts differ, undefined when they are equal: the
 * line a line diff's first change starts on, since its first snake takes every equal leading line. Linear, so a host thread
 * may run it.
 */
export function firstChangedLine(baseContent: string, newContent: string): number | undefined {
  const shorter = Math.min(baseContent.length, newContent.length);
  let index = 0;
  while (index < shorter && baseContent.charCodeAt(index) === newContent.charCodeAt(index)) index++;
  if (index === baseContent.length && index === newContent.length) return undefined;
  return countLineFeeds(newContent, 0, index) + 1;
}

/** Unchanged lines diffed on each side of a replacement: well above the 4 context lines, so jsdiff aligns a change as over the whole file. */
const DIFF_WINDOW_MARGIN_LINES = 32;

/** The old and new text around one or more replacements, whole lines, with the 0-based line each starts on. */
export interface EditWindow {
  oldText: string;
  newText: string;
  oldLine: number;
  newLine: number;
}

/** The windows an edit's patch diffs, so its cost follows the size of the change instead of the file. Linear, so a host thread may run it. */
export function editDiffWindows(baseContent: string, newContent: string, replacements: readonly TextReplacement[]): EditWindow[] {
  return getDiffWindows(baseContent, lineFeedOffsets(baseContent), replacements).map((window) => ({
    oldText: baseContent.slice(window.oldStart, window.oldEnd),
    newText: newContent.slice(window.newStart, window.newEnd),
    oldLine: window.oldLine,
    newLine: window.newLine,
  }));
}

/** Matching ranges of the old and new contents around one or more replacements: offsets and 0-based first lines. */
interface DiffWindow {
  oldStart: number;
  oldEnd: number;
  oldLine: number;
  newStart: number;
  newEnd: number;
  newLine: number;
}

/**
 * Whole-line windows with margin around the replacements, which are sorted and disjoint; overlapping windows merge.
 * `lineFeeds` holds the offsets of the LFs in `baseContent`, so each replacement costs a few binary searches, never a scan of its line.
 */
function getDiffWindows(baseContent: string, lineFeeds: Int32Array, replacements: readonly TextReplacement[]): DiffWindow[] {
  const windows: DiffWindow[] = [];
  // Offset and line deltas of the replacements before the current one.
  let offsetDelta = 0;
  let lineDelta = 0;
  for (const replacement of replacements) {
    const matchEnd = replacement.matchIndex + replacement.matchLength;
    const matchLine = lineFeedsBefore(lineFeeds, replacement.matchIndex);
    const startLine = Math.max(0, matchLine - DIFF_WINDOW_MARGIN_LINES);
    const start = startLine === 0 ? 0 : lineFeeds[startLine - 1]! + 1;
    // The LF ending the match's last line, then one more per margin line.
    const endLineFeed = lineFeedsBefore(lineFeeds, Math.max(matchEnd - 1, replacement.matchIndex)) + DIFF_WINDOW_MARGIN_LINES;
    const end = endLineFeed < lineFeeds.length ? lineFeeds[endLineFeed]! + 1 : baseContent.length;
    const replacementOffsetDelta = replacement.newText.length - replacement.matchLength;
    const replacementLineDelta = countLineFeeds(replacement.newText, 0, replacement.newText.length) - (lineFeedsBefore(lineFeeds, matchEnd) - matchLine);
    const previous = windows.at(-1);
    if (previous && start <= previous.oldEnd) {
      previous.oldEnd = Math.max(previous.oldEnd, end);
      previous.newEnd = previous.oldEnd + offsetDelta + replacementOffsetDelta;
    } else {
      windows.push({
        oldStart: start,
        oldEnd: end,
        oldLine: startLine,
        newStart: start + offsetDelta,
        newEnd: end + offsetDelta + replacementOffsetDelta,
        newLine: startLine + lineDelta,
      });
    }
    offsetDelta += replacementOffsetDelta;
    lineDelta += replacementLineDelta;
  }
  return windows;
}
