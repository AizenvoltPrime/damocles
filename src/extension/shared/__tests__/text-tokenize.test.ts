import { describe, it, expect } from 'vitest';
import { tokenize, buildFtsMatchQuery } from '../text-tokenize';

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

describe('buildFtsMatchQuery', () => {
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
});
