import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const shown: string[] = [];
  class Notification {
    static isSupported = (): boolean => true;
    readonly body: string;
    constructor(options: { body: string }) {
      this.body = options.body;
    }
    on(): void {}
    show(): void {
      shown.push(this.body);
    }
  }
  return { shown, Notification, dialog: { showMessageBox: vi.fn() } };
});

vi.mock('electron', () => ({ dialog: electron.dialog, Notification: electron.Notification }));

import type { OverlayToast } from '../../preload/overlay-channels';
import { createDesktopNotificationService, TOAST_TIMEOUT_MS, type ToastSink } from '../platform/notification-service';

let toasts: OverlayToast[];
let dismissed: string[];
let focused: boolean;
let windowOpen: boolean;
let sink: ToastSink | undefined;
let osNotifications: boolean;

function service(): ReturnType<typeof createDesktopNotificationService> {
  return createDesktopNotificationService({
    window: () => (windowOpen ? ({ isFocused: () => focused }) as never : undefined),
    toasts: () => sink,
    osNotifications: () => osNotifications,
    showWindow: () => undefined,
    t: (message) => message,
    log: () => undefined,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  toasts = [];
  dismissed = [];
  focused = true;
  windowOpen = true;
  osNotifications = true;
  electron.shown.length = 0;
  electron.dialog.showMessageBox.mockReset();
  sink = { show: (toast) => toasts.push(toast), dismiss: (id) => dismissed.push(id) };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('desktop notifications', () => {
  it('shows a non-modal notice as a toast that resolves with the chosen action', async () => {
    const notifications = service();
    const answer = notifications.warn('Reload?', 'Reload', 'Later');
    expect(toasts).toEqual([{ id: expect.any(String), severity: 'warning', message: 'Reload?', actions: ['Reload', 'Later'] }]);
    expect(notifications.pendingToasts()).toHaveLength(1);
    notifications.resolveToast(toasts[0]!.id, 'Reload');
    await expect(answer).resolves.toBe('Reload');
    expect(notifications.pendingToasts()).toHaveLength(0);
    expect(electron.dialog.showMessageBox).not.toHaveBeenCalled();
  });

  it('ignores an answer that is not one of the toast actions, and resolves undefined on dismissal', async () => {
    const notifications = service();
    const answer = notifications.error('Failed', 'Retry');
    notifications.resolveToast(toasts[0]!.id, 'Delete everything');
    expect(notifications.pendingToasts()).toHaveLength(1);
    notifications.resolveToast(toasts[0]!.id, undefined);
    await expect(answer).resolves.toBeUndefined();
  });

  it('times a toast out in main and tells the shell to drop it', async () => {
    const notifications = service();
    const plain = notifications.info('Saved');
    const asking = notifications.info('Open?', 'Open');
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS.info);
    await expect(plain).resolves.toBeUndefined();
    expect(dismissed).toEqual([toasts[0]!.id]);
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS.withActions - TOAST_TIMEOUT_MS.info);
    await expect(asking).resolves.toBeUndefined();
  });

  it('keeps modal prompts native and modal', async () => {
    electron.dialog.showMessageBox.mockResolvedValue({ response: 0 });
    const notifications = service();
    await expect(notifications.warn('Switch?', { modal: true }, 'Start new conversation')).resolves.toBe('Start new conversation');
    expect(toasts).toEqual([]);
    const [parent, options] = electron.dialog.showMessageBox.mock.calls[0] as [unknown, { buttons: string[]; cancelId: number }];
    expect(parent).toBeDefined();
    expect(options.buttons).toEqual(['Start new conversation', 'Cancel']);
    expect(options.cancelId).toBe(1);
  });

  it('raises an OS notification only while the window is not focused', () => {
    const notifications = service();
    void notifications.info('focused');
    focused = false;
    void notifications.info('in the background');
    expect(electron.shown).toEqual(['in the background']);
  });

  it('raises no OS notification while damocles.desktop.notifications.enabled is off, and still shows the toast', () => {
    osNotifications = false;
    focused = false;
    const notifications = service();
    void notifications.info('in the background');
    expect(electron.shown).toEqual([]);
    expect(toasts.map((toast) => toast.message)).toEqual(['in the background']);
  });

  it('holds a toast raised while the shell loads, for replay once it has loaded', () => {
    sink = undefined;
    const notifications = service();
    void notifications.warn('Early', 'Act');
    expect(notifications.pendingToasts()).toEqual([expect.objectContaining({ message: 'Early', actions: ['Act'] })]);
  });

  it('holds a toast raised before the window exists, and starts its countdown only once a shell shows it', async () => {
    windowOpen = false;
    sink = undefined;
    const notifications = service();
    const answer = notifications.warn('Could not decrypt 1 saved secret');
    let settled = false;
    void answer.then(() => {
      settled = true;
    });
    expect(electron.shown).toEqual(['Could not decrypt 1 saved secret']);

    vi.advanceTimersByTime(TOAST_TIMEOUT_MS.warning * 2);
    await Promise.resolve();
    expect(settled).toBe(false);

    windowOpen = true;
    expect(notifications.pendingToasts()).toEqual([expect.objectContaining({ message: 'Could not decrypt 1 saved secret' })]);
    vi.advanceTimersByTime(TOAST_TIMEOUT_MS.warning);
    await expect(answer).resolves.toBeUndefined();
  });
});
