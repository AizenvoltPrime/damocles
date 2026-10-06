import type { NotificationOptions, NotificationService } from '../../../platform/notification-service';
import type { MessageSeverity } from '../../preload/overlay-channels';
import type { NoticeSeverity } from '../../preload/notifications';
import type { AskMessage } from '../message-dialog';

export interface NotificationDeps {
  // a toast and a notification-center entry, resolved with the chosen action or undefined
  readonly notice: (severity: NoticeSeverity, message: string, actions: readonly string[]) => Promise<string | undefined>;
  // a modal question, in the overlay's dialog or the OS message box
  readonly ask: AskMessage;
  readonly t: (message: string) => string;
  readonly log: (line: string) => void;
}

const DIALOG_SEVERITY: Readonly<Record<NoticeSeverity, MessageSeverity>> = { info: 'info', warning: 'warning', error: 'danger' };

function split(rest: ReadonlyArray<NotificationOptions | string>): { modal: boolean; actions: string[] } {
  const [first, ...others] = rest;
  if (typeof first === 'object') return { modal: first.modal === true, actions: others as string[] };
  return { modal: false, actions: rest as string[] };
}

/** A modal notification is a dialog (D41); every other one is a toast and a notification-center entry (plan AD10). */
export function createDesktopNotificationService(deps: NotificationDeps): NotificationService {
  const modal = async (severity: NoticeSeverity, message: string, actions: string[]): Promise<string | undefined> => {
    const dialogSeverity = DIALOG_SEVERITY[severity];
    const chosen = await deps.ask({
      severity: dialogSeverity,
      message,
      actions,
      // Cancel answers undefined, like closing a VS Code notification.
      cancelLabel: actions.length > 0 ? deps.t('Cancel') : deps.t('OK'),
      // A danger dialog focuses Cancel, so a stray Enter never takes its action.
      ...(dialogSeverity !== 'danger' && actions.length > 0 ? { defaultAction: 0 } : {}),
    });
    return chosen === undefined ? undefined : actions[chosen];
  };

  const show = (severity: NoticeSeverity, message: string, rest: ReadonlyArray<NotificationOptions | string>): Promise<string | undefined> => {
    const { modal: isModal, actions } = split(rest);
    deps.log(`[notification:${severity}] ${message}`);
    return isModal ? modal(severity, message, actions) : deps.notice(severity, message, actions);
  };

  return {
    info: (message: string, ...rest: Array<NotificationOptions | string>) => show('info', message, rest),
    warn: (message: string, ...rest: Array<NotificationOptions | string>) => show('warning', message, rest),
    error: (message: string, ...rest: Array<NotificationOptions | string>) => show('error', message, rest),
  };
}
