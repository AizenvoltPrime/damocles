// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import { settingsViewHandlers } from '@/composables/message-handler/handlers/settings-handlers';
import type { VoiceMode } from '@shared/types/voice';
import SettingsModal from '../SettingsModal.vue';
import { NO_HOST_SETTINGS } from '../settings-rows';

const REFUSAL = 'Jarvis voice mode is not available on Windows arm64.';

let wrapper: VueWrapper | null = null;

async function openVoice(mode: VoiceMode, localRuntimeUnsupported: string | null): Promise<void> {
  const settingsStore = useSettingsStore();
  const ctx = { stores: { settingsStore, uiStore: useUIStore(), extensionUiStore: useExtensionUiStore(), voiceJarvisStore: useVoiceJarvisStore() } };
  settingsViewHandlers.voiceConfigUpdate(
    { type: 'voiceConfigUpdate', config: { ...settingsStore.voiceConfig, mode, ttsEnabled: true }, hasApiKey: false, localRuntimeUnsupported },
    ctx,
  );
  wrapper = mount(SettingsModal, {
    props: { host: NO_HOST_SETTINGS, footer: { kind: 'hostSettings' }, backdrop: 'blur', target: { section: 'voice' } },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  await nextTick();
}

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('voice settings on a platform the Jarvis runtime does not support', () => {
  it.each<VoiceMode>(['push-to-talk', 'wake-word'])('shows the refusal and offers no model download or voice test in %s mode', async (mode) => {
    await openVoice(mode, REFUSAL);
    expect(byTestId('voice-runtime-unsupported')?.textContent?.trim()).toBe(REFUSAL);
    expect(byTestId('voice-redownload')).toBeNull();
    expect(byTestId('voice-test-voice')).toBeNull();
    expect(byTestId('voice-remove-all')).not.toBeNull();
  });

  it('offers both on a supported platform', async () => {
    await openVoice('wake-word', null);
    expect(byTestId('voice-runtime-unsupported')).toBeNull();
    expect(byTestId('voice-redownload')).not.toBeNull();
    expect(byTestId('voice-test-voice')).not.toBeNull();
  });
});
