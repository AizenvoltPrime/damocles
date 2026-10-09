import type { IBufferCell, IBufferLine, IBufferRange } from '@xterm/xterm';
import { MAX_TERMINAL_LINK_PATH_LENGTH, MAX_TERMINAL_LINK_PATHS, MAX_TERMINAL_LINK_POSITION, type TerminalLinkKind } from '../../preload/terminal-channels';
import { detectLinks, type LinkOs } from './terminal-link-parsing';

// VS Code's terminalLocalLinkDetector.ts bounds: a longer wrapped line is not searched, and at most this many of its parsed
// links are resolved.
export const MAX_LINK_LINE_LENGTH = 2000;
export const MAX_LINKS_PER_LINE = 10;

// Paths with spaces that the parser cannot see, tried only when no parsed link resolves (terminalLocalLinkDetector.ts).
const FALLBACK_MATCHERS: readonly RegExp[] = [
  // Python: File "<path>", line <line>
  /^ *File (?<link>"(?<path>.+)"(, line (?<line>\d+))?)/,
  // FILE  <path>:<line>:<col>
  /^ +FILE +(?<link>(?<path>.+)(?::(?<line>\d+)(?::(?<col>\d+))?)?)/,
  // MSVC and CUDA: C:\foo\bar baz(339) : error, C:\foo\bar baz(339, 12): error
  /^(?<link>(?<path>.+)\((?<line>\d+)(?:, ?(?<col>\d+))?\)) ?:/,
  // Clang: C:\foo/bar baz:339:12: error
  /^(?<link>(?<path>.+):(?<line>\d+)(?::(?<col>\d+))?) ?:/,
  // PowerShell and cmd prompts
  /^(?:PS\s+)?(?<link>(?<path>[^>]+))>/,
  // the whole line
  /^ *(?<link>(?<path>.+))/,
];

// xterm's addon-web-links URL pattern; only http and https open (main's window-open handler allows no other scheme).
const URL_PATTERN = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
const TRAILING_SPECIAL = /[[\]"'.]$/;

/** A wrapped line's text with each UTF-16 unit's cell, so a match in the text maps back to buffer cells. */
export interface LineText {
  readonly text: string;
  // per UTF-16 unit: 1-based buffer x and y, and the cell's width
  readonly cells: ReadonlyArray<{ readonly x: number; readonly y: number; readonly width: number }>;
}

export interface LinkLines {
  getLine(y: number): Pick<IBufferLine, 'isWrapped' | 'getCell'> | undefined;
}

/**
 * The text of the wrapped line holding buffer row `y` (0-based), searched at most MAX_LINK_LINE_LENGTH characters either way
 * as VS Code's detector adapter does, with the trailing blanks of its last row cut.
 */
export function readWrappedLine(lines: LinkLines, y: number, cols: number, cell: IBufferCell): LineText {
  const reach = Math.ceil(MAX_LINK_LINE_LENGTH / cols);
  let start = y;
  while (start > 0 && y - start < reach && lines.getLine(start)?.isWrapped) start -= 1;
  let end = y;
  while (end - y < reach && lines.getLine(end + 1)?.isWrapped) end += 1;
  let text = '';
  const cells: Array<{ x: number; y: number; width: number }> = [];
  for (let row = start; row <= end; row++) {
    const line = lines.getLine(row);
    if (!line) break;
    for (let x = 0; x < cols; x++) {
      const current = line.getCell(x, cell);
      if (!current) break;
      const width = current.getWidth();
      // the right half of a wide character
      if (width === 0) continue;
      const chars = current.getChars() || ' ';
      text += chars;
      for (let unit = 0; unit < chars.length; unit++) cells.push({ x: x + 1, y: row + 1, width });
    }
  }
  const trimmed = text.trimEnd();
  return { text: trimmed, cells: cells.slice(0, trimmed.length) };
}

/** The buffer range of text[start, end): 1-based, its end the last cell inclusive, as xterm's ILink takes it. */
export function rangeOf(line: LineText, start: number, end: number): IBufferRange | undefined {
  const first = line.cells[start];
  const last = line.cells[end - 1];
  if (!first || !last || end <= start) return undefined;
  return { start: { x: first.x, y: first.y }, end: { x: last.x + last.width - 1, y: last.y } };
}

const position = (value: number | undefined): number | null => (value !== undefined && value >= 1 && value <= MAX_TERMINAL_LINK_POSITION ? value : null);

export interface LinkCandidate {
  // the paths main is asked about for this link, in preference order
  readonly paths: readonly string[];
  // text[start, end) is underlined; trimmed is how many characters to drop from its end per path, when a variant without
  // trailing punctuation is the one that resolves
  readonly start: number;
  readonly end: number;
  readonly trimmed: ReadonlyMap<string, number>;
  readonly line: number | null;
  readonly column: number | null;
}

export interface LineCandidates {
  readonly web: ReadonlyArray<{ readonly start: number; readonly end: number; readonly url: string }>;
  readonly parsed: readonly LinkCandidate[];
  readonly fallback: readonly LinkCandidate[];
}

function webLinks(text: string): Array<{ start: number; end: number; url: string }> {
  return [...text.matchAll(URL_PATTERN)].flatMap((match) => {
    const url = match[0];
    const parsed = URL.parse(url);
    // As addon-web-links checks: a URL the parser accepts as http or https.
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) return [];
    return [{ start: match.index, end: match.index + url.length, url }];
  });
}

