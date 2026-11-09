// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { DamoclesShellApi, ShellBrowserPage, ShellDesignPreview, ShellEditorTab, ShellHtmlPreview } from '../../preload/shell-channels';
import App from '../App.vue';
import BrowserTab from '../editor/BrowserTab.vue';
import DesignPreviewTab from '../editor/DesignPreviewTab.vue';
import HtmlPreviewTab from '../editor/HtmlPreviewTab.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, fakeShellApi } from './fakes';

// HTML previews, design previews and browser pages share one way into their native page view: a stand-in in the stage the
// view covers, which Tab reaches, and F6 onto the editor part; both ask main to focus the view (focusPage).

const htmlTab: ShellEditorTab & { htmlPreview: ShellHtmlPreview } = {
  id: 'html:p1/index.html', kind: 'htmlPreview', title: 'Preview index.html', projectKey: 'p1', relativePath: 'index.html', displayPath: '/w/alpha/index.html',
  dirty: false, readOnly: false, conflict: false, htmlPreview: { status: 'ready', trusted: true },
};
const designTab: ShellEditorTab & { designPreview: ShellDesignPreview } = {
  id: 'd1', kind: 'designPreview', title: 'S1 · Contacts', displayPath: '/home/u/.damocles/designs/c-1a2b/screens/S1-contacts.html', dirty: false, readOnly: false, conflict: false,
  designPreview: { designId: 'c-1a2b', relPath: 'screens/S1-contacts.html', path: '/home/u/.damocles/designs/c-1a2b/screens/S1-contacts.html', status: 'ready', width: 1280, state: 'default', provenance: false, canGoBack: false, canGoForward: false },
};
const page: ShellBrowserPage = { url: 'https://docs.example/a', loading: false, canGoBack: false, canGoForward: false, picking: false };
const browserTab: ShellEditorTab & { browser: ShellBrowserPage } = { id: 'b1', kind: 'browser', title: 'Docs', displayPath: page.url, dirty: false, readOnly: false, conflict: false, browser: page };

const mounted: VueWrapper[] = [];
function track(wrapper: VueWrapper): VueWrapper {
  mounted.push(wrapper);
  return wrapper;
}

function mountKind(kind: 'htmlPreview' | 'designPreview' | 'browser', api: DamoclesShellApi): VueWrapper {
  const global = { plugins: [shellI18n], provide: { [EDITOR_STORE]: createEditorStore(api), [SCM_STORE]: createScmStore(api.scm) } };
  if (kind === 'htmlPreview') return track(mount(HtmlPreviewTab, { props: { api, tab: htmlTab }, global, attachTo: document.body }));
  if (kind === 'designPreview') return track(mount(DesignPreviewTab, { props: { api, tab: designTab, platform: 'win32' }, global, attachTo: document.body }));
  return track(mount(BrowserTab, { props: { api, tab: browserTab }, global, attachTo: document.body }));
}

// Tab from the tab's first control onto its stand-in: a focus moved within the shell page.
function tabOnto(wrapper: VueWrapper): HTMLElement {
  (wrapper.get('button:not([disabled])').element as HTMLElement).focus();
  const standIn = wrapper.get('[data-testid="page-stand-in"]').element as HTMLElement;
  standIn.focus();
  return standIn;
}

