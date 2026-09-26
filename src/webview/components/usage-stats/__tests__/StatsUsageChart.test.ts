// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { defineComponent, h, nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import StatsUsageChart from '../StatsUsageChart.vue';
import { bucketKeys } from '../stats-chart-data';
import { rendered } from './unovis-stub';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { UsageStatsModelRow, UsageStatsSeries, UsageStatsSeriesPoint } from '@shared/types/usage-stats';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

vi.mock('@unovis/vue', () => import('./unovis-stub'));

const SONNET = 'anthropic/claude-sonnet-4-5';
const GPT = 'openai/gpt-5';

function point(bucket: string, modelKey: string | null, over: Partial<UsageStatsSeriesPoint>): UsageStatsSeriesPoint {
  return {
    bucket, modelKey, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, cost: 0, ...over,
  };
}

const model = (key: string | null, label: string | null, cost: number): UsageStatsModelRow => ({
  key, label, cost, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1,
});

// Jan 13 to Jan 19 2025 by day, with usage on two days only.
const range = { startMs: new Date(2025, 0, 13).getTime(), endMs: new Date(2025, 0, 20).getTime() };
const series: UsageStatsSeries = {
  bucket: 'day',
  points: [
    point('2025-01-14', SONNET, { input: 100, output: 50, cacheRead: 1_000, costInput: 0.3, costOutput: 0.7, costCacheRead: 0.1, cost: 1.1 }),
    point('2025-01-14', GPT, { input: 10, output: 5, cost: 0.2, costInput: 0.1, costOutput: 0.1 }),
    point('2025-01-17', SONNET, { output: 40, cost: 0.5, costOutput: 0.5 }),
  ],
};
const byModel = [model(SONNET, 'Claude Sonnet 4.5', 1.6), model(GPT, 'GPT-5', 0.2)];

type Datum = Record<string, number | string>;

/** The tooltip markup Unovis would show on hovering the bar at `index`. */
function tooltipHtml(index: number): string {
  const data = rendered.container['data'] as Datum[];
  const template = rendered.crosshair['template'] as (d: Datum) => string;
  return template(data[index]!);
}

/** The tooltip's rows as name and value pairs. */
function tooltipRows(index: number): string[][] {
  const host = document.createElement('div');
  host.innerHTML = tooltipHtml(index);
  const names = [...host.querySelectorAll('.truncate')].map((el) => el.textContent?.trim() ?? '');
  const values = [...host.querySelectorAll('.tabular-nums')].map((el) => el.textContent?.trim() ?? '');
  return names.map((name, i) => [name, values[i] ?? '']);
}

function barValues(): number[][] {
  const data = rendered.container['data'] as Datum[];
  const y = rendered.bar['y'] as Array<(d: Datum) => number>;
  return data.map((d) => y.map((acc) => acc(d)));
}

async function mountChart(chartSeries: UsageStatsSeries = series) {
  const Host = defineComponent({
    data: () => ({ metric: 'cost' as 'cost' | 'tokens' }),
    render() {
      return h(StatsUsageChart, {
        series: chartSeries,
        range,
        byModel,
        metric: this.metric,
        'onUpdate:metric': (v: 'cost' | 'tokens') => { this.metric = v; },
      });
    },
  });
  const wrapper = mount(Host, { global: { plugins: [i18n] }, attachTo: document.body });
  await nextTick();
  return wrapper;
}

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('bucketKeys', () => {
  it('zero-fills days, Monday weeks and months across the range', () => {
    expect(bucketKeys(range, 'day', [])).toEqual(['2025-01-13', '2025-01-14', '2025-01-15', '2025-01-16', '2025-01-17', '2025-01-18', '2025-01-19']);
    const quarter = { startMs: new Date(2025, 0, 1).getTime(), endMs: new Date(2025, 1, 5).getTime() };
    expect(bucketKeys(quarter, 'week', [])).toEqual(['2024-12-30', '2025-01-06', '2025-01-13', '2025-01-20', '2025-01-27', '2025-02-03']);
    expect(bucketKeys(quarter, 'month', [])).toEqual(['2025-01', '2025-02']);
  });

  it('starts All time at the earliest bucket with usage', () => {
    const allTime = { startMs: 0, endMs: new Date(2025, 2, 10).getTime() };
    expect(bucketKeys(allTime, 'month', [point('2025-01', null, {})])).toEqual(['2025-01', '2025-02', '2025-03']);
    expect(bucketKeys(allTime, 'month', [])).toEqual([]);
  });
});

