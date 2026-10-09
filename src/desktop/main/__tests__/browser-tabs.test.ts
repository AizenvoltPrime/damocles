import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', async () => (await import('./fake-views-electron')).fakeViewsElectron());

import type { PanelOptions } from '../../../platform/window-service';
import { AS_TYPED, HTTP_AT_ONCE, REFUSED, UPGRADED } from '../../../shared/__tests__/typed-address-cases';
import { BrowserTabs, isTypedAddress, type BrowserTabsEditor } from '../browser-tabs';
import type { PanelStateStore } from '../panel-state-store';
import { PanelViews, type DesktopPanel } from '../views';
import { contentsOf, fakeStates, fakeWindow, viewOf } from './fake-views-electron';

const CHAT: PanelOptions = { kind: 'chat', title: 'Damocles', localResourceRoots: [] };
const FILE_TAB = 'file-tab';
const AREA = { x: 700, y: 120, width: 500, height: 600 };

let states: PanelStateStore;
let browserEnabled: boolean;
let opened: string[];
let opens: boolean;
let openFailures: number;
let copied: string[];
let newPages: DesktopPanel[];
let focusAway: number;

// The editor pane as far as the browser tabs see it: one active tab, a file tab to fall back to, and the shell's focus requests.
function fakeEditor(): BrowserTabsEditor & { active: string | null; focused: string[]; shown: number; republished: number; tabs: BrowserTabs | undefined; activateFile(): void; set(tabId: string | null): void } {
  const editor = {
    active: null as string | null,
    focused: [] as string[],
    shown: 0,
    republished: 0,
    tabs: undefined as BrowserTabs | undefined,
    activeTabId: () => editor.active,
    activateBrowserTab: (tabId: string) => {
      editor.shown++;
      editor.set(tabId);
    },
    leaveBrowserTab: () => editor.set(FILE_TAB),
    browserTabsChanged: () => {
      editor.republished++;
    },
    focusTab: (tabId: string) => {
      editor.focused.push(tabId);
    },
    activateFile: () => editor.set(FILE_TAB),
    set: (tabId: string | null) => {
      if (editor.active === tabId) return;
      editor.active = tabId;
      editor.tabs?.activeChanged(tabId);
    },
  };
  return editor;
}

function setup(width = 1200) {
  const window = fakeWindow(width);
  const editor = fakeEditor();
  // The browser tabs and the views each need the other, as index.ts wires them.
  const owner: { views?: PanelViews } = {};
  const tabs = new BrowserTabs({
    editor,
    window: window as never,
    setPages: (chatPanelId, pages) => states.setPages(chatPanelId, pages),
    retainingStates: () => owner.views?.retainingStates ?? false,
    browserEnabled: () => browserEnabled,
    newPage: async (chat) => {
      newPages.push(chat);
      owner.views!.create({ options: { kind: 'browser', title: 'about:blank', localResourceRoots: [], owner: chat } });
    },
    openExternal: async (url) => {
      opened.push(url);
      return opens;
    },
    openExternalFailed: () => {
      openFailures++;
    },
    copy: async (text) => {
      copied.push(text);
    },
    focusAway: () => {
      focusAway++;
    },
  });
  editor.tabs = tabs;
  const views = new PanelViews({
    window: window as never,
    preloadPath: 'preload-panel.js',
    states,
    pages: tabs,
    log: () => undefined,
    onChange: () => undefined,
    onRestack: () => undefined,
    onReveal: () => undefined,
    onRendererGaveUp: () => undefined,
    onSavedSessionChange: () => undefined,
    popupOpen: () => false,
  }, (p) => p);
  owner.views = views;
  const chat = (): DesktopPanel => {
    const created = views.create({ options: CHAT });
    views.show(created.panelId, { focus: true });
    return created;
  };
  const page = (owner: DesktopPanel, url?: string): DesktopPanel => {
    const created = views.create({ options: { kind: 'browser', title: 'page', localResourceRoots: [], owner } });
    if (url !== undefined) void created.postMessage({ type: 'urlChanged', url });
    return created;
  };
  return { tabs, views, editor, chat, page, select: (target: DesktopPanel) => views.show(target.panelId, { focus: false }) };
}

