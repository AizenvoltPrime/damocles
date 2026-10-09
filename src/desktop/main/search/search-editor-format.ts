// VS Code's Search Editor text format (searchEditorSerialization.ts) and the search-result language's line rules
// (extensions/search-result), so a .code-search file moves between the two editors unchanged.
import { isRelativeFilePath } from '../../../shared/relative-path';
import { MAX_CONTEXT_LINES, MAX_SEARCH_GLOBS_LENGTH, MAX_SEARCH_PATTERN_LENGTH, type SearchRange } from '../../../shared/text-search';
import { MAX_EDITOR_TEXT_CHARS, type SearchEditorConfig } from '../../preload/shell-channels';

export const SEARCH_EDITOR_EXTENSION = '.code-search';
export const SEARCH_RESULT_LANGUAGE_ID = 'search-result';
// VS Code's Search Editor preview: one line per match, 1000 characters, a fifth of them before the match.
export const SEARCH_EDITOR_CHARS_PER_LINE = 1000;
// Header lines read for keys; VS Code reads lines 1-5 of a model and every line before the first blank one of a file.
const MAX_HEADER_KEY_LINES = 16;
const ELIDED_PREFIX = '⟪ ';
const ELIDED_SUFFIX = ' characters skipped ⟫';
const ELIDED_MIN_LENGTH = (ELIDED_PREFIX.length + ELIDED_SUFFIX.length + 5) * 2;

export const DEFAULT_SEARCH_EDITOR_CONFIG: SearchEditorConfig = {
  query: '',
  isRegex: false,
  matchCase: false,
  wholeWord: false,
  include: '',
  exclude: '',
  useExcludeSettingsAndIgnoreFiles: true,
  onlyOpenEditors: false,
  contextLines: 0,
  showIncludesExcludes: false,
};

/** VS Code's serializeSearchConfiguration: the header lines and the blank line after them, joined with '\n'. */
export function serializeSearchConfiguration(config: SearchEditorConfig): string {
  const escapeNewlines = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n');
  const flags = [
    config.matchCase && 'CaseSensitive',
    config.wholeWord && 'WordMatch',
    config.isRegex && 'RegExp',
    config.onlyOpenEditors && 'OpenEditors',
    !config.useExcludeSettingsAndIgnoreFiles && 'IgnoreExcludeSettings',
  ].filter((flag): flag is string => flag !== false);
  const lines = [
    `# Query: ${escapeNewlines(config.query)}`,
    // VS Code writes the Flags line only for these four, so OpenEditors alone is not saved.
    ...(config.matchCase || config.wholeWord || config.isRegex || !config.useExcludeSettingsAndIgnoreFiles ? [`# Flags: ${flags.join(' ')}`] : []),
    ...(config.include ? [`# Including: ${config.include}`] : []),
    ...(config.exclude ? [`# Excluding: ${config.exclude}`] : []),
    ...(config.contextLines ? [`# ContextLines: ${config.contextLines}`] : []),
    '',
  ];
  return lines.join('\n');
}

/** The saved form of a Search Editor: its header, a blank line and its body (searchEditorInput.ts serializeForDisk). */
export function serializeSearchEditor(config: SearchEditorConfig, body: string): string {
  return `${serializeSearchConfiguration(config)}\n${body}`;
}

export interface ParsedSearchEditor {
  readonly config: SearchEditorConfig;
  readonly body: string;
  // the header's query had a backslash that escapes nothing; the query is left empty, as VS Code fails to read it
  readonly headerError?: 'invalidEscape';
}

// VS Code's unescapeNewlines, undefined where it throws.
function unescapeNewlines(value: string): string | undefined {
  let out = '';
  for (let index = 0; index < value.length; index++) {
    if (value[index] !== '\\') {
      out += value[index];
      continue;
    }
    index++;
    if (value[index] === 'n') out += '\n';
    else if (value[index] === '\\') out += '\\';
    else return undefined;
  }
  return out;
}

