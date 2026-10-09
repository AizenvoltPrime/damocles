import { describe, expect, it } from 'vitest';
import { compareScoredItems, parseQuickOpenQuery, prepareQuery, scoreFuzzy, scoreItem, type FuzzyItem } from '../fuzzy-match';

function item(relativePath: string): FuzzyItem {
  const slash = relativePath.lastIndexOf('/');
  return { label: relativePath.slice(slash + 1), description: slash < 0 ? '' : relativePath.slice(0, slash), path: relativePath };
}

function rank(paths: readonly string[], query: string): string[] {
  const prepared = prepareQuery(query);
  return paths
    .map((p) => ({ item: item(p), score: scoreItem(item(p), prepared) }))
    .filter((entry) => entry.score.score > 0)
    .sort((a, b) => compareScoredItems(a.item, a.score, b.item, b.score, prepared))
    .map((entry) => entry.item.path);
}

describe('scoreFuzzy', () => {
  it('matches in order only', () => {
    expect(scoreFuzzy('abc', 'ca', 'ca', true)[0]).toBe(0);
    expect(scoreFuzzy('abc', 'ac', 'ac', true)[1]).toEqual([0, 2]);
  });

  it('refuses a gap when non-contiguous matches are off', () => {
    expect(scoreFuzzy('abc', 'ac', 'ac', false)[0]).toBe(0);
    expect(scoreFuzzy('xabc', 'ab', 'ab', false)[1]).toEqual([1, 2]);
  });

  it('scores a contiguous run above the same characters spread out', () => {
    expect(scoreFuzzy('abcx', 'abc', 'abc', true)[0]).toBeGreaterThan(scoreFuzzy('axbxc', 'abc', 'abc', true)[0]);
  });

  it('gives start-of-word, separator, camel case and same-case bonuses', () => {
    // 'b' after '/' beats 'b' inside a word
    expect(scoreFuzzy('a/b', 'b', 'b', true)[0]).toBeGreaterThan(scoreFuzzy('ab', 'b', 'b', true)[0]);
    // '/' scores above '_'
    expect(scoreFuzzy('a/b', 'b', 'b', true)[0]).toBeGreaterThan(scoreFuzzy('a_b', 'b', 'b', true)[0]);
    expect(scoreFuzzy('aB', 'b', 'b', true)[0]).toBeGreaterThan(scoreFuzzy('ab', 'b', 'b', true)[0]);
    expect(scoreFuzzy('b', 'b', 'b', true)[0]).toBeGreaterThan(scoreFuzzy('B', 'b', 'b', true)[0]);
    expect(scoreFuzzy('bx', 'b', 'b', true)[0]).toBeGreaterThan(scoreFuzzy('xxb', 'b', 'b', true)[0]);
  });

  it('treats / and \\ in the query as equal', () => {
    expect(scoreFuzzy('a/b', 'a\\b', 'a\\b', true)[1]).toEqual([0, 1, 2]);
  });
});

describe('scoreItem and compareScoredItems', () => {
  it('ranks a label prefix above a label match above a path-only match', () => {
    expect(rank(['src/xmain.ts', 'src/main.ts', 'main/other.ts'], 'main')).toEqual(['src/main.ts', 'src/xmain.ts', 'main/other.ts']);
  });

  it('returns label and description ranges split at the folder separator', () => {
    const score = scoreItem(item('src/core/a.ts'), prepareQuery('core/a'));
    expect(score.descriptionMatches).toEqual([[4, 9]]);
    expect(score.labelMatches).toEqual([[0, 1]]);
  });

  it('marks a label prefix as one range', () => {
    expect(scoreItem(item('src/fuzzy-match.ts'), prepareQuery('fuzzy')).labelMatches).toEqual([[0, 5]]);
  });

  it('puts an exact path first', () => {
    expect(rank(['b/a.ts', 'a.ts', 'x/a.ts/a.ts'], 'b/a.ts')[0]).toBe('b/a.ts');
  });

  it('requires every space-separated piece to match', () => {
    expect(rank(['src/core/a.ts', 'src/web/a.ts'], 'a core')).toEqual(['src/core/a.ts']);
  });

  it('matches a quoted piece contiguously only', () => {
    expect(rank(['src/abc.ts', 'src/axbxc.ts'], '"abc"')).toEqual(['src/abc.ts']);
  });

  it('prefers the shorter label among equal label scores', () => {
    expect(rank(['a/indexer.ts', 'a/index.ts'], 'index')).toEqual(['a/index.ts', 'a/indexer.ts']);
  });

  it('matches nothing for an empty query', () => {
    expect(scoreItem(item('a.ts'), prepareQuery('  ')).score).toBe(0);
  });
});

describe('parseQuickOpenQuery', () => {
  it.each([
    ['a.ts:12', { filter: 'a.ts', line: 12, mention: false }],
    ['a.ts#7', { filter: 'a.ts', line: 7, mention: false }],
    ['a.ts:12:4', { filter: 'a.ts', line: 12, mention: false }],
    ['a.ts(3)', { filter: 'a.ts', line: 3, mention: false }],
    ['a.ts:', { filter: 'a.ts', mention: false }],
    ['@src/a', { filter: 'src/a', mention: true }],
    ['@a.ts:9', { filter: 'a.ts', line: 9, mention: true }],
    ['a.ts:0', { filter: 'a.ts', mention: false }],
    ['a.ts:99999999999', { filter: 'a.ts', mention: false }],
    ['plain', { filter: 'plain', mention: false }],
  ])('parses %s', (query, expected) => {
    expect(parseQuickOpenQuery(query)).toEqual(expected);
  });
});
