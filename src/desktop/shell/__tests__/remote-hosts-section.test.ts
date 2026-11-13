// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { canonicalHostColor } from '@shared/host-colors';
import { THEME_PALETTES } from '../../theme-palettes';
import { STAGE_FAILED_CODES, type PasswordlessResult, type PasswordlessRun, type PopupAnswer, type RemoteHostEntry, type RemoveServerResult } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
import SettingSelect from '@/components/settings/controls/SettingSelect.vue';
import type { HostDefaultsView } from '@shared/forge/bindings';
import type { Component } from 'vue';
import { FakeResizeObserver, fakeOverlayApi, opened } from './fakes';

// One overlay page per file, as in the app: the bridge is installed before anything uses it.
const api = fakeOverlayApi();
const settingsBridge = createOverlaySettingsBridge(api);
installPlatformBridge(settingsBridge);
addSettingsMessages();

const mounted: VueWrapper[] = [];
let pinia: Pinia;

const PROD: RemoteHostEntry = {
  hostId: 'h1',
  kind: 'ssh',
  authorityKey: 'ssh+h1',
  name: 'prod-1',
  destinationLabel: 'deploy@prod-1',
  os: 'linux',
  detectedOs: 'linux',
  connection: 'connected',
  settings: { allowBypass: false, forwardAgent: false, rememberPassword: false, browserLocalNetwork: false, openLinksWithoutAsking: false },
  facts: { passwordless: false, keyInstalledByDamocles: true, lingerEnabledByDamocles: false, alwaysCredentialHosts: ['github.com'], alwaysForgeAccounts: [] },
  heldMemoryQueues: [],
};
const WIN: RemoteHostEntry = { ...PROD, hostId: 'h2', authorityKey: 'ssh+h2', name: 'win-box', os: 'win32', detectedOs: 'win32', connection: 'offline', facts: { ...PROD.facts, alwaysCredentialHosts: [] } };

async function openRemoteHosts(host?: string): Promise<VueWrapper> {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge },
    global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  api.request('s1', { kind: 'settings', generation: 1, section: 'remoteHosts' });
  await flushPromises();
  if (host !== undefined) {
    api.settingsTarget({ section: 'remoteHosts', host });
    await flushPromises();
  }
  return wrapper;
}

const $ = <E extends Element = HTMLElement>(selector: string): E | null => document.querySelector<E>(selector);
const block = (): HTMLElement => $('[data-testid="remote-host"]')!;
const switchNamed = (name: string): HTMLElement | undefined => [...block().querySelectorAll<HTMLElement>('[role="switch"]')].find((element) => element.getAttribute('aria-label') === name);
const buttonNamed = (name: string, root: ParentNode = document): HTMLElement | undefined => [...root.querySelectorAll<HTMLElement>('button')].find((element) => element.textContent?.trim() === name);
const stepStates = (): (string | undefined)[] => [...document.querySelectorAll<HTMLElement>('[data-testid="passwordless-step"]')].map((step) => step.dataset.state);
// main publishes a run's end before its call answers
const removalEnds = (result: RemoveServerResult): PopupAnswer<RemoveServerResult> => {
  api.pushHostOperations({ hostId: 'h1', removal: { result } });
  return opened(result);
};
const setupEnds = (passwordless: PasswordlessRun & { readonly result: PasswordlessResult }): PopupAnswer<PasswordlessResult> => {
  api.pushHostOperations({ hostId: 'h1', passwordless });
  return opened(passwordless.result);
};

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  document.documentElement.setAttribute('data-reduced-motion', '');
  api.remoteHosts.list = [PROD, WIN];
  api.hostOperations.clear();
  vi.mocked(api.setHostSetting).mockReset().mockResolvedValue(opened(undefined));
  vi.mocked(api.revokeCredentialHost).mockClear();
  vi.mocked(api.renameHost).mockClear();
  vi.mocked(api.removalInfo).mockClear();
  vi.mocked(api.removeServer).mockClear();
  vi.mocked(api.forgetHost).mockClear();
  vi.mocked(api.setUpPasswordless).mockClear();
  vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'win32' });
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-reduced-motion');
});