const ids = (tabs: BrowserTabs): string[] => tabs.tabs().map((tab) => tab.id);

beforeEach(() => {
  states = fakeStates();
  browserEnabled = true;
  opened = [];
  opens = true;
  openFailures = 0;
  copied = [];
  newPages = [];
  focusAway = 0;
});

describe('ownership', () => {
  it('lists only the selected chat\'s pages, resolves only their ids, and closes a chat\'s pages with it', async () => {
    const { tabs, chat, page, select } = setup();
    const a = chat();
    const aPage = page(a, 'https://a.example/');
    const b = chat();
    const bPage = page(b, 'https://b.example/');

    expect(ids(tabs)).toEqual([bPage.panelId]);
    expect(tabs.tabs()[0]).toMatchObject({ kind: 'browser', title: 'page', displayPath: 'https://b.example/', browser: { url: 'https://b.example/', loading: false } });
    await expect(tabs.action(aPage.panelId, 'reload')).rejects.toThrow('Unknown page');
    expect(() => tabs.navigate(aPage.panelId, 'https://x.example/')).toThrow('Unknown page');
    expect(() => tabs.close(aPage.panelId)).toThrow('Unknown page');
    expect(aPage.isDisposed).toBe(false);

    expect(tabs.holdsPages(a)).toBe(true);
    a.close();
    expect(aPage.isDisposed).toBe(true);
    expect(tabs.holdsPages(a)).toBe(false);
    select(b);
    expect(ids(tabs)).toEqual([bPage.panelId]);
  });

  it('keeps a chat with saved pages on their way back, and only then', () => {
    const { tabs, chat } = setup();
    const a = chat();
    expect(tabs.holdsPages(a)).toBe(false);
    tabs.setRestoring(a, true);
    expect(tabs.holdsPages(a)).toBe(true);
    tabs.setRestoring(a, false);
    expect(tabs.holdsPages(a)).toBe(false);
  });

  it('persists each chat\'s page addresses from what core reports, with the page its tabs show first', () => {
    const { chat, page, editor } = setup();
    const a = chat();
    const first = page(a, 'https://one.example/');
    page(a, 'https://two.example/');
    editor.set(first.panelId);
    expect(states.get(a.panelId)?.browser).toEqual({ pages: ['https://one.example/', 'https://two.example/'], activePage: 0 });
  });

  it('writes the saved pages only when an address or the active page changes, never for a title, load or pick', () => {
    const { chat, page, editor } = setup();
    const a = chat();
    const first = page(a, 'https://a.example/');
    const second = page(a, 'https://b.example/');
    const writes = vi.spyOn(states, 'setPages');
    void second.postMessage({ type: 'navigationState', loading: true, canGoBack: true, canGoForward: false });
    void second.postMessage({ type: 'pickingStateChanged', picking: true });
    second.setTitle('A page');
    second.setTitle('Another title');
    editor.set(second.panelId);
    expect(writes).not.toHaveBeenCalled();
    void second.postMessage({ type: 'urlChanged', url: 'https://b.example/next' });
    editor.set(first.panelId);
    expect(writes).toHaveBeenCalledTimes(2);
    expect(states.get(a.panelId)?.browser).toEqual({ pages: ['https://a.example/', 'https://b.example/next'], activePage: 0 });
  });

  it('keeps the saved pages as they were while a host teardown closes them', () => {
    const { chat, page, views } = setup();
    const a = chat();
    page(a, 'https://kept.example/');
    views.retainStatesOnClose(true);
    a.close();
    expect(states.get(a.panelId)?.browser).toEqual({ pages: ['https://kept.example/'], activePage: 0 });
  });
});

