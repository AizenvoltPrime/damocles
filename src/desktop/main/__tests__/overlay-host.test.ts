import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ webPreferences: [] as unknown[] }));

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
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
    readonly id = 7;
    readonly ipc = new FakeIpc();
    readonly mainFrame = { url: '', parent: null };
    hasFocus = false;
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
      return false;
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
      H.webPreferences.push(options.webPreferences);
    }
  }
  return { WebContentsView, nativeTheme: { shouldUseDarkColors: true, on: vi.fn(), off: vi.fn() }, protocol: {} };
});

import { OVERLAY_ACK_TIMEOUT_MS, OVERLAY_CHANNELS, type OverlayRequest } from '../../preload/overlay-channels';
import { OverlayHost, overlayHtml, parseOverlayAnswer, parseOverlayRequest } from '../overlay';
import { OVERLAY_PAGE_URL, resolveAppRequest } from '../protocol';

type FakeView = {
  visible: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  webContents: EventEmitter & {
    ipc: EventEmitter & { handlers: Map<string, (event: unknown, ...args: unknown[]) => unknown> };
    hasFocus: boolean;
    focus: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
    setZoomFactor: ReturnType<typeof vi.fn>;
    mainFrame: { url: string; parent: null };
  };
};

const MENU: OverlayRequest = {
  kind: 'menu',
  label: 'Actions for Fix login',
  anchor: { x: 10, y: 20, width: 100, height: 24 },
  items: [
    { kind: 'item', id: 'open', label: 'Open', icon: 'message-square' },
    { kind: 'separator' },
    { kind: 'item', id: 'delete', label: 'Delete session', icon: 'trash-2', danger: true },
    { kind: 'item', id: 'off', label: 'Remove tag', disabled: true },
  ],
};

function fakeWindow() {
  const children: unknown[] = [];
  const window = Object.assign(new EventEmitter(), {
    children,
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
    getContentBounds: () => window.contentBounds,
  });
  return window;
}

let window: ReturnType<typeof fakeWindow>;
let lines: string[];
let resolved: Array<[string, string | undefined]>;
let focusedOutside: number;
let host: OverlayHost;

function view(): FakeView {
  return host.view as unknown as FakeView;
}

function own(): { sender: unknown; senderFrame: { url: string; parent: null } } {
  return { sender: view().webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } };
}

function emit(channel: string, event: unknown, ...args: unknown[]): void {
  view().webContents.ipc.emit(channel, event, ...args);
}

function loaded(): void {
  host.load();
  view().webContents.emit('did-finish-load');
}

function lastRequestId(): string {
  const sent = view().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.request);
  return (sent.at(-1)?.[1] as { requestId: string }).requestId;
}

const returnFocus = { focus: vi.fn(), isDestroyed: () => false };

