// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import type { OverlayAnswer, OverlayRequest } from '../../preload/overlay-channels';
import type { DamoclesShellApi, ShellBrowserPage, ShellEditorTab } from '../../preload/shell-channels';
import BrowserTab from '../editor/BrowserTab.vue';
import Breadcrumbs from '../editor/Breadcrumbs.vue';
import EditorTabs from '../editor/EditorTabs.vue';
import { createEditorStore, EDITOR_STORE, type EditorStore } from '../editor/editor-store';
import { isSendableAddress, pageHost, pageTitle } from '../editor/browser-page';
import { AS_TYPED, HTTP_AT_ONCE, UPGRADED } from '../../../shared/__tests__/typed-address-cases';
import { shellI18n } from '../i18n';
import { EDITOR_STATE, FakeResizeObserver, fakeShellApi } from './fakes';

type BrowserEditorTab = ShellEditorTab & { browser: ShellBrowserPage };

function pageTab(page: Partial<ShellBrowserPage> = {}, title = 'Docs', id = 'p1'): BrowserEditorTab {
  const browser: ShellBrowserPage = { url: 'https://docs.example/a', loading: false, canGoBack: false, canGoForward: false, picking: false, ...page };
  return { id, kind: 'browser', title, displayPath: browser.url, dirty: false, readOnly: false, conflict: false, browser };
}

const mounted: Array<VueWrapper> = [];

function mountTab(tab: BrowserEditorTab, api: DamoclesShellApi = fakeShellApi()): { wrapper: VueWrapper; api: DamoclesShellApi; store: EditorStore } {
  const store = createEditorStore(api);
  const wrapper = mount(BrowserTab, { props: { api, tab }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store } }, attachTo: document.body });
  mounted.push(wrapper);
  return { wrapper, api, store };
}

const address = (wrapper: VueWrapper) => wrapper.get<HTMLInputElement>('[data-testid="browser-address"]');
const frames = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  FakeResizeObserver.instances = [];
  vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount();
  vi.unstubAllGlobals();
});

describe('browser page helpers', () => {
  it('titles a page without bidi controls, falls back to its address, and names a blank page', () => {
    expect(pageTitle(pageTab({}, '\u202EEvil\u2066 title'), 'New page')).toBe('Evil title');
    expect(pageTitle(pageTab({ url: 'https://a.example/x' }, ''), 'New page')).toBe('https://a.example/x');
    expect(pageTitle(pageTab({ url: 'about:blank' }, 'about:blank'), 'New page')).toBe('New page');
    expect(pageHost('https://a.example:8443/x')).toBe('a.example:8443');
  });

  it('sends a bare host or a host and port as typed, and refuses any scheme but http and https', () => {
    for (const sent of ['example.com', 'localhost:3000', 'localhost:3000/docs', 'http://a.example', 'HTTPS://a.example', 'about:blank']) expect(isSendableAddress(sent)).toBe(true);
    for (const refused of ['file:///etc/hosts', 'javascript:alert(1)', 'JavaScript:alert(1)', 'chrome://settings', 'data:text/html,x']) expect(isSendableAddress(refused)).toBe(false);
  });

  // Main and core read the text with the same table (browser-tabs.test.ts, panel-wiring.test.ts).
  it.each([...UPGRADED, ...HTTP_AT_ONCE, ...AS_TYPED])('sends %s to main', (_kind, typed) => {
    expect(isSendableAddress(typed.trim())).toBe(true);
  });
});

