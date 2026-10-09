import { describe, expect, it } from 'vitest';
import {
  buildReplaceStringWithCasePreserved,
  compareSearchFiles,
  escapeGlob,
  folderGlob,
  isMultilineRegexSource,
  matchingPattern,
  replacementAt as replacementAtCased,
  searchPreview,
  searchRegExp,
  SEARCH_PREVIEW_CHARS,
  withSmartCase,
  type SearchFileResult,
  type SearchPattern,
} from '../text-search';

const replacementAt = (regExp: RegExp, isRegex: boolean, text: string, start: number, end: number, replacement: string): string | null =>
  replacementAtCased(regExp, isRegex, text, start, end, replacement, false);

const regex = (pattern: string, options: Partial<SearchPattern> = {}): SearchPattern => ({ pattern, isRegex: true, matchCase: true, wholeWord: false, ...options });

describe('replacementAt', () => {
  it('expands groups of a regex with a lookbehind that sees the text before the match', () => {
    const query = regex('(?<=const )(\\w+) = (\\d+)');
    const line = 'export const answer = 42;';
    const start = line.indexOf('answer');
    expect(replacementAt(searchRegExp(query), true, line, start, start + 'answer = 42'.length, '$1 = $2 + 1')).toBe('answer = 42 + 1');
    // The match text alone has no "const " before it, so a lookbehind run on it alone would not match.
    expect(replacementAt(searchRegExp(query), true, 'answer = 42', 0, 11, '$1')).toBeNull();
  });

  it('expands $&, $0 and $$, keeps a group number past the groups literal, and reads VS Code escapes', () => {
    const re = searchRegExp(regex('(a)(b)'));
    expect(replacementAt(re, true, 'xab', 1, 3, '[$&|$0|$$|$2$1|$3|$10]')).toBe('[ab|ab|$|ba|$3|a0]');
    expect(replacementAt(re, true, 'xab', 1, 3, 'a\\nb\\tc\\\\d\\x')).toBe('a\nb\tc\\d\\x');
  });

  it('expands named groups', () => {
    expect(replacementAt(searchRegExp(regex('(?<word>\\w+)')), true, 'hello', 0, 5, '<$<word>>')).toBe('<hello>');
  });

  it('is literal for a text query, $1 included', () => {
    const re = searchRegExp({ pattern: 'a.b', isRegex: false, matchCase: true, wholeWord: false });
    expect(replacementAt(re, false, 'xa.b', 1, 4, '$1$&')).toBe('$1$&');
    expect(replacementAt(re, false, 'xaxb', 1, 4, 'y')).toBeNull();
  });

  it('refuses a match that moved or changed length, or a case the query no longer matches', () => {
    const re = searchRegExp(regex('fo+'));
    expect(replacementAt(re, true, 'foo', 0, 2, 'x')).toBeNull();
    expect(replacementAt(re, true, ' foo', 0, 3, 'x')).toBeNull();
    expect(replacementAt(re, true, 'FOO', 0, 3, 'x')).toBeNull();
    expect(replacementAt(searchRegExp(regex('fo+', { matchCase: false })), true, 'FOO', 0, 3, 'x')).toBe('x');
  });

  it('honours whole word', () => {
    const re = searchRegExp({ pattern: 'cat', isRegex: false, matchCase: true, wholeWord: true });
    expect(replacementAt(re, false, 'a cat', 2, 5, 'dog')).toBe('dog');
    expect(replacementAt(re, false, 'cats', 0, 3, 'dog')).toBeNull();
  });

  it('bounds a whole word by the word characters ripgrep -w reads, Unicode ones included, whatever the pattern\'s ends', () => {
    const word = (pattern: string, isRegex = false): RegExp => searchRegExp({ pattern, isRegex, matchCase: true, wholeWord: true });
    expect(replacementAt(word('na'), false, 'naïve', 0, 2, 'x')).toBeNull();
    expect(replacementAt(word('na'), false, 'éna', 1, 3, 'x')).toBeNull();
    expect(replacementAt(word('na'), false, 'na\u0301', 0, 2, 'x')).toBeNull();
    expect(replacementAt(word('na'), false, 'na\u200d', 0, 2, 'x')).toBeNull();
    expect(replacementAt(word('na'), false, 'na²', 0, 2, 'x')).toBe('x');
    expect(replacementAt(word('.foo'), false, 'a.foo', 1, 5, 'x')).toBeNull();
    expect(replacementAt(word('.foo'), false, ' .foo', 1, 5, 'x')).toBe('x');
    expect(replacementAt(word('ab|cd', true), true, 'abx', 0, 2, 'x')).toBeNull();
    expect(replacementAt(word('ab|cd', true), true, 'x cd', 2, 4, 'x')).toBe('x');
  });
});

