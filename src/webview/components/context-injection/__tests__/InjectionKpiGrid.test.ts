// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import InjectionKpiGrid from '../InjectionKpiGrid.vue';
import { i18n } from '@/i18n';
import { display, injected } from './fixtures';
import type { MemoryInjectionDisplay } from '@shared/types/context-injection';

const mounted: VueWrapper[] = [];

function mountGrid(d: MemoryInjectionDisplay) {
  const wrapper = mount(InjectionKpiGrid, { props: { display: d }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

function card(wrapper: VueWrapper, id: string) {
  const el = wrapper.find(`[data-kpi="${id}"]`);
  if (!el.exists()) throw new Error(`no card ${id}`);
  return {
    value: el.find('[data-kpi-value]').text(),
    note: el.find('[data-kpi-note]').exists() ? el.find('[data-kpi-note]').text() : null,
    trigger: el.find('button'),
  };
}

async function openPopover(wrapper: VueWrapper, id: string): Promise<HTMLElement> {
  await card(wrapper, id).trigger.trigger('click');
  await nextTick();
  const popover = document.body.querySelector<HTMLElement>(`[data-kpi-popover="${id}"]`);
  if (!popover) throw new Error(`no popover ${id}`);
  return popover;
}

function detail(popover: HTMLElement, id: string): string | undefined {
  return popover.querySelector(`[data-kpi-detail="${id}"]`)?.textContent?.trim();
}

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('InjectionKpiGrid', () => {
  it('renders the five cards in order', () => {
    const wrapper = mountGrid(display());
    expect(wrapper.findAll('[data-kpi]').map((c) => c.attributes('data-kpi'))).toEqual([
      'tokensAdded', 'newMemories', 'carried', 'notices', 'storeSize',
    ]);
  });

  it('shows the recorded total and each recorded token part behind it', async () => {
    const wrapper = mountGrid(display({ tokens: { memories: 1120, notices: 10, profile: 300, compass: 20, total: 1450, budget: 2000 } }));
    expect(card(wrapper, 'tokensAdded').value).toBe('1,450');
    expect(card(wrapper, 'tokensAdded').note).toBe('Budget for new matches: 2,000');

    const popover = await openPopover(wrapper, 'tokensAdded');
    expect(popover.querySelector('[data-kpi-formula]')?.textContent).toContain('memories + notices + profile + Compass status');
    expect(['memories', 'notices', 'profile', 'compass', 'budget'].map((id) => detail(popover, id))).toEqual(['1,120', '10', '300', '20', '2,000']);
  });

  it('counts new memories by tier and shows the gate counters behind them', async () => {
    const d = display({ added: [injected(), injected({ id: 'b', tier: 'compact' }), injected({ id: 'c', tier: 'compact' })] });
    const wrapper = mountGrid(d);
    expect(card(wrapper, 'newMemories').value).toBe('3');
    expect(card(wrapper, 'newMemories').note).toBe('1 full, 2 compact');

    const popover = await openPopover(wrapper, 'newMemories');
    expect(detail(popover, 'considered')).toBe('40');
    expect(detail(popover, 'passed')).toBe('3');
    expect(detail(popover, 'overBudget')).toBe('1');
  });

  it('shows carried memories and notices as counts', () => {
    const wrapper = mountGrid(display({ notices: [{ kind: 'forgotten', id: 'x', title: null, snippet: 's', replacementId: null, tokens: 10 }] }));
    expect(card(wrapper, 'carried').value).toBe('1');
    expect(card(wrapper, 'notices').value).toBe('1');
    expect(card(wrapper, 'notices').note).toBe('10 tokens');
  });

  it('uses the singular for one notice token', () => {
    const wrapper = mountGrid(display({
      notices: [{ kind: 'edited', id: 'x', title: null, snippet: 's', replacementId: null, tokens: 1 }],
      tokens: { memories: 0, notices: 1, profile: 0, compass: 0, total: 1, budget: 2000 },
    }));
    expect(card(wrapper, 'notices').note).toBe('1 token');
  });

  it('shows the recorded store size and each recorded scope count behind it', async () => {
    const wrapper = mountGrid(display());
    expect(card(wrapper, 'storeSize').value).toBe('100');

    const popover = await openPopover(wrapper, 'storeSize');
    expect(popover.querySelector('[data-kpi-formula]')?.textContent).toContain('session + project + global + observations');
    expect(['session', 'project', 'global', 'observations'].map((id) => detail(popover, id))).toEqual(['2', '30', '10', '58']);
  });

  it('names each info button after its card', () => {
    const wrapper = mountGrid(display());
    expect(card(wrapper, 'storeSize').trigger.attributes('aria-label')).toBe('How Memory store is calculated');
  });
});
