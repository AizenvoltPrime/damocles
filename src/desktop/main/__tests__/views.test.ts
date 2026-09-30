import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ views: [] as unknown[], webContentsOptions: [] as unknown[] }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  let nextId = 1;
  class FakeIpc extends Emitter {
    readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void {
      this.handlers.set(channel, handler);
    }
    removeHandler(channel: string): void {
      this.handlers.delete(channel);
    }
  }
  class FakeWebContents extends Emitter {
    readonly id = nextId++;
    readonly ipc = new FakeIpc();
    readonly mainFrame = { url: '', parent: null };
    focused = false;
    readonly focus = vi.fn(() => {
      this.focused = true;
    });
    readonly send = vi.fn();
    readonly close = vi.fn();
    readonly setZoomFactor = vi.fn();
    readonly loadURL = vi.fn(async (url: string) => {
      this.mainFrame.url = url;
    });
    isDestroyed(): boolean {
      return false;
    }
    isCrashed(): boolean {
      return false;
    }
    isFocused(): boolean {
      return this.focused;
    }
  }
  class WebContentsView {
    readonly webContents = new FakeWebContents();
    private visible = true;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = bounds;
    });
    readonly setVisible = vi.fn((visible: boolean) => {
      this.visible = visible;
    });
    constructor(options: { webPreferences: unknown }) {
      H.webContentsOptions.push(options.webPreferences);
      H.views.push(this);
    }
    getVisible(): boolean {
      return this.visible;
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds;
    }
  }
  return {
    WebContentsView,
    nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
    protocol: {},
  };
});

import type { PanelOptions } from '../../../platform/window-service';
import { PANEL_CHANNELS } from '../../preload/panel-channels';
import { PANE_CHANNELS, PANE_CHROME_HEIGHT, PANE_DIVIDER_WIDTH, type PaneState } from '../../preload/pane-channels';
import { CHAT_MIN_WIDTH, PANE_MIN_WIDTH } from '../pane-layout';
import { EMPTY_PANE, type PanelStateStore, type PersistedPane, type PersistedPanel } from '../panel-state-store';
import { PANE_PAGE_URL } from '../protocol';
import { PanelViews, type DesktopPanel, type PaneContext } from '../views';

const CHAT: PanelOptions = { kind: 'chat', title: 'Damocles', localResourceRoots: [] };

function pageOptions(owner: unknown): PanelOptions {
  return { kind: 'browser', title: 'page', localResourceRoots: [], owner: owner as DesktopPanel };
}

// PanelStateStore's in-memory behaviour, without its file.
function fakeStates(initial: readonly PersistedPanel[] = []): PanelStateStore & { savedWidth: number | undefined } {
  const panels = new Map<string, PersistedPanel>(initial.map((panel) => [panel.panelId, panel]));
  let selected: string | undefined;
  const store = {
    savedWidth: undefined as number | undefined,
    list: () => [...panels.values()],
    get: (id: string) => panels.get(id),
    selected: () => selected,
    paneWidth: () => store.savedWidth,
    set: (panel: { panelId: string; state: unknown }) => {
      panels.set(panel.panelId, { panelId: panel.panelId, kind: 'chat', state: panel.state, pane: panels.get(panel.panelId)?.pane ?? EMPTY_PANE });
    },
    setPane: (id: string, pane: PersistedPane) => {
      const panel = panels.get(id);
      if (panel) panels.set(id, { ...panel, pane });
    },
    setPaneWidth: (width: number) => {
      store.savedWidth = width;
    },
    delete: (id: string) => {
      panels.delete(id);
      if (selected === id) selected = undefined;
    },
    reorder: () => undefined,
    select: (id: string) => {
      if (panels.has(id)) selected = id;
    },
  };
  return store as unknown as PanelStateStore & { savedWidth: number | undefined };
}

