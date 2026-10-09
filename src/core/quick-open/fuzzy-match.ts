// Quick Open's file scoring: a port of VS Code's fuzzyScorer.ts (scoreFuzzy, scoreItemFuzzy, compareItemsByFuzzyScore,
// prepareQuery) for '/' separated relative paths. Pure: the desktop main process and the command palette both use it.

/** [start, end) offsets into a label or description. */
export type MatchRange = readonly [number, number];

export interface FuzzyItem {
  // the file name
  readonly label: string;
  // the folder relative to its project, '' at the root
  readonly description: string;
  // the relative path, '/' separated
  readonly path: string;
}

export interface ItemScore {
  // 0 = no match
  readonly score: number;
  readonly labelMatches: readonly MatchRange[];
  readonly descriptionMatches: readonly MatchRange[];
}

interface QueryPiece {
  readonly normalized: string;
  readonly normalizedLowercase: string;
  readonly pathNormalized: string;
  // the piece was wrapped in quotes: a substring match only
  readonly expectContiguousMatch: boolean;
}

export interface PreparedQuery extends QueryPiece {
  // the query split on spaces, when it has more than one piece
  readonly values: readonly QueryPiece[] | undefined;
  readonly containsPathSeparator: boolean;
}

const NO_MATCH = 0;
const NO_ITEM_SCORE: ItemScore = { score: 0, labelMatches: [], descriptionMatches: [] };
const PATH_IDENTITY_SCORE = 1 << 18;
const LABEL_PREFIX_SCORE_THRESHOLD = 1 << 17;
const LABEL_SCORE_THRESHOLD = 1 << 16;

function isUpper(code: number): boolean {
  return code >= 65 && code <= 90;
}

function considerAsEqual(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === '/' || a === '\\') return b === '/' || b === '\\';
  return false;
}

function separatorBonus(code: number): number {
  switch (code) {
    case 47: // '/'
    case 92: // '\'
      return 5;
    case 95: // '_'
    case 45: // '-'
    case 46: // '.'
    case 32: // ' '
    case 39: // "'"
    case 34: // '"'
    case 58: // ':'
      return 4;
    default:
      return 0;
  }
}

function charScore(queryChar: string, queryLowerChar: string, target: string, targetLower: string, targetIndex: number, sequenceLength: number): number {
  if (!considerAsEqual(queryLowerChar, targetLower[targetIndex])) return 0;
  let score = 1;
  // Consecutive matches: up to 3 get the full bonus, the rest half, so a long run does not swamp word starts.
  if (sequenceLength > 0) score += Math.min(sequenceLength, 3) * 6 + Math.max(0, sequenceLength - 3) * 3;
  if (queryChar === target[targetIndex]) score += 1;
  if (targetIndex === 0) {
    score += 8;
  } else {
    const bonus = separatorBonus(target.charCodeAt(targetIndex - 1));
    if (bonus) score += bonus;
    // Camel case inside a word, only outside a run: NPE boosts NullPointerException, HTTP does not boost HTTP.
    else if (isUpper(target.charCodeAt(targetIndex)) && sequenceLength === 0) score += 2;
  }
  return score;
}