describe('StatsUsageChart', () => {
  it('zero-fills the empty days and stacks cost by model in cost rank order', async () => {
    const wrapper = await mountChart();
    expect((rendered.container['data'] as Datum[]).map((d) => d['title'])).toHaveLength(7);
    expect(barValues()).toEqual([[0, 0], [1.1, 0.2], [0, 0], [0, 0], [0.5, 0], [0, 0], [0, 0]]);
    expect(wrapper.findAll('[data-chart-legend] li').map((li) => li.text())).toEqual(['Claude Sonnet 4.5', 'GPT-5']);
    const section = wrapper.get('section');
    expect(section.attributes('aria-label')).toBeUndefined();
    expect(wrapper.get(`#${section.attributes('aria-labelledby')}`).text()).toBe('Usage over time');
  });

  it('describes the chart with a hidden table of every period and category', async () => {
    const wrapper = await mountChart();
    const table = wrapper.get('[data-chart-table]');
    expect(wrapper.get('[role="img"]').attributes('aria-describedby')).toBe(table.attributes('id'));
    expect(table.classes()).toContain('sr-only');
    expect(table.findAll('thead th').map((th) => th.text())).toEqual(['Period', 'Claude Sonnet 4.5', 'GPT-5', 'Total']);
    const rows = table.findAll('tbody tr');
    expect(rows).toHaveLength(7);
    expect(rows[1]!.findAll('th, td').map((c) => c.text())).toEqual([expect.stringContaining('14'), '$1.10', '$0.20', '$1.30']);

    const byType = wrapper.findAll('[data-toggle="split"] button').find((b) => b.text() === 'By token type')!;
    await byType.trigger('click');
    await nextTick();
    expect(table.findAll('thead th').map((th) => th.text())).toEqual(['Period', 'Input', 'Output', 'Cache read', 'Cache write', 'Total']);
  });

  it('totals the tooltip from the recorded cost, which the token-type components need not sum to', async () => {
    const rounded: UsageStatsSeries = {
      bucket: 'day',
      points: [point('2025-01-14', SONNET, { input: 100, output: 50, costInput: 0.3, costOutput: 0.6, cost: 1 })],
    };
    const wrapper = await mountChart(rounded);
    const byType = wrapper.findAll('[data-toggle="split"] button').find((b) => b.text() === 'By token type')!;
    await byType.trigger('click');
    await nextTick();

    expect(tooltipRows(1)).toEqual([['Input', '$0.30'], ['Output', '$0.60'], ['Total', '$1.00']]);
  });

  it('re-renders a cached tooltip when only the billing flag changes', async () => {
    await mountChart();
    expect(tooltipHtml(1)).not.toContain('est.');

    useSettingsStore().setAccountInfo({ model: 'claude-opus-5-5', subscriptionType: 'allowance', dollarBilled: false });
    await nextTick();

    expect(tooltipHtml(1)).toContain('~$1.10 est.');
  });

  it('switches metric and split without sending a request', async () => {
    const wrapper = await mountChart();
    // Variant and size style the items; the group root declares neither, so they must not land on it as attributes.
    expect(wrapper.get('[data-toggle="metric"]').attributes('variant')).toBeUndefined();
    expect(wrapper.get('[data-toggle="metric"]').attributes('size')).toBeUndefined();

    const tokensButton = wrapper.findAll('[data-toggle="metric"] button').find((b) => b.text() === 'Tokens')!;
    await tokensButton.trigger('click');
    await nextTick();
    expect(barValues()[1]).toEqual([1_150, 15]);

    const byType = wrapper.findAll('[data-toggle="split"] button').find((b) => b.text() === 'By token type')!;
    await byType.trigger('click');
    await nextTick();
    expect(wrapper.findAll('[data-chart-legend] li').map((li) => li.text())).toEqual(['Input', 'Output', 'Cache read', 'Cache write']);
    expect(barValues()[1]).toEqual([110, 55, 1_000, 0]);

    const costButton = wrapper.findAll('[data-toggle="metric"] button').find((b) => b.text() === 'Cost')!;
    await costButton.trigger('click');
    await nextTick();
    expect(barValues()[1]).toEqual([expect.closeTo(0.4), expect.closeTo(0.8), expect.closeTo(0.1), 0]);

    expect(posted).toHaveLength(0);
  });
});