describe('replace case operators (VS Code ReplacePattern)', () => {
  const pair = searchRegExp(regex('(\\w+) (\\w+)'));
  const line = 'hello World';

  it('upper- or lower-cases the next character, or the rest, of the group each one comes before', () => {
    expect(replacementAt(pair, true, line, 0, 11, '\\u$1 \\l$2')).toBe('Hello world');
    expect(replacementAt(pair, true, line, 0, 11, '\\U$1-\\L$2')).toBe('HELLO-world');
    expect(replacementAt(pair, true, line, 0, 11, '\\u\\u$1')).toBe('HEllo');
    expect(replacementAt(pair, true, line, 0, 11, '\\l\\U$2')).toBe('wORLD');
    expect(replacementAt(pair, true, line, 0, 11, '<\\U$2>$1')).toBe('<WORLD>hello');
  });

  it('leaves an operator before anything but a group number as text, and is literal for a text query', () => {
    expect(replacementAt(pair, true, line, 0, 11, '\\Uabc $1')).toBe('\\Uabc hello');
    expect(replacementAt(pair, true, line, 0, 11, '\\U$&')).toBe('\\Uhello World');
    const text = searchRegExp({ pattern: 'hello', isRegex: false, matchCase: true, wholeWord: false });
    expect(replacementAt(text, false, line, 0, 5, '\\U$1')).toBe('\\U$1');
  });

  it('applies after Preserve Case recased the template', () => {
    expect(replacementAtCased(searchRegExp(regex('(\\w+)')), true, 'Hello', 0, 5, 'x\\l$1', true)).toBe('Xhello');
  });
});

describe('isMultilineRegexSource', () => {
  it('is true for a newline escape and false otherwise', () => {
    expect(isMultilineRegexSource('a\\nb')).toBe(true);
    expect(isMultilineRegexSource('a\\Wb')).toBe(true);
    expect(isMultilineRegexSource('a\\\\nb')).toBe(false);
    expect(isMultilineRegexSource('a.b')).toBe(false);
  });
});

describe('searchPreview', () => {
  it('keeps a short line whole', () => {
    expect(searchPreview('const x = 1;', 6, 7)).toEqual({ text: 'const x = 1;', matchStart: 6, matchEnd: 7 });
  });

  it('bounds a long line to the preview width, starting 50 characters before the match', () => {
    const line = `${'a'.repeat(300)}MATCH${'b'.repeat(300)}`;
    const preview = searchPreview(line, 300, 305);
    expect(preview.text).toHaveLength(SEARCH_PREVIEW_CHARS);
    expect(preview.text.slice(preview.matchStart, preview.matchEnd)).toBe('MATCH');
    expect(preview.matchStart).toBe(50);
  });

  it('never splits a surrogate pair and clamps a match that goes on to the next line', () => {
    const line = `${'😀'.repeat(40)}x`;
    const preview = searchPreview(line, 80, 200);
    expect(preview.text.startsWith('\uDE00')).toBe(false);
    expect(preview.text.slice(preview.matchStart)).toBe('x');
    expect(preview.matchEnd).toBe(preview.text.length);
  });
});

