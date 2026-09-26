import { describe, it, expect } from 'vitest';
import {
  customSpec,
  firstDayMs,
  presentEndMs,
  presetSpec,
  resolveStatsRange,
  stepStatsRange,
  type StatsRangeSpec,
} from '../useStatsRange';

/** Local wall-clock times, so every expectation holds in whatever time zone the suite runs. */
const at = (y: number, m: number, d: number, h = 0, min = 0, s = 0): number => new Date(y, m - 1, d, h, min, s).getTime();

// Wednesday 25 March 2026, 10:00:30 local.
const NOW = at(2026, 3, 25, 10, 0, 30);
const NOW_END = at(2026, 3, 25, 10, 1);

const span = (spec: StatsRangeSpec, now = NOW) => {
  const r = resolveStatsRange(spec, now);
  return { startMs: r.startMs, endMs: r.endMs };
};

describe('resolveStatsRange presets', () => {
  it('ends a range that holds the present at the next whole minute', () => {
    expect(presentEndMs(NOW)).toBe(NOW_END);
    expect(presentEndMs(at(2026, 3, 25, 10, 1))).toBe(at(2026, 3, 25, 10, 2));
  });

  it('starts Today at local midnight', () => {
    expect(span(presetSpec('today'))).toEqual({ startMs: at(2026, 3, 25), endMs: NOW_END });
  });

  it('starts This week on Monday', () => {
    expect(span(presetSpec('thisWeek'))).toEqual({ startMs: at(2026, 3, 23), endMs: NOW_END });
  });

  it('starts This week on the previous Monday when today is Sunday', () => {
    const sunday = at(2026, 3, 29, 12);
    expect(resolveStatsRange(presetSpec('thisWeek'), sunday).startMs).toBe(at(2026, 3, 23));
  });

  it('starts This week today when today is Monday', () => {
    const monday = at(2026, 3, 23, 8);
    expect(resolveStatsRange(presetSpec('thisWeek'), monday).startMs).toBe(at(2026, 3, 23));
  });

  it('starts This month on the first', () => {
    expect(span(presetSpec('thisMonth'))).toEqual({ startMs: at(2026, 3, 1), endMs: NOW_END });
  });

  it('counts Last N days as N calendar days including today', () => {
    expect(span(presetSpec('last7')).startMs).toBe(at(2026, 3, 19));
    expect(span(presetSpec('last30')).startMs).toBe(at(2026, 2, 24));
    expect(span(presetSpec('last90')).startMs).toBe(at(2025, 12, 26));
  });

  it('runs All time from the epoch with no previous period and no stepping', () => {
    const r = resolveStatsRange(presetSpec('allTime'), NOW);
    expect(r).toMatchObject({ startMs: 0, endMs: NOW_END, previous: null, canStepPrev: false, canStepNext: false, bucket: 'month' });
  });

  it('covers a custom range from its first to its last day inclusive', () => {
    const spec = customSpec({ year: 2026, month: 3, day: 1 }, { year: 2026, month: 3, day: 3 });
    expect(span(spec)).toEqual({ startMs: at(2026, 3, 1), endMs: at(2026, 3, 4) });
  });
});

