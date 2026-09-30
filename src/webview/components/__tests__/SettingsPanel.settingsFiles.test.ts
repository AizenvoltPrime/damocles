// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { setActivePinia, createPinia } from 'pinia';
import SettingsPanel from '../SettingsPanel.vue';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { useEditorStore } from '@/stores/useEditorStore';
import { i18n } from '@/i18n';
import { VSCODE_HOST_CAPABILITIES, type HostCapabilities } from '@shared/types/messages';

const DESKTOP: HostCapabilities = { ...VSCODE_HOST_CAPABILITIES, hostSettingsEditor: false, settingsSources: true, monaco: true };

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: (message: unknown) => void } }).acquireVsCodeApi();

const mounted: VueWrapper[] = [];
let posted: { type: string; scope?: string }[] = [];
const loads = () => posted.filter((m) => m.type === 'settingsFileLoad').map((m) => m.scope);
const availabilityRequests = () => posted.filter((m) => m.type === 'getSettingsFileAvailability');

async function mountPanel(): Promise<VueWrapper> {
  const store = useSettingsStore();
  const wrapper = mount(SettingsPanel, {
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
  });
  mounted.push(wrapper as VueWrapper);
  // The sheet renders through a portal on the tick after mount.
  await nextTick();
  return wrapper as VueWrapper;
}

const button = (scope: string) => document.body.querySelector<HTMLButtonElement>(`[data-testid="settings-edit-json-${scope}"]`);
const reason = (scope: string) => document.body.querySelector(`[data-testid="settings-edit-json-reason-${scope}"]`);

beforeEach(() => {
  setActivePinia(createPinia());
  posted = [];
  vi.spyOn(api, 'postMessage').mockImplementation((message: unknown) => void posted.push(message as { type: string }));
});
afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('SettingsPanel "Edit settings.json" entries', () => {
  it.each([
    ['the VS Code host', VSCODE_HOST_CAPABILITIES],
    ['a host without source files', { ...DESKTOP, settingsSources: false }],
    ['a host without Monaco', { ...DESKTOP, monaco: false }],
  ])('are absent and load nothing on %s', async (_name, capabilities) => {
    useSettingsStore().setHostCapabilities(capabilities);
    await mountPanel();

    for (const scope of ['user', 'project', 'local']) expect(button(scope)).toBeNull();
    expect(loads()).toEqual([]);
    expect(availabilityRequests()).toEqual([]);
  });

  it('offer all three files on desktop and ask the host whether the project files apply, without loading them', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    await mountPanel();

    for (const scope of ['user', 'project', 'local']) expect(button(scope)?.disabled).toBe(false);
    expect(availabilityRequests()).toHaveLength(1);
    expect(loads()).toEqual([]);
  });

  it('disable project and local with the reason the host gives, and enable them when the host says they apply', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    await mountPanel();
    const editorStore = useEditorStore();
    editorStore.setSettingsFileAvailability({ user: { available: true }, project: { available: false, reason: 'noProject' }, local: { available: false, reason: 'untrusted' } });
    await nextTick();

    expect(button('user')?.disabled).toBe(false);
    expect(reason('user')).toBeNull();
    expect(button('project')?.disabled).toBe(true);
    expect(reason('project')?.textContent?.trim()).toBe(i18n.global.t('settings.jsonFiles.noProject'));
    expect(button('local')?.disabled).toBe(true);
    expect(reason('local')?.textContent?.trim()).toBe(i18n.global.t('settings.jsonFiles.untrusted'));

    editorStore.setSettingsFileAvailability({ user: { available: true }, project: { available: true }, local: { available: true } });
    await nextTick();
    expect(button('project')?.disabled).toBe(false);
    expect(reason('project')).toBeNull();
    expect(button('local')?.disabled).toBe(false);
  });

  it('open the editor for the chosen file and close the sheet it sits in', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    const wrapper = await mountPanel();

    button('local')!.click();
    await nextTick();

    expect(useEditorStore().settingsEditorScope).toBe('local');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('leave focus with the editor overlay instead of returning it to the control that opened the sheet', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const wrapper = await mountPanel();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).not.toBe(opener);

    button('user')!.click();
    await wrapper.setProps({ visible: false });
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    expect(document.activeElement).not.toBe(opener);
  });

  it('return focus to the control that opened the sheet when it closes any other way', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    const wrapper = await mountPanel();
    await new Promise((r) => setTimeout(r, 0));

    await wrapper.setProps({ visible: false });
    await new Promise((r) => setTimeout(r, 0));
    await nextTick();

    expect(document.activeElement).toBe(opener);
  });

  it('offer a return to the file open in the editor, and route another file through that editor', async () => {
    useSettingsStore().setHostCapabilities(DESKTOP);
    const editorStore = useEditorStore();
    editorStore.openSettingsEditor('user');
    await mountPanel();

    expect(button('user')?.dataset['open']).toBe('true');
    expect(button('user')?.textContent?.trim()).toBe(i18n.global.t('settings.jsonFiles.return.user'));
    expect(button('project')?.textContent?.trim()).toBe(i18n.global.t('settings.jsonFiles.edit.project'));

    button('project')!.click();
    await nextTick();

    expect(editorStore.settingsEditorScope).toBe('user');
    expect(editorStore.requestedSettingsScope).toBe('project');
  });
});
