import { isTerminalPasteChord, MAX_TERMINAL_INPUT_CHARS } from '../../preload/terminal-channels';
import type { ShellPlatform } from '../../preload/shell-channels';

export interface KeyChord {
  readonly ctrl: boolean;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly meta: boolean;
  // a KeyboardEvent.code, which Electron's accelerators match by key position as well
  readonly code: string;
}

// Accelerator key names that are not a letter, a digit or an F key, as KeyboardEvent.code.
const CODES: Readonly<Record<string, string>> = {
  '`': 'Backquote', ',': 'Comma', '.': 'Period', '/': 'Slash', '\\': 'Backslash', ';': 'Semicolon', "'": 'Quote',
  '[': 'BracketLeft', ']': 'BracketRight', '-': 'Minus', '=': 'Equal', Plus: 'Equal',
  Tab: 'Tab', Space: 'Space', Enter: 'Enter', Return: 'Enter', Esc: 'Escape', Escape: 'Escape',
  Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight',
  PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Delete: 'Delete', Backspace: 'Backspace',
};

/** An Electron accelerator ("CmdOrCtrl+Shift+P", "Ctrl+`", "F6") as the chord it fires on this platform. */
export function parseAccelerator(accelerator: string, mac: boolean): KeyChord | undefined {
  // "Ctrl++" ends with the plus key itself.
  const parts = accelerator.endsWith('++') ? [...accelerator.slice(0, -2).split('+'), 'Plus'] : accelerator.split('+');
  const key = parts.pop();
  if (key === undefined || key === '') return undefined;
  const chord = { ctrl: false, shift: false, alt: false, meta: false };
  for (const modifier of parts) {
    const name = modifier.toLowerCase();
    if (name === 'cmdorctrl' || name === 'commandorcontrol') chord[mac ? 'meta' : 'ctrl'] = true;
    else if (name === 'ctrl' || name === 'control') chord.ctrl = true;
    else if (name === 'cmd' || name === 'command' || name === 'super' || name === 'meta') chord.meta = true;
    else if (name === 'shift') chord.shift = true;
    else if (name === 'alt' || name === 'option' || name === 'altgr') chord.alt = true;
    else return undefined;
  }
  const code = /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : /^\d$/.test(key) ? `Digit${key}` : /^F\d{1,2}$/i.test(key) ? key.toUpperCase() : CODES[key];
  return code === undefined ? undefined : { ...chord, code };
}

export function matchesChord(event: KeyboardEvent, chord: KeyChord): boolean {
  return event.code === chord.code && event.ctrlKey === chord.ctrl && event.shiftKey === chord.shift && event.altKey === chord.alt && event.metaKey === chord.meta;
}

// Each send stays under main's bound and never splits a surrogate pair.
export function inputChunks(data: string, size = MAX_TERMINAL_INPUT_CHARS): string[] {
  const chunks: string[] = [];
  let at = 0;
  while (at < data.length) {
    let end = Math.min(at + size, data.length);
    const last = data.charCodeAt(end - 1);
    if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(data.slice(at, end));
    at = end;
  }
  return chunks;
}

/** Shift+F10 or the context menu key, which open a terminal's, a list row's or the tab's menu. */
export function isMenuKey(event: KeyboardEvent): boolean {
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  return (event.code === 'F10' && event.shiftKey) || (event.code === 'ContextMenu' && !event.shiftKey);
}

/**
 * Shift+F10, which the caller opens its menu from in keydown: Blink makes a contextmenu event of it everywhere but macOS
 * (WebFrameWidgetImpl::HandleKeyEvent), and preventDefault keeps it from opening a second menu there.
 */
export function isShiftF10(event: KeyboardEvent): boolean {
  return event.code === 'F10' && isMenuKey(event);
}

/** xterm's own input, the textarea it keeps at the cursor; Edit › Paste pastes into the pty only while it has focus. */
export function isXtermInput(target: EventTarget | null): boolean {
  return target instanceof HTMLTextAreaElement && target.classList.contains('xterm-helper-textarea');
}

export type TerminalKeyAction = 'copy' | 'copyAndClear' | 'paste' | 'find' | 'menu' | 'previousCommand' | 'nextCommand' | 'pass';

/**
 * What the terminal does with a keydown instead of sending it to the pty (AD6), or undefined to let xterm send it. VS Code's
 * clipboard keys: Ctrl+Shift+C copies and Ctrl+Shift+V pastes on Windows and Linux; on Windows Ctrl+C also copies and
 * clears a selection (without one it reaches the pty as ^C) and Ctrl+V also pastes; on macOS Cmd+C and Cmd+V stay the Edit
 * menu's, so every Cmd chord passes (main answers the Edit menu's Paste through the shell's paste request). Ctrl+F
 * (Cmd+F) finds; Shift+F10 and the context menu key open the terminal's menu. Ctrl+Up and Ctrl+Down (Cmd on macOS) always
 * scroll to the previous or next command, as VS Code's skip list keeps them from the shell. A skip-list chord passes to the
 * application menu.
 */
export function terminalKeyAction(event: KeyboardEvent, platform: ShellPlatform, hasSelection: boolean, passKeys: readonly KeyChord[]): TerminalKeyAction | undefined {
  const mac = platform === 'darwin';
  const primary = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (primary && !event.altKey && event.code === 'KeyF' && !event.shiftKey) return 'find';
  if (isMenuKey(event)) return 'menu';
  if (primary && !event.altKey && !event.shiftKey && (event.code === 'ArrowUp' || event.code === 'ArrowDown')) return event.code === 'ArrowUp' ? 'previousCommand' : 'nextCommand';
  // Main allows the paste only on the same chord, seen in before-input-event.
  if (isTerminalPasteChord({ code: event.code, ctrl: event.ctrlKey, shift: event.shiftKey, alt: event.altKey, meta: event.metaKey }, platform)) return 'paste';
  if (!mac && event.ctrlKey && !event.altKey && !event.metaKey) {
    if (event.shiftKey && event.code === 'KeyC') return 'copy';
    if (platform === 'win32' && !event.shiftKey && event.code === 'KeyC' && hasSelection) return 'copyAndClear';
  }
  if (passKeys.some((chord) => matchesChord(event, chord))) return 'pass';
  if (mac && event.metaKey) return 'pass';
  return undefined;
}
