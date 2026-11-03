// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ShellProject, ShellState } from '../../preload/shell-channels';
import { canonicalHostColor, type HostColor } from '@shared/host-colors';
import TitleBar from '../components/TitleBar.vue';
import ProjectsSection from '../components/ProjectsSection.vue';
import GitConsentDialog from '../overlay/components/GitConsentDialog.vue';
import { shellI18n } from '../i18n';
import { FakeResizeObserver, STATE, fakeShellApi } from './fakes';

const mounted: VueWrapper[] = [];
const track = (wrapper: VueWrapper): VueWrapper => {
  mounted.push(wrapper);
  return wrapper;
};

beforeEach(() => {
  setActivePinia(createPinia());
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const remote = (name: string, color?: HostColor): ShellProject => ({
  key: 'ssh+h1|/srv/api',
  name: 'api',
  fsPath: '/srv/api',
  trusted: true,
  authority: { kind: 'ssh', key: 'ssh+h1', hostId: 'h1', name, ...(color ? { color } : {}) },
  platform: 'linux',
  connection: 'connected',
  trash: false,
  running: 0,
  waiting: 0,
});

const onRemote = (project: ShellProject): ShellState => ({ ...STATE, projects: [...STATE.projects, project], selected: { projectKey: project.key } });

describe('title bar safety stripe', () => {
  it('shows the colored host\'s stripe and its name on the solid fill, and renames it at once', async () => {
    const wrapper = track(mount(TitleBar, { props: { api: fakeShellApi(), state: onRemote(remote('prod-1', 'danger')) }, global: { plugins: [shellI18n] } }));
    const stripe = wrapper.get('[data-testid="title-bar-stripe"]');
    expect(stripe.attributes('data-tone')).toBe('danger');
    expect(stripe.classes()).toContain('d-tone-danger');
    const name = wrapper.get('[data-testid="title-bar-host-name"]');
    expect(name.classes()).toEqual(expect.arrayContaining(['d-tone-danger', 'bg-(--tone)', 'text-(--tone-on)']));
    expect(name.text()).toBe('prod-1');
    await wrapper.setProps({ state: onRemote(remote('prod-eu', 'danger')) });
    expect(wrapper.get('[data-testid="title-bar-host-name"]').text()).toBe('prod-eu');
  });

  it('paints a custom color on the stripe and the chip through d-tone-custom and the color channels', async () => {
    const wrapper = track(mount(TitleBar, { props: { api: fakeShellApi(), state: onRemote(remote('prod-1', canonicalHostColor('#00808099')!)) }, global: { plugins: [shellI18n] } }));
    const stripe = wrapper.get<HTMLElement>('[data-testid="title-bar-stripe"]');
    const chip = wrapper.get<HTMLElement>('[data-testid="title-bar-host"]');
    const name = wrapper.get<HTMLElement>('[data-testid="title-bar-host-name"]');
    expect([stripe.attributes('data-tone'), chip.attributes('data-tone')]).toEqual(['custom', 'custom']);
    expect(stripe.classes()).toContain('d-tone-custom');
    expect(name.classes()).toEqual(expect.arrayContaining(['d-tone-custom', 'bg-(--tone)', 'text-(--tone-on)']));
    for (const painted of [stripe, name]) {
      expect(painted.element.style.getPropertyValue('--host-rgb')).toBe('0 128 128');
      expect(painted.element.style.getPropertyValue('--host-alpha')).toBe('0.6');
    }
  });

  it('eases a recolor in place, and fades the old stripe and chip out as the new ones fade in when the selection changes', async () => {
    const wrapper = track(mount(TitleBar, { props: { api: fakeShellApi(), state: onRemote(remote('prod-1', 'danger')) }, global: { plugins: [shellI18n], stubs: { transition: false } }, attachTo: document.body }));
    const stripes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="title-bar-stripe"]')];
    const chips = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="title-bar-host"]')];
    const phase = (element: HTMLElement): string => (element.className.includes('o-fade-out') ? 'out' : element.className.includes('d-fade') ? 'in' : 'rest');
    const first = stripes()[0]!;
    const chip = chips()[0]!;
    expect(first.className).toContain('animate-[d-fade_.3s_var(--ease-out)]');
    expect(first.className).toContain('transition-[background-color] duration-300 ease-out');
    expect(chip.querySelector('[data-testid="title-bar-host-name"]')!.className).toContain('transition-[background-color,color] duration-300 ease-out');
    await wrapper.setProps({ state: onRemote(remote('prod-1', canonicalHostColor('#00808099')!)) });
    expect(stripes()).toEqual([first]);
    expect(chips()).toEqual([chip]);
    expect([first.dataset.tone, chip.dataset.tone]).toEqual(['custom', 'custom']);
    // another host's project fades the old stripe and chip out
    const lab: ShellProject = { ...remote('lab', 'info'), key: 'ssh+h2|/srv/api', authority: { kind: 'ssh', key: 'ssh+h2', hostId: 'h2', name: 'lab', color: 'info' } };
    await wrapper.setProps({ state: onRemote(lab) });
    expect(stripes().map((stripe) => [stripe.dataset.tone, phase(stripe)])).toEqual([['custom', 'out'], ['info', 'in']]);
    await vi.waitFor(() => expect(stripes()).toHaveLength(1));
    expect(stripes()[0]!.dataset.tone).toBe('info');
    await vi.waitFor(() => expect(chips().map((element) => element.dataset.tone)).toEqual(['info']));
    // a color added to an uncolored host changes the chip's size, so it fades
    const filledChip = chips()[0]!;
    await wrapper.setProps({ state: onRemote({ ...lab, authority: { kind: 'ssh', key: 'ssh+h2', hostId: 'h2', name: 'lab' } }) });
    expect(phase(filledChip)).toBe('out');
    await vi.waitFor(() => expect(chips().map((element) => element.dataset.tone)).toEqual([undefined]));
    // selecting a project with no colored host fades both out rather than dropping them
    await wrapper.setProps({ state: onRemote(lab) });
    await vi.waitFor(() => expect(stripes()).toHaveLength(1));
    await wrapper.setProps({ state: STATE });
    expect(stripes()[0]!.className).toContain('animate-[o-fade-out_.3s_ease-in_both]');
    expect(chips()[0]!.className).toContain('animate-[o-fade-out_.14s_ease-in_both]');
    await vi.waitFor(() => expect([...stripes(), ...chips()]).toEqual([]));
  });

  it('shows no stripe for a local project or a host without a color; the uncolored host keeps its chip, untinted', async () => {
    const wrapper = track(mount(TitleBar, { props: { api: fakeShellApi(), state: STATE }, global: { plugins: [shellI18n] } }));
    expect(wrapper.find('[data-testid="title-bar-stripe"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="title-bar-host"]').exists()).toBe(false);
    await wrapper.setProps({ state: onRemote(remote('prod-1')) });
    expect(wrapper.find('[data-testid="title-bar-stripe"]').exists()).toBe(false);
    const name = wrapper.get('[data-testid="title-bar-host-name"]');
    expect(name.text()).toBe('prod-1');
    expect(name.classes().some((name) => name.startsWith('d-tone-'))).toBe(false);
  });
});