describe('Preserve Case', () => {
  // VS Code's own cases (src/vs/editor/contrib/find/test/browser/replacePattern.test.ts).
  it.each([
    [['abc'], 'Def', 'def'],
    [['Abc'], 'Def', 'Def'],
    [['ABC'], 'Def', 'DEF'],
    [['abc', 'Abc'], 'Def', 'def'],
    [['Abc', 'abc'], 'Def', 'Def'],
    [['ABC', 'abc'], 'Def', 'DEF'],
    [['aBc', 'abc'], 'Def', 'def'],
    [['AbC'], 'Def', 'Def'],
    [['aBC'], 'Def', 'def'],
    [['aBc'], 'DeF', 'deF'],
    [['Foo-Bar'], 'newfoo-newbar', 'Newfoo-Newbar'],
    [['Foo-Bar-Abc'], 'newfoo-newbar-newabc', 'Newfoo-Newbar-Newabc'],
    [['Foo-Bar-abc'], 'newfoo-newbar', 'Newfoo-newbar'],
    [['foo-Bar'], 'newfoo-newbar', 'newfoo-Newbar'],
    [['foo-BAR'], 'newfoo-newbar', 'newfoo-NEWBAR'],
    [['foO-BAR'], 'NewFoo-NewBar', 'newFoo-NEWBAR'],
    [['Foo_Bar'], 'newfoo_newbar', 'Newfoo_Newbar'],
    [['Foo_Bar_Abc'], 'newfoo_newbar_newabc', 'Newfoo_Newbar_Newabc'],
    [['Foo_Bar_abc'], 'newfoo_newbar', 'Newfoo_newbar'],
    [['Foo_Bar-abc'], 'newfoo_newbar-abc', 'Newfoo_newbar-abc'],
    [['foo_Bar'], 'newfoo_newbar', 'newfoo_Newbar'],
    [['foo_BAR'], 'newfoo_newbar', 'newfoo_NEWBAR'],
  ])('recases %j with %s to %s', (matches, pattern, expected) => {
    expect(buildReplaceStringWithCasePreserved(matches, pattern)).toBe(expected);
  });

  it('leaves the pattern as typed for no match or an empty one', () => {
    expect(buildReplaceStringWithCasePreserved(null, 'Def')).toBe('Def');
    expect(buildReplaceStringWithCasePreserved([''], 'Def')).toBe('Def');
  });

  it('recases the replacement in replacementAt for a text and a regex query, before $1 expands', () => {
    const text = searchRegExp({ pattern: 'foo', isRegex: false, matchCase: false, wholeWord: false });
    expect(replacementAtCased(text, false, 'x FOO', 2, 5, 'bar', true)).toBe('BAR');
    expect(replacementAtCased(text, false, 'x Foo', 2, 5, 'bar', true)).toBe('Bar');
    expect(replacementAtCased(text, false, 'x Foo', 2, 5, 'bar', false)).toBe('bar');
    const regex = searchRegExp({ pattern: 'foo(\\w*)', isRegex: true, matchCase: false, wholeWord: false });
    // The template is recased, not the group's text: $1 keeps the case it matched.
    expect(replacementAtCased(regex, true, 'Foobar', 0, 6, 'baz$1', true)).toBe('Bazbar');
    expect(replacementAtCased(regex, true, 'FOOBAR', 0, 6, 'baz$1', true)).toBe('BAZBAR');
  });
});

describe('smart case', () => {
  const pattern = (value: string, isRegex = false): SearchPattern => ({ pattern: value, isRegex, matchCase: false, wholeWord: false });

  it('matches case for a pattern with an uppercase letter, as VS Code\'s query builder does', () => {
    expect(withSmartCase(pattern('Foo'), true).matchCase).toBe(true);
    expect(withSmartCase(pattern('foo'), true).matchCase).toBe(false);
    expect(withSmartCase(pattern('Foo'), false).matchCase).toBe(false);
  });

  it('ignores an escaped letter in a regex', () => {
    expect(withSmartCase(pattern('\\Bfoo\\W', true), true).matchCase).toBe(false);
    expect(withSmartCase(pattern('\\bFoo', true), true).matchCase).toBe(true);
  });
});

describe('matchingPattern', () => {
  it('searches a multi-line text query as an escaped regex whose line breaks also match CRLF', () => {
    expect(matchingPattern({ pattern: 'a.b\nc', isRegex: false, matchCase: true, wholeWord: false })).toEqual({ pattern: 'a\\.b\\r?\\nc', isRegex: true, matchCase: true, wholeWord: false });
    const one = { pattern: 'a.b', isRegex: false, matchCase: true, wholeWord: false };
    expect(matchingPattern(one)).toBe(one);
    expect(searchRegExp(matchingPattern({ pattern: 'x\ny', isRegex: false, matchCase: true, wholeWord: false })).test('x\r\ny')).toBe(true);
  });

  it('lets every line break a regex names also match CRLF, leaving range ends and nested classes as written', () => {
    const table: Array<[string, string]> = [
      ['foo', 'foo'],
      ['invalid(', 'invalid('],
      ['fo\\no', 'fo\\r?\\no'],
      ['f\\no\\no', 'f\\r?\\no\\r?\\no'],
      ['fo\no', 'fo\\r?\\no'],
      ['foo\\r\\n', 'foo\\r\\r?\\n'],
      ['a\\\\n', 'a\\\\n'],
      ['fo\\n+o', 'fo(?:\\r?\\n)+o'],
      ['fo\\n{2,}o', 'fo(?:\\r?\\n){2,}o'],
      ['(a\\n)+', '(a\\r?\\n)+'],
      ['f[a-z\\n1]', 'f(?:[a-z1]|\\r?\\n)'],
      ['f[\\n]', 'f\\r?\\n'],
      ['f[\\n]+', 'f(?:\\r?\\n)+'],
      ['f[\\n^a]', 'f(?:[\\^a]|\\r?\\n)'],
      ['[\\]\\n]', '(?:[\\]]|\\r?\\n)'],
      ['fo[^\\n]o', 'fo(?:(?!\\r\\n)[^\\n])o'],
      ['foo[^\\nzq]+o', 'foo(?:(?!\\r\\n)[^\\nzq])+o'],
      ['fo[^\\S\\n]*o', 'fo(?:(?!\\r\\n)[^\\S\\n])*o'],
      ['f[\\n-a]', 'f[\\n-a]'],
      ['f[a-\\n]', 'f[a-\\n]'],
      ['[]\\n]', '[]\\n]'],
      ['[a[b]\\n]', '[a[b]\\n]'],
      ['[\\n&&\\s]', '[\\n&&\\s]'],
      ['(?<=a\\n)\\w', '(?<=a\\r?\\n)\\w'],
      ['(?<![\\n])x\\n', '(?<!\\r?\\n)x\\r?\\n'],
      ['(?<name>x)\\n', '(?<name>x)\\r?\\n'],
    ];
    for (const [pattern, expected] of table) expect(matchingPattern(regex(pattern)).pattern, pattern).toBe(expected);
    const plain = regex('a.b');
    expect(matchingPattern(plain)).toBe(plain);
  });

  it('matches a line break the regex names at CRLF and LF alike, and never the CR of a CRLF alone', () => {
    const matches = (pattern: string, text: string): string[] => [...text.matchAll(new RegExp(searchRegExp(matchingPattern(regex(pattern))).source, 'gmu'))].map((found) => found[0]);
    expect(matches('o\\nb', 'foo\r\nbar\nfoo\nbar')).toEqual(['o\r\nb', 'o\nb']);
    expect(matches('o[\\n]b', 'foo\r\nbar')).toEqual(['o\r\nb']);
    expect(matches('o\\n+b', 'foo\r\n\r\nbar')).toEqual(['o\r\n\r\nb']);
    expect(matches('o[^\\n]', 'fo\r\nfoo\r\n')).toEqual(['oo']);
    expect(matches('r[^\\n]*\\nx', 'bar\r\nx')).toEqual(['r\r\nx']);
  });
});

