import type {
  UsageStatsBucket,
  UsageStatsModelRow,
  UsageStatsRange,
  UsageStatsSeries,
  UsageStatsSeriesPoint,
} from '@shared/types/usage-stats';

/** Pure shaping of the `/stats` series for the chart. Bucket keys are local dates, weeks start Monday. */

export type StatsMetric = 'cost' | 'tokens';
export type StatsSplit = 'model' | 'tokenType';
export type TokenType = 'input' | 'output' | 'cacheRead' | 'cacheWrite';

export const TOKEN_TYPES: readonly TokenType[] = ['input', 'output', 'cacheRead', 'cacheWrite'];

/** Distinct colors before the rest share the last one; `--chart-1` to `--chart-8` in `style.css`. */
export const CHART_COLOR_COUNT = 8;

/** Series keys that cannot collide with a model key, which always contains a `/`. */
export const UNKNOWN_MODEL_SERIES = 'unknown';
export const OTHER_MODELS_SERIES = 'other';

/** The color of the item at `rank` (0 first); ranks past the palette share its last color. */
export function chartColor(rank: number): string {
  return `var(--chart-${Math.min(rank, CHART_COLOR_COUNT - 1) + 1})`;
}

export function modelSeriesKey(modelKey: string | null): string {
  return modelKey ?? UNKNOWN_MODEL_SERIES;
}

export interface RankedModel {
  /** Series key: the model key, `UNKNOWN_MODEL_SERIES`, or `OTHER_MODELS_SERIES` for the grouped tail. */
  key: string;
  color: string;
}

/**
 * Chart series for models in the report's cost order (`byModel` arrives sorted), so a model has the same
 * color in the chart and the breakdown. Models past the palette are grouped as one "other" series.
 */
export function rankModels(byModel: readonly UsageStatsModelRow[]): { series: RankedModel[]; seriesOf: (modelKey: string | null) => string } {
  const own = byModel.length <= CHART_COLOR_COUNT ? byModel.length : CHART_COLOR_COUNT - 1;
  const series: RankedModel[] = byModel.slice(0, own).map((m, rank) => ({ key: modelSeriesKey(m.key), color: chartColor(rank) }));
  if (own < byModel.length) series.push({ key: OTHER_MODELS_SERIES, color: chartColor(CHART_COLOR_COUNT - 1) });
  const named = new Set(series.map((s) => s.key));
  return { series, seriesOf: (modelKey) => (named.has(modelSeriesKey(modelKey)) ? modelSeriesKey(modelKey) : OTHER_MODELS_SERIES) };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The local bucket holding `ms`, in the same format the host's SQL emits. */
export function bucketKeyOf(ms: number, bucket: UsageStatsBucket): string {
  const d = new Date(ms);
  if (bucket === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
  if (bucket === 'week') d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local midnight starting a bucket key. */
export function bucketStartMs(key: string): number {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d ?? 1).getTime();
}

function nextBucketStart(ms: number, bucket: UsageStatsBucket): number {
  const d = new Date(ms);
  if (bucket === 'month') d.setMonth(d.getMonth() + 1, 1);
  else d.setDate(d.getDate() + (bucket === 'week' ? 7 : 1));
  return d.getTime();
}

/**
 * Every bucket from the range's start to its end, in order. All time (start 0) begins at the earliest
 * bucket with usage instead of 1970.
 */
export function bucketKeys(range: UsageStatsRange, bucket: UsageStatsBucket, points: readonly UsageStatsSeriesPoint[]): string[] {
  const earliest = points.reduce<string | null>((min, p) => (min === null || p.bucket < min ? p.bucket : min), null);
  if (range.startMs === 0 && earliest === null) return [];
  let cursor = bucketStartMs(range.startMs === 0 ? earliest! : bucketKeyOf(range.startMs, bucket));
  const keys: string[] = [];
  while (cursor < range.endMs) {
    keys.push(bucketKeyOf(cursor, bucket));
    cursor = nextBucketStart(cursor, bucket);
  }
  return keys;
}

function pointValue(p: UsageStatsSeriesPoint, metric: StatsMetric, type?: TokenType): number {
  if (metric === 'tokens') return type ? p[type] : p.input + p.output + p.cacheRead + p.cacheWrite;
  switch (type) {
    case 'input': return p.costInput;
    case 'output': return p.costOutput;
    case 'cacheRead': return p.costCacheRead;
    case 'cacheWrite': return p.costCacheWrite;
    default: return p.cost;
  }
}

export interface BucketTotal {
  /** Recorded `cost.total`, which the token-type cost components need not sum to. */
  cost: number;
  tokens: number;
}

/** Each bucket's recorded totals, keyed like the `chartRows` rows. */
export function bucketTotals(series: UsageStatsSeries): Map<string, BucketTotal> {
  const totals = new Map<string, BucketTotal>();
  for (const p of series.points) {
    const total = totals.get(p.bucket) ?? { cost: 0, tokens: 0 };
    total.cost += p.cost;
    total.tokens += pointValue(p, 'tokens');
    totals.set(p.bucket, total);
  }
  return totals;
}

export interface ChartCategory {
  key: string;
  color: string;
}

export type ChartRow = { bucket: string } & Record<string, number | string>;

/**
 * One row per bucket with a value per category; buckets with no usage are zeros. A point outside the
 * expected keys gets its own row in key order, so the chart still sums to the totals.
 */
export function chartRows(
  series: UsageStatsSeries,
  range: UsageStatsRange,
  byModel: readonly UsageStatsModelRow[],
  metric: StatsMetric,
  split: StatsSplit,
): { categories: ChartCategory[]; rows: ChartRow[] } {
  const ranked = rankModels(byModel);
  const categories: ChartCategory[] = split === 'model'
    ? ranked.series
    : TOKEN_TYPES.map((type, i) => ({ key: type, color: chartColor(i) }));
  const zero = (bucket: string): ChartRow => ({ bucket, ...Object.fromEntries(categories.map((c) => [c.key, 0])) });
  const rows = new Map(bucketKeys(range, series.bucket, series.points).map((key) => [key, zero(key)]));
  let unexpected = false;
  for (const p of series.points) {
    let row = rows.get(p.bucket);
    if (!row) {
      row = zero(p.bucket);
      rows.set(p.bucket, row);
      unexpected = true;
    }
    if (split === 'model') {
      const key = ranked.seriesOf(p.modelKey);
      row[key] = (row[key] as number) + pointValue(p, metric);
    } else {
      for (const type of TOKEN_TYPES) row[type] = (row[type] as number) + pointValue(p, metric, type);
    }
  }
  // Keys are zero-padded dates, so string order is time order.
  const ordered = unexpected ? [...rows.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : a.bucket > b.bucket ? 1 : 0)) : [...rows.values()];
  return { categories, rows: ordered };
}