type FakeView = { webContents: FakeContents; setBounds: ReturnType<typeof vi.fn>; setVisible: ReturnType<typeof vi.fn>; getVisible(): boolean; bounds: { x: number; y: number; width: number; height: number } };

function fakeWindow(width = 1200) {
  const children: unknown[] = [];
  return Object.assign(new EventEmitter(), {
    children,
    contentView: {
      addChildView: vi.fn((view: unknown) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
        children.push(view);
      }),
      removeChildView: vi.fn((view: unknown) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
      }),
    },
    isDestroyed: () => false,
    isFocused: () => true,
    getContentBounds: () => ({ x: 0, y: 0, width, height: 800 }),
    setBackgroundColor: vi.fn(),
  });
}

let states: PanelStateStore & { savedWidth: number | undefined };
let gaveUp: DesktopPanel[];
let lines: string[];
let window: ReturnType<typeof fakeWindow>;
let browserEnabled: boolean;
let opened: string[];
let newPages: DesktopPanel[];

const context: PaneContext = {
  locale: 'en',
  platform: 'win32',
  toggleShortcutLabel: 'Ctrl+Shift+B',
  browserEnabled: () => browserEnabled,
  newPage: async (chat) => {
    newPages.push(chat);
  },
  openExternal: async (url) => {
    opened.push(url);
    return true;
  },
};

function views(width = 1200): PanelViews {
  window = fakeWindow(width);
  return new PanelViews({
    window: window as never,
    preloadPath: 'preload-panel.js',
    panePreloadPath: 'preload-pane.js',
    states,
    log: (line) => lines.push(line),
    onChange: () => undefined,
    onRendererGaveUp: (panel) => gaveUp.push(panel),
    onPaneGaveUp: () => undefined,
    paneContext: () => context,
  }, (p) => p);
}

type FakeContents = DesktopPanel['webContents'] & {
  ipc: EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> };
  focus: ReturnType<typeof vi.fn>;
  focused: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  mainFrame: { url: string; parent: null };
};

function contentsOf(panel: DesktopPanel): FakeContents {
  return panel.webContents as FakeContents;
}

function viewOf(panel: DesktopPanel): FakeView {
  return panel.view as unknown as FakeView;
}

function paneView(tabs: PanelViews): FakeView {
  return tabs.pane.view as unknown as FakeView;
}

// Calls a pane channel as the pane page's own main frame does.
async function invoke(tabs: PanelViews, channel: string, ...args: unknown[]): Promise<unknown> {
  const contents = paneView(tabs).webContents;
  const handler = contents.ipc.handlers.get(channel);
  if (!handler) throw new Error(`no handler for ${channel}`);
  return handler({ sender: contents, senderFrame: { url: PANE_PAGE_URL, parent: null } }, ...args);
}

function paneState(tabs: PanelViews): Promise<PaneState> {
  return invoke(tabs, PANE_CHANNELS.getState) as Promise<PaneState>;
}

beforeEach(() => {
  states = fakeStates();
  gaveUp = [];
  lines = [];
  opened = [];
  newPages = [];
  browserEnabled = true;
  H.views.length = 0;
  H.webContentsOptions.length = 0;
});

describe('PanelViews teardown', () => {
  it('keeps the persisted selection and shows no neighbour while tab states are retained', () => {
    const tabs = views();
    const [home, alpha, beta, fork] = ['home', 'alpha', 'beta', 'fork'].map((panelId) => tabs.create({ options: CHAT, restore: { panelId, state: null } }));
    tabs.show(beta!.panelId, { focus: true });
    const forkFocus = contentsOf(fork!).focus.mock.calls.length;
    tabs.retainStatesOnClose(true);

    for (const panel of [home!, beta!, alpha!, fork!]) panel.close();

    expect(states.selected()).toBe('beta');
    expect(states.list().map((p) => p.panelId)).toEqual(['home', 'alpha', 'beta', 'fork']);
    expect(contentsOf(fork!).focus.mock.calls.length).toBe(forkFocus);
  });

  it('selects the neighbour of a closed selected tab when states are not retained', () => {
    const tabs = views();
    const [, beta, fork] = ['alpha', 'beta', 'fork'].map((panelId) => tabs.create({ options: CHAT, restore: { panelId, state: null } }));
    tabs.show(beta!.panelId, { focus: true });
    beta!.close();
    expect(tabs.selected()).toBe(fork);
    expect(states.selected()).toBe('fork');
  });

  it('refuses to open a panel id that is already open', () => {
    const tabs = views();
    tabs.create({ options: CHAT, restore: { panelId: 'alpha', state: null } });
    expect(() => tabs.create({ options: CHAT, restore: { panelId: 'alpha', state: null } })).toThrow('already open');
  });
});

