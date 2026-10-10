import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ webPreferences: [] as unknown[] }));

vi.mock('electron', async () => (await import('./fake-overlay-electron')).fakeOverlayElectron(H.webPreferences));

import { MAX_MESSAGE_ACTIONS, OVERLAY_ACK_TIMEOUT_MS, OVERLAY_CHANNELS, type OverlayRasterRequest, type OverlayRequest, type RasterArt } from '../../preload/overlay-channels';
import { OverlayHost, overlayHtml, parseMessageRequest, parseOverlayAnswer, parseOverlayRequest, RASTER_TIMEOUT_MS } from '../overlay';
import { OVERLAY_PAGE_URL, resolveAppRequest } from '../protocol';
import { fakeOverlayWindow, type FakeOverlayView } from './fake-overlay-electron';
import { pngFixture } from './png-fixture';

type FakeView = FakeOverlayView;

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

const fakeWindow = fakeOverlayWindow;

let window: ReturnType<typeof fakeWindow>;
let lines: string[];
let focusedOutside: number;
let activations: number;
let closings: number;
let redraws: number;
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

// Blocks main's event loop for `ms`: the fake clock jumps and each timer that came due fires once, as Node runs them
// after a block, before the IPC that arrived meanwhile.
function stallMain(ms: number): void {
  (setTimeout as unknown as { clock: { jump: (by: number) => void } }).clock.jump(ms);
}

const returnFocus = { focus: vi.fn(), isDestroyed: () => false };

beforeEach(() => {
  vi.useFakeTimers();
  window = fakeWindow();
  lines = [];
  focusedOutside = 0;
  activations = 0;
  closings = 0;
  redraws = 0;
  returnFocus.focus.mockClear();
  H.webPreferences.length = 0;
  host = new OverlayHost({
    window: window as never,
    preloadPath: 'preload-overlay.js',
    state: () => ({ locale: 'en', platform: 'win32' }),
    focusOutside: () => {
      focusedOutside++;
    },
    awaitActivation: () => {
      activations++;
    },
    popupsClosed: () => {
      closings++;
    },
    canRasterize: () => {
      redraws++;
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
    void host.request(MENU, undefined);
    const requestId = lastRequestId();
    emit(OVERLAY_CHANNELS.answer, { sender: { id: 9 }, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, requestId, { kind: 'dismissed' });
    emit(OVERLAY_CHANNELS.answer, { sender: view().webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: {} } }, requestId, { kind: 'dismissed' });
    emit(OVERLAY_CHANNELS.answer, { sender: view().webContents, senderFrame: { url: 'app://damocles/shell/index.html', parent: null } }, requestId, { kind: 'dismissed' });
    expect(host.isOpen('menu')).toBe(true);
    expect(lines.filter((line) => line.startsWith('[overlay] rejected'))).toHaveLength(3);
    const getState = view().webContents.ipc.handlers.get(OVERLAY_CHANNELS.getState)!;
    await expect(getState({ sender: { id: 9 }, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } })).rejects.toThrow('Rejected');
    await expect(getState(own())).resolves.toEqual({ locale: 'en', platform: 'win32' });
  });

  it('never receives a toast: it sends none to its page and answers none of the toast channels', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await answer;
    const toastChannels: string[] = [OVERLAY_CHANNELS.toast, OVERLAY_CHANNELS.toastDismiss, OVERLAY_CHANNELS.toastsFocus, OVERLAY_CHANNELS.chime];
    expect(view().webContents.send.mock.calls.filter(([channel]) => toastChannels.includes(channel as string))).toEqual([]);
    for (const channel of [OVERLAY_CHANNELS.resolveToast, OVERLAY_CHANNELS.toastHold, OVERLAY_CHANNELS.toastArea, OVERLAY_CHANNELS.toastsLeave]) {
      expect(view().webContents.ipc.listenerCount(channel)).toBe(0);
    }
    expect('show' in host).toBe(false);
  });
});

