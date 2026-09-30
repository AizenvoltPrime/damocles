// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('vue3-lottie', () => ({ Vue3Lottie: { name: 'Vue3Lottie', render: () => null } }));
import { mount, type VueWrapper } from '@vue/test-utils';
import { createApp, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { createHandlerRegistry } from '@/composables/message-handler/handler-registry';
import type { HandlerContext, HandlerRegistry } from '@/composables/message-handler/types';
import ChatInput from '@/components/ChatInput.vue';
import SettingsPanel from '@/components/SettingsPanel.vue';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage, type HostCapabilities } from '@shared/types/messages';

const DESKTOP_MAC: HostCapabilities = {
  voice: false,
  hostSpeechExtensions: false,
  hostSettingsEditor: false,
  markdownPreview: false,
  diffReview: true,
  settingsSources: true,
  monaco: true,
  ideContext: false,
};

function buildRegistry(): HandlerRegistry {
  let registry!: HandlerRegistry;
  const app = createApp({
    setup() {
      registry = createHandlerRegistry();
      return () => null;
    },
  });
  app.use(i18n);
  app.mount(document.createElement('div'));
  app.unmount();
  return registry;
}

function dispatch(msg: ExtensionToWebviewMessage): void {
  const ctx = { stores: { settingsStore: useSettingsStore(), uiStore: { setIdeContextDefault: () => {} } } } as unknown as HandlerContext;
  const handler = buildRegistry()[msg.type] as ((m: ExtensionToWebviewMessage, c: HandlerContext) => void) | undefined;
  if (!handler) throw new Error(`no handler registered for ${msg.type}`);
  handler(msg, ctx);
}

const mounted: VueWrapper[] = [];
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
});
beforeEach(() => setActivePinia(createPinia()));

describe('host capabilities', () => {
  it('start at the VS Code values, so a VS Code webview is unchanged before and after the handshake', () => {
    expect(useSettingsStore().hostCapabilities).toEqual(VSCODE_HOST_CAPABILITIES);
    expect(VSCODE_HOST_CAPABILITIES).toEqual({
      voice: true,
      hostSpeechExtensions: true,
      hostSettingsEditor: true,
      markdownPreview: true,
      diffReview: true,
      settingsSources: false,
      monaco: false,
      ideContext: true,
    });
  });

  it('are replaced by the hostCapabilities message', () => {
    dispatch({ type: 'hostCapabilities', capabilities: DESKTOP_MAC });
    expect(useSettingsStore().hostCapabilities).toEqual(DESKTOP_MAC);
    expect(useSettingsStore().voiceControlsAvailable).toBe(false);
  });

  it('keep voice controls when either voice path exists', () => {
    const store = useSettingsStore();
    store.setHostCapabilities({ ...DESKTOP_MAC, hostSpeechExtensions: true });
    expect(store.voiceControlsAvailable).toBe(true);
    store.setHostCapabilities({ ...DESKTOP_MAC, voice: true });
    expect(store.voiceControlsAvailable).toBe(true);
  });

  it('settingsUpdate stores the source files and clears them when a later update has none', () => {
    const store = useSettingsStore();
    const settings = { ...store.currentSettings, maxBudgetUsd: 3 };
    dispatch({ type: 'settingsUpdate', settings, settingSources: { 'damocles.maxBudgetUsd': { scope: 'project', path: '/w/a/.damocles/settings.json' } } });
    expect(store.settingSources).toEqual({ 'damocles.maxBudgetUsd': { scope: 'project', path: '/w/a/.damocles/settings.json' } });

    dispatch({ type: 'settingsUpdate', settings });
    expect(store.settingSources).toEqual({});
  });
});

