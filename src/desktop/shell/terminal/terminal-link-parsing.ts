// Adapted from VS Code's terminalLinkParsing.ts (MIT, see THIRD-PARTY-NOTICES.md): finds path-like text and its line and column
// suffix in one line of terminal output, with no filesystem access; main decides which candidates are links.

export type LinkOs = 'windows' | 'posix';

export interface LinkRange {
  // UTF-16 index into the line
  readonly index: number;
  readonly text: string;
}

export interface LinkSuffix {
  readonly row: number | undefined;
  readonly col: number | undefined;
  readonly rowEnd: number | undefined;
  readonly colEnd: number | undefined;
  readonly suffix: LinkRange;
}

export interface ParsedLink {
  readonly path: LinkRange;
  // quotes before the path, underlined with it but not part of it
  readonly prefix: LinkRange | undefined;
  readonly suffix: LinkSuffix | undefined;
}

/**
 * The suffix clauses, each with its own numbered groups since a regex cannot repeat a group name. Every clause also takes '
 * for " and [] for (). Legend: path foo, row 339, col 12, rowEnd 341, colEnd 789.
 */
function suffixRegex(atEnd: boolean): RegExp {
  let rows = 0;
  let cols = 0;
  let rowEnds = 0;
  let colEnds = 0;
  const r = (): string => `(?<row${rows++}>\\d+)`;
  const c = (): string => `(?<col${cols++}>\\d+)`;
  const re = (): string => `(?<rowEnd${rowEnds++}>\\d+)`;
  const ce = (): string => `(?<colEnd${colEnds++}>\\d+)`;
  const clauses = [
    // foo:339  foo:339:12  foo:339:12-789  foo:339.12-341.789  foo 339  foo#339:12  foo, 339  "foo",339.12
    `(?::|#| |['"],|, )${r()}([:.]${c()}(?:-(?:${re()}\\.)?${ce()})?)?`,
    // "foo", line 339, col 12  "foo":line 339  "foo" on line 339, column 12  "foo" line 339 column 12
    // "foo", line 339, characters 12-789  "foo", lines 339-341  (the quotes are optional)
    `['"]?(?:,? |: ?| on )lines? ${r()}(?:-${re()})?(?:,? (?:col(?:umn)?|characters?) ${c()}(?:-${ce()})?)?`,
    // foo(339)  foo(339,12)  foo (339, 12)  foo: (339)  foo(339:12)
    `:? ?[\\[\\(]${r()}(?:(?:, ?|:)${c()})?[\\]\\)]`,
  ];
  // Spaces also match a non-breaking space, which some tools print between a path and its line.
  const source = clauses.map((clause) => (atEnd ? `${clause}$` : clause)).join('|').replace(/ /g, '[\u00A0 ]');
  return new RegExp(`(${source})`, atEnd ? undefined : 'g');
}

const SUFFIX_AT_END = suffixRegex(true);

function toSuffix(match: RegExpExecArray | null): LinkSuffix | undefined {
  const groups = match?.groups;
  if (!match || !groups) return undefined;
  const number = (...names: string[]): number | undefined => {
    const value = names.map((name) => groups[name]).find((group) => group !== undefined && group !== '');
    return value === undefined ? undefined : Number.parseInt(value, 10);
  };
  return {
    row: number('row0', 'row1', 'row2'),
    col: number('col0', 'col1', 'col2'),
    rowEnd: number('rowEnd0', 'rowEnd1', 'rowEnd2'),
    colEnd: number('colEnd0', 'colEnd1', 'colEnd2'),
    suffix: { index: match.index, text: match[0] },
  };
}

/** The line and column suffix that ends `link`, if it has one. */
export function getLinkSuffix(link: string): LinkSuffix | undefined {
  return toSuffix(SUFFIX_AT_END.exec(link));
}

/** `link` without its line and column suffix. */
export function removeLinkSuffix(link: string): string {
  const suffix = getLinkSuffix(link)?.suffix;
  return suffix ? link.slice(0, suffix.index) : link;
}

/** `link` without a query string; the ? of a `\\?\` long path is not one. */
export function removeLinkQueryString(link: string): string {
  const index = link.indexOf('?', link.startsWith('\\\\?\\') ? 4 : 0);
  return index === -1 ? link : link.slice(0, index);
}

/** Every line and column suffix in `line`, left to right and never overlapping. */
export function detectLinkSuffixes(line: string): LinkSuffix[] {
  const regex = suffixRegex(false);
  const results: LinkSuffix[] = [];
  for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
    const suffix = toSuffix(match);
    if (!suffix) break;
    results.push(suffix);
  }
  return results;
}

