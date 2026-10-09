import { describe, expect, it } from 'vitest';
import type { SearchEditorConfig } from '../../preload/shell-channels';
import {
  DEFAULT_SEARCH_EDITOR_CONFIG,
  editorMatches,
  parseSearchEditor,
  resultLocation,
  serializeSearchConfiguration,
  serializeSearchEditor,
  serializeSearchResults,
  suggestedFileName,
  type EditorFileResult,
  type ResultSummaryLabels,
} from '../search/search-editor-format';

const LABELS: ResultSummaryLabels = {
  results: (count) => (count > 1 ? `${count} results` : '1 result'),
  files: (count) => (count > 1 ? `${count} files` : '1 file'),
  noResults: 'No Results',
  limitHit: 'The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.',
};

const config = (overrides: Partial<SearchEditorConfig> = {}): SearchEditorConfig => ({ ...DEFAULT_SEARCH_EDITOR_CONFIG, ...overrides });

// A .code-search file as VS Code 1.10x writes it (searchEditorInput.serializeForDisk over serializeSearchResultForEditor).
const VS_CODE_FILE = [
  '# Query: const \\\\d\\nnext',
  '# Flags: CaseSensitive RegExp IgnoreExcludeSettings',
  '# Including: src/**',
  '# Excluding: *.md',
  '# ContextLines: 1',
  '',
  '3 results - 2 files',
  '',
  'src/a.ts:',
  '   9  before',
  '  10: const x = 1;',
  '  11  after',
  '',
  '  40  far',
  '  41: const y = 2;',
  '',
  'src/b.ts:',
  '  1: const z = 3;',
  '  2  tail',
  '',
].join('\n');

