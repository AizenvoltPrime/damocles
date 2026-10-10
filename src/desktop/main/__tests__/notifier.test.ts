import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ windows: [] as unknown[], workArea: { x: 0, y: 0, width: 1920, height: 1040 } }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeIpc extends Emitter {
    readonly handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    handle(channel: string, handler: (event: unknown, ...args: unknown[]) => unknown): void {
      this.handlers.set(channel, handler);
    }
  }
  class FakeWebContents extends Emitter {
    readonly id = 11;
    readonly ipc = new FakeIpc();
    readonly send = vi.fn();
    readonly loadURL = vi.fn(async () => undefined);
    hasFocus = false;
    readonly focus = vi.fn(() => {
      this.hasFocus = true;
    });
    isFocused(): boolean {
      return this.hasFocus;
    }
    closed = false;
    readonly close = vi.fn(() => {
      this.closed = true;
    });
    isDestroyed(): boolean {
      return this.closed;
    }
    isCrashed(): boolean {
      return false;
    }
  }
  class WebContentsView {
    private readonly contents = new FakeWebContents();
    // Electron throws on reading a destroyed view's webContents.
    destroyed = false;
    get webContents(): FakeWebContents {
      if (this.destroyed) throw new Error('Object has been destroyed');
      return this.contents;
    }
    readonly webPreferences: unknown;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    readonly setBackgroundColor = vi.fn();
    readonly setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = bounds;
    });
    constructor(options: { webPreferences: unknown }) {
      this.webPreferences = options.webPreferences;
    }
  }
  class BaseWindow extends Emitter {
    readonly views: WebContentsView[] = [];
    readonly contentView = { addChildView: (view: WebContentsView) => this.views.push(view) };
    get webContents(): FakeWebContents {
      return this.views[0]!.webContents;
    }
    readonly options: Record<string, unknown>;
    visible = false;
    destroyed = false;
    active = false;
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    readonly focus = vi.fn(() => {
      this.active = true;
    });
    readonly setAlwaysOnTop = vi.fn();
    readonly setVisibleOnAllWorkspaces = vi.fn();
    readonly setIgnoreMouseEvents = vi.fn();
    readonly setShape = vi.fn();
    readonly showInactive = vi.fn(() => {
      this.visible = true;
    });
    readonly hide = vi.fn(() => {
      this.visible = false;
    });
    readonly setBounds = vi.fn((bounds: { x: number; y: number; width: number; height: number }) => {
      this.bounds = bounds;
    });
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      H.windows.push(this);
    }
    isVisible(): boolean {
      return this.visible;
    }
    isFocused(): boolean {
      return this.active;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  const screen = Object.assign(new Emitter(), { getPrimaryDisplay: () => ({ workArea: H.workArea }) });
  return { BaseWindow, WebContentsView, screen, nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} };
});

import { MAX_TOAST_PARTS, OVERLAY_CHANNELS, type OverlayToast } from '../../preload/overlay-channels';
import { NotifierHost, parseToastArea, popupBounds, popupShape } from '../notifier';
import { NOTIFIER_PAGE_URL } from '../protocol';

type FakeWindow = EventEmitter & {
  options: Record<string, unknown>;
  views: Array<{ webPreferences: Record<string, unknown>; bounds: { x: number; y: number; width: number; height: number }; destroyed: boolean }>;
  visible: boolean;
  destroyed: boolean;
  active: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  focus: ReturnType<typeof vi.fn>;
  setAlwaysOnTop: ReturnType<typeof vi.fn>;
  setVisibleOnAllWorkspaces: ReturnType<typeof vi.fn>;
  setIgnoreMouseEvents: ReturnType<typeof vi.fn>;
  setShape: ReturnType<typeof vi.fn>;
  showInactive: ReturnType<typeof vi.fn>;
  hide: ReturnType<typeof vi.fn>;
  webContents: EventEmitter & {
    ipc: EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> };
    send: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    hasFocus: boolean;
    closed: boolean;
  };
};

