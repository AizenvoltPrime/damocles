// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { ConnectStepEvent, ContainerRebuildFailureCode, ContainerRebuildRun, DevcontainerTrustRequest, HostCardInfo, OverlayRequest, RunningContainer } from '../../preload/overlay-channels';
import type { ShellHost, ShellProject, ShellProjectGroups } from '../../preload/shell-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import StepTimeline from '../overlay/components/StepTimeline.vue';
import ProjectsSection from '../components/ProjectsSection.vue';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { failureText } from '../overlay/connect-text';
import { shellI18n } from '../i18n';
import en from '../locales/en.json';
import el from '../locales/el.json';
import { FakeResizeObserver, STATE, contentName, fakeOverlayApi, fakeShellApi, opened, type FakeOverlayApi, type FakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];
const track = <T extends VueWrapper>(wrapper: T): T => {
  mounted.push(wrapper);
  return wrapper;
};

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-reduced-motion');
});

const pressPointer = async (element: HTMLElement): Promise<void> => {
  element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }));
  element.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0, pointerType: 'mouse' }));
  element.click();
  await flushPromises();
};

const CONTAINER: HostCardInfo = {
  hostId: 'c1',
  kind: 'container',
  name: 'web-app-dev',
  destinationLabel: 'docker · typescript-node:22',
  container: { origin: 'devcontainer', image: 'mcr.microsoft.com/devcontainers/typescript-node:22', state: 'stopped', engine: 'docker', workspaceFolder: 'C:\\work\\web-app', configPath: 'C:\\work\\web-app\\.devcontainer\\devcontainer.json' },
  connection: 'offline',
  signInNeeded: false,
  recentFolders: [],
  projectFolders: [],
  notices: [],
  allowBypass: false,
  passwordless: false,
  keyInstalledByDamocles: false,
  lingerEnabledByDamocles: false,
};
const PROD: HostCardInfo = { ...CONTAINER, hostId: 'h1', kind: 'ssh', name: 'prod-1', destinationLabel: 'deploy@prod-1:22', connection: 'connected' } as HostCardInfo;
delete (PROD as { container?: unknown }).container;