describe('panel IPC', () => {
  it('carries no panel id to the renderer and listens only on the view\'s own webContents.ipc', async () => {
    const tabs = views();
    const panel = tabs.create({ options: CHAT });
    expect(H.webContentsOptions.every((options) => !Object.hasOwn(options as object, 'additionalArguments'))).toBe(true);
    panel.setHtml('<html></html>');
    await Promise.resolve();
    const contents = contentsOf(panel);
    const received = vi.fn();
    panel.onMessage(received);

    contents.ipc.emit(PANEL_CHANNELS.post, { sender: contents, senderFrame: contents.mainFrame }, { type: 'ready' });
    expect(received).toHaveBeenCalledWith({ type: 'ready' });

    const other = contentsOf(tabs.create({ options: CHAT }));
    contents.ipc.emit(PANEL_CHANNELS.post, { sender: other, senderFrame: contents.mainFrame }, { type: 'injected' });
    contents.ipc.emit(PANEL_CHANNELS.post, { sender: contents, senderFrame: { url: contents.mainFrame.url, parent: {} } }, { type: 'from a subframe' });
    const init = { sender: contents, senderFrame: { url: 'app://damocles/panel/other/index.html', parent: null }, returnValue: undefined as unknown };
    contents.ipc.emit(PANEL_CHANNELS.init, init);
    expect(received).toHaveBeenCalledTimes(1);
    expect(init.returnValue).toBeNull();
    expect(lines.filter((line) => line.includes(`panel ${panel.panelId}: rejected ${PANEL_CHANNELS.post}`))).toHaveLength(2);

    panel.close();
    expect(contents.ipc.listenerCount(PANEL_CHANNELS.post)).toBe(0);
  });
});

describe('renderer crashes', () => {
  it('reloads a crashed tab until the crash limit, then reports it once and can be restarted', async () => {
    const tabs = views();
    const panel = tabs.create({ options: CHAT });
    panel.setHtml('<html></html>');
    const contents = contentsOf(panel);
    const crash = (): void => {
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    };

    for (let i = 0; i < 3; i++) crash();
    expect(contents.loadURL).toHaveBeenCalledTimes(4);
    expect(gaveUp).toEqual([]);

    crash();
    expect(contents.loadURL).toHaveBeenCalledTimes(4);
    expect(gaveUp).toEqual([panel]);

    panel.restart();
    expect(contents.loadURL).toHaveBeenCalledTimes(5);
  });
});