const TOAST: OverlayToast = { id: 't1', at: 1, lifeMs: 12_000, remainingMs: 12_000, body: { kind: 'done', chat: { project: { key: 'p', name: 'acme' }, title: 'Chat' } } };

let resolved: Array<[string, string | undefined]>;
let holds: Array<[string, boolean]>;
let leaves: number;
let blurs: number;
let lines: string[];
let pending: OverlayToast[];
let host: NotifierHost;

const AREA = { width: 412, height: 200, parts: [] };

function win(): FakeWindow {
  return H.windows.at(-1) as FakeWindow;
}

function own(): { sender: unknown; senderFrame: { url: string; parent: null } } {
  return { sender: win().webContents, senderFrame: { url: NOTIFIER_PAGE_URL, parent: null } };
}

function notifier(platform: NodeJS.Platform): NotifierHost {
  return new NotifierHost({
    platform,
    preloadPath: 'preload-overlay.js',
    state: () => ({ locale: 'en', platform: 'win32' }),
    resolveToast: (id, action) => resolved.push([id, action]),
    holdToast: (id, held) => holds.push([id, held]),
    leave: () => {
      leaves++;
    },
    blurred: () => {
      blurs++;
    },
    pendingToasts: () => pending,
    log: (line) => lines.push(line),
  });
}

beforeEach(() => {
  H.windows.length = 0;
  resolved = [];
  holds = [];
  leaves = 0;
  blurs = 0;
  lines = [];
  pending = [];
  host = notifier('win32');
});

afterEach(() => {
  host.dispose();
});