describe('navigation bar', () => {
  it('reflects the page in disabled controls and sends each action for its tab', async () => {
    const { wrapper, api } = mountTab(pageTab({ canGoBack: true, picking: true }));
    expect(wrapper.get('[data-testid="browser-back"]').attributes('disabled')).toBeUndefined();
    expect(wrapper.get('[data-testid="browser-forward"]').attributes('disabled')).toBeDefined();
    expect(wrapper.get('[data-testid="browser-pick"]').attributes('aria-pressed')).toBe('true');
    for (const [control, action] of [['back', 'back'], ['reload', 'reload'], ['pick', 'pickElement'], ['devtools', 'devTools'], ['open-external', 'openExternal']] as const) {
      await wrapper.get(`[data-testid="browser-${control}"]`).trigger('click');
      expect(api.browserAction).toHaveBeenLastCalledWith({ tabId: 'p1', action });
    }
    for (const button of wrapper.findAll('button')) expect(button.attributes('aria-label')).toBeTruthy();
  });

  it('offers Open in system browser only for an http or https page, and shows a blank page\'s address as empty', () => {
    const { wrapper } = mountTab(pageTab({ url: 'about:blank' }, 'about:blank'));
    const external = wrapper.get('[data-testid="browser-open-external"]');
    expect(external.attributes('disabled')).toBeDefined();
    expect(external.attributes('title')).toBe('Only http and https pages open in the system browser');
    expect(address(wrapper).element.value).toBe('');
  });

  it('navigates on Enter, shows main\'s refusal, refuses a non-web scheme without asking, and Escape restores the address', async () => {
    const api = fakeShellApi([], { navigateBrowser: vi.fn(async (request: { url: string }) => request.url !== 'refused.example') });
    const { wrapper } = mountTab(pageTab(), api);
    const field = address(wrapper);
    await field.setValue('localhost:3000');
    await field.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.navigateBrowser).toHaveBeenLastCalledWith({ tabId: 'p1', url: 'localhost:3000' });
    expect(field.attributes('aria-invalid')).toBeUndefined();

    await field.setValue('refused.example');
    await field.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(field.attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('#browser-address-error').text()).toBe('This address cannot be opened here. Only http and https pages are allowed.');

    vi.mocked(api.navigateBrowser).mockClear();
    await field.setValue('file:///etc/hosts');
    await field.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.navigateBrowser).not.toHaveBeenCalled();
    expect(field.attributes('aria-invalid')).toBe('true');

    await field.trigger('keydown', { key: 'Escape' });
    expect(field.element.value).toBe('https://docs.example/a');
    expect(field.attributes('aria-invalid')).toBeUndefined();
  });

  it('shows an address main failed to take as refused, and a failed action leaves no unhandled rejection', async () => {
    const gone = async (): Promise<never> => {
      throw new Error('Unknown page');
    };
    // Not a vi.fn: a mock's settled-result tracking would handle the rejection itself.
    let actions = 0;
    const browserAction = (): Promise<never> => {
      actions++;
      return gone();
    };
    const api = fakeShellApi([], { navigateBrowser: vi.fn(gone), browserAction });
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const { wrapper } = mountTab(pageTab(), api);
      const field = address(wrapper);
      await field.setValue('next.example');
      await field.trigger('keydown', { key: 'Enter' });
      await flushPromises();
      expect(field.attributes('aria-invalid')).toBe('true');
      expect(field.element.value).toBe('next.example');
      await wrapper.get('[data-testid="browser-open-external"]').trigger('click');
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(actions).toBe(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps a sent address while main re-sends the old page, until the page moves', async () => {
    const { wrapper } = mountTab(pageTab());
    const field = address(wrapper);
    await field.setValue('next.example');
    await field.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await wrapper.setProps({ tab: pageTab({ loading: true }) });
    expect(field.element.value).toBe('next.example');
    await wrapper.setProps({ tab: pageTab({ url: 'https://next.example/', loading: true }) });
    expect(field.element.value).toBe('https://next.example/');
  });

  it('shows a lock for https, a not secure notice for an http page elsewhere, and a globe otherwise', async () => {
    const { wrapper } = mountTab(pageTab());
    const notice = () => wrapper.find('[data-testid="browser-not-secure"]');
    expect(wrapper.find('.lucide-lock').exists()).toBe(true);
    expect(notice().exists()).toBe(false);
    expect(address(wrapper).attributes('aria-describedby')).toBeUndefined();

    await wrapper.setProps({ tab: pageTab({ url: 'http://plain.example/' }) });
    expect(wrapper.find('.lucide-lock').exists()).toBe(false);
    expect(notice().text()).toBe('Not secure');
    expect(notice().attributes('title')).toBe('The connection to this site is not encrypted, so others on the network can read and change what it sends.');
    expect(address(wrapper).attributes('aria-describedby')).toBe(notice().attributes('id'));
    expect(notice().attributes('for')).toBe(address(wrapper).attributes('id'));

    shellI18n.global.locale.value = 'el';
    await wrapper.vm.$nextTick();
    expect(notice().text()).toBe('Μη ασφαλής');
    shellI18n.global.locale.value = 'en';

    await wrapper.setProps({ tab: pageTab({ url: 'http://localhost:3000/' }) });
    await flushPromises();
    expect(wrapper.find('[data-testid="browser-nav"] .lucide-globe').exists()).toBe(true);
  });
});

