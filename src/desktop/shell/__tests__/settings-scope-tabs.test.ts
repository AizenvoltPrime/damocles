// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { useSettingsStore } from '@/stores/useSettingsStore';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import type { OverlaySettingsScope, OverlaySettingsScopes, PopupAnswer } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, fakeOverlayApi } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const HOST = 'A very long host name that goes on well past the width of a tab';
const scopes = (active: OverlaySettingsScope): OverlaySettingsScopes => ({ host: { name: HOST }, projectFile: '/srv/app/.damocles/settings.json', active });
const mounted: VueWrapper[] = [];
let pinia: Pinia;

async function openOn(active: OverlaySettingsScope, section: 'chat' | 'defaults' = 'chat'): Promise<void> {
  mounted.push(mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  }));
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section, scopes: scopes(active) });
  await flushPromises();
}

// core's first settingsUpdate to a scoped view carries the keys that tab may write
async function update(writableKeys: string[] | undefined): Promise<void> {
  const store = useSettingsStore();
  api.settingsMessage({ type: 'hostCapabilities', capabilities: { ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false } });
  api.settingsMessage({ type: 'settingsUpdate', settings: store.currentSettings, workspaceWritable: true, ...(writableKeys ? { writableKeys } : {}) });
  await flushPromises();
}

const q = (selector: string): HTMLElement | null => document.querySelector<HTMLElement>(selector);
const tab = (name: 'user' | 'host' | 'project'): HTMLElement => q(`[data-testid="settings-scope-${name}"]`)!;
const row = (id: string): HTMLElement | null => q(`[data-testid="settings-row-${id}"]`);
const press = (target: HTMLElement, key: string): void => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
};
// reka selects a tab on a primary-button mousedown
const choose = (target: HTMLElement): void => {
  target.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }));
};

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.mocked(api.setSettingsScope).mockReset();
  vi.mocked(api.setSettingsScope).mockImplementation(async (scope) => ({ ok: true, value: scope }));
  document.documentElement.setAttribute('data-reduced-motion', '');
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('settings scope tabs', () => {
  it('lists the remote chat\'s own rows on its host tab, and on the User tab points to that tab instead of editing another chat', async () => {
    await openOn('machine');
    expect(q('[data-testid="settings-scope-loading"]')!.textContent).toContain(`Loading the ${HOST} settings`);
    expect(row('permission-mode')).toBeNull();
    await update(['damocles.model']);
    expect(row('permission-mode')).not.toBeNull();
    expect(q('[data-testid="settings-scope-banner"]')!.textContent).toContain(`Changes only this chat on ${HOST}`);

    api.settingsAttached(2, scopes('user'));
    await update(undefined);
    expect(row('permission-mode')).toBeNull();
    expect(row('model')).toBeNull();
    expect(q('[data-testid="settings-scope-empty"]')!.textContent).toBe(`This chat runs on ${HOST}. Change its settings on the ${HOST} tab.`);
  });

  it('lists nothing while a tab click waits for main, and goes back to the attached tab, saying so, when main cannot attach it', async () => {
    await openOn('machine', 'defaults');
    await update(['damocles.model']);
    expect(row('damocles.model')).not.toBeNull();
    let refuse!: (error: Error) => void;
    vi.mocked(api.setSettingsScope).mockImplementationOnce(() => new Promise<PopupAnswer<OverlaySettingsScope>>((_resolve, reject) => { refuse = reject; }));
    choose(tab('project'));
    await flushPromises();
    expect(api.setSettingsScope).toHaveBeenCalledWith('project');
    expect(tab('project').getAttribute('aria-selected')).toBe('true');
    expect(row('damocles.model')).toBeNull();
    expect(q('[data-testid="settings-scope-banner"]')).toBeNull();
    expect(q('[data-testid="settings-scope-loading"]')!.textContent).toContain('Loading the Project settings');

    refuse(new Error('The settings of that tab could not be opened'));
    await flushPromises();
    expect(tab('host').getAttribute('aria-selected')).toBe('true');
    expect(row('damocles.model')).not.toBeNull();
    expect(q('[data-testid="settings-scope-failed"]')!.textContent).toBe('The Project settings could not be opened.');
    expect(q('[data-testid="settings-scope-failed"]')!.getAttribute('role')).toBe('status');
  });

  it('shows the desktop app\'s own sections and Voice only on the User tab, and offers each tab\'s own settings files', async () => {
    await openOn('machine');
    expect(q('[data-testid="settings-nav-voice"]')).toBeNull();
    await update(['damocles.model']);
    expect(q('[data-testid="settings-nav-appearance"]')).toBeNull();
    expect(q('[data-testid="settings-nav-voice"]')).toBeNull();
    const files = async (): Promise<string[]> => {
      const footer = q('[data-testid="settings-footer"]')!;
      footer.focus();
      press(footer, 'Enter');
      await flushPromises();
      const items = [...document.querySelectorAll<HTMLElement>('[data-testid^="settings-edit-json-"]')].map((item) => `${item.dataset.testid!.slice('settings-edit-json-'.length)}: ${item.textContent!.trim()}`);
      press(document.activeElement as HTMLElement, 'Escape');
      await flushPromises();
      return items;
    };
    expect(await files()).toEqual([`user: Edit settings.json on ${HOST}`]);

    api.settingsAttached(2, scopes('project'));
    await update(['damocles.maxBudgetUsd']);
    expect(q('[data-testid="settings-nav-voice"]')).toBeNull();
    expect(await files()).toEqual(['project: Edit project settings.json', 'local: Edit local settings.local.json']);

    api.settingsAttached(3, scopes('user'));
    await update(undefined);
    expect(q('[data-testid="settings-nav-appearance"]')).not.toBeNull();
    expect(q('[data-testid="settings-nav-voice"]')).not.toBeNull();
    expect(await files()).toEqual(['user: Edit user settings.json']);
  });

  it.each([
    ['machine', `Not reachable from ${HOST}`],
    ['user', 'Not reachable here'],
  ] as const)('on the %s tab names the chat a loopback model cannot be reached from', async (active, hint) => {
    await openOn(active, 'defaults');
    await update(active === 'user' ? undefined : ['damocles.model']);
    const models = useSettingsStore().availableModels.map((model) => (model.value === 'step-5-preview' ? { ...model, unavailable: { reason: 'loopback-endpoint' as const, endpoint: 'http://127.0.0.1:8080' } } : model));
    api.settingsMessage({ type: 'availableModels', models });
    await flushPromises();
    const select = row('damocles.model')!.querySelector<HTMLElement>('button[aria-label="Default model"]')!;
    select.focus();
    press(select, 'Enter');
    await flushPromises();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((el) => el.textContent!.includes('Step 5 Preview'))!;
    expect(option.textContent).toContain(hint);
  });

  it('moves focus with the arrow keys without switching, and names a long host in full in its title', async () => {
    await openOn('machine');
    tab('host').focus();
    press(tab('host'), 'ArrowRight');
    await flushPromises();
    expect(document.activeElement).toBe(tab('project'));
    expect(api.setSettingsScope).not.toHaveBeenCalled();
    expect(tab('host').getAttribute('aria-selected')).toBe('true');
    press(tab('project'), 'Enter');
    await flushPromises();
    expect(api.setSettingsScope).toHaveBeenCalledWith('project');
    expect(tab('host').getAttribute('title')).toBe(HOST);
    // no TabsContent registers, so no tab names a panel that does not exist
    expect(tab('host').hasAttribute('aria-controls')).toBe(false);
    expect(tab('host').querySelector('.truncate')!.textContent).toBe(HOST);
  });
});