describe('browser pages in a chat tab pane', () => {
  it('opens a page only beside an open chat tab', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    expect(() => tabs.create({ options: pageOptions(undefined) })).toThrow('beside an open chat tab');
    expect(() => tabs.create({ options: pageOptions({ panelId: chat.panelId }) })).toThrow('beside an open chat tab');
    const page = tabs.create({ options: pageOptions(chat) });
    expect(() => tabs.create({ options: pageOptions(page) })).toThrow('beside an open chat tab');
    chat.close();
    expect(() => tabs.create({ options: pageOptions(chat) })).toThrow('beside an open chat tab');
  });

  it('adds the page to its chat pane, opens the pane, and never moves focus or the selected tab', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const focusBefore = contentsOf(chat).focus.mock.calls.length;
    const page = tabs.create({ options: pageOptions(chat) });

    expect(contentsOf(page).focus).not.toHaveBeenCalled();
    expect(contentsOf(chat).focus.mock.calls.length).toBe(focusBefore);
    expect(tabs.selected()).toBe(chat);
    expect(tabs.tabs()).toEqual([chat]);
    expect(chat.pane).toMatchObject({ open: true, activePageId: page.panelId, pages: [page] });
    expect(page.visible).toBe(true);
    expect(tabs.activePage()).toBe(page);
    expect(states.get(chat.panelId)?.pane.open).toBe(true);
  });

  it('creates page and pane views that never take focus when they navigate', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    tabs.create({ options: pageOptions(chat) });
    const [pane, chatPreferences, pagePreferences] = H.webContentsOptions as Array<Record<string, unknown>>;
    expect(pane).toMatchObject({ preload: 'preload-pane.js', focusOnNavigation: false });
    expect(pagePreferences).toMatchObject({ preload: 'preload-panel.js', focusOnNavigation: false, sandbox: true, contextIsolation: true, nodeIntegration: false });
    expect(chatPreferences).not.toHaveProperty('focusOnNavigation');
  });

  it('pushes the pane state when a resize changes its layout numbers', async () => {
    const tabs = views(1200);
    const chat = tabs.create({ options: CHAT });
    tabs.create({ options: pageOptions(chat) });
    const contents = paneView(tabs).webContents as unknown as FakeContents & { emit(event: string): boolean; send: ReturnType<typeof vi.fn> };
    contents.emit('did-finish-load');
    contents.send.mockClear();
    tabs.setContentBounds({ x: 0, y: 0, width: 600, height: 800 });
    await new Promise((resolve) => setImmediate(resolve));
    const pushed = contents.send.mock.calls.filter(([channel]) => channel === PANE_CHANNELS.state).map(([, state]) => state as PaneState);
    expect(pushed.at(-1)).toMatchObject({ mode: 'overlay', maxWidth: 600 - 48 });
  });

  it('lays chat, pane and page out side by side and stacks chat < pane < page', () => {
    const tabs = views(1200);
    const chat = tabs.create({ options: CHAT });
    const page = tabs.create({ options: pageOptions(chat) });
    const width = 480;
    expect(viewOf(chat).bounds).toEqual({ x: 0, y: 0, width: 1200 - width, height: 800 });
    expect(paneView(tabs).bounds).toEqual({ x: 1200 - width, y: 0, width, height: 800 });
    expect(viewOf(page).bounds).toEqual({ x: 1200 - width + PANE_DIVIDER_WIDTH, y: PANE_CHROME_HEIGHT, width: width - PANE_DIVIDER_WIDTH, height: 800 - PANE_CHROME_HEIGHT });
    const order = (): number[] => [chat.view, tabs.pane.view, page.view].map((view) => window.children.indexOf(view));
    expect(order()).toEqual([...order()].sort((a, b) => a - b));

    // A chat tab created later is restacked below the pane and page when it is selected back.
    const second = tabs.create({ options: CHAT });
    tabs.show(chat.panelId, { focus: false });
    const stack = [second.view, tabs.pane.view, page.view].map((view) => window.children.indexOf(view));
    expect(stack).toEqual([...stack].sort((a, b) => a - b));
  });

  it('keeps a page in a background chat hidden until that tab is selected', () => {
    const tabs = views();
    const first = tabs.create({ options: CHAT });
    const second = tabs.create({ options: CHAT });
    const page = tabs.create({ options: pageOptions(first) });
    expect(tabs.selected()).toBe(second);
    expect(page.visible).toBe(false);
    expect(paneView(tabs).getVisible()).toBe(false);
    tabs.show(first.panelId, { focus: true });
    expect(page.visible).toBe(true);
    expect(paneView(tabs).getVisible()).toBe(true);
    tabs.show(second.panelId, { focus: true });
    expect(page.visible).toBe(false);
  });

  it('reveals a page in its pane without focus and without switching tabs', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const first = tabs.create({ options: pageOptions(chat) });
    const second = tabs.create({ options: pageOptions(chat) });
    const other = tabs.create({ options: CHAT });
    first.reveal();
    expect(tabs.selected()).toBe(other);
    expect(chat.pane?.activePageId).toBe(first.panelId);
    tabs.show(chat.panelId, { focus: false });
    expect(first.visible).toBe(true);
    expect(second.visible).toBe(false);
    expect(contentsOf(first).focus).not.toHaveBeenCalled();
  });

  it('selects the neighbour when the active page closes and collapses the pane with the last page', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const [a, b, c] = [0, 1, 2].map(() => tabs.create({ options: pageOptions(chat) }));
    b!.reveal();
    b!.close();
    expect(chat.pane?.activePageId).toBe(c!.panelId);
    c!.close();
    expect(chat.pane?.activePageId).toBe(a!.panelId);
    contentsOf(a!).focused = true;
    a!.close();
    expect(chat.pane).toMatchObject({ open: false, pages: [], activePageId: undefined });
    expect(paneView(tabs).getVisible()).toBe(false);
    expect(contentsOf(chat).focus).toHaveBeenCalled();
  });

  it('moves focus from a closed focused page to the pane while other pages remain', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    tabs.create({ options: pageOptions(chat) });
    const focused = tabs.create({ options: pageOptions(chat) });
    contentsOf(focused).focused = true;
    focused.close();
    expect(paneView(tabs).webContents.focus).toHaveBeenCalledTimes(1);
  });

  it('closes every page of a chat tab that closes, and forgets them', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const pages = [0, 1].map(() => tabs.create({ options: pageOptions(chat) }));
    const disposed = vi.fn();
    for (const page of pages) page.onDispose(disposed);
    chat.close();
    expect(disposed).toHaveBeenCalledTimes(2);
    expect(pages.every((page) => page.isDisposed)).toBe(true);
    expect(states.get(chat.panelId)).toBeUndefined();
    expect(tabs.panel(pages[0]!.panelId)).toBeUndefined();
  });

  it('keeps the saved pane while a host teardown closes the pages', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const page = tabs.create({ options: pageOptions(chat) });
    void page.postMessage({ type: 'urlChanged', url: 'https://kept.example/' });
    tabs.retainStatesOnClose(true);
    chat.close();
    expect(states.get(chat.panelId)?.pane).toEqual({ open: true, maximized: false, pages: ['https://kept.example/'], activePage: 0 });
  });

  it('persists each page address from core\'s urlChanged and never from the page renderer', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const page = tabs.create({ options: pageOptions(chat) });
    void page.postMessage({ type: 'urlChanged', url: 'https://a.example/' });
    const contents = contentsOf(page);
    contents.ipc.emit(PANEL_CHANNELS.setState, { sender: contents, senderFrame: { url: page.pageUrl, parent: null } }, { url: 'file:///etc/passwd' });
    expect(states.get(chat.panelId)?.pane.pages).toEqual(['https://a.example/']);
    expect(states.get(page.panelId)).toBeUndefined();
  });

  it('restores the pane as saved while its pages arrive, then leaves reveal alone', () => {
    states = fakeStates([{ panelId: 'saved', kind: 'chat', state: null, pane: { open: false, maximized: false, pages: ['https://a.example/'] } }]);
    const tabs = views();
    const chat = tabs.create({ options: CHAT, restore: { panelId: 'saved', state: null } });
    tabs.setRestoring(chat, true);
    const page = tabs.create({ options: pageOptions(chat) });
    page.reveal();
    expect(chat.pane?.open).toBe(false);
    tabs.setRestoring(chat, false);
    tabs.create({ options: pageOptions(chat) });
    expect(chat.pane?.open).toBe(true);
  });

  it('restores a maximized pane with focus in the pane rather than the hidden composer', () => {
    states = fakeStates([{ panelId: 'saved', kind: 'chat', state: null, pane: { open: true, maximized: true, pages: [] } }]);
    const tabs = views();
    const chat = tabs.create({ options: CHAT, restore: { panelId: 'saved', state: null } });
    expect(paneView(tabs).webContents.focus).toHaveBeenCalled();
    expect(contentsOf(chat).focus).not.toHaveBeenCalled();
  });

  it('hides the pane while the browser is turned off and ignores the toggle', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const page = tabs.create({ options: pageOptions(chat) });
    browserEnabled = false;
    tabs.browserEnabledChanged();
    expect(page.visible).toBe(false);
    expect(paneView(tabs).getVisible()).toBe(false);
    tabs.togglePane(chat.panelId);
    expect(chat.pane?.open).toBe(true);
  });

  it('toggles the pane and moves focus back to the chat when the focused pane collapses', () => {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    tabs.togglePane(chat.panelId);
    expect(chat.pane?.open).toBe(true);
    expect(paneView(tabs).getVisible()).toBe(true);
    contentsOf(chat).focus.mockClear();
    paneView(tabs).webContents.focused = true;
    tabs.togglePane(chat.panelId);
    expect(chat.pane?.open).toBe(false);
    expect(contentsOf(chat).focus).toHaveBeenCalledTimes(1);
  });
});

