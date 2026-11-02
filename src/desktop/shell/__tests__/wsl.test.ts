// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { ConnectStepEvent, HostCardInfo, OverlayRequest, PopupAnswer, WslConversionRun, WslDistroInfo } from '../../preload/overlay-channels';
import type { ShellProject, ShellProjectGroups } from '../../preload/shell-channels';
import type { PortRow, PortsView } from '../../preload/ports-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import StepTimeline from '../overlay/components/StepTimeline.vue';
import WslConversion from '../overlay/components/WslConversion.vue';
import ContextMenu from '../overlay/components/ContextMenu.vue';
import ProjectsSection from '../components/ProjectsSection.vue';
import FilesSection from '../components/FilesSection.vue';
import PortsSection from '../components/PortsSection.vue';
import { portActions, portDotShape, portMenu } from '../components/ports-section';
import { distroHint, offersReopenInWsl, wslNoticeDistro } from '../components/wsl-reopen';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { failureText } from '../overlay/connect-text';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { shellI18n } from '../i18n';
import en from '../locales/en.json';
import el from '../locales/el.json';
import { FakeResizeObserver, STATE, contentName, fakeOverlayApi, fakePortsApi, fakeShellApi, opened, type FakeOverlayApi, type FakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];
const track = <T extends VueWrapper>(wrapper: T): T => {
  mounted.push(wrapper);
  return wrapper;
};
const t = (key: string, values?: Record<string, unknown>): string => shellI18n.global.t(key, values ?? {});

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

const UBUNTU: WslDistroInfo = { distro: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: true };
const LEGACY: WslDistroInfo = { distro: 'damocles-e2e-wsl1', state: 'stopped', version: 1, isDefault: false };
const SAVED: HostCardInfo = {
  hostId: 'w1',
  kind: 'wsl',
  name: 'ml-box',
  destinationLabel: 'Ubuntu-24.04',
  wsl: { distro: 'Ubuntu-24.04', version: 2, state: 'running', isDefault: true },
  connection: 'connected',
  signInNeeded: false,
  recentFolders: [],
  projectFolders: [],
  notices: [],
  allowBypass: false,
  passwordless: false,
  keyInstalledByDamocles: false,
  lingerEnabledByDamocles: false,
};
const LEGACY_HOST: HostCardInfo = { ...SAVED, hostId: 'w2', name: 'legacy', destinationLabel: LEGACY.distro, wsl: { distro: LEGACY.distro, version: 1, state: 'stopped', isDefault: false }, connection: 'offline' };

