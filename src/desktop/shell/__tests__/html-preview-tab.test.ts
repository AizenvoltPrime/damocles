// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { ShellEditorTab, ShellHtmlPreview } from '../../preload/shell-channels';
import HtmlPreviewTab from '../editor/HtmlPreviewTab.vue';
import EditorPane from '../editor/EditorPane.vue';
import { createEditorStore, EDITOR_STORE } from '../editor/editor-store';
import { createScmStore, SCM_STORE } from '../scm/scm-store';
import { createTerminalStore, TERMINAL_STORE } from '../terminal/terminal-store';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, fakeShellApi, STATE, type FakeShellApi } from './fakes';

type PreviewTab = ShellEditorTab & { htmlPreview: ShellHtmlPreview };

function previewTab(preview: Partial<ShellHtmlPreview> = {}, id = 'html:p1/site/index.html'): PreviewTab {
  return {
    id, kind: 'htmlPreview', title: 'Preview index.html', projectKey: 'p1', relativePath: 'site/index.html', displayPath: '/w/alpha/site/index.html',
    dirty: false, readOnly: false, conflict: false, htmlPreview: { status: 'ready', trusted: true, ...preview },
  };
}

// The stage measures 800 × 500 at (40, 90), as the pane lays it out; happy-dom lays out nothing.
const STAGE = { left: 40, top: 90, right: 840, bottom: 590, width: 800, height: 500 };
function layOutStage(rect: { left: number; top: number; right: number; bottom: number; width: number; height: number } = STAGE): void {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return (this.dataset['testid'] === 'html-preview-stage' ? rect : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }) as DOMRect;
  });
}

const mounted: VueWrapper[] = [];
function mountTab(tab: PreviewTab = previewTab(), api: FakeShellApi = fakeShellApi()): { wrapper: VueWrapper; api: FakeShellApi } {
  const wrapper = mount(HtmlPreviewTab, { props: { api, tab }, global: { plugins: [shellI18n] }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, api };
}

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.removeAttribute('data-reduced-motion');
});

describe('the page area', () => {
  it('reports the stage with the tab and the card\'s inner radius while the page is ready, and no area once the tab goes', () => {
    layOutStage();
    const computed = window.getComputedStyle.bind(window);
    vi.stubGlobal('getComputedStyle', (element: Element) => {
      const style = computed(element);
      if ((element as HTMLElement).dataset['testid'] !== 'html-preview-card') return style;
      return { ...style, borderTopLeftRadius: '10px', borderTopWidth: '1px' } as CSSStyleDeclaration;
    });
    const { wrapper, api } = mountTab();
    expect(api.reportHtmlPreviewBounds).toHaveBeenLastCalledWith({ tabId: 'html:p1/site/index.html', x: 40, y: 90, width: 800, height: 500, radius: 9 });
    expect(FakeResizeObserver.instances.at(-1)?.observed).toContain(wrapper.get('[data-testid="html-preview-stage"]').element);
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    expect(api.reportHtmlPreviewBounds).toHaveBeenLastCalledWith(null);
  });

  it('reports no area until the page is ready, and none again when its host drops, so the shell\'s state shows in the card', async () => {
    layOutStage();
    const { wrapper, api } = mountTab(previewTab({ status: 'loading' }));
    expect(api.reportHtmlPreviewBounds).toHaveBeenLastCalledWith(null);
    expect(api.reportHtmlPreviewBounds).not.toHaveBeenCalledWith(expect.objectContaining({ width: 800 }));
    await wrapper.setProps({ tab: previewTab({ status: 'ready' }) });
    expect(api.reportHtmlPreviewBounds).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: 'html:p1/site/index.html', width: 800, height: 500 }));
    await wrapper.setProps({ tab: previewTab({ status: 'offline', hostName: 'prod-1' }) });
    expect(api.reportHtmlPreviewBounds).toHaveBeenLastCalledWith(null);
  });

  it('reports no area while the editor pane is hidden and its stage measures empty', () => {
    layOutStage({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
    const { api } = mountTab();
    expect(api.reportHtmlPreviewBounds).toHaveBeenCalled();
    expect(api.reportHtmlPreviewBounds).not.toHaveBeenCalledWith(expect.objectContaining({ tabId: expect.any(String) }));
  });
});

