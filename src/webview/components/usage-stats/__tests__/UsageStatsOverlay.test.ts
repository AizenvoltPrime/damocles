// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import UsageStatsOverlay from '../UsageStatsOverlay.vue';
import { i18n } from '@/i18n';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { UsageStatsReport } from '@shared/types/usage-stats';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));
vi.mock('@unovis/vue', () => import('./unovis-stub'));

function report(requests: number, indexedAtMs: number | null): UsageStatsReport {
  return {
    range: { startMs: 0, endMs: 1 },
    totals: { cost: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, netCacheSavings: 0, requests, sessions: 1, activeDays: 1 },
    previousTotals: null,
    filterOptions: {
      models: [{ key: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5' }],
      projects: [{ key: 'c:\\work\\app', cwd: 'C:\\work\\app' }, { key: '', cwd: null }],
    },
    indexedAtMs,
  };
}

function latestId(): string {
  const msg = posted[posted.length - 1];
  if (msg?.type !== 'requestUsageStats') throw new Error('no request');
  return msg.requestId;
}

async function open() {
  const store = useUsageStatsStore();
  store.openOverlay();
  const wrapper = mount(UsageStatsOverlay, { global: { plugins: [i18n] }, attachTo: document.body });
  await nextTick();
  return { store, wrapper };
}

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});