describe('Building container step', () => {
  const lines = (count: number, from = 1): string[] => Array.from({ length: count }, (_, index) => `#${from + index} step ${from + index}`);
  const event = (patch: Partial<ConnectStepEvent>): ConnectStepEvent => ({ attemptId: 'a1', hostId: 'c1', transport: 'container', step: 'building', visited: ['building'], notices: [], ...patch });
  const mountTimeline = (value: ConnectStepEvent) => track(mount(StepTimeline, { props: { event: value, hostName: 'web-app-dev', otherDevices: 0, setInstallFolder: vi.fn(async () => ({ ok: true as const })) }, global: { plugins: [shellI18n] }, attachTo: document.body }));
  const shownLines = (wrapper: VueWrapper): string[] => wrapper.findAll('[data-testid="build-log-line"]').map((line) => line.text());

  it('builds first, attaches where ssh connects, and never authenticates', () => {
    const wrapper = mountTimeline(event({ buildLog: { lines: [], total: 0 } }));
    expect(wrapper.findAll('li[data-step]').map((row) => [row.attributes('data-step'), row.attributes('data-state')])).toEqual([
      ['building', 'active'],
      ['connecting', 'pending'],
      ['checking', 'pending'],
      ['installing', 'pending'],
      ['starting', 'pending'],
    ]);
    expect(wrapper.get('li[data-step="building"]').text()).toContain('Building container');
    expect(wrapper.get('li[data-step="connecting"]').text()).toBe('Attaching');
    expect(wrapper.get('[role="progressbar"]').attributes('aria-valuetext')).toBe('Building container');
    // an attach to a running container skips the build
    const attach = mountTimeline(event({ step: 'connecting', visited: ['connecting'] }));
    expect(attach.findAll('li[data-step]').map((row) => row.attributes('data-step'))).toEqual(['connecting', 'checking', 'installing', 'starting']);
    // ssh and wsl attempts never show the build step
    const ssh = mountTimeline(event({ transport: 'ssh', step: 'connecting', visited: ['connecting'] }));
    expect(ssh.findAll('li[data-step]').map((row) => row.attributes('data-step'))).toEqual(['connecting', 'authenticating', 'checking', 'installing', 'starting']);
  });

  it('tails the last five lines in monospace, each fading in, and keys each line by its place in the whole output', async () => {
    const wrapper = mountTimeline(event({ buildLog: { lines: lines(3), total: 3 } }));
    const tail = wrapper.get('[data-testid="build-log-tail"]');
    expect(tail.classes()).toContain('font-mono');
    expect(shownLines(wrapper)).toEqual(['#1 step 1', '#2 step 2', '#3 step 3']);
    for (const line of wrapper.findAll('[data-testid="build-log-line"]')) expect(line.classes()).toContain('d-fade-in');
    const third = wrapper.findAll('[data-testid="build-log-line"]')[2]!.element;
    await wrapper.setProps({ event: event({ buildLog: { lines: lines(8), total: 8 } }) });
    expect(shownLines(wrapper)).toEqual(['#4 step 4', '#5 step 5', '#6 step 6', '#7 step 7', '#8 step 8']);
    await wrapper.setProps({ event: event({ buildLog: { lines: lines(6, 3), total: 1003 } }) });
    expect(shownLines(wrapper)).toEqual(['#4 step 4', '#5 step 5', '#6 step 6', '#7 step 7', '#8 step 8']);
    // a line already shown keeps its element, so only a new one fades in
    expect(third.isConnected).toBe(false);
    const fourth = wrapper.findAll('[data-testid="build-log-line"]')[0]!.element;
    await wrapper.setProps({ event: event({ buildLog: { lines: lines(6, 4), total: 1004 } }) });
    expect(shownLines(wrapper)).toEqual(['#5 step 5', '#6 step 6', '#7 step 7', '#8 step 8', '#9 step 9']);
    expect(fourth.isConnected).toBe(false);
    expect(wrapper.findAll('[data-testid="build-log-line"]')[0]!.element).not.toBe(fourth);
    expect(wrapper.get('[data-testid="build-log-toggle"]').text().replace(/\s+/g, ' ')).toBe('Build log · 1004 lines');
    // repeated text still moves with its own line
    const repeated = ['x', 'y', 'x', 'y', 'x'];
    await wrapper.setProps({ event: event({ buildLog: { lines: repeated, total: 2000 } }) });
    const before = wrapper.findAll('[data-testid="build-log-line"]').map((line) => line.element);
    await wrapper.setProps({ event: event({ buildLog: { lines: [...repeated.slice(1), 'y'], total: 2001 } }) });
    const after = wrapper.findAll('[data-testid="build-log-line"]').map((line) => line.element);
    expect(after.slice(0, 4)).toEqual(before.slice(1));
    expect(before[0]!.isConnected).toBe(false);
  });

  it('says no line to assistive technology: the progressbar names the step and a failure its alert', () => {
    const wrapper = mountTimeline(event({ buildLog: { lines: lines(8), total: 8 } }));
    const log = wrapper.get('[data-testid="build-log"]').element;
    expect(log.querySelector('[aria-live], [role="log"], [role="status"], [role="alert"]')).toBeNull();
    expect(log.closest('[aria-live]')).toBeNull();
  });

  it('folds the tail by its toggle, which names what it controls', async () => {
    const wrapper = mountTimeline(event({ buildLog: { lines: lines(2), total: 2 } }));
    const toggle = wrapper.get('[data-testid="build-log-toggle"]');
    const tail = wrapper.get('[data-testid="build-log-tail"]');
    expect(toggle.attributes('aria-controls')).toBe(tail.attributes('id'));
    expect(toggle.attributes('aria-expanded')).toBe('true');
    await toggle.trigger('click');
    expect(toggle.attributes('aria-expanded')).toBe('false');
    await vi.waitFor(() => expect((tail.element as HTMLElement).style.display).toBe('none'));
  });

  it('shows the whole kept output in a dialog, says when earlier lines were dropped, and focuses the log', async () => {
    const wrapper = mountTimeline(event({ buildLog: { lines: lines(12, 89), total: 100 } }));
    await pressPointer(wrapper.get('[data-testid="build-log-full"]').element as HTMLElement);
    const dialog = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[role="dialog"][data-testid="build-log-dialog"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Build log: web-app-dev');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)!.textContent!.trim()).toBe('The last 12 of 100 lines; earlier lines were dropped.');
    const text = dialog.querySelector<HTMLElement>('[data-testid="build-log-full-text"]')!;
    expect([...text.querySelectorAll('span')].map((line) => line.textContent)).toEqual(lines(12, 89));
    expect(text.getAttribute('tabindex')).toBe('0');
    expect(text.getAttribute('aria-label')).toBe('Build log of web-app-dev');
    expect(text.getAttribute('aria-live')).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(text));
  });

  it('keeps the tail under a failed build and drops it once the build is done', () => {
    const failed = mountTimeline(event({ step: 'failed', failure: { code: 'devcontainerFailed', params: { message: 'Command failed: docker build' } }, buildLog: { lines: lines(2), total: 2 } }));
    expect(failed.find('[data-testid="build-log"]').exists()).toBe(true);
    expect(failed.get('[data-testid="connect-failure"]').text()).toBe('The dev container did not start: Command failed: docker build');
    const done = mountTimeline(event({ step: 'checking', visited: ['building', 'connecting', 'checking'], buildLog: { lines: lines(2), total: 2 } }));
    expect(done.get('li[data-step="building"]').attributes('data-state')).toBe('done');
    expect(done.find('[data-testid="build-log"]').exists()).toBe(false);
  });

  it('localizes every container failure main sends, in en and el', () => {
    const codes = ['folderUntrusted', 'configRefused', 'composeUnsupported', 'noDevcontainerConfig', 'containerEngineMissing', 'devcontainerFailed', 'containerNotRunning', 'viaNotConnected', 'containerFeatureMissing', 'containerPaused'];
    const rebuildCodes: ReadonlyArray<ContainerRebuildFailureCode | 'info' | 'call'> = ['configRefused', 'folderUntrusted', 'composeUnsupported', 'configFailed', 'stopFailed', 'buildFailed', 'buildFailedKept', 'reconnectFailed', 'containerEngineMissing', 'info', 'call'];
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      for (const code of codes) expect(shellI18n.global.te(`remote.failure.${code}`), `${locale} ${code}`).toBe(true);
      for (const code of rebuildCodes) expect(shellI18n.global.te(`remote.rebuild.failure.${code}`), `${locale} ${code}`).toBe(true);
      for (const key of ['withoutVolume', 'keepsWithoutVolume']) expect(shellI18n.global.te(`remote.rebuild.${key}`), `${locale} ${key}`).toBe(true);
    }
    expect(Object.keys(el.remote.devcontainerTrust.field).sort()).toEqual(Object.keys(en.remote.devcontainerTrust.field).sort());
    shellI18n.global.locale.value = 'en';
    const t = (key: string, values?: Record<string, unknown>): string => shellI18n.global.t(key, values ?? {});
    expect(failureText({ code: 'folderUntrusted', params: { folder: '/srv/app' } }, 'prod-1', t)).toBe('/srv/app is not trusted on prod-1, so nothing ran. Trust the folder, then try again.');
    // the host keeps this computer's name for it; the command names the engine's own name for the container
    expect(failureText({ code: 'containerPaused', params: { container: 'vigorous_turing', engine: 'podman' } }, 'web-app-dev', t)).toBe('The container web-app-dev is paused. Run podman unpause vigorous_turing, then connect again.');
  });

  it('never says a rebuild that stopped nothing, or failed to stop, removed the old container', () => {
    for (const locale of ['en', 'el'] as const) {
      shellI18n.global.locale.value = locale;
      const gone = shellI18n.global.t('remote.rebuild.failure.buildFailed').split(/[.;·]/)[1]!.trim();
      for (const code of ['configFailed', 'stopFailed', 'buildFailedKept']) expect(shellI18n.global.t(`remote.rebuild.failure.${code}`, { name: 'web-app-dev' }), `${locale} ${code}`).not.toContain(gone);
    }
  });
});