describe('the states over the card', () => {
  it('shows loading, the host that is not connected, and a failed load, and nothing over a ready page', async () => {
    const { wrapper } = mountTab(previewTab({ status: 'loading' }));
    const status = () => wrapper.find('[data-testid="html-preview-status"]');
    expect(status().attributes('data-status')).toBe('loading');
    expect(status().text()).toBe('Loading preview…');
    expect(wrapper.find('[data-testid="html-preview-progress"]').exists()).toBe(true);

    await wrapper.setProps({ tab: previewTab({ status: 'offline', hostName: 'prod-1' }) });
    await flushPromises();
    expect(status().attributes('data-status')).toBe('offline');
    expect(status().text()).toBe('prod-1 is not connected.');

    await wrapper.setProps({ tab: previewTab({ status: 'failed' }) });
    await flushPromises();
    expect(status().attributes('data-status')).toBe('failed');
    expect(status().text()).toBe('The preview could not load.');

    await wrapper.setProps({ tab: previewTab({ status: 'ready' }) });
    await flushPromises();
    expect(status().exists()).toBe(false);
  });

  it('announces each state through one live region that stays for the tab\'s life, the state card hidden from screen readers', async () => {
    const { wrapper } = mountTab(previewTab({ status: 'loading' }));
    const announcer = wrapper.get('[data-testid="html-preview-announcer"]');
    const regions = () => wrapper.get('[data-testid="html-preview-stage"]').findAll('[role="status"]');
    expect(announcer.attributes('role')).toBe('status');
    expect(announcer.text()).toBe('Loading preview…');
    expect(wrapper.get('[data-testid="html-preview-status"]').attributes('aria-hidden')).toBe('true');
    expect(regions()).toHaveLength(1);

    for (const [preview, text] of [[{ status: 'offline', hostName: 'prod-1' }, 'prod-1 is not connected.'], [{ status: 'failed' }, 'The preview could not load.'], [{ status: 'ready' }, '']] as const) {
      await wrapper.setProps({ tab: previewTab(preview) });
      await flushPromises();
      expect(wrapper.get('[data-testid="html-preview-announcer"]').element).toBe(announcer.element);
      expect(announcer.text()).toBe(text);
      expect(regions()).toHaveLength(1);
    }
  });

  it('says the host in Greek', () => {
    shellI18n.global.locale.value = 'el';
    const { wrapper } = mountTab(previewTab({ status: 'offline', hostName: 'prod-1' }));
    expect(wrapper.get('[data-testid="html-preview-status"]').text()).toBe('Το prod-1 δεν είναι συνδεδεμένο.');
  });
});

