import * as Diff from 'diff';

/**
 * Ports of pi's `applyReplacementsToOriginal` and `generateEditDiff` (pi-coding-agent 1.5.2
 * `dist/core/tools/edit-diff.js:18` and `:452`), which its package does not export.
 */

/** Replacement of `matchLength` characters at `matchIndex` with `newText`. */
export type TextReplacement = { matchIndex: number; matchLength: number; newText: string };

/** Display diff and unified patch of an edit, as pi's edit returns them in its details. */
export interface EditDiff {
  diff: string;
  patch: string;
  firstChangedLine: number | undefined;
}

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

/** Number of lines as `text.split("\n").length` counts them, without building the array. */
function countLines(text: string): number {
  return countLineFeeds(text, 0, text.length) + 1;
}

function countLineFeeds(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = text.indexOf('\n', start); index !== -1 && index < end; index = text.indexOf('\n', index + 1)) {
    count++;
  }
  return count;
}

/** Format jsdiff line parts as display diff lines, numbering from the given 1-based old and new lines. */
function formatDisplayDiff(
  parts: Diff.ChangeObject<string>[],
  oldStartLine: number,
  newStartLine: number,
  lineNumWidth: number,
  contextLines: number,
): { output: string[]; firstChangedLine: number | undefined } {
  const output: string[] = [];
  let oldLineNum = oldStartLine;
  let newLineNum = newStartLine;
  let lastWasChange = false;
  let firstChangedLine: number | undefined;
  const pushContext = (line: string): void => {
    output.push(` ${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`);
    oldLineNum++;
    newLineNum++;
  };
  const skip = (count: number): void => {
    output.push(` ${''.padStart(lineNumWidth, ' ')} ...`);
    oldLineNum += count;
    newLineNum += count;
  };

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const raw = part.value.split('\n');
    if (raw[raw.length - 1] === '') raw.pop();

    if (part.added || part.removed) {
      firstChangedLine ??= newLineNum;
      for (const line of raw) {
        if (part.added) {
          output.push(`+${String(newLineNum).padStart(lineNumWidth, ' ')} ${line}`);
          newLineNum++;
        } else {
          output.push(`-${String(oldLineNum).padStart(lineNumWidth, ' ')} ${line}`);
          oldLineNum++;
        }
      }
      lastWasChange = true;
      continue;
    }

    const next = parts[i + 1];
    const hasTrailingChange = next !== undefined && (next.added || next.removed);
    if (lastWasChange && hasTrailingChange) {
      if (raw.length <= contextLines * 2) {
        raw.forEach(pushContext);
      } else {
        const trailingLines = raw.slice(raw.length - contextLines);
        raw.slice(0, contextLines).forEach(pushContext);
        skip(raw.length - contextLines - trailingLines.length);
        trailingLines.forEach(pushContext);
      }
    } else if (lastWasChange) {
      const shownLines = raw.slice(0, contextLines);
      shownLines.forEach(pushContext);
      if (raw.length > shownLines.length) skip(raw.length - shownLines.length);
    } else if (hasTrailingChange) {
      const skippedLines = Math.max(0, raw.length - contextLines);
      if (skippedLines > 0) skip(skippedLines);
      raw.slice(skippedLines).forEach(pushContext);
    } else {
      oldLineNum += raw.length;
      newLineNum += raw.length;
    }
    lastWasChange = false;
  }

  return { output, firstChangedLine };
}

/** Unchanged lines diffed on each side of a replacement: well above the 4 context lines, so jsdiff aligns a change as over the whole file. */
const DIFF_WINDOW_MARGIN_LINES = 32;

/**
 * Diff an edit only around its replacements, so time and memory follow the size of the change instead of
 * the file. The result matches pi's `generateDiffString` and `generateUnifiedPatch` over the whole contents,
 * except that jsdiff may align runs of repeated lines differently within a window.
 */
export function generateEditDiff(
  path: string,
  baseContent: string,
  newContent: string,
  replacements: readonly TextReplacement[],
  contextLines = 4,
): EditDiff {
  const lineFeeds = lineFeedOffsets(baseContent);
  const lineNumWidth = String(Math.max(lineFeeds.length + 1, countLines(newContent))).length;
  const skipMarker = ` ${''.padStart(lineNumWidth, ' ')} ...`;
  const output: string[] = [];
  const hunks: Diff.StructuredPatchHunk[] = [];
  let firstChangedLine: number | undefined;
  for (const window of getDiffWindows(baseContent, lineFeeds, replacements)) {
    const oldText = baseContent.slice(window.oldStart, window.oldEnd);
    const newText = newContent.slice(window.newStart, window.newEnd);
    const shown = formatDisplayDiff(Diff.diffLines(oldText, newText), window.oldLine + 1, window.newLine + 1, lineNumWidth, contextLines);
    firstChangedLine ??= shown.firstChangedLine;
    // Both windows around a run of unchanged lines mark it as skipped; the whole-file diff shows one marker.
    if (output.at(-1) === skipMarker && shown.output[0] === skipMarker) shown.output.shift();
    // A loop, not push(...lines): spreading a replacement of many lines overflows the call stack.
    for (const line of shown.output) output.push(line);
    const patch = Diff.structuredPatch(path, path, oldText, newText, undefined, undefined, { context: contextLines });
    for (const hunk of patch.hunks) {
      hunks.push({ ...hunk, oldStart: hunk.oldStart + window.oldLine, newStart: hunk.newStart + window.newLine });
    }
  }
  const patch = Diff.formatPatch({ oldFileName: path, newFileName: path, oldHeader: undefined, newHeader: undefined, hunks }, Diff.FILE_HEADERS_ONLY);
  return { diff: output.join('\n'), patch, firstChangedLine };
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
