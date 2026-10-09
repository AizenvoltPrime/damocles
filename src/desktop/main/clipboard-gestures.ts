import type { Input, MouseInputEvent, WebContents } from 'electron';
import { tidyMenu, type OverlayAnswer, type OverlayClipboardAction, type OverlayMenuItem, type OverlayRequest } from '../preload/overlay-channels';
import { tickDeadline } from './tick-deadline';

// How long a grant waits for the request it allows; counted in main's timer ticks, so a stall of main cannot expire it.
export const GESTURE_GRANT_MS = 2000;

/**
 * One permission that a user's input, as main observed it, allows: a newer grant replaces it, and taking it, clearing it or
 * the deadline ends it. Only before-input-event, before-mouse-event, an overlay pick and the application menu issue one.
 */
export class GestureGrant<T> {
  private held: { readonly value: T; readonly cancel: () => void } | undefined;

  grant(value: T): void {
    this.clear();
    const held = {
      value,
      cancel: tickDeadline(GESTURE_GRANT_MS, () => {
        if (this.held === held) this.held = undefined;
      }),
    };
    this.held = held;
  }

  take(): T | undefined {
    const value = this.held?.value;
    this.clear();
    return value;
  }

  clear(): void {
    this.held?.cancel();
    this.held = undefined;
  }
}

type KeyInput = Pick<Input, 'type' | 'code' | 'shift' | 'control' | 'alt' | 'meta' | 'isComposing'>;

/** The context menu key, or Shift+F10, pressed in a page. */
export function isContextMenuKey(input: KeyInput): boolean {
  if (input.type !== 'keyDown' || input.isComposing) return false;
  return input.code === 'ContextMenu' || (input.code === 'F10' && input.shift && !input.control && !input.alt && !input.meta);
}

/** A right button press in a page, and on macOS a Control+click, which Blink takes as a context click too. */
export function isContextMenuMouse(mouse: Pick<MouseInputEvent, 'type' | 'button' | 'modifiers'>, platform: NodeJS.Platform): boolean {
  if (mouse.type !== 'mouseDown') return false;
  if (mouse.button === 'right') return true;
  return platform === 'darwin' && mouse.button === 'left' && (mouse.modifiers ?? []).some((modifier) => modifier === 'control' || modifier === 'ctrl');
}

/** A key that clicks a focused button: Enter as it goes down, Space as it comes up, which is when Blink dispatches the click. */
export function isActivationKey(input: KeyInput): boolean {
  if (input.isComposing || input.control || input.alt || input.meta) return false;
  if (input.type === 'keyDown') return input.code === 'Enter' || input.code === 'NumpadEnter';
  return input.type === 'keyUp' && input.code === 'Space';
}

/** A primary button release, which completes a click; on macOS a Control+click is a context click instead. */
export function isPrimaryClick(mouse: Pick<MouseInputEvent, 'type' | 'button' | 'modifiers'>, platform: NodeJS.Platform): boolean {
  return mouse.type === 'mouseUp' && mouse.button === 'left' && !isContextMenuMouse({ ...mouse, type: 'mouseDown' }, platform);
}

const isClipboardItem = (item: OverlayMenuItem): item is Extract<OverlayMenuItem, { kind: 'item' }> & { clipboard: OverlayClipboardAction } =>
  item.kind === 'item' && item.clipboard !== undefined;

export interface ShellMenuDeps {
  readonly ask: (request: OverlayRequest) => Promise<OverlayAnswer>;
  // takes the grant a context-menu click or key in the shell page issued
  readonly takeMenuGrant: () => boolean;
  // main's own localized Cut, Copy and Paste
  readonly label: (action: OverlayClipboardAction) => string;
  // the shell page, which asked and gets focus back before the answer resolves
  readonly page: Pick<WebContents, 'cut' | 'copy' | 'paste' | 'isFocused' | 'isDestroyed'>;
  readonly allowTerminalPaste: () => void;
  readonly log: (line: string) => void;
}

/**
 * Shows a menu the shell asked for. Its clipboard items stay only when a context-menu click or key main observed opened it,
 * with main's label and look, so page script can neither disguise one nor show one under the user's next key. A pick of one
 * is main's to run: cut, copy or paste on the focused shell page, or one allowed paste into its active terminal.
 */
export async function askShellMenu(request: OverlayRequest, deps: ShellMenuDeps): Promise<OverlayAnswer> {
  if (request.kind !== 'menu') return deps.ask(request);
  const granted = deps.takeMenuGrant();
  if (!request.items.some(isClipboardItem)) return deps.ask(request);
  if (!granted) deps.log('[overlay] dropping the clipboard items of a shell menu that no context-menu click or key opened');
  const items = granted
    ? request.items.map((item): OverlayMenuItem => {
      if (!isClipboardItem(item)) return item;
      const { id, clipboard, shortcut, disabled } = item;
      return {
        kind: 'item',
        id,
        clipboard,
        label: deps.label(clipboard),
        ...(clipboard === 'terminalPaste' ? { icon: 'clipboard-paste' } : {}),
        ...(shortcut !== undefined ? { shortcut } : {}),
        ...(disabled !== undefined ? { disabled } : {}),
      };
    })
    : tidyMenu(request.items.filter((item) => !isClipboardItem(item)));
  if (!items.some((item) => item.kind === 'item')) return { kind: 'dismissed' };
  const shown: OverlayRequest = { ...request, items };
  const answer = await deps.ask(shown);
  const picked = answer.kind === 'menu' ? items.find((item) => item.kind === 'item' && item.id === answer.itemId) : undefined;
  if (!picked || !isClipboardItem(picked)) return answer;
  if (picked.clipboard === 'terminalPaste') deps.allowTerminalPaste();
  else if (!deps.page.isDestroyed() && deps.page.isFocused()) deps.page[picked.clipboard]();
  else deps.log(`[overlay] not running ${picked.clipboard}: the shell page lost keyboard focus`);
  return answer;
}
