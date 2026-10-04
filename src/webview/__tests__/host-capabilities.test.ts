// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { createApp, nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import { i18n } from '@/i18n';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useUIStore } from '@/stores/useUIStore';
import { createHandlerRegistry } from '@/composables/message-handler/handler-registry';
import type { HandlerContext, HandlerRegistry } from '@/composables/message-handler/types';
import ChatInput from '@/components/ChatInput.vue';
import SettingsModal from '@/components/settings/SettingsModal.vue';
import { NO_HOST_SETTINGS } from '@/components/settings/settings-rows';
import type { SettingsSectionId } from '@shared/settings-sections';
import { VSCODE_HOST_CAPABILITIES, type ExtensionToWebviewMessage, type HostCapabilities } from '@shared/types/messages';

const DESKTOP_MAC: HostCapabilities = {
  voice: false,
  hostSpeechExtensions: false,
  hostSettingsEditor: false,
  diffReview: true,
  settingsSources: true,
  monaco: true,
  ideContext: false,
  damoclesTheme: true,
  settingsInPanel: false,
  historyInPanel: false,
  folderPickerInPanel: false,
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
      diffReview: true,
      settingsSources: false,
      monaco: false,
      ideContext: true,
      damoclesTheme: false,
      settingsInPanel: true,
      historyInPanel: true,
      folderPickerInPanel: true,
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
    dispatch({ type: 'settingsUpdate', settings, workspaceWritable: true, settingSources: { 'damocles.maxBudgetUsd': { scope: 'project', path: '/w/a/.damocles/settings.json', value: 3 } } });
    expect(store.settingSources).toEqual({ 'damocles.maxBudgetUsd': { scope: 'project', path: '/w/a/.damocles/settings.json', value: 3 } });

    dispatch({ type: 'settingsUpdate', settings, workspaceWritable: true });
    expect(store.settingSources).toEqual({});
  });

  it('openSettingsPanel opens the section it names, in the page or through the host', () => {
    const settingsStore = useSettingsStore();
    const uiStore = useUIStore();
    const posted: unknown[] = [];
    const ctx = { stores: { settingsStore, uiStore }, bridge: { postMessage: (m: unknown) => posted.push(m) } } as unknown as HandlerContext;
    const open = buildRegistry().openSettingsPanel as (m: ExtensionToWebviewMessage, c: HandlerContext) => void;

    open({ type: 'openSettingsPanel', section: 'integrations' }, ctx);
    expect(uiStore.settingsTarget).toEqual({ section: 'integrations' });
    settingsStore.setHostCapabilities(DESKTOP_MAC);
    open({ type: 'openSettingsPanel', section: 'integrations' }, ctx);
    expect(posted).toEqual([{ type: 'openAppSettings', section: 'integrations' }]);
  });

  it('settingsUpdate stores whether the Workspace section can be written', () => {
    const store = useSettingsStore();
    dispatch({ type: 'settingsUpdate', settings: store.currentSettings, workspaceWritable: false });
    expect(store.workspaceWritable).toBe(false);
    dispatch({ type: 'settingsUpdate', settings: store.currentSettings, workspaceWritable: true });
    expect(store.workspaceWritable).toBe(true);
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

  it('hide the composer\'s active-file chip when the host has no editor context', async () => {
    const wrapper = composer();
    expect(wrapper.find('[data-testid="composer-ide"]').exists()).toBe(true);

    useSettingsStore().setHostCapabilities(DESKTOP_MAC);
    await nextTick();
    expect(wrapper.find('[data-testid="composer-ide"]').exists()).toBe(false);
  });

  async function settingsModal(section: SettingsSectionId): Promise<void> {
    mounted.push(mount(SettingsModal, {
      props: { host: NO_HOST_SETTINGS, footer: { kind: 'hostSettings' }, backdrop: 'blur', target: { section } },
      attachTo: document.body,
      global: { plugins: [i18n] },
    }));
    await nextTick();
  }
  const settingsRow = (id: string) => document.body.querySelector(`[data-testid="settings-row-${id}"]`);
  const voiceNav = () => document.body.querySelector('[data-testid="settings-nav-voice"]');

  it('keep Include active file and the Voice section in the VS Code settings modal', async () => {
    await settingsModal('defaults');
    expect(settingsRow('damocles.ideContext.enabled')).not.toBeNull();
    expect(voiceNav()).not.toBeNull();
  });

  it('drop Include active file and the Voice section from the settings modal on a host without them', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP_MAC);
    await settingsModal('defaults');
    expect(settingsRow('damocles.ideContext.enabled')).toBeNull();
    expect(settingsRow('damocles.dangerouslySkipPermissions')).not.toBeNull();
    expect(voiceNav()).toBeNull();
  });
});
