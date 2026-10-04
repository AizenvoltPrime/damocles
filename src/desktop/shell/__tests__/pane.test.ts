// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { DamoclesPaneApi, PanePage, PaneState } from '../../preload/pane-channels';
import PaneApp from '../pane/PaneApp.vue';
import PaneDivider from '../pane/components/PaneDivider.vue';
import PageTabStrip from '../pane/components/PageTabStrip.vue';
import PaneNavBar from '../pane/components/PaneNavBar.vue';
import { boundWidth, createWidthRequester } from '../pane/width-request';
import { isSendableAddress, pageTitle } from '../pane/page-ids';
import { shellI18n } from '../i18n';

const PAGES: PanePage[] = [
  { id: 'p1', title: 'Example Domain', url: 'https://example.com/', iconDataUrl: 'data:image/png;base64,AA==', loading: false, canGoBack: true, canGoForward: false, picking: false },
  { id: 'p2', title: 'Docs', url: 'https://docs.example.com/', loading: true, canGoBack: false, canGoForward: false, picking: false },
  { id: 'p3', title: 'about:blank', url: 'about:blank', iconDataUrl: 'https://evil.example/icon.png', loading: false, canGoBack: false, canGoForward: false, picking: false },
];

const STATE: PaneState = {
  locale: 'en',
  platform: 'win32',
  browserEnabled: true,
  toggleShortcutLabel: 'Ctrl+Shift+B',
  chatTabId: 'chat-1',
  mode: 'split',
  width: 480,
  minWidth: 320,
  maxWidth: 900,
  pages: PAGES,
  activePageId: 'p1',
};

function fakeApi(overrides: Partial<DamoclesPaneApi> = {}): DamoclesPaneApi & { push: (s: PaneState) => void; focus: () => void } {
  const stateListeners = new Set<(s: PaneState) => void>();
  const focusListeners = new Set<() => void>();
  return {
    getState: vi.fn(async () => STATE),
    onState: vi.fn((listener) => { stateListeners.add(listener); return () => stateListeners.delete(listener); }),
    onFocusRequest: vi.fn((listener) => { focusListeners.add(listener); return () => focusListeners.delete(listener); }),
    requestWidth: vi.fn(),
    selectPage: vi.fn(async () => {}),
    closePage: vi.fn(async () => {}),
    newPage: vi.fn(async () => {}),
    navigate: vi.fn(async () => true),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    openExternal: vi.fn(async () => {}),
    pickElement: vi.fn(async () => {}),
    openDevTools: vi.fn(async () => {}),
    setMaximized: vi.fn(async () => {}),
    setCollapsed: vi.fn(async () => {}),
    push: (s) => { for (const l of stateListeners) l(s); },
    focus: () => { for (const l of focusListeners) l(); },
    ...overrides,
  };
}

// Frames run only when the test flushes them, so batching is observable.
let frames: Array<() => void> = [];
function runFrames(): void {
  const due = frames;
  frames = [];
  for (const frame of due) frame();
}

beforeEach(() => {
  shellI18n.global.locale.value = 'en';
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) => frames.push(callback));
  vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
    frames[handle - 1] = () => {};
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('width requests', () => {
  it('bounds a width to whole CSS px inside main\'s limits and drops non-finite values', () => {
    expect(boundWidth(480.4, 320, 900)).toBe(480);
    expect(boundWidth(100, 320, 900)).toBe(320);
    expect(boundWidth(5000, 320, 900)).toBe(900);
    expect(boundWidth(Number.NaN, 320, 900)).toBeUndefined();
    expect(boundWidth(Number.POSITIVE_INFINITY, 320, 900)).toBeUndefined();
    // A window narrower than the minimum leaves max below min; the minimum wins, as main clamps.
    expect(boundWidth(500, 320, 200)).toBe(320);
  });

  it('sends the latest live width once per frame, skips repeats, and commits at once', () => {
    const send = vi.fn();
    const requester = createWidthRequester(send);

    requester.request(400);
    requester.request(410);
    requester.request(420);
    expect(send).not.toHaveBeenCalled();
    runFrames();
    expect(send.mock.calls).toEqual([[420, false]]);

    requester.request(420);
    runFrames();
    expect(send).toHaveBeenCalledTimes(1);

    requester.request(430);
    requester.commit(440);
    runFrames();
    expect(send.mock.calls).toEqual([[420, false], [440, true]]);
  });
});