describe('compareSearchFiles', () => {
  const file = (relativePath: string, count: number, mtimeMs?: number): SearchFileResult => ({
    kind: 'file',
    relativePath,
    matches: Array.from({ length: count }, (_, id) => ({ id, range: { startLine: 1, startColumn: 1, endLine: 1, endColumn: 2 }, preview: { text: 'x', matchStart: 0, matchEnd: 1 } })),
    ...(mtimeMs !== undefined ? { mtimeMs } : {}),
  });
  const files = [file('src/b.ts', 1, 10), file('a.md', 3, 30), file('src/a/z.js', 2, 20), file('file10.ts', 1, 5), file('file9.ts', 1, 40)];
  const order = (sortOrder: Parameters<typeof compareSearchFiles>[2]): string[] =>
    [...files].sort((a, b) => compareSearchFiles(a, b, sortOrder)).map((result) => (result.kind === 'file' ? result.relativePath : result.title));

  it('sorts by folder and name, files before the folders beside them, numbers numerically', () => {
    expect(order('default')).toEqual(['a.md', 'file9.ts', 'file10.ts', 'src/b.ts', 'src/a/z.js']);
  });

  it('sorts by name alone, by type, by count both ways and by modification time, newest first', () => {
    expect(order('fileNames')).toEqual(['a.md', 'src/b.ts', 'file9.ts', 'file10.ts', 'src/a/z.js']);
    expect(order('type')).toEqual(['src/a/z.js', 'a.md', 'src/b.ts', 'file9.ts', 'file10.ts']);
    expect(order('countDescending').slice(0, 2)).toEqual(['a.md', 'src/a/z.js']);
    expect(order('countAscending').slice(-2)).toEqual(['src/a/z.js', 'a.md']);
    expect(order('modified')).toEqual(['file9.ts', 'a.md', 'src/a/z.js', 'src/b.ts', 'file10.ts']);
  });

  it('compares folders by their lowercase names and reads a dotfile\'s name as its extension, as VS Code\'s comparers do', () => {
    const sorted = (paths: readonly string[], sortOrder: Parameters<typeof compareSearchFiles>[2]): string[] =>
      paths.map((relativePath) => file(relativePath, 1)).sort((a, b) => compareSearchFiles(a, b, sortOrder)).map((result) => (result.kind === 'file' ? result.relativePath : ''));
    expect(sorted(['v9/a.ts', 'v10/a.ts', 'B/a.ts', 'a/a.ts'], 'default')).toEqual(['a/a.ts', 'B/a.ts', 'v10/a.ts', 'v9/a.ts']);
    expect(sorted(['a.ts', '.gitignore', 'z.c', 'Makefile'], 'type')).toEqual(['Makefile', 'z.c', '.gitignore', 'a.ts']);
  });
});

describe('folder globs', () => {
  it('escapes glob characters, commas and braces so a name stays one entry', () => {
    expect(escapeGlob('a,b{c}[d]*?')).toBe('a[,]b[{]c[}][[]d[]][*][?]');
    expect(folderGlob('src/a,b')).toBe('./src/a[,]b');
    expect(folderGlob('')).toBe('');
  });
});
