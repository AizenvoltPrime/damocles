import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ showMessageBox: vi.fn() }));

vi.mock('electron', async () => ({
  ...(await import('./fake-overlay-electron')).fakeOverlayElectron(),
  dialog: { showMessageBox: (...args: unknown[]) => H.showMessageBox(...args) },
}));

import { OVERLAY_ACK_TIMEOUT_MS, OVERLAY_CHANNELS, type OverlayRequest, type OverlayToast } from '../../preload/overlay-channels';
import { createMessageAsker } from '../message-dialog';
import { NotificationCenter } from '../notification-center';
import { OverlayHost } from '../overlay';
import { createDesktopNotificationService } from '../platform/notification-service';
import { OVERLAY_PAGE_URL } from '../protocol';
import { fakeOverlayWindow, type FakeOverlayView } from './fake-overlay-electron';

let host: OverlayHost | undefined;
let lines: string[];
let notices: Array<[string, string, readonly string[]]>;
const parent = { id: 'window' };

function newHost(): OverlayHost {
  return new OverlayHost({
    window: fakeOverlayWindow() as never,
    preloadPath: 'preload-overlay.js',
    state: () => ({ locale: 'en', platform: 'win32' }),
    focusOutside: () => undefined,
    awaitActivation: () => undefined,
    canRasterize: () => undefined,
    log: () => undefined,
  });
}

function view(): FakeOverlayView {
  return host!.view as unknown as FakeOverlayView;
}

function loaded(): void {
  host!.load();
  view().webContents.emit('did-finish-load');
}

// The request the overlay page received, as the page sees it.
function sentRequest(): { requestId: string; request: OverlayRequest } | undefined {
  const sent = view().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.request);
  return sent.at(-1)?.[1] as { requestId: string; request: OverlayRequest } | undefined;
}

