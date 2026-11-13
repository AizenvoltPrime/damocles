import type { ISearchOptions, SearchAddon } from '@xterm/addon-search';
import { rowText, type CiLogRow } from '@shared/forge/ci-log';

export interface LogMatch {
  readonly row: number;
  readonly start: number;
  readonly end: number;
}

/** The rows Find searches, by index: the parser's rows, then the provisional ones after them. */
export interface LogRows {
  readonly count: number;
  at(index: number): Pick<CiLogRow, 'spans'>;
}

// Highlights and the count stop here, so a query matching nearly every line cannot hold millions of matches; Next and
// Previous search past it.
export const MAX_LOG_MATCHES = 10_000;

type FindOptions = Pick<ISearchOptions, 'caseSensitive' | 'wholeWord' | 'regex'>;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** TerminalFind checks a pattern before it searches. */
function patternOf(query: string, options: FindOptions): RegExp {
  const source = options.regex ? query : escapeRegExp(query);
  return new RegExp(options.wholeWord ? `(?<!\\w)(?:${source})(?!\\w)` : source, options.caseSensitive ? 'g' : 'gi');
}

/** One row's matches, in order; an empty match is skipped. */
function rowMatches(pattern: RegExp, rows: LogRows, row: number): LogMatch[] {
  const text = rowText(rows.at(row));
  const matches: LogMatch[] = [];
  pattern.lastIndex = 0;
  for (let found = pattern.exec(text); found; found = pattern.exec(text)) {
    if (found[0] === '') {
      pattern.lastIndex++;
      continue;
    }
    matches.push({ row, start: found.index, end: found.index + found[0].length });
  }
  return matches;
}

/** Every match of query, row by row, at most MAX_LOG_MATCHES. */
export function findLogMatches(rows: LogRows, query: string, options: FindOptions): LogMatch[] {
  if (query === '') return [];
  const pattern = patternOf(query, options);
  const matches: LogMatch[] = [];
  for (let row = 0; row < rows.count; row++) {
    for (const match of rowMatches(pattern, rows, row)) {
      matches.push(match);
      if (matches.length >= MAX_LOG_MATCHES) return matches;
    }
  }
  return matches;
}

/**
 * The first match after from (or at it when inclusive), wrapping past the last row; with no from, the first. It reads every
 * row it passes, so a match past MAX_LOG_MATCHES is found too.
 */
export function nextLogMatch(rows: LogRows, pattern: RegExp, from: LogMatch | undefined, inclusive: boolean): LogMatch | undefined {
  const first = from?.row ?? 0;
  for (let step = 0; step <= rows.count; step++) {
    const row = (first + step) % rows.count;
    const matches = rowMatches(pattern, rows, row);
    // back at from's row after a wrap, its matches before from count
    const match = step === 0 && from ? matches.find((each) => each.start > from.start || (inclusive && each.start === from.start)) : matches[0];
    if (match) return match;
  }
  return undefined;
}

/** The last match before from, wrapping past the first row; with no from, the log's last. */
export function previousLogMatch(rows: LogRows, pattern: RegExp, from: LogMatch | undefined): LogMatch | undefined {
  const first = from?.row ?? rows.count - 1;
  for (let step = 0; step <= rows.count; step++) {
    const row = (first - step + rows.count) % rows.count;
    const matches = rowMatches(pattern, rows, row);
    const match = (step === 0 && from ? matches.filter((each) => each.start < from.start) : matches).at(-1);
    if (match) return match;
  }
  return undefined;
}

const before = (a: LogMatch, b: LogMatch): boolean => a.row < b.row || (a.row === b.row && a.start < b.start);

/** Where match sits in the counted matches, or -1 past them. */
function indexIn(matches: readonly LogMatch[], match: LogMatch): number {
  let low = 0;
  let high = matches.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const at = matches[mid]!;
    if (at.row === match.row && at.start === match.start) return mid;
    if (before(at, match)) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/** What the log search reads from its view and tells it: the rows now, and the matches to mark with the one to show. */
export interface LogSearchHost {
  rows(): LogRows;
  // changes whenever rows do, so a search after new output searches it too
  revision(): number;
  show(matches: readonly LogMatch[], current: LogMatch | null): void;
}

export type LogSearch = Pick<SearchAddon, 'findNext' | 'findPrevious' | 'clearDecorations' | 'onDidChangeResults'>;

/**
 * TerminalFind's search over a job log's whole row model, folded, windowed-out and provisional rows included: the next or
 * previous match from the current one, wrapping, as the terminal's search addon steps. The count and the highlights stop at
 * MAX_LOG_MATCHES; a match past them reports index -1.
 */
export function createLogSearch(host: LogSearchHost): LogSearch {
  const listeners = new Set<(results: { resultIndex: number; resultCount: number }) => void>();
  let cache: { key: string; matches: LogMatch[] } | undefined;
  let current: LogMatch | undefined;

  function matchesFor(query: string, options: ISearchOptions | undefined): LogMatch[] {
    const key = JSON.stringify([query, !!options?.caseSensitive, !!options?.wholeWord, !!options?.regex, host.revision()]);
    if (cache?.key !== key) cache = { key, matches: findLogMatches(host.rows(), query, options ?? {}) };
    return cache.matches;
  }

  function settle(matches: readonly LogMatch[], match: LogMatch | undefined): boolean {
    current = match;
    host.show(matches, match ?? null);
    const resultIndex = match ? indexIn(matches, match) : -1;
    for (const listener of listeners) listener({ resultIndex, resultCount: matches.length });
    return match !== undefined;
  }

  function step(query: string, options: ISearchOptions | undefined, direction: 1 | -1): boolean {
    const matches = matchesFor(query, options);
    if (matches.length === 0) return settle(matches, undefined);
    const rows = host.rows();
    const pattern = patternOf(query, options ?? {});
    // typing keeps the match it is on while that still matches
    const next = direction === 1
      ? (current ? nextLogMatch(rows, pattern, current, options?.incremental === true) : matches[0])
      : previousLogMatch(rows, pattern, current);
    return settle(matches, next);
  }

  return {
    findNext: (query, options) => step(query, options, 1),
    findPrevious: (query, options) => step(query, options, -1),
    clearDecorations: () => {
      current = undefined;
      host.show([], null);
    },
    onDidChangeResults: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
}
