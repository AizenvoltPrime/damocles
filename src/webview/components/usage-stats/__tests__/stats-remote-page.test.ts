// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { UsageStatsAggregate, UsageStatsReport } from '@shared/types/usage-stats';

// A remote chat's page: its core answers /stats from the host's own index, and the page knows only its own host.
vi.hoisted(() => {
  (globalThis as unknown as { window: Record<string, unknown> }).window ??= {};
});

vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: () => undefined }) }));

window.damoclesBridge = {
  postMessage: () => undefined,
  onMessage: () => () => undefined,
  getState: () => undefined,
  setState: () => undefined,
  getHost: () => ({ hostId: 'h1', name: 'prod-1', computer: 'ALEXIOS-PC' }),
  onHost: () => () => undefined,
  getHostNames: () => undefined,
  onHostNames: () => () => undefined,
  getOffline: () => undefined,
  hostAction: () => undefined,
  getConnection: () => undefined,
  onConnection: () => () => undefined,
  queueAction: () => undefined,
};

const { default: StatsBreakdown } = await import('../StatsBreakdown.vue');
const { i18n } = await import('@/i18n');

enableAutoUnmount(afterEach);

const agg = (cost: number): UsageStatsAggregate => ({ cost, input: cost * 100, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1 });

const report: UsageStatsReport = {
  range: { startMs: 0, endMs: 1 },
  totals: { cost: 4, input: 400, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, netCacheSavings: 0, requests: 2, sessions: 1, activeDays: 1 },
  previousTotals: null,
  filterOptions: { models: [], projects: [{ key: '/srv/api', cwd: '/srv/api' }] },
  indexedAtMs: 1,
  byProject: [{ key: '/srv/api', cwd: '/srv/api', ...agg(4) }],
  byCredential: [{ credential: 'signIn', ...agg(3) }, { credential: 'host', ...agg(1) }],
};

describe('/stats on a remote chat\'s core', () => {
  it('names the host\'s own credential spend after the page\'s own host, and marks no project with a host', () => {
    setActivePinia(createPinia());
    const wrapper = mount(StatsBreakdown, { props: { report, metric: 'cost' }, global: { plugins: [i18n] }, attachTo: document.body });
    const host = wrapper.get('[data-breakdown="credential"]').findAll('tbody tr').find((r) => r.attributes('data-row') === 'credential:host');
    expect(host?.text()).toContain('prod-1\'s environment');
    expect(wrapper.find('[data-stats-host]').exists()).toBe(false);
  });
});