describe('title bar host chip', () => {
  it('is a button named by the host\'s state that opens its card under itself, and shows it expanded meanwhile', async () => {
    const api = fakeShellApi();
    let closeCard!: () => void;
    vi.mocked(api.showHostCard).mockImplementation(() => new Promise<void>((resolve) => (closeCard = resolve)));
    const latency = { latencyMs: 38, slow: false, history: [38], measurements: 1 };
    const state: ShellState = { ...onRemote(remote('prod-1', 'danger')), hosts: [{ hostId: 'h1', kind: 'ssh', authorityKey: 'ssh+h1', name: 'prod-1', color: 'danger', connection: 'connected', signInNeeded: false, latency }] };
    const wrapper = track(mount(TitleBar, { props: { api, state }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    const chip = wrapper.get<HTMLButtonElement>('button[data-testid="title-bar-host"]');
    expect(chip.attributes('aria-haspopup')).toBe('dialog');
    expect(chip.attributes('aria-expanded')).toBe('false');
    expect(chip.get('[data-testid="host-status-dot"]').attributes('aria-label')).toBe('prod-1 · 38 ms');
    expect(chip.get('[data-testid="title-bar-host-name"]').attributes('aria-hidden')).toBe('true');
    chip.element.getBoundingClientRect = () => ({ left: 120, top: 6, width: 90, height: 28, right: 210, bottom: 34, x: 120, y: 6, toJSON: () => ({}) });
    await chip.trigger('click');
    expect(api.showHostCard).toHaveBeenCalledWith('h1', { x: 120, y: 6, width: 90, height: 28 });
    expect(chip.attributes('aria-expanded')).toBe('true');
    // a second click while the card is up opens no second one
    await chip.trigger('click');
    expect(api.showHostCard).toHaveBeenCalledTimes(1);
    closeCard();
    await flushPromises();
    expect(chip.attributes('aria-expanded')).toBe('false');
  });
});

describe('host details from the Projects list', () => {
  const HOST = { hostId: 'h1', kind: 'ssh', authorityKey: 'ssh+h1', name: 'prod-1', connection: 'connected', signInNeeded: false } as const;
  const mountList = (api: ReturnType<typeof fakeShellApi>, view: 'flat' | 'grouped'): VueWrapper => track(mount(ProjectsSection, {
    props: { api, projects: [remote('prod-1')], selectedKey: undefined, hosts: [HOST], view, groups: { order: ['ssh+h1'], collapsed: [] }, platform: 'win32', collapsed: false, bodySize: 150 },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  }));

  const RECT = { x: 160, y: 72, width: 64, height: 18 };
  // the element the card should hang from, at RECT, where the row around it is elsewhere
  const placeAt = (element: Element): void => {
    element.getBoundingClientRect = () => ({ left: RECT.x, top: RECT.y, width: RECT.width, height: RECT.height, right: RECT.x + RECT.width, bottom: RECT.y + RECT.height, x: RECT.x, y: RECT.y, toJSON: () => ({}) });
  };
  const HOST_ELEMENT = { flat: '[data-testid="host-badge"]', grouped: '[data-testid="project-group-host-details"]' } as const;

  it('opens the host\'s card under a flat row\'s badge without selecting the row', async () => {
    const api = fakeShellApi();
    const wrapper = mountList(api, 'flat');
    const badge = wrapper.get('[data-testid="host-badge"]');
    expect(badge.classes()).toContain('cursor-pointer');
    placeAt(badge.element);
    await badge.trigger('click');
    expect(api.showHostCard).toHaveBeenCalledWith('h1', RECT);
    expect(api.selectProject).not.toHaveBeenCalled();
  });

  it('opens it from a group header\'s dot without toggling the group', async () => {
    const api = fakeShellApi();
    const wrapper = mountList(api, 'grouped');
    const dot = wrapper.get('[data-testid="project-group-host-details"]');
    placeAt(dot.element);
    await dot.trigger('click');
    expect(api.showHostCard).toHaveBeenCalledWith('h1', RECT);
    expect(api.setProjectGroupCollapsed).not.toHaveBeenCalled();
  });

  it.each(['flat', 'grouped'] as const)('asks main once for a double click in the %s view, and again once the card closed', async (view) => {
    const api = fakeShellApi();
    let closeCard!: () => void;
    vi.mocked(api.showHostCard).mockImplementation(() => new Promise<void>((resolve) => (closeCard = resolve)));
    const wrapper = mountList(api, view);
    const target = wrapper.get(HOST_ELEMENT[view]);
    await target.trigger('click');
    await target.trigger('click');
    expect(api.showHostCard).toHaveBeenCalledTimes(1);
    closeCard();
    await flushPromises();
    await target.trigger('click');
    expect(api.showHostCard).toHaveBeenCalledTimes(2);
  });

  it('logs a refused card request rather than leave it unhandled, and opens the next one', async () => {
    const api = fakeShellApi();
    const error = new Error('Malformed host card request');
    vi.mocked(api.showHostCard).mockRejectedValueOnce(error);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapper = mountList(api, 'flat');
    await wrapper.get('[data-testid="host-badge"]').trigger('click');
    await flushPromises();
    expect(logged).toHaveBeenCalledWith('[projects] opening the host card failed', error);
    await wrapper.get('[data-testid="host-badge"]').trigger('click');
    expect(api.showHostCard).toHaveBeenCalledTimes(2);
    logged.mockRestore();
  });

  it('leaves a click on the badge of a host with no saved record to the row', async () => {
    const api = fakeShellApi();
    const loopback: ShellProject = { ...remote('Local daemon'), key: 'loopback|/srv/api', authority: { kind: 'loopback', key: 'loopback', name: 'Local daemon' } };
    const wrapper = track(mount(ProjectsSection, {
      props: { api, projects: [loopback], selectedKey: undefined, hosts: [], view: 'flat', groups: { order: ['loopback'], collapsed: [] }, platform: 'win32', collapsed: false, bodySize: 150 },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    }));
    const badge = wrapper.get('[data-testid="host-badge"]');
    expect(badge.classes()).not.toContain('cursor-pointer');
    await badge.trigger('click');
    expect(api.showHostCard).not.toHaveBeenCalled();
    expect(api.selectProject).toHaveBeenCalledWith('loopback|/srv/api');
  });

  it.each(['flat', 'grouped'] as const)('offers Details for the host in the %s view\'s menu, the keyboard\'s way to the card', async (view) => {
    const api = fakeShellApi();
    vi.mocked(api.requestOverlay).mockResolvedValue({ kind: 'menu', itemId: 'hostDetails' });
    const wrapper = mountList(api, view);
    placeAt(wrapper.get(HOST_ELEMENT[view]).element);
    const target = view === 'flat' ? '[data-project-key="ssh+h1|/srv/api"]' : '[data-testid="project-group-header"]';
    await wrapper.get(target).trigger('contextmenu', { clientX: 5, clientY: 5 });
    await flushPromises();
    const menu = vi.mocked(api.requestOverlay).mock.calls[0]![0];
    expect(menu.kind === 'menu' && menu.items.find((item) => item.kind === 'item' && item.id === 'hostDetails')).toMatchObject({ label: 'Details for prod-1', icon: 'server' });
    expect(api.showHostCard).toHaveBeenCalledWith('h1', RECT);
  });
});

describe('host badge tone', () => {
  const mountProjects = (project: ShellProject): VueWrapper => track(mount(ProjectsSection, {
    props: { api: fakeShellApi(), projects: [project], selectedKey: project.key, hosts: [], view: 'flat', groups: STATE.projectGroups, platform: 'win32', collapsed: false, bodySize: 150 },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  }));

  it('tints a project row\'s host badge with the host\'s tone, and keeps an uncolored host muted', () => {
    expect(mountProjects(remote('prod-1', 'danger')).get('[data-testid="host-badge"]').classes()).toContain('d-tone-danger');
    const plain = mountProjects(remote('lab')).get('[data-testid="host-badge"]').classes();
    expect(plain).toContain('d-tone-muted');
    expect(plain.some((name) => name === 'd-tone-danger')).toBe(false);
  });
});

describe('git credential consent', () => {
  const request = { kind: 'gitCredentialConsent' as const, hostName: 'prod-1', hostColor: 'danger' as const, credentialHost: 'github.com', targetHelper: false };
  const mountConsent = async (overrides: Partial<typeof request> = {}): Promise<VueWrapper> => {
    const wrapper = track(mount(GitConsentDialog, { props: { request: { ...request, ...overrides } }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    return wrapper;
  };
  const dialog = (): HTMLElement => document.querySelector<HTMLElement>('[data-testid="git-consent"]')!;

  it('names both hosts, the target in its safety color, and focuses Deny first', async () => {
    await mountConsent();
    expect(dialog().getAttribute('role')).toBe('alertdialog');
    expect(document.getElementById(dialog().getAttribute('aria-labelledby')!)!.textContent?.trim()).toBe('prod-1 wants to use your saved credentials for github.com');
    const host = dialog().querySelector<HTMLElement>('[data-testid="git-consent-host"]')!;
    expect(host.dataset.tone).toBe('danger');
    expect(host.classList.contains('d-tone-danger')).toBe(true);
    expect(dialog().textContent).toContain('github.com');
    expect([...dialog().querySelectorAll('button')].map((button) => button.textContent?.trim())).toEqual(['Deny', 'Always for prod-1', 'Allow once']);
    expect(document.activeElement?.textContent?.trim()).toBe('Deny');
    expect(dialog().querySelector('[data-testid="git-consent-helper-warning"]')).toBeNull();
  });

  it('warns when the target has a credential helper of its own', async () => {
    await mountConsent({ targetHelper: true });
    expect(dialog().querySelector('[data-testid="git-consent-helper-warning"]')!.textContent).toContain('prod-1 has a git credential helper of its own, so git will also save this credential on prod-1.');
  });

  it.each([['Allow once', 'once'], ['Always for prod-1', 'always'], ['Deny', 'deny']] as const)('answers %s as %s', async (label, choice) => {
    const wrapper = await mountConsent();
    [...dialog().querySelectorAll<HTMLElement>('button')].find((button) => button.textContent?.trim() === label)!.click();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'gitCredentialConsent', choice }]]);
  });

  it('denies on Escape', async () => {
    const wrapper = await mountConsent();
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(wrapper.emitted('answer')).toEqual([[{ kind: 'gitCredentialConsent', choice: 'deny' }]]);
  });
});