describe('overlay bounds modes', () => {
  it('is hidden, then covers the whole content area at the shell zoom for a popup, then hides again', async () => {
    loaded();
    expect(host.mode).toBe('hidden');
    expect(view().visible).toBe(false);

    const answer = host.request(MENU, returnFocus as never);
    expect(host.mode).toBe('full');
    expect(view().visible).toBe(true);
    expect(view().bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(view().webContents.setZoomFactor).toHaveBeenCalledWith(1.25);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await expect(answer).resolves.toEqual({ kind: 'dismissed' });
    expect(host.mode).toBe('hidden');
    expect(view().visible).toBe(false);
  });

  it('follows the content area on resize while a popup is open', async () => {
    loaded();
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
    void host.request(MENU, undefined);
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

  it('dismisses the open request of a kind as its window closes, closing it in the page and leaving a message dialog open', async () => {
    loaded();
    const settings = host.request({ kind: 'settings', generation: 1 }, returnFocus as never);
    const settingsId = lastRequestId();
    const question = host.request({ kind: 'message', severity: 'warning', message: 'Quit?', actions: ['Quit'], cancelLabel: 'Cancel' }, undefined);
    host.dismiss('settings');
    await expect(settings).resolves.toEqual({ kind: 'dismissed' });
    expect(view().webContents.send).toHaveBeenCalledWith(OVERLAY_CHANNELS.cancel, settingsId);
    expect(host.isOpen('message')).toBe(true);
    host.dismiss('menu');
    expect(host.isOpen('message')).toBe(true);
    void question;
  });

  it('hides and rejects the open request when the overlay crashes, then reloads it and holds a new request for it', async () => {
    loaded();
    const answer = host.request(MENU, returnFocus as never);
    view().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await expect(answer).rejects.toThrow('stopped');
    expect(host.mode).toBe('hidden');
    expect(view().webContents.loadURL).toHaveBeenCalledTimes(2);
    expect(view().webContents.loadURL).toHaveBeenLastCalledWith(OVERLAY_PAGE_URL);
    const next = host.request(MENU, undefined);
    expect(host.mode).toBe('hidden');
    view().webContents.emit('did-finish-load');
    expect(host.mode).toBe('full');
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await expect(next).resolves.toEqual({ kind: 'dismissed' });
  });

  it('keeps a held request through a crash it reloads from, and rejects it once a page that keeps crashing is left dead', async () => {
    loaded();
    const crash = (): void => {
      view().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    };
    crash();
    let error: Error | undefined;
    host.request(MENU, undefined).catch((err: Error) => (error = err));
    crash();
    crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(error).toBeUndefined();
    crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(error?.message).toBe('The overlay page stopped');
    await expect(host.request(MENU, undefined)).rejects.toThrow('not available');
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

// A reload by any route (DevTools, Ctrl+R, Chromium itself) commits a new document that holds none of the old page's popups.
describe('overlay page reload', () => {
  function reloadCommits(): void {
    view().webContents.emit('did-navigate', {}, OVERLAY_PAGE_URL, 200, 'OK');
  }

  function sentRequests(): number {
    return view().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.request).length;
  }

  function outcome(promise: Promise<unknown>): { value?: unknown; error?: Error } {
    const result: { value?: unknown; error?: Error } = {};
    promise.then((value) => (result.value = value), (err: Error) => (result.error = err));
    return result;
  }

  it('rejects the requests open when the page reloads, as a crash does, and hides the overlay', async () => {
    loaded();
    const shown = vi.fn();
    const settings = outcome(host.request(SETTINGS, returnFocus as never, shown));
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    const question = outcome(host.request(QUESTION, undefined));
    reloadCommits();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.error?.message).toBe('The overlay page reloaded');
    expect(question.error?.message).toBe('The overlay page reloaded');
    expect(host.mode).toBe('hidden');
    expect(returnFocus.focus).toHaveBeenCalledTimes(1);
    expect(shown).not.toHaveBeenCalled();
    expect(lines).toContain('[overlay] the page reloaded');
  });

  it('holds a request made while the reloaded page loads and delivers it once the page has loaded', async () => {
    loaded();
    reloadCommits();
    const answer = outcome(host.request(SETTINGS, returnFocus as never));
    await vi.advanceTimersByTimeAsync(OVERLAY_ACK_TIMEOUT_MS * 3);
    expect(sentRequests()).toBe(0);
    expect(host.mode).toBe('hidden');
    expect(answer).toEqual({});

    view().webContents.emit('did-finish-load');
    expect(sentRequests()).toBe(1);
    expect(host.mode).toBe('full');
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'settings', closed: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(answer.value).toEqual({ kind: 'settings', closed: true });
    expect(lines.filter((line) => line.includes('did not acknowledge'))).toEqual([]);
  });

  it('tells a caller waiting for the page only once the reloaded page has loaded', async () => {
    loaded();
    reloadCommits();
    let ready = false;
    const waiting = host.whenLoaded().then(() => {
      ready = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    view().webContents.emit('did-finish-load');
    await waiting;
    expect(ready).toBe(true);
  });

  it('keeps one held popup as it keeps one open: a later request dismisses an earlier one, a message dialog stays', async () => {
    loaded();
    reloadCommits();
    const menu = outcome(host.request(MENU, returnFocus as never));
    const question = outcome(host.request(QUESTION, undefined));
    const settings = outcome(host.request(SETTINGS, undefined));
    await vi.advanceTimersByTimeAsync(0);
    expect(menu.value).toEqual({ kind: 'dismissed' });
    expect(sentRequests()).toBe(0);

    view().webContents.emit('did-finish-load');
    const sent = view().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.request).map(([, payload]) => (payload as { request: OverlayRequest }).request.kind);
    expect(sent).toEqual(['message', 'settings']);
    expect(host.isOpen('message')).toBe(true);
    expect(host.isOpen('settings')).toBe(true);
    void question;
    void settings;
  });

  it('settles a held request its kind\'s dismissal or the window closing ends, and never sends it', async () => {
    loaded();
    reloadCommits();
    const settings = outcome(host.request(SETTINGS, undefined));
    host.dismiss('settings');
    const question = outcome(host.request(QUESTION, undefined));
    host.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(settings.value).toEqual({ kind: 'dismissed' });
    expect(question.error?.message).toBe('The window closed');
    expect(sentRequests()).toBe(0);
  });

  it('rejects a held request when the page fails to load, but not for a load another navigation aborted', async () => {
    loaded();
    reloadCommits();
    const aborted = outcome(host.request(MENU, undefined));
    view().webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', OVERLAY_PAGE_URL, true);
    view().webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'app://damocles/desktop-shell/assets/x.png', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted).toEqual({});
    view().webContents.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', OVERLAY_PAGE_URL, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(aborted.error?.message).toBe('The overlay page did not load');
    await expect(host.request(MENU, undefined)).rejects.toThrow('not available');
  });

  it('drops the images it asked the old page to draw and asks again once the reloaded page has loaded', async () => {
    const art: RasterArt = { width: 16, height: 16, scale: 1, ops: [{ kind: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }] };
    loaded();
    expect(redraws).toBe(1);
    const pending = host.rasterize(art);
    reloadCommits();
    await expect(pending).resolves.toBeUndefined();
    await expect(host.rasterize(art)).resolves.toBeUndefined();
    view().webContents.emit('did-finish-load');
    expect(redraws).toBe(2);
  });

  it('sends nothing to the page between the reload committing and the page loading', () => {
    loaded();
    reloadCommits();
    view().webContents.send.mockClear();
    host.stateChanged();
    host.send(OVERLAY_CHANNELS.settingsTarget, {});
    expect(view().webContents.send).not.toHaveBeenCalled();
  });
});

describe('overlay focus', () => {
  it('moves keyboard focus out when a popup that names no page to return to closes while the overlay holds it', async () => {
    loaded();
    const answer = host.request(MENU, undefined);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await answer;
    expect(host.mode).toBe('hidden');
    expect(focusedOutside).toBe(1);
  });

  it('never returns focus to the overlay itself when a popup opened from it closes', async () => {
    loaded();
    const answer = host.request(MENU, view().webContents as never);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await answer;
    expect(view().webContents.focus).toHaveBeenCalledTimes(1);
    expect(focusedOutside).toBe(1);
  });

  it('leaves focus alone for a popup opened while the window is unfocused, and takes it when asked once the window activates', async () => {
    loaded();
    window.focused = false;
    const answer = host.request({ kind: 'message', severity: 'danger', message: 'The window stopped working.', actions: ['Reload Window'], cancelLabel: 'Close' }, undefined);
    expect(host.mode).toBe('full');
    expect(view().webContents.focus).not.toHaveBeenCalled();
    expect(activations).toBe(1);
    host.focus();
    expect(view().webContents.focus).toHaveBeenCalledTimes(1);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'message', action: 0 });
    await expect(answer).resolves.toEqual({ kind: 'message', action: 0 });
    // With no popup open there is nothing to focus.
    host.focus();
    expect(view().webContents.focus).toHaveBeenCalledTimes(1);
  });

  // The window may never activate while the popup is open; what awaited that activation must not outlive the popup.
  it('reports the last popup closing, before it returns focus, whether it is answered or the overlay fails', async () => {
    loaded();
    window.focused = false;
    let closedBeforeFocusReturned: number | undefined;
    returnFocus.focus.mockImplementationOnce(() => {
      closedBeforeFocusReturned = closings;
    });
    const menu = host.request(MENU, returnFocus as never);
    const menuId = lastRequestId();
    const question = host.request({ kind: 'message', severity: 'danger', message: 'The window stopped working.', actions: ['Reload Window'], cancelLabel: 'Close' }, undefined);
    expect(activations).toBe(2);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'message', action: 0 });
    await question;
    expect(host.mode).toBe('full');
    expect(closings).toBe(0);
    emit(OVERLAY_CHANNELS.answer, own(), menuId, { kind: 'dismissed' });
    await menu;
    expect(host.mode).toBe('hidden');
    expect(closings).toBe(1);
    expect(closedBeforeFocusReturned).toBe(1);

    const failed = host.request(MENU, undefined);
    view().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await expect(failed).rejects.toThrow('The overlay page stopped');
    expect(closings).toBe(2);
  });
});

describe('overlay acknowledgement', () => {
  // A cold or starved renderer can take longer than the deadline to render a popup it has already received.
  it('keeps a request the page acknowledged open while it renders, however long that takes, and reports it shown only once rendered', async () => {
    loaded();
    const shown = vi.fn();
    const answer = host.request(SETTINGS, returnFocus as never, shown);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS * 5);
    expect(host.isOpen('settings')).toBe(true);
    expect(host.mode).toBe('full');
    expect(shown).not.toHaveBeenCalled();
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    expect(shown).toHaveBeenCalledTimes(1);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'settings', closed: true });
    await expect(answer).resolves.toEqual({ kind: 'settings', closed: true });
    expect(lines.filter((line) => line.includes('did not acknowledge'))).toEqual([]);
  });

  it('never reports a popup shown that the page did not acknowledge first, or that missed its deadline', async () => {
    loaded();
    const early = vi.fn();
    const answer = host.request(MENU, undefined, early);
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    expect(early).not.toHaveBeenCalled();
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await answer;

    const missed = vi.fn();
    const unanswered = host.request(MENU, undefined, missed);
    const settled = expect(unanswered).rejects.toThrow('did not respond');
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS);
    await settled;
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    expect(missed).not.toHaveBeenCalled();
  });

  it('logs how long the first popup shown after each page load took to acknowledge and to render, and no later one', async () => {
    loaded();
    const first = host.request(SETTINGS, undefined);
    vi.advanceTimersByTime(5);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    vi.advanceTimersByTime(2995);
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'settings', closed: true });
    await first;
    const second = host.request(MENU, undefined);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await second;
    loaded();
    const reloaded = host.request(MENU, undefined);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    vi.advanceTimersByTime(40);
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await reloaded;
    expect(lines.filter((line) => line.includes('acknowledged'))).toEqual([
      `[overlay] the first request since the page loaded (settings) was acknowledged in 5 ms of ${OVERLAY_ACK_TIMEOUT_MS} and shown in 3000 ms`,
      `[overlay] the first request since the page loaded (menu) was acknowledged in 0 ms of ${OVERLAY_ACK_TIMEOUT_MS} and shown in 40 ms`,
    ]);
  });

  it('honors an acknowledgement that arrived while main was blocked past the deadline', async () => {
    loaded();
    const shown = vi.fn();
    const answer = host.request(QUESTION, returnFocus as never, shown);
    stallMain(OVERLAY_ACK_TIMEOUT_MS + 1000);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    emit(OVERLAY_CHANNELS.shown, own(), lastRequestId());
    expect(shown).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS * 10);
    expect(host.isOpen('message')).toBe(true);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'message', action: 0 });
    await expect(answer).resolves.toEqual({ kind: 'message', action: 0 });
    expect(lines.filter((line) => line.includes('did not acknowledge'))).toEqual([]);
  });

  it('still rejects a request the overlay never acknowledges, by the deadline and after a stall of main', async () => {
    loaded();
    const plain = host.request(MENU, undefined);
    const plainSettled = expect(plain).rejects.toThrow('did not respond');
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS - 1);
    expect(host.isOpen('menu')).toBe(true);
    vi.advanceTimersByTime(1);
    await plainSettled;

    const stalled = host.request(MENU, undefined);
    const stalledSettled = expect(stalled).rejects.toThrow('did not respond');
    stallMain(OVERLAY_ACK_TIMEOUT_MS + 1000);
    expect(host.isOpen('menu')).toBe(true);
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS);
    await stalledSettled;
    expect(host.mode).toBe('hidden');
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

  it('settles once every request it was still answering when its page went has been answered, a failed one included', async () => {
    let answer!: (value: string) => void;
    host.handle('test:slow', () => new Promise<string>((resolve) => (answer = resolve)));
    host.handle('test:failing', async () => {
      throw new Error('failed');
    });
    const slow = view().webContents.ipc.handlers.get('test:slow')!(own()) as Promise<unknown>;
    const failing = view().webContents.ipc.handlers.get('test:failing')!(own()) as Promise<unknown>;
    host.dispose();
    let settled = false;
    const done = host.settled().then(() => {
      settled = true;
    });
    await expect(failing).rejects.toThrow('failed');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    answer('ok');
    await expect(slow).resolves.toBe('ok');
    await done;
    expect(settled).toBe(true);
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

  it('takes a new-terminal pick only of a profile and a project the request offered, and opens that request only from main', () => {
    const request: OverlayRequest = {
      kind: 'newTerminal',
      profiles: [{ id: 'pwsh', name: 'PowerShell', path: 'C:\\pwsh.exe', args: [], source: 'detected', icon: 'powershell', customIcon: null, color: null, isDefault: true }],
      projects: [{ key: 'c:\\alpha', name: 'alpha', path: 'C:\\alpha', current: true }],
    };
    expect(parseOverlayAnswer({ kind: 'newTerminal', profileId: 'pwsh', projectKey: 'c:\\alpha' }, request)).toEqual({ kind: 'newTerminal', profileId: 'pwsh', projectKey: 'c:\\alpha' });
    expect(parseOverlayAnswer({ kind: 'newTerminal', profileId: 'cmd', projectKey: 'c:\\alpha' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'newTerminal', profileId: 'pwsh', projectKey: 'C:\\Windows' }, request)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'dismissed' }, request)).toEqual({ kind: 'dismissed' });
    expect(parseOverlayRequest(request)).toBeUndefined();
  });
});

