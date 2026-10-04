import type { InjectionTier, MemoryScoreBreakdown } from '@shared/types/context-injection';
import type { MemoryScope } from '@shared/types/memory';
import { SCORE_WEIGHTS } from '@shared/memory-score';
import { STALENESS_THRESHOLD } from '@shared/memory-staleness';
import { porterStem } from '../porter-stem';
import { ENGLISH_REFERENCE_STEMS, SOFTWARE_REFERENCE_STEMS } from './reference-stems.generated';

/** Relevance gate constants, calibrated on the replay harness and pinned by `injection-gate.test.ts`. */
export const GATE = {
  commonDfMin: 20,
  commonDfFraction: 0.05,
  /** Reference ranks 1 to this are core vocabulary and count as common. */
  coreVocabularyRank: 1000,
  /** In-store rarity: decides distinctiveness for identifiers, other scripts and non-English prompts. */
  rareDfMin: 3,
  rareDfFraction: 0.005,
  /** Shortest letters-plus-digits identifier that can be distinctive; `s3` or `v2` alone names no subject. */
  identifierMinLength: 3,
  /** Fewest words a prompt needs before it can be judged not English; one or two jargon words are not a language. */
  languageMinWords: 3,
  /** A distinctive-term hit must still carry this share of the query's idf, so one stray token in a long paste does not pass. */
  distinctiveMinRelevance: 0.1,
  /** Without a distinctive term, a memory must match every topical term of a prompt with up to `coverageTerms` of them, else that many. */
  coverageTerms: 3,
  /** Fewest topical terms a prompt without a distinctive term needs to admit anything. */
  coverageMinTerms: 2,
  coverageMinRelevance: 0.5,
  /** Below this relevance a gated entry renders compact even when it ranks into the full tier. */
  fullMinRelevance: 0.4,
} as const;

/** Per-context token budgets for the ungated rules and notices. Pinned and profile come from settings. */
export const BUDGETS = {
  sessionTokens: 500,
  preferenceTokens: 600,
  preferenceChars: 400,
  noticeTokens: 600,
  maxNotices: 10,
} as const;

export const DEFAULT_TIER_LIMITS = { full: 4, compact: 8, tokenBudget: 2000 } as const;

export const FILE_PROXIMITY_FULL = 1;
export const FILE_PROXIMITY_PARTIAL = 0.4;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const RETRIEVAL_BOOST_DENOMINATOR = Math.log2(11);

export function commonDfThreshold(n: number): number {
  return Math.max(GATE.commonDfMin, GATE.commonDfFraction * n);
}

export function rareDfThreshold(n: number): number {
  return Math.max(GATE.rareDfMin, Math.ceil(GATE.rareDfFraction * n));
}

export function inverseDocumentFrequency(n: number, df: number): number {
  return Math.log(1 + n / df);
}

let stemRanks: Map<string, number> | null = null;

function buildStemRanks(): Map<string, number> {
  const ranks = new Map<string, number>();
  const english = ENGLISH_REFERENCE_STEMS.split(/\s+/).filter(Boolean);
  english.forEach((stem, i) => {
    if (!ranks.has(stem)) ranks.set(stem, i + 1);
  });
  // The software list is unranked, so its words rank after every English word.
  for (const stem of SOFTWARE_REFERENCE_STEMS.split(/\s+/).filter(Boolean)) {
    if (!ranks.has(stem)) ranks.set(stem, english.length + 1);
  }
  return ranks;
}

/**
 * 1-based general-vocabulary rank of `term`, or 0 when it is not listed. A term is looked up by its
 * Porter stem, the form its FTS match searches, and takes the rank of the most frequent reference
 * word sharing that stem, so `summarization` ranks with `summarize`.
 */
export function vocabularyRank(term: string): number {
  stemRanks ??= buildStemRanks();
  return stemRanks.get(porterStem(term)) ?? 0;
}

/** The reference only judges words in its own alphabet; any other script keeps the in-store rarity rule. */
const REFERENCE_ALPHABET = /^[a-z]+$/;
const WORD = /^\p{L}+$/u;
const LEADING_LETTER = /^\p{L}/u;

/**
 * `word`: letters only, any script. `identifier`: starts with a letter and holds a digit (`oauth2`,
 * `es2022`, `h264`). `other`: numbers, digit-led mixes such as timestamp pieces (`26t18`, `440z`) and
 * two-character mixes; they add relevance but never pass a rule. Tokens hold only letters and digits.
 */
function termShape(term: string): 'word' | 'identifier' | 'other' {
  if (WORD.test(term)) return 'word';
  if (term.length >= GATE.identifierMinLength && LEADING_LETTER.test(term)) return 'identifier';
  return 'other';
}

