import { dialog, type BrowserWindow, type MessageBoxOptions, type WebContents } from 'electron';
import type { MessageSeverity, OverlayAnswer, OverlayRequest } from '../preload/overlay-channels';
import { parseMessageRequest } from './overlay';

export interface MessageQuestion {
  readonly severity: MessageSeverity;
  readonly message: string;
  readonly detail?: string;
  readonly actions: readonly string[];
  // undefined: no Cancel button; Escape, the scrim and the OS box's close still cancel. Then defaultAction is required.
  readonly cancelLabel?: string;
  // the action focused first; undefined focuses Cancel
  readonly defaultAction?: number;
  // lines shown verbatim in the mono font; the caller makes control characters visible
  readonly preview?: readonly string[];
}

/** Asks the user; resolves the index of the chosen action, or undefined for Cancel. */
export type AskMessage = (question: MessageQuestion) => Promise<number | undefined>;

export interface MessageOverlay {
  request(request: OverlayRequest, returnFocus: WebContents | undefined): Promise<OverlayAnswer>;
}

export interface MessageAskerDeps {
  // undefined while no window holds an overlay
  readonly overlay: () => MessageOverlay | undefined;
  readonly window: () => BrowserWindow | undefined;
  // where keyboard focus returns once the dialog closes
  readonly focused: () => WebContents | undefined;
  // true once a quit nobody can cancel closes the window: a question then answers Cancel so the request asking it settles
  readonly closing: () => boolean;
  readonly log: (line: string) => void;
}

const NATIVE_TYPE: Readonly<Record<MessageSeverity, NonNullable<MessageBoxOptions['type']>>> = { info: 'info', warning: 'warning', danger: 'error' };

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Every desktop question renders as the overlay's dialog (D41). The OS message box asks only when the overlay cannot:
 * no overlay page loaded or loading, a crashed or reloaded one, a missed acknowledgement, or a question beyond the
 * overlay's bounds, except once a quit closes the window.
 */
export function createMessageAsker(deps: MessageAskerDeps): AskMessage {
  const native = async (question: MessageQuestion): Promise<number | undefined> => {
    const detail = [question.detail, ...(question.preview ?? [])].filter((part) => part !== undefined && part !== '').join('\n');
    const options: MessageBoxOptions = {
      type: NATIVE_TYPE[question.severity],
      title: 'Damocles',
      message: question.message,
      ...(detail !== '' ? { detail } : {}),
      // Cancel is the last button, when there is one; Escape and closing the box answer the index past the actions either way.
      buttons: question.cancelLabel !== undefined ? [...question.actions, question.cancelLabel] : [...question.actions],
      cancelId: question.actions.length,
      defaultId: question.defaultAction ?? question.actions.length,
      noLink: true,
    };
    const parent = deps.window();
    const { response } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
    return response < question.actions.length ? response : undefined;
  };

  return async (question) => {
    if (deps.closing()) {
      deps.log('[dialog] the window is closing for a quit; the question is dismissed');
      return undefined;
    }
    const request = parseMessageRequest({ kind: 'message', ...question });
    const overlay = deps.overlay();
    if (!request || !overlay) {
      deps.log(`[dialog] ${request ? 'no overlay to ask in' : 'the question exceeds the overlay dialog bounds'}; asking with the OS message box`);
      return native(question);
    }
    let answer: OverlayAnswer;
    try {
      answer = await overlay.request(request, deps.focused());
    } catch (err) {
      if (deps.closing()) {
        deps.log('[dialog] the window closed for a quit; the question is dismissed');
        return undefined;
      }
      deps.log(`[dialog] the overlay could not ask (${errorText(err)}); asking with the OS message box`);
      return native(question);
    }
    return answer.kind === 'message' && answer.action !== null ? answer.action : undefined;
  };
}
