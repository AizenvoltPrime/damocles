// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import BindPlanOverlay from '../BindPlanOverlay.vue';
import { useBindPlanStore } from '@/stores/useBindPlanStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { createUIHandlers } from '@/composables/message-handler/handlers/ui-handlers';
import { i18n } from '@/i18n';
import type { WebviewToExtensionMessage } from '@shared/types/messages';

const posted: WebviewToExtensionMessage[] = [];
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    postMessage: (m: WebviewToExtensionMessage) => posted.push(m),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

const FILES = [
  { id: 'id-new', relativePath: '.damocles/plans/new.md', modifiedAt: Date.now() - 2 * 3_600_000 },
  { id: 'id-old', relativePath: 'PLAN.md', modifiedAt: Date.now() - 30 * 86_400_000 },
];

function deliver(files = FILES, hasPlan = false): void {
  createUIHandlers().planFileCandidates!({ type: 'planFileCandidates', files, hasPlan }, {} as never);
}

function mountOverlay() {
  return mount(BindPlanOverlay, { global: { plugins: [i18n] }, attachTo: document.body });
}

beforeEach(() => {
  posted.length = 0;
  setActivePinia(createPinia());
  useBindPlanStore().open();
});

describe('BindPlanOverlay', () => {
  it('shows loading until core answers, then lists the candidates with their edit time', async () => {
    const wrapper = mountOverlay();
    expect(wrapper.find('[role="status"]').exists()).toBe(true);

    deliver();
    await nextTick();

    const rows = wrapper.findAll('[data-testid="bind-plan-file"]');
    expect(rows.map((r) => r.attributes('title'))).toEqual(['.damocles/plans/new.md', 'PLAN.md']);
    expect(rows[0]!.text()).toContain('Edited 2 hours ago');
    expect(rows[0]!.attributes('aria-checked')).toBe('true');
    expect(wrapper.find('[data-testid="bind-plan-overwrite"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('binds the picked file by its issued id, never by path, and closes', async () => {
    const wrapper = mountOverlay();
    deliver();
    await nextTick();

    await wrapper.findAll('[data-testid="bind-plan-file"]')[1]!.trigger('click');
    await wrapper.get('[data-testid="bind-plan-bind"]').trigger('click');

    expect(posted).toEqual([{ type: 'bindPlanToSession', candidateId: 'id-old' }]);
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('moves the selection with the arrow keys', async () => {
    const wrapper = mountOverlay();
    deliver();
    await nextTick();

    await wrapper.get('[role="radiogroup"]').trigger('keydown', { key: 'ArrowDown' });

    const rows = wrapper.findAll('[data-testid="bind-plan-file"]');
    expect(rows.map((r) => r.attributes('aria-checked'))).toEqual(['false', 'true']);
    expect(rows.map((r) => r.attributes('tabindex'))).toEqual(['-1', '0']);
    wrapper.unmount();
  });

  it('warns that binding overwrites the bound plan', async () => {
    const wrapper = mountOverlay();
    deliver(FILES, true);
    await nextTick();

    expect(wrapper.get('[data-testid="bind-plan-overwrite"]').text()).toBe(
      'The session already has a plan file. Binding overwrites it in place.',
    );
    wrapper.unmount();
  });

  it('leaves loading when the listing failed, says so, and still offers Browse', async () => {
    const wrapper = mountOverlay();
    createUIHandlers().planFileCandidates!({ type: 'planFileCandidates', files: [], hasPlan: false, listFailed: true }, {} as never);
    await nextTick();

    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('[data-testid="bind-plan-list-failed"]').text()).toContain("Couldn't list this folder's plan files");
    expect(wrapper.find('[data-testid="bind-plan-empty"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="bind-plan-browse"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('browses with the OS dialog by posting no id', async () => {
    const wrapper = mountOverlay();
    deliver([]);
    await nextTick();

    expect(wrapper.find('[data-testid="bind-plan-empty"]').exists()).toBe(true);
    expect(wrapper.get('[data-testid="bind-plan-bind"]').attributes('disabled')).toBeDefined();
    await wrapper.get('[data-testid="bind-plan-browse"]').trigger('click');

    expect(posted).toEqual([{ type: 'bindPlanToSession' }]);
    expect(wrapper.emitted('close')).toHaveLength(1);
    wrapper.unmount();
  });

  it('ignores a list that arrives after it closed', () => {
    const store = useBindPlanStore();
    store.close();
    deliver();
    expect(store.loaded).toBe(false);
  });

  it('closes when the session changes, so a list from the previous session is never bound', async () => {
    const store = useBindPlanStore();
    deliver();
    useSessionStore().setResumedSession('other-session');
    await nextTick();

    expect(store.isOpen).toBe(false);
  });

  it('closes when the panel switches folder', async () => {
    const store = useBindPlanStore();
    useSettingsStore().setWorkspaceFolders([], 'other-folder', 'other-folder');
    await nextTick();

    expect(store.isOpen).toBe(false);
  });
});