/** Most of the prompt's words miss the English reference, so it cannot judge them. */
function isNonEnglishPrompt(terms: readonly string[]): boolean {
  const words = terms.filter(t => WORD.test(t));
  const misses = words.filter(t => vocabularyRank(t) === 0).length;
  return words.length >= GATE.languageMinWords && misses * 2 > words.length;
}

export interface TermStat {
  term: string;
  df: number;
  idf: number;
  /** Specific enough to admit a memory on its own. */
  distinctive: boolean;
  topical: boolean;
}

export interface TermAnalysis {
  /** Terms that match at least one visible memory and are not common, in query order. */
  usable: TermStat[];
  common: string[];
  /** Terms that match no visible memory; they carry no signal and are left out of `queryIdf`. */
  unmatched: string[];
  queryIdf: number;
}

/**
 * Common: frequent in the store, or core English vocabulary. Distinctive: an `[a-z]+` word absent from
 * the English reference, which must also be rare in the store when the prompt is not English; a word in
 * another script or an identifier, when rare in the store. Everything else is general: it counts toward
 * coverage but never admits a memory alone.
 */
export function analyzeTerms(terms: readonly string[], dfByTerm: ReadonlyMap<string, number>, n: number): TermAnalysis {
  const common: string[] = [];
  const unmatched: string[] = [];
  const usable: TermStat[] = [];
  const commonAbove = commonDfThreshold(n);
  const rareAtMost = rareDfThreshold(n);
  const nonEnglish = isNonEnglishPrompt(terms);
  const stems = new Set<string>();
  for (const term of terms) {
    // Terms sharing a Porter stem run the same FTS match, so only the first counts.
    const stem = porterStem(term);
    if (stems.has(stem)) continue;
    stems.add(stem);
    const df = dfByTerm.get(term) ?? 0;
    const rank = vocabularyRank(term);
    if (df > commonAbove || (rank > 0 && rank <= GATE.coreVocabularyRank)) common.push(term);
    else if (df === 0) unmatched.push(term);
    else {
      const shape = termShape(term);
      const topical = shape !== 'other';
      const rare = df <= rareAtMost;
      const distinctive =
        shape === 'word' && REFERENCE_ALPHABET.test(term) ? rank === 0 && (rare || !nonEnglish) : topical && rare;
      usable.push({ term, df, idf: inverseDocumentFrequency(n, df), distinctive, topical });
    }
  }
  return { usable, common, unmatched, queryIdf: usable.reduce((sum, t) => sum + t.idf, 0) };
}

export interface LexicalMatch {
  passed: boolean;
  /** Passed on a distinctive term at `fullMinRelevance`; any other gated entry renders compact at most. */
  fullAllowed: boolean;
  matchedTerms: string[];
  relevance: number;
  matchedIdf: number;
  queryIdf: number;
}

/**
 * Gate rule 5. A query with a distinctive term admits only memories that match one; its general
 * terms add relevance but never admit alone. A query without one admits a memory that matches all its
 * topical terms, or `coverageTerms` of them when it has more, carrying at least `coverageMinRelevance`
 * of the query's idf, and renders it compact: ordinary words together are weaker evidence than a name.
 */
export function evaluateLexical(matched: ReadonlySet<string>, analysis: TermAnalysis): LexicalMatch {
  const hits = analysis.usable.filter(t => matched.has(t.term));
  const matchedIdf = hits.reduce((sum, t) => sum + t.idf, 0);
  const relevance = analysis.queryIdf > 0 ? matchedIdf / analysis.queryIdf : 0;
  const distinctive = analysis.usable.some(t => t.distinctive);
  const required = Math.min(analysis.usable.filter(t => t.topical).length, GATE.coverageTerms);
  const passed = distinctive
    ? hits.some(t => t.distinctive) && relevance >= GATE.distinctiveMinRelevance
    : required >= GATE.coverageMinTerms &&
      hits.filter(t => t.topical).length >= required &&
      relevance >= GATE.coverageMinRelevance;
  const fullAllowed = passed && distinctive && relevance >= GATE.fullMinRelevance;
  return { passed, fullAllowed, matchedTerms: hits.map(t => t.term), relevance, matchedIdf, queryIdf: analysis.queryIdf };
}

const LEADING_PUNCTUATION = new Set(['"', "'", '`', '(', '[', '{', '<']);
const TRAILING_PUNCTUATION = new Set(['"', "'", '`', ')', ']', '}', '>', ',', ';', ':', '!', '?', '.']);
const LINE_SUFFIX = /:\d+(?::\d+)?$/;
// At least one character before the extension, so a dot-directory like `~/.damocles` is not a file.
const FILE_EXTENSION = /.\.[A-Za-z0-9]{1,10}$/;
const MAX_TYPED_PATHS = 10;

