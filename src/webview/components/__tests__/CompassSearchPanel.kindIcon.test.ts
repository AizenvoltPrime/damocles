// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import CompassSearchPanel from '../CompassSearchPanel.vue';
import { useCompassStore } from '@/stores/useCompassStore';
import { i18n } from '@/i18n';
import type { CompassNodeKind } from '@shared/types/compass';

const mounted: VueWrapper[] = [];

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('CompassSearchPanel result icons', () => {
  it('reads the kind icon only from its own table, so a host kind named after an Object member gets the plain dot', () => {
    const store = useCompassStore();
    store.searchQuery = 'x';
    store.setSearchResults((['Class', 'constructor'] as CompassNodeKind[]).map((kind, id) => ({
      score: 1,
      node: { id, kind, name: `n${id}`, qualified_name: `q${id}`, file_path: 'a.ts', line_start: 1, line_end: 2, language: 'ts', community_id: null },
    })));

    const wrapper = mount(CompassSearchPanel, { global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(wrapper);

    const icons = wrapper.findAll('[data-testid="compass-search-result"] svg').map((svg) => svg.classes().find((c) => c.startsWith('lucide-') && !c.endsWith('-icon')));
    expect(icons).toEqual(['lucide-box', 'lucide-dot']);
  });
});