describe('divider', () => {
  function mountDivider(props: Partial<{ width: number; minWidth: number; maxWidth: number }> = {}) {
    return mount(PaneDivider, {
      props: { width: 480, minWidth: 320, maxWidth: 900, controls: 'browser-pane', ...props },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    });
  }

  it('is a focusable vertical separator whose values are main\'s numbers', () => {
    const separator = mountDivider().get('[role="separator"]');

    expect(separator.attributes()).toMatchObject({
      'aria-orientation': 'vertical',
      'aria-valuenow': '480',
      'aria-valuemin': '320',
      'aria-valuemax': '900',
      'aria-valuetext': '480 pixels wide',
      'aria-controls': 'browser-pane',
      'aria-label': 'Resize browser pane',
      tabindex: '0',
    });
  });

  it('resizes by a step with the arrows (left widens), jumps with Home and End, and commits each key', async () => {
    const wrapper = mountDivider();
    const separator = wrapper.get('[role="separator"]');

    await separator.trigger('keydown', { key: 'ArrowLeft' });
    await separator.trigger('keydown', { key: 'ArrowRight' });
    await separator.trigger('keydown', { key: 'ArrowLeft', shiftKey: true });
    await separator.trigger('keydown', { key: 'Home' });
    await separator.trigger('keydown', { key: 'End' });

    expect(wrapper.emitted('resize')).toEqual([[496, true], [464, true], [544, true], [320, true], [900, true]]);
  });

  it('sends nothing for a key that cannot move it past a limit', async () => {
    const wrapper = mountDivider({ width: 900 });
    const separator = wrapper.get('[role="separator"]');

    await separator.trigger('keydown', { key: 'ArrowLeft' });
    await separator.trigger('keydown', { key: 'End' });

    expect(wrapper.emitted('resize')).toBeUndefined();
  });

  it('drags from screen coordinates, one bounded request per frame, and commits the last width on release', async () => {
    const wrapper = mountDivider();
    const separator = wrapper.get('[role="separator"]');
    const captured: number[] = [];
    (separator.element as HTMLElement).setPointerCapture = (id: number) => captured.push(id);

    await separator.trigger('pointerdown', { button: 0, pointerId: 7, screenX: 1000 });
    // The view moves under the pointer while main resizes it; only screenX counts.
    await separator.trigger('pointermove', { pointerId: 7, screenX: 990, clientX: 3 });
    await separator.trigger('pointermove', { pointerId: 7, screenX: 960, clientX: 3 });
    runFrames();
    await separator.trigger('pointermove', { pointerId: 7, screenX: -5000 });
    await separator.trigger('pointermove', { pointerId: 8, screenX: 0 });
    runFrames();
    await separator.trigger('pointerup', { pointerId: 7, screenX: -5000 });
    await separator.trigger('lostpointercapture', { pointerId: 7 });

    expect(captured).toEqual([7]);
    expect(wrapper.emitted('resize')).toEqual([[520, false], [900, false], [900, true]]);
  });
});