describe('UsageStatsOverlay', () => {
  it('shows indexing progress on a first scan and holds back the partial index', async () => {
    const { store, wrapper } = await open();
    const id = latestId();
    store.handleResult({ type: 'usageStats', requestId: id, final: false, report: report(5, null) });
    store.handleProgress({ type: 'usageStatsProgress', requestId: id, filesDone: 40, filesTotal: 100 });
    await nextTick();

    expect(wrapper.text()).toContain('Indexing conversation files');
    expect(wrapper.text()).toContain('40 of 100 files');
    expect(wrapper.find('[data-kpi]').exists()).toBe(false);

    store.handleResult({ type: 'usageStats', requestId: id, final: true, report: report(5, 2_000) });
    await nextTick();
    expect(wrapper.find('[data-kpi="cost"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Updated');
  });

  it('shows cached numbers at once while a later scan runs', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: false, report: report(5, 1_000) });
    await nextTick();
    expect(wrapper.find('[data-kpi="cost"]').exists()).toBe(true);
  });

  it('shows the empty state when the range has no usage', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: true, report: report(0, 1_000) });
    await nextTick();
    expect(wrapper.text()).toContain('No usage in this range');
  });

  it('keeps the empty state while a reload runs, instead of flashing a dashboard of zeros', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: true, report: report(0, 1_000) });
    await nextTick();

    store.refresh();
    await nextTick();

    expect(store.status).toBe('loading');
    expect(wrapper.find('[data-empty]').exists()).toBe(true);
    expect(wrapper.find('[data-kpi]').exists()).toBe(false);
  });

  it('names the current preset on the range picker and disables Compare for All time', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: true, report: report(5, 1_000) });
    await nextTick();

    expect(wrapper.find('button[aria-label="Date range: Last 30 days"]').exists()).toBe(true);
    const compare = wrapper.get('button[role="switch"]');
    expect(compare.attributes('disabled')).toBeUndefined();

    store.setRange({ preset: 'allTime' });
    await nextTick();

    expect(wrapper.find('button[aria-label="Date range: All time"]').exists()).toBe(true);
    expect(compare.attributes('disabled')).toBeDefined();
  });

  it('shows the error with a Retry that sends a new request', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: true, report: null, error: 'worker exited' });
    await nextTick();
    expect(wrapper.text()).toContain('worker exited');

    const before = posted.length;
    const retry = wrapper.findAll('button').find((b) => b.text() === 'Retry');
    await retry!.trigger('click');
    expect(posted.length).toBe(before + 1);
    expect(store.status).toBe('loading');
  });

  it('lists projects by folder name with the full path as the title, and the null project as No project', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: true, report: report(5, 1_000) });
    await nextTick();

    await wrapper.find('button[aria-label="Projects: All projects"]').trigger('click');
    await nextTick();
    const items = [...document.body.querySelectorAll('[role="option"]')];
    expect(items.map((i) => i.textContent?.trim())).toEqual(['app', 'No project']);
    expect(items[0]!.getAttribute('title')).toBe('C:\\work\\app');

    (items[1] as HTMLElement).click();
    await nextTick();
    const msg = posted[posted.length - 1];
    expect(msg?.type === 'requestUsageStats' && msg.query).toMatchObject({ projectKeys: [''], scan: false });
  });

  it('keeps the search text across picks in a multi-select filter', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: true, report: report(5, 1_000) });
    await nextTick();

    await wrapper.find('button[aria-label="Projects: All projects"]').trigger('click');
    await nextTick();
    const search = document.body.querySelector<HTMLInputElement>('input')!;
    search.value = 'app';
    search.dispatchEvent(new Event('input'));
    await nextTick();

    (document.body.querySelector('[role="option"]') as HTMLElement).click();
    await nextTick();

    expect(store.projectKeys).toEqual(['c:\\work\\app']);
    expect(document.body.querySelector<HTMLInputElement>('input')!.value).toBe('app');
  });

  it('opens a calendar whose weeks start on Monday', async () => {
    const { wrapper } = await open();
    await wrapper.find('button[aria-label^="Pick a custom range"]').trigger('click');
    await nextTick();
    const firstCell = document.body.querySelector('[data-reka-calendar-cell-trigger]');
    const [y, m, d] = firstCell!.getAttribute('data-value')!.split('-').map(Number);
    expect(new Date(y!, m! - 1, d!).getDay()).toBe(1);
  });

  it('labels the calendar month buttons in the UI language', async () => {
    const { wrapper } = await open();
    i18n.global.locale.value = 'el';
    try {
      await nextTick();
      await wrapper.find('button[aria-label^="Επιλογή προσαρμοσμένου διαστήματος"]').trigger('click');
      await nextTick();
      expect(document.body.querySelector('button[aria-label="Προηγούμενος μήνας"]')).not.toBeNull();
      expect(document.body.querySelector('button[aria-label="Επόμενος μήνας"]')).not.toBeNull();
      expect(document.body.querySelector('button[aria-label="Previous page"]')).toBeNull();
    } finally {
      i18n.global.locale.value = 'en';
    }
  });

  it('lets the calendar pick today after the overlay has stayed open past midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(2025, 0, 14, 23, 59));
      const { store, wrapper } = await open();
      store.setRange({ preset: 'today', offset: 0 });
      await nextTick();
      vi.setSystemTime(new Date(2025, 0, 15, 0, 5));

      await wrapper.find('button[aria-label^="Pick a custom range"]').trigger('click');
      await nextTick();
      const cellFor = (value: string) => document.body.querySelector(`[data-reka-calendar-cell-trigger][data-value="${value}"]`);
      expect(cellFor('2025-01-15')?.hasAttribute('data-disabled')).toBe(false);
      expect(cellFor('2025-01-16')?.hasAttribute('data-disabled')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('places the chart under the KPIs and the breakdowns below it, sharing one metric toggle', async () => {
    const { store, wrapper } = await open();
    const agg = { cost: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 5 };
    store.handleResult({
      type: 'usageStats',
      requestId: latestId(),
      final: true,
      report: {
        ...report(5, 1_000),
        series: { bucket: 'month', points: [] },
        byModel: [{ key: 'anthropic/claude-opus-4-5', label: 'Claude Opus 4.5', ...agg }],
        byProject: [{ key: 'c:\\work\\app', cwd: 'C:\\work\\app', ...agg }],
        bySource: [{ source: 'main', detail: null, ...agg }],
      },
    });
    await nextTick();

    const order = [...wrapper.element.querySelectorAll('[data-kpi="cost"], [data-chart-legend], [data-breakdown="model"]')];
    expect(order.map((el) => (el as HTMLElement).dataset['kpi'] ?? ((el as HTMLElement).dataset['breakdown'] ? 'breakdown' : 'chart'))).toEqual(['cost', 'chart', 'breakdown']);
    expect(wrapper.get('[role="img"]').attributes('aria-describedby')).toBe(wrapper.get('[data-chart-table]').attributes('id'));

    const sent = posted.length;
    const tokens = wrapper.findAll('[data-toggle="metric"] button').find((b) => b.text() === 'Tokens')!;
    await tokens.trigger('click');
    await nextTick();
    expect(wrapper.get('[data-breakdown="model"] th[aria-sort="descending"]').text()).toContain('Tokens');
    expect(posted.length).toBe(sent);
  });

  it('scans again from Refresh', async () => {
    const { store, wrapper } = await open();
    store.handleResult({ type: 'usageStats', requestId: latestId(), final: true, report: report(5, 1_000) });
    await nextTick();

    await wrapper.find('button[aria-label="Refresh"]').trigger('click');
    const msg = posted[posted.length - 1];
    expect(msg?.type === 'requestUsageStats' && msg.query.scan).toBe(true);
  });
});