describe('Dev container trust dialog', () => {
  let api: FakeOverlayApi;
  beforeEach(() => {
    api = fakeOverlayApi();
  });

  const REQUEST: DevcontainerTrustRequest = {
    folder: '/home/me/web-app',
    configPath: '/home/me/web-app/.devcontainer/devcontainer.json',
    changed: false,
    items: [
      { field: 'initializeCommand', values: [{ text: 'npm run prepare\necho ready' }] },
      { field: 'mounts', values: [{ text: 'source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind', danger: 'dockerSocket' }, { text: 'source=${localEnv:HOME}/.aws,target=/root/.aws,type=bind' }] },
      { field: 'privileged', values: [{ text: 'true', danger: 'privileged' }] },
      { field: 'capAdd', values: [{ text: 'SYS_PTRACE' }] },
    ],
  };

  async function ask(request: Partial<DevcontainerTrustRequest> = {}): Promise<HTMLElement> {
    track(mount(OverlayApp, {
      props: { api, settingsBridge: createOverlaySettingsBridge(api) },
      global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    }));
    await flushPromises();
    api.request('t1', { kind: 'devcontainerTrust', ...REQUEST, ...request });
    await flushPromises();
    return vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="devcontainer-trust"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
  }

  it('lists every item in monospace, keeps line breaks, and focuses Cancel first', async () => {
    const dialog = await ask();
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Run this dev container configuration?');
    expect([...dialog.querySelectorAll<HTMLElement>('[data-testid="devcontainer-trust-item"]')].map((item) => [item.dataset.field, item.querySelector('dt')!.textContent!.replace(/\s+/g, ' ').trim()])).toEqual([
      ['initializeCommand', 'Runs on the host first initializeCommand'],
      ['mounts', 'Mounts mounts'],
      ['privileged', 'Privileged mode privileged'],
      ['capAdd', 'Added capabilities capAdd'],
    ]);
    const codes = [...dialog.querySelectorAll<HTMLElement>('[data-testid="devcontainer-trust-value"] code')];
    expect(codes.map((code) => code.textContent)).toEqual(['npm run prepare\necho ready', 'source=/var/run/docker.sock,target=/var/run/docker.sock,type=bind', 'source=${localEnv:HOME}/.aws,target=/root/.aws,type=bind', 'true', 'SYS_PTRACE']);
    for (const code of codes) expect(code.className).toContain('font-mono');
    expect(codes[0]!.className).toContain('whitespace-pre-wrap');
    expect(dialog.querySelector('[data-testid="devcontainer-trust-host"]')!.textContent!.trim()).toBe('This computer');
    expect(dialog.querySelector('[data-testid="devcontainer-trust-reason"]')!.textContent).toBe("Building the container runs and mounts what this folder's configuration lists below, on this computer. Check it before you build.");
    expect(dialog.querySelector('[data-testid="devcontainer-trust-folder"]')!.textContent).toBe('/home/me/web-app');
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.querySelector('[data-testid="devcontainer-trust-cancel"]')));
  });

  it('marks the privileged and docker socket values with an icon and words, not color alone, and says what they grant', async () => {
    const dialog = await ask({ hostName: 'prod-1', hostColor: 'danger' });
    const dangerous = [...dialog.querySelectorAll<HTMLElement>('[data-testid="devcontainer-trust-value"][data-danger]')];
    expect(dangerous.map((value) => [value.dataset.danger, value.querySelector('[data-testid="devcontainer-trust-danger"]')?.textContent?.trim(), value.querySelector('svg') !== null])).toEqual([
      ['dockerSocket', 'Docker socket', true],
      ['privileged', 'Full host access', true],
    ]);
    // the plain values carry no mark
    expect(dialog.querySelectorAll('[data-testid="devcontainer-trust-danger"]')).toHaveLength(2);
    const description = document.getElementById(dialog.getAttribute('aria-describedby')!)!;
    expect([...description.querySelectorAll<HTMLElement>('[data-testid="devcontainer-trust-danger-summary"]')].map((summary) => summary.textContent!.trim())).toEqual([
      'The Docker socket lets the container start any container on prod-1, with full access to it.',
      'Privileged mode gives the container full control of prod-1.',
    ]);
    expect(dialog.querySelector('[data-testid="devcontainer-trust-host"]')!.textContent!.trim()).toBe('prod-1');
    expect(dialog.querySelector<HTMLElement>('[data-testid="devcontainer-trust-accept"]')!.className).toContain('bg-destructive');
  });

  it('says a changed configuration in its heading', async () => {
    const dialog = await ask({ changed: true, items: [{ field: 'runArgs', values: [{ text: '--network=host' }] }] });
    expect(dialog.dataset.changed).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('This dev container configuration changed');
    expect(dialog.querySelector('[data-testid="devcontainer-trust-danger-summary"]')).toBeNull();
  });

  it('refuses on Escape, and answers once', async () => {
    const dialog = await ask();
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog.querySelector('[data-testid="devcontainer-trust-cancel"]')));
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'devcontainerTrust', accept: false }));
    expect(api.answer).toHaveBeenCalledTimes(1);
  });

  it('refuses on Cancel and accepts only on Build container', async () => {
    let dialog = await ask();
    await pressPointer(dialog.querySelector<HTMLElement>('[data-testid="devcontainer-trust-cancel"]')!);
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'devcontainerTrust', accept: false }));
    for (const wrapper of mounted.splice(0)) wrapper.unmount();
    api = fakeOverlayApi();
    dialog = await ask();
    await pressPointer(dialog.querySelector<HTMLElement>('[data-testid="devcontainer-trust-accept"]')!);
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'devcontainerTrust', accept: true }));
  });
});

