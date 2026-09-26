// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import StatsTopSessions from '../StatsTopSessions.vue';
import { i18n } from '@/i18n';
import { useUsageStatsStore } from '@/stores/useUsageStatsStore';
import type { WebviewToExtensionMessage } from '@shared/types/messages';
import type { UsageStatsTopSession } from '@shared/types/usage-stats';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

function session(sessionId: string, over: Partial<UsageStatsTopSession> = {}): UsageStatsTopSession {
  return {
    sessionId, title: `Title ${sessionId}`, projectKey: 'c:\\work\\alpha', cwd: 'C:\\Work\\alpha', lastActiveMs: 1_700_000_000_000,
    missing: false, openable: true, cost: 1, input: 100, output: 0, cacheRead: 0, cacheWrite: 0, unpricedTokens: 0, requests: 1, ...over,
  };
}

const SESSIONS = [
  session('open', { cost: 5, input: 10 }),
  session('gone', { cost: 3, input: 5_000, missing: true, openable: false, title: null }),
  session('elsewhere', { cost: 1, input: 20, openable: false, cwd: 'D:\\other', projectKey: 'd:\\other' }),
  session('untitled', { cost: 0.5, title: null }),
  session('local', { cost: 0, input: 200, unpricedTokens: 200 }),
  session('mixed', { cost: 0.25, input: 300, unpricedTokens: 100 }),
];

function mountTable() {
  return mount(StatsTopSessions, { props: { sessions: SESSIONS }, global: { plugins: [i18n] } });
}

type Wrapper = ReturnType<typeof mountTable>;
const rowIds = (w: Wrapper) => w.findAll('tbody tr').map((r) => r.attributes('data-session'));
const rowOf = (w: Wrapper, id: string) => w.get(`tbody tr[data-session="${id}"]`);

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});

describe('StatsTopSessions', () => {
  it('lists conversations by cost, naming deleted and untitled ones', () => {
    const w = mountTable();
    expect(rowIds(w)).toEqual(['open', 'gone', 'elsewhere', 'untitled', 'mixed', 'local']);
    expect(rowOf(w, 'gone').text()).toContain('Deleted conversation');
    expect(rowOf(w, 'untitled').text()).toContain('Untitled conversation');
    expect(rowOf(w, 'open').text()).toContain('alpha');
  });

  it('marks unpriced spend, and never reads a wholly unpriced conversation as $0.00', () => {
    const w = mountTable();
    expect(rowOf(w, 'local').get('[data-cost]').text()).toBe('unpriced');
    expect(rowOf(w, 'local').get('[data-cost]').attributes('title')).toContain('It is not $0.');
    expect(rowOf(w, 'local').get('[data-unpriced]').attributes('title')).toBe('200 tokens have no recorded price and are not counted in the cost');
    expect(rowOf(w, 'mixed').get('[data-cost]').text()).toBe('$0.25');
    expect(rowOf(w, 'mixed').find('[data-unpriced]').exists()).toBe(true);
    expect(rowOf(w, 'open').find('[data-unpriced]').exists()).toBe(false);
  });

  it('opens an openable conversation with resumeSession and closes the overlay', async () => {
    const store = useUsageStatsStore();
    store.openOverlay();
    const w = mountTable();
    await rowOf(w, 'open').get('[data-open]').trigger('click');
    expect(posted.filter((m) => m.type === 'resumeSession')).toEqual([{ type: 'resumeSession', sessionId: 'open' }]);
    expect(store.isOverlayOpen).toBe(false);
  });

  it('keeps rows that cannot open disabled, with a reason', async () => {
    const w = mountTable();
    const gone = rowOf(w, 'gone');
    const elsewhere = rowOf(w, 'elsewhere');
    expect(gone.get('[data-open]').attributes('disabled')).toBeDefined();
    expect(gone.attributes('title')).toContain('was deleted');
    expect(elsewhere.attributes('title')).toContain('not open in this window');
    await gone.trigger('click');
    await elsewhere.trigger('click');
    expect(posted).toEqual([]);
  });

  it('sorts by a clicked column and flips on a second click', async () => {
    const w = mountTable();
    await w.get('[data-sort="tokens"]').trigger('click');
    await nextTick();
    expect(rowIds(w)[0]).toBe('gone');
    await w.get('[data-sort="tokens"]').trigger('click');
    await nextTick();
    expect(rowIds(w)[0]).toBe('open');
    await w.get('[data-sort="title"]').trigger('click');
    expect(w.get('[data-sort="title"]').element.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
  });
});
