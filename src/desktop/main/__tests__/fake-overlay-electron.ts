import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

// The electron pieces OverlayHost touches, for a vi.mock('electron') factory; webPreferences records each view's options.
export function fakeOverlayElectron(webPreferences: unknown[] = []): Record<string, unknown> {
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
    readonly id = 7;
    readonly ipc = new FakeIpc();
    readonly mainFrame = { url: '', parent: null };
    hasFocus = false;
    crashed = false;
    readonly focus = vi.fn(() => {
      this.hasFocus = true;
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
      return this.crashed;
    }
    isFocused(): boolean {
      return this.hasFocus;
    }
  }
  class WebContentsView {
    readonly webContents = new FakeWebContents();
    visible = true;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = bounds;
    });
    readonly setVisible = vi.fn((visible: boolean) => {
      this.visible = visible;
    });
    constructor(options: { webPreferences: unknown }) {
      webPreferences.push(options.webPreferences);
    }
  }
  return { WebContentsView, nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} };
}

export function fakeOverlayWindow() {
  const children: unknown[] = [];
  const window = Object.assign(new EventEmitter(), {
    children,
    focused: true,
    contentBounds: { x: 0, y: 0, width: 1200, height: 800 },
    contentView: {
      addChildView: vi.fn((view: unknown) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
        children.push(view);
      }),
    },
    webContents: { getZoomFactor: () => 1.25 },
    isDestroyed: () => false,
    isFocused: () => window.focused,
    getContentBounds: () => window.contentBounds,
  });
  return window;
}

export type FakeOverlayView = {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  webContents: EventEmitter & {
    ipc: EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> };
    hasFocus: boolean;
    crashed: boolean;
    focus: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    setZoomFactor: ReturnType<typeof vi.fn>;
    mainFrame: { url: string; parent: null };
  };
};
