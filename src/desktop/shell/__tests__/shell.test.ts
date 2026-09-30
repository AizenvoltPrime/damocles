// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { ContentBounds, DamoclesShellApi, ShellState, ShellTab, ShellToast } from '../../preload/shell-channels';
import App from '../App.vue';
import TabStrip from '../components/TabStrip.vue';
import ProjectList from '../components/ProjectList.vue';
import ToastRegion from '../components/ToastRegion.vue';
import { shellI18n } from '../i18n';
import { watchContentBounds } from '../content-bounds';

function fakeApi(overrides: Partial<DamoclesShellApi> = {}): DamoclesShellApi & { toast: (t: ShellToast) => void; dismiss: (id: string) => void; push: (s: ShellState) => void; focusStrip: () => void } {
  const toastListeners = new Set<(t: ShellToast) => void>();
  const dismissListeners = new Set<(id: string) => void>();
  const stateListeners = new Set<(s: ShellState) => void>();
  const focusListeners = new Set<() => void>();
  return {
    getState: vi.fn(async () => STATE),
    onState: vi.fn((listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); }),
    addProject: vi.fn(async () => {}),
    removeProject: vi.fn(async () => ({ ok: true as const })),
    selectProject: vi.fn(async () => {}),
    grantTrust: vi.fn(async () => {}),
    newTab: vi.fn(async () => {}),
    selectTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    moveTab: vi.fn(async () => {}),
    togglePane: vi.fn(async () => {}),
    reportContentBounds: vi.fn(),
    onToast: vi.fn((listener) => { toastListeners.add(listener); return () => toastListeners.delete(listener); }),
    onToastDismiss: vi.fn((listener) => { dismissListeners.add(listener); return () => dismissListeners.delete(listener); }),
    resolveToast: vi.fn(),
    onFocusTabStrip: vi.fn((listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); }),
    focusStrip: () => { for (const l of focusListeners) l(); },
    toast: (t) => { for (const l of toastListeners) l(t); },
    dismiss: (id) => { for (const l of dismissListeners) l(id); },
    push: (s) => { for (const l of stateListeners) l(s); },
    ...overrides,
  };
}

const TABS: ShellTab[] = [
  { id: 'a', title: 'Fix login', projectKey: 'p1', projectName: 'alpha' },
  { id: 'b', title: '', projectKey: 'p2', projectName: 'beta', busy: true },
  { id: 'c', title: 'Example' },
];

const STATE: ShellState = {
  locale: 'en',
  platform: 'win32',
  projects: [
    { key: 'p1', name: 'alpha', fsPath: '/w/alpha', trusted: true, isDefault: true },
    { key: 'p2', name: 'beta', fsPath: '/w/beta', trusted: false, isDefault: false },
  ],
  tabs: TABS,
  selectedTabId: 'a',
  paneShortcutLabel: 'Ctrl+Shift+B',
};

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(element: Element): void {
    this.observed.push(element);
  }
  disconnect(): void {
    this.observed = [];
  }
}

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

function mountStrip(api: DamoclesShellApi, tabs: ShellTab[] = TABS, selectedTabId = 'a') {
  return mount(TabStrip, {
    props: { api, tabs, selectedTabId, platform: 'win32' },
    global: { plugins: [shellI18n] },
    attachTo: document.body,
  });
}

