import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { NO_PAGES, type PanelStateStore, type PersistedChat, type PersistedPages } from '../panel-state-store';
import type { DesktopPanel } from '../views';

// Two URLs of one document: they differ in their hash at most.
function sameDocument(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0];
}

// The electron pieces PanelViews and its pages touch, for a vi.mock('electron') factory; webPreferences records each view's options.
export function fakeViewsElectron(webPreferences: unknown[] = []): Record<string, unknown> {
  let nextId = 1;
  class FakeIpc extends EventEmitter {
    readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void {
      this.handlers.set(channel, handler);
    }
    removeHandler(channel: string): void {
      this.handlers.delete(channel);
    }
  }
  class FakeWebContents extends EventEmitter {
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
    // a design view's (design-previews.ts): its sheets, isolated world, WebRTC policy, reload and frame capture
    private cssCount = 0;
    readonly insertCSS = vi.fn(async () => `css-${++this.cssCount}`);
    readonly removeInsertedCSS = vi.fn(async () => undefined);
    readonly executeJavaScriptInIsolatedWorld = vi.fn(async () => undefined);
    readonly setWebRTCIPHandlingPolicy = vi.fn();
    // an evicted surface captures as an empty image; mockResolvedValueOnce(EMPTY_CAPTURE) gives one
    readonly capturePage = vi.fn(async () => ({ isEmpty: () => false, getSize: () => ({ width: 640, height: 400 }), resize: () => { throw new Error('no resize below the cap'); }, toJPEG: () => Buffer.from('jpeg'), toPNG: () => Buffer.from('png') }));
    zoom = 1;
    getZoomFactor(): number {
      return this.zoom;
    }
    // A load commits, and its document is ready, at once; the test finishes it (did-finish-load) when it needs to.
    readonly loadURL = vi.fn(async (url: string) => {
      this.history.entries.splice(this.history.index + 1, Infinity, { url, title: '', status: 200 });
      this.history.index = this.history.entries.length - 1;
      this.mainFrame.url = url;
      this.emit('did-navigate', {}, url, 200);
      this.emit('dom-ready');
    });
    // a reload loads the current entry as a new document, in Electron's full order
    readonly reload = vi.fn(() => this.navigateTo(this.history.index, false));
    // Chromium's session history, as a design view's Back, Forward, rebuild and replay use it
    private readonly history = { entries: [] as Array<{ url: string; title: string; status: number }>, index: -1 };
    readonly navigationHistory = {
      canGoBack: (): boolean => this.history.index > 0,
      canGoForward: (): boolean => this.history.index < this.history.entries.length - 1,
      goBack: vi.fn(() => this.goToIndex(this.history.index - 1)),
      goForward: vi.fn(() => this.goToIndex(this.history.index + 1)),
      goToIndex: vi.fn((index: number) => this.goToIndex(index)),
      getActiveIndex: (): number => this.history.index,
      length: (): number => this.history.entries.length,
      getAllEntries: (): Array<{ url: string; title: string }> => this.history.entries.map(({ url, title }) => ({ url, title })),
      // Chromium refuses to remove the active entry
      removeEntryAtIndex: vi.fn((index: number): boolean => {
        if (index === this.history.index || index < 0 || index >= this.history.entries.length) return false;
        this.history.entries.splice(index, 1);
        if (index < this.history.index) this.history.index--;
        return true;
      }),
      restore: vi.fn(async ({ entries, index }: { entries: Array<{ url: string; title: string }>; index?: number }) => {
        this.history.entries = entries.map((entry) => ({ ...entry, status: 200 }));
        this.history.index = index ?? entries.length - 1;
        this.navigateTo(this.history.index, false);
      }),
    };
    private goToIndex(index: number): void {
      if (index < 0 || index >= this.history.entries.length) return;
      const from = this.history.entries[this.history.index]?.url;
      this.history.index = index;
      this.navigateTo(index, from !== undefined && sameDocument(from, this.history.entries[index]!.url));
    }
    // a page's link: a new entry after the current one, as a click on it adds; a link to a hash of this page stays in it
    followLink(url: string, status = 200): void {
      const from = this.history.entries[this.history.index]?.url;
      this.history.entries.splice(this.history.index + 1, Infinity, { url, title: '', status });
      this.history.index = this.history.entries.length - 1;
      this.navigateTo(this.history.index, from !== undefined && sameDocument(from, url));
    }
    // Electron's order, after the call that asked for it returns: did-start-navigation; then did-navigate-in-page alone, or
    // did-navigate, dom-ready and did-finish-load
    private navigateTo(index: number, inPage: boolean): void {
      queueMicrotask(() => this.commitEntry(index, inPage));
    }
    private commitEntry(index: number, inPage: boolean): void {
      const { url, status } = this.history.entries[index]!;
      this.emit('did-start-navigation', { url, isMainFrame: true, isSameDocument: inPage });
      this.mainFrame.url = url;
      if (inPage) {
        this.emit('did-navigate-in-page', {}, url, true);
        return;
      }
      this.emit('did-navigate', {}, url, status);
      this.emit('dom-ready');
      this.emit('did-finish-load');
    }
    getURL(): string {
      return this.mainFrame.url;
    }
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
    readonly setBorderRadius = vi.fn();
    readonly setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = bounds;
    });
    readonly setVisible = vi.fn((visible: boolean) => {
      this.visible = visible;
    });
    constructor(options: { webPreferences: unknown }) {
      webPreferences.push(options.webPreferences);
    }
    getVisible(): boolean {
      return this.visible;
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return this.bounds;
    }
  }
  // a PNG data URL decodes to an image of the size its test names through mockReturnValueOnce, else 100 × 100
  const nativeImage = {
    createFromDataURL: vi.fn((url: string) => ({
      isEmpty: () => !url.startsWith('data:image/png;base64,'),
      getSize: () => ({ width: 100, height: 100 }),
      resize: () => { throw new Error('no resize below the cap'); },
      toPNG: () => Buffer.from('png'),
    })),
  };
  return {
    WebContentsView,
    nativeImage,
    nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
    protocol: {},
  };
}