describe('Connect dialog distro cards', () => {
  let api: FakeOverlayApi;
  beforeEach(() => {
    api = fakeOverlayApi();
  });

  async function openConnect(request: Partial<Extract<OverlayRequest, { kind: 'connect' }>> = {}): Promise<void> {
    track(mount(OverlayApp, {
      props: { api, settingsBridge: createOverlaySettingsBridge(api) },
      global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    }));
    await flushPromises();
    api.request('c1', { kind: 'connect', hosts: [], distros: [UBUNTU, LEGACY], sshConfigAliases: [], ...request });
    await flushPromises();
    await flushPromises();
  }
  const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"]')!;
  const card = (distro: string): HTMLElement | null => dialog().querySelector<HTMLElement>(`[data-testid="distro-card"][data-distro="${distro}"]`);
  const pressPointer = async (element: HTMLElement): Promise<void> => {
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
    element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
    element.click();
    await flushPromises();
  };

  it('lists each distro with its icon, a state dot of its own shape, the default marker and a WSL 1 chip', async () => {
    await openConnect();
    const group = dialog().querySelector<HTMLElement>('[data-testid="distro-cards"]')!;
    expect(group.getAttribute('role')).toBe('group');
    expect(group.getAttribute('aria-label')).toBe('WSL');
    const ubuntu = card('Ubuntu-24.04')!;
    const legacy = card('damocles-e2e-wsl1')!;
    expect(contentName(ubuntu)).toBe('Ubuntu-24.04 Default WSL 2 · Running');
    expect(contentName(legacy)).toBe('damocles-e2e-wsl1 WSL 1 Stopped');
    expect(ubuntu.querySelector('[data-testid="distro-default"]')?.textContent?.trim()).toBe('Default');
    // named by their content, which axe's label-content-name-mismatch cannot fault; the dot is aria-hidden beside the state in words
    for (const element of [ubuntu, legacy]) expect(element.hasAttribute('aria-label')).toBe(false);
    expect(ubuntu.querySelector('[data-testid="distro-wsl1"]')).toBeNull();
    expect(legacy.querySelector('[data-testid="distro-default"]')).toBeNull();
    expect(legacy.querySelector('[data-testid="distro-wsl1"]')?.textContent?.trim()).toBe('WSL 1');
    const dot = (element: HTMLElement) => element.querySelector<HTMLElement>('[data-testid="distro-state-dot"]')!;
    expect([dot(ubuntu).dataset.state, dot(legacy).dataset.state]).toEqual(['running', 'stopped']);
    expect(dot(ubuntu).getAttribute('role')).toBe('img');
    expect(dot(ubuntu).getAttribute('aria-label')).toBe('Running');
    // a disc runs and a ring is stopped, so the state never rests on color alone
    expect(dot(ubuntu).querySelector('circle')!.getAttribute('fill')).toBe('currentColor');
    expect(dot(legacy).querySelector('circle')!.getAttribute('fill')).toBe('none');
    // the cards enter as host cards do, staggered after the saved hosts and aliases
    expect(ubuntu.closest<HTMLElement>('.host-card')!.style.getPropertyValue('--card-index')).toBe('0');
    expect(legacy.closest<HTMLElement>('.host-card')!.style.getPropertyValue('--card-index')).toBe('1');
  });

  it('hides the WSL section without distros and follows the distros main pushes', async () => {
    await openConnect({ distros: [] });
    expect(dialog().querySelector('[data-testid="distro-cards"]')).toBeNull();
    api.connectDistros([LEGACY]);
    await flushPromises();
    expect([...dialog().querySelectorAll<HTMLElement>('[data-testid="distro-card"]')].map((element) => element.dataset.distro)).toEqual(['damocles-e2e-wsl1']);
  });

  it('names a new distro before saving it, prefilled with the distro name, and connects it under the accepted name', async () => {
    vi.mocked(api.checkHostName).mockImplementation(async (name: string) => opened(name.trim() === 'prod' ? { ok: false as const, reason: 'taken' as const, clashWith: 'prod' } : { ok: true as const, name: name.trim() }));
    await openConnect();
    card('damocles-e2e-wsl1')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('input[aria-label="Name"]')).not.toBeNull());
    expect(api.startConnect).not.toHaveBeenCalled();
    expect(dialog().textContent).toContain('Name this distro');
    const name = dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    expect(name.value).toBe('damocles-e2e-wsl1');
    name.value = 'prod';
    name.dispatchEvent(new Event('input'));
    await flushPromises();
    expect(dialog().querySelector('[role="alert"]')!.textContent).toBe('Another host is already called prod');
    name.value = 'old-alpine';
    name.dispatchEvent(new Event('input'));
    // main pushes the new attempt's first step before it answers the start
    vi.mocked(api.startConnect).mockImplementationOnce(async () => {
      api.connectStep({ attemptId: 'attempt-1', hostId: 'host-new', transport: 'wsl', step: 'connecting', visited: ['connecting'], notices: [] });
      return opened({ ok: true as const, attemptId: 'attempt-1', hostId: 'host-new' });
    });
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenCalledWith({ distro: 'damocles-e2e-wsl1', name: 'old-alpine' }));
    await vi.waitFor(() => expect(dialog().querySelector('[role="progressbar"]')).not.toBeNull());
    // a WSL attempt never authenticates
    expect([...dialog().querySelectorAll<HTMLElement>('li[data-step]')].map((row) => row.dataset.step)).toEqual(['connecting', 'checking', 'installing', 'starting']);
  });

  it('shows a saved distro by its host\'s name and connection, opens its card, and lists it only among the distros', async () => {
    await openConnect({ hosts: [SAVED], distros: [{ ...UBUNTU, hostId: 'w1' }, LEGACY] });
    const ubuntu = card('Ubuntu-24.04')!;
    expect(ubuntu.dataset.hostId).toBe('w1');
    expect(contentName(ubuntu)).toBe('ml-box Default Ubuntu-24.04 · WSL 2 · Connected');
    expect(ubuntu.querySelector('[data-testid="host-status-dot"]')?.getAttribute('data-connection')).toBe('connected');
    expect(dialog().querySelector('[data-testid="host-card-button"]')).toBeNull();
    // connected: straight to its folders, as a saved host
    ubuntu.click();
    await vi.waitFor(() => expect(api.browseHost).toHaveBeenCalledWith('w1', undefined));
    expect(api.startConnect).not.toHaveBeenCalled();
  });

  it('keeps a saved distro wsl.exe no longer lists among the saved hosts, so it can still be opened and forgotten', async () => {
    await openConnect({ hosts: [{ ...SAVED, connection: 'offline' }], distros: [LEGACY] });
    const saved = dialog().querySelector<HTMLElement>('[data-testid="host-card-button"]')!;
    expect(contentName(saved)).toBe('ml-box Ubuntu-24.04 Not connected');
    // still a distro, so drawn with the distro icon, not the server of an SSH host
    expect(saved.querySelector('.lucide-square-terminal')).not.toBeNull();
    expect(saved.querySelector('.lucide-server')).toBeNull();
  });

  it('connects a saved, offline distro through its host record', async () => {
    await openConnect({ hosts: [LEGACY_HOST], distros: [{ ...LEGACY, hostId: 'w2' }] });
    const legacy = card('damocles-e2e-wsl1')!;
    expect(contentName(legacy)).toBe('legacy WSL 1 damocles-e2e-wsl1 · Stopped');
    legacy.click();
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenCalledWith({ hostId: 'w2' }));
  });

  it('shows a WSL 1 host\'s polling note with Convert to WSL 2, hides sign-in and passwordless setup, and converts after the confirmation', async () => {
    vi.mocked(api.conversionInfo).mockResolvedValue(opened({ runs: [{ kind: 'chat', id: 'p1', title: 'Fix the tests', state: 'running' }, { kind: 'terminal', id: 't1', title: 'bash', state: 'background' }] }));
    let finish!: (answer: PopupAnswer<void>) => void;
    vi.mocked(api.convertToWsl2).mockImplementationOnce(() => {
      api.pushHostOperations({ hostId: 'w2', conversion: { steps: { stopping: 'running', converting: 'pending', reconnecting: 'pending' }, output: [] } });
      return new Promise((resolve) => (finish = resolve));
    });
    await openConnect({ hosts: [{ ...LEGACY_HOST, connection: 'connected' }], distros: [{ ...LEGACY, hostId: 'w2' }] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for legacy"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="host-wsl1-note"]')).not.toBeNull());
    expect(dialog().querySelector('[data-testid="host-wsl1-note"]')!.textContent).toContain('WSL 1: Damocles checks for file changes every 5 seconds, which uses more CPU in very large folders.');
    // the address line names the distro and its WSL version, as the mockup's card does
    expect(dialog().querySelector('[data-testid="host-card-destination"]')!.textContent).toBe('damocles-e2e-wsl1 · WSL 1');
    expect(dialog().querySelector('[data-testid="host-card-sign-in"]')).toBeNull();
    expect(dialog().querySelector('[data-testid="passwordless"]')).toBeNull();
    // the removal stage runs over ssh, so a WSL host offers no removal
    expect(dialog().querySelector('[data-testid="remove-server"]')).toBeNull();
    expect(dialog().querySelector('[data-testid="forget-host"]')).not.toBeNull();

    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="convert-wsl2"]')!);
    expect(api.conversionInfo).toHaveBeenCalledWith('w2');
    const confirm = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="convert-wsl2-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(confirm.textContent).toContain('Convert damocles-e2e-wsl1 to WSL 2?');
    expect([...confirm.querySelectorAll<HTMLElement>('[data-testid="convert-wsl2-run"]')].map((row) => [row.dataset.kind, ...[...row.querySelectorAll('span')].map((span) => span.textContent)])).toEqual([['chat', 'Fix the tests', 'agent'], ['terminal', 'bash', 'terminal']]);
    await vi.waitFor(() => expect(document.activeElement).toBe(confirm.querySelector('[data-testid="convert-wsl2-cancel"]')));
    await pressPointer(confirm.querySelector<HTMLElement>('[data-testid="convert-wsl2-confirm"]')!);
    expect(api.convertToWsl2).toHaveBeenCalledWith('w2');
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="convert-wsl2-progress"]')).not.toBeNull());
    expect(dialog().querySelector('[data-testid="convert-wsl2"]')).toBeNull();
    // the button the confirmation would return focus to is gone, so the steps take it
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog().querySelector('[data-testid="convert-wsl2-steps"]')));
    // a click beside the dialog never drops the card while the conversion runs
    const beside = document.body.appendChild(document.createElement('div'));
    await pressPointer(beside);
    expect(api.answer).not.toHaveBeenCalled();

    api.pushHostOperations({ hostId: 'w2', conversion: { steps: { stopping: 'done', converting: 'running', reconnecting: 'pending' }, output: ['Conversion in progress, this may take a few minutes.'] } });
    await flushPromises();
    const steps = () => [...dialog().querySelectorAll<HTMLElement>('[data-testid="convert-wsl2-step"]')].map((step) => [step.dataset.step, step.dataset.state]);
    expect(steps()).toEqual([['stopping', 'done'], ['converting', 'running'], ['reconnecting', 'pending']]);
    expect(dialog().querySelector('[data-testid="convert-wsl2-output"]')!.textContent).toContain('Conversion in progress');

    api.pushHostOperations({ hostId: 'w2', conversion: { steps: { stopping: 'done', converting: 'done', reconnecting: 'done' }, output: ['Conversion in progress, this may take a few minutes.', 'The operation completed successfully.'], result: { ok: true } } });
    finish(opened(undefined));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="convert-wsl2-done"]')!.textContent).toContain('legacy runs on WSL 2 now');
    await pressPointer(beside);
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('c1', { kind: 'dismissed' }));
  });

  it('converts only a connected distro, whose daemon lists the running work', async () => {
    await openConnect({ hosts: [LEGACY_HOST], distros: [{ ...LEGACY, hostId: 'w2' }] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for legacy"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="convert-wsl2"]')).not.toBeNull());
    const button = dialog().querySelector<HTMLButtonElement>('[data-testid="convert-wsl2"]')!;
    expect(button.disabled).toBe(true);
    // said as text, which keyboard and screen reader users reach as the button's description
    const reason = dialog().querySelector<HTMLElement>('[data-testid="convert-wsl2-needs-connection"]')!;
    expect(reason.textContent!.trim()).toBe('Connect to legacy to convert it.');
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('cancels the conversion at the confirmation without starting it', async () => {
    await openConnect({ hosts: [{ ...LEGACY_HOST, connection: 'connected' }], distros: [{ ...LEGACY, hostId: 'w2' }] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for legacy"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="convert-wsl2"]')).not.toBeNull());
    dialog().querySelector<HTMLElement>('[data-testid="convert-wsl2"]')!.focus();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="convert-wsl2"]')!);
    const confirm = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[data-testid="convert-wsl2-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(confirm.textContent).toContain('Nothing runs on legacy now.');
    const button = dialog().querySelector<HTMLElement>('[data-testid="convert-wsl2"]')!;
    expect(dialog().querySelector('[data-testid="convert-wsl2-needs-connection"]')).toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
    await pressPointer(confirm.querySelector<HTMLElement>('[data-testid="convert-wsl2-cancel"]')!);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="convert-wsl2-dialog"][data-state="open"]')).toBeNull());
    expect(api.convertToWsl2).not.toHaveBeenCalled();
    // a refusal leaves the button, where focus goes back
    await vi.waitFor(() => expect(document.activeElement).toBe(button));
  });

  it('shows a conversion main runs on a card opened mid-run, folds its wsl.exe tail by keyboard, and says a failure verbatim', async () => {
    const running: WslConversionRun = { steps: { stopping: 'done', converting: 'running', reconnecting: 'pending' }, output: ['Conversion in progress, this may take a few minutes.'] };
    api.pushHostOperations({ hostId: 'w2', conversion: running });
    await openConnect({ hosts: [LEGACY_HOST], distros: [{ ...LEGACY, hostId: 'w2' }] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for legacy"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelectorAll('[data-testid="convert-wsl2-step"]')).toHaveLength(3));
    expect(api.getHostOperations).toHaveBeenCalledWith('w2');
    expect(dialog().querySelector('[data-testid="convert-wsl2"]')).toBeNull();
    const toggle = dialog().querySelector<HTMLButtonElement>('[data-testid="convert-wsl2-output-toggle"]')!;
    expect(toggle.tagName).toBe('BUTTON');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent?.replace(/\s+/g, ' ').trim()).toBe('wsl.exe output · 1 line');
    const output = (): HTMLElement => dialog().querySelector<HTMLElement>('[data-testid="convert-wsl2-output"]')!;
    expect(toggle.getAttribute('aria-controls')).toBe(output().id);
    expect(output().style.display).toBe('');
    toggle.click();
    await flushPromises();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await vi.waitFor(() => expect(output().style.display).toBe('none'));
    toggle.click();
    await flushPromises();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    await vi.waitFor(() => expect(output().style.display).toBe(''));

    const message = 'Please enable the Virtual Machine Platform Windows feature and ensure virtualization is enabled in the BIOS.\nError code: Wsl/Service/CreateInstance/HCS_E_HYPERV_NOT_INSTALLED';
    api.pushHostOperations({ hostId: 'w2', conversion: { ...running, steps: { stopping: 'done', converting: 'failed', reconnecting: 'pending' }, result: { ok: false, code: 'setVersionFailed', message } } });
    await flushPromises();
    const failure = dialog().querySelector<HTMLElement>('[data-testid="convert-wsl2-failure"]')!;
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.dataset.code).toBe('setVersionFailed');
    expect(failure.textContent).toContain('wsl.exe could not convert damocles-e2e-wsl1, so it stays on WSL 1.');
    expect(failure.querySelector('[data-testid="convert-wsl2-message"]')!.textContent).toBe(message);
    // the distro stays on WSL 1, so the note and its button offer the conversion again
    expect(dialog().querySelector('[data-testid="convert-wsl2"]')).not.toBeNull();
  });

  it('tucks the WSL 1 note away when main says the distro runs WSL 2', async () => {
    api.pushHostOperations({ hostId: 'w2', conversion: { steps: { stopping: 'done', converting: 'done', reconnecting: 'done' }, output: [], result: { ok: true } } });
    const wrapper = track(mount(WslConversion, {
      props: { api, hostId: 'w2', hostName: 'legacy', distro: LEGACY.distro, version: 1, connected: true },
      global: { plugins: [shellI18n], stubs: { transition: false } },
      attachTo: document.body,
    }));
    await flushPromises();
    expect(wrapper.find('[data-testid="host-wsl1-note"]').exists()).toBe(true);
    await wrapper.setProps({ version: 2 });
    expect(wrapper.get('[data-testid="host-wsl1-note"]').classes()).toContain('t-tuck-leave-active');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="host-wsl1-note"]').exists()).toBe(false));
    expect(wrapper.find('[data-testid="convert-wsl2-done"]').exists()).toBe(true);
  });

  it('localizes every conversion failure main sends, in en and el', () => {
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      for (const code of ['setVersionFailed', 'shutdownFailed', 'reconnectFailed', 'call', 'info']) expect(shellI18n.global.te(`remote.wsl.failure.${code}`), `${locale} ${code}`).toBe(true);
      for (const code of ['notWindowsFolder', 'wslpathFailed', 'connectFailed', 'unknownDistro']) expect(shellI18n.global.te(`wsl.failure.${code}`), `${locale} ${code}`).toBe(true);
    }
    expect(Object.keys(el.wsl.failure).sort()).toEqual(Object.keys(en.wsl.failure).sort());
    shellI18n.global.locale.value = 'en';
    expect(failureText({ code: 'unknown', params: { reason: 'wslExited', exitCode: 1 } }, 'ml-box', t)).toBe('wsl.exe ended before Damocles started on ml-box (exit code 1). Show log has the details.');
  });
});

describe('WSL timeline', () => {
  const event = (patch: Partial<ConnectStepEvent>): ConnectStepEvent => ({ attemptId: 'a1', hostId: 'w1', transport: 'wsl', step: 'checking', visited: ['connecting', 'checking'], notices: [], ...patch });
  const mountTimeline = (value: ConnectStepEvent) => track(mount(StepTimeline, { props: { event: value, hostName: 'Ubuntu-24.04', otherDevices: 0, setInstallFolder: vi.fn(async () => ({ ok: true as const })) }, global: { plugins: [shellI18n] }, attachTo: document.body }));

  it('skips Authenticating, starts the distro where ssh connects, and counts only its own steps', () => {
    const wrapper = mountTimeline(event({}));
    expect(wrapper.findAll('li[data-step]').map((row) => [row.attributes('data-step'), row.attributes('data-state'), row.text()])).toEqual([
      ['connecting', 'done', 'Starting Ubuntu-24.04'],
      // the active step's spinner gives way to an ellipsis under reduced motion
      ['checking', 'active', '…Checking server'],
      ['installing', 'pending', 'Installing'],
      ['starting', 'pending', 'Starting'],
    ]);
    expect(wrapper.get('[role="progressbar"]').attributes()).toMatchObject({ 'aria-valuemax': '4', 'aria-valuenow': '1', 'aria-valuetext': 'Checking server' });
  });

  it('keeps Authenticating for ssh', () => {
    const wrapper = mountTimeline(event({ transport: 'ssh', visited: ['connecting', 'authenticating', 'checking'] }));
    expect(wrapper.findAll('li[data-step]').map((row) => row.attributes('data-step'))).toEqual(['connecting', 'authenticating', 'checking', 'installing', 'starting']);
    expect(wrapper.get('li[data-step="connecting"]').text()).toBe('Connecting');
  });

  it('names the distro start in the progressbar while it runs', () => {
    const wrapper = mountTimeline(event({ step: 'connecting', visited: ['connecting'] }));
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toBe('Starting Ubuntu-24.04');
  });
});

const LOCAL = { kind: 'local', key: 'local', name: 'This computer' } as const;
const project = (key: string, extra: Partial<ShellProject> = {}): ShellProject => ({ ...STATE.projects[0]!, key, name: key, fsPath: `C:\\work\\${key}`, authority: LOCAL, connection: 'connected', running: 0, waiting: 0, ...extra });
const UNC = project('app', { fsPath: '\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\app', wsl: { distro: 'Ubuntu-24.04', path: '/home/me/app' } });
const WINDOWS = project('site', { fsPath: 'C:\\work\\site' });
const REMOTE = project('api', { fsPath: '/srv/api', authority: { kind: 'ssh', key: 'ssh+h1', hostId: 'h1', name: 'prod-1' } });

describe('Reopen in WSL in Projects', () => {
  function mountSection(options: { projects?: readonly ShellProject[]; view?: 'flat' | 'grouped'; platform?: 'win32' | 'linux'; api?: FakeShellApi } = {}): { wrapper: VueWrapper; api: FakeShellApi } {
    const api = options.api ?? fakeShellApi();
    const projects = options.projects ?? [UNC, WINDOWS, REMOTE];
    const groups: ShellProjectGroups = { order: ['local', 'ssh+h1'], collapsed: [] };
    const wrapper = track(mount(ProjectsSection, {
      props: { api, projects, selectedKey: 'app', hosts: [], view: options.view ?? 'flat', groups, platform: options.platform ?? 'win32', collapsed: false, bodySize: 300 },
      global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    }));
    return { wrapper, api };
  }
  const menuIds = (api: FakeShellApi): string[] => {
    const request = api.overlayRequests.at(-1);
    return request?.kind === 'menu' ? request.items.flatMap((item) => (item.kind === 'item' ? [item.id] : [])) : [];
  };

  it('shows the notice under a WSL folder\'s row, outside its option, in both views', async () => {
    for (const view of ['flat', 'grouped'] as const) {
      const { wrapper } = mountSection({ view });
      const notices = wrapper.findAll('[data-testid="wsl-notice"]');
      expect(notices).toHaveLength(1);
      const notice = notices[0]!;
      expect(notice.attributes()).toMatchObject({ 'data-place': 'row', 'aria-hidden': 'true' });
      expect(notice.text()).toContain('This folder is in WSL (Ubuntu-24.04). Reopen in WSL to run its tools in Linux at full speed.');
      // the listbox may own only options and groups of options: the row's notice serves the pointer, and its text describes the
      // option; the keyboard reopens from the project's menu and from Files
      const option = wrapper.get('[role="option"][data-project-key="app"]');
      expect(option.findAll('button')).toHaveLength(0);
      expect(document.getElementById(option.attributes('aria-describedby')!)?.textContent?.trim()).toBe('This folder is in WSL (Ubuntu-24.04). Reopen in WSL to run its tools in Linux at full speed.');
      expect(notice.findAll('button').map((button) => button.attributes('tabindex'))).toEqual(['-1', '-1']);
      expect(wrapper.get('[role="option"][data-project-key="site"]').attributes('aria-describedby')).toBeUndefined();
      const unit = notice.element.parentElement!;
      expect(unit.getAttribute('role')).toBe('none');
      expect(unit.contains(option.element)).toBe(true);
      expect(unit.getAttribute('data-drag-id')).toBe('p:app');
      expect(unit.getAttribute('data-flip')).toBe('p:app');
      expect(option.attributes('data-flip')).toBeUndefined();
      expect(option.attributes('id')).toBe(wrapper.get('[role="listbox"]').attributes('aria-activedescendant'));
      // other rows stay plain options
      expect(wrapper.get('[role="option"][data-project-key="site"]').attributes('data-drag-id')).toBe('p:site');
      wrapper.unmount();
    }
  });

  it('lifts the row and its notice as one unit above the rows it passes while dragged, the option not lifting on its own', async () => {
    const { wrapper } = mountSection({ projects: [WINDOWS, UNC] });
    const unit = wrapper.get('[data-drag-id="p:app"]').element;
    const option = wrapper.get('[role="option"][data-project-key="app"]').element;
    const plain = wrapper.get('[role="option"][data-project-key="site"]').element;
    const boxes = new Map<Element, { top: number; height: number }>([[plain, { top: 0, height: 34 }], [unit, { top: 35, height: 80 }]]);
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const box = boxes.get(this) ?? { top: 0, height: 0 };
      return new DOMRect(0, box.top, 200, box.height);
    });
    vi.spyOn(Element.prototype, 'setPointerCapture').mockImplementation(() => {});
    const pointer = (type: string, clientY: number): PointerEvent => new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientY });

    option.dispatchEvent(pointer('pointerdown', 50));
    window.dispatchEvent(pointer('pointermove', 20));
    await flushPromises();
    const lift = ['data-dragging:relative', 'data-dragging:z-5', 'data-dragging:bg-(--d-card)', 'data-dragging:shadow-(--d-shadow)', 'data-dragging:ring-1', 'data-dragging:ring-(--d-accent)'];
    expect(unit.getAttribute('data-dragging')).toBe('true');
    expect([...unit.classList]).toEqual(expect.arrayContaining(lift));
    expect((unit as HTMLElement).style.transform).toContain('translateY(-30px)');
    expect([...option.classList].filter((name) => lift.includes(name))).toEqual([]);
    // a plain row lifts itself
    expect([...plain.classList]).toEqual(expect.arrayContaining(lift));
    window.dispatchEvent(pointer('pointercancel', 20));
  });

  it('shows no notice once dismissed or for a remote project', () => {
    expect(mountSection({ projects: [{ ...UNC, wslNoticeDismissed: true }] }).wrapper.find('[data-testid="wsl-notice"]').exists()).toBe(false);
    expect(wslNoticeDistro(UNC)).toBe('Ubuntu-24.04');
    expect(wslNoticeDistro({ ...UNC, authority: REMOTE.authority })).toBeUndefined();
  });

  it('reopens from the notice in its own distro and dismisses it per project, never selecting the row', async () => {
    const { wrapper, api } = mountSection();
    let finish!: (result: Awaited<ReturnType<FakeShellApi['reopenInWsl']>>) => void;
    vi.mocked(api.reopenInWsl).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    await wrapper.get('[data-testid="wsl-notice-reopen"]').trigger('click');
    expect(api.reopenInWsl).toHaveBeenCalledWith('app');
    expect(api.selectProject).not.toHaveBeenCalled();
    const button = wrapper.get<HTMLButtonElement>('[data-testid="wsl-notice-reopen"]');
    expect(button.element.disabled).toBe(true);
    await vi.waitFor(() => expect(button.text()).toBe('Reopening in Ubuntu-24.04…'));
    // the alert was mounted empty, outside the listbox and the aria-hidden notice, before the failure filled it
    const alert = document.querySelector<HTMLElement>('[data-testid="wsl-notice-failure-alert"][data-project-key="app"]')!;
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent?.trim()).toBe('');
    expect(alert.closest('[role="listbox"], [aria-hidden="true"]')).toBeNull();
    finish({ ok: false, code: 'unknownDistro' });
    await flushPromises();
    expect(wrapper.get('[data-testid="wsl-notice-failure"]').attributes()).toMatchObject({ 'data-code': 'unknownDistro' });
    expect(wrapper.get('[data-testid="wsl-notice-failure"]').attributes('role')).toBeUndefined();
    expect(wrapper.get('[data-testid="wsl-notice-failure"]').text()).toBe('wsl.exe no longer lists Ubuntu-24.04.');
    expect(alert.textContent?.trim()).toBe('wsl.exe no longer lists Ubuntu-24.04.');
    expect(document.querySelectorAll('[data-testid="wsl-notice-failure-alert"]')).toHaveLength(1);
    expect(button.element.disabled).toBe(false);
    const dismiss = wrapper.get('[data-testid="wsl-notice-dismiss"]');
    expect(dismiss.attributes('aria-label')).toBe('Hide this notice for app');
    await dismiss.trigger('click');
    expect(api.dismissWslNotice).toHaveBeenCalledWith('app');
    expect(api.selectProject).not.toHaveBeenCalled();
  });

  it('says in the notice, and to assistive technology, when main could not hide it', async () => {
    const { wrapper, api } = mountSection();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.dismissWslNotice).mockRejectedValueOnce(new Error('the hosts file refuses writes'));
    await wrapper.get('[data-testid="wsl-notice-dismiss"]').trigger('click');
    await flushPromises();
    const failure = wrapper.get('[data-testid="wsl-notice-failure"]');
    expect(failure.attributes('data-code')).toBe('dismissFailed');
    expect(failure.text()).toBe('Damocles could not hide this notice. Try again.');
    expect(document.querySelector('[data-testid="wsl-notice-failure-alert"]')?.textContent?.trim()).toBe('Damocles could not hide this notice. Try again.');
    expect(logged).toHaveBeenCalledWith('[wsl] hiding the notice failed', expect.any(Error));
    // a second try that succeeds clears the line
    await wrapper.get('[data-testid="wsl-notice-dismiss"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-testid="wsl-notice-failure"]').exists()).toBe(false);
    shellI18n.global.locale.value = 'el';
    vi.mocked(api.dismissWslNotice).mockRejectedValueOnce(new Error('again'));
    await wrapper.get('[data-testid="wsl-notice-dismiss"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="wsl-notice-failure"]').text()).toBe('Δεν ήταν δυνατή η απόκρυψη αυτής της ειδοποίησης. Δοκιμάστε ξανά.');
  });

  it('ends the busy state when main rejects the reopen, whose toast already said why', async () => {
    const { wrapper, api } = mountSection();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.reopenInWsl).mockRejectedValueOnce(new Error('ipc'));
    await wrapper.get('[data-testid="wsl-notice-reopen"]').trigger('click');
    await flushPromises();
    expect(wrapper.get<HTMLButtonElement>('[data-testid="wsl-notice-reopen"]').element.disabled).toBe(false);
    expect(wrapper.find('[data-testid="wsl-notice-failure"]').exists()).toBe(false);
    expect(logged).toHaveBeenCalledWith('[wsl] reopening the folder in WSL failed', expect.any(Error));
  });

  it('offers Reopen in WSL... only for a local folder on a Windows drive, on Windows', async () => {
    const { wrapper, api } = mountSection();
    for (const [key, expected] of [['site', true], ['app', false], ['api', false]] as const) {
      await wrapper.get(`[data-project-key="${key}"]`).trigger('contextmenu');
      await flushPromises();
      expect(menuIds(api).includes('reopenInWsl'), key).toBe(expected);
    }
    // a WSL folder reopens in its own distro from its menu too, so a dismissed notice is not the only way
    await wrapper.get('[data-project-key="app"]').trigger('contextmenu');
    expect(menuIds(api)).toContain('reopenInWslDistro');
    expect(offersReopenInWsl(WINDOWS, 'linux')).toBe(false);
    expect(offersReopenInWsl({ ...WINDOWS, fsPath: '\\\\server\\share\\site' }, 'win32')).toBe(false);
    // only the drive paths main maps, which name folders with a backslash
    expect(offersReopenInWsl({ ...WINDOWS, fsPath: 'D:\\site' }, 'win32')).toBe(true);
    expect(offersReopenInWsl({ ...WINDOWS, fsPath: 'D:/site' }, 'win32')).toBe(false);
  });

  it('picks a distro, says what /mnt costs, then reopens the folder in it', async () => {
    const { wrapper, api } = mountSection();
    vi.mocked(api.listWslDistros).mockResolvedValue([UBUNTU, LEGACY]);
    api.answerNext({ kind: 'menu', itemId: 'reopenInWsl' });
    api.answerNext({ kind: 'menu', itemId: 'distro:damocles-e2e-wsl1' });
    api.answerNext({ kind: 'confirm', confirmed: true });
    let finish!: (result: Awaited<ReturnType<FakeShellApi['reopenInWsl']>>) => void;
    vi.mocked(api.reopenInWsl).mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const status = wrapper.get('[data-testid="projects-reopening-status"]').element;
    expect(status.getAttribute('role')).toBe('status');
    expect(status.textContent?.trim()).toBe('');
    await wrapper.get('[data-project-key="site"]').trigger('contextmenu');
    await flushPromises();
    const [, pick, confirm] = api.overlayRequests;
    expect(pick?.kind === 'menu' && pick.label).toBe('Reopen site in WSL');
    expect(pick?.kind === 'menu' && pick.items).toEqual([
      { kind: 'item', id: 'distro:Ubuntu-24.04', label: 'Ubuntu-24.04', icon: 'square-terminal', hint: 'Running · Default' },
      { kind: 'item', id: 'distro:damocles-e2e-wsl1', label: 'damocles-e2e-wsl1', icon: 'square-terminal', hint: 'Stopped · WSL 1' },
    ]);
    expect(confirm).toEqual({
      kind: 'confirm',
      title: 'Reopen site in damocles-e2e-wsl1?',
      message: 'Damocles opens this folder in damocles-e2e-wsl1 through /mnt, as a new project. site stays in the list with its chats.',
      detail: { label: 'Folder', text: 'C:\\work\\site' },
      warning: { text: "/mnt is slower than damocles-e2e-wsl1's own file system, and Damocles checks it for changes every 5 seconds.", running: false },
      confirmLabel: 'Reopen in WSL',
      cancelLabel: 'Cancel',
      danger: false,
    });
    expect(api.reopenInWsl).toHaveBeenCalledWith('site', 'damocles-e2e-wsl1');
    expect(wrapper.get('[data-testid="projects-reopening"]').text()).toBe('Reopening site in damocles-e2e-wsl1…');
    // the visible line is the status's copy; the status itself was mounted, empty, before the reopen started
    expect(wrapper.get('[data-testid="projects-reopening"]').attributes('aria-hidden')).toBe('true');
    expect(wrapper.get('[data-testid="projects-reopening-status"]').element).toBe(status);
    expect(status.textContent?.trim()).toBe('Reopening site in damocles-e2e-wsl1…');
    finish({ ok: false, code: 'wslpathFailed', message: 'wslpath: C:\\work\\site\u0007' });
    await flushPromises();
    expect(status.textContent?.trim()).toBe('');
    // the line tucks away rather than vanishing
    expect(wrapper.get('[data-testid="projects-reopening"]').classes()).toContain('t-tuck-leave-active');
    await vi.waitFor(() => expect(wrapper.find('[data-testid="projects-reopening"]').exists()).toBe(false));
    const refusal = wrapper.get('[data-testid="projects-refusal"]');
    expect(refusal.attributes('data-code')).toBe('wslpathFailed');
    expect(refusal.text()).toBe('damocles-e2e-wsl1 could not map site to a Linux path. wslpath: C:\\work\\site\\u{7}');
  });

  it('reopens nothing when the confirmation is cancelled, and says when no distro is installed', async () => {
    const { wrapper, api } = mountSection();
    vi.mocked(api.listWslDistros).mockResolvedValue([UBUNTU]);
    api.answerNext({ kind: 'menu', itemId: 'reopenInWsl' });
    api.answerNext({ kind: 'menu', itemId: 'distro:Ubuntu-24.04' });
    api.answerNext({ kind: 'confirm', confirmed: false });
    await wrapper.get('[data-project-key="site"]').trigger('contextmenu');
    await flushPromises();
    expect(api.reopenInWsl).not.toHaveBeenCalled();
    vi.mocked(api.listWslDistros).mockResolvedValue([]);
    api.answerNext({ kind: 'menu', itemId: 'reopenInWsl' });
    await wrapper.get('[data-project-key="site"]').trigger('contextmenu');
    await flushPromises();
    expect(wrapper.get('[data-testid="projects-refusal"]').text()).toBe('No WSL distro is installed on this computer.');
  });

  it('describes a distro in the pick by its state, default marker and WSL 1', () => {
    expect(distroHint({ ...UBUNTU, state: 'other', isDefault: false, version: 1 }, t)).toBe('State unknown · WSL 1');
  });
});

