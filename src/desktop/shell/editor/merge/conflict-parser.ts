// Conflict markers in a file's text, ported from VS Code's extensions/merge-conflict/src/mergeConflictParser.ts and
// documentMergeConflict.ts. Text only, so inline conflicts work in untrusted projects and outside git.

// git's marker length; a path's conflict-marker-size attribute makes git write longer ones, and every marker of a conflict
// is as long as its start
const MARKER_SIZE = 7;
const START = '<'.repeat(MARKER_SIZE);
const END = '>'.repeat(MARKER_SIZE);

// The length of the run of char a line starts with.
function runOf(text: string, char: string): number {
  let length = 0;
  while (text[length] === char) length++;
  return length;
}

// Offsets into the text; a block's content runs from the end of its marker line's break to the start of the next marker.
export interface ConflictBlock {
  // 1-based line of the marker
  readonly headerLine: number;
  readonly contentStart: number;
  readonly contentEnd: number;
  // 1-based lines the content spans: [firstLine, firstLine + lineCount)
  readonly firstLine: number;
  readonly lineCount: number;
  // the marker's text after the marker and a space: "HEAD", "feature"
  readonly name: string;
}

export interface Conflict {
  readonly current: ConflictBlock;
  readonly commonAncestors: readonly ConflictBlock[];
  // 1-based line of =======
  readonly splitterLine: number;
  readonly incoming: ConflictBlock;
  // the whole conflict, from the <<<<<<< line's start to the end of the >>>>>>> line's break
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
}

interface Line {
  readonly number: number;
  readonly text: string;
  readonly start: number;
  // after the line's break
  readonly next: number;
}

function linesOf(text: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  let number = 1;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code !== 10 && code !== 13) continue;
    const next = code === 13 && text.charCodeAt(index + 1) === 10 ? index + 2 : index + 1;
    lines.push({ number: number++, text: text.slice(start, index), start, next });
    start = next;
    index = next - 1;
  }
  lines.push({ number, text: text.slice(start), start, next: text.length });
  return lines;
}

/** Whether the text holds both a start and an end marker, before any scan (containsConflict). */
export function containsConflict(text: string): boolean {
  return text.includes(START) && text.includes(END);
}

// prefix: the marker's length; its name follows after one space
function block(marker: Line, nextMarker: Line, prefix: number): ConflictBlock {
  return {
    headerLine: marker.number,
    contentStart: marker.next,
    contentEnd: nextMarker.start,
    firstLine: marker.number + 1,
    lineCount: nextMarker.number - marker.number - 1,
    name: marker.text.slice(prefix + 1),
  };
}

/**
 * Every complete conflict in the text, in order (scanDocument): a second start before an end stops the scan, and a block
 * without a splitter is skipped. Empty and whitespace-only lines are never markers.
 */
export function parseConflicts(text: string): Conflict[] {
  if (!containsConflict(text)) return [];
  const conflicts: Conflict[] = [];
  let scan: { start: Line; size: number; ancestors: Line[]; splitter?: Line } | null = null;
  for (const line of linesOf(text)) {
    if (line.text.trim() === '') continue;
    const opening = runOf(line.text, '<');
    if (opening >= MARKER_SIZE) {
      if (scan !== null) break;
      scan = { start: line, size: opening, ancestors: [] };
    } else if (scan && !scan.splitter && runOf(line.text, '|') === scan.size) {
      scan.ancestors.push(line);
    } else if (scan && !scan.splitter && line.text === '='.repeat(scan.size)) {
      scan.splitter = line;
    } else if (scan && runOf(line.text, '>') === scan.size) {
      if (scan.splitter) {
        const afterCurrent = scan.ancestors[0] ?? scan.splitter;
        const size = scan.size;
        conflicts.push({
          current: block(scan.start, afterCurrent, size),
          commonAncestors: scan.ancestors.map((marker, index) => block(marker, scan!.ancestors[index + 1] ?? scan!.splitter!, size)),
          splitterLine: scan.splitter.number,
          incoming: { ...block(scan.splitter, line, 0), headerLine: line.number, name: line.text.slice(size + 1) },
          start: scan.start.start,
          end: line.next,
          startLine: scan.start.number,
          endLine: line.number,
        });
      }
      scan = null;
    }
  }
  return conflicts;
}

export type ConflictChoice = 'current' | 'incoming' | 'both';

/**
 * The text that replaces a conflict when one side is taken (DocumentMergeConflict.applyEdit): a side that is only a line break
 * leaves nothing, and Both is current then incoming.
 */
export function conflictReplacement(text: string, conflict: Conflict, choice: ConflictChoice): string {
  const current = text.slice(conflict.current.contentStart, conflict.current.contentEnd);
  const incoming = text.slice(conflict.incoming.contentStart, conflict.incoming.contentEnd);
  if (choice === 'both') return current + incoming;
  const content = choice === 'current' ? current : incoming;
  return content === '\n' || content === '\r\n' ? '' : content;
}

/** The text with every conflict resolved the same way, as Accept All Current or Accept All Incoming leave a buffer. */
export function resolveAll(text: string, choice: ConflictChoice): string {
  let out = '';
  let at = 0;
  for (const conflict of parseConflicts(text)) {
    out += text.slice(at, conflict.start) + conflictReplacement(text, conflict, choice);
    at = conflict.end;
  }
  return out + text.slice(at);
}