describe('page tab strip', () => {
  function mountStrip(pages = PAGES, activePageId = 'p1') {
    return mount(PageTabStrip, {
      props: { pages, activePageId, mac: false },
      global: { plugins: [shellI18n] },
      attachTo: document.body,
    });
  }

  it('follows the WAI-ARIA tabs pattern with one tabbable tab and only data: favicons', () => {
    const wrapper = mountStrip();
    const tabs = wrapper.findAll('[role="tab"]');

    expect(wrapper.get('[role="tablist"]').attributes('aria-label')).toBe('Pages');
    expect(tabs.map((tab) => tab.attributes('aria-label'))).toEqual(['Example Domain', 'Docs, loading', 'New page']);
    expect(tabs.map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs.map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(tabs[0]!.attributes('aria-controls')).toBe('pane-page');
    expect(tabs[1]!.attributes('aria-controls')).toBeUndefined();
    expect(tabs[0]!.find('img').attributes('src')).toBe('data:image/png;base64,AA==');
    expect(tabs[2]!.find('img').exists()).toBe(false);
    expect(tabs[1]!.find('.d-spinning').exists()).toBe(true);
    expect(wrapper.find('[role="tab"] button, [role="tab"] [tabindex]:not([role="tab"])').exists()).toBe(false);
  });

  it('shows page text without bidi controls, so a title cannot reorder itself or its neighbours', () => {
    const hostile = { ...PAGES[0]!, title: '‮gpj.exe⁦x' };

    expect(pageTitle(hostile, 'New page')).toBe('gpj.exex');
    expect(pageTitle({ ...PAGES[0]!, title: '‮' }, 'New page')).toBe('https://example.com/');
  });

  it('moves focus with arrows, Home and End without selecting; Enter selects; Delete closes', async () => {
    const wrapper = mountStrip();
    const tab = (i: number) => wrapper.findAll('[role="tab"]')[i]!;

    await tab(0).trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('pane-page-tab-p3');
    await tab(2).trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('pane-page-tab-p1');
    await tab(0).trigger('keydown', { key: 'End' });
    await tab(2).trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('pane-page-tab-p1');
    expect(wrapper.emitted('select')).toBeUndefined();

    await tab(1).trigger('keydown', { key: 'Enter' });
    await tab(1).trigger('keydown', { key: 'Delete' });
    await tab(0).trigger('keydown', { key: 'Backspace' });
    expect(wrapper.emitted('select')).toEqual([['p2']]);
    expect(wrapper.emitted('close')).toEqual([['p2']]);
  });
});

describe('nav bar', () => {
  function mountBar(api: DamoclesPaneApi, page: PanePage | undefined = PAGES[0]) {
    return mount(PaneNavBar, { props: { api, page }, global: { plugins: [shellI18n] }, attachTo: document.body });
  }

  it('reflects page state in disabled buttons and routes each action to the page', async () => {
    const api = fakeApi();
    const wrapper = mountBar(api);
    const button = (name: string) => wrapper.get(`button[aria-label="${name}"]`);

    expect(button('Back').attributes('disabled')).toBeUndefined();
    expect(button('Forward').attributes('disabled')).toBeDefined();
    for (const name of ['Back', 'Reload', 'Open in system browser', 'Pick an element for the chat', 'Developer tools']) await button(name).trigger('click');

    expect(api.goBack).toHaveBeenCalledWith('p1');
    expect(api.reload).toHaveBeenCalledWith('p1');
    expect(api.openExternal).toHaveBeenCalledWith('p1');
    expect(api.pickElement).toHaveBeenCalledWith('p1');
    expect(api.openDevTools).toHaveBeenCalledWith('p1');
    expect(button('Pick an element for the chat').attributes('aria-pressed')).toBe('false');
  });

  it('disables Open in system browser for a page that is not http or https, and shows a blank page as empty', () => {
    const wrapper = mountBar(fakeApi(), PAGES[2]);

    expect(wrapper.get('button[aria-label="Open in system browser"]').attributes('disabled')).toBeDefined();
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('');
  });

  it('navigates on Enter, shows a refusal, and Escape restores the page address', async () => {
    const api = fakeApi({ navigate: vi.fn(async () => false) });
    const wrapper = mountBar(api);
    const input = wrapper.get('input');

    await input.setValue('example.org');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(api.navigate).toHaveBeenCalledWith('p1', 'example.org');
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(wrapper.get('[role="status"]').text()).toContain('Only http and https pages are allowed.');

    await input.trigger('keydown', { key: 'Escape' });
    expect((input.element as HTMLInputElement).value).toBe('https://example.com/');
    expect(input.attributes('aria-invalid')).toBeUndefined();
  });

  it('keeps a sent address while main re-sends the old page, until the page moves or its load ends in place', async () => {
    const page = PAGES[0]!;
    const wrapper = mountBar(fakeApi(), page);
    const input = wrapper.get('input');
    const value = () => (input.element as HTMLInputElement).value;

    await input.setValue('example.org/next');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await wrapper.setProps({ page: { ...page } });
    expect(value()).toBe('example.org/next');
    await wrapper.setProps({ page: { ...page, loading: true } });
    expect(value()).toBe('example.org/next');
    await wrapper.setProps({ page: { ...page, url: 'https://example.org/next', loading: true } });
    expect(value()).toBe('https://example.org/next');

    await input.setValue('example.org/refused-by-core');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    await wrapper.setProps({ page: { ...page, url: 'https://example.org/next', loading: true } });
    expect(value()).toBe('example.org/refused-by-core');
    await wrapper.setProps({ page: { ...page, url: 'https://example.org/next', loading: false } });
    expect(value()).toBe('https://example.org/next');
  });

  it('refuses a non-web scheme without asking main', async () => {
    const api = fakeApi();
    const wrapper = mountBar(api);
    const input = wrapper.get('input');

    await input.setValue('file:///etc/passwd');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();

    expect(api.navigate).not.toHaveBeenCalled();
    expect(input.attributes('aria-invalid')).toBe('true');
    expect(isSendableAddress('javascript:alert(1)')).toBe(false);
    expect(isSendableAddress('HTTPS://example.com')).toBe(true);
    expect(isSendableAddress('about:blank')).toBe(true);
  });
});

describe('pane app', () => {
  const { activePageId: _active, ...NO_ACTIVE_PAGE } = STATE;

  async function mountPane(state: PaneState = STATE, api = fakeApi({ getState: vi.fn(async () => state) })) {
    const wrapper = mount(PaneApp, { props: { api }, global: { plugins: [shellI18n] }, attachTo: document.body });
    await flushPromises();
    return { wrapper, api };
  }

  it('split: divider, tabs, the page region, and the collapse tooltip with main\'s shortcut', async () => {
    const { wrapper, api } = await mountPane();

    expect(wrapper.find('[role="separator"]').exists()).toBe(true);
    expect((wrapper.get('input').element as HTMLInputElement).value).toBe('https://example.com/');
    expect(wrapper.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe('pane-page-tab-p1');
    const collapse = wrapper.get('button[aria-label="Hide browser pane"]');
    expect(collapse.attributes('title')).toBe('Hide browser pane (Ctrl+Shift+B)');
    await collapse.trigger('click');
    await wrapper.get('button[aria-label="Maximize pane"]').trigger('click');
    expect(api.setCollapsed).toHaveBeenCalledWith(true);
    expect(api.setMaximized).toHaveBeenCalledWith(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(api.setCollapsed).toHaveBeenCalledTimes(1);
  });

  it('overlay: a scrim of the remaining width collapses on click, Escape collapses, and the pane keeps main\'s width', async () => {
    const { wrapper, api } = await mountPane({ ...STATE, mode: 'overlay' });

    expect(wrapper.get('section').attributes('style')).toContain('width: 480px');
    await wrapper.get('[aria-hidden="true"].bg-black\\/25').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(vi.mocked(api.setCollapsed).mock.calls).toEqual([[true], [true]]);
  });

  it('maximized: no divider, and the toggle restores the split', async () => {
    const { wrapper, api } = await mountPane({ ...STATE, mode: 'maximized' });

    expect(wrapper.find('[role="separator"]').exists()).toBe(false);
    await wrapper.get('button[aria-label="Restore side-by-side view"]').trigger('click');
    expect(api.setMaximized).toHaveBeenCalledWith(false);
  });

  it('empty: explains itself and offers a new page whose address field then takes focus', async () => {
    const { wrapper, api } = await mountPane({ ...NO_ACTIVE_PAGE, pages: [] });

    expect(wrapper.find('[role="tabpanel"]').exists()).toBe(false);
    expect(wrapper.text()).toContain('Pages the agent opens in this conversation appear here.');
    const buttons = wrapper.findAll('button').filter((b) => b.text() === 'New page');
    await buttons[0]!.trigger('click');
    expect(api.newPage).toHaveBeenCalled();

    (api as ReturnType<typeof fakeApi>).push({ ...STATE, pages: [PAGES[2]!], activePageId: 'p3' });
    await flushPromises();
    expect(document.activeElement?.id).toBe('pane-address');
  });

  it('sends the divider\'s resize to main and focuses the active page tab when main asks (F6)', async () => {
    const { wrapper, api } = await mountPane();

    await wrapper.get('[role="separator"]').trigger('keydown', { key: 'Home' });
    expect(api.requestWidth).toHaveBeenCalledWith(320, true);

    (api as ReturnType<typeof fakeApi>).focus();
    expect(document.activeElement?.id).toBe('pane-page-tab-p1');
  });

  it('follows main\'s locale', async () => {
    const { wrapper } = await mountPane({ ...STATE, locale: 'el' });

    expect(document.documentElement.lang).toBe('el');
    expect(wrapper.get('[role="separator"]').attributes('aria-label')).toBe('Αλλαγή πλάτους του πλαισίου περιήγησης');
    expect(wrapper.get('input').attributes('aria-label')).toBe('Διεύθυνση');
  });
});