/** The variants of a path without trailing brackets, quotes and dots, each with how far the underline shrinks for it. */
function withoutTrailing(path: string, suffixed: boolean): { paths: string[]; trimmed: Map<string, number> } {
  const paths = [path];
  const trimmed = new Map<string, number>();
  let previous = path;
  let removed = previous.replace(TRAILING_SPECIAL, '');
  let cut = 0;
  while (removed !== previous && removed !== '') {
    // With a suffix the underline already ends at the suffix, so it keeps its length.
    if (!suffixed) cut += 1;
    paths.push(removed);
    trimmed.set(removed, cut);
    previous = removed;
    removed = removed.replace(TRAILING_SPECIAL, '');
  }
  return { paths, trimmed };
}

/**
 * The link candidates in one wrapped line: web links, the parser's paths (at most MAX_LINKS_PER_LINE, none overlapping a
 * web link), and VS Code's fallback matches for paths with spaces. Paths over MAX_TERMINAL_LINK_PATH_LENGTH are dropped.
 */
export function lineCandidates(text: string, os: LinkOs): LineCandidates {
  if (text === '' || text.length > MAX_LINK_LINE_LENGTH) return { web: [], parsed: [], fallback: [] };
  const web = webLinks(text);
  const inWeb = (start: number, end: number): boolean => web.some((link) => start < link.end && end > link.start);
  const parsed: LinkCandidate[] = [];
  for (const link of detectLinks(text, os)) {
    if (parsed.length >= MAX_LINKS_PER_LINE) break;
    const start = link.prefix?.index ?? link.path.index;
    const end = link.suffix ? link.suffix.suffix.index + link.suffix.suffix.text.length : link.path.index + link.path.text.length;
    if (link.path.text.length > MAX_TERMINAL_LINK_PATH_LENGTH || inWeb(start, end)) continue;
    const { paths, trimmed } = withoutTrailing(link.path.text, link.suffix !== undefined);
    parsed.push({ paths, start, end, trimmed, line: position(link.suffix?.row), column: position(link.suffix?.col) });
  }
  const fallback: LinkCandidate[] = [];
  for (const matcher of FALLBACK_MATCHERS) {
    const groups = matcher.exec(text)?.groups;
    const linkText = groups?.link;
    const path = groups?.path;
    if (!linkText || !path || linkText.length > MAX_TERMINAL_LINK_PATH_LENGTH) continue;
    const start = text.indexOf(linkText);
    if (inWeb(start, start + linkText.length)) continue;
    const number = (value: string | undefined): number | null => (value === undefined ? null : position(Number.parseInt(value, 10)));
    fallback.push({ paths: [path], start, end: start + linkText.length, trimmed: new Map(), line: number(groups.line), column: number(groups.col) });
  }
  return { web, parsed, fallback };
}

/** Every distinct path the candidates ask about, parsed ones first, bounded by MAX_TERMINAL_LINK_PATHS. */
export function requestPaths(candidates: LineCandidates): string[] {
  const paths = new Set<string>();
  for (const candidate of [...candidates.parsed, ...candidates.fallback]) {
    for (const path of candidate.paths) {
      if (paths.size >= MAX_TERMINAL_LINK_PATHS) return [...paths];
      if (path.length >= 1 && path.length <= MAX_TERMINAL_LINK_PATH_LENGTH && !path.includes('\0')) paths.add(path);
    }
  }
  return [...paths];
}

export interface ResolvedLink {
  readonly kind: TerminalLinkKind;
  readonly path: string;
  readonly start: number;
  readonly end: number;
  readonly line: number | null;
  readonly column: number | null;
}

/**
 * The confirmed links from main's answers: each parsed candidate's first path that resolved, with its underline shortened
 * by any trailing characters that variant drops; the fallback matches count only when no parsed candidate resolved.
 */
export function confirmedLinks(candidates: LineCandidates, paths: readonly string[], kinds: ReadonlyArray<TerminalLinkKind | null>): ResolvedLink[] {
  const kindOf = new Map(paths.map((path, index) => [path, kinds[index] ?? null] as const));
  const confirm = (list: readonly LinkCandidate[]): ResolvedLink[] => list.flatMap((candidate) => {
    const path = candidate.paths.find((variant) => kindOf.get(variant));
    const kind = path === undefined ? undefined : kindOf.get(path);
    if (path === undefined || !kind) return [];
    return [{ kind, path, start: candidate.start, end: candidate.end - (candidate.trimmed.get(path) ?? 0), line: candidate.line, column: candidate.column }];
  });
  const parsed = confirm(candidates.parsed);
  return parsed.length > 0 ? parsed : confirm(candidates.fallback);
}
