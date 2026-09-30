import { USAGE_STATS_TOP_SESSIONS } from '../../shared/types/usage-stats';
import type {
  UsageStatsAggregate,
  UsageStatsBucket,
  UsageStatsHeatmapCell,
  UsageStatsTopSession,
  UsageStatsModelOption,
  UsageStatsModelRow,
  UsageStatsProjectOption,
  UsageStatsProjectRow,
  UsageStatsQuery,
  UsageStatsRange,
  UsageStatsReport,
  UsageStatsSeries,
  UsageStatsSource,
  UsageStatsSourceRow,
  UsageStatsTotals,
} from '../../shared/types/usage-stats';
import type { UsageDatabase } from './database';
import type { UsageStatsModel } from './worker-protocol';

/**
 * Read side of the usage index. Filters bind only through `json_each` parameters; no value is ever spliced into
 * SQL text. Formulas: `docs/invariants.md`, "Usage accounting".
 */

/** Zone-local parts of one instant, in the key formats `UsageStatsSeriesPoint.bucket` and `UsageStatsHeatmapCell` document. */
export interface LocalParts {
  day: string;
  /** The Monday starting the week. */
  week: string;
  month: string;
  /** 0 for Monday through 6 for Sunday. */
  weekday: number;
  hour: number;
}

type LocalPart = keyof LocalParts;

const DAY_MS = 86_400_000;
// Every UTC offset and DST change since 1972 falls on a 15-minute UTC boundary, so one slot has one local time.
const SLOT_MS = 15 * 60_000;
const SLOT_CACHE_LIMIT = 100_000;
const zoneCaches = new Map<string, { format: Intl.DateTimeFormat; slots: Map<number, LocalParts> }>();

const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** The local date parts of `tsMs` in the IANA zone `timeZone`. Throws a RangeError for an unknown zone. */
export function localParts(timeZone: string, tsMs: number): LocalParts {
  let zone = zoneCaches.get(timeZone);
  if (!zone) {
    const format = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
    zone = { format, slots: new Map() };
    zoneCaches.set(timeZone, zone);
  }
  const slot = Math.floor(tsMs / SLOT_MS);
  const cached = zone.slots.get(slot);
  if (cached) return cached;
  const formatted = zone.format.formatToParts(slot * SLOT_MS);
  const field = (type: Intl.DateTimeFormatPartTypes): number => Number(formatted.find((p) => p.type === type)?.value);
  const dateMs = Date.UTC(field('year'), field('month') - 1, field('day'));
  const weekday = (new Date(dateMs).getUTCDay() + 6) % 7;
  const day = isoDate(dateMs);
  const parts: LocalParts = { day, week: isoDate(dateMs - weekday * DAY_MS), month: day.slice(0, 7), weekday, hour: field('hour') };
  if (zone.slots.size >= SLOT_CACHE_LIMIT) zone.slots.clear();
  zone.slots.set(slot, parts);
  return parts;
}

const LOCAL_PARTS: readonly LocalPart[] = ['day', 'week', 'month', 'weekday', 'hour'];
const withLocalFunction = new WeakSet<UsageDatabase>();

/** Registers `usage_local(zone, part, ts_ms)` on the connection; SQL functions are per connection. */
function registerLocalFunction(db: UsageDatabase): void {
  if (withLocalFunction.has(db)) return;
  db.function('usage_local', { deterministic: true }, (timeZone, part, tsMs) => {
    const name = LOCAL_PARTS.find((p) => p === part);
    if (typeof timeZone !== 'string' || typeof tsMs !== 'number' || !name) throw new TypeError('usage_local expects (zone, part, ts_ms)');
    return localParts(timeZone, tsMs)[name];
  });
  withLocalFunction.add(db);
}

