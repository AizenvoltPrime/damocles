// Text search shapes and the pure rules main's search and replace share with the desktop shell's buffer replace.

export const MAX_SEARCH_PATTERN_LENGTH = 2000;
// Characters of one comma-separated include or exclude list.
export const MAX_SEARCH_GLOBS_LENGTH = 4000;
export const MAX_REPLACEMENT_LENGTH = 2000;
// VS Code's search.maxResults.
export const MAX_SEARCH_RESULTS = 20_000;
export const SEARCH_PREVIEW_CHARS = 250;
// Characters a preview keeps before the match: VS Code's charsPerLine / 5.
const PREVIEW_LEADING_CHARS = 50;

export interface SearchQuery {
  readonly pattern: string;
  readonly isRegex: boolean;
  readonly matchCase: boolean;
  readonly wholeWord: boolean;
  // comma-separated globs
  readonly include: string;
  readonly exclude: string;
  readonly useExcludeSettingsAndIgnoreFiles: boolean;
  // only the open editors' buffers: the selected project's text documents and untitled tabs
  readonly onlyOpenEditors: boolean;
}

// VS Code's HistoryNavigator limit, per input.
export const MAX_SEARCH_HISTORY = 100;
// Search Editor context lines around each match.
export const MAX_CONTEXT_LINES = 100;

export type SearchPattern = Pick<SearchQuery, 'pattern' | 'isRegex' | 'matchCase' | 'wholeWord'>;

