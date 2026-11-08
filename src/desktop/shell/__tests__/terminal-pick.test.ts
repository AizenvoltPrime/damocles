// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia } from 'pinia';
import type { OverlayRequest } from '../../preload/overlay-channels';
import type { TerminalProfileOption, TerminalProjectOption } from '../../preload/terminal-channels';
import OverlayApp from '../overlay/OverlayApp.vue';
import { TERMINAL_HOME_ROW } from '../overlay/quick-pick';
import { loadShellLocale, shellI18n } from '../i18n';
import { canonicalHostColor } from '../../../shared/host-colors';
import { createOverlaySettingsBridge } from '../overlay/settings/overlay-bridge';
import { FakeResizeObserver, fakeOverlayApi, opened, type FakeOverlayApi } from './fakes';

const mounted: VueWrapper[] = [];
let api: FakeOverlayApi;

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  api = fakeOverlayApi();
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

async function openPick(projects: TerminalProjectOption[]): Promise<VueWrapper> {
  const wrapper = mount(OverlayApp, {
    props: { api, settingsBridge: createOverlaySettingsBridge(api) },
    global: { plugins: [shellI18n, createPinia()], stubs: { transition: false, 'transition-group': false } },
    attachTo: document.body,
  });
  mounted.push(wrapper);
  await flushPromises();
  const request: OverlayRequest = { kind: 'newTerminal', projects };
  api.request('t1', request);
  await flushPromises();
  return wrapper;
}

const project = (key: string, name: string, extra: Partial<TerminalProjectOption> = {}): TerminalProjectOption => ({
  key, name, path: `/work/${name}`, current: false, authority: { kind: 'local' }, reachable: true, ...extra,
});
const PROD = { kind: 'ssh', name: 'prod', color: 'danger' } as const;
const ALPHA = project('c:\\alpha', 'alpha');
const BETA = project('c:\\beta', 'beta', { current: true });
const API = project('ssh+h1|/srv/api', 'api', { authority: PROD });
const WEB = project('ssh+h2|/srv/web', 'web', { authority: { kind: 'ssh', name: 'lab' }, reachable: false });
const shell = (id: string, isDefault = false): TerminalProfileOption => ({ id, name: id, path: `/bin/${id}`, args: [], source: 'detected', icon: 'bash', customIcon: null, color: null, isDefault });

const pick = (wrapper: VueWrapper) => wrapper.get('[data-pick="terminal"]');
const rows = (wrapper: VueWrapper) => wrapper.findAll('[data-testid="quick-pick-item"]');
const row = (wrapper: VueWrapper, id: string) => wrapper.get(`[data-testid="quick-pick-item"][data-item-id="${CSS.escape(id)}"]`);
const input = (wrapper: VueWrapper) => wrapper.get('[data-testid="quick-pick-input"]');
const activeId = (wrapper: VueWrapper) => wrapper.find('[data-testid="quick-pick-item"][aria-selected="true"]').attributes('data-item-id');