describe('the page area', () => {
  it('rounds the shown page view to the corner radius the shell reports, so it sits inside its rounded card', () => {
    const { tabs, chat, page } = setup();
    tabs.setBounds(AREA, 9);
    const a = chat();
    const shown = page(a, 'https://a.example/');
    expect(viewOf(shown).setBounds).toHaveBeenLastCalledWith(AREA);
    expect(viewOf(shown).setBorderRadius).toHaveBeenLastCalledWith(9);
    tabs.setBounds({ ...AREA, width: 400 }, 14);
    expect(viewOf(shown).setBorderRadius).toHaveBeenLastCalledWith(14);
  });
});

describe('the swap on selection (D14)', () => {
  it('activates a new page of the selected chat, swaps the pages on a chat switch and returns each chat to its page', () => {
    const { tabs, editor, chat, page, select } = setup();
    tabs.setBounds(AREA);
    const a = chat();
    const aPage = page(a, 'https://a.example/');
    expect(editor.active).toBe(aPage.panelId);
    expect(aPage.visible).toBe(true);

    const b = chat();
    // Leaving a chat on its page tab gives the editor back a file tab; B has no pages.
    expect(editor.active).toBe(FILE_TAB);
    expect(ids(tabs)).toEqual([]);
    expect(aPage.visible).toBe(false);
    const bPage = page(b, 'https://b.example/');
    expect(bPage.visible).toBe(true);

    select(a);
    expect(ids(tabs)).toEqual([aPage.panelId]);
    expect(editor.active).toBe(aPage.panelId);
    expect(aPage.visible).toBe(true);
    expect(bPage.visible).toBe(false);

    select(b);
    expect(editor.active).toBe(bPage.panelId);
    expect(bPage.visible).toBe(true);
    expect(aPage.visible).toBe(false);
  });

  it('leaves a chat that was left on a file tab on its file tab, and reveals a background chat\'s page for its next selection', () => {
    const { tabs, editor, chat, page, select } = setup();
    tabs.setBounds(AREA);
    const a = chat();
    const aPage = page(a, 'https://a.example/');
    editor.activateFile();
    const b = chat();
    select(a);
    expect(editor.active).toBe(FILE_TAB);

    select(b);
    const second = page(a, 'https://a2.example/');
    expect(editor.active).toBe(FILE_TAB);
    expect(second.visible).toBe(false);
    aPage.reveal();
    expect(editor.active).toBe(FILE_TAB);
    select(a);
    expect(editor.active).toBe(aPage.panelId);
  });

  it('activates the neighbour when the active page closes, and a file tab after the last', () => {
    const { tabs, editor, chat, page } = setup();
    tabs.setBounds(AREA);
    const a = chat();
    const [one, two, three] = [1, 2, 3].map((n) => page(a, `https://${n}.example/`));
    editor.set(two!.panelId);
    tabs.close(two!.panelId);
    expect(editor.active).toBe(three!.panelId);
    tabs.close(three!.panelId);
    expect(editor.active).toBe(one!.panelId);
    one!.close();
    expect(editor.active).toBe(FILE_TAB);
    expect(ids(tabs)).toEqual([]);
  });

  it('leaves the active editor tab alone while saved pages come back, and reveals the saved one only as the chat\'s page', () => {
    const { tabs, editor, chat, page, select } = setup();
    tabs.setBounds(AREA);
    const a = chat();
    editor.activateFile();
    tabs.setRestoring(a, true);
    const first = page(a, 'https://one.example/');
    const second = page(a, 'https://two.example/');
    second.reveal();
    tabs.setRestoring(a, false);
    expect(editor.active).toBe(FILE_TAB);
    expect(editor.shown).toBe(0);
    expect(first.visible || second.visible).toBe(false);
    expect(states.get(a.panelId)?.browser.activePage).toBe(1);
    const b = chat();
    select(a);
    expect(editor.active).toBe(FILE_TAB);
    select(b);
  });
});