const QUESTION: Extract<OverlayRequest, { kind: 'message' }> = {
  kind: 'message',
  severity: 'warning',
  message: 'Do you trust the authors of the files in /w/alpha?',
  detail: 'Until you trust it, only your user-level configuration applies there.',
  actions: ['Trust Folder'],
  cancelLabel: "Don't Trust",
};
const SETTINGS: OverlayRequest = { kind: 'settings', generation: 1 };

describe('overlay message dialogs (D41)', () => {
  it('stack above an open request instead of dismissing it, and focus returns once both closed', async () => {
    loaded();
    const settings = host.request(SETTINGS, returnFocus as never);
    const settingsId = lastRequestId();
    const question = host.request(QUESTION, view().webContents as never);
    const questionId = lastRequestId();
    expect(questionId).not.toBe(settingsId);
    expect(host.isOpen('settings')).toBe(true);
    expect(host.isOpen('message')).toBe(true);

    emit(OVERLAY_CHANNELS.answer, own(), questionId, { kind: 'message', action: 0 });
    await expect(question).resolves.toEqual({ kind: 'message', action: 0 });
    expect(host.mode).toBe('full');
    expect(returnFocus.focus).not.toHaveBeenCalled();

    emit(OVERLAY_CHANNELS.answer, own(), settingsId, { kind: 'settings', closed: true });
    await expect(settings).resolves.toEqual({ kind: 'settings', closed: true });
    expect(returnFocus.focus).toHaveBeenCalledTimes(1);
  });

  it('stay open when another popup replaces the open one', async () => {
    loaded();
    const question = host.request(QUESTION, returnFocus as never);
    const menu = host.request(MENU, undefined);
    const replacement = host.request(MENU, undefined);
    await expect(menu).resolves.toEqual({ kind: 'dismissed' });
    expect(host.isOpen('message')).toBe(true);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'dismissed' });
    await expect(replacement).resolves.toEqual({ kind: 'dismissed' });
    expect(host.isOpen('message')).toBe(true);
    host.dispose();
    await expect(question).rejects.toThrow('window closed');
  });

  it('reject every open request when the overlay misses an acknowledgement', async () => {
    loaded();
    const settings = host.request(SETTINGS, returnFocus as never);
    emit(OVERLAY_CHANNELS.ack, own(), lastRequestId());
    const question = host.request(QUESTION, undefined);
    const both = Promise.allSettled([settings, question]);
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS);
    expect((await both).map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(host.mode).toBe('hidden');
  });

  it('accept an answer only for the id main issued, naming one of its actions or Cancel', async () => {
    loaded();
    const question = host.request(QUESTION, undefined);
    emit(OVERLAY_CHANNELS.answer, own(), 'forged', { kind: 'message', action: 0 });
    emit(OVERLAY_CHANNELS.answer, { sender: { id: 9 }, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, lastRequestId(), { kind: 'message', action: 0 });
    expect(host.isOpen('message')).toBe(true);
    emit(OVERLAY_CHANNELS.answer, own(), lastRequestId(), { kind: 'message', action: 3 });
    await expect(question).resolves.toEqual({ kind: 'dismissed' });
  });
});