/** Bucket expressions over `entries.ts_ms` in the zone bound to `:zone`. */
const LOCAL_BUCKET_SQL: Record<LocalPart, string> = {
  day: "usage_local(:zone, 'day', ts_ms)",
  week: "usage_local(:zone, 'week', ts_ms)",
  month: "usage_local(:zone, 'month', ts_ms)",
  weekday: "usage_local(:zone, 'weekday', ts_ms)",
  hour: "usage_local(:zone, 'hour', ts_ms)",
};

export interface UsageStatsFilters {
  modelKeys: readonly string[];
  projectKeys: readonly string[];
}

const FILTERED_ENTRIES = `
FROM entries e LEFT JOIN temp.usage_rates r ON r.model_key = e.model_key
WHERE e.ts_ms >= :start AND e.ts_ms < :end
  AND (json_array_length(:models) = 0 OR e.model_key IN (SELECT value FROM json_each(:models)))
  AND (json_array_length(:projects) = 0 OR e.project_key IN (SELECT value FROM json_each(:projects)))`;

function filterParams(range: UsageStatsRange, filters: UsageStatsFilters) {
  return {
    start: range.startMs,
    end: range.endMs,
    models: JSON.stringify(filters.modelKeys),
    projects: JSON.stringify(filters.projectKeys),
  };
}

/** Parameters for a statement that uses `LOCAL_BUCKET_SQL`; call it before `prepare`, which resolves the SQL function. */
function zonedParams(db: UsageDatabase, range: UsageStatsRange, filters: UsageStatsFilters, timeZone: string) {
  registerLocalFunction(db);
  return { ...filterParams(range, filters), zone: timeZone };
}

// An entry with zero recorded cost is unpriced: its tokens are reported apart and it saves nothing.
// The input rate is the entry's own cost.input / input, else the registry rate; no rate means no saving.
const TOTALS_SQL = `
SELECT
  coalesce(sum(e.cost_total), 0) AS cost,
  coalesce(sum(e.input), 0) AS input,
  coalesce(sum(e.output), 0) AS output,
  coalesce(sum(e.cache_read), 0) AS cache_read,
  coalesce(sum(e.cache_write), 0) AS cache_write,
  coalesce(sum(CASE WHEN e.cost_total = 0 THEN e.input + e.output + e.cache_read + e.cache_write ELSE 0 END), 0) AS unpriced_tokens,
  coalesce(sum(CASE WHEN e.cost_total = 0 THEN 0 ELSE coalesce(
    (e.cache_read + e.cache_write) * (CASE WHEN e.input > 0 THEN e.cost_input / e.input ELSE r.input_rate END)
      - (e.cost_cache_read + e.cost_cache_write), 0) END), 0) AS net_savings,
  count(*) AS requests,
  count(DISTINCT e.session_id) AS sessions,
  count(DISTINCT ${LOCAL_BUCKET_SQL.day}) AS active_days
${FILTERED_ENTRIES}`;

interface TotalsRow {
  cost: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  unpriced_tokens: number;
  net_savings: number;
  requests: number;
  sessions: number;
  active_days: number;
}

/** Replace the connection's TEMP rate table with the registry's input rates. */
export function loadRates(db: UsageDatabase, models: readonly UsageStatsModel[]): void {
  db.exec('CREATE TEMP TABLE IF NOT EXISTS usage_rates (model_key TEXT PRIMARY KEY, input_rate REAL NOT NULL)');
  db.exec('DELETE FROM temp.usage_rates');
  db.prepare(`INSERT OR REPLACE INTO temp.usage_rates (model_key, input_rate)
    SELECT json_extract(value, '$.key'), json_extract(value, '$.rate') FROM json_each(?)
    WHERE json_type(value, '$.rate') IN ('integer', 'real')`)
    .run(JSON.stringify(models.map((m) => ({ key: m.key, rate: m.inputRatePerToken }))));
}