describe('page bounds', () => {
  it('lays only the active page tab\'s view over the reported page area, clamped to the window', () => {
    const { tabs, editor, chat, page } = setup(1000);
    const a = chat();
    const [one, two] = [page(a, 'https://1.example/'), page(a, 'https://2.example/')];
    expect(two.visible).toBe(false);
    tabs.setBounds(AREA);
    expect(two.visible).toBe(true);
    expect(viewOf(two).bounds).toEqual({ x: 700, y: 120, width: 300, height: 600 });
    expect(one.visible).toBe(false);
    editor.set(one.panelId);
    expect(one.visible).toBe(true);
    expect(two.visible).toBe(false);
  });

  it('shows no page while a file tab is the active editor tab, while the shell reports no page area, or while the browser is off', () => {
    const { tabs, editor, chat, page } = setup();
    const a = chat();
    const shown = page(a, 'https://a.example/');
    tabs.setBounds(AREA);
    expect(shown.visible).toBe(true);

    editor.activateFile();
    expect(shown.visible).toBe(false);
    tabs.setBounds(AREA);
    expect(shown.visible).toBe(false);
    expect(tabs.activePage()).toBeUndefined();

    editor.set(shown.panelId);
    expect(shown.visible).toBe(true);
    tabs.setBounds(undefined);
    expect(shown.visible).toBe(false);
    tabs.setBounds({ ...AREA, width: 0 });
    expect(shown.visible).toBe(false);

    tabs.setBounds(AREA);
    browserEnabled = false;
    tabs.enabledChanged();
    expect(shown.visible).toBe(false);
    expect(editor.active).toBe(FILE_TAB);
    expect(ids(tabs)).toEqual([]);
    expect(tabs.activePage()).toBeUndefined();
    browserEnabled = true;
    tabs.enabledChanged();
    expect(ids(tabs)).toEqual([shown.panelId]);
  });
});

describe('focus', () => {
  it('never focuses a page on creation, navigation, reveal, selection or a chat switch', () => {
    const { tabs, chat, page, select } = setup();
    tabs.setBounds(AREA);
    const a = chat();
    const shown = page(a, 'https://a.example/');
    void shown.postMessage({ type: 'navigationState', loading: true, canGoBack: true, canGoForward: false });
    shown.reveal();
    const b = chat();
    select(a);
    select(b);
    select(a);
    expect(contentsOf(shown).focus).not.toHaveBeenCalled();
  });

  it('moves focus away from a page view that closes or hides while it holds focus', () => {
    const { tabs, editor, chat, page } = setup();
    tabs.setBounds(AREA);
    const a = chat();
    const first = page(a, 'https://1.example/');
    const second = page(a, 'https://2.example/');
    contentsOf(second).focused = true;
    expect(tabs.focused()).toBe(true);
    editor.set(first.panelId);
    expect(focusAway).toBe(1);
    contentsOf(second).focused = false;
    contentsOf(first).focused = true;
    first.close();
    expect(focusAway).toBe(2);
  });

  it('focuses the tab of a blank page a user asked for, and only that one', async () => {
    const { tabs, editor, chat } = setup();
    const a = chat();
    await tabs.newPage();
    expect(newPages).toEqual([a]);
    expect(editor.focused).toEqual([editor.active]);
    browserEnabled = false;
    await tabs.newPage();
    expect(newPages).toEqual([a]);
  });
});

