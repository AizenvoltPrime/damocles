// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { ShellProject, ShellState } from '../../preload/shell-channels';
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

const remote = (name: string, color?: 'danger' | 'info'): ShellProject => ({
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
    const label = wrapper.get('[data-testid="title-bar-stripe-label"]');
    expect(label.classes()).toEqual(expect.arrayContaining(['d-tone-danger', 'bg-(--tone)', 'text-(--tone-on)']));
    expect(label.text()).toContain('prod-1');
    await wrapper.setProps({ state: onRemote(remote('prod-eu', 'danger')) });
    expect(wrapper.get('[data-testid="title-bar-stripe-label"]').text()).toContain('prod-eu');
    expect(wrapper.get('[data-testid="title-bar-stripe-label"]').text()).not.toContain('prod-1');
  });

  it('fades the old stripe and label out as the new ones fade in when the selection or the color changes', async () => {
    const wrapper = track(mount(TitleBar, { props: { api: fakeShellApi(), state: onRemote(remote('prod-1', 'danger')) }, global: { plugins: [shellI18n], stubs: { transition: false } }, attachTo: document.body }));
    const stripes = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="title-bar-stripe"]')];
    const labels = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-testid="title-bar-stripe-label"]')];
    const first = stripes()[0]!;
    expect(first.className).toContain('animate-[d-fade_.3s_var(--ease-out)]');
    await wrapper.setProps({ state: onRemote(remote('prod-1', 'info')) });
    expect(stripes().map((stripe) => [stripe.dataset.tone, stripe.className.includes('o-fade-out') ? 'out' : stripe.className.includes('d-fade') ? 'in' : 'rest'])).toEqual([['danger', 'out'], ['info', 'in']]);
    await vi.waitFor(() => expect(stripes()).toHaveLength(1));
    expect(stripes()[0]).not.toBe(first);
    expect(stripes()[0]!.dataset.tone).toBe('info');
    await vi.waitFor(() => expect(labels().map((label) => label.dataset.tone)).toEqual(['info']));
    // selecting a project with no colored host fades both out rather than dropping them
    await wrapper.setProps({ state: STATE });
    expect(stripes()[0]!.className).toContain('animate-[o-fade-out_.3s_ease-in_both]');
    expect(labels()[0]!.className).toContain('animate-[o-fade-out_.14s_ease-in_both]');
    await vi.waitFor(() => expect([...stripes(), ...labels()]).toEqual([]));
  });

  it('shows no stripe for a local project or a host without a color', async () => {
    const wrapper = track(mount(TitleBar, { props: { api: fakeShellApi(), state: STATE }, global: { plugins: [shellI18n] } }));
    expect(wrapper.find('[data-testid="title-bar-stripe"]').exists()).toBe(false);
    await wrapper.setProps({ state: onRemote(remote('prod-1')) });
    expect(wrapper.find('[data-testid="title-bar-stripe"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="title-bar-stripe-label"]').exists()).toBe(false);
  });
});

describe('host badge tone', () => {
  const mountProjects = (project: ShellProject): VueWrapper => track(mount(ProjectsSection, {
    props: { api: fakeShellApi(), projects: [project], selectedKey: project.key, remoteEnabled: true, hosts: [], view: 'flat', groups: STATE.projectGroups, platform: 'win32', collapsed: false, bodySize: 150 },
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
