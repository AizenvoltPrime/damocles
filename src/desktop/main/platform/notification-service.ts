import type { NotificationOptions, NotificationService } from '../../../platform/notification-service';
import type { LocalizedText } from '../../../shared/localized-text';
import type { MessageSeverity } from '../../preload/overlay-channels';
import type { NoticeSeverity } from '../../preload/notifications';
import type { AskMessage } from '../message-dialog';

/** Main's own notices, whose text main already rendered; each answers with the chosen action's label. */
export interface TextNotifications {
  info(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  info(message: string, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  warn(message: string, ...actions: string[]): Promise<string | undefined>;
  error(message: string, options: NotificationOptions, ...actions: string[]): Promise<string | undefined>;
  error(message: string, ...actions: string[]): Promise<string | undefined>;
}

/** A notice of rendered text answered with the chosen action's index, so actions that read alike stay apart. */
export interface IndexedNotifications {
  show(severity: NoticeSeverity, message: string, actions: readonly string[], options?: NotificationOptions): Promise<number | undefined>;
}

export type DesktopNotifications = TextNotifications & IndexedNotifications;

export interface NotificationDeps {
  // a toast and a notification-center entry, resolved with the chosen action's index or undefined
  readonly notice: (severity: NoticeSeverity, message: string, actions: readonly string[]) => Promise<number | undefined>;
  // a modal question, in the overlay's dialog or the OS message box
  readonly ask: AskMessage;
  readonly t: (message: string) => string;
  readonly log: (line: string) => void;
}

const DIALOG_SEVERITY: Readonly<Record<NoticeSeverity, MessageSeverity>> = { info: 'info', warning: 'warning', error: 'danger' };

function split(rest: ReadonlyArray<NotificationOptions | string>): { options: NotificationOptions | undefined; actions: string[] } {
  const [first, ...others] = rest;
  if (typeof first === 'object') return { options: first, actions: others as string[] };
  return { options: undefined, actions: rest as string[] };
}

/** A modal notification is a dialog (D41); every other one is a toast and a notification-center entry (plan AD10). */
export function createDesktopNotificationService(deps: NotificationDeps): DesktopNotifications {
  const modal = (severity: NoticeSeverity, message: string, actions: readonly string[], signal: AbortSignal | undefined): Promise<number | undefined> => {
    const dialogSeverity = DIALOG_SEVERITY[severity];
    return deps.ask({
      severity: dialogSeverity,
      message,
      actions: [...actions],
      // Cancel answers undefined, like closing a VS Code notification.
      cancelLabel: actions.length > 0 ? deps.t('Cancel') : deps.t('OK'),
      // A danger dialog focuses Cancel, so a stray Enter never takes its action.
      ...(dialogSeverity !== 'danger' && actions.length > 0 ? { defaultAction: 0 } : {}),
    }, signal);
  };

  const show: IndexedNotifications['show'] = (severity, message, actions, options) => {
    deps.log(`[notification:${severity}] ${message}`);
    return options?.modal === true ? modal(severity, message, actions, options.signal) : deps.notice(severity, message, actions);
  };

  const labelled = (severity: NoticeSeverity) => async (message: string, ...rest: Array<NotificationOptions | string>): Promise<string | undefined> => {
    const { options, actions } = split(rest);
    const chosen = await show(severity, message, actions, options);
    return chosen === undefined ? undefined : actions[chosen];
  };

  return { show, info: labelled('info'), warn: labelled('warning'), error: labelled('error') };
}

const SEVERITY: Readonly<Record<keyof NotificationService, NoticeSeverity>> = { info: 'info', warn: 'warning', error: 'error' };

/** Core's notices, rendered in main's language; the answer is the chosen action's index, so no rendered label is compared. */
export function localizedNotifications(notifications: IndexedNotifications, render: (text: LocalizedText) => string): NotificationService {
  const show = (severity: keyof NotificationService) => (message: LocalizedText, actions: readonly LocalizedText[] = [], options?: NotificationOptions): Promise<number | undefined> =>
    notifications.show(SEVERITY[severity], render(message), actions.map(render), options);
  return { info: show('info'), warn: show('warn'), error: show('error') };
}
