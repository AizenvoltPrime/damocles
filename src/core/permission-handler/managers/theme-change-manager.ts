// The theme card of ThemeSet and ThemeSchedule: Apply, Discard, or Change with a note, plus Show in window. A content decision,
// not a tool permission: no mode, YOLO, rule or hook answers it. It stays open across answers until its tool closes it, so an
// Apply that finds the theme changed can turn it Outdated. Its `state` is core's alone, and every answer a view sends is
// answered: with `applying` or the card's close when taken, else with the card as it stands.
import { randomUUID } from 'node:crypto';
import { applyThemeChangeUpdate, type ThemeCardUpdate, type ThemeChangeAction, type ThemeChangeChoice, type ThemeChangeItem, type ThemeChangeState, type ThemeContrastIssue, type ThemeShowNote } from '../../../shared/themes/agent';
import type { ThemeFile } from '../../../shared/themes/schema';
import type { CssDroppedPart } from '../../../shared/themes/css-types';
import type { LookKind } from '../../../shared/themes/tokens';
import { registerAbortablePrompt, type PermissionState } from '../state';
import type { PendingThemeChange, PostMessageFn, ThemeChangeAnswer } from '../types';

/** What the card shows. */
export interface ThemeChangeAsk {
  readonly toolUseId: string;
  readonly action: ThemeChangeAction;
  readonly theme?: ThemeFile;
  readonly themeName?: string;
  readonly looks: readonly LookKind[];
  readonly isNew: boolean;
  readonly changes: readonly ThemeChangeItem[];
  readonly contrast: readonly ThemeContrastIssue[];
  // what the sanitizer removed from the proposal's custom CSS
  readonly droppedCss?: readonly CssDroppedPart[];
  // how many more parts it removed than droppedCss lists
  readonly droppedCssMore?: number;
  readonly state: Exclude<ThemeChangeState, 'applying'>;
  readonly planMode: boolean;
  readonly canShowInWindow: boolean;
  // a chat on a remote host: the device the change lands on and its computer's name; another device's card shows no image
  // and offers Discard only
  readonly device?: ThemeCardDevice;
  // with `device`: the stage that device's core made, which only its own views are told
  readonly stageId?: string;
}

export interface ThemeCardDevice {
  readonly clientId: string;
  readonly computer?: string;
}

export interface ThemeChangeUpdate {
  readonly state?: Exclude<ThemeChangeState, 'applying'>;
  readonly showInWindow?: boolean;
  readonly showNote?: ThemeShowNote;
}

/** An open card, held by its tool until the tool closes it. */
export interface ThemeChangePrompt {
  readonly promptId: string;
  // the user's next answer; undefined once the card closed (the signal aborted, the panel ended). A card left `applying`
  // waits again.
  answer(): Promise<ThemeChangeAnswer | undefined>;
  update(update: ThemeChangeUpdate): void;
  close(): void;
}

export class ThemeChangeManager {
  private readonly state: PermissionState;
  private readonly getPostMessage: () => PostMessageFn | null;
  private readonly actor: () => string | undefined;

  constructor(state: PermissionState, getPostMessage: () => PostMessageFn | null, actor: () => string | undefined = () => undefined) {
    this.state = state;
    this.getPostMessage = getPostMessage;
    this.actor = actor;
  }