beforeEach(() => {
  vi.useFakeTimers();
  window = fakeWindow();
  lines = [];
  resolved = [];
  focusedOutside = 0;
  returnFocus.focus.mockClear();
  H.webPreferences.length = 0;
  host = new OverlayHost({
    window: window as never,
    preloadPath: 'preload-overlay.js',
    state: () => ({ locale: 'en', platform: 'win32' }),
    resolveToast: (id, action) => resolved.push([id, action]),
    pendingToasts: () => [],
    focusOutside: () => {
      focusedOutside++;
    },
    log: (line) => lines.push(line),
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('overlay page', () => {
  it('is served in memory at its exact URL under a nonce CSP with no worker or remote source', () => {
    expect(OVERLAY_PAGE_URL).toBe('app://damocles/overlay/index.html');
    expect(resolveAppRequest(OVERLAY_PAGE_URL, process.cwd())).toEqual({ kind: 'overlay' });
    expect(resolveAppRequest('app://damocles/overlay/other.html', process.cwd())).toBeUndefined();
    const html = overlayHtml({ kind: 'dark', css: ':root{}', reducedMotion: false });
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
    expect(csp).toBe(`default-src 'none'; style-src app://damocles 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src app://damocles; img-src app://damocles data:; base-uri 'none'; form-action 'none';`);
    expect(html).toContain(`<script nonce="${nonce}" type="module" src="app://damocles/desktop-shell/assets/overlay.js"></script>`);
    expect(html).toContain('<link href="app://damocles/desktop-shell/assets/overlay.css" rel="stylesheet">');
  });

  it('runs sandboxed and isolated and never takes focus by loading', () => {
    expect(H.webPreferences[0]).toMatchObject({ preload: 'preload-overlay.js', contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, focusOnNavigation: false });
  });
});

describe('overlay sender check', () => {
  it('accepts IPC only from its own view main frame on the exact overlay URL, on its own webContents.ipc', async () => {
    loaded();
    emit(OVERLAY_CHANNELS.toastArea, { sender: { id: 9 }, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, { width: 300, height: 80 });
    emit(OVERLAY_CHANNELS.toastArea, { sender: view().webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: {} } }, { width: 300, height: 80 });
    emit(OVERLAY_CHANNELS.toastArea, { sender: view().webContents, senderFrame: { url: 'app://damocles/shell/index.html', parent: null } }, { width: 300, height: 80 });
    expect(host.mode).toBe('hidden');
    expect(lines.filter((line) => line.startsWith('[overlay] rejected'))).toHaveLength(3);
    const getState = view().webContents.ipc.handlers.get(OVERLAY_CHANNELS.getState)!;
    await expect(getState({ sender: { id: 9 }, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } })).rejects.toThrow('Rejected');
    await expect(getState(own())).resolves.toEqual({ locale: 'en', platform: 'win32' });
  });

  it('passes a toast answer on only when it is well formed', () => {
    loaded();
    emit(OVERLAY_CHANNELS.resolveToast, own(), 't1', 'Reload');
    emit(OVERLAY_CHANNELS.resolveToast, own(), 't2', undefined);
    emit(OVERLAY_CHANNELS.resolveToast, own(), 42, 'Reload');
    emit(OVERLAY_CHANNELS.resolveToast, own(), 't3', { action: 'x' });
    expect(resolved).toEqual([['t1', 'Reload'], ['t2', undefined]]);
  });
});

describe('overlay bounds modes', () => {
  it('is hidden, then covers the bottom-right toast area at the shell zoom, then the whole content area for a popup', async () => {
    loaded();
    expect(host.mode).toBe('hidden');
    expect(view().visible).toBe(false);

    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    expect(host.mode).toBe('toasts');
    expect(view().bounds).toEqual({ x: 1200 - 400, y: 800 - 125, width: 400, height: 125 });
    expect(view().webContents.setZoomFactor).toHaveBeenCalledWith(1.25);

    const answer = host.request(MENU, returnFocus as never);
    expect(host.mode).toBe('full');
    expect(view().bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await expect(answer).resolves.toEqual({ kind: 'dismissed' });
    expect(host.mode).toBe('toasts');

    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 0, height: 0 });
    expect(host.mode).toBe('hidden');
  });

  it('ignores a malformed toast area', () => {
    loaded();
    for (const area of [null, { width: -1, height: 10 }, { width: Number.NaN, height: 10 }, { width: 1e9, height: 10 }, { width: '10', height: 10 }]) {
      emit(OVERLAY_CHANNELS.toastArea, own(), area);
    }
    expect(host.mode).toBe('hidden');
    expect(lines.filter((line) => line === '[overlay] ignoring a malformed toast area')).toHaveLength(5);
  });

  it('follows the content area on resize, in toasts mode and in full mode', async () => {
    loaded();
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    window.contentBounds = { x: 0, y: 0, width: 1000, height: 700 };
    window.emit('resize');
    expect(view().bounds).toEqual({ x: 1000 - 400, y: 700 - 125, width: 400, height: 125 });

    const answer = host.request(MENU, returnFocus as never);
    window.contentBounds = { x: 0, y: 0, width: 900, height: 600 };
    window.emit('resize');
    expect(view().bounds).toEqual({ x: 0, y: 0, width: 900, height: 600 });
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await answer;
  });

  it('restacks itself above every view when it shows, and on request', () => {
    loaded();
    const other = {};
    window.contentView.addChildView(other);
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    expect(window.children.at(-1)).toBe(host.view);
    window.contentView.addChildView(other);
    host.restack();
    expect(window.children.at(-1)).toBe(host.view);
  });
});

describe('overlay requests', () => {
  it('focuses the overlay for a popup and returns focus to the page that had it once answered', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    expect(view().webContents.focus).toHaveBeenCalled();
    expect(returnFocus.focus).not.toHaveBeenCalled();
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'menu', itemId: 'delete' });
    await expect(answer).resolves.toEqual({ kind: 'menu', itemId: 'delete' });
    expect(returnFocus.focus).toHaveBeenCalledTimes(1);
  });

  it('hides and rejects a request the overlay does not acknowledge within the timeout', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    const settled = expect(answer).rejects.toThrow('did not respond');
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS);
    await settled;
    expect(host.mode).toBe('hidden');
    expect(returnFocus.focus).toHaveBeenCalled();
    expect(view().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.cancel, expect.any(String));
  });

  it('never times out a popup the overlay acknowledged, however long the user reads it', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS * 100);
    expect(host.mode).toBe('full');
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'menu', itemId: 'open' });
    await expect(answer).resolves.toEqual({ kind: 'menu', itemId: 'open' });
  });

  it('dismisses a request whose answer is malformed, so an invisible overlay never covers the window', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'menu', itemId: 'off' });
    await expect(answer).resolves.toEqual({ kind: 'dismissed' });
    expect(host.mode).toBe('hidden');
    expect(returnFocus.focus).toHaveBeenCalled();
  });

  it('ignores an answer to a request that is not open', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    emit(OVERLAY_CHANNELS.answer, own(), 'forged-id', { kind: 'menu', itemId: 'open' });
    expect(host.mode).toBe('full');
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await expect(answer).resolves.toEqual({ kind: 'dismissed' });
  });

  it('dismisses the open popup when a second request arrives, and returns focus once the last closes', async () => {
    loaded();
    const first = host.request(MENU, returnFocus as never);
    const firstId = lastRequestId();
    const second = host.request({ kind: 'confirm', title: 'Delete Session', message: 'Sure?', confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true }, undefined);
    await expect(first).resolves.toEqual({ kind: 'dismissed' });
    expect(view().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.cancel, firstId);
    expect(returnFocus.focus).not.toHaveBeenCalled();
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'confirm', confirmed: true });
    await expect(second).resolves.toEqual({ kind: 'confirm', confirmed: true });
    expect(returnFocus.focus).toHaveBeenCalledTimes(1);
  });

  it('hides and rejects the open request when the overlay crashes, then reloads it', async () => {
    loaded();
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    const answer = host.request(MENU, returnFocus as never);
    view().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await expect(answer).rejects.toThrow('stopped');
    expect(host.mode).toBe('hidden');
    expect(host.toastSink).toBeUndefined();
    expect(view().webContents.loadURL).toHaveBeenCalledTimes(2);
    expect(view().webContents.loadURL).toHaveBeenLastCalledWith(OVERLAY_PAGE_URL);
  });

  it('refuses a request while the page is not loaded', async () => {
    await expect(host.request(MENU, undefined)).rejects.toThrow('not available');
    expect(host.mode).toBe('hidden');
  });

  it('tells a caller when the page has loaded, at once once it has', async () => {
    let ready = false;
    const waiting = host.whenLoaded().then(() => {
      ready = true;
    });
    host.load();
    await Promise.resolve();
    expect(ready).toBe(false);
    view().webContents.emit('did-finish-load');
    await waiting;
    await expect(host.whenLoaded()).resolves.toBeUndefined();
    void host.request(MENU, undefined);
    expect(host.mode).toBe('full');
  });
});