describe('pane actions', () => {
  function setup() {
    const tabs = views();
    const chat = tabs.create({ options: CHAT });
    const page = tabs.create({ options: pageOptions(chat) });
    const delivered: unknown[] = [];
    page.onMessage((message) => delivered.push(message));
    return { tabs, chat, page, delivered };
  }

  it('reports the selected chat tab pane with main\'s layout numbers', async () => {
    const { tabs, chat, page } = setup();
    void page.postMessage({ type: 'urlChanged', url: 'https://a.example/' });
    void page.postMessage({ type: 'navigationState', loading: true, canGoBack: true, canGoForward: false });
    void page.postMessage({ type: 'pickingStateChanged', picking: true });
    page.setTitle('A page');
    expect(await paneState(tabs)).toEqual({
      locale: 'en',
      platform: 'win32',
      browserEnabled: true,
      toggleShortcutLabel: 'Ctrl+Shift+B',
      chatTabId: chat.panelId,
      mode: 'split',
      width: 480,
      minWidth: PANE_MIN_WIDTH,
      maxWidth: 1200 - CHAT_MIN_WIDTH,
      pages: [{ id: page.panelId, title: 'A page', url: 'https://a.example/', loading: true, canGoBack: true, canGoForward: false, picking: true }],
      activePageId: page.panelId,
    });
  });

  it('delivers navigation as the page\'s own webview messages, and refuses a non-web address', async () => {
    const { tabs, page, delivered } = setup();
    expect(await invoke(tabs, PANE_CHANNELS.navigate, page.panelId, 'example.com/x')).toBe(true);
    expect(await invoke(tabs, PANE_CHANNELS.navigate, page.panelId, 'file:///c:/Windows/win.ini')).toBe(false);
    expect(await invoke(tabs, PANE_CHANNELS.navigate, page.panelId, 'javascript:alert(1)')).toBe(false);
    for (const channel of [PANE_CHANNELS.goBack, PANE_CHANNELS.goForward, PANE_CHANNELS.reload, PANE_CHANNELS.pickElement, PANE_CHANNELS.openDevTools]) {
      await invoke(tabs, channel, page.panelId);
    }
    expect(delivered).toEqual([
      { type: 'navigate', url: 'https://example.com/x' },
      { type: 'goBack' },
      { type: 'goForward' },
      { type: 'reload' },
      { type: 'pickElement' },
      { type: 'openDevTools' },
    ]);
  });

  it('resolves page ids only against the selected chat tab', async () => {
    const { tabs, page, delivered } = setup();
    tabs.create({ options: CHAT });
    await expect(invoke(tabs, PANE_CHANNELS.reload, page.panelId)).rejects.toThrow('Unknown page');
    await expect(invoke(tabs, PANE_CHANNELS.closePage, page.panelId)).rejects.toThrow('Unknown page');
    await expect(invoke(tabs, PANE_CHANNELS.selectPage, 'no-such-page')).rejects.toThrow('Unknown page');
    expect(delivered).toEqual([]);
    expect(page.isDisposed).toBe(false);
  });

  it('opens only an http or https page in the system browser, with the URL main observed', async () => {
    const { tabs, page } = setup();
    void page.postMessage({ type: 'urlChanged', url: 'about:blank' });
    await expect(invoke(tabs, PANE_CHANNELS.openExternal, page.panelId)).rejects.toThrow('Only http and https');
    void page.postMessage({ type: 'urlChanged', url: 'https://a.example/' });
    await invoke(tabs, PANE_CHANNELS.openExternal, page.panelId);
    expect(opened).toEqual(['https://a.example/']);
  });

  it('opens a new page beside the selected chat only while the browser is on', async () => {
    const { tabs, chat } = setup();
    await invoke(tabs, PANE_CHANNELS.newPage);
    expect(newPages).toEqual([chat]);
    browserEnabled = false;
    await expect(invoke(tabs, PANE_CHANNELS.newPage)).rejects.toThrow('turned off');
    expect(newPages).toEqual([chat]);
  });

  it('selects, closes, maximizes and collapses', async () => {
    const { tabs, chat, page } = setup();
    const second = tabs.create({ options: pageOptions(chat) });
    await invoke(tabs, PANE_CHANNELS.selectPage, page.panelId);
    expect(page.visible).toBe(true);
    expect(second.visible).toBe(false);
    await invoke(tabs, PANE_CHANNELS.setMaximized, true);
    expect((await paneState(tabs)).mode).toBe('maximized');
    expect(viewOf(page).bounds).toEqual({ x: 0, y: PANE_CHROME_HEIGHT, width: 1200, height: 800 - PANE_CHROME_HEIGHT });
    expect(chat.visible).toBe(false);
    await invoke(tabs, PANE_CHANNELS.setMaximized, false);
    expect((await paneState(tabs)).mode).toBe('split');
    expect(chat.visible).toBe(true);
    await invoke(tabs, PANE_CHANNELS.closePage, second.panelId);
    expect(second.isDisposed).toBe(true);
    await invoke(tabs, PANE_CHANNELS.setCollapsed, true);
    expect((await paneState(tabs)).mode).toBe('collapsed');
    expect(page.visible).toBe(false);
    await expect(invoke(tabs, PANE_CHANNELS.setCollapsed, 'yes')).rejects.toThrow('Malformed flag');
  });

  it('clamps a requested width, lays out in the same call and persists only a committed one', async () => {
    const { tabs, chat, page } = setup();
    const contents = paneView(tabs).webContents;
    const request = (width: unknown, commit: unknown): void => {
      contents.ipc.emit(PANE_CHANNELS.requestWidth, { sender: contents, senderFrame: { url: PANE_PAGE_URL, parent: null } }, width, commit);
    };
    request(600, false);
    expect(viewOf(chat).bounds.width).toBe(600);
    expect(viewOf(page).bounds.x).toBe(600 + PANE_DIVIDER_WIDTH);
    expect(states.savedWidth).toBeUndefined();
    request(5000, true);
    expect(states.savedWidth).toBe(1200 - CHAT_MIN_WIDTH);
    request(Number.NaN, true);
    request(-5, true);
    request(700, 'yes');
    expect(states.savedWidth).toBe(1200 - CHAT_MIN_WIDTH);
    expect(lines.filter((line) => line === '[pane] ignoring a malformed width request')).toHaveLength(3);
  });
});