describe('stepping', () => {
  it('steps Today by one day, and Next comes back to the present', () => {
    const back = stepStatsRange(presetSpec('today'), -1);
    expect(span(back)).toEqual({ startMs: at(2026, 3, 24), endMs: at(2026, 3, 25) });
    expect(resolveStatsRange(back, NOW).canStepNext).toBe(true);

    const forward = stepStatsRange(back, 1);
    expect(forward).toEqual(presetSpec('today'));
    expect(resolveStatsRange(forward, NOW).canStepNext).toBe(false);
  });

  it('steps This week by whole Monday-based weeks', () => {
    expect(span(stepStatsRange(presetSpec('thisWeek'), -1))).toEqual({ startMs: at(2026, 3, 16), endMs: at(2026, 3, 23) });
  });

  it('steps This month by calendar month, whatever the month length', () => {
    const feb = stepStatsRange(presetSpec('thisMonth'), -1);
    expect(span(feb)).toEqual({ startMs: at(2026, 2, 1), endMs: at(2026, 3, 1) });
    expect(span(stepStatsRange(feb, -1))).toEqual({ startMs: at(2026, 1, 1), endMs: at(2026, 2, 1) });
  });

  it('steps a month from the last day of a long month without skipping one', () => {
    const march31 = at(2026, 3, 31, 10);
    expect(span(stepStatsRange(presetSpec('thisMonth'), -1), march31)).toEqual({ startMs: at(2026, 2, 1), endMs: at(2026, 3, 1) });
  });

  it('steps Last N days and a custom range by their own length', () => {
    expect(span(stepStatsRange(presetSpec('last7'), -1))).toEqual({ startMs: at(2026, 3, 12), endMs: at(2026, 3, 19) });

    const custom = customSpec({ year: 2026, month: 3, day: 1 }, { year: 2026, month: 3, day: 3 });
    expect(span(stepStatsRange(custom, -1))).toEqual({ startMs: at(2026, 2, 26), endMs: at(2026, 3, 1) });
    expect(span(stepStatsRange(custom, 1))).toEqual({ startMs: at(2026, 3, 4), endMs: at(2026, 3, 7) });
  });

  it('disables Next for every preset at the present', () => {
    for (const preset of ['today', 'thisWeek', 'thisMonth', 'last7', 'last30', 'last90', 'allTime'] as const) {
      expect(resolveStatsRange(presetSpec(preset), NOW).canStepNext, preset).toBe(false);
    }
  });

  it('disables Next for a custom range that ends today and clips its end to the present', () => {
    const r = resolveStatsRange(customSpec({ year: 2026, month: 3, day: 20 }, { year: 2026, month: 3, day: 25 }), NOW);
    expect(r.canStepNext).toBe(false);
    expect(r.endMs).toBe(NOW_END);
  });

  it('enables Next for a custom range that ended yesterday', () => {
    const r = resolveStatsRange(customSpec({ year: 2026, month: 3, day: 20 }, { year: 2026, month: 3, day: 24 }), NOW);
    expect(r.canStepNext).toBe(true);
  });
});

describe('previous period', () => {
  const previous = (spec: StatsRangeSpec, now = NOW) => resolveStatsRange(spec, now).previous;

  it('compares Today with the same elapsed span of yesterday', () => {
    expect(previous(presetSpec('today'))).toEqual({ startMs: at(2026, 3, 24), endMs: at(2026, 3, 24, 10, 1) });
  });

  it('compares This week with the same elapsed span of last week', () => {
    expect(previous(presetSpec('thisWeek'))).toEqual({ startMs: at(2026, 3, 16), endMs: at(2026, 3, 18, 10, 1) });
  });

  it('compares This month with the same elapsed span of last month', () => {
    expect(previous(presetSpec('thisMonth'))).toEqual({ startMs: at(2026, 2, 1), endMs: at(2026, 2, 25, 10, 1) });
  });

  it('caps the previous month at its own end when this month has more days elapsed', () => {
    expect(previous(presetSpec('thisMonth'), at(2026, 3, 31, 10))).toEqual({ startMs: at(2026, 2, 1), endMs: at(2026, 3, 1) });
    expect(previous(presetSpec('thisMonth'), at(2024, 3, 30, 10))).toEqual({ startMs: at(2024, 2, 1), endMs: at(2024, 3, 1) });
    expect(previous(presetSpec('thisMonth'), at(2026, 1, 31, 10))).toEqual({ startMs: at(2025, 12, 1), endMs: at(2025, 12, 31, 10, 1) });
  });

  it('compares a whole past month with the whole month before it', () => {
    expect(previous(stepStatsRange(presetSpec('thisMonth'), -1))).toEqual({ startMs: at(2026, 1, 1), endMs: at(2026, 2, 1) });
  });

  it('compares Last 7 days with the preceding span of equal elapsed length', () => {
    expect(previous(presetSpec('last7'))).toEqual({ startMs: at(2026, 3, 12), endMs: at(2026, 3, 18, 10, 1) });
    expect(previous(stepStatsRange(presetSpec('last7'), -1))).toEqual({ startMs: at(2026, 3, 5), endMs: at(2026, 3, 12) });
  });

  it('compares a custom range with the preceding equal span', () => {
    const custom = customSpec({ year: 2026, month: 3, day: 1 }, { year: 2026, month: 3, day: 3 });
    expect(previous(custom)).toEqual({ startMs: at(2026, 2, 26), endMs: at(2026, 3, 1) });
  });

  it('has no previous period for All time', () => {
    expect(previous(presetSpec('allTime'))).toBeNull();
  });
});

