/** Shapes of the `/stats` protocol between the webview and the extension host. Formulas: `docs/invariants.md`, "Usage accounting". */

export type UsageStatsBucket = 'day' | 'week' | 'month';

export const USAGE_STATS_BUCKETS: readonly UsageStatsBucket[] = ['day', 'week', 'month'];

/** Project key of ledger rows recorded with `cwd: null`; shown as "No project". */
export const NO_PROJECT_KEY = '';

/** The host rejects a query whose model or project filter exceeds these bounds. */
export const USAGE_STATS_MAX_FILTER_KEYS = 200;
export const USAGE_STATS_MAX_FILTER_KEY_LENGTH = 1024;
export const USAGE_STATS_MAX_TIME_ZONE_LENGTH = 64;

export interface UsageStatsRange {
  /** Inclusive, epoch ms. All time is 0. */
  startMs: number;
  /** Exclusive, epoch ms. */
  endMs: number;
}

export interface UsageStatsQuery extends UsageStatsRange {
  /** Null when compare is off or the preset is All time. */
  previous: UsageStatsRange | null;
  /** Empty means all. Normalized `provider/model` keys. */
  modelKeys: string[];
  /** Empty means all. May include `NO_PROJECT_KEY`. */
  projectKeys: string[];
  bucket: UsageStatsBucket;
  /** The webview's IANA zone. Buckets, the heatmap and active days use its calendar, so they match the webview's own keys. */
  timeZone: string;
  /** True on open and Refresh; false answers once from the index without scanning. */
  scan: boolean;
}

export interface UsageStatsTotals {
  /** Sum of `cost.total` over priced entries, USD. */
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Tokens of entries that carry tokens and a zero recorded cost. */
  unpricedTokens: number;
  /** USD; unpriced entries excluded; negative when cache writes outweigh the reads. */
  netCacheSavings: number;
  /** Usage-bearing entries. */
  requests: number;
  /** Distinct top-level sessions with usage in range. */
  sessions: number;
  /** Distinct calendar dates in the query's zone with usage in range. */
  activeDays: number;
}

export interface UsageStatsModelOption {
  key: string;
  label: string;
}

/** `cwd` is null only for `NO_PROJECT_KEY`. */
export interface UsageStatsProjectOption {
  key: string;
  cwd: string | null;
}

/** Sums over one group of entries. Share and cache hit rate are derived from these and the report totals. */
export interface UsageStatsAggregate {
  cost: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  unpricedTokens: number;
  requests: number;
}

/** One model's usage in one time bucket. */
export interface UsageStatsSeriesPoint {
  /** Date in the query's zone: `YYYY-MM-DD` for day, the Monday `YYYY-MM-DD` for week, `YYYY-MM` for month. */
  bucket: string;
  /** Null for entries whose model was never recorded. */
  modelKey: string | null;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  /** Recorded `cost.total`. */
  cost: number;
}

/** Only buckets with usage are listed; the webview zero-fills the rest. */
export interface UsageStatsSeries {
  bucket: UsageStatsBucket;
  points: UsageStatsSeriesPoint[];
}

export interface UsageStatsModelRow extends UsageStatsAggregate {
  /** Null for entries whose model was never recorded. */
  key: string | null;
  /** Registry label; null when the registry does not know the key. */
  label: string | null;
}

export interface UsageStatsProjectRow extends UsageStatsAggregate {
  key: string;
  /** Null only for `NO_PROJECT_KEY`. */
  cwd: string | null;
}

/** Where spend came from. Every entry has exactly one source; precedence: `docs/invariants.md`, "Usage accounting". */
export type UsageStatsSource = 'main' | 'subagent' | 'team' | 'compaction' | 'cacheWarm' | 'background';

export const USAGE_STATS_SOURCES: readonly UsageStatsSource[] = ['main', 'subagent', 'team', 'compaction', 'cacheWarm', 'background'];

export interface UsageStatsSourceRow extends UsageStatsAggregate {
  source: UsageStatsSource;
  /**
   * subagent: agent type; team: role; background: ledger purpose; compaction: `compaction` or `branch_summary`;
   * cacheWarm: the file it was recorded in (`main`, `subagent`, `team`); main: null. Null also when unrecorded.
   */
  detail: string | null;
}

/** Usage in one weekday and hour of the query's zone. Weekday is 0 for Monday through 6 for Sunday; empty cells are omitted. */
export interface UsageStatsHeatmapCell {
  weekday: number;
  hour: number;
  cost: number;
  tokens: number;
  requests: number;
}

/** A top-level conversation with its subagent, team and attributed sub-call spend rolled in. */
export interface UsageStatsTopSession extends UsageStatsAggregate {
  sessionId: string;
  /** Null when the conversation has no title or its file was deleted. */
  title: string | null;
  projectKey: string;
  cwd: string | null;
  lastActiveMs: number;
  /** The conversation's file is gone; its spend stays. */
  missing: boolean;
  /** Set by the host: a folder open in this window holds the conversation. */
  openable: boolean;
}

export interface UsageStatsReport {
  range: UsageStatsRange;
  totals: UsageStatsTotals;
  previousTotals: UsageStatsTotals | null;
  filterOptions: { models: UsageStatsModelOption[]; projects: UsageStatsProjectOption[] };
  /** When the last scan completed, epoch ms; null before the first one. */
  indexedAtMs: number | null;
  /** Each breakdown below sums to `totals` over the same range and filters. */
  series?: UsageStatsSeries;
  byModel?: UsageStatsModelRow[];
  byProject?: UsageStatsProjectRow[];
  bySource?: UsageStatsSourceRow[];
  heatmap?: UsageStatsHeatmapCell[];
  /** The costliest conversations in range, at most `USAGE_STATS_TOP_SESSIONS`. */
  topSessions?: UsageStatsTopSession[];
}

export const USAGE_STATS_TOP_SESSIONS = 10;