// VS Code reads `+value`; anything that is not a plain count is no context, and a count past the bound is the bound.
function parseContextLines(value: string): number {
  if (!/^\d{1,9}$/.test(value)) return 0;
  return Math.min(Number(value), MAX_CONTEXT_LINES);
}

/**
 * VS Code's parseSerializedSearchEditor: the lines before the first blank one are the header, the rest is the body joined
 * with '\n'. A header line is `# Key: value`; unknown keys and other lines are ignored, and a value past the input bounds is
 * dropped. Linear in the text.
 */
export function parseSearchEditor(text: string): ParsedSearchEditor {
  const lines = text.split(/\r?\n/);
  const blank = lines.indexOf('');
  const header = blank === -1 ? lines : lines.slice(0, blank);
  const body = blank === -1 ? '' : lines.slice(blank + 1).join('\n');
  let config: SearchEditorConfig = DEFAULT_SEARCH_EDITOR_CONFIG;
  let headerError: ParsedSearchEditor['headerError'];
  for (const line of header.slice(0, MAX_HEADER_KEY_LINES)) {
    const parsed = /^# ([^:]*): (.*)$/.exec(line);
    if (!parsed) continue;
    const [, key, value] = parsed as unknown as [string, string, string];
    switch (key) {
      case 'Query': {
        const query = unescapeNewlines(value);
        if (query === undefined) headerError = 'invalidEscape';
        else if (query.length <= MAX_SEARCH_PATTERN_LENGTH) config = { ...config, query };
        break;
      }
      case 'Including':
        if (value.length <= MAX_SEARCH_GLOBS_LENGTH) config = { ...config, include: value };
        break;
      case 'Excluding':
        if (value.length <= MAX_SEARCH_GLOBS_LENGTH) config = { ...config, exclude: value };
        break;
      case 'ContextLines':
        config = { ...config, contextLines: parseContextLines(value) };
        break;
      case 'Flags':
        config = {
          ...config,
          isRegex: value.includes('RegExp'),
          matchCase: value.includes('CaseSensitive'),
          useExcludeSettingsAndIgnoreFiles: !value.includes('IgnoreExcludeSettings'),
          wholeWord: value.includes('WordMatch'),
          onlyOpenEditors: value.includes('OpenEditors'),
        };
        break;
    }
  }
  config = { ...config, showIncludesExcludes: Boolean(config.include || config.exclude || !config.useExcludeSettingsAndIgnoreFiles) };
  return { config, body, ...(headerError !== undefined ? { headerError } : {}) };
}

/** VS Code's suggestFileName: the query with every run of other characters as '_', or Search. */
export function suggestedFileName(query: string): string {
  const stem = query.replace(/[^\w \-_]+/g, '_').slice(0, 100) || 'Search';
  return `${stem}${SEARCH_EDITOR_EXTENSION}`;
}

// One match as VS Code's MatchImpl holds it for the Search Editor: its range in the file, and the preview lines from its first
// line to its last with its columns there (1-based, end exclusive).
export interface EditorMatch {
  readonly range: SearchRange;
  readonly previewLines: readonly string[];
  readonly previewStart: number;
  readonly previewEnd: number;
}

export interface EditorFileResult {
  // the file's label: its relative path with the platform's separator, or an untitled buffer's title
  readonly label: string;
  readonly matches: readonly EditorMatch[];
  // context lines by 1-based line number
  readonly context: ReadonlyMap<number, string>;
}

/**
 * One search hit as VS Code's TextSearchMatch builds it with a one-line, SEARCH_EDITOR_CHARS_PER_LINE preview: `text` is the
 * hit's lines from firstLine (without their final line break) and `ranges` its matches in the file. Matches all on one line
 * share that line, cut around them with "⟪ N characters skipped ⟫" between distant ones; any other hit keeps its lines whole.
 */
