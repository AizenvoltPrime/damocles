// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useExtensionUiStore } from '@/stores/useExtensionUiStore';
import { useVoiceJarvisStore } from '@/stores/useVoiceJarvisStore';
import { settingsViewHandlers } from '@/composables/message-handler/handlers/settings-handlers';
import type { VoiceRuntimeStatus } from '@shared/types/voice';
import SettingsModal from '../SettingsModal.vue';
import { NO_HOST_SETTINGS } from '../settings-rows';

const posted = vi.hoisted(() => [] as unknown[]);
vi.mock('@/composables/usePlatformBridge', () => ({
  usePlatformBridge: () => ({
    host: 'vscode',
    postMessage: (message: unknown) => void posted.push(message),
    onMessage: () => () => {},
    getState: () => undefined,
    setState: () => {},
  }),
}));

let wrapper: VueWrapper | null = null;

async function openVoice(status: VoiceRuntimeStatus): Promise<void> {
  const settingsStore = useSettingsStore();
  const ctx = { stores: { settingsStore, uiStore: useUIStore(), extensionUiStore: useExtensionUiStore(), voiceJarvisStore: useVoiceJarvisStore() } };
  settingsViewHandlers.voiceConfigUpdate(
    { type: 'voiceConfigUpdate', config: { ...settingsStore.voiceConfig, mode: 'off', ttsEnabled: true }, hasApiKey: false },
    ctx,
  );
  settingsViewHandlers.voiceRuntimeStatus({ type: 'voiceRuntimeStatus', status }, ctx);
  wrapper = mount(SettingsModal, {
    props: { host: NO_HOST_SETTINGS, footer: { kind: 'hostSettings' }, backdrop: 'blur', target: { section: 'voice' } },
    attachTo: document.body,
    global: { plugins: [i18n] },
  });
  await nextTick();
}

const byTestId = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const statusText = (): string | undefined => byTestId('voice-runtime-status')?.textContent?.replace(/\s+/g, ' ').trim();
const actions = (): string[] => [...document.querySelectorAll<HTMLElement>('[data-testid^="voice-runtime-"]')]
  .map((element) => element.dataset.testid!)
  .filter((id) => ['voice-runtime-start', 'voice-runtime-install', 'voice-runtime-retry', 'voice-runtime-cancel'].includes(id));

