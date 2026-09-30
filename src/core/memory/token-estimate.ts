/**
 * Surrogate-safe, CJK-aware token estimation and truncation. Shared so display truncation and budget
 * math agree on one definition of "a token" and never split a surrogate pair. Cheap model: CJK/
 * full-width code points ≈ 1 token, everything else ≈ 0.25.
 */

/** True when `cp` is a CJK/full-width code point a tokenizer would weight as ~1 token. */
export function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols and punctuation
    (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Unified Ideographs Extension A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
    (cp >= 0xac00 && cp <= 0xd7af) || // Hangul syllables
    (cp >= 0xff00 && cp <= 0xffef) || // Full-width / half-width forms
    cp >= 0x20000 // Astral CJK ideograph extensions (Ext B and beyond)
  );
}

/**
 * Estimate the token count of `text`, iterating by code point (not `text.length`, which would split
 * surrogate pairs and double-count astral chars). CJK/full-width add +1, everything else +0.25.
 */
export function estimateTokens(text: string): number {
  let sum = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    sum += isCjkCodePoint(cp) ? 1 : 0.25;
  }
  return Math.ceil(sum);
}

/**
 * Truncate `text` to at most `maxChars` code points, cutting on a code-point boundary so a surrogate
 * pair is never split into a lone surrogate.
 */
export function truncateToChars(text: string, maxChars: number): string {
  const codePoints = [...text];
  if (codePoints.length <= maxChars) {
    return text;
  }
  return codePoints.slice(0, maxChars).join('');
}