// What a path before a suffix may not contain, and what it may not start with.
const PATH_SEPARATOR = /[\s|<>]/;
const PATH_BAD_START = /[[({]/;

// Terminal output is hostile, so the path before each suffix is found by scanning the line once, never by a regex anchored
// only at its end, which backtracks over every start position.
function detectLinksViaSuffix(line: string): ParsedLink[] {
  const results: ParsedLink[] = [];
  let scanned = 0;
  let afterSeparator = 0;
  for (const suffix of detectLinkSuffixes(line)) {
    const end = suffix.suffix.index;
    for (; scanned < end; scanned++) if (PATH_SEPARATOR.test(line[scanned]!)) afterSeparator = scanned + 1;
    // A number followed by a slash is a Git diff prefix such as `1/`, read as part of a path instead.
    if (line[end + suffix.suffix.text.length] === '/') continue;
    let start = afterSeparator;
    while (start < end && PATH_BAD_START.test(line[start]!)) start++;
    if (start === end) continue;
    let path = line.slice(start, end);
    let prefix: LinkRange | undefined;
    const quotes = /^['"]+/.exec(path)?.[0];
    if (quotes) {
      prefix = { index: start, text: quotes };
      path = path.slice(quotes.length);
      if (path.trim().length === 0) continue;
      // `echo "'foo' on line 1"`: of several quotes, only the one the suffix closes is the prefix.
      const last = quotes[quotes.length - 1]!;
      if (quotes.length > 1 && /['"]/.test(suffix.suffix.text[0] ?? '') && suffix.suffix.text[0] === last) {
        const trim = quotes.length - 1;
        prefix = { index: prefix.index + trim, text: last };
        start += trim;
      }
    }
    const pathIndex = start + (prefix?.text.length ?? 0);
    results.push({ path: { index: pathIndex, text: path }, prefix, suffix });
    // `notlink[foo:45]`: the text after each unclosed opening bracket is a candidate too.
    for (const bracket of path.matchAll(/[[(](?![\])])/g)) {
      results.push({ path: { index: pathIndex + bracket.index + 1, text: path.slice(bracket.index + 1) }, prefix, suffix });
    }
  }
  return results;
}

// '":; are allowed in paths but are usually separators; a backslash in a POSIX path is excluded to rule out catastrophic
// backtracking (VS Code #24795).
const POSIX_PATH_PREFIX = '(?:\\.\\.?|\\~|file://)';
const POSIX_EXCLUDED = '[^\\0<>\\?\\s!`&*()\'":;\\\\]';
const POSIX_EXCLUDED_START = '[^\\0<>\\?\\s!`&*()\\[\\]\'":;\\\\]';
const WIN_DRIVE_PREFIX = '(?:\\\\\\\\\\?\\\\|file:\\/\\/\\/)?[a-zA-Z]:';
const WIN_OTHER_PREFIX = '\\.\\.?|\\~';
const WIN_SEPARATOR = '(?:\\\\|\\/)';
const WIN_EXCLUDED = '[^\\0<>\\?\\|\\/\\s!`&*()\'":;]';
const WIN_EXCLUDED_START = '[^\\0<>\\?\\|\\/\\s!`&*()\\[\\]\'":;]';

// `/foo`, `~/foo`, `./foo`, `../foo`, `foo/bar`
const POSIX_PATH = `(?:(?:${POSIX_PATH_PREFIX}|(?:${POSIX_EXCLUDED_START}${POSIX_EXCLUDED}*))?(?:\\/(?:${POSIX_EXCLUDED})+)+)`;
// `\\?\c:\foo`, `c:\foo`, `~\foo`, `.\foo`, `..\foo`, `foo\bar`, and the same with forward slashes
const WIN_PATH = `(?:(?:(?:${WIN_DRIVE_PREFIX}|${WIN_OTHER_PREFIX})|(?:${WIN_EXCLUDED_START}${WIN_EXCLUDED}*))?(?:${WIN_SEPARATOR}(?:${WIN_EXCLUDED})+)+)`;

// Git's one-letter diff prefixes (a/ b/, the mnemonic c/ i/ o/ w/, and 1/ 2/ of `git diff --no-index`).
const DIFF_PREFIX = '[abciow12]\\/';
const DIFF_LINE = new RegExp(`^[-+]{3} ${DIFF_PREFIX}`);
const DIFF_TEXT = new RegExp(`^${DIFF_PREFIX}`);

function detectPathsNoSuffix(line: string, os: LinkOs): ParsedLink[] {
  const regex = new RegExp(os === 'windows' ? WIN_PATH : POSIX_PATH, 'g');
  const results: ParsedLink[] = [];
  for (let match = regex.exec(line); match !== null; match = regex.exec(line)) {
    let text = match[0];
    let index = match.index;
    if (!text) break;
    // `--- a/foo/bar`, `+++ b/foo/bar` and `diff --git a/foo/bar b/foo/bar` name foo/bar.
    if ((index === 4 && DIFF_LINE.test(line)) || (line.startsWith('diff --git') && DIFF_TEXT.test(text))) {
      text = text.slice(2);
      index += 2;
    }
    results.push({ path: { index, text }, prefix: undefined, suffix: undefined });
  }
  return results;
}

const pathEnd = (link: ParsedLink): number => link.path.index + link.path.text.length;

/** Inserts `link` in index order unless its path overlaps or touches one already there; suffixed links were placed first. */
function insertIfFree(links: ParsedLink[], link: ParsedLink): void {
  const at = links.findIndex((other) => other.path.index > link.path.index);
  const before = at === -1 ? links[links.length - 1] : links[at - 1];
  const after = at === -1 ? undefined : links[at];
  if (before && link.path.index <= pathEnd(before)) return;
  if (after && pathEnd(link) >= after.path.index) return;
  links.splice(at === -1 ? links.length : at, 0, link);
}

/** The links in `line`: those with a line and column suffix, then suffix-less paths that do not overlap them. */
export function detectLinks(line: string, os: LinkOs): ParsedLink[] {
  const results = detectLinksViaSuffix(line);
  for (const link of detectPathsNoSuffix(line, os)) insertIfFree(results, link);
  return results;
}