  /**
   * Raises the card until its tool closes it or `signal` aborts. `showInWindow` runs the card's toggle; the card shows the new
   * state only once its tool calls `update`. It registers with no webview attached too: `repostPendingPrompts` shows it.
   */
  open(ask: ThemeChangeAsk, signal: AbortSignal, showInWindow: (on: boolean) => void): ThemeChangePrompt {
    const promptId = `themechange-${randomUUID()}`;
    let waiter: ((answer: ThemeChangeAnswer | undefined) => void) | undefined;
    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      signal.removeEventListener('abort', close);
      if (this.state.removePendingThemeChange(promptId)) this.getPostMessage()?.({ type: 'themeChangeClosed', promptId });
      const waiting = waiter;
      waiter = undefined;
      waiting?.(undefined);
    };
    const request: PendingThemeChange['request'] = {
      type: 'requestThemeChange',
      promptId,
      toolUseId: ask.toolUseId,
      action: ask.action,
      ...(ask.theme ? { theme: ask.theme } : {}),
      ...(ask.themeName !== undefined ? { themeName: ask.themeName } : {}),
      looks: [...ask.looks],
      isNew: ask.isNew,
      changes: [...ask.changes],
      contrast: [...ask.contrast],
      ...(ask.droppedCss && ask.droppedCss.length > 0 ? { droppedCss: [...ask.droppedCss] } : {}),
      ...(ask.droppedCssMore !== undefined && ask.droppedCssMore > 0 ? { droppedCssMore: ask.droppedCssMore } : {}),
      state: ask.state,
      planMode: ask.planMode,
      canShowInWindow: ask.canShowInWindow,
      showInWindow: false,
      owner: this.state.promptOwner(null),
      ...(ask.device && ask.stageId !== undefined ? { stageId: ask.stageId } : {}),
    };
    const device = ask.device;
    // The card's new state, stored for a returning webview and sent to every view; another device's card has no Show in window.
    const change = (update: ThemeCardUpdate): void => {
      const pending = this.state.pendingThemeChanges.get(promptId);
      if (!pending) return;
      this.state.updatePendingThemeChange(promptId, applyThemeChangeUpdate(pending.request, update));
      const whole = { type: 'themeChangeUpdated' as const, promptId, ...update };
      if (!device || !this.state.postToDevices) {
        this.getPostMessage()?.(whole);
        return;
      }
      const stateOnly = update.state !== undefined ? { type: 'themeChangeUpdated' as const, promptId, state: update.state } : undefined;
      this.state.postToDevices((clientId) => (clientId === device.clientId ? whole : stateOnly));
    };
    registerAbortablePrompt({
      signal,
      toolUseId: promptId,
      register: () => {
        this.state.addPendingThemeChange(promptId, {
          request,
          deliver: (answer) => {
            const waiting = waiter;
            if (!waiting) return false;
            waiter = undefined;
            if (answer.choice === 'apply') change({ state: 'applying' });
            waiting(answer);
            return true;
          },
          showInWindow,
          close,
          ...(device ? { device: device.clientId } : {}),
        });
        if (device) this.state.devicePrompts.set(promptId, (clientId) => this.requestFor(promptId, device, clientId));
        this.state.postPrompt(promptId, request, this.getPostMessage());
      },
      onAborted: close,
    });
    return {
      promptId,
      answer: () => {
        if (closed) return Promise.resolve(undefined);
        if (this.state.pendingThemeChanges.get(promptId)?.request.state === 'applying') change({ state: 'waiting' });
        return new Promise((resolve) => { waiter = resolve; });
      },
      update: (update) => {
        if (!closed) change(update);
      },
      close,
    };
  }

  /**
   * The user's answer from any view. Not taken for `change` with a blank note, for anything but `discard` on an outdated card
   * or from a device the change does not land on, and while its tool is not waiting for an answer (an Apply under way): the
   * views are then sent the card as it stands. One for a card no longer open is answered with its close.
   */
  resolveThemeChange(promptId: string, choice: ThemeChangeChoice, note: string | undefined): void {
    const pending = this.state.pendingThemeChanges.get(promptId);
    if (!pending) {
      this.getPostMessage()?.({ type: 'themeChangeClosed', promptId });
      return;
    }
    const trimmed = note?.trim() ?? '';
    const refused = (choice === 'change' && trimmed === '')
      || (choice !== 'discard' && (pending.request.state === 'outdated' || !this.onItsDevice(pending)));
    if (refused || !pending.deliver(choice === 'change' ? { choice, note: trimmed } : { choice })) {
      this.state.postPrompt(promptId, pending.request, this.getPostMessage());
    }
  }

  /** The card's Show in window toggle; its tool answers with the card's new state. */
  setShowInWindow(promptId: string, on: boolean): void {
    const pending = this.state.pendingThemeChanges.get(promptId);
    if (!pending || !pending.request.canShowInWindow || pending.request.state !== 'waiting' || !this.onItsDevice(pending)) return;
    pending.showInWindow(on);
  }

  /** Whether the answer comes from the device the card's change lands on; a card with no device has none to check. */
  private onItsDevice(pending: PendingThemeChange): boolean {
    return pending.device === undefined || this.actor() === pending.device;
  }

  /** The card as `clientId`'s views show it: whole on the device it changes, without the image and Discard only elsewhere. */
  private requestFor(promptId: string, device: ThemeCardDevice, clientId: string | undefined): PendingThemeChange['request'] | undefined {
    const request = this.state.pendingThemeChanges.get(promptId)?.request;
    if (!request || clientId === device.clientId) return request;
    const { theme: _theme, stageId: _stageId, ...rest } = request;
    return { ...rest, canShowInWindow: false, showInWindow: false, otherDevice: device.computer !== undefined ? { computer: device.computer } : {} };
  }
}
