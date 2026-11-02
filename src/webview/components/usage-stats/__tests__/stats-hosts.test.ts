// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import type { BridgeHostName } from '@shared/damocles-bridge';
import type { UsageStatsAggregate, UsageStatsReport } from '@shared/types/usage-stats';

type Names = Readonly<Record<string, BridgeHostName>>;

// A local chat's page of the desktop app: main's init carries this computer's host names, and a rename resends them.
const page = vi.hoisted(() => {
  const state: { names: Names; listener: ((names: Names) => void) | undefined } = {
    names: { h1: { name: 'prod-1', color: 'danger' }, h2: { name: 'lab-02' } },
    listener: undefined,
  };
  (globalThis as unknown as { window: Record<string, unknown> }).window ??= {};
  return state;
});

vi.mock('@/composables/usePlatformBridge', () => ({ usePlatformBridge: () => ({ postMessage: () => undefined }) }));

window.damoclesBridge = {
  postMessage: () => undefined,
  onMessage: () => () => undefined,
  getState: () => undefined,
  setState: () => undefined,
  getHost: () => undefined,
  onHost: () => () => undefined,
  getHostNames: () => page.names,
  onHostNames: (listener) => {
    page.listener = listener;
    return () => undefined;
  },
  getOffline: () => undefined,
  hostAction: () => undefined,
  getConnection: () => undefined,
  onConnection: () => () => undefined,
  allowYolo: async () => false,
  queueAction: () => undefined,
};

const { default: StatsBreakdown } = await import('../StatsBreakdown.vue');
const { default: StatsTopSessions } = await import('../StatsTopSessions.vue');
const { default: StatsFilterBar } = await import('../StatsFilterBar.vue');
const { useUsageStatsStore } = await import('@/stores/useUsageStatsStore');
const { i18n, applyLocale } = await import('@/i18n');

enableAutoUnmount(afterEach);
beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  applyLocale('en');
  page.listener?.({ h1: { name: 'prod-1', color: 'danger' }, h2: { name: 'lab-02' } });
});

const agg = (cost: number): UsageStatsAggregate => ({ cost, input: cost * 100, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1 });

const LOCAL = 'c:\\work\\alpha';
const PROD = 'remote:h1|/srv/api';
const GONE = 'remote:h9|/home/u/old';

function report(): UsageStatsReport {
  return {
    range: { startMs: 0, endMs: 1 },
    totals: { cost: 10, input: 1_000, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, netCacheSavings: 0, requests: 3, sessions: 3, activeDays: 1 },
    previousTotals: null,
    filterOptions: {
      models: [],
      projects: [{ key: LOCAL, cwd: 'C:\\Work\\alpha' }, { key: PROD, cwd: '/srv/api', hostId: 'h1' }, { key: GONE, cwd: '/home/u/old', hostId: 'h9' }],
    },
    indexedAtMs: 1,
    byProject: [
      { key: PROD, cwd: '/srv/api', hostId: 'h1', ...agg(5) },
      { key: LOCAL, cwd: 'C:\\Work\\alpha', ...agg(3) },
      { key: GONE, cwd: '/home/u/old', hostId: 'h9', ...agg(2) },
    ],
    byCredential: [
      { credential: 'signIn', ...agg(6) },
      { credential: 'host', hostId: 'h1', ...agg(3) },
      { credential: 'host', hostId: 'h2', ...agg(1) },
    ],
  };
}

const mountBreakdown = () => mount(StatsBreakdown, { props: { report: report(), metric: 'cost' }, global: { plugins: [i18n] }, attachTo: document.body });

function rowOf(wrapper: ReturnType<typeof mountBreakdown>, sectionId: string, rowId: string) {
  const found = wrapper.get(`[data-breakdown="${sectionId}"]`).findAll('tbody tr').find((r) => r.attributes('data-row') === rowId);
  if (!found) throw new Error(`no row ${rowId}`);
  return found;
}

const hostChip = (el: { find: (selector: string) => { exists: () => boolean; text: () => string; classes: () => string[] } }) => {
  const chip = el.find('[data-stats-host]');
  return chip.exists() ? { name: chip.text(), tone: chip.classes().find((c) => c.startsWith('d-tone-')) } : null;
};

