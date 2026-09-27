import { describe, it, expect } from 'vitest';
import { highlightTerms } from '../highlight-terms';

const hits = (text: string, terms: string[]) => highlightTerms(text, terms).filter((s) => s.hit).map((s) => s.text);

describe('highlightTerms', () => {
  it('marks whole words that start with a term, case-insensitively', () => {
    expect(hits('Run Vitest via PowerShell; vitest.config.ts too', ['vitest', 'powershell'])).toEqual(['Vitest', 'PowerShell', 'vitest']);
  });

  it('matches only at the start of a word', () => {
    expect(hits('unittest pretest testing', ['test'])).toEqual(['testing']);
  });

  it('keeps every character, in order, across the segments', () => {
    const text = 'a/b.ts: vitest -- vitesse!';
    expect(highlightTerms(text, ['vit']).map((s) => s.text).join('')).toBe(text);
  });

  it('alternates plain and hit segments, never two of a kind in a row', () => {
    const segments = highlightTerms('alpha beta gamma', ['alpha', 'gamma']);
    expect(segments).toEqual([
      { text: 'alpha', hit: true },
      { text: ' beta ', hit: false },
      { text: 'gamma', hit: true },
    ]);
  });

  it('handles non-Latin words and ignores diacritics, as the FTS tokenizer does', () => {
    expect(hits('Η μνήμη μνημονεύει', ['ΜΝΗΜ'])).toEqual(['μνήμη', 'μνημονεύει']);
    expect(hits('cafe café', ['café'])).toEqual(['cafe', 'café']);
  });

  it('returns the text as one plain segment when no term applies', () => {
    expect(highlightTerms('nothing here', [])).toEqual([{ text: 'nothing here', hit: false }]);
    expect(highlightTerms('nothing here', ['', 'zzz'])).toEqual([{ text: 'nothing here', hit: false }]);
    expect(highlightTerms('', ['a'])).toEqual([]);
  });

  it('stays linear on a long input', () => {
    const text = 'ab '.repeat(50_000);
    const start = performance.now();
    const segments = highlightTerms(text, ['ab']);
    expect(performance.now() - start).toBeLessThan(500);
    expect(segments.filter((s) => s.hit)).toHaveLength(50_000);
  });
});