/** Totals over `[startMs, endMs)`, with active days counted in `timeZone`. Requires `loadRates` on this connection first. */
export function queryTotals(db: UsageDatabase, range: UsageStatsRange, filters: UsageStatsFilters, timeZone: string): UsageStatsTotals {
  const params = zonedParams(db, range, filters, timeZone);
  const row = db.prepare(TOTALS_SQL).get(params) as unknown as TotalsRow;
  return {
    cost: row.cost,
    input: row.input,
    output: row.output,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    unpricedTokens: row.unpriced_tokens,
    netCacheSavings: row.net_savings,
    requests: row.requests,
    sessions: row.sessions,
    activeDays: row.active_days,
  };
}

// Same unpriced rule as TOTALS_SQL, so every breakdown sums to the totals.
const AGGREGATE_COLUMNS = `
  coalesce(sum(e.cost_total), 0) AS cost,
  coalesce(sum(e.input), 0) AS input,
  coalesce(sum(e.output), 0) AS output,
  coalesce(sum(e.cache_read), 0) AS cache_read,
  coalesce(sum(e.cache_write), 0) AS cache_write,
  coalesce(sum(CASE WHEN e.cost_total = 0 THEN e.input + e.output + e.cache_read + e.cache_write ELSE 0 END), 0) AS unpriced_tokens,
  count(*) AS requests`;

interface AggregateRow {
  cost: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  unpriced_tokens: number;
  requests: number;
}

const aggregateOf = (row: AggregateRow): UsageStatsAggregate => ({
  cost: row.cost,
  input: row.input,
  output: row.output,
  cacheRead: row.cache_read,
  cacheWrite: row.cache_write,
  unpricedTokens: row.unpriced_tokens,
  requests: row.requests,
});

const ORDER_BY_SPEND = 'ORDER BY sum(e.cost_total) DESC, sum(e.input + e.output + e.cache_read + e.cache_write) DESC';

/** Usage per time bucket of `timeZone` and model; buckets with no usage are omitted. */
export function querySeries(
  db: UsageDatabase,
  range: UsageStatsRange,
  filters: UsageStatsFilters,
  bucket: UsageStatsBucket,
  timeZone: string,
): UsageStatsSeries {
  const params = zonedParams(db, range, filters, timeZone);
  const rows = db.prepare(`SELECT ${LOCAL_BUCKET_SQL[bucket]} AS bucket, e.model_key AS model_key,
    coalesce(sum(e.input), 0) AS input,
    coalesce(sum(e.output), 0) AS output,
    coalesce(sum(e.cache_read), 0) AS cache_read,
    coalesce(sum(e.cache_write), 0) AS cache_write,
    coalesce(sum(e.cost_input), 0) AS cost_input,
    coalesce(sum(e.cost_output), 0) AS cost_output,
    coalesce(sum(e.cost_cache_read), 0) AS cost_cache_read,
    coalesce(sum(e.cost_cache_write), 0) AS cost_cache_write,
    coalesce(sum(e.cost_total), 0) AS cost
    ${FILTERED_ENTRIES}
    GROUP BY 1, 2 ORDER BY 1, 2`).all(params) as Array<{
    bucket: string; model_key: string | null; input: number; output: number; cache_read: number; cache_write: number;
    cost_input: number; cost_output: number; cost_cache_read: number; cost_cache_write: number; cost: number;
  }>;
  return {
    bucket,
    points: rows.map((r) => ({
      bucket: r.bucket,
      modelKey: r.model_key,
      input: r.input,
      output: r.output,
      cacheRead: r.cache_read,
      cacheWrite: r.cache_write,
      costInput: r.cost_input,
      costOutput: r.cost_output,
      costCacheRead: r.cost_cache_read,
      costCacheWrite: r.cost_cache_write,
      cost: r.cost,
    })),
  };
}

export function queryByModel(
  db: UsageDatabase,
  range: UsageStatsRange,
  filters: UsageStatsFilters,
  models: readonly UsageStatsModel[],
): UsageStatsModelRow[] {
  const labels = new Map(models.map((m) => [m.key, m.label]));
  const rows = db.prepare(`SELECT e.model_key AS key, ${AGGREGATE_COLUMNS}
    ${FILTERED_ENTRIES}
    GROUP BY e.model_key ${ORDER_BY_SPEND}, e.model_key`).all(filterParams(range, filters)) as unknown as Array<AggregateRow & { key: string | null }>;
  return rows.map((r) => ({ key: r.key, label: r.key === null ? null : labels.get(r.key) ?? null, ...aggregateOf(r) }));
}