beforeEach(() => {
  setActivePinia(createPinia());
  posted.length = 0;
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

describe('the voice runtime status row', () => {
  it.each<[VoiceRuntimeStatus, string, string[]]>([
    [{ kind: 'idle' }, 'Not running yet.', ['voice-runtime-start']],
    [{ kind: 'ready' }, 'Running.', []],
    [{ kind: 'needs-install', message: 'The voice runtime is not installed.', consentRequired: false }, 'The voice runtime is not installed.', ['voice-runtime-install']],
    [{ kind: 'failed', message: 'pip install failed' }, 'pip install failed', ['voice-runtime-retry']],
    [{ kind: 'cancelled' }, 'Cancelled.', ['voice-runtime-install']],
    [{ kind: 'starting', stage: 'smoke-check', pct: 10, installing: false }, 'Verifying the runtime…', ['voice-runtime-cancel']],
  ])('renders %o', async (status, text, buttons) => {
    await openVoice(status);
    expect(statusText()).toBe(text);
    expect(actions()).toEqual(buttons);
    expect(byTestId('voice-runtime-progress')).toBeNull();
  });

  it('shows the stage and percent of an install', async () => {
    await openVoice({ kind: 'starting', stage: 'downloading-python', pct: 42, installing: true });
    expect(statusText()).toBe('Downloading Python… 42%');
    const progress = byTestId('voice-runtime-progress');
    expect(progress?.getAttribute('aria-valuenow')).toBe('42');
    expect(actions()).toEqual(['voice-runtime-cancel']);
  });

  it.each<VoiceRuntimeStatus>([{ kind: 'not-needed' }, { kind: 'unsupported', message: 'Not on this platform.' }])('is absent for %o', async (status) => {
    await openVoice(status);
    expect(byTestId('settings-row-voice-runtime')).toBeNull();
  });

  it.each<[VoiceRuntimeStatus, string, string]>([
    [{ kind: 'needs-install', message: 'missing', consentRequired: false }, 'voice-runtime-install', 'voiceRuntimeInstall'],
    [{ kind: 'failed', message: 'broken' }, 'voice-runtime-retry', 'voiceRuntimeInstall'],
    [{ kind: 'starting', stage: 'installing-pip', pct: 80, installing: true }, 'voice-runtime-cancel', 'voiceRuntimeCancel'],
  ])('sends the request of its button for %o', async (status, button, type) => {
    await openVoice(status);
    posted.length = 0;
    byTestId(button)!.click();
    expect(posted).toEqual([{ type }]);
  });

  it('follows the status the host pushes', async () => {
    await openVoice({ kind: 'needs-install', message: 'missing', consentRequired: false });
    useSettingsStore().setVoiceRuntimeStatus({ kind: 'starting', stage: 'extracting-python', pct: 65, installing: true });
    await nextTick();
    expect(statusText()).toBe('Extracting Python… 65%');
    useSettingsStore().setVoiceRuntimeStatus({ kind: 'cancelled' });
    await nextTick();
    expect(actions()).toEqual(['voice-runtime-install']);
  });

  it('shows the first line of a long failure, the rest under Details, and announces only the first line', async () => {
    await openVoice({ kind: 'failed', message: 'pip install failed (exit 1):\nCollecting torch\nERROR: No matching distribution' });
    expect(statusText()).toBe('pip install failed (exit 1):');
    expect(byTestId('voice-runtime-details')?.querySelector('pre')?.textContent).toBe('Collecting torch\nERROR: No matching distribution');
    expect(byTestId('voice-runtime-announcement')?.textContent?.trim()).toBe('pip install failed (exit 1):');
    expect(byTestId('voice-runtime-status')?.getAttribute('aria-live')).toBeNull();
  });

  it('keeps the announcement region mounted while the row comes and goes', async () => {
    await openVoice({ kind: 'not-needed' });
    expect(byTestId('voice-runtime-announcement')).not.toBeNull();
  });
});

describe('the download consent in Settings', () => {
  const consentDialog = (): HTMLElement | null => byTestId('voice-runtime-consent');

  it('opens the first-run disclosure from Install while no consent is stored, and installs with consent once accepted', async () => {
    await openVoice({ kind: 'needs-install', message: 'The voice runtime is not installed.', consentRequired: true });
    posted.length = 0;
    byTestId('voice-runtime-install')!.click();
    await nextTick();
    expect(posted).toEqual([]);
    expect(consentDialog()?.textContent).toContain('CC-BY-4.0');

    byTestId('confirm-action')!.click();
    await nextTick();
    expect(posted).toEqual([{ type: 'voiceRuntimeInstall', consent: true }]);
  });

  it('sends nothing when the disclosure is cancelled', async () => {
    await openVoice({ kind: 'needs-install', message: 'missing', consentRequired: true });
    posted.length = 0;
    byTestId('voice-runtime-install')!.click();
    await nextTick();
    byTestId('confirm-cancel')!.click();
    await nextTick();
    expect(posted).toEqual([]);
  });

  it('opens the disclosure once a Start finds something to download without consent, and not for a start that ran', async () => {
    await openVoice({ kind: 'idle' });
    posted.length = 0;
    byTestId('voice-runtime-start')!.click();
    expect(posted).toEqual([{ type: 'voiceRuntimeInstall' }]);
    const store = useSettingsStore();
    store.setVoiceRuntimeStatus({ kind: 'starting', stage: 'smoke-check', pct: 10, installing: false });
    await nextTick();
    expect(consentDialog()).toBeNull();
    store.setVoiceRuntimeStatus({ kind: 'needs-install', message: 'The voice runtime is not installed.', consentRequired: true });
    await nextTick();
    expect(consentDialog()).not.toBeNull();
  });

  it('does not open the disclosure for a status the row did not ask for', async () => {
    await openVoice({ kind: 'ready' });
    useSettingsStore().setVoiceRuntimeStatus({ kind: 'needs-install', message: 'missing', consentRequired: true });
    await nextTick();
    expect(consentDialog()).toBeNull();
  });
});