describe('tab strip', () => {
  it('follows the WAI-ARIA tabs pattern with one tabbable tab', () => {
    const wrapper = mountStrip(fakeApi());
    const tabs = wrapper.findAll('[role="tab"]');

    expect(wrapper.find('[role="tablist"]').attributes('aria-label')).toBe('Open tabs');
    expect(tabs.map((tab) => tab.attributes('aria-label'))).toEqual(['Fix login, alpha', 'New conversation, beta, working', 'Example']);
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(tabs[0]!.attributes('aria-controls')).toBe('shell-tabpanel');
    expect(wrapper.find('img').exists()).toBe(false);
  });

  it('moves focus with arrows, Home and End without selecting', async () => {
    const api = fakeApi();
    const wrapper = mountStrip(api);
    const tab = (i: number) => wrapper.findAll('[role="tab"]')[i]!;

    await tab(0).trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('shell-tab-b');
    expect(tab(1).attributes('tabindex')).toBe('0');

    await tab(1).trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('shell-tab-c');

    await tab(2).trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('shell-tab-a');

    await tab(0).trigger('keydown', { key: 'Home' });
    await tab(0).trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('shell-tab-c');
    expect(api.selectTab).not.toHaveBeenCalled();
  });

  it('selects with Enter or Space, closes with Delete, reorders with Ctrl+Shift+Arrow', async () => {
    const api = fakeApi();
    const wrapper = mountStrip(api);
    const tab = (i: number) => wrapper.findAll('[role="tab"]')[i]!;

    await tab(1).trigger('keydown', { key: 'Enter' });
    await tab(2).trigger('keydown', { key: ' ' });
    expect(api.selectTab).toHaveBeenNthCalledWith(1, 'b');
    expect(api.selectTab).toHaveBeenNthCalledWith(2, 'c');

    await tab(1).trigger('keydown', { key: 'Delete' });
    expect(api.closeTab).toHaveBeenCalledWith('b');

    await tab(0).trigger('keydown', { key: 'ArrowRight', ctrlKey: true, shiftKey: true });
    expect(api.moveTab).toHaveBeenCalledWith('a', 1);
    await tab(0).trigger('keydown', { key: 'ArrowLeft', ctrlKey: true, shiftKey: true });
    expect(api.moveTab).toHaveBeenCalledTimes(1);
  });

  it('focuses the selected tab when main asks for the strip (F6)', async () => {
    const api = fakeApi();
    mountStrip(api, TABS, 'b');

    api.focusStrip();
    await flushPromises();

    expect(document.activeElement?.id).toBe('shell-tab-b');
  });

  it('closes the selected tab and opens a new one from buttons after the strip', async () => {
    const api = fakeApi();
    const wrapper = mountStrip(api);

    await wrapper.get('button[aria-label="Close Fix login"]').trigger('click');
    await wrapper.get('button[aria-label="New tab"]').trigger('click');

    expect(api.closeTab).toHaveBeenCalledWith('a');
    expect(api.newTab).toHaveBeenCalledWith();
  });

  it('labels tabs in Greek when the locale is el', () => {
    shellI18n.global.locale.value = 'el';
    const wrapper = mountStrip(fakeApi());

    expect(wrapper.find('[role="tablist"]').attributes('aria-label')).toBe('Ανοιχτές καρτέλες');
    expect(wrapper.findAll('[role="tab"]')[1]!.attributes('aria-label')).toBe('Νέα συνομιλία, beta, σε εξέλιξη');
  });
});

describe('project list', () => {
  it('shows trust state, default and a trust action only for untrusted projects', async () => {
    const api = fakeApi();
    const wrapper = mount(ProjectList, { props: { api, projects: STATE.projects }, global: { plugins: [shellI18n] } });

    expect(wrapper.text()).toContain('Trusted');
    expect(wrapper.text()).toContain('Not trusted');
    expect(wrapper.text()).toContain('Default');
    expect(wrapper.find('button[aria-label="Trust project alpha"]').exists()).toBe(false);

    await wrapper.get('button[aria-label="Trust project beta"]').trigger('click');
    await wrapper.get('button[aria-label="Use project beta for new tabs"]').trigger('click');
    await wrapper.get('button[aria-label="New tab in project beta"]').trigger('click');
    await wrapper.get('button[aria-label="Add project"]').trigger('click');

    expect(api.grantTrust).toHaveBeenCalledWith('p2');
    expect(api.selectProject).toHaveBeenCalledWith('p2');
    expect(api.newTab).toHaveBeenCalledWith('p2');
    expect(api.addProject).toHaveBeenCalled();
    expect(wrapper.find('button[aria-label="Use project alpha for new tabs"]').exists()).toBe(false);
  });

  it('shows the refusal reason when a remove is refused', async () => {
    const api = fakeApi({ removeProject: vi.fn(async () => ({ ok: false as const, reason: 'A conversation is running there.' })) });
    const wrapper = mount(ProjectList, { props: { api, projects: STATE.projects }, global: { plugins: [shellI18n] } });

    await wrapper.get('button[aria-label="Remove project alpha"]').trigger('click');
    await flushPromises();

    expect(wrapper.get('[role="alert"]').text()).toBe('Could not remove project alpha: A conversation is running there.');
  });
});

