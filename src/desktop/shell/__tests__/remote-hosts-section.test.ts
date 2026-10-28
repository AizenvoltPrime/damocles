// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { installPlatformBridge } from '@/composables/usePlatformBridge';
import { STAGE_FAILED_CODES, type PasswordlessResult, type PopupAnswer, type RemoteHostEntry, type RemoveServerResult } from '../../preload/overlay-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { addSettingsMessages } from '../overlay/settings/settings-messages';
import { shellI18n } from '../i18n';
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
  authorityKey: 'ssh+h1',
  name: 'prod-1',
  destinationLabel: 'deploy@prod-1',
  os: 'linux',
  detectedOs: 'linux',
  connection: 'connected',
  settings: { allowBypass: false, forwardAgent: false, rememberPassword: false, browserLocalNetwork: false, openLinksWithoutAsking: false },
  facts: { passwordless: false, keyInstalledByDamocles: true, lingerEnabledByDamocles: false, alwaysCredentialHosts: ['github.com'] },
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

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  document.documentElement.setAttribute('data-reduced-motion', '');
  api.remoteHosts.list = [PROD, WIN];
  vi.mocked(api.setHostSetting).mockReset().mockResolvedValue(opened(undefined));
  vi.mocked(api.revokeCredentialHost).mockClear();
  vi.mocked(api.renameHost).mockClear();
  vi.mocked(api.removalInfo).mockClear();
  vi.mocked(api.removeServer).mockClear();
  vi.mocked(api.forgetHost).mockClear();
  vi.mocked(api.setUpPasswordless).mockClear();
  vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'win32', remoteEnabled: true });
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
  });

  it('is a section only while remote development is on', async () => {
    vi.mocked(api.getState).mockResolvedValue({ locale: 'en', platform: 'win32', remoteEnabled: false });
    await openRemoteHosts();
    expect($('[data-testid="settings-nav-remoteHosts"]')).toBeNull();
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
    expect(swatches.map((swatch) => swatch.dataset.tone)).toEqual(['none', 'accent', 'success', 'warning', 'danger', 'info']);
    expect(swatches.map((swatch) => swatch.getAttribute('tabindex'))).toEqual(['0', '-1', '-1', '-1', '-1', '-1']);
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
    vi.mocked(api.removeServer).mockResolvedValueOnce(opened({ ok: true, notices: [{ code: 'versionKept', params: { version: '3.7.0', machine: 'LAPTOP' } }] }));
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
      vi.mocked(api.removeServer).mockResolvedValueOnce(opened({ ok: false, code: 'stageFailed', params }));
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
    vi.mocked(api.removeServer).mockResolvedValueOnce(opened({ ok: false, code: 'daemonRunning', params: {} }));
    vi.mocked(api.retryRemoval).mockClear();
    vi.mocked(api.retryRemoval).mockResolvedValueOnce(opened({ ok: true, notices: [] }));
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
    api.connectStep({ attemptId: 'a9', hostId: 'h1', step: 'authenticating', visited: ['connecting', 'authenticating'], notices: [], prompt: { promptId: 'p9', kind: 'secret', secretKind: 'password', text: "deploy@prod-1's password:" } });
    await flushPromises();
    const field = block().querySelector<HTMLInputElement>('[data-testid="secret-prompt"] input[aria-label="Password"]')!;
    expect(document.activeElement).toBe(field);
    await wrapper.get('[data-testid="secret-prompt"] input').setValue('hunter2');
    await wrapper.get('[data-testid="secret-prompt"]').trigger('submit');
    await flushPromises();
    expect(api.answerConnect).toHaveBeenCalledWith('a9', 'p9', 'hunter2', false);
    expect(block().querySelector('[data-testid="secret-prompt"]')).toBeNull();
    finish(opened({ ok: true, notices: [] }));
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
    api.connectStep({ attemptId: 'a9', hostId: 'h1', step: 'authenticating', visited: ['connecting', 'authenticating'], notices: [], prompt: { promptId: 'p9', kind: 'secret', secretKind: 'password', text: "deploy@prod-1's password:" } });
    await flushPromises();
    block().querySelector<HTMLElement>('[data-testid="secret-prompt"] [data-testid="secret-cancel"]')!.click();
    await flushPromises();
    expect(api.answerConnect).toHaveBeenCalledWith('a9', 'p9', null, false);
    expect(block().querySelector('[data-testid="secret-prompt"]')).toBeNull();
    finish(opened({ ok: false, code: 'stageFailed', params: { code: 'exit', exitCode: '255' } }));
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

  it('forgets an unreachable host without offering the removal', async () => {
    await openRemoteHosts('h2');
    buttonNamed('Forget host', block())!.click();
    await flushPromises();
    const dialog = $('[data-testid="forget-host-dialog"]')!;
    expect(buttonNamed('Remove the server first...', dialog)).toBeUndefined();
    buttonNamed('Forget host', dialog)!.click();
    await flushPromises();
    expect(api.forgetHost).toHaveBeenCalledWith('h2');
    expect(api.removeServer).not.toHaveBeenCalled();
  });

  it('sets up passwordless login in three steps, each ending with a check', async () => {
    let finish!: (answer: PopupAnswer<PasswordlessResult>) => void;
    vi.mocked(api.setUpPasswordless).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    await openRemoteHosts();
    buttonNamed('Set up passwordless login')!.click();
    await flushPromises();
    const state = (): (string | undefined)[] => [...document.querySelectorAll<HTMLElement>('[data-testid="passwordless-step"]')].map((step) => step.dataset.state);
    expect(state()).toEqual(['pending', 'pending', 'pending']);
    for (const step of ['generate', 'install', 'verify'] as const) {
      api.passwordlessStep({ hostId: 'h1', step, state: 'running' });
      api.passwordlessStep({ hostId: 'h1', step, state: 'done' });
    }
    api.passwordlessStep({ hostId: 'h2', step: 'generate', state: 'failed' });
    await flushPromises();
    expect(state()).toEqual(['done', 'done', 'done']);
    expect(document.querySelectorAll('[data-testid="passwordless-step"] svg.animate-\\[d-icon-in_\\.3s_var\\(--ease-spring\\)\\]')).toHaveLength(3);
    expect(document.querySelector('[data-testid="passwordless-step"][data-step="install"]')!.textContent).toContain('Add it to ~/.ssh/authorized_keys on prod-1');
    // main records the key and pushes the host before it answers; the finished steps stay
    api.hostEntries([{ ...PROD, facts: { ...PROD.facts, passwordless: true } }, WIN]);
    finish(opened({ ok: true }));
    await flushPromises();
    expect(state()).toEqual(['done', 'done', 'done']);
    expect($('[data-testid="passwordless-done"]')!.textContent).toContain('Passwordless login works on prod-1.');
    expect(buttonNamed('Set up passwordless login')).toBeUndefined();
  });

  it('marks the step a passwordless setup failed at and names the file from main\'s code', async () => {
    vi.mocked(api.setUpPasswordless).mockResolvedValueOnce(opened({ ok: false, step: 'install', code: 'ownership', params: { path: '/home/deploy/.ssh' } }));
    await openRemoteHosts();
    buttonNamed('Set up passwordless login')!.click();
    await flushPromises();
    expect(document.querySelector<HTMLElement>('[data-testid="passwordless-step"][data-step="install"]')!.dataset.state).toBe('failed');
    expect($('[data-testid="passwordless-failure"]')!.textContent).toContain('/home/deploy/.ssh on prod-1 belongs to another user');
  });
});