export function editorMatches(text: string, firstLine: number, ranges: readonly SearchRange[]): EditorMatch[] {
  const singleLine = ranges.every((range) => range.startLine === firstLine && range.endLine === firstLine);
  if (!singleLine) {
    const lines = text.split('\n');
    return ranges.map((range) => ({
      range,
      previewLines: lines.slice(range.startLine - firstLine, range.endLine - firstLine + 1),
      previewStart: range.startColumn,
      previewEnd: range.endColumn,
    }));
  }
  const newline = text.indexOf('\n');
  const line = newline === -1 ? text : text.slice(0, text[newline - 1] === '\r' ? newline - 1 : newline);
  const leadingChars = Math.floor(SEARCH_EDITOR_CHARS_PER_LINE / 5);
  let preview = '';
  let shift = 0;
  let lastEnd = 0;
  const columns: Array<[number, number]> = [];
  for (const range of ranges) {
    const start = range.startColumn - 1;
    const previewStart = Math.max(start - leadingChars, 0);
    const previewEnd = start + SEARCH_EDITOR_CHARS_PER_LINE;
    if (previewStart > lastEnd + leadingChars + ELIDED_MIN_LENGTH) {
      const elision = `${ELIDED_PREFIX}${previewStart - lastEnd}${ELIDED_SUFFIX}`;
      preview += elision + line.slice(previewStart, previewEnd);
      shift += previewStart - (lastEnd + elision.length);
    } else {
      preview += line.slice(lastEnd, previewEnd);
    }
    lastEnd = previewEnd;
    columns.push([range.startColumn - shift, range.endColumn - shift]);
  }
  return ranges.map((range, index) => ({ range, previewLines: [preview], previewStart: columns[index]![0], previewEnd: columns[index]![1] }));
}

export interface SerializedResults {
  readonly text: string;
  // the matches in the body, 1-based lines of the body
  readonly ranges: SearchRange[];
}

function compareRangeStarts(a: SearchRange, b: SearchRange): number {
  return a.startLine - b.startLine || a.startColumn - b.startColumn || a.endLine - b.endLine || a.endColumn - b.endColumn;
}

// VS Code's matchesToSearchResultFormat for one file: its label line, then its match and context lines.
function fileLines(file: EditorFileResult): { lines: string[]; ranges: SearchRange[] } {
  const sorted = [...file.matches].sort((a, b) => compareRangeStarts(a.range, b.range));
  const longest = String(sorted.at(-1)!.range.endLine).length;
  const lines = [`${file.label}:`];
  const ranges: SearchRange[] = [];
  const offsets = new Map<number, number>();
  const context = [...file.context].map(([lineNumber, line]) => ({ lineNumber, line })).sort((a, b) => a.lineNumber - b.lineNumber);
  let lastLine: number | undefined;
  for (const match of sorted) {
    const singleLine = match.previewLines.length === 1;
    match.previewLines.forEach((source, index) => {
      const lineNumber = match.range.startLine + index;
      const prefix = `  ${' '.repeat(longest - String(lineNumber).length)}${lineNumber}: `;
      const content = source.split(/\r?\n?$/, 1)[0] ?? '';
      const start = singleLine || index === 0 ? match.previewStart : 1;
      const end = singleLine || index === match.previewLines.length - 1 ? match.previewEnd : source.length + 1;
      if (!offsets.has(lineNumber)) {
        while (context.length > 0 && context[0]!.lineNumber < lineNumber) {
          const next = context.shift()!;
          if (lastLine !== undefined && next.lineNumber !== lastLine + 1) lines.push('');
          lines.push(`  ${' '.repeat(longest - String(next.lineNumber).length)}${next.lineNumber}  ${next.line}`);
          lastLine = next.lineNumber;
        }
        offsets.set(lineNumber, lines.length);
        lines.push(prefix + content);
        lastLine = lineNumber;
      }
      const at = offsets.get(lineNumber)! + 1;
      ranges.push({ startLine: at, startColumn: start + prefix.length, endLine: at, endColumn: end + prefix.length });
    });
  }
  // VS Code writes the context after the last match without the padding or the gap lines.
  for (const next of context) lines.push(`  ${next.lineNumber}  ${next.line}`);
  return { lines, ranges };
}

export interface ResultSummaryLabels {
  readonly results: (count: number) => string;
  readonly files: (count: number) => string;
  readonly noResults: string;
  readonly limitHit: string;
}