/** What capturePage answers for a view whose surface Chromium evicted. */
export const EMPTY_CAPTURE = { isEmpty: () => true, getSize: () => ({ width: 0, height: 0 }), toJPEG: () => Buffer.alloc(0), toPNG: () => Buffer.alloc(0) };

export type FakeContents = DesktopPanel['webContents'] & {
  ipc: EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> };
  focus: ReturnType<typeof vi.fn>;
  focused: boolean;
  zoom: number;
  loadURL: ReturnType<typeof vi.fn>;
  mainFrame: { url: string; parent: null };
  followLink(url: string, status?: number): void;
};

export type FakeView = {
  webContents: FakeContents;
  setBounds: ReturnType<typeof vi.fn>;
  setBorderRadius: ReturnType<typeof vi.fn>;
  setVisible: ReturnType<typeof vi.fn>;
  getVisible(): boolean;
  bounds: { x: number; y: number; width: number; height: number };
};

export function contentsOf(panel: DesktopPanel): FakeContents {
  return panel.webContents as FakeContents;
}

export function viewOf(panel: DesktopPanel): FakeView {
  return panel.view as unknown as FakeView;
}

export function fakeWindow(width = 1200) {
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
    webContents: Object.assign(new EventEmitter(), { focus: vi.fn() }),
    isDestroyed: () => false,
    isFocused: (): boolean => true,
    isMinimized: (): boolean => false,
    getContentBounds: () => ({ x: 0, y: 0, width, height: 800 }),
    setBackgroundColor: vi.fn(),
  });
}

// PanelStateStore's in-memory behaviour, without its file.
export function fakeStates(initial: readonly PersistedChat[] = []): PanelStateStore {
  const chats = new Map<string, PersistedChat>(initial.map((chat) => [chat.panelId, chat]));
  return {
    list: () => [...chats.values()],
    get: (id: string) => chats.get(id),
    selected: () => undefined,
    set: (chat: { panelId: string; state: unknown }) => {
      chats.set(chat.panelId, { panelId: chat.panelId, state: chat.state, browser: chats.get(chat.panelId)?.browser ?? NO_PAGES });
    },
    setPages: (id: string, browser: PersistedPages) => {
      const chat = chats.get(id);
      if (chat) chats.set(id, { ...chat, browser });
    },
    delete: (id: string) => {
      chats.delete(id);
    },
    select: () => undefined,
  } as unknown as PanelStateStore;
}