describe('the toolbar and the trust banner', () => {
  it('sends Reload and Open in browser for its tab, with a name on each button', async () => {
    const { wrapper, api } = mountTab();
    await wrapper.get('[data-testid="html-preview-reload"]').trigger('click');
    expect(api.htmlPreviewAction).toHaveBeenLastCalledWith({ tabId: 'html:p1/site/index.html', action: 'reload' });
    await wrapper.get('[data-testid="html-preview-open-in-browser"]').trigger('click');
    expect(api.htmlPreviewAction).toHaveBeenLastCalledWith({ tabId: 'html:p1/site/index.html', action: 'openInBrowser' });
    for (const button of wrapper.findAll('button')) expect(button.attributes('aria-label')).toBeTruthy();
  });

  it('turns the Reload glyph once per click, and not under reduced motion', async () => {
    const { wrapper } = mountTab();
    const glyph = () => wrapper.get('[data-testid="html-preview-reload"] svg').attributes('style');
    expect(glyph()).toContain('rotate(0deg)');
    await wrapper.get('[data-testid="html-preview-reload"]').trigger('click');
    await flushPromises();
    expect(glyph()).toContain('rotate(360deg)');
    document.documentElement.setAttribute('data-reduced-motion', '');
    await wrapper.get('[data-testid="html-preview-reload"]').trigger('click');
    await flushPromises();
    expect(glyph()).toContain('rotate(360deg)');
  });

  it('shows the banner only for an untrusted folder, and Trust Folder... asks main once while its request is in flight', async () => {
    let answer: () => void = () => undefined;
    const api = fakeShellApi([], { htmlPreviewAction: vi.fn(() => new Promise<void>((resolve) => { answer = resolve; })) });
    const trusted = mountTab(previewTab(), fakeShellApi());
    expect(trusted.wrapper.find('[data-testid="html-preview-untrusted"]').exists()).toBe(false);

    const { wrapper } = mountTab(previewTab({ trusted: false }), api);
    const banner = wrapper.get('[data-testid="html-preview-untrusted"]');
    expect(banner.attributes('role')).toBe('status');
    expect(banner.text()).toContain('Scripts are off because this folder is not trusted.');
    const trust = wrapper.get('[data-testid="html-preview-trust"]');
    expect(trust.text()).toBe('Trust Folder...');
    await trust.trigger('click');
    expect(trust.attributes('aria-disabled')).toBe('true');
    await trust.trigger('click');
    expect(api.htmlPreviewAction).toHaveBeenCalledTimes(1);
    expect(api.htmlPreviewAction).toHaveBeenCalledWith({ tabId: 'html:p1/site/index.html', action: 'trustFolder' });
    answer();
    await flushPromises();
    expect(trust.attributes('aria-disabled')).toBeUndefined();

    await wrapper.setProps({ tab: previewTab({ trusted: true }) });
    await flushPromises();
    expect(wrapper.find('[data-testid="html-preview-untrusted"]').exists()).toBe(false);
  });

  it('marks Reload busy and disabled while its request is in flight, as Open in browser is', async () => {
    let answer: () => void = () => undefined;
    const api = fakeShellApi([], { htmlPreviewAction: vi.fn(() => new Promise<void>((resolve) => { answer = resolve; })) });
    const { wrapper } = mountTab(previewTab(), api);
    const reload = wrapper.get('[data-testid="html-preview-reload"]');
    await reload.trigger('click');
    expect(reload.attributes('aria-busy')).toBe('true');
    expect(reload.attributes('aria-disabled')).toBe('true');
    answer();
    await flushPromises();
    expect(reload.attributes('aria-busy')).toBeUndefined();
    expect(reload.attributes('aria-disabled')).toBeUndefined();
  });

  it('logs a refusal main reported, and the button takes clicks again', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const api = fakeShellApi([], { htmlPreviewAction: vi.fn(async () => { throw new Error('the tab closed'); }) });
    const { wrapper } = mountTab(previewTab(), api);
    await wrapper.get('[data-testid="html-preview-open-in-browser"]').trigger('click');
    await flushPromises();
    expect(logged).toHaveBeenCalledWith('[html preview] main refused openInBrowser', expect.any(Error));
    expect(wrapper.get('[data-testid="html-preview-open-in-browser"]').attributes('aria-disabled')).toBeUndefined();
  });
});

describe('in the editor pane', () => {
  it('renders an htmlPreview tab, and switching to another preview reports the old one gone before the new one\'s area', async () => {
    layOutStage();
    const first = previewTab();
    const second = previewTab({}, 'html:p1/site/about.html');
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs: [first, second], activeTabId: first.id })) });
    const store = createEditorStore(api);
    await store.start();
    const scm = createScmStore(api.scm);
    await scm.start();
    const wrapper = mount(EditorPane, { props: { api, state: STATE }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store, [SCM_STORE]: scm, [TERMINAL_STORE as symbol]: createTerminalStore(api) }, stubs: { PaneGrip: true } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    expect(wrapper.find('[data-testid="html-preview-tab"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="editor-not-displayed"]').exists()).toBe(false);
    expect(api.reportHtmlPreviewBounds).toHaveBeenLastCalledWith(expect.objectContaining({ tabId: first.id }));

    vi.mocked(api.reportHtmlPreviewBounds).mockClear();
    api.pushEditorState({ ...EDITOR_STATE, tabs: [first, second], activeTabId: second.id });
    await flushPromises();
    expect(vi.mocked(api.reportHtmlPreviewBounds).mock.calls).toEqual([[null], [expect.objectContaining({ tabId: second.id })]]);
  });
});