describe('message and notification request validation', () => {
  it('rebuilds a message main asks, dropping unknown fields and an empty detail', () => {
    expect(parseMessageRequest({ ...QUESTION, extra: 1 })).toEqual(QUESTION);
    expect(parseMessageRequest({ ...QUESTION, detail: '', defaultAction: 0 })).toEqual({ ...QUESTION, detail: undefined, defaultAction: 0 });
    // A renderer can never open one.
    expect(parseOverlayRequest(QUESTION)).toBeUndefined();
  });

  it.each([
    ['an unknown severity', { ...QUESTION, severity: 'fatal' }],
    ['no message', { ...QUESTION, message: '' }],
    ['a message over the bound', { ...QUESTION, message: 'x'.repeat(2001) }],
    ['a detail over the bound', { ...QUESTION, detail: 'x'.repeat(2001) }],
    ['no cancel label', { ...QUESTION, cancelLabel: '' }],
    ['too many actions', { ...QUESTION, actions: Array.from({ length: MAX_MESSAGE_ACTIONS + 1 }, (_, i) => `a${i}`) }],
    ['an empty action', { ...QUESTION, actions: [''] }],
    ['a default action out of range', { ...QUESTION, defaultAction: 1 }],
    ['a fractional default action', { ...QUESTION, defaultAction: 0.5 }],
  ])('refuses a message with %s', (_name, raw) => {
    expect(parseMessageRequest(raw)).toBeUndefined();
  });

  it('accepts the bell center from the shell with an anchor only, and its answers', () => {
    const center = parseOverlayRequest({ kind: 'notifications', anchor: MENU.anchor, entries: ['forged'] });
    expect(center).toEqual({ kind: 'notifications', anchor: MENU.anchor });
    expect(parseOverlayRequest({ kind: 'notifications', anchor: { x: -1, y: 0, width: 1, height: 1 } })).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'notifications', action: 'open', entryId: 'e1' }, center!)).toEqual({ kind: 'notifications', action: 'open', entryId: 'e1' });
    expect(parseOverlayAnswer({ kind: 'notifications', action: 'preview' }, center!)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'notifications', action: 'open' }, center!)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'notifications', action: 'clear' }, center!)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'message', action: 0 }, center!)).toBeUndefined();
  });

  it('accepts a message answer naming an action index or null for Cancel', () => {
    expect(parseOverlayAnswer({ kind: 'message', action: 0 }, QUESTION)).toEqual({ kind: 'message', action: 0 });
    expect(parseOverlayAnswer({ kind: 'message', action: null }, QUESTION)).toEqual({ kind: 'message', action: null });
    expect(parseOverlayAnswer({ kind: 'message', action: 1 }, QUESTION)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'message', action: '0' }, QUESTION)).toBeUndefined();
    expect(parseOverlayAnswer({ kind: 'message' }, QUESTION)).toBeUndefined();
  });
});