describe('navigation bar and tab actions', () => {
  it('turns each action into the webview message the page\'s own toolbar would post', async () => {
    const { tabs, chat, page } = setup();
    const a = chat();
    const shown = page(a, 'https://a.example/');
    const delivered: unknown[] = [];
    shown.onMessage((message) => delivered.push(message));
    for (const action of ['back', 'forward', 'reload', 'pickElement', 'devTools'] as const) await tabs.action(shown.panelId, action);
    expect(tabs.navigate(shown.panelId, 'example.com/x')).toBe(true);
    expect(delivered).toEqual([
      { type: 'goBack' },
      { type: 'goForward' },
      { type: 'reload' },
      { type: 'pickElement' },
      { type: 'openDevTools' },
      { type: 'navigate', url: 'example.com/x' },
    ]);
    delivered.length = 0;
    expect(tabs.navigate(shown.panelId, 'devbox:8080')).toBe(true);
    expect(tabs.navigate(shown.panelId, 'https://example.com/y')).toBe(true);
    expect(delivered).toEqual([{ type: 'navigate', url: 'devbox:8080' }, { type: 'navigate', url: 'https://example.com/y' }]);
  });

  it('refuses whatever isNavigableUrl refuses and navigates nothing then', () => {
    const { tabs, chat, page } = setup();
    const a = chat();
    const shown = page(a, 'https://a.example/');
    const delivered: unknown[] = [];
    shown.onMessage((message) => delivered.push(message));
    for (const refused of ['file:///c:/Windows/win.ini', 'javascript:alert(1)', 'data:text/html,x', 'chrome://settings', '   ', 'x'.repeat(8193)]) {
      expect(tabs.navigate(shown.panelId, refused)).toBe(false);
    }
    expect(delivered).toEqual([]);
  });

  // Core reads the text it is sent with the same rule (src/core/browser/__tests__/panel-wiring.test.ts runs the same table).
  it.each([...UPGRADED, ...HTTP_AT_ONCE, ...AS_TYPED])('sends %s to core as typed', (_kind, typed) => {
    const { tabs, chat, page } = setup();
    const shown = page(chat(), 'https://a.example/');
    const delivered: unknown[] = [];
    shown.onMessage((message) => delivered.push(message));
    expect(isTypedAddress(typed)).toBe(true);
    expect(tabs.navigate(shown.panelId, typed)).toBe(true);
    expect(delivered).toEqual([{ type: 'navigate', url: typed.trim() }]);
  });

  it('refuses what core would refuse, and an address past the length bound or not a string', () => {
    for (const typed of [...REFUSED, 'x'.repeat(8193), 42]) expect(isTypedAddress(typed)).toBe(false);
  });

  it('opens only an http or https page in the system browser, tells the user once when it cannot, and copies the address main observed', async () => {
    const { tabs, chat, page } = setup();
    const a = chat();
    const shown = page(a, 'about:blank');
    await tabs.action(shown.panelId, 'openExternal');
    expect(opened).toEqual([]);
    expect(openFailures).toBe(1);
    void shown.postMessage({ type: 'urlChanged', url: 'https://a.example/x' });
    await tabs.action(shown.panelId, 'openExternal');
    expect(openFailures).toBe(1);
    opens = false;
    await tabs.action(shown.panelId, 'openExternal');
    expect(openFailures).toBe(2);
    await tabs.action(shown.panelId, 'copyUrl');
    expect(opened).toEqual(['https://a.example/x', 'https://a.example/x']);
    expect(copied).toEqual(['https://a.example/x']);
  });

  it('shows what core reports about the page on its tab', () => {
    const { tabs, editor, chat, page } = setup();
    const a = chat();
    const shown = page(a, 'https://a.example/');
    const before = editor.republished;
    void shown.postMessage({ type: 'navigationState', loading: true, canGoBack: true, canGoForward: false });
    void shown.postMessage({ type: 'pickingStateChanged', picking: true });
    shown.setTitle('A page');
    expect(editor.republished).toBe(before + 3);
    expect(tabs.tabs()[0]).toMatchObject({ title: 'A page', browser: { url: 'https://a.example/', loading: true, canGoBack: true, canGoForward: false, picking: true } });
  });
});