function answerFromOverlay(answer: unknown): void {
  const sent = sentRequest()!;
  view().webContents.ipc.emit(OVERLAY_CHANNELS.ack, { sender: view().webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, sent.requestId);
  view().webContents.ipc.emit(OVERLAY_CHANNELS.answer, { sender: view().webContents, senderFrame: { url: OVERLAY_PAGE_URL, parent: null } }, sent.requestId, answer);
}

function service(): ReturnType<typeof createDesktopNotificationService> {
  return createDesktopNotificationService({
    notice: async (severity, message, actions) => {
      notices.push([severity, message, actions]);
      return actions[0];
    },
    ask: createMessageAsker({ overlay: () => host, window: () => parent as never, focused: () => undefined, log: (line) => lines.push(line) }),
    t: (message) => message,
    log: () => undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  host = newHost();
  lines = [];
  notices = [];
  H.showMessageBox.mockReset();
});

afterEach(() => {
  host?.dispose();
  vi.useRealTimers();
});

describe('desktop notifications', () => {
  it('sends a non-modal notification to the center as a toast and entry', async () => {
    await expect(service().warn('Reload?', 'Reload', 'Later')).resolves.toBe('Reload');
    expect(notices).toEqual([['warning', 'Reload?', ['Reload', 'Later']]]);
    expect(H.showMessageBox).not.toHaveBeenCalled();
  });

  it('answers a notice with actions from its popup while the main window is focused, and the overlay page never gets it', async () => {
    loaded();
    const popup: OverlayToast[] = [];
    const center = new NotificationCenter({
      doNotDisturb: () => false,
      setDoNotDisturb: async () => undefined,
      popupsEnabled: () => true,
      windowFocused: () => true,
      chatSelected: () => true,
      viewedChat: () => undefined,
      flash: () => undefined,
      describeChat: async () => undefined,
      popups: () => ({ show: (toast) => popup.push(toast), dismiss: () => undefined }),
      chime: () => undefined,
      usageWarningShown: () => false,
      recordUsageWarning: () => undefined,
      run: () => undefined,
      changed: () => undefined,
      log: () => undefined,
    });
    const notifications = createDesktopNotificationService({
      notice: (severity, message, actions) => center.notice(severity, message, actions),
      ask: createMessageAsker({ overlay: () => host, window: () => parent as never, focused: () => undefined, log: (line) => lines.push(line) }),
      t: (message) => message,
      log: () => undefined,
    });
    const answer = notifications.warn('Reload the window to apply the change?', 'Reload', 'Later');
    expect(popup.map((toast) => toast.body)).toEqual([{ kind: 'notice', severity: 'warning', message: 'Reload the window to apply the change?', actions: ['Reload', 'Later'] }]);
    center.resolveToast(popup[0]!.id, 'Later');
    await expect(answer).resolves.toBe('Later');
    expect(view().webContents.send.mock.calls.filter(([channel]) => channel === OVERLAY_CHANNELS.toast)).toEqual([]);
    expect(H.showMessageBox).not.toHaveBeenCalled();
  });

  it('asks a modal notification as the overlay message dialog and answers the chosen action', async () => {
    loaded();
    const answer = service().warn('Switch this panel to beta?', { modal: true }, 'Start new conversation');
    expect(sentRequest()?.request).toEqual({
      kind: 'message',
      severity: 'warning',
      message: 'Switch this panel to beta?',
      actions: ['Start new conversation'],
      cancelLabel: 'Cancel',
      defaultAction: 0,
    });
    answerFromOverlay({ kind: 'message', action: 0 });
    await expect(answer).resolves.toBe('Start new conversation');
    expect(notices).toEqual([]);
    expect(H.showMessageBox).not.toHaveBeenCalled();
  });

  it('resolves Cancel, Escape and a dismissal undefined, and focuses Cancel first in a danger dialog', async () => {
    loaded();
    const cancelled = service().error('The Damocles window stopped working.', { modal: true }, 'Reload Window');
    const request = sentRequest()?.request as Extract<OverlayRequest, { kind: 'message' }>;
    expect(request.severity).toBe('danger');
    expect(request.defaultAction).toBeUndefined();
    answerFromOverlay({ kind: 'message', action: null });
    await expect(cancelled).resolves.toBeUndefined();

    const dismissed = service().info('Done.', { modal: true });
    expect((sentRequest()?.request as Extract<OverlayRequest, { kind: 'message' }>).cancelLabel).toBe('OK');
    answerFromOverlay({ kind: 'dismissed' });
    await expect(dismissed).resolves.toBeUndefined();
  });

  it('falls back to the OS message box, parented to the window, when the overlay page has not loaded', async () => {
    H.showMessageBox.mockResolvedValue({ response: 0 });
    await expect(service().warn('Switch?', { modal: true }, 'Start new conversation')).resolves.toBe('Start new conversation');
    const [boxParent, options] = H.showMessageBox.mock.calls[0] as [unknown, { buttons: string[]; cancelId: number; defaultId: number; type: string }];
    expect(boxParent).toBe(parent);
    expect(options).toMatchObject({ buttons: ['Start new conversation', 'Cancel'], cancelId: 1, defaultId: 0, type: 'warning' });
    expect(lines.some((line) => line.includes('asking with the OS message box'))).toBe(true);
  });

  it('falls back when there is no overlay at all, and maps the box\'s Cancel to undefined', async () => {
    host?.dispose();
    host = undefined;
    H.showMessageBox.mockResolvedValue({ response: 1 });
    await expect(service().warn('Switch?', { modal: true }, 'Start new conversation')).resolves.toBeUndefined();
    expect(H.showMessageBox).toHaveBeenCalledTimes(1);
  });

  it('falls back when the overlay crashes while it asks', async () => {
    loaded();
    H.showMessageBox.mockResolvedValue({ response: 0 });
    const answer = service().error('Reload?', { modal: true }, 'Reload Window');
    expect(sentRequest()).toBeDefined();
    view().webContents.crashed = true;
    view().webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 });
    await expect(answer).resolves.toBe('Reload Window');
    expect(H.showMessageBox.mock.calls[0]![1]).toMatchObject({ type: 'error', defaultId: 1, cancelId: 1 });
  });

  it('falls back when the overlay misses its acknowledgement', async () => {
    loaded();
    H.showMessageBox.mockResolvedValue({ response: 0 });
    const answer = service().warn('Switch?', { modal: true }, 'Start new conversation');
    vi.advanceTimersByTime(OVERLAY_ACK_TIMEOUT_MS);
    await expect(answer).resolves.toBe('Start new conversation');
    expect(lines.some((line) => line.includes('did not respond'))).toBe(true);
  });

  it('asks a question beyond the overlay dialog\'s bounds with the OS message box', async () => {
    loaded();
    H.showMessageBox.mockResolvedValue({ response: 1 });
    await expect(service().warn('x'.repeat(5000), { modal: true }, 'Go')).resolves.toBeUndefined();
    expect(sentRequest()).toBeUndefined();
    expect(H.showMessageBox).toHaveBeenCalledTimes(1);
  });
});