const TAB_IDS = { htmlPreview: htmlTab.id, designPreview: designTab.id, browser: browserTab.id } as const;
const STAGES = { htmlPreview: 'html-preview-stage', designPreview: 'design-preview-frame', browser: 'browser-stage' } as const;

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe.each(['htmlPreview', 'designPreview', 'browser'] as const)('the %s tab\'s page stand-in', (kind) => {
  it('is a named stop in the tab order inside the area the view covers, with a focus ring', () => {
    const wrapper = mountKind(kind, fakeShellApi());
    const standIns = wrapper.findAll('[data-testid="page-stand-in"]');
    expect(standIns).toHaveLength(1);
    const standIn = standIns[0]!;
    expect(wrapper.get(`[data-testid="${STAGES[kind]}"]`).element.contains(standIn.element)).toBe(true);
    expect(standIn.attributes('tabindex')).toBe('0');
    expect(standIn.attributes('role')).toBe('button');
    expect(standIn.attributes('aria-label')).toBe('Go to the page');
    expect(standIn.classes()).toEqual(expect.arrayContaining(['focus-visible:ring-2', 'focus-visible:ring-(--d-accent)']));
  });

  it('is named in Greek', () => {
    shellI18n.global.locale.value = 'el';
    expect(mountKind(kind, fakeShellApi()).get('[data-testid="page-stand-in"]').attributes('aria-label')).toBe('Μετάβαση στη σελίδα');
  });

  it('moves focus into its tab\'s page once Tab reaches it, leaving nothing focused in the shell page', async () => {
    const api = fakeShellApi();
    const wrapper = mountKind(kind, api);
    tabOnto(wrapper);
    await flushPromises();
    expect(api.focusPage).toHaveBeenCalledExactlyOnceWith({ tabId: TAB_IDS[kind] });
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps focus while main shows no page, and Enter asks again', async () => {
    const api = fakeShellApi([], { focusPage: vi.fn(async () => false) });
    const wrapper = mountKind(kind, api);
    const standIn = tabOnto(wrapper);
    await flushPromises();
    expect(document.activeElement).toBe(standIn);
    vi.mocked(api.focusPage).mockResolvedValue(true);
    await wrapper.get('[data-testid="page-stand-in"]').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.focusPage).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(document.body);
  });

  it('enters no page when the shell page regains focus with the stand-in still focused', async () => {
    const api = fakeShellApi([], { focusPage: vi.fn(async () => false) });
    const standIn = tabOnto(mountKind(kind, api));
    await flushPromises();
    expect(api.focusPage).toHaveBeenCalledOnce();
    // Blink restores focus to the active element as the page regains it, with no relatedTarget.
    standIn.dispatchEvent(new FocusEvent('focus', { relatedTarget: null }));
    await flushPromises();
    expect(api.focusPage).toHaveBeenCalledOnce();
  });
});

describe('the page stand-in while no page can show', () => {
  it('is marked unavailable for an HTML preview that is not ready, and available once it is', async () => {
    const wrapper = track(mount(HtmlPreviewTab, { props: { api: fakeShellApi(), tab: { ...htmlTab, htmlPreview: { status: 'loading', trusted: true } } }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    expect(wrapper.get('[data-testid="page-stand-in"]').attributes('aria-disabled')).toBe('true');
    await wrapper.setProps({ tab: htmlTab });
    expect(wrapper.get('[data-testid="page-stand-in"]').attributes('aria-disabled')).toBeUndefined();
  });

  it('is marked unavailable for a design preview whose frame shows a state', () => {
    const api = fakeShellApi();
    const wrapper = track(mount(DesignPreviewTab, { props: { api, tab: { ...designTab, designPreview: { ...designTab.designPreview, status: 'loading' } }, platform: 'win32' }, global: { plugins: [shellI18n] }, attachTo: document.body }));
    expect(wrapper.get('[data-testid="page-stand-in"]').attributes('aria-disabled')).toBe('true');
  });
});

describe('F6 onto the editor part', () => {
  async function mountApp(tab: ShellEditorTab, focusPage: () => Promise<boolean>) {
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [tab], activeTabId: tab.id })), focusPage: vi.fn(focusPage) });
    const wrapper = track(mount(App, { props: { api }, global: { plugins: [shellI18n], stubs: { DesignPreviewTab: true } }, attachTo: document.body }));
    await flushPromises();
    return { wrapper, api };
  }
  const stripTab = (wrapper: VueWrapper, tab: ShellEditorTab) => wrapper.get(`[data-editor-tab][data-tab-id="${tab.id}"]`).element;

  it.each([htmlTab, designTab])('enters the page of an active $kind tab', async (tab) => {
    const { api } = await mountApp(tab, async () => true);
    api.focusPart('editor');
    await flushPromises();
    expect(api.focusPage).toHaveBeenCalledExactlyOnceWith({ tabId: tab.id });
  });

  it.each([htmlTab, designTab])('focuses the $kind tab in the strip when main shows no page', async (tab) => {
    const { wrapper, api } = await mountApp(tab, async () => false);
    api.focusPart('editor');
    await flushPromises();
    expect(api.focusPage).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(stripTab(wrapper, tab));
  });

  it('lands in a browser page\'s address field, from which Tab reaches the page', async () => {
    const { wrapper, api } = await mountApp(browserTab, async () => true);
    api.focusPart('editor');
    await flushPromises();
    expect(api.focusPage).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(wrapper.get('[data-testid="browser-address"]').element);
  });
});
