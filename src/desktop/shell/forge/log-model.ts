import type { CiColor, CiLogRow, CiLogSection, CiLogSpan } from '@shared/forge/ci-log';

/**
 * The rows a job log shows with its folded sections collapsed: indexes into rows, ascending. A folded section's header stays
 * and the rest of the section (to its end, or the log's end while it is open) is skipped, in one pass over what shows.
 */
export function visibleRowIndexes(rows: readonly CiLogRow[], sections: ReadonlyMap<number, CiLogSection>, folded: ReadonlySet<number>): number[] {
  const shown: number[] = [];
  for (let index = 0; index < rows.length; index++) {
    shown.push(index);
    const header = rows[index]!.header;
    if (header === undefined || !folded.has(header)) continue;
    const end = sections.get(header)?.endRow;
    index = end === undefined ? rows.length : Math.max(index, end);
  }
  return shown;
}

/** The lines a folded section hides: everything after its header, to its end or the log's end while it is open. */
export const hiddenLines = (section: CiLogSection, rowCount: number): number => (section.endRow ?? rowCount - 1) - section.headerRow;

/** Where row sits in the ascending visible indexes, or -1 when a fold hides it. */
export function visibleIndexOf(visible: readonly number[], row: number): number {
  let low = 0;
  let high = visible.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const value = visible[mid]!;
    if (value === row) return mid;
    if (value < row) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/** The sections holding row, innermost first: what Find unfolds to show a match. */
export function sectionsAround(row: CiLogRow, sections: ReadonlyMap<number, CiLogSection>): number[] {
  const around: number[] = [];
  for (let id = row.section; id !== undefined; id = sections.get(id)?.parent) {
    // a header row's own section folds below it, so only its parents hide it
    if (id !== row.header) around.push(id);
  }
  return around;
}

/** A colour as CSS: the 16 terminal colours from the theme's --d-ansi-* tokens; the parser sends 16-255 and truecolor as rgb. */
export function ciColor(color: CiColor): string {
  return 'rgb' in color ? `rgb(${color.rgb[0]} ${color.rgb[1]} ${color.rgb[2]})` : `var(--d-ansi-${color.palette})`;
}

export function spanStyle(span: CiLogSpan): Record<string, string> | undefined {
  const fg = span.fg && ciColor(span.fg);
  const bg = span.bg && ciColor(span.bg);
  if (span.inverse) return { color: bg ?? 'var(--d-bg)', backgroundColor: fg ?? 'var(--d-text)' };
  if (!fg && !bg) return undefined;
  return { ...(fg ? { color: fg } : {}), ...(bg ? { backgroundColor: bg } : {}) };
}

export function spanClass(span: CiLogSpan): string {
  return [span.bold ? 'font-semibold' : '', span.dim ? 'opacity-60' : '', span.italic ? 'italic' : '', span.underline ? 'underline' : ''].filter(Boolean).join(' ');
}

/** A piece of a row as it renders: a span's text, cut where a Find match starts or ends and around each direction control. */
export interface RowPiece {
  readonly text: string;
  readonly span: CiLogSpan;
  readonly mark?: 'match' | 'current';
  /** The piece is one direction control, shown by its name instead of acting on the text around it. */
  readonly control?: { readonly name: string; readonly code: string };
}

// rendered by name, never as the character, so a log cannot reorder the text the reader sees
const DIRECTION_CONTROLS: ReadonlyMap<number, string> = new Map([
  [0x061c, 'ALM'],
  [0x200e, 'LRM'],
  [0x200f, 'RLM'],
  [0x202a, 'LRE'],
  [0x202b, 'RLE'],
  [0x202c, 'PDF'],
  [0x202d, 'LRO'],
  [0x202e, 'RLO'],
  [0x2066, 'LRI'],
  [0x2067, 'RLI'],
  [0x2068, 'FSI'],
  [0x2069, 'PDI'],
]);

function pushPieces(pieces: RowPiece[], text: string, span: CiLogSpan, mark: 'match' | 'current' | undefined): void {
  const marked = mark === undefined ? {} : { mark };
  let start = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    const name = code === 0x061c || (code >= 0x200e && code <= 0x2069) ? DIRECTION_CONTROLS.get(code) : undefined;
    if (name === undefined) continue;
    if (at > start) pieces.push({ text: text.slice(start, at), span, ...marked });
    pieces.push({ text: text[at]!, span, ...marked, control: { name, code: `U+${code.toString(16).toUpperCase().padStart(4, '0')}` } });
    start = at + 1;
  }
  if (start < text.length) pieces.push({ text: start === 0 ? text : text.slice(start), span, ...marked });
}

/** A row's spans cut at its matches' edges; ranges are [start, end) into the row's plain text, ascending and apart. */
export function rowPieces(spans: readonly CiLogSpan[], ranges: readonly { readonly start: number; readonly end: number; readonly current: boolean }[]): RowPiece[] {
  const pieces: RowPiece[] = [];
  let offset = 0;
  let next = 0;
  for (const span of spans) {
    const spanEnd = offset + span.text.length;
    let at = offset;
    while (at < spanEnd) {
      while (next < ranges.length && ranges[next]!.end <= at) next++;
      const range = ranges[next];
      if (!range || range.start >= spanEnd) {
        pushPieces(pieces, span.text.slice(at - offset), span, undefined);
        break;
      }
      if (range.start > at) {
        pushPieces(pieces, span.text.slice(at - offset, range.start - offset), span, undefined);
        at = range.start;
      }
      const cut = Math.min(range.end, spanEnd);
      pushPieces(pieces, span.text.slice(at - offset, cut - offset), span, range.current ? 'current' : 'match');
      at = cut;
    }
    offset = spanEnd;
  }
  return pieces;
}

/** A row's time as the timestamp column shows it: an ISO stamp at the viewer's clock, any other stamp as the log wrote it. */
export function stampText(stamp: string, format: Intl.DateTimeFormat): string {
  const time = Date.parse(stamp);
  return Number.isNaN(time) ? stamp : format.format(time);
}