describe('overlay rasterizing (D52)', () => {
  const ART: RasterArt = { width: 16, height: 16, scale: 1, ops: [{ kind: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }] };

  function lastRaster(): OverlayRasterRequest {
    const sent = view().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.rasterize);
    return sent.at(-1)?.[1] as OverlayRasterRequest;
  }

  it('sends main\'s art under an id main issued and resolves with the PNG once it is valid', async () => {
    loaded();
    const result = host.rasterize(ART);
    const request = lastRaster();
    expect(request.art).toEqual(ART);
    const png = pngFixture(16, 16);
    emit(OVERLAY_CHANNELS.rasterized, own(), request.id, new Uint8Array(png));
    await expect(result).resolves.toEqual(png);
  });

  it('refuses a PNG of another size or a non-PNG answer, and answers from any other page or for an id it never issued', async () => {
    loaded();
    const wrongSize = host.rasterize(ART);
    emit(OVERLAY_CHANNELS.rasterized, own(), lastRaster().id, new Uint8Array(pngFixture(32, 32)));
    await expect(wrongSize).resolves.toBeUndefined();
    const notPng = host.rasterize(ART);
    emit(OVERLAY_CHANNELS.rasterized, own(), lastRaster().id, 'data:image/png;base64,AAAA');
    await expect(notPng).resolves.toBeUndefined();
    expect(lines.filter((line) => line.includes('refused a rasterized image'))).toHaveLength(2);

    const forged = host.rasterize(ART);
    const { id } = lastRaster();
    emit(OVERLAY_CHANNELS.rasterized, { sender: { id: 9 }, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, id, new Uint8Array(pngFixture(16, 16)));
    emit(OVERLAY_CHANNELS.rasterized, own(), 'not-issued', new Uint8Array(pngFixture(16, 16)));
    emit(OVERLAY_CHANNELS.rasterized, own(), id, null);
    await expect(forged).resolves.toBeUndefined();
  });

  it('resolves undefined while the page is not loaded, when it misses the deadline, and when it crashes', async () => {
    await expect(host.rasterize(ART)).resolves.toBeUndefined();
    loaded();
    const late = host.rasterize(ART);
    vi.advanceTimersByTime(RASTER_TIMEOUT_MS);
    await expect(late).resolves.toBeUndefined();
    const crashed = host.rasterize(ART);
    view().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await expect(crashed).resolves.toBeUndefined();
  });

  it('accepts an image that arrived while main was blocked past the deadline, and still gives up on one that never arrives', async () => {
    loaded();
    const stalled = host.rasterize(ART);
    stallMain(RASTER_TIMEOUT_MS + 1000);
    const png = pngFixture(16, 16);
    emit(OVERLAY_CHANNELS.rasterized, own(), lastRaster().id, new Uint8Array(png));
    await expect(stalled).resolves.toEqual(png);
    expect(redraws).toBe(1);

    const never = host.rasterize(ART);
    stallMain(RASTER_TIMEOUT_MS + 1000);
    expect(lines.filter((line) => line.includes('did not rasterize'))).toEqual([]);
    vi.advanceTimersByTime(RASTER_TIMEOUT_MS);
    await expect(never).resolves.toBeUndefined();
    expect(lines.filter((line) => line.includes('did not rasterize'))).toHaveLength(1);
  });

  it('tells main each time its page loads, so a badge drawn while it could not draw is drawn again', () => {
    expect(redraws).toBe(0);
    loaded();
    expect(redraws).toBe(1);
    view().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    view().webContents.emit('did-finish-load');
    expect(redraws).toBe(2);
  });

  it('asks for a redraw when the page answers after a deadline, once per page load, and never resolves the missed request', async () => {
    loaded();
    const first = host.rasterize(ART);
    const firstId = lastRaster().id;
    const second = host.rasterize(ART);
    const secondId = lastRaster().id;
    vi.advanceTimersByTime(RASTER_TIMEOUT_MS);
    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(redraws).toBe(1);

    emit(OVERLAY_CHANNELS.rasterized, own(), firstId, new Uint8Array(pngFixture(16, 16)));
    expect(redraws).toBe(2);
    emit(OVERLAY_CHANNELS.rasterized, own(), secondId, new Uint8Array(pngFixture(16, 16)));
    expect(redraws).toBe(2);
    expect(lines.filter((line) => line.includes('ignoring a rasterized image'))).toEqual([]);

    view().webContents.emit('did-finish-load');
    expect(redraws).toBe(3);
    const third = host.rasterize(ART);
    const thirdId = lastRaster().id;
    vi.advanceTimersByTime(RASTER_TIMEOUT_MS);
    await expect(third).resolves.toBeUndefined();
    emit(OVERLAY_CHANNELS.rasterized, own(), thirdId, new Uint8Array(pngFixture(16, 16)));
    expect(redraws).toBe(4);
  });
});
