import { describe, expect, it } from 'vitest';
import { detectLinks, detectLinkSuffixes, getLinkSuffix, removeLinkQueryString, removeLinkSuffix, type LinkOs, type ParsedLink } from '../terminal/terminal-link-parsing';

// VS Code's terminalLinkParsing.test.ts cases, run against the port.
interface TestLink {
  link: string;
  prefix: string | undefined;
  suffix: string | undefined;
  hasRow: boolean;
  hasCol: boolean;
  hasRowEnd?: boolean;
  hasColEnd?: boolean;
}

const OSES: ReadonlyArray<{ os: LinkOs; label: string; path: string }> = [
  { os: 'posix', label: '[Linux]', path: '/test/path/linux' },
  { os: 'posix', label: '[macOS]', path: '/test/path/macintosh' },
  { os: 'windows', label: '[Windows]', path: 'C:\\test\\path\\windows' },
];

const ROW = 339;
const COL = 12;
const ROW_END = 341;
const COL_END = 789;
const TEST_LINKS: TestLink[] = [
  // Simple
  { link: 'foo', prefix: undefined, suffix: undefined, hasRow: false, hasCol: false },
  { link: 'foo:339', prefix: undefined, suffix: ':339', hasRow: true, hasCol: false },
  { link: 'foo:339:12', prefix: undefined, suffix: ':339:12', hasRow: true, hasCol: true },
  { link: 'foo:339:12-789', prefix: undefined, suffix: ':339:12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
  { link: 'foo:339.12', prefix: undefined, suffix: ':339.12', hasRow: true, hasCol: true },
  { link: 'foo:339.12-789', prefix: undefined, suffix: ':339.12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
  { link: 'foo:339.12-341.789', prefix: undefined, suffix: ':339.12-341.789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },
  { link: 'foo#339', prefix: undefined, suffix: '#339', hasRow: true, hasCol: false },
  { link: 'foo#339:12', prefix: undefined, suffix: '#339:12', hasRow: true, hasCol: true },
  { link: 'foo#339:12-789', prefix: undefined, suffix: '#339:12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
  { link: 'foo#339.12', prefix: undefined, suffix: '#339.12', hasRow: true, hasCol: true },
  { link: 'foo#339.12-789', prefix: undefined, suffix: '#339.12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
  { link: 'foo#339.12-341.789', prefix: undefined, suffix: '#339.12-341.789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },
  { link: 'foo 339', prefix: undefined, suffix: ' 339', hasRow: true, hasCol: false },
  { link: 'foo 339:12', prefix: undefined, suffix: ' 339:12', hasRow: true, hasCol: true },
  { link: 'foo 339:12-789', prefix: undefined, suffix: ' 339:12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
  { link: 'foo 339.12', prefix: undefined, suffix: ' 339.12', hasRow: true, hasCol: true },
  { link: 'foo 339.12-789', prefix: undefined, suffix: ' 339.12-789', hasRow: true, hasCol: true, hasRowEnd: false, hasColEnd: true },
  { link: 'foo 339.12-341.789', prefix: undefined, suffix: ' 339.12-341.789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },
  { link: 'foo, 339', prefix: undefined, suffix: ', 339', hasRow: true, hasCol: false },

  // Double quotes
  { link: '"foo",339', prefix: '"', suffix: '",339', hasRow: true, hasCol: false },
  { link: '"foo",339:12', prefix: '"', suffix: '",339:12', hasRow: true, hasCol: true },
  { link: '"foo",339.12', prefix: '"', suffix: '",339.12', hasRow: true, hasCol: true },
  { link: '"foo", line 339', prefix: '"', suffix: '", line 339', hasRow: true, hasCol: false },
  { link: '"foo", line 339, col 12', prefix: '"', suffix: '", line 339, col 12', hasRow: true, hasCol: true },
  { link: '"foo", line 339, column 12', prefix: '"', suffix: '", line 339, column 12', hasRow: true, hasCol: true },
  { link: '"foo":line 339', prefix: '"', suffix: '":line 339', hasRow: true, hasCol: false },
  { link: '"foo":line 339, col 12', prefix: '"', suffix: '":line 339, col 12', hasRow: true, hasCol: true },
  { link: '"foo":line 339, column 12', prefix: '"', suffix: '":line 339, column 12', hasRow: true, hasCol: true },
  { link: '"foo": line 339', prefix: '"', suffix: '": line 339', hasRow: true, hasCol: false },
  { link: '"foo": line 339, col 12', prefix: '"', suffix: '": line 339, col 12', hasRow: true, hasCol: true },
  { link: '"foo": line 339, column 12', prefix: '"', suffix: '": line 339, column 12', hasRow: true, hasCol: true },
  { link: '"foo" on line 339', prefix: '"', suffix: '" on line 339', hasRow: true, hasCol: false },
  { link: '"foo" on line 339, col 12', prefix: '"', suffix: '" on line 339, col 12', hasRow: true, hasCol: true },
  { link: '"foo" on line 339, column 12', prefix: '"', suffix: '" on line 339, column 12', hasRow: true, hasCol: true },
  { link: '"foo" line 339', prefix: '"', suffix: '" line 339', hasRow: true, hasCol: false },
  { link: '"foo" line 339 column 12', prefix: '"', suffix: '" line 339 column 12', hasRow: true, hasCol: true },

  // Single quotes
  { link: '\'foo\',339', prefix: '\'', suffix: '\',339', hasRow: true, hasCol: false },
  { link: '\'foo\',339:12', prefix: '\'', suffix: '\',339:12', hasRow: true, hasCol: true },
  { link: '\'foo\',339.12', prefix: '\'', suffix: '\',339.12', hasRow: true, hasCol: true },
  { link: '\'foo\', line 339', prefix: '\'', suffix: '\', line 339', hasRow: true, hasCol: false },
  { link: '\'foo\', line 339, col 12', prefix: '\'', suffix: '\', line 339, col 12', hasRow: true, hasCol: true },
  { link: '\'foo\', line 339, column 12', prefix: '\'', suffix: '\', line 339, column 12', hasRow: true, hasCol: true },
  { link: '\'foo\':line 339', prefix: '\'', suffix: '\':line 339', hasRow: true, hasCol: false },
  { link: '\'foo\':line 339, col 12', prefix: '\'', suffix: '\':line 339, col 12', hasRow: true, hasCol: true },
  { link: '\'foo\':line 339, column 12', prefix: '\'', suffix: '\':line 339, column 12', hasRow: true, hasCol: true },
  { link: '\'foo\': line 339', prefix: '\'', suffix: '\': line 339', hasRow: true, hasCol: false },
  { link: '\'foo\': line 339, col 12', prefix: '\'', suffix: '\': line 339, col 12', hasRow: true, hasCol: true },
  { link: '\'foo\': line 339, column 12', prefix: '\'', suffix: '\': line 339, column 12', hasRow: true, hasCol: true },
  { link: '\'foo\' on line 339', prefix: '\'', suffix: '\' on line 339', hasRow: true, hasCol: false },
  { link: '\'foo\' on line 339, col 12', prefix: '\'', suffix: '\' on line 339, col 12', hasRow: true, hasCol: true },
  { link: '\'foo\' on line 339, column 12', prefix: '\'', suffix: '\' on line 339, column 12', hasRow: true, hasCol: true },
  { link: '\'foo\' line 339', prefix: '\'', suffix: '\' line 339', hasRow: true, hasCol: false },
  { link: '\'foo\' line 339 column 12', prefix: '\'', suffix: '\' line 339 column 12', hasRow: true, hasCol: true },

  // No quotes
  { link: 'foo, line 339', prefix: undefined, suffix: ', line 339', hasRow: true, hasCol: false },
  { link: 'foo, line 339, col 12', prefix: undefined, suffix: ', line 339, col 12', hasRow: true, hasCol: true },
  { link: 'foo, line 339, column 12', prefix: undefined, suffix: ', line 339, column 12', hasRow: true, hasCol: true },
  { link: 'foo:line 339', prefix: undefined, suffix: ':line 339', hasRow: true, hasCol: false },
  { link: 'foo:line 339, col 12', prefix: undefined, suffix: ':line 339, col 12', hasRow: true, hasCol: true },
  { link: 'foo:line 339, column 12', prefix: undefined, suffix: ':line 339, column 12', hasRow: true, hasCol: true },
  { link: 'foo: line 339', prefix: undefined, suffix: ': line 339', hasRow: true, hasCol: false },
  { link: 'foo: line 339, col 12', prefix: undefined, suffix: ': line 339, col 12', hasRow: true, hasCol: true },
  { link: 'foo: line 339, column 12', prefix: undefined, suffix: ': line 339, column 12', hasRow: true, hasCol: true },
  { link: 'foo on line 339', prefix: undefined, suffix: ' on line 339', hasRow: true, hasCol: false },
  { link: 'foo on line 339, col 12', prefix: undefined, suffix: ' on line 339, col 12', hasRow: true, hasCol: true },
  { link: 'foo on line 339, column 12', prefix: undefined, suffix: ' on line 339, column 12', hasRow: true, hasCol: true },
  { link: 'foo line 339', prefix: undefined, suffix: ' line 339', hasRow: true, hasCol: false },
  { link: 'foo line 339 column 12', prefix: undefined, suffix: ' line 339 column 12', hasRow: true, hasCol: true },

  // Parentheses
  { link: 'foo(339)', prefix: undefined, suffix: '(339)', hasRow: true, hasCol: false },
  { link: 'foo(339,12)', prefix: undefined, suffix: '(339,12)', hasRow: true, hasCol: true },
  { link: 'foo(339, 12)', prefix: undefined, suffix: '(339, 12)', hasRow: true, hasCol: true },
  { link: 'foo (339)', prefix: undefined, suffix: ' (339)', hasRow: true, hasCol: false },
  { link: 'foo (339,12)', prefix: undefined, suffix: ' (339,12)', hasRow: true, hasCol: true },
  { link: 'foo (339, 12)', prefix: undefined, suffix: ' (339, 12)', hasRow: true, hasCol: true },
  { link: 'foo: (339)', prefix: undefined, suffix: ': (339)', hasRow: true, hasCol: false },
  { link: 'foo: (339,12)', prefix: undefined, suffix: ': (339,12)', hasRow: true, hasCol: true },
  { link: 'foo: (339, 12)', prefix: undefined, suffix: ': (339, 12)', hasRow: true, hasCol: true },
  { link: 'foo(339:12)', prefix: undefined, suffix: '(339:12)', hasRow: true, hasCol: true },
  { link: 'foo (339:12)', prefix: undefined, suffix: ' (339:12)', hasRow: true, hasCol: true },

  // Square brackets
  { link: 'foo[339]', prefix: undefined, suffix: '[339]', hasRow: true, hasCol: false },
  { link: 'foo[339,12]', prefix: undefined, suffix: '[339,12]', hasRow: true, hasCol: true },
  { link: 'foo[339, 12]', prefix: undefined, suffix: '[339, 12]', hasRow: true, hasCol: true },
  { link: 'foo [339]', prefix: undefined, suffix: ' [339]', hasRow: true, hasCol: false },
  { link: 'foo [339,12]', prefix: undefined, suffix: ' [339,12]', hasRow: true, hasCol: true },
  { link: 'foo [339, 12]', prefix: undefined, suffix: ' [339, 12]', hasRow: true, hasCol: true },
  { link: 'foo: [339]', prefix: undefined, suffix: ': [339]', hasRow: true, hasCol: false },
  { link: 'foo: [339,12]', prefix: undefined, suffix: ': [339,12]', hasRow: true, hasCol: true },
  { link: 'foo: [339, 12]', prefix: undefined, suffix: ': [339, 12]', hasRow: true, hasCol: true },
  { link: 'foo[339:12]', prefix: undefined, suffix: '[339:12]', hasRow: true, hasCol: true },
  { link: 'foo [339:12]', prefix: undefined, suffix: ' [339:12]', hasRow: true, hasCol: true },

  // OCaml-style
  { link: '"foo", line 339, character 12', prefix: '"', suffix: '", line 339, character 12', hasRow: true, hasCol: true },
  { link: '"foo", line 339, characters 12-789', prefix: '"', suffix: '", line 339, characters 12-789', hasRow: true, hasCol: true, hasColEnd: true },
  { link: '"foo", lines 339-341', prefix: '"', suffix: '", lines 339-341', hasRow: true, hasCol: false, hasRowEnd: true },
  { link: '"foo", lines 339-341, characters 12-789', prefix: '"', suffix: '", lines 339-341, characters 12-789', hasRow: true, hasCol: true, hasRowEnd: true, hasColEnd: true },

  // Non-breaking space
  { link: 'foo\u00A0339:12', prefix: undefined, suffix: '\u00A0339:12', hasRow: true, hasCol: true },
  { link: '"foo" on line 339,\u00A0column 12', prefix: '"', suffix: '" on line 339,\u00A0column 12', hasRow: true, hasCol: true },
  { link: '\'foo\' on line\u00A0339, column 12', prefix: '\'', suffix: '\' on line\u00A0339, column 12', hasRow: true, hasCol: true },
  { link: 'foo (339,\u00A012)', prefix: undefined, suffix: ' (339,\u00A012)', hasRow: true, hasCol: true },
  { link: 'foo\u00A0[339, 12]', prefix: undefined, suffix: '\u00A0[339, 12]', hasRow: true, hasCol: true },
];
const WITH_SUFFIX = TEST_LINKS.filter((link): link is TestLink & { suffix: string } => link.suffix !== undefined);

const expectedSuffix = (link: TestLink & { suffix: string }, at: number) => ({
  row: link.hasRow ? ROW : undefined,
  col: link.hasCol ? COL : undefined,
  rowEnd: link.hasRowEnd ? ROW_END : undefined,
  colEnd: link.hasColEnd ? COL_END : undefined,
  suffix: { index: at, text: link.suffix },
});

const plain = (index: number, text: string): ParsedLink => ({ path: { index, text }, prefix: undefined, suffix: undefined });
const show = (text: string): string => `\`${text.replaceAll('\u00A0', '<nbsp>')}\``;

describe('removeLinkSuffix', () => {
  it.each(TEST_LINKS)('$link', (link) => {
    expect(removeLinkSuffix(link.link)).toBe(link.suffix === undefined ? link.link : link.link.replace(link.suffix, ''));
  });
});

describe('getLinkSuffix', () => {
  it.each(TEST_LINKS)('$link', (link) => {
    expect(getLinkSuffix(link.link)).toEqual(link.suffix === undefined ? undefined : expectedSuffix({ ...link, suffix: link.suffix }, link.link.length - link.suffix.length));
  });
});

describe('detectLinkSuffixes', () => {
  it.each(TEST_LINKS)('$link', (link) => {
    expect(detectLinkSuffixes(link.link)).toEqual(link.suffix === undefined ? [] : [expectedSuffix({ ...link, suffix: link.suffix }, link.link.length - link.suffix.length)]);
  });

  it('foo(1, 2) bar[3, 4] baz on line 5', () => {
    expect(detectLinkSuffixes('foo(1, 2) bar[3, 4] baz on line 5')).toEqual([
      { row: 1, col: 2, rowEnd: undefined, colEnd: undefined, suffix: { index: 3, text: '(1, 2)' } },
      { row: 3, col: 4, rowEnd: undefined, colEnd: undefined, suffix: { index: 13, text: '[3, 4]' } },
      { row: 5, col: undefined, rowEnd: undefined, colEnd: undefined, suffix: { index: 23, text: ' on line 5' } },
    ]);
  });
});

describe('removeLinkQueryString', () => {
  it('removes any query string from the link', () => {
    expect(removeLinkQueryString('?a=b')).toBe('');
    expect(removeLinkQueryString('foo?a=b')).toBe('foo');
    expect(removeLinkQueryString('./foo?a=b')).toBe('./foo');
    expect(removeLinkQueryString('/foo/bar?a=b')).toBe('/foo/bar');
    expect(removeLinkQueryString('foo?a=b?')).toBe('foo');
    expect(removeLinkQueryString('foo?a=b&c=d')).toBe('foo');
  });

  it('keeps the ? of a UNC long path', () => {
    expect(removeLinkQueryString('\\\\?\\foo?a=b')).toBe('\\\\?\\foo');
  });
});

describe('detectLinks', () => {
  it('foo(1, 2) bar[3, 4] "baz" on line 5', () => {
    expect(detectLinks('foo(1, 2) bar[3, 4] "baz" on line 5', 'posix')).toEqual([
      { path: { index: 0, text: 'foo' }, prefix: undefined, suffix: { row: 1, col: 2, rowEnd: undefined, colEnd: undefined, suffix: { index: 3, text: '(1, 2)' } } },
      { path: { index: 10, text: 'bar' }, prefix: undefined, suffix: { row: 3, col: 4, rowEnd: undefined, colEnd: undefined, suffix: { index: 13, text: '[3, 4]' } } },
      { path: { index: 21, text: 'baz' }, prefix: { index: 20, text: '"' }, suffix: { row: 5, col: undefined, rowEnd: undefined, colEnd: undefined, suffix: { index: 24, text: '" on line 5' } } },
    ]);
  });

  it('detects several links when opening brackets are in the text', () => {
    const suffix = { row: 45, col: undefined, rowEnd: undefined, colEnd: undefined, suffix: { index: 11, text: ':45' } };
    expect(detectLinks('notlink[foo:45]', 'posix')).toEqual([
      { path: { index: 0, text: 'notlink[foo' }, prefix: undefined, suffix },
      { path: { index: 8, text: 'foo' }, prefix: undefined, suffix },
    ]);
  });

  it('extracts the link prefix', () => {
    expect(detectLinks('"foo", line 5, col 6', 'posix')).toEqual([
      { path: { index: 1, text: 'foo' }, prefix: { index: 0, text: '"' }, suffix: { row: 5, col: 6, rowEnd: undefined, colEnd: undefined, suffix: { index: 4, text: '", line 5, col 6' } } },
    ]);
  });

  it('keeps only the quote the suffix closes as the prefix when several precede the path', () => {
    expect(detectLinks('echo \'"foo", line 5, col 6\'', 'posix')).toEqual([
      { path: { index: 7, text: 'foo' }, prefix: { index: 6, text: '"' }, suffix: { row: 5, col: 6, rowEnd: undefined, colEnd: undefined, suffix: { index: 10, text: '", line 5, col 6' } } },
    ]);
  });

  it('detects suffix and suffix-less links on one line', () => {
    expect(detectLinks('PS C:\\Github\\microsoft\\vscode> echo \'"foo", line 5, col 6\'', 'windows')).toEqual([
      plain(3, 'C:\\Github\\microsoft\\vscode'),
      { path: { index: 38, text: 'foo' }, prefix: { index: 37, text: '"' }, suffix: { row: 5, col: 6, rowEnd: undefined, colEnd: undefined, suffix: { index: 41, text: '", line 5, col 6' } } },
    ]);
  });

  it('excludes pipe characters from link paths', () => {
    expect(detectLinks('|C:\\Github\\microsoft\\vscode|', 'windows')).toEqual([plain(1, 'C:\\Github\\microsoft\\vscode')]);
  });

  it('excludes pipe characters from link paths with suffixes', () => {
    expect(detectLinks('|C:\\Github\\microsoft\\vscode:400|', 'windows')).toEqual([
      { path: { index: 1, text: 'C:\\Github\\microsoft\\vscode' }, prefix: undefined, suffix: { row: 400, col: undefined, rowEnd: undefined, colEnd: undefined, suffix: { index: 27, text: ':400' } } },
    ]);
  });

  describe.each(OSES)('$label', ({ os, path }) => {
    it('excludes bracket characters from link paths', () => {
      expect(detectLinks(`<${path}<`, os)).toEqual([plain(1, path)]);
      expect(detectLinks(`>${path}>`, os)).toEqual([plain(1, path)]);
    });

    it('excludes bracket characters from link paths with suffixes', () => {
      const suffix = { row: 400, col: undefined, rowEnd: undefined, colEnd: undefined, suffix: { index: 1 + path.length, text: ':400' } };
      expect(detectLinks(`<${path}:400<`, os)).toEqual([{ path: { index: 1, text: path }, prefix: undefined, suffix }]);
      expect(detectLinks(`>${path}:400>`, os)).toEqual([{ path: { index: 1, text: path }, prefix: undefined, suffix }]);
    });

    it('excludes query strings from link paths', () => {
      expect(detectLinks(`${path}?a=b`, os)).toEqual([plain(0, path)]);
      expect(detectLinks(`${path}?a=b&c=d`, os)).toEqual([plain(0, path)]);
    });

    it('detects no link starting with ? in a query string holding POSIX or Windows paths (VS Code #204195)', () => {
      expect(detectLinks('http://foo.com/?bar=/a/b&baz=c', os).some((link) => link.path.text.startsWith('?'))).toBe(false);
      expect(detectLinks('http://foo.com/?bar=a:\\b&baz=c', os).some((link) => link.path.text.startsWith('?'))).toBe(false);
    });
  });

  describe('file names in git diffs', () => {
    it.each(['a', 'c', 'w', 'i', 'o'])('--- %s/foo/bar', (prefix) => {
      expect(detectLinks(`--- ${prefix}/foo/bar`, 'posix')).toEqual([plain(6, 'foo/bar')]);
    });

    it.each(['b', 'c', 'w', 'i', 'o'])('+++ %s/foo/bar', (prefix) => {
      expect(detectLinks(`+++ ${prefix}/foo/bar`, 'posix')).toEqual([plain(6, 'foo/bar')]);
    });

    it.each([['a', 'b'], ['c', 'w'], ['i', 'o']])('diff --git %s/foo/bar %s/foo/baz', (source, destination) => {
      expect(detectLinks(`diff --git ${source}/foo/bar ${destination}/foo/baz`, 'posix')).toEqual([plain(13, 'foo/bar'), plain(23, 'foo/baz')]);
    });

    it('numeric prefixes used by git diff --no-index', () => {
      expect(detectLinks('--- 1/foo/bar', 'posix')).toEqual([plain(6, 'foo/bar')]);
      expect(detectLinks('+++ 2/foo/baz', 'posix')).toEqual([plain(6, 'foo/baz')]);
      expect(detectLinks('diff --git 1/foo/bar 2/foo/baz', 'posix')).toEqual([plain(13, 'foo/bar'), plain(23, 'foo/baz')]);
    });

    it('reversed numeric prefixes used by git diff --no-index -R', () => {
      expect(detectLinks('--- 2/foo/baz', 'posix')).toEqual([plain(6, 'foo/baz')]);
      expect(detectLinks('+++ 1/foo/bar', 'posix')).toEqual([plain(6, 'foo/bar')]);
      expect(detectLinks('diff --git 2/foo/baz 1/foo/bar', 'posix')).toEqual([plain(13, 'foo/baz'), plain(23, 'foo/bar')]);
    });

    it('ordinary numeric line suffix', () => {
      expect(detectLinks('foo 1', 'posix')).toEqual([
        { path: { index: 0, text: 'foo' }, prefix: undefined, suffix: { row: 1, col: undefined, rowEnd: undefined, colEnd: undefined, suffix: { index: 3, text: ' 1' } } },
      ]);
    });

    it('numeric suffix followed by a path separator', () => {
      expect(detectLinks('foo 1/bar', 'posix')).toEqual([plain(4, '1/bar')]);
    });

    it('ordinary numeric line suffix after diff --git text', () => {
      expect(detectLinks('diff --git foo.ts:123', 'posix')).toEqual([
        { path: { index: 11, text: 'foo.ts' }, prefix: undefined, suffix: { row: 123, col: undefined, rowEnd: undefined, colEnd: undefined, suffix: { index: 17, text: ':123' } } },
      ]);
    });
  });

  describe('three suffix links on one line', () => {
    const cases = WITH_SUFFIX.slice(0, -2).map((first, i) => [first, WITH_SUFFIX[i + 1]!, WITH_SUFFIX[i + 2]!] as const);
    it.each(cases.map((links) => ({ name: show(` ${links.map((link) => link.link).join(' ')} `), links })))('$name', ({ links }) => {
      const line = ` ${links.map((link) => link.link).join(' ')} `;
      let at = 1;
      const expected = links.map((link): ParsedLink => {
        const start = at;
        at += link.link.length + 1;
        const prefixLength = link.prefix?.length ?? 0;
        return {
          prefix: link.prefix ? { index: start, text: link.prefix } : undefined,
          path: { index: start + prefixLength, text: link.link.replace(link.suffix, '').replace(link.prefix ?? '', '') },
          suffix: expectedSuffix(link, start + link.link.length - link.suffix.length),
        };
      });
      expect(detectLinks(line, 'posix')).toEqual(expected);
    });
  });

  // A path search that backtracks over every start position took about 240 ms per line here.
  it.each([' 1', ' :1', ' #1'])('stays linear on a long run of text followed by many %j suffixes', (suffix) => {
    const line = 'a'.repeat(1333) + suffix.repeat(Math.floor(667 / suffix.length));
    let fastest = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      detectLinks(line, 'posix');
      fastest = Math.min(fastest, performance.now() - started);
    }
    expect(fastest).toBeLessThan(25);
  });

  it('starts a suffixed path after the last space, pipe or angle bracket, skipping opening brackets', () => {
    expect(detectLinks('x|((foo.ts:3', 'posix').map((link) => [link.path.index, link.path.text])).toEqual([[4, 'foo.ts']]);
    expect(detectLinks('<file:///a/b.ts:3', 'posix').map((link) => [link.path.index, link.path.text])).toEqual([[1, 'file:///a/b.ts']]);
    expect(detectLinks('see ((( :3', 'posix')).toEqual([]);
  });

  it('ignores suffixed links whose path is the empty string', () => {
    expect(detectLinks('""",1', 'posix')).toEqual([]);
  });

  it('reads the formats compilers and tools print', () => {
    const at = (line: string): Array<{ path: string; row: number | undefined; col: number | undefined }> => detectLinks(line, 'posix').map((link) => ({ path: link.path.text, row: link.suffix?.row, col: link.suffix?.col }));
    expect(at('src/app.ts:42:7')).toEqual([{ path: 'src/app.ts', row: 42, col: 7 }]);
    expect(at('src/app.ts(42,7): error TS2304')).toEqual([{ path: 'src/app.ts', row: 42, col: 7 }]);
    expect(at('  File "src/app.py", line 42, in <module>')).toEqual([{ path: 'src/app.py', row: 42, col: undefined }]);
    expect(at('  --> src/main.rs:42:7')).toEqual([{ path: 'src/main.rs', row: 42, col: 7 }]);
    expect(at('src/app.ts:42.7')).toEqual([{ path: 'src/app.ts', row: 42, col: 7 }]);
  });
});
