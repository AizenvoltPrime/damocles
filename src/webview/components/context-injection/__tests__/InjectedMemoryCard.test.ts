// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import InjectedMemoryCard from '../InjectedMemoryCard.vue';
import { i18n, applyLocale } from '@/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { scoreFromBreakdown } from '../injection-score';
import { ID_A, ID_B, injected } from './fixtures';
import type { InjectedMemory } from '@shared/types/context-injection';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/useVSCode', () => ({
  useVSCode: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m) }),
}));

const mounted: VueWrapper[] = [];

function mountCard(memory: InjectedMemory, forgotten = false, pinned = memory.isPinned) {
  const wrapper = mount(InjectedMemoryCard, { props: { memory, pinned, forgotten }, global: { plugins: [i18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

async function openScore(wrapper: VueWrapper): Promise<HTMLElement> {
  await wrapper.find('[data-action="score-details"]').trigger('click');
  await nextTick();
  const popover = document.body.querySelector<HTMLElement>('[data-score-popover]');
  if (!popover) throw new Error('no score popover');
  return popover;
}

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  applyLocale('en');
});

describe('InjectedMemoryCard', () => {
  it('shows scope, kind and tier badges', () => {
    const wrapper = mountCard(injected({ isStale: true, isPinned: true }));
    expect(wrapper.find('[data-badge="scope"]').text()).toBe('Project');
    expect(wrapper.find('[data-badge="kind"]').text()).toBe('Fact');
    expect(wrapper.find('[data-badge="tier"]').text()).toBe('full');
    expect(wrapper.find('[data-badge="stale"]').exists()).toBe(true);
    expect(wrapper.find('[data-badge="pinned"]').exists()).toBe(true);
  });

  it('shows the upgraded, truncated and rerank badges only when they apply', () => {
    const plain = mountCard(injected());
    for (const badge of ['upgraded', 'truncated', 'rerank']) expect(plain.find(`[data-badge="${badge}"]`).exists()).toBe(false);

    const wrapper = mountCard(injected({ upgradedFromCompact: true, truncated: true, rerankRelevance: 'high', rerankReason: 'names the test runner' }));
    expect(wrapper.find('[data-badge="upgraded"]').text()).toBe('now in full');
    expect(wrapper.find('[data-badge="truncated"]').text()).toBe('truncated');
    expect(wrapper.find('[data-badge="rerank"]').text()).toBe('high relevance');
    expect(wrapper.find('[data-badge="rerank"]').attributes('title')).toBe('names the test runner');
  });

  it('shows the current pin, not the one recorded with the prompt', () => {
    const wrapper = mountCard(injected({ isPinned: false }), false, true);
    expect(wrapper.find('[data-badge="pinned"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="unpin"]').exists()).toBe(true);
  });

  it('counts tokens with a singular form and locale grouping', () => {
    expect(mountCard(injected({ tokens: 1 })).find('[data-memory-tokens]').text()).toBe('1 token');
    expect(mountCard(injected({ tokens: 1234 })).find('[data-memory-tokens]').text()).toBe('1,234 tokens');
  });

  it('quotes matched terms the way the locale does', () => {
    applyLocale('el');
    const wrapper = mountCard(injected({ reasons: [{ kind: 'matched', terms: ['vitest'] }] }));
    expect(wrapper.find('[data-reason="matched"]').text()).toBe('Ταίριαξε με «vitest»');
  });

  it('states every reason in plain language', () => {
    const wrapper = mountCard(injected({
      reasons: [
        { kind: 'matched', terms: ['vitest', 'powershell'] },
        { kind: 'file', path: 'src/x.ts', source: 'editor' },
        { kind: 'file', path: 'src/y.ts', source: 'prompt' },
        { kind: 'pinned' },
        { kind: 'session' },
        { kind: 'preference' },
        { kind: 'mentioned' },
        { kind: 'replacement', replacesId: ID_B },
      ],
    }));
    expect(wrapper.findAll('[data-reason]').map((r) => r.text())).toEqual([
      "Matched 'vitest', 'powershell'",
      'From your open file src/x.ts',
      'From a file named in your prompt: src/y.ts',
      'Pinned',
      'Saved for this conversation',
      'Your working preference',
      'You mentioned it',
      'Replaces 22222222',
    ]);
  });

  it('highlights the matched words with <mark> elements, never injected HTML', () => {
    const wrapper = mountCard(injected({ content: 'Use <b>Vitest</b> in PowerShell' }));
    const content = wrapper.find('[data-memory-content]');
    expect(content.findAll('mark').map((m) => m.text())).toEqual(['Vitest', 'PowerShell']);
    expect(content.find('b').exists()).toBe(false);
    expect(content.text()).toBe('Use <b>Vitest</b> in PowerShell');
  });

  it('shows facts and files for an observation', () => {
    const wrapper = mountCard(injected({
      kind: 'observation',
      title: 'Vitest runs via PowerShell',
      facts: ['bash lacks npx on PATH'],
      files: ['vitest.config.ts'],
    }));
    expect(wrapper.find('[data-memory-title] mark').text()).toBe('Vitest');
    expect(wrapper.find('[data-memory-facts]').text()).toContain('bash lacks npx on PATH');
    expect(wrapper.find('[data-memory-files]').text()).toBe('vitest.config.ts');
  });

  it('explains a ranked score with the formula, and the terms reproduce the recorded score', async () => {
    const memory = injected();
    const wrapper = mountCard(memory);
    const popover = await openScore(wrapper);

    expect(popover.querySelector('[data-score-formula]')?.textContent).toBe(
      'score = (0.55·rel + 0.15·file + 0.15·recency + 0.10·retrieval + sourceCountBoost) × stalenessPenalty',
    );
    expect(popover.querySelector('[data-score-term="relevance"]')?.textContent).toContain('0.55 × 0.60 = 0.33');
    expect(popover.querySelector('[data-score-term="stalenessPenalty"]')?.textContent).toContain('× 1.00');
    expect(scoreFromBreakdown(memory.scoreBreakdown!)).toBeCloseTo(0.33 + 0 + 0.12 + 0.02 + 0.05, 10);
    expect(popover.querySelector('[data-score-total]')?.textContent).toContain('0.52');
  });

  it.each(['pinned', 'session', 'preference', 'mentioned'] as const)('says a %s entry is not ranked', async (kind) => {
    const wrapper = mountCard(injected({ reasons: [{ kind }], score: null, scoreBreakdown: null }));
    expect(wrapper.find('[data-memory-score]').text()).toContain('not ranked');
    const popover = await openScore(wrapper);
    expect(popover.querySelector('[data-score-not-ranked]')?.textContent).toBe('Not ranked: always included once per context');
    expect(popover.querySelector('[data-score-formula]')).toBeNull();
  });

  it('pins and unpins through the panel messages', async () => {
    const wrapper = mountCard(injected());
    await wrapper.find('[data-action="pin"]').trigger('click');
    expect(posted).toEqual([{ type: 'pinMemory', id: ID_A }]);

    const pinned = mountCard(injected({ isPinned: true }));
    await pinned.find('[data-action="unpin"]').trigger('click');
    expect(posted[1]).toEqual({ type: 'unpinMemory', id: ID_A });
  });

  it('forgets only after the confirm popover, with the chain scope the panel uses', async () => {
    const wrapper = mountCard(injected());
    await wrapper.find('[data-action="forget"]').trigger('click');
    await nextTick();
    const cancel = document.body.querySelector<HTMLElement>('[data-action="forget-cancel"]');
    expect(cancel).not.toBeNull();
    cancel!.click();
    await nextTick();
    expect(posted).toEqual([]);

    await wrapper.find('[data-action="forget"]').trigger('click');
    await nextTick();
    document.body.querySelector<HTMLElement>('[data-action="forget-confirm"]')!.click();
    await nextTick();
    expect(posted).toEqual([{ type: 'forgetMemory', id: ID_A, scope: 'chain' }]);
  });

  it('opens the memory panel focused on the memory', async () => {
    const wrapper = mountCard(injected({ kind: 'observation' }));
    await wrapper.find('[data-action="open-in-panel"]').trigger('click');
    const ui = useUIStore();
    expect(ui.showMemoryPanel).toBe(true);
    expect(ui.memoryPanelFocus).toEqual({ id: ID_A, kind: 'observation' });
    expect(posted).toEqual([]);
  });

  it('marks a forgotten memory and offers only the panel link', () => {
    const wrapper = mountCard(injected(), true);
    expect(wrapper.attributes('data-forgotten')).toBe('true');
    expect(wrapper.find('[data-badge="forgotten"]').exists()).toBe(true);
    expect(wrapper.find('[data-action="pin"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="forget"]').exists()).toBe(false);
    expect(wrapper.find('[data-action="open-in-panel"]').exists()).toBe(true);
  });

  it('gives every icon button an accessible name', () => {
    const wrapper = mountCard(injected());
    for (const button of wrapper.findAll('button')) {
      expect(button.attributes('aria-label'), button.html()).toBeTruthy();
    }
  });
});
