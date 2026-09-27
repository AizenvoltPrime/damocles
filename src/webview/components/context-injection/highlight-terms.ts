export interface HighlightSegment {
  text: string;
  hit: boolean;
}

// Mirrors the FTS5 unicode61 tokenizer: its word boundaries, and matching with diacritics removed.
const WORD_PATTERN = /[\p{L}\p{N}]+/gu;
const MARKS = /\p{M}+/gu;

function fold(value: string): string {
  return value.normalize('NFD').replace(MARKS, '').toLowerCase();
}

/**
 * Splits `text` into segments, marking every word that starts with one of `terms`, ignoring case and diacritics.
 * Adjacent segments of the same kind are merged, so the output alternates hit and plain text.
 */
export function highlightTerms(text: string, terms: readonly string[]): HighlightSegment[] {
  const prefixes = [...new Set(terms.map(fold).filter((term) => term.length > 0))];
  if (text.length === 0) return [];
  if (prefixes.length === 0) return [{ text, hit: false }];

  const segments: HighlightSegment[] = [];
  const push = (value: string, hit: boolean): void => {
    if (value.length === 0) return;
    const last = segments[segments.length - 1];
    if (last && last.hit === hit) last.text += value;
    else segments.push({ text: value, hit });
  };

  let cursor = 0;
  for (const match of text.matchAll(WORD_PATTERN)) {
    const word = match[0];
    const folded = fold(word);
    if (!prefixes.some((prefix) => folded.startsWith(prefix))) continue;
    push(text.slice(cursor, match.index), false);
    push(word, true);
    cursor = match.index + word.length;
  }
  push(text.slice(cursor), false);
  return segments;
}
