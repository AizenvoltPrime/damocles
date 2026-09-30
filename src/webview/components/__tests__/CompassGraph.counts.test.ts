// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import CompassGraph from '../CompassGraph.vue';
import { useCompassStore } from '@/stores/useCompassStore';
import { i18n } from '@/i18n';
import type { CompassGraphNode } from '@shared/types/compass';

const node = (id: number, name: string): CompassGraphNode => ({
  id, kind: 'Function', name, qualified_name: `a.ts::${name}`, file_path: 'a.ts', line_start: 1, line_end: 2, language: 'typescript', community_id: null,
});

const mounted: VueWrapper[] = [];

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
  i18n.global.locale.value = 'en';
});

describe('CompassGraph node and edge counts', () => {
  it('follow a change of UI language without a rebuild', async () => {
    useCompassStore().setGraphData({
      nodes: [node(1, 'a'), node(2, 'b')],
      edges: [{ id: 1, kind: 'CALLS', source_qualified: 'a.ts::a', target_qualified: 'a.ts::b', file_path: 'a.ts' }],
      communities: [],
    });
    mounted.push(mount(CompassGraph, { attachTo: document.body, global: { plugins: [i18n] } }) as VueWrapper);
    const english = i18n.global.t('compass.graph.counts', { nodes: 2, edges: 1 });
    await expect.poll(() => document.body.textContent).toContain(english);

    i18n.global.locale.value = 'el';
    await nextTick();

    expect(document.body.textContent).toContain(i18n.global.t('compass.graph.counts', { nodes: 2, edges: 1 }));
    expect(document.body.textContent).not.toContain(english);
  });
});