// 1-based, UTF-16 columns (Monaco's IRange)
export interface SearchRange {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

// text: at most SEARCH_PREVIEW_CHARS of the match's first line; offsets are UTF-16 into text
export interface SearchPreview {
  readonly text: string;
  readonly matchStart: number;
  readonly matchEnd: number;
}

export interface SearchMatch {
  // issued by main, unique within its search
  readonly id: number;
  readonly range: SearchRange;
  readonly preview: SearchPreview;
}

// A project file, or an untitled buffer, which has no path and is never addressed by one.
export type SearchFileResult =
  | {
      readonly kind: 'file';
      // '/'-separated, relative to the shown folder
      readonly relativePath: string;
      readonly matches: readonly SearchMatch[];
      // the matches came from this open document's buffer
      readonly documentId?: string;
      // only while the sort order is 'modified'
      readonly mtimeMs?: number;
    }
  | { readonly kind: 'untitled'; readonly documentId: string; readonly title: string; readonly matches: readonly SearchMatch[] };

export type SearchFileKey = { readonly kind: 'file'; readonly relativePath: string } | { readonly kind: 'untitled'; readonly documentId: string };

export function searchFileKey(file: SearchFileResult): SearchFileKey {
  return file.kind === 'file' ? { kind: 'file', relativePath: file.relativePath } : { kind: 'untitled', documentId: file.documentId };
}

function escapeRegExpCharacters(value: string): string {
  return value.replace(/[\\{}*+?|^$.[\]()]/g, '\\$&');
}

// ripgrep's -w: no word character on either side of the match, whatever its own ends are. A word character is the Unicode
// \w of ripgrep's default engine (UTS #18 Annex C), which JavaScript's \b, ASCII-only even with the u flag, is not.
const WORD_CHARACTER = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';

/**
 * The query as a sticky JavaScript RegExp (unicode, `i` unless Match Case, a whole word bounded as ripgrep -w bounds it), with
 * `m` because ripgrep anchors `^` and `$` at lines. Throws a SyntaxError for a pattern JavaScript cannot compile.
 */
export function searchRegExp(query: SearchPattern): RegExp {
  const source = query.isRegex ? query.pattern : escapeRegExpCharacters(query.pattern);
  const bounded = query.wholeWord ? `(?<!${WORD_CHARACTER})(?:${source})(?!${WORD_CHARACTER})` : source;
  return new RegExp(bounded, `${query.matchCase ? '' : 'i'}muy`);
}

/**
 * The query as ripgrep, the open buffers and replace match it: a text query holding a line break searches as an escaped regex
 * across lines (VS Code's queryBuilder isMultiline), and every line break a regex names also matches '\r\n' (crlfLineBreaks).
 */
export function matchingPattern<T extends SearchPattern>(query: T): T {
  if (!query.isRegex && !query.pattern.includes('\n')) return query;
  const pattern = crlfLineBreaks(query.isRegex ? query.pattern : escapeRegExpCharacters(query.pattern));
  return pattern === query.pattern && query.isRegex ? query : { ...query, isRegex: true, pattern };
}

const isLineBreak = (token: string): boolean => token === '\\n' || token === '\n';

// *, +, ?, {n}, {n,} or {n,m}, at lastIndex.
const QUANTIFIER = /[*+?]|\{\d+(?:,\d*)?\}/y;

function quantifiedAt(pattern: string, index: number): boolean {
  QUANTIFIER.lastIndex = index;
  return QUANTIFIER.test(pattern);
}

// A class's members, read in ripgrep's dialect: a leading ']' is a member, '[' opens a nested or POSIX class.
function characterClassAt(pattern: string, start: number): { readonly end: number; readonly negated: boolean; readonly members: string[]; readonly simple: boolean } {
  let index = start + 1;
  const negated = pattern[index] === '^';
  if (negated) index++;
  const members: string[] = [];
  let simple = pattern[index] !== ']';
  if (!simple) members.push(pattern[index++]!);
  let depth = 1;
  while (index < pattern.length) {
    const char = pattern[index]!;
    if (char === ']' && --depth === 0) break;
    if (char === '[' || (char === '&' && pattern[index + 1] === '&')) simple = false;
    if (char === '[') depth++;
    const token = char === '\\' ? pattern.slice(index, index + 2) : char;
    members.push(token);
    index += token.length;
  }
  return { end: Math.min(index + 1, pattern.length), negated, members, simple: simple && index < pattern.length };
}

// The class at start, rewritten so a line break it admits also matches '\r\n' and one it excludes also excludes that '\r'.
function crlfCharacterClass(pattern: string, start: number): { readonly end: number; readonly text: string } {
  const { end, negated, members, simple } = characterClassAt(pattern, start);
  const written = pattern.slice(start, end);
  const breaks = members.flatMap((member, index) => (isLineBreak(member) ? [index] : []));
  const inRange = breaks.some((index) => (index >= 2 && members[index - 1] === '-') || (index + 2 < members.length && members[index + 1] === '-'));
  if (!simple || breaks.length === 0 || inRange) return { end, text: written };
  if (negated) return { end, text: `(?:(?!\\r\\n)${written})` };
  const others = members.filter((member) => !isLineBreak(member)).join('');
  if (others === '') return { end, text: quantifiedAt(pattern, end) ? '(?:\\r?\\n)' : '\\r?\\n' };
  return { end, text: `(?:[${others.startsWith('^') ? '\\' : ''}${others}]|\\r?\\n)` };
}

// VS Code's fixRegexNewline and fixNewline (src/vs/workbench/services/search/node/ripgrepTextSearchEngine.ts).
// ripgrep's --crlf moves only `$`, so a line break the regex names, as `\n` or a newline character, must also match '\r\n'.
// A rewritten lookbehind has a variable length, which needs PCRE2 10.43 or later; the bundled ripgrep has it.
function crlfLineBreaks(pattern: string): string {
  let out = '';
  for (let index = 0; index < pattern.length;) {
    if (pattern[index] === '[') {
      const { end, text } = crlfCharacterClass(pattern, index);
      out += text;
      index = end;
      continue;
    }
    const token = pattern[index] === '\\' ? pattern.slice(index, index + 2) : pattern[index]!;
    index += token.length;
    out += isLineBreak(token) ? (quantifiedAt(pattern, index) ? '(?:\\r?\\n)' : '\\r?\\n') : token;
  }
  return out;
}

/** searchRegExp for a replace, or undefined when JavaScript cannot compile a pattern ripgrep's engine took. */
export function replaceRegExp(query: SearchPattern): RegExp | undefined {
  try {
    return searchRegExp(query);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

// VS Code's containsUppercaseCharacter.
function containsUppercaseCharacter(target: string, ignoreEscapedChars: boolean): boolean {
  if (!target) return false;
  const text = ignoreEscapedChars ? target.replace(/\\./g, '') : target;
  return text.toLowerCase() !== text;
}

/** VS Code's smart case (queryBuilder isCaseSensitive): a pattern with an uppercase letter (unescaped, for a regex) matches case. */
export function withSmartCase<T extends SearchPattern>(query: T, smartCase: boolean): T {
  if (!smartCase || query.matchCase || !containsUppercaseCharacter(query.pattern, query.isRegex)) return query;
  return { ...query, matchCase: true };
}

function casePreservedFor(matches: readonly string[], pattern: string, separator: '-' | '_'): boolean {
  return matches[0]!.includes(separator) && pattern.includes(separator) && matches[0]!.split(separator).length === pattern.split(separator).length;
}

/** VS Code's buildReplaceStringWithCasePreserved (src/vs/base/common/search.ts): `pattern` in the case of the match `matches[0]`. */
export function buildReplaceStringWithCasePreserved(matches: readonly string[] | null, pattern: string): string {
  if (!matches || matches[0] === '') return pattern;
  const matched = matches[0]!;
  const hyphens = casePreservedFor(matches, pattern, '-');
  const underscores = casePreservedFor(matches, pattern, '_');
  if (hyphens !== underscores) {
    const separator = hyphens ? '-' : '_';
    const parts = matched.split(separator);
    return pattern.split(separator).map((part, index) => buildReplaceStringWithCasePreserved([parts[index]!], part)).join(separator);
  }
  if (matched.toUpperCase() === matched) return pattern.toUpperCase();
  if (matched.toLowerCase() === matched) return pattern.toLowerCase();
  if (containsUppercaseCharacter(matched[0]!, false) && pattern.length > 0) return pattern[0]!.toUpperCase() + pattern.slice(1);
  if (matched[0]!.toUpperCase() !== matched[0] && pattern.length > 0) return pattern[0]!.toLowerCase() + pattern.slice(1);
  return pattern;
}

/** VS Code's isMultilineRegexSource: a regex that can match a line break searches across lines. */
export function isMultilineRegexSource(pattern: string): boolean {
  for (let i = 0; i < pattern.length; i++) {
    const code = pattern[i];
    if (code === '\n') return true;
    if (code !== '\\') continue;
    i++;
    const next = pattern[i];
    if (next === 'n' || next === 'r' || next === 'W') return true;
  }
  return false;
}

// VS Code's parseReplaceString escapes: \n, \t and \\.
function unescapeReplacement(replacement: string): string {
  return replacement.replace(/\\([\\nt])/g, (_all, char: string) => (char === 'n' ? '\n' : char === 't' ? '\t' : '\\'));
}

// VS Code's ReplacePattern case operations (src/vs/workbench/services/search/common/replace.ts): \u and \l change one
// character of the numbered group they come before, \U and \L the rest of it; before an empty or missing group they are text.
const CASE_OPERATIONS = /((?:\\[uUlL])+)\$([1-9]\d*)/y;

function caseOperations(template: string, at: number, match: RegExpExecArray): { readonly text: string; readonly end: number } | undefined {
  CASE_OPERATIONS.lastIndex = at;
  const found = CASE_OPERATIONS.exec(template);
  const group = found ? match[Number(found[2])] : undefined;
  if (!found || !group) return undefined;
  const operations = found[1]!.replace(/\\/g, '');
  let text = '';
  let index = 0;
  for (; index < operations.length && index < group.length; index++) {
    const operation = operations[index];
    if (operation === 'U' || operation === 'L') {
      text += operation === 'U' ? group.slice(index).toUpperCase() : group.slice(index).toLowerCase();
      index = group.length;
      break;
    }
    text += operation === 'u' ? group[index]!.toUpperCase() : group[index]!.toLowerCase();
  }
  return { text: text + group.slice(index), end: at + found[0].length };
}

// String.prototype.replace's GetSubstitution, plus VS Code's $0 for the whole match and its case operations.
function substitute(match: RegExpExecArray, text: string, template: string): string {
  const matched = match[0];
  const groups = match.length - 1;
  let out = '';
  for (let i = 0; i < template.length; i++) {
    const char = template[i]!;
    const next = template[i + 1];
    const cased = char === '\\' ? caseOperations(template, i, match) : undefined;
    if (cased) {
      out += cased.text;
      i = cased.end - 1;
      continue;
    }
    if (char !== '$' || next === undefined) {
      out += char;
      continue;
    }
    if (next === '$') {
      out += '$';
      i++;
    } else if (next === '&' || next === '0') {
      out += matched;
      i++;
    } else if (next === '`') {
      out += text.slice(0, match.index);
      i++;
    } else if (next === "'") {
      out += text.slice(match.index + matched.length);
      i++;
    } else if (next >= '1' && next <= '9') {
      const two = template[i + 2];
      const twoDigit = two !== undefined && two >= '0' && two <= '9' ? Number(next + two) : 0;
      if (twoDigit >= 1 && twoDigit <= groups) {
        out += match[twoDigit] ?? '';
        i += 2;
      } else if (Number(next) <= groups) {
        out += match[Number(next)] ?? '';
        i++;
      } else {
        out += char;
      }
    } else if (next === '<' && match.groups) {
      const close = template.indexOf('>', i + 2);
      if (close < 0) {
        out += char;
        continue;
      }
      out += match.groups[template.slice(i + 2, close)] ?? '';
      i = close;
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * The text that replaces the match at [start, end) of `text`, or null when `regExp` (from searchRegExp) no longer matches
 * exactly there. `text` is the match's line, or its lines for a match across lines, so lookarounds see the text around the
 * match. A regex query expands $1 to $99, $<name>, $&, $0, $`, $' and $$, VS Code's \n, \t and \\, and its \u, \l, \U and
 * \L before a numbered group; any other is literal. Preserve Case recases the template after its escapes and before the
 * expansion, as VS Code's ReplacePattern does.
 */
export function replacementAt(regExp: RegExp, isRegex: boolean, text: string, start: number, end: number, replacement: string, preserveCase: boolean): string | null {
  regExp.lastIndex = start;
  const match = regExp.exec(text);
  if (!match || match.index !== start || match[0].length !== end - start) return null;
  const template = isRegex ? unescapeReplacement(replacement) : replacement;
  const cased = preserveCase ? buildReplaceStringWithCasePreserved(match, template) : template;
  return isRegex ? substitute(match, text, cased) : cased;
}

function isLowSurrogate(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * At most SEARCH_PREVIEW_CHARS of `line` around the match at [matchStart, matchEnd) (UTF-16; matchEnd past the line's end for
 * a match that goes on to later lines), starting PREVIEW_LEADING_CHARS before the match, never inside a surrogate pair.
 */
export function searchPreview(line: string, matchStart: number, matchEnd: number): SearchPreview {
  let from = Math.max(0, matchStart - PREVIEW_LEADING_CHARS);
  if (from > 0 && isLowSurrogate(line, from)) from++;
  let to = Math.min(line.length, from + SEARCH_PREVIEW_CHARS);
  if (to < line.length && isLowSurrogate(line, to)) to--;
  return { text: line.slice(from, to), matchStart: Math.min(matchStart - from, to - from), matchEnd: Math.min(Math.max(matchEnd, matchStart) - from, to - from) };
}

// damocles.desktop.search.sortOrder's values (SEARCH_SORT_ORDERS in desktop-configuration.ts).
export type SearchSortOrder = 'default' | 'fileNames' | 'type' | 'modified' | 'countDescending' | 'countAscending';

// base/common/comparers.ts intlFileNameCollatorBaseNumeric
const fileNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** VS Code's compareFileNames: numeric, ignoring case and accents, then by code unit where the collator ties. */
export function compareFileNames(one: string, other: string): number {
  const result = fileNameCollator.compare(one, other);
  return result === 0 && one !== other ? (one < other ? -1 : 1) : result;
}

// VS Code's comparePathComponents: a folder name by its lowercase code units.
function comparePathComponents(one: string, other: string): number {
  const a = one.toLowerCase();
  const b = other.toLowerCase();
  return a === b ? 0 : a < b ? -1 : 1;
}

/** VS Code's comparePaths: segment by segment, a folder's own files before deeper paths. */
export function comparePaths(one: string, other: string): number {
  const oneParts = one.split('/');
  const otherParts = other.split('/');
  for (let index = 0; ; index++) {
    const endOne = index === oneParts.length - 1;
    const endOther = index === otherParts.length - 1;
    if (endOne && endOther) return compareFileNames(oneParts[index]!, otherParts[index]!);
    if (endOne) return -1;
    if (endOther) return 1;
    const result = comparePathComponents(oneParts[index]!, otherParts[index]!);
    if (result !== 0) return result;
  }
}

// VS Code's FileNameMatch: '.gitignore' has the name '' and the extension 'gitignore'.
function nameAndExtension(name: string): [string, string] {
  const match = /^(.*?)(\.([^.]*))?$/.exec(name);
  return [match?.[1] ?? '', match?.[3] ?? ''];
}

/** VS Code's compareFileExtensions: by extension, then by name. */
export function compareFileExtensions(one: string, other: string): number {
  const [oneName, oneExtension] = nameAndExtension(one);
  const [otherName, otherExtension] = nameAndExtension(other);
  const byExtension = fileNameCollator.compare(oneExtension, otherExtension);
  if (byExtension !== 0) return byExtension;
  if (oneExtension !== otherExtension) return oneExtension < otherExtension ? -1 : 1;
  return compareFileNames(oneName, otherName);
}

/** What a result file or folder sorts by: its '/'-separated path (an untitled buffer's title), its match count and modification time. */
export interface SortableResult {
  readonly path: string;
  readonly count: number;
  readonly mtimeMs?: number | undefined;
}

/**
 * VS Code's searchMatchComparer (contrib/search/browser/searchCompare.ts) for two files or two folders under a
 * damocles.desktop.search.sortOrder; a folder has no modification time, so Modified orders folders by path.
 */
export function compareSearchResults(a: SortableResult, b: SortableResult, order: SearchSortOrder): number {
  const nameA = a.path.slice(a.path.lastIndexOf('/') + 1);
  const nameB = b.path.slice(b.path.lastIndexOf('/') + 1);
  switch (order) {
    case 'countDescending':
      return b.count - a.count;
    case 'countAscending':
      return a.count - b.count;
    case 'type':
      return compareFileExtensions(nameA, nameB);
    case 'fileNames':
      return compareFileNames(nameA, nameB);
    case 'modified':
      if (a.mtimeMs !== undefined && b.mtimeMs !== undefined) return b.mtimeMs - a.mtimeMs;
      return comparePaths(a.path, b.path) || compareFileNames(nameA, nameB);
    case 'default':
      return comparePaths(a.path, b.path) || compareFileNames(nameA, nameB);
  }
}

/** The path a result file sorts by: its relative path, or an untitled buffer's title. */
export function searchFileLabel(file: SearchFileResult): string {
  return file.kind === 'file' ? file.relativePath : file.title;
}

/** compareSearchResults for two result files. */
export function compareSearchFiles(a: SearchFileResult, b: SearchFileResult, order: SearchSortOrder): number {
  const sortable = (file: SearchFileResult): SortableResult => ({ path: searchFileLabel(file), count: file.matches.length, mtimeMs: file.kind === 'file' ? file.mtimeMs : undefined });
  return compareSearchResults(sortable(a), sortable(b), order);
}

/** VS Code's escapeGlobPattern, plus `{`, `}` and `,` so a name stays one glob of a comma-separated list. */
export function escapeGlob(value: string): string {
  return value.replace(/[?*[\]{},]/g, '[$&]');
}

/** A folder of the shown folder as an include or exclude entry, VS Code's `./folder` form; '' is the folder itself. */
export function folderGlob(relativePath: string): string {
  return relativePath === '' ? '' : `./${escapeGlob(relativePath)}`;
}