describe('toasts', () => {
  it('renders actions, resolves with the chosen action or undefined, and honors main dismissals', async () => {
    const api = fakeApi();
    const wrapper = mount(ToastRegion, { props: { api }, global: { plugins: [shellI18n] } });

    api.toast({ id: 't1', severity: 'error', message: 'Provider failed', actions: ['Retry', 'Open log'] });
    api.toast({ id: 't2', severity: 'info', message: 'Saved', actions: [] });
    api.toast({ id: 't3', severity: 'warning', message: 'Slow', actions: [] });
    await flushPromises();

    // One live region per politeness, and no role=alert inside either, so each toast is announced once.
    expect(wrapper.get('[aria-live="assertive"]').text()).toContain('Provider failed');
    expect(wrapper.get('[aria-live="polite"]').text()).toContain('Saved');
    expect(wrapper.get('[aria-live="polite"]').text()).not.toContain('Provider failed');
    expect(wrapper.find('[aria-live] [role="alert"]').exists()).toBe(false);
    await wrapper.get('button:not([aria-label])').trigger('click');
    expect(api.resolveToast).toHaveBeenCalledWith('t1', 'Retry');

    await wrapper.findAll('button[aria-label="Dismiss notification"]')[0]!.trigger('click');
    expect(api.resolveToast).toHaveBeenCalledWith('t2', undefined);

    api.dismiss('t3');
    await flushPromises();
    expect(wrapper.text()).not.toContain('Slow');
    expect(api.resolveToast).toHaveBeenCalledTimes(2);
  });

});

describe('content bounds', () => {
  function rectElement(rect: { left: number; top: number; right: number; bottom: number }): HTMLElement {
    const element = document.createElement('div');
    element.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON: () => rect });
    return element;
  }

  it('reports on start, on resize only when the rectangle changed, and on every DPR change', () => {
    const changeListeners: Array<() => void> = [];
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      addEventListener: (_: string, listener: () => void) => changeListeners.push(listener),
      removeEventListener: vi.fn(),
    })));
    let rect = { left: 240.4, top: 36.6, right: 1000.2, bottom: 700 };
    const content = rectElement(rect);
    content.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON: () => rect });
    const neighbour = document.createElement('header');
    const reports: ContentBounds[] = [];

    const stop = watchContentBounds(content, [neighbour], (bounds) => reports.push(bounds));
    const observer = FakeResizeObserver.instances[0]!;

    expect(observer.observed).toEqual([content, neighbour]);
    expect(reports).toEqual([{ x: 240, y: 37, width: 760, height: 663 }]);

    observer.callback();
    expect(reports).toHaveLength(1);

    rect = { left: 0, top: 36.6, right: 1000.2, bottom: 700 };
    observer.callback();
    expect(reports.at(-1)).toEqual({ x: 0, y: 37, width: 1000, height: 663 });

    changeListeners[0]!();
    expect(reports).toHaveLength(3);
    expect(changeListeners).toHaveLength(2);

    stop();
    expect(observer.observed).toEqual([]);
  });

  it('App reports the tabpanel rectangle labelled by the selected tab', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const api = fakeApi();
    const wrapper = mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
    await flushPromises();

    const panel = wrapper.get('[role="tabpanel"]');
    expect(panel.attributes('aria-labelledby')).toBe('shell-tab-a');
    expect(api.reportContentBounds).toHaveBeenCalled();

    const { selectedTabId: _selected, ...withoutSelection } = STATE;
    api.push({ ...withoutSelection, locale: 'el', tabs: [] });
    await flushPromises();
    expect(wrapper.find('[role="tabpanel"]').exists()).toBe(false);
    expect(document.documentElement.lang).toBe('el');
    expect(wrapper.text()).toContain('Δεν υπάρχουν ανοιχτές καρτέλες');
    wrapper.unmount();
  });
});

describe('pane toggle', () => {
  function mountApp(api: DamoclesShellApi) {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    return mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
  }

  it('is absent while the browser feature is off', async () => {
    const wrapper = mountApp(fakeApi());
    await flushPromises();

    expect(wrapper.find('button[aria-label="Browser pane"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('toggles the selected chat tab pane, pressed while open, with the shortcut in its tooltip', async () => {
    const api = fakeApi({ getState: vi.fn(async () => ({ ...STATE, pane: { open: false } })) });
    const wrapper = mountApp(api);
    await flushPromises();

    const toggle = wrapper.get('button[aria-label="Browser pane"]');
    expect(toggle.attributes('aria-pressed')).toBe('false');
    expect(toggle.attributes('title')).toBe('Show browser pane (Ctrl+Shift+B)');
    await toggle.trigger('click');
    expect(api.togglePane).toHaveBeenCalledWith('a');

    api.push({ ...STATE, pane: { open: true } });
    await flushPromises();
    expect(wrapper.get('button[aria-label="Browser pane"]').attributes('aria-pressed')).toBe('true');
    expect(wrapper.get('button[aria-label="Browser pane"]').attributes('title')).toBe('Hide browser pane (Ctrl+Shift+B)');

    api.push({ ...STATE, locale: 'el', pane: { open: true } });
    await flushPromises();
    expect(wrapper.get('button[aria-pressed="true"]').attributes('aria-label')).toBe('Πλαίσιο περιήγησης');
    wrapper.unmount();
  });
});