describe('Settings, Remote hosts', () => {
  it('renames and recolors the host scope tab at once', async () => {
    mounted.push(mount(OverlayApp, { props: { api, settingsBridge }, global: { plugins: [shellI18n, pinia], stubs: { transition: false, 'transition-group': false } }, attachTo: document.body }));
    await flushPromises();
    api.request('s1', { kind: 'settings', generation: 1, scopes: { host: { name: 'prod-1' }, active: 'user' } });
    await flushPromises();
    const tab = (): HTMLElement => $('[data-testid="settings-scope-host"]')!;
    expect(tab().textContent).toContain('prod-1');
    expect(tab().querySelector('.d-tone-muted')).not.toBeNull();
    api.settingsScopeHost({ name: 'prod-eu', color: 'danger' });
    await flushPromises();
    expect(tab().textContent).toContain('prod-eu');
    expect(tab().querySelector('.d-tone-danger')).not.toBeNull();
    api.settingsScopeHost({ name: 'prod-eu', color: canonicalHostColor('#00809a99')! });
    await flushPromises();
    const dot = tab().querySelector<HTMLElement>('.d-tone-custom')!;
    expect(dot.style.getPropertyValue('--host-rgb')).toBe('0 128 154');
    expect(dot.style.getPropertyValue('--host-alpha')).toBe('0.6');
  });

  it('lists the saved hosts, shows the first, and holds the global idle limit in its header', async () => {
    await openRemoteHosts();
    expect($('[data-testid="settings-nav-remoteHosts"]')!.getAttribute('aria-selected')).toBe('true');
    expect($('[data-testid="settings-row-damocles.desktop.remote.terminalIdleDays"]')).not.toBeNull();
    const picks = [...document.querySelectorAll<HTMLElement>('[data-testid="remote-host-pick"]')];
    expect(picks.map((pick) => [pick.textContent?.trim(), pick.getAttribute('aria-checked')])).toEqual([['prod-1', 'true'], ['win-box', 'false']]);
    expect(block().dataset.hostId).toBe('h1');
  });

  it('opens on the host a settings request names', async () => {
    await openRemoteHosts('h2');
    expect(block().dataset.hostId).toBe('h2');
  });

  it('sends a switch to main, shows it at once, and keeps main\'s pushed value', async () => {
    await openRemoteHosts();
    switchNamed('Allow YOLO')!.click();
    await flushPromises();
    expect(api.setHostSetting).toHaveBeenCalledWith('h1', { key: 'allowBypass', value: true });
    expect(switchNamed('Allow YOLO')!.getAttribute('aria-checked')).toBe('true');
    api.hostEntries([{ ...PROD, settings: { ...PROD.settings, allowBypass: true } }, WIN]);
    await flushPromises();
    expect(switchNamed('Allow YOLO')!.getAttribute('aria-checked')).toBe('true');
    api.hostEntries([PROD, WIN]);
    await flushPromises();
    expect(switchNamed('Allow YOLO')!.getAttribute('aria-checked')).toBe('false');
  });

  it('reverts a change main could not save and says so', async () => {
    vi.mocked(api.setHostSetting).mockRejectedValue(new Error('store write failed'));
    await openRemoteHosts();
    switchNamed('Remember password')!.click();
    await flushPromises();
    expect(switchNamed('Remember password')!.getAttribute('aria-checked')).toBe('false');
    expect($('[data-testid="settings-row-remote-host-remember"] [role="alert"]')!.textContent).toContain('The setting could not be saved.');
  });

  it('offers agent forwarding only for a POSIX host', async () => {
    await openRemoteHosts();
    expect(switchNamed('Forward my SSH agent')).toBeDefined();
    buttonNamed('win-box')!.click();
    await flushPromises();
    expect(block().dataset.hostId).toBe('h2');
    expect(switchNamed('Forward my SSH agent')).toBeUndefined();
    expect(switchNamed('Allow YOLO')).toBeDefined();
  });

  it('offers a container its own agent forwarding switch, off by default, and no password to remember', async () => {
    api.remoteHosts.list = [{ ...PROD, kind: 'container', authorityKey: `container+${'ab'.repeat(16)}`, name: 'web-app', destinationLabel: 'web-app', container: { origin: 'attach', state: 'running', engine: 'docker', containerName: 'web-app', user: 'configured' } }];
    await openRemoteHosts();
    const agent = switchNamed('Forward my SSH agent')!;
    expect(agent.getAttribute('aria-checked')).toBe('false');
    expect(switchNamed('Remember password')).toBeUndefined();
    agent.click();
    await flushPromises();
    expect(api.setHostSetting).toHaveBeenCalledWith('h1', { key: 'forwardAgent', value: true });
    expect(switchNamed('Forward my SSH agent')!.getAttribute('aria-checked')).toBe('true');
  });

  it('leaves the ssh-only settings and passwordless setup off a WSL host', async () => {
    api.remoteHosts.list = [{ ...PROD, kind: 'wsl', name: 'ml-box', destinationLabel: 'Ubuntu-24.04' }];
    await openRemoteHosts();
    expect(switchNamed('Forward my SSH agent')).toBeUndefined();
    expect(switchNamed('Remember password')).toBeUndefined();
    expect(switchNamed('Allow YOLO')).toBeDefined();
    expect(block().querySelector('[data-testid="settings-row-remote-host-os"]')).toBeNull();
    expect(block().querySelector('[data-testid="passwordless"]')).toBeNull();
    // the removal stage runs over ssh, so a WSL host offers none
    expect(block().querySelector('[data-testid="remove-server"]')).toBeNull();
  });

  it('names the host in the links switch and stores the network and links switches', async () => {
    await openRemoteHosts();
    switchNamed('Open links from prod-1\'s terminals without asking')!.click();
    switchNamed('Let the agent\'s browser reach this computer\'s local network')!.click();
    await flushPromises();
    expect(api.setHostSetting).toHaveBeenCalledWith('h1', { key: 'openLinksWithoutAsking', value: true });
    expect(api.setHostSetting).toHaveBeenCalledWith('h1', { key: 'browserLocalNetwork', value: true });
  });

  it('picks a color from the palette tones, by click and by arrow key, and clears it with None', async () => {
    await openRemoteHosts();
    const swatches = [...block().querySelectorAll<HTMLElement>('[role="radiogroup"][aria-label="Color"] [role="radio"]')];
    expect(swatches.map((swatch) => swatch.dataset.tone)).toEqual(['none', 'accent', 'success', 'warning', 'danger', 'info', 'custom']);
    expect(swatches.map((swatch) => swatch.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1', '-1']);
    swatches[4]!.click();
    await flushPromises();
    expect(api.setHostSetting).toHaveBeenLastCalledWith('h1', { key: 'color', value: 'danger' });
    const red = block().querySelector<HTMLElement>('[data-tone="danger"]')!;
    expect(red.getAttribute('aria-checked')).toBe('true');
    expect(red.classList.contains('d-tone-danger')).toBe(true);
    red.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect(api.setHostSetting).toHaveBeenLastCalledWith('h1', { key: 'color', value: 'info' });
    // the roving tab stop follows the arrow key
    expect((document.activeElement as HTMLElement | null)?.dataset.tone).toBe('info');
    block().querySelector<HTMLElement>('[data-tone="none"]')!.click();
    await flushPromises();
    expect(api.setHostSetting).toHaveBeenLastCalledWith('h1', { key: 'color', value: null });
  });

  describe('custom color', () => {
    const TEAL = { ...PROD, settings: { ...PROD.settings, color: canonicalHostColor('#00808099')! } };
    const custom = (): HTMLElement => block().querySelector<HTMLElement>('[data-tone="custom"]')!;
    const picker = (): HTMLElement | null => $('[data-testid="host-color-picker"]');
    const hex = (): HTMLInputElement => picker()!.querySelector<HTMLInputElement>('input[aria-label="Hex color"]')!;
    const areaThumb = (): HTMLElement => picker()!.querySelector<HTMLElement>('[role="slider"][aria-label="Saturation and brightness"]')!;
    const opacity = (): HTMLElement => picker()!.querySelector<HTMLElement>('[role="slider"][aria-label="Opacity"]')!;
    const press = (target: Element, type: 'keydown' | 'keyup', key: string): void => {
      target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }));
    };
    const colorWrites = (): unknown[] => vi.mocked(api.setHostSetting).mock.calls.filter(([, change]) => change.key === 'color');
    // the picker's commits reach main once they pause
    const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 350));
    const described = (element: HTMLElement): string => (element.getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ');

    async function openPicker(): Promise<void> {
      custom().click();
      await flushPromises();
      expect(picker()).not.toBeNull();
    }

    async function typeHex(text: string): Promise<void> {
      hex().focus();
      hex().value = text;
      hex().dispatchEvent(new Event('input', { bubbles: true }));
      await flushPromises();
    }

    it('shows a stored custom color on its checked swatch, in its description and in the host picker', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      expect(custom().getAttribute('aria-checked')).toBe('true');
      expect(custom().getAttribute('aria-label')).toBe('Custom color');
      expect(described(custom())).toBe('#008080 at 60% opacity Opens a color picker');
      expect(custom().title).toBe('Custom color: #008080 at 60% opacity');
      expect(custom().classList.contains('d-tone-custom')).toBe(true);
      expect(custom().style.getPropertyValue('--host-rgb')).toBe('0 128 128');
      const dot = $('[data-testid="remote-host-pick"][data-host-id="h1"] span[aria-hidden="true"]')!;
      expect(dot.classList.contains('d-tone-custom')).toBe(true);
      expect(dot.style.getPropertyValue('--host-alpha')).toBe(String(0x99 / 255));
    });

    it('keeps the custom swatch a plain radio, open or closed, and gives focus back to it on Escape', async () => {
      await openRemoteHosts();
      const radioOnly = (): string[] => custom().getAttributeNames().filter((name) => name.startsWith('aria-')).sort();
      expect(radioOnly()).toEqual(['aria-checked', 'aria-describedby', 'aria-label']);
      expect(described(custom())).toBe('Opens a color picker');
      await openPicker();
      expect(radioOnly()).toEqual(['aria-checked', 'aria-describedby', 'aria-label']);
      expect(picker()!.getAttribute('role')).toBe('dialog');
      press(areaThumb(), 'keydown', 'Escape');
      await flushPromises();
      expect(picker()).toBeNull();
      expect(document.activeElement).toBe(custom());
    });

    it('writes the commits once they pause, starting from the stored color', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      expect(hex().value).toBe('#00808099');
      await typeHex('#FF000080');
      press(hex(), 'keydown', 'Enter');
      press(hex(), 'keyup', 'Enter');
      await flushPromises();
      expect(custom().style.getPropertyValue('--host-rgb')).toBe('255 0 0');
      expect(colorWrites()).toEqual([]);
      await typeHex('#0000ff80');
      press(hex(), 'keydown', 'Enter');
      press(hex(), 'keyup', 'Enter');
      await settle();
      expect(colorWrites()).toEqual([['h1', { key: 'color', value: '#0000ff80' }]]);
      press(hex(), 'keydown', 'Escape');
      await flushPromises();
      expect(picker()).toBeNull();
      expect(colorWrites()).toHaveLength(1);
      expect($('[data-testid="settings-nav-remoteHosts"]')).not.toBeNull();
    });

    it('writes a held commit at once when the popover closes', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      areaThumb().focus();
      press(areaThumb(), 'keydown', 'ArrowDown');
      press(areaThumb(), 'keyup', 'ArrowDown');
      await flushPromises();
      const committed = hex().value;
      expect(colorWrites()).toEqual([]);
      custom().click();
      await flushPromises();
      expect(picker()).toBeNull();
      expect(colorWrites()).toEqual([['h1', { key: 'color', value: committed }]]);
    });

    it('drops an unwritten draft on Escape', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      areaThumb().focus();
      press(areaThumb(), 'keydown', 'ArrowDown');
      await flushPromises();
      expect(hex().value).not.toBe('#00808099');
      press(areaThumb(), 'keydown', 'Escape');
      await flushPromises();
      expect(picker()).toBeNull();
      expect(colorWrites()).toEqual([]);
      expect(custom().style.getPropertyValue('--host-rgb')).toBe('0 128 128');
    });

    it('writes nothing for hex typed and then cancelled with Escape, even when the closing field blurs', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      await typeHex('#ff0000');
      const field = hex();
      press(field, 'keydown', 'Escape');
      await flushPromises();
      expect(picker()).toBeNull();
      field.dispatchEvent(new FocusEvent('blur'));
      await settle();
      expect(colorWrites()).toEqual([]);
    });

    it('writes an unwritten draft once when the swatch closes the popover', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      areaThumb().focus();
      press(areaThumb(), 'keydown', 'ArrowDown');
      await flushPromises();
      const draft = hex().value;
      expect(draft).toMatch(/^#[0-9a-f]{8}$/);
      custom().click();
      await flushPromises();
      expect(picker()).toBeNull();
      expect(colorWrites()).toEqual([['h1', { key: 'color', value: draft }]]);
    });

    it('writes an unwritten draft once when a press outside closes the popover, and leaves focus there', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      areaThumb().focus();
      press(areaThumb(), 'keydown', 'ArrowDown');
      await flushPromises();
      const draft = hex().value;
      const outside = block().querySelector<HTMLElement>('[data-tone="none"]')!;
      outside.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      await flushPromises();
      expect(picker()).toBeNull();
      expect(colorWrites()).toEqual([['h1', { key: 'color', value: draft }]]);
      expect(document.activeElement).not.toBe(custom());
    });

    it('starts a host with no color from the accent tone and a tone from its palette value, and closing unchanged writes nothing', async () => {
      await openRemoteHosts();
      await openPicker();
      expect(hex().value).toBe(THEME_PALETTES.dark['--d-accent']);
      custom().click();
      await flushPromises();
      api.remoteHosts.list = [{ ...PROD, settings: { ...PROD.settings, color: 'danger' } }, WIN];
      api.hostEntries(api.remoteHosts.list);
      await flushPromises();
      await openPicker();
      expect(hex().value).toBe(THEME_PALETTES.dark['--d-danger']);
      custom().click();
      await flushPromises();
      expect(picker()).toBeNull();
      expect(colorWrites()).toEqual([]);
    });

    it('reads zero opacity as no color: None shows checked and the write clears the color', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      opacity().focus();
      press(opacity(), 'keydown', 'Home');
      press(opacity(), 'keyup', 'Home');
      await flushPromises();
      expect(block().querySelector('[data-tone="none"]')!.getAttribute('aria-checked')).toBe('true');
      expect(custom().getAttribute('aria-checked')).toBe('false');
      expect($('[data-testid="host-color-transparent"]')?.closest('[role="status"]')).not.toBeNull();
      custom().click();
      await flushPromises();
      expect(colorWrites()).toEqual([['h1', { key: 'color', value: null }]]);
    });

    it('writes a held commit to the host it was made on when another host is selected, and closes the picker', async () => {
      api.remoteHosts.list = [TEAL, WIN];
      await openRemoteHosts();
      await openPicker();
      await typeHex('#ff000080');
      press(hex(), 'keydown', 'Enter');
      press(hex(), 'keyup', 'Enter');
      await flushPromises();
      const field = hex();
      await typeHex('#00ff0080');
      api.settingsTarget({ section: 'remoteHosts', host: 'h2' });
      await flushPromises();
      expect(block().dataset.hostId).toBe('h2');
      expect(picker()).toBeNull();
      field.dispatchEvent(new FocusEvent('blur'));
      await settle();
      expect(colorWrites()).toEqual([['h1', { key: 'color', value: '#ff000080' }]]);
      expect(custom().getAttribute('aria-checked')).toBe('false');
    });

    it('arrows onto the custom swatch without writing or opening it', async () => {
      await openRemoteHosts();
      const info = block().querySelector<HTMLElement>('[data-tone="info"]')!;
      info.click();
      await flushPromises();
      vi.mocked(api.setHostSetting).mockClear();
      press(info, 'keydown', 'ArrowRight');
      await flushPromises();
      expect(document.activeElement).toBe(custom());
      expect(picker()).toBeNull();
      expect(colorWrites()).toEqual([]);
    });
  });

  it('renames the host through main\'s validator', async () => {
    await openRemoteHosts();
    const field = block().querySelector<HTMLInputElement>('[data-testid="host-name-input"]')!;
    expect(field.value).toBe('prod-1');
    field.value = 'prod-eu';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(api.renameHost).toHaveBeenCalledWith('h1', 'prod-eu');
  });

  it('keeps a typed name across a push of the same hosts, and takes a name the push changed', async () => {
    await openRemoteHosts();
    const field = block().querySelector<HTMLInputElement>('[data-testid="host-name-input"]')!;
    field.value = 'PROD';
    field.dispatchEvent(new Event('input'));
    await flushPromises();
    api.hostEntries([{ ...PROD, connection: 'offline' }, WIN]);
    await flushPromises();
    expect(field.value).toBe('PROD');
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(api.renameHost).toHaveBeenCalledWith('h1', 'PROD');
    api.hostEntries([{ ...PROD, name: 'prod-eu' }, WIN]);
    await flushPromises();
    expect(field.value).toBe('prod-eu');
  });

  it('says in place that the name was not saved when main\'s call fails', async () => {
    vi.mocked(api.renameHost).mockRejectedValueOnce(new Error('store write failed'));
    await openRemoteHosts();
    const field = block().querySelector<HTMLInputElement>('[data-testid="host-name-input"]')!;
    field.value = 'prod-eu';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(block().querySelector('[data-testid="host-name-error"]')!.textContent).toBe('The name could not be saved. Try again.');
    expect(field.value).toBe('prod-eu');
  });

  it('lists the credential hosts this host may always use, each with Revoke', async () => {
    await openRemoteHosts();
    const rows = [...block().querySelectorAll<HTMLElement>('[data-testid="credential-host"]')];
    expect(rows.map((row) => row.textContent)).toEqual([expect.stringContaining('github.com')]);
    rows[0]!.querySelector<HTMLElement>('[aria-label="Revoke github.com"]')!.click();
    await flushPromises();
    expect(api.revokeCredentialHost).toHaveBeenCalledWith('h1', 'github.com');
  });

  it('removes the server after listing what runs, with a box only for each change Damocles made', async () => {
    vi.mocked(api.removalInfo).mockResolvedValueOnce(opened({ runs: [{ kind: 'chat', id: 'c1', title: 'Fix login', state: 'running' }, { kind: 'terminal', id: 't1', title: 'npm run dev', state: 'background' }], offerRemoveKey: true, offerDisableLinger: false }));
    vi.mocked(api.removeServer).mockImplementationOnce(async () => removalEnds({ ok: true, notices: [{ code: 'versionKept', params: { version: '3.7.0', machine: 'LAPTOP' } }] }));
    await openRemoteHosts();
    buttonNamed('Remove Damocles server...')!.click();
    await flushPromises();
    const dialog = $('[data-testid="remove-server-dialog"]')!;
    expect(dialog.getAttribute('role')).toBe('alertdialog');
    expect([...dialog.querySelectorAll('[data-testid="removal-run"]')].map((row) => row.textContent)).toEqual([expect.stringContaining('Fix login'), expect.stringContaining('npm run dev')]);
    expect(dialog.querySelector('[data-testid="remove-server-key"]')!.getAttribute('aria-checked')).toBe('true');
    expect(dialog.querySelector('[data-testid="remove-server-linger"]')).toBeNull();
    expect(document.activeElement).toBe(dialog.querySelector('[data-testid="remove-server-cancel"]'));
    buttonNamed('Remove server', dialog)!.click();
    await flushPromises();
    expect(api.removeServer).toHaveBeenCalledWith('h1', { removeKey: true, disableLinger: false });
    expect($('[data-testid="remove-server-result"]')!.textContent).toContain('Version 3.7.0 stays, because LAPTOP still uses it.');
  });

  it('shows Disable linger, unchecked, only when Damocles turned linger on', async () => {
    vi.mocked(api.removalInfo).mockResolvedValueOnce(opened({ runs: [], offerRemoveKey: false, offerDisableLinger: true }));
    await openRemoteHosts();
    buttonNamed('Remove Damocles server...')!.click();
    await flushPromises();
    const dialog = $('[data-testid="remove-server-dialog"]')!;
    expect(dialog.querySelector('[data-testid="remove-server-key"]')).toBeNull();
    const linger = dialog.querySelector<HTMLElement>('[data-testid="remove-server-linger"]')!;
    expect(linger.getAttribute('aria-checked')).toBe('false');
    linger.click();
    await flushPromises();
    buttonNamed('Remove server', dialog)!.click();
    await flushPromises();
    expect(api.removeServer).toHaveBeenCalledWith('h1', { removeKey: false, disableLinger: true });
  });

  it('says why a removal failed, from main\'s code, with an exit code only for an exit', async () => {
    const failures = [
      [{ code: 'exit', exitCode: '2' }, 'Removing the files on prod-1 failed with exit code 2.'],
      [{ code: 'keyFile' }, 'The Damocles server files on prod-1 were removed, but the file holding the key Damocles installed could not be read or rewritten, so the key is still there.'],
      [{ code: 'killed' }, 'Removing the files on prod-1 was stopped before it finished.'],
    ] as const;
    for (const [params, text] of failures) {
      vi.mocked(api.removeServer).mockImplementationOnce(async () => removalEnds({ ok: false, code: 'stageFailed', params }));
      const wrapper = await openRemoteHosts();
      buttonNamed('Remove Damocles server...')!.click();
      await flushPromises();
      buttonNamed('Remove server', $('[data-testid="remove-server-dialog"]')!)!.click();
      await flushPromises();
      const result = $('[data-testid="remove-server-result"]')!;
      expect(result.getAttribute('role')).toBe('alert');
      expect(result.textContent).toContain(text);
      expect($('[data-testid="remove-server-retry"]')).toBeNull();
      mounted.splice(mounted.indexOf(wrapper), 1);
      wrapper.unmount();
    }
  });

  it('has an en and el text for every stageFailed code', () => {
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      for (const code of STAGE_FAILED_CODES) expect(shellI18n.global.te(`remote.removeServer.stageFailed.${code}`), `${locale} ${code}`).toBe(true);
      expect(shellI18n.global.te('remote.removeServer.retry'), locale).toBe(true);
    }
    shellI18n.global.locale.value = 'en';
  });

  it('offers Try again after daemonRunning, which runs the removal again without a connection', async () => {
    vi.mocked(api.removeServer).mockImplementationOnce(async () => removalEnds({ ok: false, code: 'daemonRunning', params: {} }));
    vi.mocked(api.retryRemoval).mockClear();
    vi.mocked(api.retryRemoval).mockImplementationOnce(async () => removalEnds({ ok: true, notices: [] }));
    await openRemoteHosts();
    buttonNamed('Remove Damocles server...')!.click();
    await flushPromises();
    buttonNamed('Remove server', $('[data-testid="remove-server-dialog"]')!)!.click();
    await flushPromises();
    expect($('[data-testid="remove-server-result"]')!.textContent).toContain('Damocles was still running on prod-1, so nothing was removed.');
    $<HTMLElement>('[data-testid="remove-server-retry"]')!.click();
    await flushPromises();
    expect(api.retryRemoval).toHaveBeenCalledWith('h1');
    expect($('[data-testid="remove-server-result"]')!.textContent).toContain('Removed the Damocles server from prod-1.');
    expect($('[data-testid="remove-server-retry"]')).toBeNull();
  });

  it("asks the secret the removal stage's ssh waits on, and answers it through the connect channel", async () => {
    let finish!: (answer: PopupAnswer<RemoveServerResult>) => void;
    vi.mocked(api.removeServer).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    vi.mocked(api.answerConnect).mockClear();
    const wrapper = await openRemoteHosts();
    buttonNamed('Remove Damocles server...')!.click();
    await flushPromises();
    buttonNamed('Remove server', $('[data-testid="remove-server-dialog"]')!)!.click();
    await flushPromises();
    api.pushHostOperations({ hostId: 'h1', removal: { prompt: { attemptId: 'a9', promptId: 'p9', kind: 'secret', secretKind: 'password', text: "deploy@prod-1's password:" } } });
    await flushPromises();
    const field = block().querySelector<HTMLInputElement>('[data-testid="secret-prompt"] input[aria-label="Password"]')!;
    expect(document.activeElement).toBe(field);
    await wrapper.get('[data-testid="secret-prompt"] input').setValue('hunter2');
    await wrapper.get('[data-testid="secret-prompt"]').trigger('submit');
    await flushPromises();
    expect(api.answerConnect).toHaveBeenCalledWith('a9', 'p9', 'hunter2', false);
    expect(block().querySelector('[data-testid="secret-prompt"]')).toBeNull();
    finish(removalEnds({ ok: true, notices: [] }));
    await flushPromises();
  });

  it("cancels the secret the removal stage's ssh waits on by answering it with nothing", async () => {
    let finish!: (answer: PopupAnswer<RemoveServerResult>) => void;
    vi.mocked(api.removeServer).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    vi.mocked(api.answerConnect).mockClear();
    await openRemoteHosts();
    buttonNamed('Remove Damocles server...')!.click();
    await flushPromises();
    buttonNamed('Remove server', $('[data-testid="remove-server-dialog"]')!)!.click();
    await flushPromises();
    api.pushHostOperations({ hostId: 'h1', removal: { prompt: { attemptId: 'a9', promptId: 'p9', kind: 'secret', secretKind: 'password', text: "deploy@prod-1's password:" } } });
    await flushPromises();
    block().querySelector<HTMLElement>('[data-testid="secret-prompt"] [data-testid="secret-cancel"]')!.click();
    await flushPromises();
    expect(api.answerConnect).toHaveBeenCalledWith('a9', 'p9', null, false);
    expect(block().querySelector('[data-testid="secret-prompt"]')).toBeNull();
    finish(removalEnds({ ok: false, code: 'stageFailed', params: { code: 'exit', exitCode: '255' } }));
    await flushPromises();
  });

  it('offers the removal first when forgetting a reachable host, then forgets it', async () => {
    await openRemoteHosts();
    buttonNamed('Forget host', block())!.click();
    await flushPromises();
    const dialog = $('[data-testid="forget-host-dialog"]')!;
    buttonNamed('Remove the server first...', dialog)!.click();
    await flushPromises();
    buttonNamed('Remove server', $('[data-testid="remove-server-dialog"]')!)!.click();
    await flushPromises();
    expect(api.removeServer).toHaveBeenCalled();
    expect(api.forgetHost).toHaveBeenCalledWith('h1');
  });

  it('says Forget host also forgets the containers of an SSH host that container records run on', async () => {
    api.remoteHosts.list = [PROD, WIN, { ...WIN, hostId: 'c1', kind: 'container', authorityKey: 'container+c1', name: 'api-shell', container: { origin: 'attach', state: 'running', engine: 'docker', containerName: 'api', user: 'root', via: { hostId: 'h2', name: 'win-box' } } }];
    await openRemoteHosts('h2');
    buttonNamed('Forget host', block())!.click();
    await flushPromises();
    expect($('[data-testid="forget-host-dialog"]')!.textContent).toContain('every container opened through it');
  });

  it('forgets an unreachable host without offering the removal', async () => {
    await openRemoteHosts('h2');
    buttonNamed('Forget host', block())!.click();
    await flushPromises();
    const dialog = $('[data-testid="forget-host-dialog"]')!;
    expect(buttonNamed('Remove the server first...', dialog)).toBeUndefined();
    // no container record runs on win-box, so none is named
    expect(dialog.textContent).not.toContain('every container opened through it');
    buttonNamed('Forget host', dialog)!.click();
    await flushPromises();
    expect(api.forgetHost).toHaveBeenCalledWith('h2');
    expect(api.removeServer).not.toHaveBeenCalled();
  });

  it('sets up passwordless login in three steps, each ending with a check', async () => {
    let finish!: (answer: PopupAnswer<PasswordlessResult>) => void;
    vi.mocked(api.setUpPasswordless).mockImplementationOnce(() => {
      api.pushHostOperations({ hostId: 'h1', passwordless: { steps: { generate: 'pending', install: 'pending', verify: 'pending' } } });
      return new Promise((resolve) => (finish = resolve));
    });
    await openRemoteHosts();
    buttonNamed('Set up passwordless login')!.click();
    await flushPromises();
    expect(stepStates()).toEqual(['pending', 'pending', 'pending']);
    expect(buttonNamed('Set up passwordless login')).toBeUndefined();
    api.pushHostOperations({ hostId: 'h1', passwordless: { steps: { generate: 'done', install: 'done', verify: 'done' } } });
    api.pushHostOperations({ hostId: 'h2', passwordless: { steps: { generate: 'failed', install: 'pending', verify: 'pending' } } });
    await flushPromises();
    expect(stepStates()).toEqual(['done', 'done', 'done']);
    expect(document.querySelectorAll('[data-testid="passwordless-step"] svg.animate-\\[d-icon-in_\\.3s_var\\(--ease-spring\\)\\]')).toHaveLength(3);
    expect(document.querySelector('[data-testid="passwordless-step"][data-step="install"]')!.textContent).toContain('Add it to ~/.ssh/authorized_keys on prod-1');
    // main records the key and pushes the host before it answers; the finished steps stay
    api.hostEntries([{ ...PROD, facts: { ...PROD.facts, passwordless: true } }, WIN]);
    finish(setupEnds({ steps: { generate: 'done', install: 'done', verify: 'done' }, result: { ok: true } }));
    await flushPromises();
    expect(stepStates()).toEqual(['done', 'done', 'done']);
    expect($('[data-testid="passwordless-done"]')!.textContent).toContain('Passwordless login works on prod-1.');
    expect(buttonNamed('Set up passwordless login')).toBeUndefined();
  });

  it('marks the step a passwordless setup failed at and names the file from main\'s code', async () => {
    vi.mocked(api.setUpPasswordless).mockImplementationOnce(async () => setupEnds({ steps: { generate: 'done', install: 'failed', verify: 'pending' }, result: { ok: false, step: 'install', code: 'ownership', params: { path: '/home/deploy/.ssh' } } }));
    await openRemoteHosts();
    buttonNamed('Set up passwordless login')!.click();
    await flushPromises();
    expect(document.querySelector<HTMLElement>('[data-testid="passwordless-step"][data-step="install"]')!.dataset.state).toBe('failed');
    expect($('[data-testid="passwordless-failure"]')!.textContent).toContain('/home/deploy/.ssh on prod-1 belongs to another user');
  });

  it('shows the steps of a setup main runs when the page opens mid-run, with no second start offered', async () => {
    api.pushHostOperations({ hostId: 'h1', passwordless: { steps: { generate: 'done', install: 'running', verify: 'pending' } } });
    await openRemoteHosts();
    expect(api.getHostOperations).toHaveBeenCalledWith('h1');
    expect(stepStates()).toEqual(['done', 'running', 'pending']);
    expect(buttonNamed('Set up passwordless login')).toBeUndefined();
  });

  it('keeps a setup\'s steps across a reattach that remounts the page, and takes only a newer snapshot', async () => {
    await openRemoteHosts();
    api.pushHostOperations({ hostId: 'h1', passwordless: { steps: { generate: 'done', install: 'running', verify: 'pending' } } });
    await flushPromises();
    // a remote core attaching mid-setup remounts the section, which reads main's snapshot again
    api.settingsAttached(2);
    await flushPromises();
    expect(vi.mocked(api.getHostOperations).mock.calls.filter(([hostId]) => hostId === 'h1').length).toBeGreaterThanOrEqual(2);
    expect(stepStates()).toEqual(['done', 'running', 'pending']);
    api.pushHostOperations({ hostId: 'h1', passwordless: { steps: { generate: 'done', install: 'done', verify: 'done' }, result: { ok: true } } });
    api.pushHostOperations({ hostId: 'h1', revision: 1, passwordless: { steps: { generate: 'running', install: 'pending', verify: 'pending' } } });
    await flushPromises();
    expect(stepStates()).toEqual(['done', 'done', 'done']);
    api.settingsAttached(3);
    await flushPromises();
    expect(stepStates()).toEqual(['done', 'done', 'done']);
    expect($('[data-testid="passwordless-done"]')!.textContent).toContain('Passwordless login works on prod-1.');
  });

  it('shows a removal main runs, and its result once it ended, on a page opened after it started', async () => {
    api.pushHostOperations({ hostId: 'h1', removal: {} });
    const wrapper = await openRemoteHosts();
    expect($('[data-testid="remove-server-progress"]')!.textContent).toContain('prod-1');
    expect(buttonNamed('Remove Damocles server...')!.hasAttribute('disabled')).toBe(true);
    mounted.splice(mounted.indexOf(wrapper), 1);
    wrapper.unmount();
    api.pushHostOperations({ hostId: 'h1', removal: { result: { ok: false, code: 'daemonRunning', params: {} } } });
    await openRemoteHosts();
    expect($('[data-testid="remove-server-progress"]')).toBeNull();
    expect($('[data-testid="remove-server-result"]')!.textContent).toContain('Damocles was still running on prod-1, so nothing was removed.');
    expect($('[data-testid="remove-server-retry"]')).not.toBeNull();
  });
});

