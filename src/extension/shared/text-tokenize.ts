/** Consolidated stopword set for memory/FTS tokenization. Canonical home. */
export const MEMORY_FTS_STOPWORDS: Set<string> = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it', 'for',
  'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at', 'this', 'but',
  'his', 'by', 'from', 'they', 'we', 'her', 'she', 'or', 'an', 'will',
  'my', 'one', 'all', 'would', 'there', 'their', 'what', 'so', 'up',
  'if', 'about', 'who', 'get', 'which', 'go', 'me', 'when', 'make',
  'can', 'like', 'no', 'just', 'him', 'know', 'take', 'into', 'your',
  'some', 'could', 'them', 'see', 'other', 'than', 'then', 'now', 'its',
  'also', 'after', 'how', 'our', 'two', 'way', 'did', 'has', 'am', 'is',
  'are', 'was', 'were', 'been', 'being', 'had', 'does', 'done', 'should',
  'help', 'please', 'want', 'need',
]);

/**
 * Lowercases and splits on every run of non-alphanumeric characters, then drops short and stopword
 * tokens. The split mirrors the FTS5 `unicode61` tokenizer's word boundaries exactly: unicode61
 * treats every character outside the Unicode letter/number classes — `.`, `_`, `-`, `/`, etc. — as a
 * separator, so `app/Http` indexes as the two terms `app` + `http`. The query side MUST split
 * identically; deleting the separator instead (`app/http` → `apphttp`) produces a term that exists in
 * no document and silently matches nothing. Unicode-aware so non-Latin scripts survive. Tokens are
 * not porter-stemmed (FTS5 stems the MATCH terms itself); the raw tokens are a lexical approximation
 * for Jaccard dedup.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u)
    .filter(t => t.length > 1 && !MEMORY_FTS_STOPWORDS.has(t));
}

/**
 * Builds an SQLite FTS5 MATCH query from free text: tokenizes, caps to the
 * first `maxTokens` tokens, and OR-joins quoted tokens. Returns null when no
 * tokens survive.
 */
export function buildFtsMatchQuery(text: string, maxTokens: number = 32): string | null {
  const capped = tokenize(text).slice(0, maxTokens);
  if (capped.length === 0) return null;
  return capped.map(t => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}