describe('focus and bounds', () => {
  it('takes no focus by itself, and focuses and selects its address on a user\'s request', async () => {
    const { wrapper, store } = mountTab(pageTab());
    await flushPromises();
    expect(document.activeElement).not.toBe(address(wrapper).element);
    await wrapper.setProps({ tab: pageTab({ url: 'https://docs.example/b', loading: true }) });
    await flushPromises();
    expect(document.activeElement).not.toBe(address(wrapper).element);
    store.requestFocus('p1');
    await flushPromises();
    expect(document.activeElement).toBe(address(wrapper).element);
    expect(address(wrapper).element.selectionStart).toBe(0);
    expect(address(wrapper).element.selectionEnd).toBe(address(wrapper).element.value.length);
  });

  it('reports its page area to main while it shows, and no area once it goes', async () => {
    const api = fakeShellApi();
    const { wrapper } = mountTab(pageTab(), api);
    expect(api.reportBrowserBounds).toHaveBeenCalledWith(expect.objectContaining({ x: expect.any(Number), width: expect.any(Number) }));
    expect(FakeResizeObserver.instances.at(-1)?.observed).toContain(wrapper.get('[data-testid="browser-stage"]').element);
    wrapper.unmount();
    mounted.splice(mounted.indexOf(wrapper), 1);
    expect(api.reportBrowserBounds).toHaveBeenLastCalledWith(null);
  });

  it('reports the page card\'s corner radius inside its border, so main rounds the page view to fit the card', () => {
    const computed = window.getComputedStyle.bind(window);
    vi.stubGlobal('getComputedStyle', (element: Element) => {
      const style = computed(element);
      if ((element as HTMLElement).dataset['testid'] !== 'browser-card') return style;
      return { ...style, borderTopLeftRadius: '10px', borderTopWidth: '1px' } as CSSStyleDeclaration;
    });
    const api = fakeShellApi();
    mountTab(pageTab(), api);
    expect(api.reportBrowserBounds).toHaveBeenCalledWith(expect.objectContaining({ radius: 9 }));
  });
});

describe('load line', () => {
  it('trickles while the page loads, runs out and fades when it stops, and rests after', async () => {
    const { wrapper } = mountTab(pageTab());
    const line = () => wrapper.get('[data-testid="browser-progress"]');
    expect(line().attributes('data-phase')).toBe('idle');
    await wrapper.setProps({ tab: pageTab({ loading: true }) });
    expect(line().attributes('data-phase')).toBe('start');
    await frames();
    expect(line().attributes('data-phase')).toBe('loading');
    await wrapper.setProps({ tab: pageTab({ loading: false }) });
    expect(line().attributes('data-phase')).toBe('done');
    line().element.dispatchEvent(Object.assign(new Event('transitionend'), { propertyName: 'opacity' }));
    await flushPromises();
    expect(line().attributes('data-phase')).toBe('idle');
  });

  it('starts at rest on another page tab that is not loading', async () => {
    const { wrapper } = mountTab(pageTab({ loading: true }));
    await frames();
    await wrapper.setProps({ tab: pageTab({ url: 'https://other.example/' }, 'Other', 'p2') });
    expect(wrapper.get('[data-testid="browser-progress"]').attributes('data-phase')).toBe('idle');
  });
});

