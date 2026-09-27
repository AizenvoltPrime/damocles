import { describe, it, expect } from 'vitest';
import { tokenize, buildFtsMatchQuery, extractMemoryIds, queryTerms, stripEnglishClitics } from '../text-tokenize';

describe('tokenize', () => {
  it('drops stopwords, short tokens, and punctuation-only tokens', () => {
    expect(tokenize('the and is of a I')).toEqual([]);
    expect(tokenize('!!! ??? --- ...')).toEqual([]);
  });

  it('strips outer punctuation before the stopword filter', () => {
    expect(tokenize('the, and, of!')).toEqual([]);
    expect(tokenize('(esbuild) [bundler]')).toEqual(['esbuild', 'bundler']);
  });

  it('preserves non-Latin scripts to match the unicode61 tokenizer', () => {
    expect(tokenize('ελληνικά κείμενο')).toEqual(['ελληνικά', 'κείμενο']);
    expect(tokenize('日本語 のテスト')).toEqual(['日本語', 'のテスト']);
  });

  it('splits identifier punctuation the way unicode61 does, so paths match the FTS index', () => {
    expect(tokenize('main.ts user_name')).toEqual(['main', 'ts', 'user', 'name']);
    expect(tokenize('app/Http')).toEqual(['app', 'http']);
  });
});

describe('buildFtsMatchQuery path tokens', () => {
  it('splits a slashed path into separately-matchable terms (regression: apphttp matched nothing)', () => {
    expect(buildFtsMatchQuery('List the files in app/Http')).toBe('"list" OR "files" OR "app" OR "http"');
  });
});

describe('extractMemoryIds', () => {
  it('returns distinct lowercase UUIDs in first-seen order', () => {
    const a = '985d5b12-ff9a-499f-922c-5dcdf2e9a8fe';
    const b = '00b6ebee-316e-4e01-be61-7838683f9a27';
    expect(extractMemoryIds(`see ${a.toUpperCase()} and ${b}, then ${a}`)).toEqual([a, b]);
    expect(extractMemoryIds('no ids here')).toEqual([]);
  });
});

describe('queryTerms', () => {
  it('drops UUID fragments and git SHAs but keeps short hex words and numbers', () => {
    const { terms, dropped } = queryTerms(
      'fix 985d5b12-ff9a-499f-922c-5dcdf2e9a8fe from commit 5d1c426a9f and cafe 2024',
    );
    expect(terms).toEqual(['fix', 'commit', 'cafe', '2024']);
    expect(dropped).toEqual([
      { term: '985d5b12-ff9a-499f-922c-5dcdf2e9a8fe', reason: 'id' },
      { term: '5d1c426a9f', reason: 'id' },
    ]);
  });

  it('deduplicates terms, keeping first-seen order', () => {
    expect(queryTerms('vitest config vitest Config tests').terms).toEqual(['vitest', 'config', 'tests']);
  });

  it('keeps an all-letter hex word such as deadbeef', () => {
    expect(queryTerms('deadbeef facade').terms).toEqual(['deadbeef', 'facade']);
  });

  it('caps at maxTerms distinct terms', () => {
    expect(queryTerms('a1 b1 a1 c1 d1', 3).terms).toEqual(['a1', 'b1', 'c1']);
  });
});

describe('buildFtsMatchQuery', () => {
  it('omits id fragments and duplicate terms', () => {
    expect(buildFtsMatchQuery('985d5b12-ff9a-499f-922c-5dcdf2e9a8fe alpha alpha')).toBe('"alpha"');
  });

  it('returns null when no tokens survive', () => {
    expect(buildFtsMatchQuery('the and is of')).toBeNull();
    expect(buildFtsMatchQuery('   ')).toBeNull();
  });

  it('reduces a SQL-injection string to safe quoted tokens', () => {
    const query = buildFtsMatchQuery("'; DROP TABLE memories; --");
    expect(query).toBe('"drop" OR "table" OR "memories"');
    expect(query).not.toContain(';');
    expect(query).not.toContain('--');
  });

  it('OR-joins quoted tokens', () => {
    expect(buildFtsMatchQuery('alpha beta')).toBe('"alpha" OR "beta"');
  });

  it('caps the token count to maxTokens', () => {
    expect(buildFtsMatchQuery('alpha beta gamma delta', 2)).toBe('"alpha" OR "beta"');
  });

  it('keeps SHAs and UUID fragments for a search that asks for them', () => {
    expect(buildFtsMatchQuery('commit 5d1c426a9f 5d1c426a9f', undefined, { keepIds: true })).toBe('"commit" OR "5d1c426a9f"');
    expect(buildFtsMatchQuery('985d5b12-ff9a-499f-922c-5dcdf2e9a8fe', 2, { keepIds: true })).toBe('"985d5b12" OR "ff9a"');
  });
});

describe('stripEnglishClitics', () => {
  it('drops negative contractions whole and other clitics from their host word', () => {
    expect(queryTerms(stripEnglishClitics("it doesn't load, we'll retry the user's cache; can’t stop")).terms).toEqual([
      'load',
      'retry',
      'user',
      'cache',
      'stop',
    ]);
  });

  it('leaves quoted letters and identifiers alone', () => {
    expect(stripEnglishClitics("press 'd' then 's3' and o'clock")).toBe("press 'd' then 's3' and o'clock");
  });

  it('runs in linear time on a long run of letters', () => {
    const run = 'ACGT'.repeat(100_000);
    const start = performance.now();
    expect(stripEnglishClitics(`${run} doesn't`)).toBe(`${run}  `);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
