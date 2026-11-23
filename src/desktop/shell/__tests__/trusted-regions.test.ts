// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { shallowRef } from 'vue';
import { KEEP_CHANGES_MS } from '@shared/themes/agent';
import { canonicalHostColor } from '@shared/host-colors';
import { BUILTIN_PALETTES } from '@shared/themes/builtin';
import { checkPalette } from '@shared/themes/contrast';
import type { ShellEditorTab, ShellHost, ShellProject, ShellState } from '../../preload/shell-channels';
import type { TerminalGroupInfo, TerminalInfo } from '../../preload/terminal-channels';
import App from '../App.vue';
import Breadcrumbs from '../editor/Breadcrumbs.vue';
import EditorTabs from '../editor/EditorTabs.vue';
import TerminalList from '../terminal/TerminalList.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { createTerminalStore, TERMINAL_STORE, type TerminalStore } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, STATE, TERMINAL_STATE, fakeShellApi } from './fakes';
import { installVisibilityObserver, type FakeVisibility } from '../../../webview/__tests__/visibility-observer';

// Theme CSS reaches only [data-theme-scope] roots and stops at [data-trusted] and [data-trusted-mark]; a trusted part of
// the shell under a scope root, or a scope root inside one, would let a theme restyle or hide it.

const mounted: VueWrapper[] = [];
let visibility: FakeVisibility;
beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  visibility = installVisibilityObserver();
});
afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function crossings(root: ParentNode): string[] {
  const found: string[] = [];
  for (const trusted of root.querySelectorAll('[data-trusted]')) {
    if (trusted.parentElement?.closest('[data-theme-scope]')) found.push(`trusted under scope: ${trusted.outerHTML.slice(0, 120)}`);
  }
  for (const scope of root.querySelectorAll('[data-theme-scope]')) {
    if (scope.closest('[data-trusted]')) found.push(`scope inside trusted: ${scope.outerHTML.slice(0, 120)}`);
  }
  return found;
}

const PROD = { kind: 'ssh', key: 'ssh+h1', hostId: 'h1', name: 'prod-1', color: 'danger' } as const;
const HOST: ShellHost = { hostId: 'h1', kind: 'ssh', authorityKey: 'ssh+h1', name: 'prod-1', color: 'danger', connection: 'connected', signInNeeded: false };
const REMOTE: ShellProject = { ...STATE.projects[0]!, key: 'r1', name: 'api', fsPath: '/srv/api', authority: PROD, platform: 'linux', trusted: false };

// The window with everything trusted it can show at once: a remote project's stripe and host chip, the window controls,
// the three theme banners and the editor dock's peek bar, beside grouped projects with a host dot and an Untrusted badge.
const { selectedChat: _noChat, ...WITHOUT_CHAT } = STATE;
const SHOWN: ShellState = {
  ...WITHOUT_CHAT,
  projects: [...STATE.projects, REMOTE],
  hosts: [HOST],
  selected: { projectKey: 'r1' },
  chatViewShown: false,
  projectsView: 'grouped',
  projectGroups: { order: ['local', 'ssh+h1'], collapsed: [] },
  safeStart: { reason: 'launch' },
  keepChanges: { phase: 'counting', endsAt: Date.now() + KEEP_CHANGES_MS, durationMs: KEEP_CHANGES_MS, chatTitle: 'Warmer', change: { kind: 'create', theme: 'Amber', picked: ['dark'] }, previousName: 'Bleach', changeCount: 1 },
  themeProposal: { promptId: 'tc-1', chatTitle: 'Warmer' },
  dockPeek: true,
};

