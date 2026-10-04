import { randomUUID } from 'node:crypto';
import { dialog, Notification, type BrowserWindow, type MessageBoxOptions } from 'electron';
import type { NotificationOptions, NotificationService } from '../../../platform/notification-service';
import type { OverlayToast } from '../../preload/overlay-channels';

type Severity = OverlayToast['severity'];

// How long main keeps a toast before resolving it undefined; the overlay only renders and reports.
export const TOAST_TIMEOUT_MS: Readonly<Record<Severity | 'withActions', number>> = {
  info: 8_000,
  warning: 12_000,
  error: 20_000,
  // a toast that asks for a choice stays long enough to be answered after a glance away
  withActions: 120_000,
};

export interface ToastSink {
  show(toast: OverlayToast): void;
  dismiss(id: string): void;
}

export interface NotificationDeps {
  readonly window: () => BrowserWindow | undefined;
  // undefined while the overlay page is loading or gone
  readonly toasts: () => ToastSink | undefined;
  // damocles.desktop.notifications.enabled: whether an OS notification accompanies a toast while the window is unfocused
  readonly osNotifications: () => boolean;
  // brings the window forward when the user clicks an OS notification
  readonly showWindow: () => void;
  readonly t: (message: string) => string;
  readonly log: (line: string) => void;
}

export interface DesktopNotificationService extends NotificationService {
  // The overlay's answer: an action label of that toast, or undefined for a dismissal.
  resolveToast(id: string, action: string | undefined): void;
  // Toasts still waiting for an answer, for an overlay page that has just (re)loaded and shows them; their countdowns start now.
  pendingToasts(): readonly OverlayToast[];
}

interface PendingToast {
  readonly toast: OverlayToast;
  readonly resolve: (action: string | undefined) => void;
  // set once an overlay has been handed the toast
  timer: NodeJS.Timeout | undefined;
}

function split(rest: ReadonlyArray<NotificationOptions | string>): { modal: boolean; actions: string[] } {
  const [first, ...others] = rest;
  if (typeof first === 'object') return { modal: first.modal === true, actions: others as string[] };
  return { modal: false, actions: rest as string[] };
}

// Modal prompts are native message boxes on the window; everything else is an in-window toast, plus an OS notification while the window is not focused.
export function createDesktopNotificationService(deps: NotificationDeps): DesktopNotificationService {
  const pending = new Map<string, PendingToast>();

  const settle = (id: string, action: string | undefined): void => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(action);
  };

  const notifyOs = (message: string): void => {
    const window = deps.window();
    if (window?.isFocused() || !deps.osNotifications() || !Notification.isSupported()) return;
    const notification = new Notification({ title: 'Damocles', body: message });
    notification.on('click', () => deps.showWindow());
    notification.show();
  };

  const modal = async (type: Severity, message: string, actions: string[]): Promise<string | undefined> => {
    const options: MessageBoxOptions = {
      type,
      title: 'Damocles',
      message,
      // The last button dismisses and resolves undefined, like closing a VS Code notification.
      buttons: [...actions, actions.length > 0 ? deps.t('Cancel') : deps.t('OK')],
      cancelId: actions.length,
      defaultId: 0,
      noLink: true,
    };
    const parent = deps.window();
    const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    return actions[response];
  };

  const startCountdown = (entry: PendingToast): void => {
    if (entry.timer !== undefined) return;
    const { id, severity, actions } = entry.toast;
    entry.timer = setTimeout(() => {
      settle(id, undefined);
      deps.toasts()?.dismiss(id);
    }, actions.length > 0 ? TOAST_TIMEOUT_MS.withActions : TOAST_TIMEOUT_MS[severity]);
  };

  // A toast raised before the window exists, while its overlay loads or while it is closed waits in main for the next
  // overlay to load; its countdown starts once an overlay has it.
  const toast = (severity: Severity, message: string, actions: string[]): Promise<string | undefined> => {
    notifyOs(message);
    const shown: OverlayToast = { id: randomUUID(), severity, message, actions };
    return new Promise((resolve) => {
      const entry: PendingToast = { toast: shown, resolve, timer: undefined };
      pending.set(shown.id, entry);
      const sink = deps.toasts();
      if (!sink) return;
      startCountdown(entry);
      sink.show(shown);
    });
  };

  const show = (type: Severity, message: string, rest: ReadonlyArray<NotificationOptions | string>): Promise<string | undefined> => {
    const { modal: isModal, actions } = split(rest);
    deps.log(`[notification:${type}] ${message}`);
    return isModal ? modal(type, message, actions) : toast(type, message, actions);
  };

  return {
    info: (message: string, ...rest: Array<NotificationOptions | string>) => show('info', message, rest),
    warn: (message: string, ...rest: Array<NotificationOptions | string>) => show('warning', message, rest),
    error: (message: string, ...rest: Array<NotificationOptions | string>) => show('error', message, rest),
    resolveToast: (id, action) => {
      const entry = pending.get(id);
      if (!entry) return;
      if (action !== undefined && !entry.toast.actions.includes(action)) {
        deps.log(`[notification] ignored an answer that is not one of toast ${id}'s actions`);
        return;
      }
      settle(id, action);
    },
    pendingToasts: () => [...pending.values()].map((entry) => {
      startCountdown(entry);
      return entry.toast;
    }),
  };
}
