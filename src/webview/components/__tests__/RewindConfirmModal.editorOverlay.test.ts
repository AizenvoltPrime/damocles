// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import RewindConfirmModal from '../RewindConfirmModal.vue';
import { useEditorStore } from '@/stores/useEditorStore';
import { i18n } from '@/i18n';

const mounted: VueWrapper[] = [];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const dialog = () => document.body.querySelector('[role="alertdialog"]');
const press = (key: string) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

async function mountModal(): Promise<VueWrapper> {
  const wrapper = mount(RewindConfirmModal, {
    props: { visible: true, canFork: true, files: [{ path: '/w/a.ts', displayName: 'a.ts' }], filesAffected: 1 },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  mounted.push(wrapper as VueWrapper);
  await flush();
  return wrapper as VueWrapper;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

// The modal traps focus and pointer events, which would leave an editor overlay opened from it unusable.
describe('RewindConfirmModal under an editor overlay', () => {
  it('steps aside while the overlay is open and comes back when it closes, ignoring keys meanwhile', async () => {
    const wrapper = await mountModal();
    expect(dialog()).not.toBeNull();

    const editorStore = useEditorStore();
    editorStore.showDiff({
      type: 'editorShowDiff', viewId: 'r1', title: 'a.ts', purpose: 'checkpoint',
      original: { name: 'a.ts', body: { kind: 'text', content: 'a', languageId: 'typescript' } },
      modified: { name: 'a.ts', body: { kind: 'text', content: 'b', languageId: 'typescript' } },
    });
    await flush();
    expect(dialog()).toBeNull();

    press('Escape');
    press('2');
    expect(wrapper.emitted('cancel')).toBeUndefined();
    expect(wrapper.emitted('confirm')).toBeUndefined();

    editorStore.dismissView();
    await nextTick();
    await flush();
    expect(dialog()).not.toBeNull();
    expect(wrapper.emitted('cancel')).toBeUndefined();
  });
});
