// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ConsolidationOverlay from '../ConsolidationOverlay.vue';
import { i18n } from '@/i18n';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import type { ConsolidationExtractedMemory } from '@shared/types/consolidation';

const mounted: VueWrapper[] = [];

function mountWith(extracted: ConsolidationExtractedMemory[]): VueWrapper {
  useConsolidationStore().setResult({
    ranAt: Date.now(),
    trigger: 'manual',
    status: 'extracted',
    extracted,
    maintenance: { promoted: 0, decayed: 0, pruned: 0 },
    candidatesReviewed: 1,
  });
  const wrapper = mount(ConsolidationOverlay, { global: { plugins: [i18n], stubs: { MarkdownRenderer: true } }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

beforeEach(() => {
  setActivePinia(createPinia());
  document.body.innerHTML = '';
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('ConsolidationOverlay extracted workspace', () => {
  it('names the folder an item was filed under, with the full path as its title and a silent arrow', () => {
    const wrapper = mountWith([
      { kind: 'fact', scope: 'project', content: 'uses pnpm', workspace: 'C:\\work\\beta', outcome: 'inserted' },
      { kind: 'fact', scope: 'project', content: 'uses vitest', outcome: 'inserted' },
    ]);

    const labels = wrapper.findAll('[data-extracted-workspace]');
    expect(labels).toHaveLength(1);
    expect(labels[0]!.text()).toBe('→ beta');
    expect(labels[0]!.attributes('title')).toBe('C:\\work\\beta');
    expect(labels[0]!.find('[aria-hidden="true"]').text()).toBe('→');
  });
});