describe('overlay focus', () => {
  it('moves keyboard focus out when the last toast goes while the overlay holds it, and only then', () => {
    loaded();
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 0, height: 0 });
    expect(focusedOutside).toBe(0);

    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    // A click on a toast focuses the overlay view.
    view().webContents.hasFocus = true;
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 60 });
    expect(focusedOutside).toBe(0);
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 0, height: 0 });
    expect(host.mode).toBe('hidden');
    expect(focusedOutside).toBe(1);
  });

  it('never returns focus to the overlay itself when a popup opened from it closes', async () => {
    loaded();
    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    host.focusToasts();
    const answer = host.request(MENU, view().webContents as never);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await answer;
    expect(host.mode).toBe('toasts');
    expect(focusedOutside).toBe(1);
  });

  it('is an F6 stop only while toasts show, and Escape there moves focus back out', () => {
    loaded();
    host.focusToasts();
    expect(view().webContents.focus).not.toHaveBeenCalled();

    emit(OVERLAY_CHANNELS.toastArea, own(), { width: 320, height: 100 });
    host.focusToasts();
    expect(host.focused).toBe(true);
    expect(view().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.toastsFocus, undefined);
    emit(OVERLAY_CHANNELS.toastsLeave, { sender: { id: 9 }, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } });
    expect(focusedOutside).toBe(0);
    emit(OVERLAY_CHANNELS.toastsLeave, own());
    expect(focusedOutside).toBe(1);
    expect(host.mode).toBe('toasts');
  });
});