describe('the epoch bound', () => {
  // The host rejects a range that starts before the epoch, which a local midnight east of UTC does on 1970-01-01.
  it('starts at the first local midnight that is not before the epoch', () => {
    const first = firstDayMs();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(new Date(first).getHours()).toBe(0);
    expect(first).toBeLessThan(86_400_000);
  });

  it('neither steps back nor compares past the first day', () => {
    const d = new Date(firstDayMs());
    const firstDay = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
    const r = resolveStatsRange(customSpec(firstDay, firstDay), NOW);
    expect(r.startMs).toBe(firstDayMs());
    expect(r.canStepPrev).toBe(false);
    expect(r.previous).toBeNull();

    const next = new Date(firstDayMs());
    next.setDate(next.getDate() + 1);
    const secondDay = { year: next.getFullYear(), month: next.getMonth() + 1, day: next.getDate() };
    expect(resolveStatsRange(customSpec(secondDay, secondDay), NOW).canStepPrev).toBe(true);
  });
});

describe('auto bucket', () => {
  const bucket = (first: [number, number, number], last: [number, number, number]) =>
    resolveStatsRange(
      customSpec({ year: first[0], month: first[1], day: first[2] }, { year: last[0], month: last[1], day: last[2] }),
      NOW,
    ).bucket;

  it('buckets by day up to 31 days, by week up to 183, then by month', () => {
    expect(bucket([2026, 1, 1], [2026, 1, 31])).toBe('day');
    expect(bucket([2026, 1, 1], [2026, 2, 1])).toBe('week');
    expect(bucket([2025, 7, 1], [2025, 12, 30])).toBe('week');
    expect(bucket([2025, 7, 1], [2025, 12, 31])).toBe('month');
  });

  const dstMonths = [2025, 2026].flatMap((year) =>
    [1, 3, 5, 7, 8, 10, 12].filter((month) => new Date(year, month - 1, 1).getTimezoneOffset() !== new Date(year, month, 1).getTimezoneOffset())
      .map((month) => [year, month] as const));
  // Only the runner's zone can change `Date`'s offset, so a zone with no DST change in a 31-day month has nothing to check.
  it.skipIf(dstMonths.length === 0)('keeps a 31-day month that crosses a DST change on day buckets', () => {
    for (const [year, month] of dstMonths) {
      expect(bucket([year, month, 1], [year, month, 31]), `${year}-${month}`).toBe('day');
    }
  });

  it('picks the bucket for each preset', () => {
    expect(resolveStatsRange(presetSpec('today'), NOW).bucket).toBe('day');
    expect(resolveStatsRange(presetSpec('thisMonth'), NOW).bucket).toBe('day');
    expect(resolveStatsRange(presetSpec('last30'), NOW).bucket).toBe('day');
    expect(resolveStatsRange(presetSpec('last90'), NOW).bucket).toBe('week');
  });
});