function trimEdges(token: string): string {
  let start = 0;
  let end = token.length;
  while (start < end && LEADING_PUNCTUATION.has(token[start]!)) start++;
  while (end > start && TRAILING_PUNCTUATION.has(token[end - 1]!)) end--;
  return token.slice(start, end);
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
// A drive, root, home or relative prefix, or any backslash; `app/Http` and `and/or` stay words.
const ROOTED_PATH = /^(?:[A-Za-z]:[\\/]|[\\/]|~[\\/]|\.\.?[\\/])|\\/;
const MIN_UNROOTED_DIRECTORY_SEGMENTS = 3;

/** The non-empty segments of a token with a path separator that is not a URL, else null. */
function pathSegments(token: string): string[] | null {
  if ((!token.includes('/') && !token.includes('\\')) || URL_SCHEME.test(token)) return null;
  return token.split(/[\\/]/).filter(Boolean);
}

// Letter-led, so a version such as `2.36.0` keeps its last part.
const BARE_FILE_NAME = /^([^\\/]+)\.[A-Za-z][A-Za-z0-9]{0,9}$/;

export interface PromptPaths {
  /** The prompt without its file paths, each directory path cut to its last segment and each bare file name to its name. */
  text: string;
  /** Typed paths for the file gate, deduplicated case-insensitively. */
  paths: string[];
}

/**
 * Takes the paths a prompt types off its query words. Parent directories locate a subject rather than
 * name one, and would admit memories on a user or folder name. A file path (a separator plus an
 * extension) feeds the file gate only; a directory path keeps its last segment; a bare file name
 * (`OrganizationScope.php`) keeps its name without the extension, which names a format, not a subject.
 */
export function splitTypedPaths(prompt: string): PromptPaths {
  const paths: string[] = [];
  const seen = new Set<string>();
  const text = prompt.replace(/\S+/g, raw => {
    const token = trimEdges(raw).replace(LINE_SUFFIX, '');
    const segments = pathSegments(token);
    if (!segments) return BARE_FILE_NAME.exec(token)?.[1] ?? raw;
    if (segments.length < 2) return raw;
    const last = segments[segments.length - 1]!;
    if (FILE_EXTENSION.test(last)) {
      const key = token.toLowerCase();
      if (!seen.has(key) && paths.length < MAX_TYPED_PATHS) {
        seen.add(key);
        paths.push(token);
      }
      return ' ';
    }
    return ROOTED_PATH.test(token) || segments.length >= MIN_UNROOTED_DIRECTORY_SEGMENTS ? ` ${last} ` : raw;
  });
  return { text, paths };
}

export interface FileFields {
  content: string;
  filesRead?: readonly string[];
  filesModified?: readonly string[];
}

/** Lowercased, forward-slashed content and file lists, computed once per memory. */
export function normalizeFileFields(memory: FileFields): string[] {
  return [memory.content, ...(memory.filesRead ?? []), ...(memory.filesModified ?? [])].map(f =>
    f.replace(/\\/g, '/').toLowerCase(),
  );
}

/**
 * File proximity to `filePath` over fields from `normalizeFileFields`. Full credit (1) only with
 * directory context, a ≥2-trailing-segment suffix of `filePath`; a bare filename earns partial credit
 * (0.4), because leaf names like `index.ts` are common.
 */
export function fileProximityMatcher(filePath: string): (fields: readonly string[]) => number {
  const segments = filePath.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const fileName = segments[segments.length - 1] ?? '';
  if (!fileName) return () => 0;
  // The shortest full suffix (two segments) is contained in every longer one, so it alone decides.
  const minimalSuffix = segments.length >= 2 ? segments.slice(-2).join('/') : null;
  return fields => {
    if (minimalSuffix && fields.some(f => f.includes(minimalSuffix))) return FILE_PROXIMITY_FULL;
    if (fields.some(f => f.includes(fileName))) return FILE_PROXIMITY_PARTIAL;
    return 0;
  };
}

export function computeRecency(updatedAt: number, now: number): number {
  return 1 / (1 + (now - updatedAt) / SEVEN_DAYS_MS);
}

/** Log-damped so the retrieved→boosted→retrieved loop saturates near 10 retrievals. */
export function computeRetrievalBoost(count: number): number {
  return count > 0 ? Math.log2(1 + count) / RETRIEVAL_BOOST_DENOMINATOR : 0;
}

export function computeSourceCountBoost(sourceCount: number): number {
  return 0.05 * Math.log2(1 + sourceCount);
}

export function computeStalenessPenalty(kind: string, fileChangeCount: number): number {
  if (kind !== 'observation' || fileChangeCount < STALENESS_THRESHOLD) return 1;
  return 0.3 + 0.7 * Math.exp(-0.25 * fileChangeCount);
}

export function scoreGatedEntry(inputs: {
  lexical: Pick<LexicalMatch, 'relevance' | 'matchedIdf' | 'queryIdf'>;
  fileProximity: number;
  updatedAt: number;
  now: number;
  retrievalCount: number;
  sourceCount: number;
  kind: string;
  fileChangeCount: number;
}): { score: number; breakdown: MemoryScoreBreakdown } {
  const breakdown: MemoryScoreBreakdown = {
    relevance: inputs.lexical.relevance,
    matchedIdf: inputs.lexical.matchedIdf,
    queryIdf: inputs.lexical.queryIdf,
    fileProximity: inputs.fileProximity,
    recency: computeRecency(inputs.updatedAt, inputs.now),
    retrievalBoost: computeRetrievalBoost(inputs.retrievalCount),
    sourceCountBoost: computeSourceCountBoost(inputs.sourceCount),
    stalenessPenalty: computeStalenessPenalty(inputs.kind, inputs.fileChangeCount),
  };
  const raw =
    SCORE_WEIGHTS.relevance * breakdown.relevance +
    SCORE_WEIGHTS.file * breakdown.fileProximity +
    SCORE_WEIGHTS.recency * breakdown.recency +
    SCORE_WEIGHTS.retrieval * breakdown.retrievalBoost +
    breakdown.sourceCountBoost;
  return { score: raw * breakdown.stalenessPenalty, breakdown };
}

const SCOPE_ORDER: Record<MemoryScope, number> = { session: 0, project: 1, global: 2 };

export interface RankKey {
  score: number;
  scope: MemoryScope;
  updatedAt: number;
}

/** Score desc, then session before project before global, then most recent. */
export function compareRank(a: RankKey, b: RankKey): number {
  return b.score - a.score || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || b.updatedAt - a.updatedAt;
}

export interface TierCandidate {
  id: string;
  /** False for file-only matches and rerank-`low` entries, which render compact at most. */
  fullAllowed: boolean;
  /** Already in context as compact: it can only be upgraded to full, never re-sent compact. */
  liveCompact: boolean;
  tokens: Record<InjectionTier, number>;
}

export interface TierPlan {
  tiers: Map<string, InjectionTier>;
  /** Passed the gate but left out by the entry limits or the token budget. */
  overBudget: number;
  /** Live compact entries that ranked below the full tier and so were not re-sent. */
  alreadyInContext: number;
}

/**
 * Top `full` entries render full, the next `compact` render compact. Over `tokenBudget`, the lowest
 * full entries are demoted to compact first, then the lowest compact entries are dropped. Both limits
 * are maxima: a demotion past `compact` drops the lowest-ranked compact entry.
 */
export function assignTiers(
  ranked: readonly TierCandidate[],
  limits: { full: number; compact: number; tokenBudget: number },
): TierPlan {
  const tiers = new Map<string, InjectionTier>();
  let fullCount = 0;
  let compactCount = 0;
  let overBudget = 0;
  let alreadyInContext = 0;
  for (const c of ranked) {
    if (c.fullAllowed && fullCount < limits.full) {
      tiers.set(c.id, 'full');
      fullCount++;
    } else if (c.liveCompact) {
      alreadyInContext++;
    } else if (compactCount < limits.compact) {
      tiers.set(c.id, 'compact');
      compactCount++;
    } else {
      overBudget++;
    }
  }

  const byId = new Map(ranked.map(c => [c.id, c]));
  const total = (): number => [...tiers].reduce((sum, [id, tier]) => sum + byId.get(id)!.tokens[tier], 0);
  let used = total();
  const order = ranked.map(c => c.id).reverse();
  for (const id of order) {
    if (used <= limits.tokenBudget) break;
    if (tiers.get(id) !== 'full') continue;
    const c = byId.get(id)!;
    if (c.liveCompact) {
      tiers.delete(id);
      alreadyInContext++;
      used -= c.tokens.full;
    } else {
      tiers.set(id, 'compact');
      used += c.tokens.compact - c.tokens.full;
      if (++compactCount > limits.compact) {
        const lowest = order.find(o => tiers.get(o) === 'compact')!;
        tiers.delete(lowest);
        compactCount--;
        overBudget++;
        used -= byId.get(lowest)!.tokens.compact;
      }
    }
  }
  for (const id of order) {
    if (used <= limits.tokenBudget) break;
    if (tiers.get(id) !== 'compact') continue;
    tiers.delete(id);
    overBudget++;
    used -= byId.get(id)!.tokens.compact;
  }
  return { tiers, overBudget, alreadyInContext };
}