describe('Connect dialog containers', () => {
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
    api.request('c1', { kind: 'connect', hosts: [CONTAINER, PROD], distros: [], sshConfigAliases: [], ...request });
    await flushPromises();
    await flushPromises();
  }
  const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[role="dialog"][data-testid="connect-dialog"]')!;

  it('lists saved containers under Dev Containers with the box icon, their state in words and a dot of its own shape', async () => {
    const running: HostCardInfo = { ...CONTAINER, hostId: 'c2', name: 'api-shell', container: { origin: 'attach', image: 'node:22-alpine', state: 'running', engine: 'docker', containerName: 'api', user: 'root', via: { hostId: 'h1', name: 'prod-1' } } };
    const gone: HostCardInfo = { ...CONTAINER, hostId: 'c3', name: 'old', container: { ...CONTAINER.container!, state: 'missing' } };
    await openConnect({ hosts: [CONTAINER, running, gone, PROD] });
    const group = dialog().querySelector<HTMLElement>('[data-testid="container-cards"]')!;
    expect(group.getAttribute('aria-label')).toBe('Dev Containers');
    // the saved hosts list keeps only the ssh host
    expect([...dialog().querySelectorAll<HTMLElement>('[data-testid="host-card-button"]')].map((card) => contentName(card))).toEqual(['prod-1 deploy@prod-1:22 Connected']);
    const cards = [...group.querySelectorAll<HTMLElement>('[data-testid="container-card"]')];
    expect(cards.map((card) => contentName(card))).toEqual([
      'web-app-dev Dev container · typescript-node:22 · Stopped',
      'api-shell Attach · node:22-alpine · Running · on prod-1',
      'old Dev container · typescript-node:22 · Removed',
    ]);
    for (const card of cards) {
      expect(card.hasAttribute('aria-label')).toBe(false);
      expect(card.querySelector('.lucide-box')).not.toBeNull();
    }
    const dot = (card: HTMLElement): HTMLElement => card.querySelector<HTMLElement>('[data-testid="container-state-dot"]')!;
    expect(cards.map((card) => dot(card).dataset.state)).toEqual(['stopped', 'running', 'missing']);
    // a ring is stopped and a crossed ring is gone, so the state never rests on color alone
    expect(dot(cards[0]!).querySelectorAll('path')).toHaveLength(0);
    expect(dot(cards[2]!).querySelectorAll('path')).toHaveLength(1);
    // a connected container shows its connection instead
    api.connectHosts([{ ...CONTAINER, connection: 'connected', container: { ...CONTAINER.container!, state: 'running' } }, PROD]);
    await flushPromises();
    const connected = group.querySelector<HTMLElement>('[data-testid="container-card"]')!;
    expect(contentName(connected)).toBe('web-app-dev Dev container · typescript-node:22 · Connected');
    expect(connected.querySelector('[data-testid="host-status-dot"]')!.getAttribute('data-shape')).toBe('connected');
  });

  it('names and attaches to a running container on this computer, as root when asked', async () => {
    const containers: RunningContainer[] = [
      { id: 'a1b2c3d4e5f6', name: 'web/app', image: 'node:22', status: 'Up 3 hours', state: 'running', prefillName: 'webapp', user: 'node' },
      { id: 'f6e5d4c3b2a1', name: 'db', image: 'postgres:16', status: 'Up 2 days (Paused)', state: 'paused', prefillName: 'db', hostId: 'c9' },
    ];
    vi.mocked(api.listContainers).mockResolvedValue(opened({ ok: true as const, engine: 'docker' as const, containers }));
    vi.mocked(api.checkHostName).mockImplementation(async (name: string) => opened({ ok: true as const, name: name.trim() }));
    await openConnect();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-container-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-local"]')).not.toBeNull());
    expect([...dialog().querySelectorAll<HTMLElement>('[data-testid="container-where-host"]')].map((card) => card.dataset.hostId)).toEqual(['h1']);
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-local"]')!);
    expect(api.listContainers).toHaveBeenCalledWith(undefined);
    await vi.waitFor(() => expect(dialog().querySelectorAll('[data-testid="running-container"]')).toHaveLength(2));
    const rows = [...dialog().querySelectorAll<HTMLElement>('[data-testid="running-container"]')];
    expect(rows.map((row) => contentName(row))).toEqual(['web/app as node node:22 · Up 3 hours', 'db as root Saved postgres:16 · Up 2 days (Paused)']);
    expect(rows.map((row) => row.querySelector<HTMLElement>('[data-testid="container-state-dot"]')!.dataset.state)).toEqual(['running', 'paused']);
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-user"] [data-segment]:last-child')!);
    await vi.waitFor(() => expect(rows[0]!.querySelector('[data-testid="running-container-user"]')!.textContent!.trim()).toBe('as root'));
    await pressPointer(rows[0]!);
    const name = await vi.waitFor(() => {
      const field = dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]');
      expect(field).not.toBeNull();
      return field!;
    });
    expect(name.value).toBe('webapp');
    expect(dialog().textContent).toContain('Name this container');
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenCalledWith({ attach: 'a1b2c3d4e5f6', user: 'root', name: 'webapp' }));
  });

  it('attaches a listed container that has a record under its name, as the user chosen in the view', async () => {
    vi.mocked(api.listContainers).mockResolvedValue(opened({ ok: true as const, engine: 'docker' as const, containers: [{ id: 'f6e5d4c3b2a1', name: 'api', image: 'node:22-alpine', status: 'Up', state: 'running', prefillName: 'api', user: 'node', hostId: 'c2' }] }));
    const recorded: HostCardInfo = { ...CONTAINER, hostId: 'c2', name: 'api-shell', container: { origin: 'attach', state: 'running', engine: 'docker', containerName: 'api', user: 'root' } };
    await openConnect({ hosts: [CONTAINER, recorded, PROD] });
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-container-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-local"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-local"]')!);
    const row = await vi.waitFor(() => {
      const shown = dialog().querySelector<HTMLElement>('[data-testid="running-container"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    // the view shows the user the attach runs as, the configured one here, though the record was saved as root
    expect(row.querySelector('[data-testid="running-container-user"]')!.textContent!.trim()).toBe('as node');
    await pressPointer(row);
    expect(api.startConnect).toHaveBeenCalledWith({ attach: 'f6e5d4c3b2a1', user: 'configured', name: 'api-shell' });
    expect(dialog().querySelector('input[aria-label="Name"]')).toBeNull();
  });

  it('reconnects a listed container that has a record, and says why a list failed', async () => {
    vi.mocked(api.listContainers).mockResolvedValueOnce(opened({ ok: false as const, code: 'containerEngineMissing' as const }));
    await openConnect({ hosts: [CONTAINER, { ...CONTAINER, hostId: 'c3', name: 'old' }, PROD] });
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-container-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-host"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-host"]')!);
    expect(api.listContainers).toHaveBeenCalledWith('h1');
    const failure = await vi.waitFor(() => {
      const shown = dialog().querySelector<HTMLElement>('[data-testid="attach-failure"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.textContent!.trim()).toBe('Docker or Podman was not found on prod-1.');
    let list!: (answer: Awaited<ReturnType<FakeOverlayApi['listContainers']>>) => void;
    vi.mocked(api.listContainers).mockImplementationOnce(() => new Promise((resolve) => (list = resolve)));
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-refresh"]')!);
    // the list is busy and says so with the spinner every other view's wait shows
    const listing = dialog().querySelector<HTMLElement>('[data-testid="attach-listing"]')!;
    expect(listing.textContent!.trim()).toBe('Listing the containers on prod-1…');
    expect(listing.querySelector('svg.d-spinning')!.getAttribute('aria-hidden')).toBe('true');
    expect(dialog().querySelector('[data-testid="attach-list"]')!.getAttribute('aria-busy')).toBe('true');
    list(opened({ ok: true as const, engine: 'docker' as const, containers: [{ id: 'f6e5d4c3b2a1', name: 'db', image: 'postgres:16', status: 'Up', state: 'running', prefillName: 'db', hostId: 'c3' }] }));
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="running-container"]')).not.toBeNull());
    expect(dialog().querySelector('[data-testid="attach-list"]')!.getAttribute('aria-busy')).toBe('false');
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="running-container"]')!);
    expect(api.startConnect).toHaveBeenCalledWith({ attach: 'f6e5d4c3b2a1', user: 'configured', via: 'h1', name: 'old' });
  });

  it('returns focus to the host chosen before when going back from the running containers', async () => {
    vi.mocked(api.listContainers).mockResolvedValue(opened({ ok: true as const, engine: 'docker' as const, containers: [] }));
    await openConnect();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-container-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-host"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-host"][data-host-id="h1"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="attach-empty"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-back"]')!);
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog().querySelector('[data-testid="container-where-host"][data-host-id="h1"]')));

    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-local"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="attach-back"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-back"]')!);
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog().querySelector('[data-testid="container-where-local"]')));
  });

  it('opens a local folder in a container: a folder without a configuration is refused in place, one with it is named and built', async () => {
    vi.mocked(api.checkHostName).mockImplementation(async (name: string) => opened({ ok: true as const, name: name.trim() }));
    vi.mocked(api.pickContainerFolder).mockResolvedValueOnce(opened({ ok: false as const, code: 'noDevcontainerConfig' as const, folder: 'C:\\work\\notes' }));
    await openConnect();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="devcontainer-folder-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-local"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-local"]')!);
    const refusal = await vi.waitFor(() => {
      const shown = dialog().querySelector<HTMLElement>('[data-testid="container-refusal"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(refusal.getAttribute('role')).toBe('alert');
    expect(refusal.textContent!.trim()).toBe('C:\\work\\notes has no .devcontainer/devcontainer.json or .devcontainer.json.');
    vi.mocked(api.pickContainerFolder).mockResolvedValueOnce(opened({ ok: true as const, folder: 'C:\\work\\web-app', configPath: 'C:\\work\\web-app\\.devcontainer\\devcontainer.json', prefillName: 'web-app' }));
    startAnswers(step({ attemptId: 'a7', hostId: 'c7', step: 'building', visited: ['building'] }));
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-local"]')!);
    const name = await vi.waitFor(() => {
      const field = dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]');
      expect(field).not.toBeNull();
      return field!;
    });
    expect(name.value).toBe('web-app');
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenCalledWith({ devcontainer: 'C:\\work\\web-app', name: 'web-app' }));
    // the timeline shows main's first step, which main pushed before it answered
    await vi.waitFor(() => expect(dialog().querySelector('li[data-step="building"]')?.getAttribute('data-state')).toBe('active'));
    // main opens the container's folder and closes the dialog itself, so a connected dev container never shows the folder browser;
    // reduced motion moves a connected timeline on at once
    document.documentElement.setAttribute('data-reduced-motion', '');
    api.connectHosts([{ ...CONTAINER, hostId: 'c7', connection: 'connected' }, PROD]);
    api.connectStep({ attemptId: 'a7', hostId: 'c7', transport: 'container', step: 'connected', visited: ['building', 'connecting', 'checking', 'starting'], notices: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    expect(dialog().querySelector('[data-testid="folder-browser-confirm"]')).toBeNull();
    expect(dialog().querySelector('[data-testid="connect-progress"]')).not.toBeNull();
  });

  it('opens a folder on an SSH host through its folder browser, which checks the folder before naming it', async () => {
    vi.mocked(api.checkHostName).mockImplementation(async (name: string) => opened({ ok: true as const, name: name.trim() }));
    vi.mocked(api.checkContainerFolder).mockResolvedValueOnce(opened({ ok: true as const, folder: '/srv/app', configPath: '/srv/app/.devcontainer/devcontainer.json', prefillName: 'app' }));
    await openConnect();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="devcontainer-folder-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-host"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-host"]')!);
    const open = await vi.waitFor(() => {
      const shown = dialog().querySelector<HTMLButtonElement>('[data-testid="folder-browser-confirm"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(open.textContent!.trim()).toBe('Open in container');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('Choose a folder with a dev container on prod-1');
    await pressPointer(open);
    await vi.waitFor(() => expect(api.checkContainerFolder).toHaveBeenCalledWith('h1', '/home/u'));
    const name = await vi.waitFor(() => {
      const field = dialog().querySelector<HTMLInputElement>('input[aria-label="Name"]');
      expect(field).not.toBeNull();
      return field!;
    });
    name.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenCalledWith({ devcontainer: '/srv/app', via: 'h1', name: 'app' }));
    expect(api.pickHostFolder).not.toHaveBeenCalled();
  });

  const step = (patch: Partial<ConnectStepEvent>): ConnectStepEvent => ({ attemptId: 'a1', hostId: 'c1', transport: 'container', step: 'connecting', visited: ['connecting'], notices: [], ...patch });
  const connected = (patch: Partial<ConnectStepEvent> = {}): ConnectStepEvent => step({ step: 'connected', visited: ['connecting', 'checking', 'starting'], ...patch });
  // main pushes the step of the attempt a start begins or joins before it answers the start
  const startAnswers = (event: ConnectStepEvent): void => {
    vi.mocked(api.startConnect).mockImplementationOnce(async () => {
      api.connectStep(event);
      return opened({ ok: true as const, attemptId: event.attemptId, hostId: event.hostId });
    });
  };
  const rowStates = (): Array<[string | undefined, string | undefined]> => [...dialog().querySelectorAll<HTMLElement>('li[data-step]')].map((row) => [row.dataset.step, row.dataset.state]);

  it('connects a saved, offline dev container from its card and waits on the connected timeline for main to open its folder', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    startAnswers(step({ step: 'building', visited: ['building'] }));
    await openConnect();
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-card"][data-host-id="c1"]')!);
    expect(api.startConnect).toHaveBeenCalledWith({ hostId: 'c1' });
    await vi.waitFor(() => expect(rowStates()[0]).toEqual(['building', 'active']));
    api.connectStep(connected({ visited: ['building', 'connecting', 'checking', 'starting'] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    // the timeline stays, its Connected seen, until main opens the folder and closes the dialog
    expect(dialog().querySelector('[data-testid="connect-progress"]')!.getAttribute('aria-valuetext')).toBe('Connected');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('web-app-dev');
  });

  it('reconnects a picked folder that has a record through its host, and shows a connected one as main reports it, never as connecting', async () => {
    document.documentElement.setAttribute('data-reduced-motion', '');
    vi.mocked(api.pickContainerFolder).mockResolvedValue(opened({ ok: true as const, folder: 'C:\\work\\web-app', configPath: 'C:\\work\\web-app\\.devcontainer\\devcontainer.json', prefillName: 'web-app', hostId: 'c1' }));
    startAnswers(connected());
    await openConnect({ hosts: [{ ...CONTAINER, connection: 'connected', container: { ...CONTAINER.container!, state: 'running' } }, PROD] });
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="devcontainer-folder-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-local"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-local"]')!);
    await vi.waitFor(() => expect(api.startConnect).toHaveBeenCalledWith({ hostId: 'c1' }));
    expect(dialog().querySelector('input[aria-label="Name"]')).toBeNull();
    // the attempt main joined is connected: every step done, none running, while main opens the folder and closes the dialog
    await vi.waitFor(() => expect(rowStates()).toEqual([['connecting', 'done'], ['checking', 'done'], ['starting', 'done']]));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await flushPromises();
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('web-app-dev');
  });

  it('builds a dev container from the dialog the banner\'s Retry opens on it', async () => {
    startAnswers(step({ step: 'building', visited: ['building'] }));
    const needsBuild: HostCardInfo = { ...CONTAINER, connection: 'failed', failure: { code: 'containerNeedsBuild', params: {} } };
    await openConnect({ hosts: [needsBuild, PROD], hostId: 'c1' });
    expect(api.startConnect).toHaveBeenCalledWith({ hostId: 'c1' });
    await vi.waitFor(() => expect(rowStates()[0]).toEqual(['building', 'active']));
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent!.trim()).toBe('web-app-dev');
  });

  it('says in its language when main could not open a connected dev container\'s folder, and Retry asks main again', async () => {
    startAnswers(step({ step: 'building', visited: ['building'] }));
    await openConnect({ hostId: 'c1' });
    await vi.waitFor(() => expect(rowStates()[0]).toEqual(['building', 'active']));
    api.connectStep(connected({ visited: ['building', 'connecting', 'checking', 'starting'], folderFailure: { code: 'containerFolderFailed', params: {} } }));
    const failure = await vi.waitFor(() => {
      const shown = dialog().querySelector<HTMLElement>('[data-testid="connect-failure"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.dataset.code).toBe('containerFolderFailed');
    expect(failure.textContent!.trim()).toBe('Connected to web-app-dev, but its workspace folder could not be opened as a project. Retry to open it again.');
    expect(failure.closest('li')!.dataset.step).toBe('starting');
    // the connection is up, so every step stays done
    expect(rowStates().every(([, state]) => state === 'done')).toBe(true);
    const retry = [...dialog().querySelectorAll<HTMLElement>('[data-failure-actions] button')].find((button) => button.textContent!.trim() === 'Retry')!;
    await vi.waitFor(() => expect(document.activeElement).toBe(retry));
    expect(failureText({ code: 'containerFolderFailed', params: {} }, 'web-app-dev', (key, values) => shellI18n.global.t(key, values ?? {}, { locale: 'el' }))).toBe('Η σύνδεση στο web-app-dev έγινε, αλλά ο φάκελος εργασίας του δεν άνοιξε ως έργο. Πατήστε Δοκιμή ξανά για να ανοίξει.');
    startAnswers(connected({ visited: ['building', 'connecting', 'checking', 'starting'] }));
    await pressPointer(retry);
    expect(api.startConnect).toHaveBeenLastCalledWith({ hostId: 'c1' });
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="connect-failure"]')).toBeNull());
  });

  it('goes straight to the folders of a listed container whose record is connected, as main joins its connection', async () => {
    vi.mocked(api.listContainers).mockResolvedValue(opened({ ok: true as const, engine: 'docker' as const, containers: [{ id: 'f6e5d4c3b2a1', name: 'api', image: 'node:22-alpine', status: 'Up', state: 'running', prefillName: 'api', user: 'node', hostId: 'c2' }] }));
    const recorded: HostCardInfo = { ...CONTAINER, hostId: 'c2', name: 'api-shell', connection: 'connected', container: { origin: 'attach', state: 'running', engine: 'docker', containerName: 'api', user: 'configured' } };
    startAnswers(connected({ hostId: 'c2', attemptId: 'a2' }));
    await openConnect({ hosts: [CONTAINER, recorded, PROD] });
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="attach-container-card"]')!);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="container-where-local"]')).not.toBeNull());
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="container-where-local"]')!);
    await pressPointer(await vi.waitFor(() => {
      const shown = dialog().querySelector<HTMLElement>('[data-testid="running-container"]');
      expect(shown).not.toBeNull();
      return shown!;
    }));
    expect(api.startConnect).toHaveBeenCalledWith({ attach: 'f6e5d4c3b2a1', user: 'configured', name: 'api-shell' });
    await vi.waitFor(() => expect(api.browseHost).toHaveBeenCalledWith('c2', undefined));
    expect(dialog().querySelector('[role="progressbar"]')).toBeNull();
  });

  it('opens with the last known container states and distros, and shows the lists main refreshes after it', async () => {
    const away: HostCardInfo = { ...CONTAINER, container: { ...CONTAINER.container!, state: 'unknown' } };
    await openConnect({ hosts: [away, PROD], distros: [] });
    const dotState = (): string | undefined => dialog().querySelector<HTMLElement>('[data-testid="container-card"] [data-testid="container-state-dot"]')?.dataset.state;
    expect(dotState()).toBe('unknown');
    expect(dialog().querySelector('[data-testid="distro-cards"]')).toBeNull();
    api.connectHosts([{ ...CONTAINER, container: { ...CONTAINER.container!, state: 'running' } }, PROD]);
    api.connectDistros([{ distro: 'Ubuntu-24.04', state: 'running', version: 2, isDefault: true }]);
    await flushPromises();
    expect(dotState()).toBe('running');
    expect([...dialog().querySelectorAll<HTMLElement>('[data-testid="distro-card"]')].map((card) => card.dataset.distro)).toEqual(['Ubuntu-24.04']);
    // the lists change in place: no refreshing state, as the mockup has none
    expect(dialog().querySelector('[aria-busy="true"]')).toBeNull();
  });

  it('rebuilds a dev container from its card after a confirmation naming what stops', async () => {
    vi.mocked(api.rebuildInfo).mockResolvedValue(opened({ runs: [{ kind: 'chat', id: 'p1', title: 'Fix checkout', state: 'running' }, { kind: 'terminal', id: 't1', title: 'npm run dev', state: 'background' }] }));
    await openConnect({ hosts: [{ ...CONTAINER, connection: 'connected' }, PROD] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for web-app-dev"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="rebuild-container"]')).not.toBeNull());
    expect([...dialog().querySelectorAll<HTMLElement>('[data-testid="host-card-container"] dd')].map((fact) => [fact.dataset.fact, fact.textContent!.trim()])).toEqual([
      ['image', 'mcr.microsoft.com/devcontainers/typescript-node:22'],
      ['engine', 'docker'],
      ['runsOn', 'This computer'],
      ['folder', 'C:\\work\\web-app'],
      ['config', 'C:\\work\\web-app\\.devcontainer\\devcontainer.json'],
    ]);
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="rebuild-container"]')!);
    expect(api.rebuildInfo).toHaveBeenCalledWith('c1');
    const confirm = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[role="alertdialog"][data-testid="rebuild-container-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(confirm.textContent).toContain('Rebuild web-app-dev?');
    expect([...confirm.querySelectorAll<HTMLElement>('[data-testid="rebuild-container-run"]')].map((row) => [row.dataset.kind, ...[...row.querySelectorAll('span')].map((span) => span.textContent)])).toEqual([['chat', 'Fix checkout', 'agent'], ['terminal', 'npm run dev', 'terminal']]);
    await vi.waitFor(() => expect(document.activeElement).toBe(confirm.querySelector('[data-testid="rebuild-container-cancel"]')));
    vi.mocked(api.rebuildContainer).mockImplementationOnce(async () => {
      api.pushHostOperations({ hostId: 'c1', rebuild: { steps: { stopping: 'done', building: 'running', reconnecting: 'pending' }, log: { lines: ['#1 FROM node:22'], total: 1 } } });
      return opened(undefined);
    });
    await pressPointer(confirm.querySelector<HTMLElement>('[data-testid="rebuild-container-confirm"]')!);
    expect(api.rebuildContainer).toHaveBeenCalledWith('c1');
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="rebuild-container-progress"]')).not.toBeNull());
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog().querySelector('[data-testid="rebuild-container-steps"]')));
    expect([...dialog().querySelectorAll<HTMLElement>('[data-testid="rebuild-container-step"]')].map((step) => [step.dataset.step, step.dataset.state])).toEqual([['stopping', 'done'], ['building', 'running'], ['reconnecting', 'pending']]);
    expect(dialog().querySelector('[data-testid="build-log-line"]')!.textContent).toBe('#1 FROM node:22');
    expect(dialog().querySelector('[data-testid="rebuild-container"]')).toBeNull();
    const failed: ContainerRebuildRun = { steps: { stopping: 'done', building: 'failed', reconnecting: 'pending' }, log: { lines: ['#1 FROM node:22', 'ERROR: failed to solve'], total: 2 }, result: { ok: false, code: 'buildFailed', message: 'ERROR: failed to solve' } };
    api.pushHostOperations({ hostId: 'c1', rebuild: failed });
    await flushPromises();
    const failure = dialog().querySelector<HTMLElement>('[data-testid="rebuild-container-failure"]')!;
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.dataset.code).toBe('buildFailed');
    expect(failure.querySelector('[data-testid="rebuild-container-message"]')!.textContent).toBe('ERROR: failed to solve');
    expect(failure.textContent).toContain('The container did not build. The old one is gone; fix the configuration and rebuild.');
    // a gate failure stopped nothing; its engine text shows as text, its hidden characters escaped
    const stoppedNothing = { steps: { stopping: 'pending', building: 'pending', reconnecting: 'pending' }, log: { lines: [], total: 0 } } as const;
    api.pushHostOperations({ hostId: 'c1', rebuild: { ...stoppedNothing, result: { ok: false, code: 'configFailed', message: '<img src=x onerror=alert(1)> bad \u202Ejson' } } });
    await flushPromises();
    const gate = dialog().querySelector<HTMLElement>('[data-testid="rebuild-container-failure"]')!;
    expect(gate.dataset.code).toBe('configFailed');
    expect(gate.querySelector('p')!.textContent).toBe('The configuration could not be checked, so nothing was stopped.');
    expect(gate.querySelector('img')).toBeNull();
    expect(gate.querySelector('[data-testid="rebuild-container-message"]')!.textContent).toBe('<img src=x onerror=alert(1)> bad \\u{202E}json');
    api.pushHostOperations({ hostId: 'c1', rebuild: { ...stoppedNothing, steps: { ...stoppedNothing.steps, stopping: 'failed' }, result: { ok: false, code: 'stopFailed', message: 'the daemon did not answer' } } });
    await flushPromises();
    const stop = dialog().querySelector<HTMLElement>('[data-testid="rebuild-container-failure"]')!;
    expect(stop.dataset.code).toBe('stopFailed');
    expect(stop.querySelector('p')!.textContent).toBe('Damocles could not stop its server in web-app-dev, so nothing was removed or rebuilt.');
    expect(stop.querySelector('[data-testid="rebuild-container-message"]')!.textContent).toBe('the daemon did not answer');
    api.pushHostOperations({ hostId: 'c1', rebuild: { ...failed, result: { ok: false, code: 'buildFailedKept', message: 'initializeCommand failed with exit code 1' } } });
    await flushPromises();
    const kept = dialog().querySelector<HTMLElement>('[data-testid="rebuild-container-failure"]')!;
    expect(kept.dataset.code).toBe('buildFailedKept');
    expect(kept.querySelector('p')!.textContent).toBe('The container did not build. The old one is still there with its server stopped; reconnect from this card to use it, or fix the configuration and rebuild.');
  });

  it('says on the card and in the confirmation that a container without the data volume loses its chats on rebuild', async () => {
    vi.mocked(api.rebuildInfo).mockResolvedValue(opened({ runs: [] }));
    const withoutVolume: HostCardInfo = { ...CONTAINER, connection: 'connected', container: { ...CONTAINER.container!, state: 'running', withoutDataVolume: true } };
    await openConnect({ hosts: [withoutVolume, PROD], hostId: 'c1', card: 'rebuild' });
    const confirm = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[data-testid="rebuild-container-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(confirm.querySelector('[data-testid="rebuild-container-keeps"]')!.textContent!.trim()).toBe('The project keeps its trust and layout. The chats and settings in web-app-dev are lost, because this container has no Damocles data volume. The rebuilt container keeps its chats and settings from then on. Files outside the workspace folder are lost.');
    await pressPointer(confirm.querySelector<HTMLElement>('[data-testid="rebuild-container-cancel"]')!);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="rebuild-container-dialog"][data-state="open"]')).toBeNull());
    const note = dialog().querySelector<HTMLElement>('[data-testid="rebuild-container-volume"]')!;
    expect(note.textContent!.trim()).toBe('Chats and settings in web-app-dev live inside this container, which Damocles did not create, so a rebuild removes them. A container rebuilt here keeps chats and settings made after the rebuild in Damocles\' data volume.');
    expect(note.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    expect(dialog().querySelector('[data-testid="container-rebuild"]')!.textContent).not.toContain('Rebuild after you change the configuration');
    // once main records a container with the volume, the card says nothing more and the confirmation keeps its usual line
    api.connectHosts([{ ...withoutVolume, container: { ...CONTAINER.container!, state: 'running' } }, PROD]);
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="rebuild-container-volume"]')).toBeNull());
    expect(dialog().querySelector('[data-testid="container-rebuild"]')!.textContent).toContain('Rebuild after you change the configuration or the Dockerfile.');
    await pressPointer(dialog().querySelector<HTMLElement>('[data-testid="rebuild-container"]')!);
    const again = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[data-testid="rebuild-container-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(again.querySelector('[data-testid="rebuild-container-keeps"]')!.textContent!.trim()).toBe('The project keeps its trust, layout and chats. Files outside the workspace folder are lost.');
  });

  it('gives focus to the rebuild steps when main shows them after the confirmation closed, or back to the button when the call failed', async () => {
    vi.mocked(api.rebuildInfo).mockResolvedValue(opened({ runs: [] }));
    await openConnect({ hosts: [{ ...CONTAINER, connection: 'connected' }, PROD] });
    dialog().querySelector<HTMLElement>('button[aria-label="Details for web-app-dev"]')!.click();
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="rebuild-container"]')).not.toBeNull());
    const confirmRebuild = async (): Promise<void> => {
      const button = dialog().querySelector<HTMLElement>('[data-testid="rebuild-container"]')!;
      button.focus();
      await pressPointer(button);
      const confirm = await vi.waitFor(() => {
        const shown = document.querySelector<HTMLElement>('[data-testid="rebuild-container-dialog"][data-state="open"]');
        expect(shown).not.toBeNull();
        return shown!;
      });
      await pressPointer(confirm.querySelector<HTMLElement>('[data-testid="rebuild-container-confirm"]')!);
      await vi.waitFor(() => expect(document.querySelector('[data-testid="rebuild-container-dialog"][data-state="open"]')).toBeNull());
      await flushPromises();
    };

    vi.mocked(api.rebuildContainer).mockRejectedValueOnce(new Error('ipc'));
    await confirmRebuild();
    expect(dialog().querySelector('[data-testid="rebuild-container-failure"]')!.getAttribute('data-code')).toBe('call');
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog().querySelector('[data-testid="rebuild-container"]')));

    vi.mocked(api.rebuildContainer).mockImplementationOnce(() => new Promise(() => {}));
    await confirmRebuild();
    expect(dialog().querySelector('[data-testid="rebuild-container-steps"]')).toBeNull();
    api.pushHostOperations({ hostId: 'c1', rebuild: { steps: { stopping: 'running', building: 'pending', reconnecting: 'pending' }, log: { lines: [], total: 0 } } });
    await vi.waitFor(() => expect(document.activeElement).toBe(dialog().querySelector('[data-testid="rebuild-container-steps"]')));
  });

  it('opens on the rebuild confirmation from the project menu, and Cancel starts nothing', async () => {
    await openConnect({ hosts: [{ ...CONTAINER, connection: 'connected' }, PROD], hostId: 'c1', card: 'rebuild' });
    const confirm = await vi.waitFor(() => {
      const shown = document.querySelector<HTMLElement>('[data-testid="rebuild-container-dialog"][data-state="open"]');
      expect(shown).not.toBeNull();
      return shown!;
    });
    expect(confirm.textContent).toContain('Nothing runs in web-app-dev now.');
    await pressPointer(confirm.querySelector<HTMLElement>('[data-testid="rebuild-container-cancel"]')!);
    await vi.waitFor(() => expect(document.querySelector('[data-testid="rebuild-container-dialog"][data-state="open"]')).toBeNull());
    expect(api.rebuildContainer).not.toHaveBeenCalled();
  });

  it('offers no rebuild on an attached container', async () => {
    await openConnect({ hosts: [{ ...CONTAINER, container: { ...CONTAINER.container!, origin: 'attach' } }, PROD], hostId: 'c1', card: 'show' });
    await vi.waitFor(() => expect(dialog().querySelector('[data-testid="host-card"]')).not.toBeNull());
    expect(dialog().querySelector('[data-testid="container-rebuild"]')).toBeNull();
  });
});