// sample data
const READY: HostDefaultsView = {
  state: 'ready',
  servers: [
    { serverId: 'indigital', server: 'gitlab.indigital.gr', kind: 'gitlab', gitHosts: ['gitlab.indigital.gr'], accounts: [{ id: 'indigital|1', login: 'astefanopoulos' }, { id: 'indigital|2', login: 'astef-admin' }], defaultAccountId: 'indigital|1' },
    { serverId: 'gitlab.com', server: 'gitlab.com', kind: 'gitlab', gitHosts: ['gitlab.com'], accounts: [{ id: 'gitlab.com|1', login: 'alexios-s' }, { id: 'gitlab.com|2', login: 'work-alexios' }] },
  ],
};
const defaultsBlock = (): HTMLElement => $('[data-testid="forge-defaults"]')!;
// SettingSelect is generic, so its wrapper and props are typed by hand
const propsOf = (select: VueWrapper): Record<string, unknown> => select.props() as Record<string, unknown>;
const serverSelect = (wrapper: VueWrapper, server: string): VueWrapper => (wrapper.findAllComponents(SettingSelect as Component) as VueWrapper[]).find((select) => propsOf(select)['label'] === `Default account on ${server}`)!;

describe('Settings, Remote hosts, Default accounts', () => {
  beforeEach(() => {
    api.forge.defaults.clear();
    vi.mocked(api.forgeHostDefaults).mockClear();
    vi.mocked(api.setForgeHostDefault).mockReset().mockResolvedValue(opened(true));
    vi.mocked(api.openForgeAccounts).mockClear();
    api.remoteHosts.list = [{ ...PROD, facts: { ...PROD.facts, alwaysCredentialHosts: ['gitlab.indigital.gr', 'bitbucket.org'] } }, WIN];
  });

  it('shows a skeleton shaped like a server line, declared loading, until core publishes the accounts', async () => {
    await openRemoteHosts();
    expect(defaultsBlock().dataset.state).toBe('loading');
    const skeleton = $('[data-testid="forge-defaults-loading"]')!;
    expect(skeleton.getAttribute('role')).toBe('status');
    expect(skeleton.getAttribute('aria-busy')).toBe('true');
    expect(skeleton.getAttribute('aria-label')).toBe('Loading accounts');
    api.forge.defaults.set('ssh+h1', READY);
    api.forgeChanged({});
    await flushPromises();
    expect($('[data-testid="forge-defaults-loading"]')).toBeNull();
    expect(defaultsBlock().dataset.state).toBe('ready');
  });

  it('names the host, offers No default then each account per server, and names the default on the consent row', async () => {
    api.forge.defaults.set('ssh+h1', READY);
    const wrapper = await openRemoteHosts();
    expect(block().textContent).toContain('Default accounts on prod-1');
    const indigital = serverSelect(wrapper, 'gitlab.indigital.gr');
    expect(propsOf(indigital)['modelValue']).toBe('indigital|1');
    expect((propsOf(indigital)['options'] as readonly { label: string }[]).map((option) => option.label)).toEqual(['No default', 'astefanopoulos', 'astef-admin']);
    expect(propsOf(serverSelect(wrapper, 'gitlab.com'))['modelValue']).toBe('none');
    expect(defaultsBlock().querySelectorAll('[data-testid="forge-default-server"] svg[data-forge-mark="gitlab"]')).toHaveLength(2);
    const consent = [...block().querySelectorAll<HTMLElement>('[data-testid="credential-host"]')];
    expect(consent[0]!.querySelector('[data-testid="credential-host-default"]')!.textContent).toBe('as astefanopoulos, the default');
    expect(consent[1]!.querySelector('[data-testid="credential-host-default"]')).toBeNull();
  });

  it('saves a pick at once, says Saved, and the consent row names the new default', async () => {
    api.forge.defaults.set('ssh+h1', READY);
    const wrapper = await openRemoteHosts();
    serverSelect(wrapper, 'gitlab.indigital.gr').vm.$emit('update:modelValue', 'indigital|2');
    await flushPromises();
    expect(api.setForgeHostDefault).toHaveBeenCalledWith('ssh+h1', 'indigital', 'indigital|2');
    expect(defaultsBlock().textContent).toContain('Saved');
    expect(block().querySelector('[data-testid="credential-host-default"]')!.textContent).toBe('as astef-admin, the default');
    serverSelect(wrapper, 'gitlab.com').vm.$emit('update:modelValue', 'none');
    await flushPromises();
    expect(api.setForgeHostDefault).toHaveBeenLastCalledWith('ssh+h1', 'gitlab.com', null);
  });

  it('lists an account the host may always use apart from the credential hosts, by its login, and revokes only that account', async () => {
    api.forge.defaults.set('ssh+h1', READY);
    api.remoteHosts.list = [{ ...PROD, facts: { ...PROD.facts, alwaysCredentialHosts: ['gitlab.indigital.gr'], alwaysForgeAccounts: [{ serverId: 'gitlab.com', accountId: 'gitlab.com|2' }] } }, WIN];
    vi.mocked(api.revokeForgeAccount).mockClear();
    await openRemoteHosts();
    const row = block().querySelector<HTMLElement>('[data-testid="credential-account"]')!;
    expect(row.textContent?.replace(/\s+/g, ' ').trim()).toContain('work-alexios on gitlab.com');
    const revoke = row.querySelector<HTMLElement>('[data-testid="credential-account-revoke"]')!;
    expect(revoke.getAttribute('aria-label')).toBe('Revoke work-alexios on gitlab.com');
    revoke.click();
    await flushPromises();
    expect(api.revokeForgeAccount).toHaveBeenCalledWith('h1', { serverId: 'gitlab.com', accountId: 'gitlab.com|2' });
    expect(api.revokeCredentialHost).not.toHaveBeenCalled();
  });

  it('reverts a pick main did not save and says so in an alert', async () => {
    api.forge.defaults.set('ssh+h1', READY);
    vi.mocked(api.setForgeHostDefault).mockResolvedValue(opened(false));
    const wrapper = await openRemoteHosts();
    serverSelect(wrapper, 'gitlab.indigital.gr').vm.$emit('update:modelValue', 'indigital|2');
    await flushPromises();
    expect(propsOf(serverSelect(wrapper, 'gitlab.indigital.gr'))['modelValue']).toBe('indigital|1');
    expect([...block().querySelectorAll('[role="alert"]')].map((alert) => alert.textContent?.trim())).toContain('The setting could not be saved.');
  });

  it('says there is no account yet and opens Accounts', async () => {
    api.forge.defaults.set('ssh+h1', { state: 'ready', servers: [] });
    await openRemoteHosts();
    expect(defaultsBlock().textContent).toContain('You have no GitHub or GitLab account on this computer yet.');
    buttonNamed('Open Accounts', defaultsBlock())!.click();
    await flushPromises();
    expect(api.openForgeAccounts).toHaveBeenCalledWith({});
  });

  it('logs a refusal to open Accounts rather than leaving it unhandled', async () => {
    api.forge.defaults.set('ssh+h1', { state: 'ready', servers: [] });
    const refusal = new Error('Malformed forge.openAccounts call');
    vi.mocked(api.openForgeAccounts).mockRejectedValueOnce(refusal);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await openRemoteHosts();
    buttonNamed('Open Accounts', defaultsBlock())!.click();
    await flushPromises();
    expect(logged).toHaveBeenCalledWith('[remote hosts] main refused to open Git hosting settings', refusal);
    logged.mockRestore();
  });

  it('says core could not read the accounts, with Try again', async () => {
    api.forge.defaults.set('ssh+h1', { state: 'error' });
    await openRemoteHosts();
    expect(defaultsBlock().dataset.state).toBe('error');
    expect(defaultsBlock().querySelector('[role="alert"]')!.textContent).toContain('Damocles could not read your GitHub and GitLab accounts.');
    api.forge.defaults.set('ssh+h1', READY);
    buttonNamed('Try again', defaultsBlock())!.click();
    await flushPromises();
    expect(defaultsBlock().dataset.state).toBe('ready');
  });

  it('reads the defaults of the host picked in the host switcher', async () => {
    api.forge.defaults.set('ssh+h1', READY);
    api.forge.defaults.set('ssh+h2', { state: 'ready', servers: [] });
    await openRemoteHosts();
    [...document.querySelectorAll<HTMLElement>('[data-testid="remote-host-pick"]')].find((pick) => pick.dataset.hostId === 'h2')!.click();
    await flushPromises();
    expect(api.forgeHostDefaults).toHaveBeenLastCalledWith('ssh+h2');
    expect(block().textContent).toContain('Default accounts on win-box');
    expect(defaultsBlock().textContent).toContain('You have no GitHub or GitLab account on this computer yet.');
  });
});