describe('the .code-search header', () => {
  it('writes VS Code\'s header lines: escaped query, the Flags line only for its four flags, and context lines only when set', () => {
    expect(serializeSearchConfiguration(config({ query: 'a\\b\nc' }))).toBe('# Query: a\\\\b\\nc\n');
    expect(serializeSearchConfiguration(config({ query: 'q', onlyOpenEditors: true }))).toBe('# Query: q\n');
    expect(serializeSearchConfiguration(config({ query: 'q', matchCase: true, wholeWord: true, isRegex: true, onlyOpenEditors: true, useExcludeSettingsAndIgnoreFiles: false, include: 'a', exclude: 'b', contextLines: 2 })))
      .toBe('# Query: q\n# Flags: CaseSensitive WordMatch RegExp OpenEditors IgnoreExcludeSettings\n# Including: a\n# Excluding: b\n# ContextLines: 2\n');
  });

  it('round-trips a file VS Code wrote, byte for byte', () => {
    const parsed = parseSearchEditor(VS_CODE_FILE);
    expect(parsed.config).toEqual({
      query: 'const \\d\nnext',
      isRegex: true,
      matchCase: true,
      wholeWord: false,
      include: 'src/**',
      exclude: '*.md',
      useExcludeSettingsAndIgnoreFiles: false,
      onlyOpenEditors: false,
      contextLines: 1,
      showIncludesExcludes: true,
    });
    expect(parsed.headerError).toBeUndefined();
    expect(serializeSearchEditor(parsed.config, parsed.body)).toBe(VS_CODE_FILE);
  });

  it('reads a CRLF file as VS Code does, its body joined with \\n', () => {
    const parsed = parseSearchEditor(VS_CODE_FILE.replace(/\n/g, '\r\n'));
    expect(parsed.body).toBe(parseSearchEditor(VS_CODE_FILE).body);
  });

  it('takes a file without a blank line as all header, and ignores unknown and malformed header lines', () => {
    expect(parseSearchEditor('# Query: q\n# Flags: WordMatch')).toEqual({ config: config({ query: 'q', wholeWord: true }), body: '' });
    expect(parseSearchEditor('# Nope: x\nnot a header\n#Query: y\n\nbody').config).toEqual(DEFAULT_SEARCH_EDITOR_CONFIG);
  });

  it('reports a backslash that escapes nothing, as VS Code refuses the query, and keeps the rest', () => {
    const parsed = parseSearchEditor('# Query: a\\b\n# Including: src\n\nbody');
    expect(parsed.headerError).toBe('invalidEscape');
    expect(parsed.config).toMatchObject({ query: '', include: 'src' });
    expect(parsed.body).toBe('body');
  });

  it('reads context lines only as a plain count, capped at the bound', () => {
    const lines = (value: string): number => parseSearchEditor(`# ContextLines: ${value}\n\n`).config.contextLines;
    expect(lines('3')).toBe(3);
    expect(lines('1e309')).toBe(0);
    expect(lines('-5')).toBe(0);
    expect(lines('NaN')).toBe(0);
    expect(lines('500')).toBe(100);
    expect(lines('9999999999')).toBe(0);
  });

  it('drops a header value past the input bounds and reads a huge header in linear time', () => {
    const started = Date.now();
    const parsed = parseSearchEditor(`# Query: ${'x'.repeat(10 * 1024 * 1024)}\n# Including: ${'y'.repeat(4001)}\n# Excluding: ok\n\nbody`);
    expect(parsed.config).toMatchObject({ query: '', include: '', exclude: 'ok' });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('reads only the first header lines for keys', () => {
    const header = Array.from({ length: 20 }, (_, i) => `# Junk${i}: x`).join('\n');
    expect(parseSearchEditor(`${header}\n# Query: late\n\n`).config.query).toBe('');
  });

  it('proposes VS Code\'s file name for an untitled editor', () => {
    expect(suggestedFileName('foo/bar: baz*')).toBe('foo_bar_ baz_.code-search');
    expect(suggestedFileName('')).toBe('Search.code-search');
  });
});

describe('the results body', () => {
  const file = (label: string, matches: EditorFileResult['matches'], context: Array<[number, string]> = []): EditorFileResult => ({ label, matches, context: new Map(context) });
  const single = (line: number, text: string, start: number, end: number) => editorMatches(text, line, [{ startLine: line, startColumn: start, endLine: line, endColumn: end }]);

  it('lays results out as VS Code does: summary, files, padded line numbers, context and gaps', () => {
    const serialized = serializeSearchResults([
      file('src/a.ts', [...single(10, 'const x = 1;', 1, 6), ...single(41, 'const y = 2;', 1, 6)], [[9, 'before'], [11, 'after'], [40, 'far']]),
      file('src/b.ts', single(1, 'const z = 3;', 1, 6), [[2, 'tail']]),
    ], false, LABELS);
    expect(serialized.text).toBe(parseSearchEditor(VS_CODE_FILE).body);
    expect(serialized.ranges).toEqual([
      { startLine: 5, startColumn: 7, endLine: 5, endColumn: 12 },
      { startLine: 9, startColumn: 7, endLine: 9, endColumn: 12 },
      { startLine: 12, startColumn: 6, endLine: 12, endColumn: 11 },
    ]);
  });

  it('says No Results, and adds the limit notice when the search stopped', () => {
    expect(serializeSearchResults([], false, LABELS).text).toBe('No Results\n');
    expect(serializeSearchResults([file('a', single(1, 'x', 1, 2))], true, LABELS).text.split('\n').slice(0, 3)).toEqual(['1 result - 1 file', LABELS.limitHit, '']);
  });

  it('writes a line two matches share once, with both highlighted', () => {
    const serialized = serializeSearchResults([file('a.ts', editorMatches('aa bb aa', 3, [{ startLine: 3, startColumn: 1, endLine: 3, endColumn: 3 }, { startLine: 3, startColumn: 7, endLine: 3, endColumn: 9 }]))], false, LABELS);
    expect(serialized.text).toBe('2 results - 1 file\n\na.ts:\n  3: aa bb aa\n');
    expect(serialized.ranges.map((range) => [range.startLine, range.startColumn, range.endColumn])).toEqual([[4, 6, 8], [4, 12, 14]]);
  });

  it('cuts a long line around its matches with VS Code\'s elision marker', () => {
    const line = `${'a'.repeat(3000)}needle${'b'.repeat(10)}`;
    const [match] = editorMatches(line, 1, [{ startLine: 1, startColumn: 3001, endLine: 1, endColumn: 3007 }]);
    expect(match!.previewLines[0]).toBe(`⟪ 2800 characters skipped ⟫${'a'.repeat(200)}needle${'b'.repeat(10)}`);
    expect(match!.previewLines[0]!.slice(match!.previewStart - 1, match!.previewEnd - 1)).toBe('needle');
  });
});

describe('opening a result', () => {
  const body = ['1 result - 1 file', '', 'src/a.ts:', '   9  before', '  10: const x = 1;', '', 'other.ts:', '  3: ⟪ 120 characters skipped ⟫abc', ''].join('\n');

  it('points a result line at its file\'s line and the column under the cursor, and a file line at the file', () => {
    expect(resultLocation(body, 5, 7)).toEqual({ kind: 'match', relativePath: 'src/a.ts', line: 10, column: 1 });
    expect(resultLocation(body, 5, 2)).toEqual({ kind: 'match', relativePath: 'src/a.ts', line: 10, column: 1 });
    expect(resultLocation(body, 5, 15)).toEqual({ kind: 'match', relativePath: 'src/a.ts', line: 10, column: 9 });
    expect(resultLocation(body, 4, 12)).toEqual({ kind: 'match', relativePath: 'src/a.ts', line: 9, column: 6 });
    expect(resultLocation(body, 3, 1)).toEqual({ kind: 'file', relativePath: 'src/a.ts' });
    expect(resultLocation(body, 1, 1)).toBeUndefined();
    expect(resultLocation(body, 99, 1)).toBeUndefined();
  });

  it('counts the characters an elision marker stands for', () => {
    const line = '  3: ⟪ 120 characters skipped ⟫abc';
    expect(resultLocation(body, 8, line.indexOf('abc') + 2)).toEqual({ kind: 'match', relativePath: 'other.ts', line: 3, column: 122 });
    const huge = ['a.ts:', `  1: ⟪ ${'9'.repeat(400)} characters skipped ⟫x`].join('\n');
    expect(resultLocation(huge, 2, 500)).toMatchObject({ kind: 'match', relativePath: 'a.ts', line: 1 });
    expect((resultLocation(huge, 2, 500) as { column: number }).column).toBeLessThanOrEqual(10 * 1024 * 1024);
  });

  it.each(['/etc/passwd', 'C:\\Windows\\win.ini', 'C:/x', '\\\\host\\share\\x', '//host/share/x', '..\\x', '../x', 'a/../../x', ''])('opens nothing for the label %j', (label) => {
    const text = `${label}:\n  1: x`;
    expect(resultLocation(text, 2, 6)).toBeUndefined();
    expect(resultLocation(text, 1, 1)).toBeUndefined();
  });

  it('reads a Windows label VS Code wrote with backslashes as a relative path', () => {
    expect(resultLocation('src\\a.ts:\n  1: x', 2, 6)).toEqual({ kind: 'match', relativePath: 'src/a.ts', line: 1, column: 1 });
  });

  it('reads a long result line in linear time', () => {
    const line = `  1: ${' '.repeat(2_000_000)}\u2028`;
    const started = Date.now();
    resultLocation(`a.ts:\n${line}`, 2, 3);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