export function queryByProject(db: UsageDatabase, range: UsageStatsRange, filters: UsageStatsFilters): UsageStatsProjectRow[] {
  const rows = db.prepare(`SELECT g.*, p.cwd AS cwd FROM (
      SELECT e.project_key AS key, ${AGGREGATE_COLUMNS}
      ${FILTERED_ENTRIES}
      GROUP BY e.project_key
    ) g LEFT JOIN projects p ON p.project_key = g.key
    ORDER BY g.cost DESC, g.input + g.output + g.cache_read + g.cache_write DESC, g.key`).all(filterParams(range, filters)) as unknown as Array<AggregateRow & { key: string; cwd: string | null }>;
  return rows.map((r) => ({ key: r.key, cwd: r.cwd, ...aggregateOf(r) }));
}

// One branch per entry, so the sources partition the totals: `docs/invariants.md`, "Usage accounting".
const SOURCE_SQL = `CASE
  WHEN e.origin = 'background' THEN 'background'
  WHEN e.kind IN ('compaction', 'branch_summary') THEN 'compaction'
  WHEN e.kind = 'usage:cache_warm' THEN 'cacheWarm'
  WHEN e.origin = 'subagent' THEN 'subagent'
  WHEN e.origin = 'team' THEN 'team'
  ELSE 'main' END`;
const SOURCE_DETAIL_SQL = `CASE
  WHEN e.origin = 'background' THEN e.detail
  WHEN e.kind IN ('compaction', 'branch_summary') THEN e.kind
  WHEN e.kind = 'usage:cache_warm' THEN e.origin
  WHEN e.origin IN ('subagent', 'team') THEN e.detail
  ELSE NULL END`;

/** One row per source and detail; see `UsageStatsSourceRow` for what the detail holds. */
export function queryBySource(db: UsageDatabase, range: UsageStatsRange, filters: UsageStatsFilters): UsageStatsSourceRow[] {
  const rows = db.prepare(`SELECT ${SOURCE_SQL} AS source, ${SOURCE_DETAIL_SQL} AS detail, ${AGGREGATE_COLUMNS}
    ${FILTERED_ENTRIES}
    GROUP BY 1, 2 ${ORDER_BY_SPEND}, 1, 2`).all(filterParams(range, filters)) as unknown as Array<
    AggregateRow & { source: UsageStatsSource; detail: string | null }
  >;
  return rows.map((r) => ({ source: r.source, detail: r.detail, ...aggregateOf(r) }));
}

/** Usage per weekday and hour of `timeZone`. */
export function queryHeatmap(db: UsageDatabase, range: UsageStatsRange, filters: UsageStatsFilters, timeZone: string): UsageStatsHeatmapCell[] {
  const params = zonedParams(db, range, filters, timeZone);
  return db.prepare(`SELECT ${LOCAL_BUCKET_SQL.weekday} AS weekday, ${LOCAL_BUCKET_SQL.hour} AS hour,
    coalesce(sum(e.cost_total), 0) AS cost,
    coalesce(sum(e.input + e.output + e.cache_read + e.cache_write), 0) AS tokens,
    count(*) AS requests
    ${FILTERED_ENTRIES}
    GROUP BY 1, 2 ORDER BY 1, 2`).all(params) as unknown as UsageStatsHeatmapCell[];
}

/**
 * The costliest top-level conversations. `entries.session_id` is already the top-level session for
 * subagent, team and attributed sub-call rows, so grouping on it rolls their spend into the parent.
 * `openable` is left false for the host to decide.
 */
