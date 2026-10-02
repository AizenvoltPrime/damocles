// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import MemoryPanel from '../MemoryPanel.vue';
import { i18n, applyLocale } from '@/i18n';
import type { SearchResult } from '@shared/types/memory';

const mounted: VueWrapper[] = [];

async function searchShowing(results: SearchResult[]): Promise<VueWrapper> {
  const wrapper = mount(MemoryPanel, {
    props: { notes: [], observations: [], searchResults: [], hasMoreObservations: false, loadingObservations: false },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  const search = wrapper.find<HTMLInputElement>('input[placeholder="Search all memories..."]');
  await search.setValue('deploy');
  await search.trigger('keydown', { key: 'Enter' });
  await wrapper.setProps({ searchResults: results });
  return wrapper;
}

const result = (over: Partial<SearchResult>): SearchResult => ({ id: 'm1', tier: 'project', title: null, snippet: 's', rank: 1, timestamp: 0, ...over });

beforeEach(() => {
  setActivePinia(createPinia());
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  applyLocale('en');
});

describe('MemoryPanel search result reason', () => {
  it('renders a Jev grade as a localized verdict, not the model-facing English reason', async () => {
    const wrapper = await searchShowing([
      result({ rerankRelevance: 'high', reason: 'Classifier: directly relevant (0.82)', rerankClassifierScore: 0.82 }),
    ]);
    applyLocale('el');
    await nextTick();
    expect(wrapper.find('[data-testid="search-result-reason"]').text()).toBe('Ταξινομητής: άμεσα σχετική (0,82)');
  });

  it('renders the relevance badge in the active locale', async () => {
    const wrapper = await searchShowing([result({ rerankRelevance: 'low', reason: 'unrelated' })]);
    const badgeText = (): string[] => wrapper.findAll('.text-xs.h-4').map((badge) => badge.text());
    expect(badgeText()).toContain('low relevance');
    applyLocale('el');
    await nextTick();
    expect(badgeText()).toContain('χαμηλή συνάφεια');
  });

  it('keeps an LLM rerank reason as written', async () => {
    const wrapper = await searchShowing([result({ rerankRelevance: 'medium', reason: 'mentions the deploy target' })]);
    expect(wrapper.find('[data-testid="search-result-reason"]').text()).toBe('mentions the deploy target');
  });
});
