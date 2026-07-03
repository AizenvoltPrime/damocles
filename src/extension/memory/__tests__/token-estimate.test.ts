import { describe, it, expect } from 'vitest';
import { estimateTokens, truncateToChars, isCjkCodePoint } from '../token-estimate';

describe('estimateTokens', () => {
  it('estimates CJK text higher than equal-length latin text', () => {
    // Equal code-point length: CJK ~1 token/char, latin ~0.25/char.
    const cjk = '日本語漢字仮'; // 6 code points → 6 tokens
    const latin = 'abcdef'; // 6 code points → ceil(1.5) = 2 tokens
    expect([...cjk].length).toBe([...latin].length);
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens(latin));
    expect(estimateTokens(cjk)).toBe(6);
  });

  it('estimates a pure-latin string at ceil(len / 4)', () => {
    const s = 'the quick brown fox'; // 19 chars → ceil(4.75) = 5
    expect(estimateTokens(s)).toBe(Math.ceil(s.length / 4));
    expect(estimateTokens('a'.repeat(40))).toBe(10); // 40 * 0.25 = 10
  });

  it('returns 0 for an empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts an astral emoji as a single code point, not two chars', () => {
    // One code point (U+1F600) but text.length === 2 → weighted as one non-CJK char → ceil(0.25) = 1.
    expect(estimateTokens('😀')).toBe(1);
    expect('😀'.length).toBe(2);
  });
});

describe('truncateToChars', () => {
  it('never splits a surrogate pair when the cut lands mid-pair', () => {
    // Each is 2 UTF-16 units but 1 code point; a naive slice(0, 3) would split the second emoji.
    const emojis = '😀😀😀'; // 3 code points, 6 UTF-16 units
    const result = truncateToChars(emojis, 2);
    expect([...result].length).toBe(2);
    expect(result).toBe('😀😀');
    // No lone/unpaired surrogate.
    for (const ch of result) {
      const cp = ch.codePointAt(0)!;
      expect(cp < 0xd800 || cp > 0xdfff).toBe(true);
    }
    expect([...result].join('')).toBe(result);
  });

  it('truncates mixed latin + astral text on a code-point boundary', () => {
    const mixed = 'ab😀cd'; // code points: a,b,😀,c,d
    expect(truncateToChars(mixed, 3)).toBe('ab😀');
    expect([...truncateToChars(mixed, 3)].length).toBe(3);
  });

  it('returns the input unchanged when maxChars >= code-point length', () => {
    const s = 'hello 😀 world';
    expect(truncateToChars(s, [...s].length)).toBe(s);
    expect(truncateToChars(s, 999)).toBe(s);
    expect(truncateToChars('', 5)).toBe('');
  });
});

describe('isCjkCodePoint', () => {
  it('classifies representative CJK / full-width code points as CJK', () => {
    expect(isCjkCodePoint('あ'.codePointAt(0)!)).toBe(true); // Hiragana
    expect(isCjkCodePoint('カ'.codePointAt(0)!)).toBe(true); // Katakana
    expect(isCjkCodePoint('漢'.codePointAt(0)!)).toBe(true); // CJK ideograph
    expect(isCjkCodePoint('한'.codePointAt(0)!)).toBe(true); // Hangul
    expect(isCjkCodePoint('Ａ'.codePointAt(0)!)).toBe(true); // Full-width A (U+FF21)
    expect(isCjkCodePoint(0x3400)).toBe(true); // CJK Ext-A start
    expect(isCjkCodePoint(0x20000)).toBe(true); // astral ideograph extension
  });

  it('classifies latin and common emoji as non-CJK', () => {
    expect(isCjkCodePoint('a'.codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint('Z'.codePointAt(0)!)).toBe(false);
    expect(isCjkCodePoint('😀'.codePointAt(0)!)).toBe(false); // U+1F600 is not an ideograph
  });
});
