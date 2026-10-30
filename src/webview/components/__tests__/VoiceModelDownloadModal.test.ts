// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import VoiceModelDownloadModal from '../VoiceModelDownloadModal.vue';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import { nextTick } from 'vue';
import { applyLocale, i18n } from '@/i18n';
import { createVoiceStreamHandlers } from '@/composables/message-handler/handlers/voice-stream-handlers';
import type { HandlerContext } from '@/composables/message-handler/types';
import { inGreek } from '../../../__mocks__/greek-locale';

const mounted: VueWrapper[] = [];

function mountModal(): VueWrapper {
  const wrapper = mount(VoiceModelDownloadModal, {
    props: { downloads: { 'whisper-small': { bytesReceived: 1, bytesTotal: 10, status: 'downloading' } } },
    global: { plugins: [i18n] },
    attachTo: document.body,
  });
  mounted.push(wrapper as VueWrapper);
  return wrapper as VueWrapper;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  document.body.innerHTML = '';
});

describe('VoiceModelDownloadModal', () => {
  it('hides from its X, its scrim and Escape without cancelling the download', async () => {
    const wrapper = mountModal();

    await wrapper.get('[data-testid="overlay-close"]').trigger('click');
    await wrapper.get('[data-testid="overlay-scrim"]').trigger('click');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

    expect(wrapper.emitted('hide')).toHaveLength(3);
    expect(wrapper.emitted('cancel')).toBeUndefined();
  });

  it('cancels only from its Cancel download button', async () => {
    const wrapper = mountModal();

    await wrapper.get('[data-testid="voice-model-download-cancel"]').trigger('click');

    expect(wrapper.get('[data-testid="voice-model-download-cancel"]').text()).toBe('Cancel download');
    expect(wrapper.emitted('cancel')).toEqual([[]]);
    expect(wrapper.emitted('hide')).toBeUndefined();
  });
});

describe('VoiceModelDownloadModal after a language switch', () => {
  afterEach(() => applyLocale('en'));

  it("renders a failed download's reason in the new language", async () => {
    const coreText = { message: 'Could not open file: {0}', args: ['whisper.bin'] };
    const store = useVoiceJarvisStore();
    const ctx = { stores: { voiceJarvisStore: store } } as unknown as HandlerContext;
    createVoiceStreamHandlers().voiceModelDownloadProgress!({ type: 'voiceModelDownloadProgress', modelId: 'whisper-small', bytesReceived: 1, bytesTotal: 10, status: 'error', message: coreText }, ctx);
    const wrapper = mount(VoiceModelDownloadModal, { props: { downloads: store.modelDownload }, global: { plugins: [i18n] }, attachTo: document.body });
    mounted.push(wrapper as VueWrapper);
    expect(wrapper.get('[role="alert"]').text()).toBe('Could not open file: whisper.bin');

    await applyLocale('el');
    await nextTick();
    expect(wrapper.get('[role="alert"]').text()).toBe(inGreek(coreText));
  });
});

describe('the voice store showing the download modal', () => {
  const progress = (status: 'downloading' | 'error') => ({ modelId: 'whisper-small', bytesReceived: 1, bytesTotal: 10, status });

  it('keeps a hidden download hidden while it runs, shows it again when a model fails, and shows the next download', () => {
    const store = useVoiceJarvisStore();
    store.updateModelDownload(progress('downloading'));
    expect(store.showModelDownload).toBe(true);

    store.hideModelDownload();
    store.updateModelDownload(progress('downloading'));
    expect(store.hasActiveDownload).toBe(true);
    expect(store.showModelDownload).toBe(false);

    store.updateModelDownload(progress('error'));
    expect(store.showModelDownload).toBe(true);

    store.hideModelDownload();
    store.markModelDownloadsDone();
    store.updateModelDownload(progress('downloading'));
    expect(store.showModelDownload).toBe(true);
  });
});