describe('overlay dispose', () => {
  it('stops following the window and its IPC, rejects the open request and closes the page', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    const settled = expect(answer).rejects.toThrow('window closed');
    const channels = [...view().webContents.ipc.eventNames()];
    expect(channels).toContain(OVERLAY_CHANNELS.answer);
    host.dispose();
    await settled;

    expect(window.listenerCount('resize')).toBe(0);
    expect(view().webContents.ipc.handlers.size).toBe(0);
    for (const channel of channels) expect(view().webContents.ipc.listenerCount(channel)).toBe(0);
    expect(view().webContents.close).toHaveBeenCalledTimes(1);
    host.dispose();
    expect(view().webContents.close).toHaveBeenCalledTimes(1);
  });
});

describe('overlay request validation', () => {
  it('rebuilds a valid request without unknown fields', () => {
    const parsed = parseOverlayRequest({ ...MENU, extra: 'x', items: [{ kind: 'item', id: 'a', label: 'A', onclick: 'x' }] });
    expect(parsed).toEqual({ kind: 'menu', label: 'Actions for Fix login', anchor: MENU.anchor, items: [{ kind: 'item', id: 'a', label: 'A' }] });
    const confirm = { kind: 'confirm', title: 'T', message: 'm', confirmLabel: 'OK', cancelLabel: 'No', danger: true };
    expect(parseOverlayRequest({ ...confirm, warning: { text: 'Still running', running: true, extra: 1 } })).toEqual({ ...confirm, warning: { text: 'Still running', running: true } });
  });

  it.each([
    ['an unknown kind', { kind: 'html', html: '<b>' }],
    ['a menu with no accessible name', { ...MENU, label: '' }],
    ['an icon outside the allowlist', { ...MENU, items: [{ kind: 'item', id: 'a', label: 'A', icon: 'skull' }] }],
    ['too many items', { ...MENU, items: Array.from({ length: 101 }, (_, i) => ({ kind: 'item', id: `i${i}`, label: 'x' })) }],
    ['no items', { ...MENU, items: [] }],
    ['a duplicate item id', { ...MENU, items: [{ kind: 'item', id: 'a', label: 'A' }, { kind: 'item', id: 'a', label: 'B' }] }],
    ['a long label', { ...MENU, items: [{ kind: 'item', id: 'a', label: 'x'.repeat(201) }] }],
    ['a non-finite anchor', { ...MENU, anchor: { x: Number.NaN, y: 0, width: 1, height: 1 } }],
    ['a negative anchor', { ...MENU, anchor: { x: -1, y: 0, width: 1, height: 1 } }],
    ['dialog text over the bound', { kind: 'confirm', title: 'T', message: 'x'.repeat(2001), confirmLabel: 'OK', cancelLabel: 'No', danger: false }],
    ['a dialog with no danger flag', { kind: 'confirm', title: 'T', message: 'm', confirmLabel: 'OK', cancelLabel: 'No' }],
    ['a warning without its running flag', { kind: 'confirm', title: 'T', message: 'm', warning: { text: 'w' }, confirmLabel: 'OK', cancelLabel: 'No', danger: true }],
    ['too many tags', { kind: 'tagPicker', anchor: MENU.anchor, tags: Array.from({ length: 501 }, (_, i) => `t${i}`), placeholder: '' }],
    ['a long tag', { kind: 'tagPicker', anchor: MENU.anchor, tags: ['x'.repeat(51)], placeholder: '' }],
  ])('rejects %s', (_name, raw) => {
    expect(parseOverlayRequest(raw)).toBeUndefined();
  });

  it('accepts an answer only of the request kind, with an enabled menu item or a bounded tag', () => {
    expect(parseOverlayAnswer({ kind: 'menu', itemId: 'open' }, MENU)).toEqual({ kind: 'menu', itemId: 'open' });
    expect(parseOverlayAnswer({ kind: 'menu', itemId: 'off' }, MENU)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'menu', itemId: 'nope' }, MENU)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'confirm', confirmed: true }, MENU)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'dismissed' }, MENU)).toEqual({ kind: 'dismissed' });
    const picker = parseOverlayRequest({ kind: 'tagPicker', anchor: MENU.anchor, tags: ['bug'], placeholder: 'Enter tag...' })!;
    expect(parseOverlayAnswer({ kind: 'tagPicker', tag: '  feature ' }, picker)).toEqual({ kind: 'tagPicker', tag: 'feature' });
    expect(parseOverlayAnswer({ kind: 'tagPicker', tag: null }, picker)).toEqual({ kind: 'tagPicker', tag: null });
    expect(parseOverlayAnswer({ kind: 'tagPicker', tag: '   ' }, picker)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'tagPicker', tag: 'x'.repeat(51) }, picker)).toBeUndefined();
  });
});