/** VS Code's scoreFuzzy: [score, matched positions in target]; score 0 is no match. */
export function scoreFuzzy(target: string, query: string, queryLower: string, allowNonContiguousMatches: boolean): [number, number[]] {
  if (!target || !query || target.length < query.length) return [NO_MATCH, []];
  const targetLower = target.toLowerCase();
  const targetLength = target.length;
  const queryLength = query.length;
  const scores: number[] = new Array<number>(queryLength * targetLength).fill(0);
  const matches: number[] = new Array<number>(queryLength * targetLength).fill(0);
  for (let queryIndex = 0; queryIndex < queryLength; queryIndex++) {
    const offset = queryIndex * targetLength;
    const previousOffset = offset - targetLength;
    const queryGtZero = queryIndex > 0;
    for (let targetIndex = 0; targetIndex < targetLength; targetIndex++) {
      const targetGtZero = targetIndex > 0;
      const current = offset + targetIndex;
      const leftScore = targetGtZero ? scores[current - 1]! : 0;
      const diag = previousOffset + targetIndex - 1;
      const diagScore = queryGtZero && targetGtZero ? scores[diag]! : 0;
      const sequenceLength = queryGtZero && targetGtZero ? matches[diag]! : 0;
      // Past the first query character a score needs one for the previous character, so the query matches in order.
      const score = !diagScore && queryGtZero ? 0 : charScore(query[queryIndex]!, queryLower[queryIndex]!, target, targetLower, targetIndex, sequenceLength);
      const valid = score > 0 && diagScore + score >= leftScore;
      if (valid && (allowNonContiguousMatches || queryGtZero || targetLower.startsWith(queryLower, targetIndex))) {
        matches[current] = sequenceLength + 1;
        scores[current] = diagScore + score;
      } else {
        matches[current] = NO_MATCH;
        scores[current] = leftScore;
      }
    }
  }
  const positions: number[] = [];
  let queryIndex = queryLength - 1;
  let targetIndex = targetLength - 1;
  while (queryIndex >= 0 && targetIndex >= 0) {
    if (matches[queryIndex * targetLength + targetIndex] === NO_MATCH) {
      targetIndex--;
    } else {
      positions.push(targetIndex);
      queryIndex--;
      targetIndex--;
    }
  }
  return [scores[queryLength * targetLength - 1]!, positions.reverse()];
}