describe('desktop popup window (D52)', () => {
  it('sits at the bottom-right of the work area, never larger than it', () => {
    expect(popupBounds({ width: 412, height: 180.4, parts: [] }, { x: 0, y: 0, width: 1920, height: 1040 })).toEqual({ x: 1508, y: 859, width: 412, height: 181 });
    expect(popupBounds({ width: 412, height: 2000, parts: [] }, { x: -1280, y: 40, width: 1280, height: 984 })).toEqual({ x: -412, y: 40, width: 412, height: 984 });
  });

  it('places the reported parts in the window by the area\'s bottom-right corner, in whole pixels', () => {
    const area = { width: 412, height: 230.5, parts: [{ x: 16, y: 16.25, width: 380, height: 90.5 }, { x: 160, y: 120, width: 92, height: 24 }] };
    expect(popupShape(area, { x: 1508, y: 809, width: 412, height: 231 })).toEqual([{ x: 16, y: 16, width: 380, height: 92 }, { x: 160, y: 120, width: 92, height: 25 }]);
    // A stack taller than the work area loses its top, as the page does.
    expect(popupShape(area, { x: 1508, y: 0, width: 412, height: 200 })).toEqual([{ x: 16, y: -15, width: 380, height: 92 }, { x: 160, y: 89, width: 92, height: 25 }]);
    expect(parseToastArea({ width: 412, height: 230.5, parts: area.parts, extra: 1 })).toEqual(area);
  });

  it.each([
    ['darwin', 'panel'],
    ['win32', 'toolbar'],
    // Electron aborts on X11 creating a window of any type.
    ['linux', undefined],
  ] as const)('on %s it is a %s window and never calls setVisibleOnAllWorkspaces, which hides the Dock icon on macOS', (platform, type) => {
    host = notifier(platform);
    host.sink();
    expect(win().options).toMatchObject({ show: false, frame: false, transparent: true, skipTaskbar: true, alwaysOnTop: true });
    expect(win().options['type']).toBe(type);
    expect(Object.hasOwn(win().options, 'type')).toBe(type !== undefined);
    expect(win().setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });

  it.each(['win32', 'darwin'] as const)('on %s it lets the pointer through except over a toast or the pill, forwarding its moves to the page while shown', (platform) => {
    host = notifier(platform);
    host.sink();
    win().webContents.emit('did-finish-load');
    const pointer = (over: unknown, event = own()): void => {
      win().webContents.ipc.emit(OVERLAY_CHANNELS.toastsPointer, event, over);
    };
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), AREA);
    expect(win().setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    // Click-through before it first shows, so no click lands on its margin.
    expect(win().setIgnoreMouseEvents.mock.invocationCallOrder.at(-1)!).toBeLessThan(win().showInactive.mock.invocationCallOrder[0]!);
    pointer(true);
    expect(win().setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), { ...AREA, height: 300 });
    expect(win().setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    pointer(false);
    expect(win().setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });

    const calls = win().setIgnoreMouseEvents.mock.calls.length;
    pointer('yes');
    pointer(true, { sender: win().webContents, senderFrame: { url: 'app://damocles/overlay/index.html', parent: null } } as never);
    expect(win().setIgnoreMouseEvents.mock.calls.length).toBe(calls);
    expect(lines).toContain('[notifier] ignoring a malformed toast pointer report');

    // Hidden, it stops forwarding, which on Windows hooks every mouse move.
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), { width: 0, height: 0, parts: [] });
    expect(win().setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
    expect(win().setShape).not.toHaveBeenCalled();
  });

  it('on Linux its shape is the reported toasts and pill, as it has no pointer forwarding', () => {
    host = notifier('linux');
    host.sink();
    win().webContents.emit('did-finish-load');
    const parts = [{ x: 16, y: 16, width: 380, height: 90 }, { x: 16, y: 116, width: 380, height: 68 }];
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), { ...AREA, parts });
    expect(win().setShape).toHaveBeenLastCalledWith(parts);
    expect(win().setShape.mock.invocationCallOrder[0]!).toBeLessThan(win().showInactive.mock.invocationCallOrder[0]!);
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastsPointer, own(), true);
    expect(win().setIgnoreMouseEvents).not.toHaveBeenCalled();
  });

  it('lets a late crash of a window it already replaced leave the current page alone', () => {
    host.sink();
    const first = win();
    host.dispose();
    host.sink();
    const second = win();
    second.webContents.emit('did-finish-load');
    second.webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), AREA);
    first.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    expect(host.sink()).toBe(host);
    expect(second.visible).toBe(true);
    expect(second.hide).not.toHaveBeenCalled();
    expect(lines.some((line) => line.startsWith('[notifier] renderer gone'))).toBe(false);
  });

  it('drops the sound of a popup raised while no popup window is open, so it never plays when the window opens later', () => {
    host.chime('attention');
    host.sink();
    win().webContents.emit('did-finish-load');
    expect(win().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.chime)).toEqual([]);
  });

  it('opens a hidden, frameless, always-on-top window on first use and is a sink only once its page loaded', () => {
    expect(host.sink()).toBeUndefined();
    expect(H.windows).toHaveLength(1);
    expect(win().options).toMatchObject({ show: false, frame: false, transparent: true, skipTaskbar: true, alwaysOnTop: true });
    expect(win().views[0]!.webPreferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true, focusOnNavigation: false });
    expect(win().setAlwaysOnTop).toHaveBeenCalledWith(true, 'screen-saver');
    expect(win().webContents.loadURL).toHaveBeenCalledWith(NOTIFIER_PAGE_URL);
    pending = [TOAST];
    win().webContents.emit('did-finish-load');
    expect(win().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.toast, TOAST);
    expect(host.sink()).toBe(host);
    expect(H.windows).toHaveLength(1);
  });

  it('shows without taking focus at the size of the reported stack, and hides when it empties', () => {
    host.sink();
    win().webContents.emit('did-finish-load');
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), AREA);
    expect(win().bounds).toEqual({ x: 1508, y: 840, width: 412, height: 200 });
    expect(win().views[0]!.bounds).toEqual({ x: 0, y: 0, width: 412, height: 200 });
    expect(win().showInactive).toHaveBeenCalledTimes(1);
    expect(win().focus).not.toHaveBeenCalled();
    expect(win().webContents.focus).not.toHaveBeenCalled();
    expect(host.focused).toBe(false);
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), { width: 0, height: 0, parts: [] });
    expect(win().hide).toHaveBeenCalledTimes(1);
    expect(win().visible).toBe(false);
  });

  it('ignores a malformed toast area', () => {
    host.sink();
    win().webContents.emit('did-finish-load');
    const part = { x: 16, y: 16, width: 380, height: 90 };
    const areas = [
      null,
      { width: -1, height: 10, parts: [] },
      { width: Number.NaN, height: 10, parts: [] },
      { width: 1e9, height: 10, parts: [] },
      { width: '10', height: 10, parts: [] },
      { width: 412, height: 200 },
      { width: 412, height: 200, parts: [{ ...part, width: -1 }] },
      { width: 412, height: 200, parts: [{ x: 16, y: 16, width: 380 }] },
      { width: 412, height: 200, parts: Array.from({ length: MAX_TOAST_PARTS + 1 }, () => part) },
    ];
    for (const area of areas) win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), area);
    expect(win().showInactive).not.toHaveBeenCalled();
    expect(lines.filter((line) => line === '[notifier] ignoring a malformed toast area')).toHaveLength(areas.length);
  });

  it('is an F6 stop only while a popup shows: focusing it takes window and page focus and asks for the newest card, and Escape hands focus back', () => {
    host.focusToasts();
    expect(H.windows).toHaveLength(0);
    host.sink();
    win().webContents.emit('did-finish-load');
    host.focusToasts();
    expect(win().focus).not.toHaveBeenCalled();
    expect(host.showing).toBe(false);

    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), AREA);
    expect(host.showing).toBe(true);
    host.focusToasts();
    expect(win().focus).toHaveBeenCalledTimes(1);
    expect(win().webContents.focus).toHaveBeenCalledTimes(1);
    expect(win().webContents.send).toHaveBeenLastCalledWith(OVERLAY_CHANNELS.toastsFocus, undefined);
    expect(host.focused).toBe(true);
    expect(host.owns(win().webContents as never)).toBe(true);
    expect(host.owns({} as never)).toBe(false);

    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastsLeave, { sender: win().webContents, senderFrame: { url: 'app://damocles/overlay/index.html', parent: null } });
    expect(leaves).toBe(0);
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastsLeave, own());
    expect(leaves).toBe(1);
    // A popup whose window is not the active one does not hold focus, whatever its page last had, and says it lost focus.
    win().active = false;
    win().emit('blur');
    expect(host.focused).toBe(false);
    expect(blurs).toBe(1);
  });

  it('takes answers and holds only from its own page, bounded', async () => {
    host.sink();
    const contents = win().webContents;
    contents.ipc.emit(OVERLAY_CHANNELS.resolveToast, own(), 't1', 'open');
    contents.ipc.emit(OVERLAY_CHANNELS.resolveToast, own(), 't1', undefined);
    contents.ipc.emit(OVERLAY_CHANNELS.resolveToast, own(), 't1', 'x'.repeat(501));
    contents.ipc.emit(OVERLAY_CHANNELS.resolveToast, own(), '', 'open');
    contents.ipc.emit(OVERLAY_CHANNELS.resolveToast, { sender: contents, senderFrame: { url: 'app://damocles/overlay/index.html', parent: null } }, 't1', 'open');
    contents.ipc.emit(OVERLAY_CHANNELS.toastHold, own(), 't1', true);
    contents.ipc.emit(OVERLAY_CHANNELS.toastHold, own(), 't1', 'yes');
    expect(resolved).toEqual([['t1', 'open'], ['t1', undefined]]);
    expect(holds).toEqual([['t1', true]]);
    expect(lines.some((line) => line.startsWith('[notifier] rejected'))).toBe(true);
    await expect(Promise.resolve(contents.ipc.handlers.get(OVERLAY_CHANNELS.getState)!(own()))).resolves.toEqual({ locale: 'en', platform: 'win32' });
    expect(() => contents.ipc.handlers.get(OVERLAY_CHANNELS.getState)!({ sender: {}, senderFrame: { url: NOTIFIER_PAGE_URL, parent: null } })).toThrow('Rejected');
  });

  it('plays the sound of the popup that opened it once its page loads, and later ones at once, with no click needed', () => {
    host.sink();
    expect(win().views[0]!.webPreferences).toMatchObject({ autoplayPolicy: 'no-user-gesture-required' });
    host.chime('attention');
    expect(win().webContents.send).not.toHaveBeenCalled();
    win().webContents.emit('did-finish-load');
    expect(win().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.chime, 'attention');
    host.chime('done');
    expect(win().webContents.send).toHaveBeenLastCalledWith(OVERLAY_CHANNELS.chime, 'done');
    expect(win().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.chime)).toHaveLength(2);
  });

  // A reload by any route commits a new document that shows nothing until main replays the toasts to it.
  it('hides and stops taking popups when its page reloads, then replays the toasts and the held sound once it has loaded', () => {
    host.sink();
    win().webContents.emit('did-finish-load');
    win().webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), AREA);
    expect(win().visible).toBe(true);
    win().webContents.emit('did-navigate', {}, NOTIFIER_PAGE_URL, 200, 'OK');
    expect(win().visible).toBe(false);
    expect(host.sink()).toBeUndefined();
    win().webContents.send.mockClear();
    host.chime('attention');
    expect(win().webContents.send).not.toHaveBeenCalled();
    pending = [TOAST];
    win().webContents.emit('did-finish-load');
    expect(win().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.toast, TOAST);
    expect(win().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.chime, 'attention');
    expect(host.sink()).toBe(host);
  });

  it('plays the most urgent tone of the popups that arrived before its page loaded', () => {
    host.sink();
    host.chime('warning');
    host.chime('attention');
    host.chime('done');
    win().webContents.emit('did-finish-load');
    expect(win().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.chime)).toEqual([[OVERLAY_CHANNELS.chime, 'attention']]);
  });

  it('forgets a window the OS closed, as quitting does, and opens a new one for the next popup', () => {
    host.sink();
    const first = win();
    const contents = first.webContents;
    first.webContents.emit('did-finish-load');
    first.webContents.ipc.emit(OVERLAY_CHANNELS.toastArea, own(), AREA);
    first.destroyed = true;
    first.views[0]!.destroyed = true;
    first.emit('closed');
    expect(contents.closed).toBe(true);
    expect(host.focused).toBe(false);
    expect(host.showing).toBe(false);
    host.focusToasts();
    expect(host.sink()).toBeUndefined();
    expect(H.windows).toHaveLength(2);
  });

  it('answers the state to the page of a window quitting closed while it loads, and drops that page\'s late reports', async () => {
    host.sink();
    const contents = win().webContents;
    const closing = own();
    win().emit('closed');
    await expect(Promise.resolve(contents.ipc.handlers.get(OVERLAY_CHANNELS.getState)!(closing))).resolves.toEqual({ locale: 'en', platform: 'win32' });
    contents.ipc.emit(OVERLAY_CHANNELS.toastHold, closing, 't1', true);
    contents.ipc.emit(OVERLAY_CHANNELS.toastArea, closing, AREA);
    expect(holds).toEqual([]);
    expect(lines.filter((line) => line.startsWith('[notifier] rejected'))).toEqual([]);
  });

  it('closes its window on dispose, and opens a new one for the next popup', () => {
    host.sink();
    const first = win();
    host.dispose();
    expect(first.destroyed).toBe(true);
    expect(first.webContents.closed).toBe(true);
    host.sink();
    expect(H.windows).toHaveLength(2);
  });
});
