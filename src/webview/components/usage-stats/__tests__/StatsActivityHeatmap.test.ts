// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import StatsActivityHeatmap from '../StatsActivityHeatmap.vue';
import { i18n } from '@/i18n';
import type { UsageStatsHeatmapCell } from '@shared/types/usage-stats';

// Monday 09:00 costs most; Sunday 23:00 uses the most tokens; Wednesday 12:00 ran only unpriced models.
const CELLS: UsageStatsHeatmapCell[] = [
  { weekday: 0, hour: 9, cost: 4, tokens: 100, requests: 2 },
  { weekday: 6, hour: 23, cost: 1, tokens: 9_000, requests: 5 },
  { weekday: 2, hour: 12, cost: 0, tokens: 1, requests: 1 },
];

function mountHeatmap(metric: 'cost' | 'tokens') {
  return mount(StatsActivityHeatmap, { props: { cells: CELLS, metric }, global: { plugins: [i18n] } });
}

const cell = (w: ReturnType<typeof mountHeatmap>, weekday: number, hour: number) => w.get(`[data-cell="${weekday}-${hour}"]`);
const shade = (w: ReturnType<typeof mountHeatmap>, weekday: number, hour: number): number => {
  const match = /--heat:\s*(\d+)%/.exec(cell(w, weekday, hour).attributes('style') ?? '');
  return match ? Number(match[1]) : 0;
};

beforeEach(() => setActivePinia(createPinia()));

describe('StatsActivityHeatmap', () => {
  it('renders a Monday-first 7 by 24 table with weekday row headers and hour column headers', () => {
    const w = mountHeatmap('cost');
    const table = w.get('table');
    expect(table.attributes('aria-labelledby')).toBe(w.get('h3').attributes('id'));
    const hours = table.findAll('thead th[scope="col"]');
    expect(hours).toHaveLength(24);
    expect(hours[9]!.get('.sr-only').text()).toBe('09:00');
    const days = table.findAll('tbody th[scope="row"]');
    expect(days.map((d) => d.get('.sr-only').text())).toEqual(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']);

    const cells = w.findAll('[data-cell]');
    expect(cells).toHaveLength(7 * 24);
    expect(cells.every((c) => c.element.tagName === 'TD' && c.get('.sr-only').text().length > 0)).toBe(true);
    expect(w.find('[role="img"]').exists()).toBe(false);
    expect(cells[0]!.attributes('data-cell')).toBe('0-0');
    expect(cell(w, 0, 9).get('.sr-only').text()).toBe('$4.00, 100 tokens, 2 requests');
    expect(cell(w, 0, 9).attributes('title')).toMatch(/^Monday .*: \$4\.00, 100 tokens, 2 requests$/);
    expect(cell(w, 3, 3).get('.sr-only').text()).toBe('no usage');
  });

  it('reads an hour spent only on unpriced models as unpriced rather than $0.00, in the singular for one', () => {
    const w = mountHeatmap('cost');
    expect(cell(w, 2, 12).get('.sr-only').text()).toBe('unpriced, 1 token, 1 request');
  });

  it('shades by the chosen metric, leaving empty hours unshaded', () => {
    const byCost = mountHeatmap('cost');
    expect(shade(byCost, 0, 9)).toBe(100);
    expect(shade(byCost, 6, 23)).toBeLessThan(shade(byCost, 0, 9));
    expect(cell(byCost, 3, 3).attributes('style')).toBeUndefined();
    expect(cell(byCost, 3, 3).classes()).toContain('bg-muted/40');
    expect(cell(byCost, 0, 9).classes().join(' ')).toContain('var(--chart-1)');

    const byTokens = mountHeatmap('tokens');
    expect(shade(byTokens, 6, 23)).toBe(100);
    expect(shade(byTokens, 0, 9)).toBeLessThan(shade(byTokens, 6, 23));
  });
});
