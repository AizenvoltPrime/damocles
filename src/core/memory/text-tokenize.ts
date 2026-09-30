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

// A negative contraction is always an auxiliary, so it goes whole; other clitics leave their host word.
// The lookbehind anchors the first alternative at the start of a letter run, which keeps it linear-time.
const ENGLISH_CLITIC = /(?<!\p{L})\p{L}+n['\u2019]t(?![\p{L}\p{N}])|(?<=\p{L})['\u2019](?:s|d|m|ll|re|ve)(?![\p{L}\p{N}])/giu;

/**
 * Removes English contractions before tokenizing, which would otherwise split `doesn't` into the
 * non-word `doesn` and `we'll` into `we` plus `ll`.
 */
export function stripEnglishClitics(text: string): string {
  return text.replace(ENGLISH_CLITIC, ' ');
}

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const HEX_ID_PATTERN = /^[0-9a-f]{7,}$/;

/** Distinct lowercase UUIDs in `text`, in first-seen order. */
export function extractMemoryIds(text: string): string[] {
  return [...new Set((text.match(UUID_PATTERN) ?? []).map(id => id.toLowerCase()))];
}

function isHexId(token: string): boolean {
  return HEX_ID_PATTERN.test(token) && /\d/.test(token) && /[a-f]/.test(token);
}

export interface QueryTerms {
  terms: string[];
  dropped: Array<{ term: string; reason: 'id' }>;
}

/**
 * Retrieval terms for a prompt: UUIDs are removed before tokenizing (their dash-separated fragments
 * would otherwise become terms), all-hex tokens of 7+ chars mixing digits and letters (git SHAs,
 * short ids) are dropped, and the rest is deduplicated in order and capped at `maxTerms`.
 */
export function queryTerms(text: string, maxTerms: number = 32): QueryTerms {
  const dropped: QueryTerms['dropped'] = [];
  const seenDropped = new Set<string>();
  for (const id of extractMemoryIds(text)) {
    seenDropped.add(id);
    dropped.push({ term: id, reason: 'id' });
  }
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(text.replace(UUID_PATTERN, ' '))) {
    if (isHexId(token)) {
      if (!seenDropped.has(token)) {
        seenDropped.add(token);
        dropped.push({ term: token, reason: 'id' });
      }
      continue;
    }
    if (seen.has(token)) continue;
    seen.add(token);
    terms.push(token);
    if (terms.length === maxTerms) break;
  }
  return { terms, dropped };
}

export function quoteFtsTerm(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/**
 * Builds an SQLite FTS5 MATCH query from free text: `queryTerms`, capped to `maxTokens`, OR-joined
 * as quoted terms. Returns null when no terms survive. `keepIds` keeps UUID fragments and hex ids,
 * for a user search where the id is what is being looked for.
 */
export function buildFtsMatchQuery(text: string, maxTokens: number = 32, options: { keepIds?: boolean } = {}): string | null {
  const terms = options.keepIds ? [...new Set(tokenize(text))].slice(0, maxTokens) : queryTerms(text, maxTokens).terms;
  if (terms.length === 0) return null;
  return terms.map(quoteFtsTerm).join(' OR ');
}
