// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import StatsKpiGrid from '../StatsKpiGrid.vue';
import { i18n, applyLocale } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import type { UsageStatsTotals } from '@shared/types/usage-stats';

function totals(overrides: Partial<UsageStatsTotals> = {}): UsageStatsTotals {
  return {
    cost: 10,
    input: 1_000,
    output: 500,
    cacheRead: 3_000,
    cacheWrite: 1_000,
    unpricedTokens: 0,
    netCacheSavings: 2,
    requests: 20,
    sessions: 4,
    activeDays: 3,
    ...overrides,
  };
}

function mountGrid(current: UsageStatsTotals, previous: UsageStatsTotals | null) {
  return mount(StatsKpiGrid, { props: { totals: current, previous }, global: { plugins: [i18n] } });
}

function card(wrapper: ReturnType<typeof mountGrid>, id: string) {
  const el = wrapper.find(`[data-kpi="${id}"]`);
  if (!el.exists()) throw new Error(`no card ${id}`);
  return {
    value: el.find('[data-kpi-value]').text(),
    delta: el.find('[data-kpi-delta]').exists() ? el.find('[data-kpi-delta]') : null,
    note: el.find('[data-kpi-note]').exists() ? el.find('[data-kpi-note]').text() : null,
  };
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => applyLocale('en'));

describe('StatsKpiGrid', () => {
  it('renders the seven cards in order', () => {
    const wrapper = mountGrid(totals(), null);
    expect(wrapper.findAll('[data-kpi]').map((c) => c.attributes('data-kpi'))).toEqual([
      'cost', 'totalTokens', 'outputTokens', 'cacheHitRate', 'netCacheSavings', 'sessions', 'activeDays',
    ]);
  });

  it('derives total tokens and the cache hit rate from the four token counts', () => {
    const wrapper = mountGrid(totals(), null);
    expect(card(wrapper, 'totalTokens').value).toBe('5.5K');
    // 3000 / (1000 + 3000 + 1000)
    expect(card(wrapper, 'cacheHitRate').value).toBe('60%');
  });

  it('shows no deltas when compare is off', () => {
    const wrapper = mountGrid(totals(), null);
    expect(wrapper.findAll('[data-kpi-delta]')).toHaveLength(0);
  });

  it('shows relative deltas against the previous period', () => {
    const wrapper = mountGrid(totals({ cost: 15, sessions: 2 }), totals({ cost: 10, sessions: 4 }));
    expect(card(wrapper, 'cost').delta?.text()).toBe('+50%');
    expect(card(wrapper, 'sessions').delta?.text()).toBe('-50%');
    expect(card(wrapper, 'cost').delta?.attributes('title')).toBe('Previous period: $10.00');
  });

  it('shows the cache hit rate change in percentage points', () => {
    // 60% now against 40% before: 2000 / (2000 + 2000 + 1000)
    const wrapper = mountGrid(totals(), totals({ input: 2_000, cacheRead: 2_000 }));
    expect(card(wrapper, 'cacheHitRate').delta?.text()).toBe('+20 pp');
  });

  it('colors spend neutral whichever way it moves and cache improvements as success', () => {
    const up = mountGrid(totals({ cost: 20, netCacheSavings: 5 }), totals({ cost: 10, netCacheSavings: 2, cacheRead: 1_000 }));
    expect(card(up, 'cost').delta?.classes()).toContain('text-muted-foreground');
    expect(card(up, 'totalTokens').delta?.classes()).toContain('text-muted-foreground');
    expect(card(up, 'cacheHitRate').delta?.classes()).toContain('text-success');
    expect(card(up, 'netCacheSavings').delta?.classes()).toContain('text-success');

    const down = mountGrid(totals({ netCacheSavings: 1, cacheRead: 1_000 }), totals({ netCacheSavings: 2 }));
    expect(card(down, 'cacheHitRate').delta?.classes()).toContain('text-muted-foreground');
    expect(card(down, 'netCacheSavings').delta?.classes()).toContain('text-muted-foreground');
  });

  it('shows "new" where the previous value is zero', () => {
    const empty = totals({ cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, netCacheSavings: 0, sessions: 0, activeDays: 0, requests: 0 });
    const wrapper = mountGrid(totals(), empty);
    for (const id of ['cost', 'totalTokens', 'outputTokens', 'cacheHitRate', 'netCacheSavings', 'sessions', 'activeDays']) {
      expect(card(wrapper, id).delta?.text(), id).toBe('new');
    }
  });

  it('shows no delta where both periods are zero', () => {
    const wrapper = mountGrid(totals({ sessions: 0 }), totals({ sessions: 0 }));
    expect(card(wrapper, 'sessions').delta).toBeNull();
  });

  it('lists unpriced tokens on the cost card instead of folding them into the cost', () => {
    const wrapper = mountGrid(totals({ unpricedTokens: 12_000 }), null);
    expect(card(wrapper, 'cost').value).toBe('$10.00');
    expect(card(wrapper, 'cost').note).toBe('plus 12K unpriced tokens');

    const priced = mountGrid(totals(), null);
    expect(card(priced, 'cost').note).toBeNull();
  });

  it('marks the cost as an estimate when the account is not dollar-billed', async () => {
    const wrapper = mountGrid(totals(), null);
    expect(wrapper.find('[data-kpi="cost"]').text()).toContain('API-equivalent cost');
    expect(card(wrapper, 'cost').value).toBe('$10.00');

    useSettingsStore().setAccountInfo({ model: 'claude-opus-4-5', subscriptionType: 'allowance', dollarBilled: false });
    await nextTick();

    expect(card(wrapper, 'cost').value).toBe('~$10.00 est.');
    expect(wrapper.find('[data-kpi="cost"] [data-kpi-value]').attributes('title')).toBeTruthy();
  });

  it('shows n/a for the hit rate when no prompt token was read', () => {
    const wrapper = mountGrid(totals({ input: 0, cacheRead: 0, cacheWrite: 0 }), null);
    expect(card(wrapper, 'cacheHitRate').value).toBe('n/a');
  });

  it('renders every label in Greek', async () => {
    applyLocale('el');
    const wrapper = mountGrid(totals(), totals({ cost: 5 }));
    await nextTick();
    expect(wrapper.find('[data-kpi="cost"]').text()).toContain('Κόστος σε τιμές API');
    expect(wrapper.find('[data-kpi="activeDays"]').text()).toContain('Ενεργές ημέρες');
  });
});
