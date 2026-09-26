import { describe, it, expect } from 'vitest';
import { CHART_COLOR_COUNT, OTHER_MODELS_SERIES, chartColor, chartRows, rankModels } from '../stats-chart-data';
import type { UsageStatsModelRow, UsageStatsSeriesPoint } from '@shared/types/usage-stats';

function point(bucket: string, modelKey: string | null, cost: number): UsageStatsSeriesPoint {
  return {
    bucket, modelKey, input: 0, output: cost * 10, cacheRead: 0, cacheWrite: 0,
    costInput: 0, costOutput: cost, costCacheRead: 0, costCacheWrite: 0, cost,
  };
}

const model = (key: string, cost: number): UsageStatsModelRow => ({
  key, label: key, cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1,
});

describe('chartRows', () => {
  const SONNET = 'anthropic/claude-sonnet-4-5';
  // Jan 13 to Jan 15 2025 by day, in this machine's zone.
  const range = { startMs: new Date(2025, 0, 13).getTime(), endMs: new Date(2025, 0, 16).getTime() };

  it('keeps a point whose bucket is outside the expected keys, in key order, so the chart sums to the total', () => {
    const points = [point('2025-01-14', SONNET, 1), point('2025-01-12', SONNET, 0.25), point('2025-01-16', SONNET, 2)];
    const { rows } = chartRows({ bucket: 'day', points }, range, [model(SONNET, 3.25)], 'cost', 'model');
    expect(rows.map((r) => [r.bucket, r[SONNET]])).toEqual([
      ['2025-01-12', 0.25],
      ['2025-01-13', 0],
      ['2025-01-14', 1],
      ['2025-01-15', 0],
      ['2025-01-16', 2],
    ]);
    expect(rows.reduce((acc, r) => acc + (r[SONNET] as number), 0)).toBe(3.25);
  });
});

describe('rankModels', () => {
  it('gives the first seven models their own color and groups the tail as other in the color the breakdown gives ranks 7 and up', () => {
    const byModel = Array.from({ length: CHART_COLOR_COUNT + 2 }, (_, rank) => model(`p/m${rank}`, 100 - rank));
    const { series, seriesOf } = rankModels(byModel);
    expect(series).toHaveLength(CHART_COLOR_COUNT);
    expect(series.at(-1)).toEqual({ key: OTHER_MODELS_SERIES, color: chartColor(CHART_COLOR_COUNT - 1) });
    byModel.forEach((m, rank) => {
      if (rank < CHART_COLOR_COUNT - 1) {
        expect(seriesOf(m.key)).toBe(m.key);
        expect(series[rank]!.color).toBe(chartColor(rank));
      } else {
        expect(seriesOf(m.key)).toBe(OTHER_MODELS_SERIES);
        expect(chartColor(rank)).toBe(series.at(-1)!.color);
      }
    });
  });

  it('keeps every model its own series when they fit the palette', () => {
    const byModel = Array.from({ length: CHART_COLOR_COUNT }, (_, rank) => model(`p/m${rank}`, 100 - rank));
    const { series } = rankModels(byModel);
    expect(series.map((s) => s.key)).toEqual(byModel.map((m) => m.key));
    expect(series.map((s) => s.color)).toEqual(byModel.map((_, rank) => chartColor(rank)));
  });
});