describe('page tabs in the strip', () => {
  async function mountTabs(tabs: ShellEditorTab[]): Promise<{ wrapper: VueWrapper; api: ReturnType<typeof fakeShellApi> }> {
    const api = fakeShellApi([], { getEditorState: vi.fn(async () => ({ ...EDITOR_STATE, tabs, activeTabId: tabs[0]!.id })) });
    const store = createEditorStore(api);
    await store.start();
    const wrapper = mount(EditorTabs, { props: { api, closeShortcut: 'Ctrl+W' }, global: { plugins: [shellI18n], provide: { [EDITOR_STORE]: store } }, attachTo: document.body });
    mounted.push(wrapper);
    await flushPromises();
    return { wrapper, api };
  }

  it('shows a favicon, a spinner while loading or a globe, and the page title without bidi controls', async () => {
    const { wrapper } = await mountTabs([
      pageTab({ iconDataUrl: 'data:image/png;base64,AAAA' }, 'Docs', 'p1'),
      pageTab({ loading: true }, 'Loading', 'p2'),
      pageTab({}, '\u202Eevil', 'p3'),
    ]);
    const tabs = wrapper.findAll('[data-editor-tab]');
    expect(tabs[0]!.get('[data-testid="editor-tab-favicon"]').attributes('src')).toBe('data:image/png;base64,AAAA');
    expect(tabs[1]!.find('[data-testid="editor-tab-loading"]').exists()).toBe(true);
    expect(tabs[1]!.text()).toContain('loading');
    expect(tabs[2]!.find('.lucide-globe').exists()).toBe(true);
    expect(tabs[2]!.text()).toContain('evil');
    expect(tabs[2]!.text()).not.toContain('\u202E');
    expect(tabs[0]!.attributes('draggable')).toBe('false');
  });

  it('offers Reload page, Open DevTools and Copy URL on a page tab, and sends each for that tab', async () => {
    const { wrapper, api } = await mountTabs([pageTab()]);
    const answers: OverlayAnswer[] = ['reloadPage', 'devTools', 'copyUrl'].map((itemId) => ({ kind: 'menu', itemId }));
    for (const answer of answers) {
      api.answerNext(answer);
      await wrapper.get('[data-editor-tab]').trigger('contextmenu', { clientX: 4, clientY: 4 });
      await flushPromises();
    }
    const request = api.overlayRequests.at(-1) as Extract<OverlayRequest, { kind: 'menu' }>;
    const labels = request.items.flatMap((item) => (item.kind === 'item' ? [item.label] : []));
    expect(labels).toEqual(['Close', 'Close others', 'Close to the right', 'Close all', 'Reload page', 'Open DevTools', 'Copy URL']);
    expect(vi.mocked(api.browserAction).mock.calls.map(([call]) => call)).toEqual([
      { tabId: 'p1', action: 'reload' },
      { tabId: 'p1', action: 'devTools' },
      { tabId: 'p1', action: 'copyUrl' },
    ]);
  });
});

describe('breadcrumbs', () => {
  it('names a page tab Browser and its host', () => {
    const wrapper = mount(Breadcrumbs, { props: { tab: pageTab({ url: 'https://docs.example:8080/a' }) }, global: { plugins: [shellI18n] } });
    mounted.push(wrapper);
    expect(wrapper.text()).toContain('Browser');
    expect(wrapper.text()).toContain('docs.example:8080');
    expect(wrapper.find('[data-testid="editor-read-only"]').exists()).toBe(false);
  });
});