/**
 * VS Code's serializeSearchResultForEditor: "N results - M files" (or No Results), the limit notice when it applies, a blank
 * line, then each file (in the caller's order) as its label line, its lines and a blank line.
 */
export function serializeSearchResults(files: readonly EditorFileResult[], limitHit: boolean, labels: ResultSummaryLabels): SerializedResults {
  const resultCount = files.reduce((sum, file) => sum + file.matches.length, 0);
  const lines = [resultCount ? `${labels.results(resultCount)} - ${labels.files(files.length)}` : labels.noResults];
  if (limitHit) lines.push(labels.limitHit);
  lines.push('');
  const ranges: SearchRange[] = [];
  for (const file of files) {
    if (file.matches.length === 0) continue;
    const serialized = fileLines(file);
    const before = lines.length;
    for (const range of serialized.ranges) ranges.push({ ...range, startLine: range.startLine + before, endLine: range.endLine + before });
    lines.push(...serialized.lines, '');
  }
  return { text: lines.join('\n'), ranges };
}

export type ResultLocation =
  | { readonly kind: 'file'; readonly relativePath: string }
  | { readonly kind: 'match'; readonly relativePath: string; readonly line: number; readonly column: number };

// A file line of the search-result language: `^(\S.*):$`.
function fileLabelOf(line: string): string | undefined {
  return line.length > 1 && !/\s/.test(line[0]!) && line.endsWith(':') ? line.slice(0, -1) : undefined;
}

// A result line `^(\s+)(\d+)(: |  )(\s*)(.*)$`, read without backtracking: the line number and where the text starts.
function resultLineOf(line: string): { lineNumber: number; textStart: number } | undefined {
  let index = 0;
  while (index < line.length && /\s/.test(line[index]!)) index++;
  if (index === 0) return undefined;
  const digitsStart = index;
  while (index < line.length && line[index]! >= '0' && line[index]! <= '9') index++;
  if (index === digitsStart || index - digitsStart > 9) return undefined;
  const separator = line.slice(index, index + 2);
  if (separator !== ': ' && separator !== '  ') return undefined;
  return { lineNumber: Number(line.slice(digitsStart, index)), textStart: index + 2 };
}

/**
 * Where a position in a Search Editor body points (the search-result language's definition provider): a file line names its
 * file, a result line its file's line at the column under the cursor, counting the characters an elision marker stands for.
 * The label must be a relative path inside the project ('\' read as '/'); an absolute, drive, UNC or `..` label points nowhere.
 */
export function resultLocation(body: string, line: number, column: number): ResultLocation | undefined {
  const lines = body.split(/\r?\n/);
  const text = lines[line - 1];
  if (text === undefined) return undefined;
  const asPath = (label: string): string | undefined => {
    const relativePath = label.replace(/\\/g, '/');
    return isRelativeFilePath(relativePath) ? relativePath : undefined;
  };
  const label = fileLabelOf(text);
  if (label !== undefined) {
    const relativePath = asPath(label);
    return relativePath === undefined ? undefined : { kind: 'file', relativePath };
  }
  const result = resultLineOf(text);
  if (!result) return undefined;
  let relativePath: string | undefined;
  for (let index = line - 2; index >= 0; index--) {
    const above = fileLabelOf(lines[index]!);
    if (above === undefined) continue;
    relativePath = asPath(above);
    break;
  }
  if (relativePath === undefined) return undefined;
  const offset = column - 1;
  if (offset < result.textStart) return { kind: 'match', relativePath, line: result.lineNumber, column: 1 };
  const elision = /⟪ ([0-9]{1,9}) characters skipped ⟫/g;
  elision.lastIndex = result.textStart;
  let segmentStart = result.textStart;
  let target = 0;
  for (let found = elision.exec(text); found; found = elision.exec(text)) {
    if (offset < found.index) break;
    target += found.index - segmentStart + Number(found[1]);
    segmentStart = elision.lastIndex;
  }
  return { kind: 'match', relativePath, line: result.lineNumber, column: Math.min(target + Math.max(0, offset - segmentStart) + 1, MAX_EDITOR_TEXT_CHARS) };
}
