import { dialog, type BrowserWindow, type MessageBoxOptions, type WebContents } from 'electron';
import type { MessageCheckbox, MessageSeverity, OverlayAnswer, OverlayRequest } from '../preload/overlay-channels';
import { parseMessageRequest, type InputBrowseHandler } from './overlay';

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

/** Asks the user; resolves the index of the chosen action, or undefined for Cancel or once signal aborts, which withdraws the question. */
export type AskMessage = (question: MessageQuestion, signal?: AbortSignal) => Promise<number | undefined>;

export interface CheckedQuestion extends MessageQuestion {
  readonly checkbox: MessageCheckbox;
}

// action: as AskMessage resolves it; checked: the box as the user left it, its initial state when nobody answered
export interface CheckedAnswer {
  readonly action: number | undefined;
  readonly checked: boolean;
}

/** Asks a question with a checkbox ("Don't ask again", "Apply to all remaining conflicts"); a caller applies checked only with an action. */
export type AskCheckedMessage = (question: CheckedQuestion, signal?: AbortSignal) => Promise<CheckedAnswer>;

export interface MessageOverlay {
  request(request: OverlayRequest, returnFocus: WebContents | undefined, shown?: () => void, browse?: InputBrowseHandler, signal?: AbortSignal): Promise<OverlayAnswer>;
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
  const ask = createAsker(deps);
  return async (question, signal) => (await ask(question, signal)).action;
}

/** createMessageAsker's dialog with a checkbox above its buttons, or the OS message box's checkbox when the overlay cannot ask. */
export function createCheckedMessageAsker(deps: MessageAskerDeps): AskCheckedMessage {
  const ask = createAsker(deps);
  return async (question, signal) => {
    const answer = await ask(question, signal);
    return { action: answer.action, checked: answer.checked ?? question.checkbox.checked };
  };
}

type AnyQuestion = MessageQuestion & { readonly checkbox?: MessageCheckbox };
// checked: undefined when the question has no checkbox or nobody answered it
type AnyAnswer = { readonly action: number | undefined; readonly checked: boolean | undefined };
const UNANSWERED: AnyAnswer = { action: undefined, checked: undefined };

function createAsker(deps: MessageAskerDeps): (question: AnyQuestion, signal?: AbortSignal) => Promise<AnyAnswer> {
  const native = async (question: AnyQuestion, signal: AbortSignal | undefined): Promise<AnyAnswer> => {
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
      ...(question.checkbox ? { checkboxLabel: question.checkbox.label, checkboxChecked: question.checkbox.checked } : {}),
    };
    const parent = deps.window();
    const unclosable = (): void => deps.log('[dialog] a withdrawn question shows in the OS message box, which cannot be closed; its answer is ignored');
    signal?.addEventListener('abort', unclosable, { once: true });
    try {
      const { response, checkboxChecked } = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
      if (signal?.aborted) return UNANSWERED;
      return { action: response < question.actions.length ? response : undefined, checked: question.checkbox ? checkboxChecked : undefined };
    } finally {
      signal?.removeEventListener('abort', unclosable);
    }
  };

  return async (question, signal) => {
    if (signal?.aborted) return UNANSWERED;
    if (deps.closing()) {
      deps.log('[dialog] the window is closing for a quit; the question is dismissed');
      return UNANSWERED;
    }
    const request = parseMessageRequest({ kind: 'message', ...question });
    const overlay = deps.overlay();
    if (!request || !overlay) {
      deps.log(`[dialog] ${request ? 'no overlay to ask in' : 'the question exceeds the overlay dialog bounds'}; asking with the OS message box`);
      return native(question, signal);
    }
    let answer: OverlayAnswer;
    try {
      answer = await overlay.request(request, deps.focused(), undefined, undefined, signal);
    } catch (err) {
      if (deps.closing()) {
        deps.log('[dialog] the window closed for a quit; the question is dismissed');
        return UNANSWERED;
      }
      if (signal?.aborted) return UNANSWERED;
      deps.log(`[dialog] the overlay could not ask (${errorText(err)}); asking with the OS message box`);
      return native(question, signal);
    }
    if (answer.kind !== 'message' || signal?.aborted) return UNANSWERED;
    return { action: answer.action ?? undefined, checked: answer.checked };
  };
}