describe('Containers in the project menu', () => {
  const project = (key: string, extra: Partial<ShellProject> = {}): ShellProject => ({ ...STATE.projects[0]!, key, name: key, fsPath: `C:\\work\\${key}`, authority: { kind: 'local', key: 'local', name: 'This computer' }, connection: 'connected', running: 0, waiting: 0, ...extra });
  const WEB = project('web', { devcontainerConfig: 'C:\\work\\web\\.devcontainer\\devcontainer.json' });
  const PLAIN = project('plain');
  const IN_WSL = project('linux', { fsPath: '\\\\wsl.localhost\\Ubuntu\\home\\me\\linux', wsl: { distro: 'Ubuntu', path: '/home/me/linux' }, devcontainerConfig: '\\\\wsl.localhost\\Ubuntu\\home\\me\\linux\\.devcontainer.json' });
  const INSIDE = project('inside', { fsPath: '/workspaces/web', authority: { kind: 'container', key: 'container+k1', hostId: 'c1', name: 'web-app-dev' } });
  const ATTACHED = project('attached', { fsPath: '/app', authority: { kind: 'container', key: 'container+k2', hostId: 'c2', name: 'api-shell' } });
  const HOSTS: ShellHost[] = [
    { hostId: 'c1', kind: 'container', container: { origin: 'devcontainer' }, authorityKey: 'container+k1', name: 'web-app-dev', connection: 'connected', signInNeeded: false },
    { hostId: 'c2', kind: 'container', container: { origin: 'attach' }, authorityKey: 'container+k2', name: 'api-shell', connection: 'connected', signInNeeded: false },
  ];

  function mountSection(api: FakeShellApi): VueWrapper {
    const groups: ShellProjectGroups = { order: ['local'], collapsed: [] };
    return track(mount(ProjectsSection, {
      props: { api, projects: [WEB, PLAIN, IN_WSL, INSIDE, ATTACHED], selectedKey: 'web', hosts: HOSTS, view: 'flat', groups, platform: 'linux', collapsed: false, bodySize: 300 },
      global: { plugins: [shellI18n], stubs: { transition: false, 'transition-group': false } },
      attachTo: document.body,
    }));
  }
  const menuItems = (api: FakeShellApi): Array<[string, string | undefined]> => {
    const request = api.overlayRequests.at(-1);
    return request?.kind === 'menu' ? request.items.flatMap((item) => (item.kind === 'item' ? [[item.id, item.hint] as [string, string | undefined]] : [])) : [];
  };

  it('offers Reopen in Container for a folder whose configuration main published, and reopens it', async () => {
    const api = fakeShellApi();
    const wrapper = mountSection(api);
    api.answerNext({ kind: 'menu', itemId: 'reopenInContainer' });
    await wrapper.get('[data-project-key="web"]').trigger('contextmenu');
    await flushPromises();
    expect(menuItems(api)).toContainEqual(['reopenInContainer', 'C:\\work\\web\\.devcontainer\\devcontainer.json']);
    expect(api.reopenInContainer).toHaveBeenCalledWith('web');
  });

  it("opens the menu in the same task as the right-click, reading nothing from the project's target", () => {
    const api = fakeShellApi();
    const wrapper = mountSection(api);
    wrapper.get('[data-project-key="web"]').element.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(api.overlayRequests.at(-1)).toMatchObject({ kind: 'menu', label: 'Actions for web' });
    expect(menuItems(api).map(([id]) => id)).toContain('reopenInContainer');
  });

  it('offers no Reopen in Container without a published configuration, or for a folder in WSL', async () => {
    const api = fakeShellApi();
    const wrapper = mountSection(api);
    for (const key of ['plain', 'linux']) {
      await wrapper.get(`[data-project-key="${key}"]`).trigger('contextmenu');
      await flushPromises();
      expect(menuItems(api).map(([id]) => id)).not.toContain('reopenInContainer');
    }
  });

  it('asks nothing about a container project and offers Rebuild Container only on a dev container', async () => {
    const api = fakeShellApi();
    const wrapper = mountSection(api);
    api.answerNext({ kind: 'menu', itemId: 'rebuildContainer' });
    await wrapper.get('[data-project-key="inside"]').trigger('contextmenu');
    await flushPromises();
    expect(menuItems(api).map(([id]) => id)).toContain('rebuildContainer');
    expect(menuItems(api).map(([id]) => id)).not.toContain('reopenInContainer');
    expect(api.rebuildContainer).toHaveBeenCalledWith('inside');
    await wrapper.get('[data-project-key="attached"]').trigger('contextmenu');
    await flushPromises();
    expect(menuItems(api).map(([id]) => id)).not.toContain('rebuildContainer');
  });

  it('says a refused reopen under the list', async () => {
    const api = fakeShellApi();
    vi.mocked(api.reopenInContainer).mockResolvedValueOnce({ ok: false, code: 'noDevcontainerConfig' });
    const wrapper = mountSection(api);
    api.answerNext({ kind: 'menu', itemId: 'reopenInContainer' });
    await wrapper.get('[data-project-key="web"]').trigger('contextmenu');
    await flushPromises();
    const refusal = wrapper.get('[data-testid="projects-refusal"]');
    expect(refusal.attributes('data-code')).toBe('noDevcontainerConfig');
    expect(refusal.text()).toBe('web has no dev container configuration any more.');
  });
});