function normalizeQuery(original: string): { pathNormalized: string; normalized: string; normalizedLowercase: string } {
  const pathNormalized = original.replace(/\\/g, '/');
  const normalized = pathNormalized.replace(/[*\u2026\s"]/g, '').replace(/(?<=.)#$/, '');
  return { pathNormalized, normalized, normalizedLowercase: normalized.toLowerCase() };
}

function expectsExactMatch(query: string): boolean {
  return query.length > 1 && query.startsWith('"') && query.endsWith('"');
}

/** VS Code's prepareQuery: wildcards, ellipses, quotes and whitespace removed; space-separated pieces must all match. */
export function prepareQuery(original: string): PreparedQuery {
  const { pathNormalized, normalized, normalizedLowercase } = normalizeQuery(original);
  const pieces = original.split(' ');
  let values: QueryPiece[] | undefined;
  if (pieces.length > 1) {
    for (const piece of pieces) {
      const normalizedPiece = normalizeQuery(piece);
      if (!normalizedPiece.normalized) continue;
      (values ??= []).push({ ...normalizedPiece, expectContiguousMatch: expectsExactMatch(piece) });
    }
  }
  return { pathNormalized, normalized, normalizedLowercase, values, containsPathSeparator: pathNormalized.includes('/'), expectContiguousMatch: expectsExactMatch(original) };
}

function createMatches(positions: readonly number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const position of positions) {
    const last = ranges.at(-1);
    if (last && last[1] === position) last[1] += 1;
    else ranges.push([position, position + 1]);
  }
  return ranges;
}

function normalizeMatches(ranges: ReadonlyArray<readonly [number, number]>): MatchRange[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged.at(-1);
    if (last && !(last[1] < start)) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

function scoreSingle(item: FuzzyItem, query: QueryPiece, preferLabelMatches: boolean, allowNonContiguousMatches: boolean): ItemScore {
  const allowGaps = allowNonContiguousMatches && !query.expectContiguousMatch;
  if (preferLabelMatches || !item.description) {
    const [labelScore, positions] = scoreFuzzy(item.label, query.normalized, query.normalizedLowercase, allowGaps);
    if (labelScore) {
      const prefix = item.label.toLowerCase().startsWith(query.normalizedLowercase);
      const base = prefix ? LABEL_PREFIX_SCORE_THRESHOLD + Math.round((query.normalized.length / item.label.length) * 100) : LABEL_SCORE_THRESHOLD;
      return { score: base + labelScore, labelMatches: prefix ? [[0, query.normalized.length]] : createMatches(positions), descriptionMatches: [] };
    }
  }
  if (item.description) {
    const prefix = `${item.description}/`;
    const [score, positions] = scoreFuzzy(`${prefix}${item.label}`, query.normalized, query.normalizedLowercase, allowGaps);
    if (score) {
      const labelMatches: MatchRange[] = [];
      const descriptionMatches: MatchRange[] = [];
      for (const [start, end] of createMatches(positions)) {
        if (start < prefix.length && end > prefix.length) {
          labelMatches.push([0, end - prefix.length]);
          descriptionMatches.push([start, prefix.length]);
        } else if (start >= prefix.length) {
          labelMatches.push([start - prefix.length, end - prefix.length]);
        } else {
          descriptionMatches.push([start, end]);
        }
      }
      return { score, labelMatches, descriptionMatches };
    }
  }
  return NO_ITEM_SCORE;
}

/** VS Code's scoreItemFuzzy: the label first unless the query names a folder, then "description/label". */
export function scoreItem(item: FuzzyItem, query: PreparedQuery, allowNonContiguousMatches = true): ItemScore {
  if (!query.normalized || !item.label) return NO_ITEM_SCORE;
  if (query.pathNormalized.toLowerCase() === item.path.toLowerCase()) {
    return { score: PATH_IDENTITY_SCORE, labelMatches: [[0, item.label.length]], descriptionMatches: item.description ? [[0, item.description.length]] : [] };
  }
  const preferLabelMatches = !query.containsPathSeparator;
  if (!query.values || query.values.length <= 1) return scoreSingle(item, query, preferLabelMatches, allowNonContiguousMatches);
  let score = 0;
  const labelMatches: MatchRange[] = [];
  const descriptionMatches: MatchRange[] = [];
  for (const piece of query.values) {
    const pieceScore = scoreSingle(item, piece, preferLabelMatches, allowNonContiguousMatches);
    if (pieceScore.score === NO_MATCH) return NO_ITEM_SCORE;
    score += pieceScore.score;
    labelMatches.push(...pieceScore.labelMatches);
    descriptionMatches.push(...pieceScore.descriptionMatches);
  }
  return { score, labelMatches: normalizeMatches(labelMatches), descriptionMatches: normalizeMatches(descriptionMatches) };
}

const fileNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function compareFileNames(a: string, b: string): number {
  const result = fileNameCollator.compare(a, b);
  if (result === 0 && a !== b) return a < b ? -1 : 1;
  return result;
}

function compareAnything(one: string, other: string, lookFor: string): number {
  const a = one.toLowerCase();
  const b = other.toLowerCase();
  const aPrefix = a.startsWith(lookFor);
  const bPrefix = b.startsWith(lookFor);
  if (aPrefix !== bPrefix) return aPrefix ? -1 : 1;
  if (aPrefix && bPrefix && a.length !== b.length) return a.length - b.length;
  const aSuffix = a.endsWith(lookFor);
  const bSuffix = b.endsWith(lookFor);
  if (aSuffix !== bSuffix) return aSuffix ? -1 : 1;
  return compareFileNames(a, b) || a.localeCompare(b);
}

function matchLength(ranges: readonly MatchRange[]): number {
  return ranges.length === 0 ? 0 : ranges.at(-1)![1] - ranges[0]![0];
}

function compareByMatchLength(a: readonly MatchRange[], b: readonly MatchRange[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  if (b.length === 0) return -1;
  if (a.length === 0) return 1;
  const lengthA = matchLength(a);
  const lengthB = matchLength(b);
  return lengthA === lengthB ? 0 : lengthB < lengthA ? 1 : -1;
}

function matchDistance(item: FuzzyItem, score: ItemScore): number {
  const start = score.descriptionMatches[0]?.[0] ?? score.labelMatches[0]?.[0] ?? -1;
  let end = -1;
  if (score.labelMatches.length > 0) {
    end = score.labelMatches.at(-1)![1];
    if (score.descriptionMatches.length > 0 && item.description) end += item.description.length;
  } else if (score.descriptionMatches.length > 0) {
    end = score.descriptionMatches.at(-1)![1];
  }
  return end - start;
}

/** VS Code's compareItemsByFuzzyScore: negative when a ranks above b. */
export function compareScoredItems(a: FuzzyItem, scoreA: ItemScore, b: FuzzyItem, scoreB: ItemScore, query: PreparedQuery): number {
  if ((scoreA.score === PATH_IDENTITY_SCORE || scoreB.score === PATH_IDENTITY_SCORE) && scoreA.score !== scoreB.score) {
    return scoreA.score === PATH_IDENTITY_SCORE ? -1 : 1;
  }
  if (scoreA.score > LABEL_SCORE_THRESHOLD || scoreB.score > LABEL_SCORE_THRESHOLD) {
    if (scoreA.score !== scoreB.score) return scoreA.score > scoreB.score ? -1 : 1;
    if (scoreA.score < LABEL_PREFIX_SCORE_THRESHOLD && scoreB.score < LABEL_PREFIX_SCORE_THRESHOLD) {
      const byLength = compareByMatchLength(scoreA.labelMatches, scoreB.labelMatches);
      if (byLength !== 0) return byLength;
    }
    if (a.label.length !== b.label.length) return a.label.length - b.label.length;
  }
  if (scoreA.score !== scoreB.score) return scoreA.score > scoreB.score ? -1 : 1;
  const aLabel = scoreA.labelMatches.length > 0;
  const bLabel = scoreB.labelMatches.length > 0;
  if (aLabel !== bLabel) return aLabel ? -1 : 1;
  const distanceA = matchDistance(a, scoreA);
  const distanceB = matchDistance(b, scoreB);
  if (distanceA && distanceB && distanceA !== distanceB) return distanceB > distanceA ? -1 : 1;
  const lengthA = a.label.length + a.description.length;
  const lengthB = b.label.length + b.description.length;
  if (lengthA !== lengthB) return lengthA - lengthB;
  if (a.path.length !== b.path.length) return a.path.length - b.path.length;
  if (a.label !== b.label) return compareAnything(a.label, b.label, query.normalized);
  if (a.description !== b.description) return compareAnything(a.description, b.description, query.normalized);
  return a.path === b.path ? 0 : compareAnything(a.path, b.path, query.normalized);
}

// VS Code's LINE_COLON_PATTERN (search.ts): `file:12`, `file#12`, `file(12)`, `file:12:3`, `file:line 12`.
const LINE_PATTERN = /\s?[#:(](?:line )?(\d*)(?:[#:,](\d*))?(?:-(\d*)(?:[#:,](\d*))?)?\)?:?\s*$/;

export interface QuickOpenQueryParts {
  // the text the files are scored against
  readonly filter: string;
  // 1-based; absent without a line suffix
  readonly line?: number;
  // the query started with '@': the pick is mentioned in the chat instead of opened
  readonly mention: boolean;
}

// A line past this reads as no line (the editor clamps to its last line anyway).
const MAX_LINE = 10_000_000;

/** Splits a Quick Open query into its '@' prefix, its filter and its `:line` suffix. */
export function parseQuickOpenQuery(query: string): QuickOpenQueryParts {
  const mention = query.startsWith('@');
  const rest = mention ? query.slice(1) : query;
  const match = LINE_PATTERN.exec(rest);
  if (!match) return { filter: rest.trim(), mention };
  const filter = rest.slice(0, match.index).trim();
  const digits = match[1] ?? '';
  const line = digits === '' ? undefined : Number.parseInt(digits, 10);
  return { filter, mention, ...(line !== undefined && line >= 1 && line <= MAX_LINE ? { line } : {}) };
}