describe('Reopen in WSL at the top of Files', () => {
  async function mountFiles(wslNotice?: { projectKey: string; projectName: string; distro: string }): Promise<{ wrapper: VueWrapper; api: FakeShellApi }> {
    const api = fakeShellApi();
    const wrapper = track(mount(FilesSection, {
      props: { api, projectKey: 'app', projectName: 'app', platform: 'win32', projectPlatform: 'win32', trash: true, collapsed: false, ...(wslNotice ? { wslNotice } : {}) },
      global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api), [SCM_STORE]: createScmStore(api.scm) } },
      attachTo: document.body,
    }));
    await flushPromises();
    return { wrapper, api };
  }

  it('tops the tree with the notice, which reopens and dismisses through main', async () => {
    const { wrapper, api } = await mountFiles({ projectKey: 'app', projectName: 'app', distro: 'Ubuntu-24.04' });
    const notice = wrapper.get('[data-testid="wsl-notice"]');
    expect(notice.attributes()).toMatchObject({ 'data-place': 'files', role: 'group', 'aria-label': 'Reopen app in WSL' });
    expect(notice.attributes('aria-hidden')).toBeUndefined();
    expect(notice.findAll('button').map((button) => button.attributes('tabindex'))).toEqual([undefined, undefined]);
    expect(notice.element.compareDocumentPosition(wrapper.get('[data-testid="files-tree"]').element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // in Files the notice is read as it is, its failure line the alert
    expect(document.querySelector('[data-testid="wsl-notice-failure-alert"]')).toBeNull();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(api.dismissWslNotice).mockRejectedValueOnce(new Error('ipc'));
    await wrapper.get('[data-testid="wsl-notice-dismiss"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="wsl-notice-failure"]').attributes()).toMatchObject({ role: 'alert', 'data-code': 'dismissFailed' });
    vi.mocked(api.dismissWslNotice).mockClear();
    await wrapper.get('[data-testid="wsl-notice-reopen"]').trigger('click');
    expect(api.reopenInWsl).toHaveBeenCalledWith('app');
    await wrapper.get('[data-testid="wsl-notice-dismiss"]').trigger('click');
    expect(api.dismissWslNotice).toHaveBeenCalledWith('app');
    await wrapper.setProps({ wslNotice: undefined });
    expect(wrapper.find('[data-testid="wsl-notice"]').exists()).toBe(false);
  });

  it('shows no notice without one', async () => {
    const { wrapper } = await mountFiles();
    expect(wrapper.find('[data-testid="wsl-notice"]').exists()).toBe(false);
  });
});