// the badge swaps an old name out through its leave transition
const settle = async (): Promise<void> => {
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('/stats on this computer\'s core, with remote spend', () => {
  it('labels each remote project with its host as this computer names it, and a forgotten host as removed', () => {
    const wrapper = mountBreakdown();
    expect(hostChip(rowOf(wrapper, 'project', `project:${PROD}`))).toEqual({ name: 'prod-1', tone: 'd-tone-danger' });
    expect(rowOf(wrapper, 'project', `project:${PROD}`).find('button').text()).toBe('api');
    expect(hostChip(rowOf(wrapper, 'project', `project:${LOCAL}`))).toBeNull();
    expect(hostChip(rowOf(wrapper, 'project', `project:${GONE}`))).toEqual({ name: 'Removed host', tone: 'd-tone-muted' });
    // in a narrow column the chip gives way too, so the folder keeps a few letters
    const chip = rowOf(wrapper, 'project', `project:${PROD}`).get('[data-stats-host]').classes();
    expect(chip).toContain('shrink');
    expect(chip).not.toContain('shrink-0');
  });

  it('attributes a host\'s own credential spend to that host\'s environment', () => {
    const wrapper = mountBreakdown();
    expect(rowOf(wrapper, 'credential', 'credential:host:h1').text()).toContain('prod-1\'s environment');
    expect(rowOf(wrapper, 'credential', 'credential:host:h1').get('span.truncate').attributes('title')).toBe('Spend prod-1 paid with a credential of its own, for a provider you were not signed in to');
    expect(rowOf(wrapper, 'credential', 'credential:host:h2').text()).toContain('lab-02\'s environment');
    expect(rowOf(wrapper, 'credential', 'credential:signIn').text()).toContain('Your sign-ins');
  });

  it('names the hosts again after a rename or recolor on this computer', async () => {
    const wrapper = mountBreakdown();
    page.listener?.({ h1: { name: 'api-prod', color: 'info' }, h2: { name: 'lab-02' } });
    await settle();
    expect(hostChip(rowOf(wrapper, 'project', `project:${PROD}`))).toEqual({ name: 'api-prod', tone: 'd-tone-info' });
    expect(rowOf(wrapper, 'credential', 'credential:host:h1').text()).toContain('api-prod\'s environment');
  });

  it('names the host in the project filter and the drill-in chip, which carry no host badge', async () => {
    const store = useUsageStatsStore();
    store.setProjectKeys([PROD]);
    const wrapper = mountBreakdown();
    expect(wrapper.get('[data-project-chip]').text()).toBe('api on prod-1');
    const bar = mount(StatsFilterBar, { global: { plugins: [i18n] }, attachTo: document.body });
    store.$patch({ report: report() });
    await nextTick();
    expect(bar.get('[aria-label^="Projects:"]').attributes('aria-label')).toBe('Projects: api on prod-1');
  });

  it('names the host of a host\'s spend that has no project in the project filter', async () => {
    const store = useUsageStatsStore();
    const hostNoProject = 'remote:h1|';
    store.setProjectKeys([hostNoProject]);
    const bar = mount(StatsFilterBar, { global: { plugins: [i18n] }, attachTo: document.body });
    const withNoProject = report();
    store.$patch({ report: { ...withNoProject, filterOptions: { ...withNoProject.filterOptions, projects: [{ key: '', cwd: null }, { key: hostNoProject, cwd: null, hostId: 'h1' }] } } });
    await nextTick();
    expect(bar.get('[aria-label^="Projects:"]').attributes('aria-label')).toBe('Projects: No project on prod-1');
  });

  it('marks a top conversation from a host with that host, and says where to open it', () => {
    const wrapper = mount(StatsTopSessions, {
      props: {
        sessions: [
          { sessionId: 's1', title: 'Fix the deploy', projectKey: PROD, cwd: '/srv/api', hostId: 'h1', lastActiveMs: 1, missing: false, openable: false, ...agg(4) },
          { sessionId: 's2', title: 'Local work', projectKey: LOCAL, cwd: 'C:\\Work\\alpha', lastActiveMs: 1, missing: false, openable: true, ...agg(2) },
        ],
      },
      global: { plugins: [i18n] },
      attachTo: document.body,
    });
    const [remote, local] = wrapper.findAll('tbody tr');
    expect(hostChip(remote!)).toEqual({ name: 'prod-1', tone: 'd-tone-danger' });
    expect(remote!.attributes('title')).toBe('This conversation ran on prod-1. Open it from that host\'s project.');
    expect(hostChip(local!)).toBeNull();
  });

  it('says it in Greek', () => {
    applyLocale('el');
    const wrapper = mountBreakdown();
    expect(rowOf(wrapper, 'credential', 'credential:host:h1').text()).toContain('Περιβάλλον του prod-1');
    expect(hostChip(rowOf(wrapper, 'project', `project:${GONE}`))?.name).toBe('Διαγραμμένος διακομιστής');
  });
});