describe('the shell window', () => {
  it('keeps the title bar\'s trusted parts, the banners and the peek bar out of every scope root', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();

    const trusted = ['title-bar-stripe', 'title-bar-host', 'window-controls', 'safe-start-banner', 'keep-changes-banner', 'show-in-window-strip', 'theme-dock-peek'];
    for (const testId of trusted) {
      expect(document.querySelector(`[data-testid="${testId}"]`)?.hasAttribute('data-trusted'), testId).toBe(true);
    }
    expect(crossings(document)).toEqual([]);
  });

  // IntersectionObserver v2 calls an element covered when anything paints over it, a later sibling's shadow included, and a
  // fade never shows on a root whose opacity is pinned; the runtime check cannot run here, so the classes are held to the rule.
  it('gives no strip whose visibility is checked a shadow, and no trusted root a fade', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n], stubs: { transition: false } }, attachTo: document.body }));
    await flushPromises();

    const checked = visibility.observed().map((element) => element.getAttribute('data-testid'));
    expect(checked).toEqual(expect.arrayContaining(['safe-start-banner', 'keep-changes-banner', 'show-in-window-strip', 'theme-dock-peek']));
    for (const element of visibility.observed()) expect(element.className, element.getAttribute('data-testid') ?? '').not.toMatch(/(^|[\s:])shadow-/);
    for (const trusted of document.querySelectorAll('[data-trusted]')) expect(trusted.className, trusted.getAttribute('data-testid') ?? '').not.toMatch(/d-fade|o-fade-out|opacity-/);
    expect(document.querySelector('[data-testid="window-close"]')!.className).not.toMatch(/opacity-/);
  });

  // A gated strip must fit the window whole, so the one part of it with no fixed size scrolls inside a bounded box.
  it('bounds the text of every banner, so each fits the window however long a name is', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();

    for (const testId of ['safe-start-banner', 'keep-changes-banner', 'show-in-window-strip']) {
      const text = document.querySelector(`[data-testid="${testId}"] > div > p`)!;
      expect(text.classList.contains('max-h-18'), testId).toBe(true);
      expect(text.classList.contains('overflow-y-auto'), testId).toBe(true);
    }
  });

  // In flow the note added a row to a one-row strip, which moved its controls and every strip under it.
  it('holds each strip\'s checking note in a live region from the start, laid over the strip\'s text so that it moves no control', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    const strips = ['safe-start-banner', 'keep-changes-banner', 'show-in-window-strip', 'theme-dock-peek'];
    const region = (testId: string): HTMLElement => {
      const regions = [...document.querySelectorAll<HTMLElement>(`[data-testid="${testId}"] p[role="status"]`)].filter((candidate) => candidate.classList.contains('absolute'));
      expect(regions, testId).toHaveLength(1);
      return regions[0]!;
    };

    const held = strips.map(region);
    for (const [index, note] of held.entries()) {
      const testId = strips[index]!;
      expect(note.textContent, testId).toBe('');
      expect([...note.classList], testId).toEqual(expect.arrayContaining(['pointer-events-none', 'absolute', 'inset-0']));
      const cell = note.parentElement!;
      expect(cell.classList.contains('relative'), testId).toBe(true);
      expect(cell.parentElement?.dataset.testid, testId).toBe(testId);
      expect(cell.querySelector('button'), testId).toBeNull();
    }

    visibility.report(false);
    await new Promise((resolve) => setTimeout(resolve, 550));
    await flushPromises();
    for (const [index, testId] of strips.entries()) {
      expect(region(testId), testId).toBe(held[index]);
      expect(region(testId).querySelector('[data-testid="trusted-checking"]')?.textContent, testId).toBe('This card must be fully visible before you can answer. Scroll it into view or move what covers it.');
    }
  });

  it('sends each banner\'s button to its own request, and none while the banner is covered', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    const click = (selector: string): void => document.querySelector<HTMLElement>(selector)!.click();
    const presses = ['[data-testid="safe-start-use-mine"]', '[data-testid="safe-start-banner"] button:nth-of-type(2)', '[data-testid="keep-changes-keep"]', '[data-testid="keep-changes-revert"]', '[data-testid="show-in-window-stop"]', '[data-testid="theme-dock-peek"] button'];
    const requests = [api.useMyTheme, api.openSettings, api.keepThemeChanges, api.revertThemeChanges, api.stopShowingProposal, api.endThemeDockPeek];

    visibility.report(false);
    await flushPromises();
    for (const selector of presses) click(selector);
    for (const request of requests) expect(request).not.toHaveBeenCalled();

    visibility.report(true);
    await flushPromises();
    for (const selector of presses) click(selector);
    for (const request of requests) expect(request).toHaveBeenCalledTimes(1);
    expect(api.openSettings).toHaveBeenCalledWith('appearance');
  });

  it('ends the dock\'s peek on Escape pressed on its bar only, and not while the bar is covered', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    const escape = (target: Element): boolean => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const back = document.querySelector('[data-testid="theme-dock-peek"] button')!;
    expect(back.hasAttribute('aria-pressed')).toBe(false);

    escape(document.querySelector('[data-testid="quick-open-box"]')!);
    escape(document.body);
    expect(api.endThemeDockPeek).not.toHaveBeenCalled();

    visibility.report(false);
    await flushPromises();
    escape(back);
    expect(api.endThemeDockPeek).not.toHaveBeenCalled();

    visibility.report(true);
    await flushPromises();
    expect(escape(back)).toBe(false);
    expect(api.endThemeDockPeek).toHaveBeenCalledTimes(1);
  });

  // The title bar is a wallpaper panel whose own background is see-through under a wallpaper; trusted text there needs an
  // opaque trusted surface of its own, and checkPalette refuses a translucent --d-panel, so the trusted one is always opaque.
  it('paints nothing on the theme dock\'s slot, which main\'s own view covers', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => ({ ...STATE, dockInset: 26 })) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();
    const slot = document.querySelector('[data-testid="theme-dock-slot"]')!;
    expect([...slot.classList].filter((name) => /(^|:)bg-/.test(name))).toEqual([]);
    expect(slot.classList.contains('absolute')).toBe(true);
  });

  it('fades the breadcrumb\'s chat crumb in through a motion.css class, never an arbitrary animation', async () => {
    const source = await import('../components/TitleBar.vue?raw');
    expect(source.default).toContain('enter-active-class="d-fade-in"');
    expect(source.default).not.toMatch(/animate-\[/);
  });

  it('paints each trusted title bar control on the trusted --d-panel, never on the see-through pane', async () => {
    const { color: _hostColor, ...plainHost } = HOST;
    const { color: _authorityColor, ...plainAuthority } = PROD;
    const api = fakeShellApi([], { getState: vi.fn(async () => ({ ...SHOWN, hosts: [plainHost], projects: [...STATE.projects, { ...REMOTE, authority: plainAuthority }] })) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();

    const titleBar = document.querySelector('[data-testid="title-bar"]')!;
    expect(titleBar.getAttribute('data-wallpaper-panel')).toBe('titlebar');
    for (const testId of ['title-bar-host', 'window-controls']) {
      const control = titleBar.querySelector(`[data-testid="${testId}"]`)!;
      expect(control.hasAttribute('data-trusted'), testId).toBe(true);
      expect(control.classList.contains('bg-(--d-panel)'), testId).toBe(true);
    }
    // the plain host name is --d-text, which the trusted palette holds at AA on --d-panel
    expect(titleBar.querySelector('[data-testid="title-bar-host-name"]')!.classList.contains('text-(--d-text)')).toBe(true);
    expect(checkPalette(BUILTIN_PALETTES.dark, 'dark').filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(checkPalette({ ...BUILTIN_PALETTES.dark, '--d-panel': `${BUILTIN_PALETTES.dark['--d-panel']!.slice(0, 7)}00` }, 'dark')).toContainEqual(expect.objectContaining({ rule: 'format', fg: '--d-panel', severity: 'error' }));
  });

  it('scopes the title bar\'s brand and breadcrumb, and every sidebar section body, never a section header', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => SHOWN) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();

    const titleBar = document.querySelector('[data-testid="title-bar"]')!;
    const titleScopes = [...titleBar.querySelectorAll('[data-theme-scope]')];
    expect(titleScopes.map((scope) => scope.getAttribute('data-theme-scope'))).toEqual(['titlebar', 'titlebar']);
    expect(titleScopes[0]!.querySelector('[data-testid="app-menu"]')).not.toBeNull();
    expect(titleScopes[1]!.getAttribute('data-testid')).toBe('breadcrumb');
    // each sits in an unscoped box that clips it to the bar, and nothing a theme can resize is exempt from window dragging
    for (const scope of titleScopes) {
      expect(scope.parentElement!.classList.contains('overflow-clip')).toBe(true);
      expect(scope.parentElement!.closest('[data-theme-scope]')).toBeNull();
      expect(scope.classList.contains('title-bar-control')).toBe(false);
      expect(scope.querySelector('.title-bar-control')).toBeNull();
    }
    const brand = titleBar.querySelector('[data-testid="title-bar-brand"]')!;
    expect(brand).toBe(titleScopes[0]!.parentElement);
    expect(brand.classList.contains('title-bar-control')).toBe(true);
    expect(brand.classList.contains('max-w-40')).toBe(true);

    const sections = [...document.querySelectorAll('section.sidebar-section')];
    expect(sections.length).toBeGreaterThan(0);
    for (const section of sections) {
      const scopes = [...section.querySelectorAll('[data-theme-scope]')];
      expect(scopes.map((scope) => scope.getAttribute('data-theme-scope')), section.getAttribute('data-section') ?? '').toEqual(['sidebar']);
      expect(section.querySelector('[data-testid="sidebar-section-header"]')!.closest('[data-theme-scope]')).toBeNull();
    }
  });

  it('marks the host dot of a project group and the Untrusted badge inside the sidebar\'s scope as safety marks', async () => {
    const api = fakeShellApi([], { getState: vi.fn(async () => ({ ...SHOWN, hosts: [{ ...HOST, color: canonicalHostColor('#ff8000ff')! }] })) });
    mounted.push(mount(App, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    await flushPromises();

    const dot = document.querySelector('[data-testid="project-group-color"]')!;
    expect(dot.closest('[data-trusted-mark]')).not.toBeNull();
    expect(dot.closest('[data-theme-scope="sidebar"]')).not.toBeNull();
    const untrusted = document.querySelector('[data-testid="untrusted-badge"]')!;
    expect(untrusted.hasAttribute('data-trusted-mark')).toBe(true);
    expect(untrusted.closest('[data-theme-scope="sidebar"]')).not.toBeNull();
  });
});

describe('the editor and terminal chrome', () => {
  it('scopes the editor tab strip and the breadcrumbs as editorChrome', async () => {
    const tab: ShellEditorTab = { id: 'a', kind: 'code', documentId: 'd-a', title: 'a.ts', projectKey: 'p1', relativePath: 'src/a.ts', displayPath: '/w/alpha/src/a.ts', dirty: false, readOnly: false, conflict: false };
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [tab], activeTabId: tab.id })) });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const tabs = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W', projects: [], hosts: [] }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) } }, attachTo: document.body });
    mounted.push(tabs);
    const crumbs = mount(Breadcrumbs, { props: { tab, projectName: 'alpha' }, global: { plugins: [shellI18n] }, attachTo: document.body });
    mounted.push(crumbs);
    await flushPromises();

    expect(tabs.element.getAttribute('data-theme-scope')).toBe('editorChrome');
    expect(tabs.element.querySelector('[role="tablist"]')).not.toBeNull();
    expect(crumbs.element.getAttribute('data-theme-scope')).toBe('editorChrome');
    expect(crossings(document)).toEqual([]);
  });

  it('scopes the terminal list as terminalChrome, leaving its resize sash outside', () => {
    const info = (id: string): TerminalInfo => ({
      id, title: id, name: null, profileId: 'cmd', icon: 'cmd', customIcon: null, color: null, projectKey: 'p1', projectName: 'alpha', status: 'running', exitCode: null, description: null, running: null, integrated: false, restoring: false, windowsBuild: null, pathFlavor: 'posix', placement: 'panel',
    });
    const group = (id: string, paneIds: string[]): TerminalGroupInfo => ({ id, paneIds, activePaneId: paneIds[0]!, sizes: paneIds.map(() => 1 / paneIds.length) });
    const terminals = [info('t1'), info('t2')];
    const groups = [group('g1', ['t1']), group('g2', ['t2'])];
    const store = { renaming: shallowRef(null), startRename: vi.fn(), state: shallowRef({ ...TERMINAL_STATE, terminals, groups, activeId: 't1' }), moved: shallowRef(null), move: vi.fn() } as unknown as TerminalStore;
    const list = mount(TerminalList, {
      props: { api: fakeShellApi(), platform: 'win32', terminals, groups, activeId: 't1', splitShortcut: 'Ctrl+Shift+5', widthRem: 12, panelWidth: 1200 },
      global: { plugins: [shellI18n], provide: { [TERMINAL_STORE as symbol]: store } },
      attachTo: document.body,
    });
    mounted.push(list);

    const scope = list.get('[data-theme-scope]');
    expect(scope.attributes('data-theme-scope')).toBe('terminalChrome');
    expect(scope.attributes('role')).toBe('tablist');
    expect(list.get('[data-testid="terminal-list-sash"]').element.closest('[data-theme-scope]')).toBeNull();
  });
});