describe('ports WSL forwards itself', () => {
  const VIA: PortRow = { key: 'localhost:5173', remoteHost: 'localhost', remotePort: 5173, localPort: 5173, processLabel: 'node (npm run dev)', state: 'forwarded', liveConnections: 0, origin: 'auto', onDetect: 'notify', viaWsl: true };
  const view = (rows: readonly PortRow[]): PortsView => ({ hostId: 'w1', autoForwardMode: 'all', autoForward: true, connected: true, rows });

  it('reads "5173 → localhost:5173" with a via WSL mark, its own dot, and no tunnel to stop or move', async () => {
    const ports = fakePortsApi(async () => view([VIA]));
    const api = fakeShellApi([], { ports });
    const wrapper = track(mount(PortsSection, { props: { api, projectKey: 'wsl+Ubuntu/home/me/app', hostId: 'w1', hostName: 'ml-box', collapsed: false }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    const row = wrapper.get('[data-testid="port-row"][data-port="5173"]');
    expect(row.attributes('data-via-wsl')).toBe('true');
    expect(row.get('[data-testid="port-mapping"]').text().replace(/\s+/g, ' ')).toBe('5173 → forwarded to localhost:5173, via WSL');
    expect(row.get('[data-testid="port-via-wsl"]').attributes('title')).toBe('WSL forwards this port to this computer itself: no tunnel, same port.');
    expect(row.attributes('title')).toBe('ml-box:5173 → localhost:5173 · via WSL · node (npm run dev)');
    expect(row.get('[data-testid="port-dot"]').attributes()).toMatchObject({ 'data-shape': 'direct', 'aria-label': 'Reached through WSL, no tunnel' });
    expect(row.find('[data-testid="port-stop"]').exists()).toBe(false);
    expect(row.find('[data-testid="port-open-pane"]').exists()).toBe(true);
    await row.trigger('keydown', { key: 'Delete' });
    expect(ports.stop).not.toHaveBeenCalled();
  });

  it('leaves Change local port and Stop forwarding out of its menu', () => {
    expect(portDotShape(VIA)).toBe('direct');
    expect(portActions(VIA)).toEqual(['openInPane', 'openInBrowser', 'copyAddress', 'setLabel']);
    const ids = portMenu(VIA, { action: (action) => action, whenDetected: 'When detected', onDetect: (value) => value }, true).flatMap((item) => (item.kind === 'separator' ? [] : [item.id]));
    expect(ids).toEqual(['openInPane', 'openInBrowser', 'copyAddress', 'setLabel', 'whenDetected']);
  });
});

describe('menu hints', () => {
  it('shows an item\'s hint as a second line under its label, part of its name', () => {
    const wrapper = track(mount(ContextMenu, {
      props: { request: { kind: 'menu', label: 'Reopen site in WSL', anchor: { x: 0, y: 0, width: 0, height: 0 }, items: [{ kind: 'item', id: 'distro:Ubuntu-24.04', label: 'Ubuntu-24.04', hint: 'Running · Default' }, { kind: 'item', id: 'plain', label: 'Plain' }] } },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    }));
    const items = wrapper.findAll('[data-menu-item]');
    expect(items[0]!.get('[data-testid="overlay-menu-hint"]').text()).toBe(', Running · Default');
    expect(items[0]!.get('[data-testid="overlay-menu-hint"] .sr-only').text()).toBe(',');
    expect(items[0]!.text().replace(/\s+/g, ' ')).toBe('Ubuntu-24.04, Running · Default');
    expect(items[1]!.find('[data-testid="overlay-menu-hint"]').exists()).toBe(false);
  });
});
