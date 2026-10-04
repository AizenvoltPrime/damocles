// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import VoiceModelDownloadModal from '../VoiceModelDownloadModal.vue';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import { i18n } from '@/i18n';

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
