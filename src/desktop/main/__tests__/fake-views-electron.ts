import { EventEmitter } from 'node:events';
import { vi } from 'vitest';
import { NO_PAGES, type PanelStateStore, type PersistedChat, type PersistedPages } from '../panel-state-store';
import type { DesktopPanel } from '../views';

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
    // A load commits, and its document is ready, at once.
    readonly loadURL = vi.fn(async (url: string) => {
      this.mainFrame.url = url;
      this.emit('did-navigate');
      this.emit('dom-ready');
    });
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
  return {
    WebContentsView,
    nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() },
    protocol: {},
  };
}

export type FakeContents = DesktopPanel['webContents'] & {
  ipc: EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> };
  focus: ReturnType<typeof vi.fn>;
  focused: boolean;
  loadURL: ReturnType<typeof vi.fn>;
  mainFrame: { url: string; parent: null };
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