describe('the New Terminal pick', () => {
  it('lists the projects first, under the sidebar\'s host headings, starting on the current project', async () => {
    const wrapper = await openPick([ALPHA, BETA, API, WEB]);
    expect(pick(wrapper).attributes('data-step')).toBe('project');
    expect(wrapper.findAll('[data-testid="quick-pick-group"]').map((group) => group.text())).toEqual(['This computer', 'prod', 'lab']);
    expect(rows(wrapper).map((item) => item.attributes('data-item-id'))).toEqual([ALPHA.key, BETA.key, API.key, WEB.key]);
    expect(activeId(wrapper)).toBe(BETA.key);
    expect(row(wrapper, BETA.key).text()).toContain('Current');
    expect(wrapper.get('[data-testid="quick-pick-hint"]').text()).toBe('Shift+Enter starts the host\'s default shell');
    // a host that is not connected: listed, greyed, saying why
    expect(row(wrapper, WEB.key).attributes('aria-disabled')).toBe('true');
    expect(row(wrapper, WEB.key).text()).toContain('Not connected');
    expect(rows(wrapper).filter((item) => item.attributes('aria-disabled') === 'true')).toHaveLength(1);
  });

  it('draws a host\'s custom colour as a dot through d-tone-custom on the muted folder icon', async () => {
    const tinted = project('wsl+U|/web', 'web', { authority: { kind: 'wsl', name: 'Ubuntu', color: canonicalHostColor('#ffffff40')! } });
    const wrapper = await openPick([ALPHA, tinted]);
    const dot = row(wrapper, tinted.key).get('[data-testid="quick-pick-icon-dot"]');
    expect(dot.classes()).toEqual(expect.arrayContaining(['d-tone-custom', 'bg-(--tone)']));
    expect(dot.attributes('style')).toContain('--host-alpha: 0.25');
    expect(row(wrapper, ALPHA.key).find('[data-testid="quick-pick-icon-dot"]').exists()).toBe(false);
  });

  it('shows no headings while the projects are all on one host', async () => {
    const wrapper = await openPick([ALPHA, BETA]);
    expect(wrapper.findAll('[data-testid="quick-pick-group"]')).toHaveLength(0);
  });

  it('then lists the chosen project\'s host\'s shells, default first, and answers with the shell picked', async () => {
    let resolve!: (value: TerminalProfileOption[]) => void;
    api.terminalPick.answer = (projectKey) => (projectKey === API.key ? new Promise((done) => (resolve = done)).then((listed) => opened({ kind: 'shells', profiles: listed as TerminalProfileOption[] })) : Promise.resolve(opened({ kind: 'shells', profiles: [] })));
    const wrapper = await openPick([ALPHA, BETA, API]);
    await row(wrapper, API.key).trigger('click');
    await flushPromises();
    expect(pick(wrapper).attributes('data-step')).toBe('profile');
    expect(api.terminalPickProfiles).toHaveBeenCalledWith({ projectKey: API.key });
    expect(wrapper.get('[data-testid="quick-pick-empty"]').text()).toBe('Detecting shells…');
    expect(wrapper.get('[data-testid="quick-pick-scope"]').attributes('title')).toBe('api · prod');
    expect(input(wrapper).attributes('placeholder')).toBe('Select a shell on prod');
    resolve([shell('zsh', true), shell('bash')]);
    await flushPromises();
    expect(rows(wrapper).map((item) => [item.attributes('data-item-id'), item.text().includes('Default')])).toEqual([['zsh', true], ['bash', false]]);
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'newTerminal', projectKey: API.key, profileId: 'bash' }));
    expect(api.terminalPickProfiles).toHaveBeenCalledTimes(1);
  });

  it('starts the host\'s default shell on Shift+Enter or Shift+click, with no shell step', async () => {
    const wrapper = await openPick([ALPHA, BETA, API]);
    await input(wrapper).trigger('keydown', { key: 'Enter', shiftKey: true });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'newTerminal', projectKey: BETA.key, profileId: null }));
    expect(api.terminalPickProfiles).not.toHaveBeenCalled();

    api.request('t2', { kind: 'newTerminal', projects: [ALPHA, BETA, API] });
    await flushPromises();
    await row(wrapper, API.key).trigger('click', { shiftKey: true });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t2', { kind: 'newTerminal', projectKey: API.key, profileId: null }));
  });

  it('takes no disabled row: Enter and a click on a project whose host is not connected do nothing', async () => {
    const wrapper = await openPick([ALPHA, WEB]);
    await row(wrapper, WEB.key).trigger('click');
    await input(wrapper).trigger('keydown', { key: 'ArrowDown' });
    expect(activeId(wrapper)).toBe(WEB.key);
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await input(wrapper).trigger('keydown', { key: 'Enter', shiftKey: true });
    await flushPromises();
    expect(pick(wrapper).attributes('data-step')).toBe('project');
    expect(api.answer).not.toHaveBeenCalled();
  });

  it('offers the home folder on this computer while no project is reachable, and starts there', async () => {
    api.terminalPick.answer = async () => opened({ kind: 'shells', profiles: [shell('pwsh', true)] });
    const wrapper = await openPick([WEB]);
    expect(wrapper.findAll('[data-testid="quick-pick-group"]').map((group) => group.text())).toEqual(['This computer', 'lab']);
    expect(rows(wrapper).map((item) => item.attributes('data-item-id'))).toEqual([TERMINAL_HOME_ROW, WEB.key]);
    expect(activeId(wrapper)).toBe(TERMINAL_HOME_ROW);
    expect(row(wrapper, TERMINAL_HOME_ROW).text()).toContain('Home folder');
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.terminalPickProfiles).toHaveBeenCalledWith({ projectKey: null });
    await input(wrapper).trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'newTerminal', projectKey: null, profileId: 'pwsh' }));
  });

  it('skips the project step with one reachable project, and with none open (the home folder)', async () => {
    api.terminalPick.answer = async () => opened({ kind: 'shells', profiles: [shell('pwsh', true)] });
    const one = await openPick([ALPHA]);
    expect(pick(one).attributes('data-step')).toBe('profile');
    expect(api.terminalPickProfiles).toHaveBeenLastCalledWith({ projectKey: ALPHA.key });
    expect(one.find('[data-testid="quick-pick-scope"]').exists()).toBe(false);
    expect(input(one).attributes('placeholder')).toBe('Select a shell on this computer');
    one.unmount();
    mounted.length = 0;

    const none = await openPick([]);
    expect(pick(none).attributes('data-step')).toBe('profile');
    expect(api.terminalPickProfiles).toHaveBeenLastCalledWith({ projectKey: null });
    await input(none).trigger('keydown', { key: 'Enter' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'newTerminal', projectKey: null, profileId: 'pwsh' }));
  });

  it('says no shell was found on the host when its list is empty, and Escape cancels', async () => {
    const wrapper = await openPick([ALPHA, API]);
    await row(wrapper, API.key).trigger('click');
    await flushPromises();
    const failed = wrapper.get('[data-testid="quick-pick-failed"]');
    expect(failed.text()).toBe('No shells were found on prod.');
    expect(failed.attributes('role')).toBe('alert');
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'dismissed' }));

    api.request('t2', { kind: 'newTerminal', projects: [ALPHA] });
    await flushPromises();
    expect(wrapper.get('[data-testid="quick-pick-failed"]').text()).toBe('No shells were found on this computer.');
  });

  it('says the shells could not be loaded when the fetch fails, and that the host went away when main says so', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    api.terminalPick.answer = () => Promise.reject(new Error('the host went away'));
    const wrapper = await openPick([ALPHA, API]);
    await row(wrapper, API.key).trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="quick-pick-failed"]').text()).toBe('The shells of prod could not be loaded.');
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t1', { kind: 'dismissed' }));

    api.request('t2', { kind: 'newTerminal', projects: [ALPHA] });
    await flushPromises();
    expect(wrapper.get('[data-testid="quick-pick-failed"]').text()).toBe('The shells of this computer could not be loaded.');
    await input(wrapper).trigger('keydown', { key: 'Escape' });
    await vi.waitFor(() => expect(api.answer).toHaveBeenCalledWith('t2', { kind: 'dismissed' }));

    api.terminalPick.answer = async () => opened({ kind: 'notConnected' });
    api.request('t3', { kind: 'newTerminal', projects: [ALPHA, API] });
    await flushPromises();
    await row(wrapper, API.key).trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="quick-pick-failed"]').text()).toBe('prod is not connected.');
  });

  // Greek has no grammatical "on {host}" for this computer's heading, so a local project's shell step has its own text.
  it('names this computer in its own words on a local project\'s shell step, in Greek too', async () => {
    const wrapper = await openPick([ALPHA, API]);
    await loadShellLocale('el');
    shellI18n.global.locale.value = 'el';
    await row(wrapper, ALPHA.key).trigger('click');
    await flushPromises();
    expect(input(wrapper).attributes('placeholder')).toBe('Επιλέξτε κέλυφος σε αυτόν τον υπολογιστή');
    expect(wrapper.get('[data-testid="quick-pick-failed"]').text()).toBe('Δεν βρέθηκαν κελύφη σε αυτόν τον υπολογιστή.');
  });

  it('announces Detecting shells… through a live region present from the start, not one inserted with its text', async () => {
    api.terminalPick.answer = () => new Promise(() => undefined);
    const wrapper = await openPick([ALPHA, API]);
    const status = wrapper.get('[data-testid="quick-pick-status"]');
    expect(status.attributes('role')).toBe('status');
    expect(status.text()).toBe('');
    await row(wrapper, API.key).trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-testid="quick-pick-status"]').element).toBe(status.element);
    expect(status.text()).toBe('Detecting shells…');
  });

  it('filters the projects in place, keeping each heading above its first match', async () => {
    const wrapper = await openPick([ALPHA, BETA, API]);
    await input(wrapper).setValue('api');
    await flushPromises();
    expect(wrapper.findAll('[data-testid="quick-pick-group"]').map((group) => group.text())).toEqual(['prod']);
    expect(rows(wrapper).map((item) => item.attributes('data-item-id'))).toEqual([API.key]);
    expect(activeId(wrapper)).toBe(API.key);
  });
});
