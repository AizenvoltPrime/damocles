// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { VSCODE_HOST_CAPABILITIES } from '@shared/types/messages';
import type { ToolsSnapshot } from '@shared/types/tools';
import type { ForgeAccountsState } from '@shared/forge/accounts';
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

const mounted: VueWrapper[] = [];
const FORGE = 'damocles.desktop.forge.';
const FORGE_STATE: ForgeAccountsState = { status: 'ready', servers: [], accounts: [], notices: [], redirectUris: { gitlab: '', github: '' }, showAvatars: true };

function tools(forgeEnabled: boolean): ToolsSnapshot {
  return { groups: [{ group: 'forge', enabled: forgeEnabled, available: true }, { group: 'core', enabled: true, available: true }], tools: [] };
}

async function openAccounts(): Promise<void> {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'accounts' });
  await flushPromises();
  api.settingsMessage({ type: 'hostCapabilities', capabilities: { ...VSCODE_HOST_CAPABILITIES, settingsInPanel: false, forgeAccounts: true } });
  api.settingsMessage({ type: 'forgeAccountsChanged', state: FORGE_STATE });
  api.settingsMessage({ type: 'toolStatus', data: tools(true) });
  await flushPromises();
}

const row = (name: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-testid="settings-row-${FORGE}${name}"]`);
const switchOf = (name: string): HTMLElement => row(name)!.querySelector<HTMLElement>('[role="switch"]')!;
const segment = (name: string, label: string): HTMLElement => [...row(name)!.querySelectorAll<HTMLElement>('button[aria-pressed]')].find((button) => button.textContent!.trim() === label)!;
const settingsSent = (): unknown[] => vi.mocked(api.settingsSend).mock.calls.map(([, message]) => message);

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.mocked(api.setPref).mockClear();
  vi.mocked(api.settingsSend).mockClear();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('Settings › Models & accounts › Git hosting: the forge settings rows', () => {
  it('lists the six settings at the end of the Git hosting group, titled, with their defaults', async () => {
    await openAccounts();
    const group = document.querySelector<HTMLElement>('[data-testid="forge-hosting"]')!;
    const order = [...group.querySelectorAll('[data-testid^="settings-row-damocles.desktop.forge."]')].map((element) => element.getAttribute('data-testid')!.slice(`settings-row-${FORGE}`.length));
    expect(order).toEqual(['agentTools', 'agentReadAnyRepository', 'ciStatus', 'branchProtection', 'cloneProtocol', 'showAvatars']);
    const rows = [...group.querySelectorAll('[data-testid^="settings-row-"]')].map((element) => element.getAttribute('data-testid'));
    expect(rows.indexOf('settings-row-forge-add-server')).toBeLessThan(rows.indexOf(`settings-row-${FORGE}agentTools`));
    const title = (name: string): string => row(name)!.querySelector('[id^="settings-row-label-"]')!.textContent!.trim();
    expect(['agentTools', 'agentReadAnyRepository', 'ciStatus', 'branchProtection', 'cloneProtocol', 'showAvatars'].map(title)).toEqual([
      "Agent's GitHub and GitLab tools", 'Agent reads any repository', 'CI status', 'Server branch protection', 'Clone and publish over', 'Account pictures',
    ]);
    expect(switchOf('agentTools').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('agentReadAnyRepository').getAttribute('aria-checked')).toBe('false');
    expect(switchOf('ciStatus').getAttribute('aria-checked')).toBe('true');
    expect(switchOf('branchProtection').getAttribute('aria-checked')).toBe('true');
    expect(segment('cloneProtocol', 'HTTPS').getAttribute('aria-pressed')).toBe('true');
    expect(switchOf('showAvatars').getAttribute('aria-checked')).toBe('true');
  });

  it("says what reading any repository allows: the account's repositories for reads, the project's alone for writes, off by default", async () => {
    await openAccounts();
    expect(row('agentReadAnyRepository')!.querySelector('.sm-row-desc')!.textContent!.trim()).toBe(
      "Lets the agent's read tools target any repository your account can see on the project's server. Writes stay limited to the project's own repositories. Off by default.",
    );
  });

  it('writes each desktop setting to the user file through main', async () => {
    await openAccounts();
    switchOf('agentReadAnyRepository').click();
    switchOf('ciStatus').click();
    switchOf('branchProtection').click();
    segment('cloneProtocol', 'SSH').click();
    switchOf('showAvatars').click();
    await flushPromises();
    expect(vi.mocked(api.setPref).mock.calls).toEqual([
      [`${FORGE}agentReadAnyRepository`, true],
      [`${FORGE}ciStatus`, false],
      [`${FORGE}branchProtection`, false],
      [`${FORGE}cloneProtocol`, 'ssh'],
      [`${FORGE}showAvatars`, false],
    ]);
    expect(row('agentReadAnyRepository')!.querySelector('[data-testid="setting-saved"]')!.getAttribute('title')).toBe('/home/u/.damocles/settings.json');
    expect(segment('cloneProtocol', 'SSH').getAttribute('aria-pressed')).toBe('true');
  });

  it("switches the agent tools as the Tools panel does: core's toggleToolGroup writes, and only core's toolStatus says what they are", async () => {
    await openAccounts();
    switchOf('agentTools').click();
    await flushPromises();
    expect(settingsSent()).toContainEqual({ type: 'toggleToolGroup', group: 'forge', enabled: false });
    expect(api.setPref).not.toHaveBeenCalled();
    // the switch holds its own value while the write is in flight, whatever toolStatus says meanwhile
    api.settingsMessage({ type: 'toolStatus', data: tools(true) });
    await flushPromises();
    expect(switchOf('agentTools').getAttribute('aria-checked')).toBe('false');
    api.settingsMessage({ type: 'settingWriteResult', key: `${FORGE}agentTools`, ok: true, scope: 'user', file: '/home/u/.damocles/settings.json' });
    api.settingsMessage({ type: 'toolStatus', data: tools(false) });
    await flushPromises();
    expect(switchOf('agentTools').getAttribute('aria-checked')).toBe('false');
    expect(row('agentReadAnyRepository')).toBeNull();
    // a change from elsewhere (the Tools panel, settings.json) reaches the row only as core's next toolStatus
    api.settingsMessage({ type: 'toolStatus', data: tools(true) });
    await flushPromises();
    expect(switchOf('agentTools').getAttribute('aria-checked')).toBe('true');
    expect(row('agentReadAnyRepository')).not.toBeNull();
  });

  it('finds a row by search though no server row matches', async () => {
    await openAccounts();
    const search = document.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
    search.value = 'account pictures';
    search.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(row('showAvatars')).not.toBeNull();
    expect(row('ciStatus')).toBeNull();
    expect(document.querySelector('[data-testid^="settings-row-forge-server"]')).toBeNull();
  });
});