export function queryTopSessions(db: UsageDatabase, range: UsageStatsRange, filters: UsageStatsFilters, limit: number): UsageStatsTopSession[] {
  const rows = db.prepare(`SELECT g.*, s.title AS title, coalesce(s.missing, 0) AS missing,
      coalesce(s.project_key, g.entry_project_key) AS project_key, p.cwd AS cwd
    FROM (
      SELECT e.session_id AS session_id, min(e.project_key) AS entry_project_key, max(e.ts_ms) AS last_active_ms, ${AGGREGATE_COLUMNS}
      ${FILTERED_ENTRIES} AND e.session_id IS NOT NULL
      GROUP BY e.session_id
    ) g
    LEFT JOIN sessions s ON s.session_id = g.session_id
    LEFT JOIN projects p ON p.project_key = coalesce(s.project_key, g.entry_project_key)
    ORDER BY g.cost DESC, g.input + g.output + g.cache_read + g.cache_write DESC, g.session_id
    LIMIT :limit`).all({ ...filterParams(range, filters), limit }) as unknown as Array<
    AggregateRow & { session_id: string; title: string | null; missing: number; project_key: string; cwd: string | null; last_active_ms: number }
  >;
  return rows.map((r) => ({
    sessionId: r.session_id,
    title: r.title,
    projectKey: r.project_key,
    cwd: r.cwd,
    lastActiveMs: r.last_active_ms,
    missing: r.missing === 1,
    openable: false,
    ...aggregateOf(r),
  }));
}

/** Every indexed model and project, independent of the range, so the pickers stay stable while filtering. */
export function queryFilterOptions(
  db: UsageDatabase,
  models: readonly UsageStatsModel[],
): { models: UsageStatsModelOption[]; projects: UsageStatsProjectOption[] } {
  const labels = new Map(models.map((m) => [m.key, m.label]));
  const modelOptions = (db.prepare('SELECT DISTINCT model_key FROM entries WHERE model_key IS NOT NULL').all() as Array<{ model_key: string }>)
    .map(({ model_key }) => ({ key: model_key, label: labels.get(model_key) ?? model_key }))
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  const projects = db.prepare(`SELECT p.project_key AS key, p.cwd AS cwd FROM projects p
    WHERE EXISTS (SELECT 1 FROM entries e WHERE e.project_key = p.project_key) ORDER BY p.project_key`).all() as unknown as UsageStatsProjectOption[];
  return { models: modelOptions, projects: projects.map(({ key, cwd }) => ({ key, cwd })) };
}

export function queryIndexedAt(db: UsageDatabase): number | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'indexed_at_ms'").get() as { value: string } | undefined;
  return row ? Number(row.value) : null;
}

/** Every figure comes from one read snapshot, so a commit from another window cannot land between the totals and a breakdown. */
export function buildReport(db: UsageDatabase, query: UsageStatsQuery, models: readonly UsageStatsModel[]): UsageStatsReport {
  // Deferred: the TEMP rate table is private to this connection and never takes the main write lock.
  db.exec('BEGIN');
  try {
    loadRates(db, models);
    const filters: UsageStatsFilters = { modelKeys: query.modelKeys, projectKeys: query.projectKeys };
    const report: UsageStatsReport = {
      range: { startMs: query.startMs, endMs: query.endMs },
      totals: queryTotals(db, query, filters, query.timeZone),
      previousTotals: query.previous ? queryTotals(db, query.previous, filters, query.timeZone) : null,
      filterOptions: queryFilterOptions(db, models),
      indexedAtMs: queryIndexedAt(db),
      series: querySeries(db, query, filters, query.bucket, query.timeZone),
      byModel: queryByModel(db, query, filters, models),
      byProject: queryByProject(db, query, filters),
      bySource: queryBySource(db, query, filters),
      heatmap: queryHeatmap(db, query, filters, query.timeZone),
      topSessions: queryTopSessions(db, query, filters, USAGE_STATS_TOP_SESSIONS),
    };
    db.exec('COMMIT');
    return report;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