describe('capability consumers', () => {
  function composer(): VueWrapper {
    const wrapper = mount(ChatInput, {
      props: { isProcessing: false, permissionMode: 'default', dangerouslySkipPermissions: false },
      global: { plugins: [i18n], stubs: { ElementAttachmentStrip: true, ImageThumbnailStrip: true } },
      attachTo: document.body,
    });
    mounted.push(wrapper);
    return wrapper;
  }
  const micButton = (wrapper: VueWrapper) => wrapper.find(`button[title="${i18n.global.t('chatInput.voice.noApiKey')}"]`);

  it('hide the microphone when the host has no voice path', async () => {
    const wrapper = composer();
    expect(micButton(wrapper).exists()).toBe(true);

    useSettingsStore().setHostCapabilities(DESKTOP_MAC);
    await nextTick();
    expect(micButton(wrapper).exists()).toBe(false);
  });

  async function settingsPanel(): Promise<void> {
    const store = useSettingsStore();
    mounted.push(mount(SettingsPanel, {
      props: {
        settings: store.currentSettings,
        availableModels: [],
        visible: true,
        activeModel: '',
        defaultModel: '',
        panelThinking: null,
        panelThinkingModel: '',
        defaultThinking: null,
        defaultThinkingModel: '',
        voiceConfig: store.voiceConfig,
        voiceHasApiKey: false,
        exploreHasApiKey: false,
        exploreProvider: '',
        exploreModel: '',
        exploreEffort: '',
      },
      attachTo: document.body,
      global: { plugins: [i18n] },
    }) as VueWrapper);
    await nextTick();
  }

  it('leave the VS Code settings panel as it was', async () => {
    await settingsPanel();
    const text = document.body.textContent ?? '';

    expect(text).toContain(i18n.global.t('settings.openVsCodeSettings'));
    expect(text).toContain(i18n.global.t('settings.voice.title'));
    expect(text).not.toContain(i18n.global.t('settings.source.userFileInfo'));
    expect(text).toContain(i18n.global.t('settings.ideContext'));
    expect(document.body.querySelector('[data-testid="setting-sources"]')).toBeNull();
  });

  it('describe the .damocles files only on a host that keeps them', async () => {
    useSettingsStore().setHostCapabilities({ ...VSCODE_HOST_CAPABILITIES, hostSettingsEditor: false });
    await settingsPanel();

    expect(document.body.textContent ?? '').not.toContain(i18n.global.t('settings.source.userFileInfo'));
  });

  it('show each project-supplied value with its file, and drop VS Code-only and voice affordances', async () => {
    const store = useSettingsStore();
    store.setHostCapabilities(DESKTOP_MAC);
    store.updateSettings(store.currentSettings, {
      'damocles.maxBudgetUsd': { scope: 'project', path: '/w/a/.damocles/settings.json' },
      'damocles.memory.enabled': { scope: 'local', path: '/w/a/.damocles/settings.local.json' },
    });
    await settingsPanel();
    const text = document.body.textContent ?? '';

    expect(text).not.toContain(i18n.global.t('settings.openVsCodeSettings'));
    expect(text).not.toContain(i18n.global.t('settings.voice.title'));
    expect(text).not.toContain(i18n.global.t('settings.ideContext'));
    expect(text).toContain(i18n.global.t('settings.source.userFileInfo'));
    const sources = document.body.querySelector('[data-testid="setting-sources"]')!.textContent ?? '';
    expect(sources).toContain('damocles.maxBudgetUsd');
    expect(sources).toContain('/w/a/.damocles/settings.json');
    expect(sources).toContain('damocles.memory.enabled');
    expect(sources).toContain('/w/a/.damocles/settings.local.json');

    const budgetLabel = [...document.body.querySelectorAll('label')].find((l) => l.textContent?.startsWith(i18n.global.t('settings.budgetLimit')))!;
    expect(budgetLabel.textContent).toContain(i18n.global.t('settings.source.project'));
    expect(budgetLabel.textContent).toContain(i18n.global.t('settings.source.fromFile', { path: '/w/a/.damocles/settings.json' }));
  });
});
