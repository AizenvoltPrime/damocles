// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import MemoryPanel from '../MemoryPanel.vue';
import OverlayShell from '../OverlayShell.vue';
import { useMemoryStore } from '@/stores/useMemoryStore';
import { i18n } from '@/i18n';

const mounted: VueWrapper[] = [];

function mountPanel(): VueWrapper {
  const wrapper = mount(MemoryPanel, {
    props: { notes: [], observations: [], searchResults: [], hasMoreObservations: false, loadingObservations: false },
    global: { plugins: [i18n], stubs: { MarkdownRenderer: true } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  return wrapper;
}

const clickScrim = (wrapper: VueWrapper) => wrapper.get('[data-testid="overlay-scrim"]').trigger('click');

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('MemoryPanel unsent text', () => {
  it('reports a typed new memory as a draft, so a scrim click leaves the panel open', async () => {
    const wrapper = mountPanel();
    await wrapper.get('[data-testid="memory-new"]').setValue('remember the deploy window');

    expect(wrapper.findComponent(OverlayShell).props('hasDraft')).toBe(true);
    await clickScrim(wrapper);
    expect(wrapper.emitted('close')).toBeUndefined();

    await wrapper.get('[data-testid="memory-new"]').setValue('   ');
    await clickScrim(wrapper);
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('reports an unsaved profile edit as a draft', async () => {
    useMemoryStore().setProfile({ static: '', dynamic: '' }, { static: '', dynamic: '' });
    const wrapper = mountPanel();
    expect(wrapper.findComponent(OverlayShell).props('hasDraft')).toBe(false);

    await wrapper.findAll('button').find((b) => b.text().includes('User Profile'))!.trigger('click');
    await wrapper.get('textarea[placeholder="Stable facts that apply everywhere..."]').setValue('prefers short answers');

    expect(wrapper.findComponent(OverlayShell).props('hasDraft')).toBe(true);
    await clickScrim(wrapper);
    expect(wrapper.emitted('close')).toBeUndefined();
  });
});
