import type { UsageStatsBucket, UsageStatsRange } from '@shared/types/usage-stats';

/** Every date boundary here is local wall-clock time, and weeks start on Monday in every locale. */

export type StatsCalendarPreset = 'today' | 'thisWeek' | 'thisMonth';
export type StatsSpanPreset = 'last7' | 'last30' | 'last90';
export type StatsPreset = StatsCalendarPreset | StatsSpanPreset | 'allTime' | 'custom';

/** The presets a picker lists; `custom` is reached through the calendar. */
export const STATS_PRESETS: readonly Exclude<StatsPreset, 'custom'>[] = [
  'today', 'thisWeek', 'thisMonth', 'last7', 'last30', 'last90', 'allTime',
];

export type StatsRangeSpec =
  /** `offset` counts steps back from the one holding the present: 0 is current, -1 the one before. */
  | { preset: StatsCalendarPreset | StatsSpanPreset; offset: number }
  | { preset: 'allTime' }
  /** Local midnights; `endMs` is the midnight after the last included day. */
  | { preset: 'custom'; startMs: number; endMs: number };

export interface ResolvedStatsRange extends UsageStatsRange {
  /** The comparison period, or null for All time and for a period that would start before `firstDayMs()`. */
  previous: UsageStatsRange | null;
  bucket: UsageStatsBucket;
  /** False when the step back would start before `firstDayMs()`. */
  canStepPrev: boolean;
  /** False while the range holds the present. */
  canStepNext: boolean;
}

interface Step {
  unit: 'day' | 'month';
  count: number;
}

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;
const SPAN_DAYS: Record<StatsSpanPreset, number> = { last7: 7, last30: 30, last90: 90 };

function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Calendar days, so a DST change keeps the wall-clock time instead of drifting an hour. */
function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return d.getTime();
}

/** A day that does not exist in the target month overflows into the next one (Mar 31 minus a month is Mar 3). */
function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  d.setMonth(d.getMonth() + months);
  return d.getTime();
}

function startOfWeek(ms: number): number {
  const day = startOfDay(ms);
  const sinceMonday = (new Date(day).getDay() + 6) % 7;
  return addDays(day, -sinceMonday);
}

function startOfMonth(ms: number): number {
  const d = new Date(startOfDay(ms));
  d.setDate(1);
  return d.getTime();
}

/** The first local midnight at or after the epoch; the host rejects a range that starts earlier. */
export function firstDayMs(): number {
  const midnight = startOfDay(0);
  return midnight >= 0 ? midnight : addDays(midnight, 1);
}

/** The exclusive end sent for a range that holds the present: the next whole minute, so it always follows `now`. */
export function presentEndMs(now: number): number {
  return Math.floor(now / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
}

function shift(ms: number, step: Step, times: number): number {
  return step.unit === 'month' ? addMonths(ms, step.count * times) : addDays(ms, step.count * times);
}

/** Rounding absorbs the hour a DST change adds to or removes from a span of whole days. */
function daysBetween(startMs: number, endMs: number): number {
  return Math.round((endMs - startMs) / DAY_MS);
}

function stepOf(spec: Exclude<StatsRangeSpec, { preset: 'allTime' }>): Step {
  switch (spec.preset) {
    case 'today': return { unit: 'day', count: 1 };
    case 'thisWeek': return { unit: 'day', count: 7 };
    case 'thisMonth': return { unit: 'month', count: 1 };
    case 'last7':
    case 'last30':
    case 'last90': return { unit: 'day', count: SPAN_DAYS[spec.preset] };
    case 'custom': return { unit: 'day', count: daysBetween(spec.startMs, spec.endMs) };
  }
}

/** The full period a spec names, before its end is clipped to the present. */
function periodOf(spec: Exclude<StatsRangeSpec, { preset: 'allTime' }>, now: number): UsageStatsRange {
  if (spec.preset === 'custom') return { startMs: spec.startMs, endMs: spec.endMs };
  const step = stepOf(spec);
  let start: number;
  switch (spec.preset) {
    case 'today': start = startOfDay(now); break;
    case 'thisWeek': start = startOfWeek(now); break;
    case 'thisMonth': start = startOfMonth(now); break;
    default: start = addDays(startOfDay(now), 1 - SPAN_DAYS[spec.preset]);
  }
  start = shift(start, step, spec.offset);
  return { startMs: start, endMs: shift(start, step, 1) };
}

function autoBucket(startMs: number, endMs: number): UsageStatsBucket {
  const days = daysBetween(startMs, endMs);
  if (days <= 31) return 'day';
  if (days <= 183) return 'week';
  return 'month';
}

/**
 * The range to query at `now`. The previous period is the same range moved back one step (a calendar
 * unit, or the range's own length) with its end clipped to the current start, so a partly elapsed
 * period compares against the same elapsed span of the one before it.
 */
export function resolveStatsRange(spec: StatsRangeSpec, now: number): ResolvedStatsRange {
  const presentEnd = presentEndMs(now);
  if (spec.preset === 'allTime') {
    return { startMs: 0, endMs: presentEnd, previous: null, bucket: 'month', canStepPrev: false, canStepNext: false };
  }
  const step = stepOf(spec);
  const period = periodOf(spec, now);
  const endMs = Math.min(period.endMs, presentEnd);
  const previousStart = shift(period.startMs, step, -1);
  const inRange = previousStart >= firstDayMs();
  return {
    startMs: period.startMs,
    endMs,
    previous: inRange ? { startMs: previousStart, endMs: Math.min(shift(endMs, step, -1), period.startMs) } : null,
    bucket: autoBucket(period.startMs, endMs),
    canStepPrev: inRange,
    canStepNext: period.endMs <= now,
  };
}

/** Moves a range one step back (-1) or forward (1). The caller checks `canStepPrev` / `canStepNext` first. */
export function stepStatsRange(spec: StatsRangeSpec, direction: -1 | 1): StatsRangeSpec {
  if (spec.preset === 'allTime') return spec;
  if (spec.preset === 'custom') {
    const step = stepOf(spec);
    return { preset: 'custom', startMs: shift(spec.startMs, step, direction), endMs: shift(spec.endMs, step, direction) };
  }
  return { preset: spec.preset, offset: spec.offset + direction };
}

export function presetSpec(preset: Exclude<StatsPreset, 'custom'>): StatsRangeSpec {
  return preset === 'allTime' ? { preset } : { preset, offset: 0 };
}

export interface LocalDate {
  year: number;
  /** 1-based. */
  month: number;
  day: number;
}

/** A custom range covering `first` through `last`, both included. */
export function customSpec(first: LocalDate, last: LocalDate): StatsRangeSpec {
  return {
    preset: 'custom',
    startMs: new Date(first.year, first.month - 1, first.day).getTime(),
    endMs: new Date(last.year, last.month - 1, last.day + 1).getTime(),
  };
}

export function localDateOf(ms: number): LocalDate {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}
