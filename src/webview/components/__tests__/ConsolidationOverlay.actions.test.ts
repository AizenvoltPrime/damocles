// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { setActivePinia, createPinia } from 'pinia';
import ConsolidationOverlay from '../ConsolidationOverlay.vue';
import { i18n } from '@/i18n';
import { useConsolidationStore } from '@/stores/useConsolidationStore';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { VSCODE_HOST_CAPABILITIES, type WebviewToExtensionMessage } from '@shared/types/messages';
import type { ConsolidationFailure } from '@shared/types/consolidation';

const posted = vi.hoisted((): WebviewToExtensionMessage[] => []);
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({ postMessage: (m: WebviewToExtensionMessage) => posted.push(m), onMessage: () => () => {}, getState: () => undefined, setState: () => {} }),
}));

const mounted: VueWrapper[] = [];

function mountOverlay(failure?: ConsolidationFailure): VueWrapper {
  if (failure) {
    useConsolidationStore().setResult({
      ranAt: Date.now(),
      trigger: 'manual',
      status: 'failed',
      extracted: [],
      maintenance: { promoted: 0, decayed: 0, pruned: 0 },
      candidatesReviewed: 0,
      failure,
    });
  }
  const wrapper = mount(ConsolidationOverlay, { global: { plugins: [i18n], stubs: { MarkdownRenderer: true } }, attachTo: document.body });
  mounted.push(wrapper);
  return wrapper;
}

const signInButton = (wrapper: VueWrapper) => wrapper.findAll('button').find((b) => b.text() === i18n.global.t('consolidation.signIn'));

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
});

describe('ConsolidationOverlay actions', () => {
  it('Run now triggers a pass', async () => {
    const wrapper = mountOverlay();
    await wrapper.get('[data-testid="consolidation-run"]').trigger('click');

    expect(posted).toEqual([{ type: 'triggerConsolidation' }]);
  });

  it('Retry triggers a pass after a failure', async () => {
    const wrapper = mountOverlay({ kind: 'error', detail: 'boom', phase: 'extract' });
    expect(signInButton(wrapper)).toBeUndefined();

    await wrapper.get('[data-testid="consolidation-retry"]').trigger('click');

    expect(posted).toEqual([{ type: 'triggerConsolidation' }]);
  });

  it('Sign in opens the Accounts settings in the page when the host keeps settings there', async () => {
    const wrapper = mountOverlay({ kind: 'no-model' });

    await signInButton(wrapper)!.trigger('click');

    expect(useUIStore().showSettingsModal).toBe(true);
    expect(useUIStore().settingsTarget).toEqual({ section: 'accounts' });
    expect(posted).toEqual([]);
  });

  it('Sign in asks core for the Accounts settings when the host keeps them outside the page', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false });
    const wrapper = mountOverlay({ kind: 'no-model' });

    await signInButton(wrapper)!.trigger('click');

    expect(posted).toEqual([{ type: 'openAppSettings', section: 'accounts' }]);
  });
});
