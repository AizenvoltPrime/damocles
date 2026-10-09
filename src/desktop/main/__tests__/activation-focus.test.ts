import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { ActivationFocus, onWindowActivated, onWindowDeactivated } from '../activation-focus';

const SHELL = 'shell';
const make = (): ActivationFocus<string> => new ActivationFocus<string>((contents) => contents === SHELL);

// What onWindowActivated reads of a BrowserWindow: its events, isMinimized() and isFocused().
function fakeWindow() {
  return Object.assign(new EventEmitter(), {
    minimized: false,
    focused: true,
    isMinimized(): boolean { return this.minimized; },
    isFocused(): boolean { return this.focused; },
  });
}
type ActivatingWindow = Pick<BrowserWindow, 'on' | 'isMinimized' | 'isFocused'>;

describe('activation focus', () => {
  it('returns to the view the user left, past the focus the activation gives the window\'s own page', () => {
    const focus = make();
    expect(focus.activated()).toBeUndefined();
    focus.focused('chat');
    focus.deactivated();
    focus.focused(SHELL);
    expect(focus.activated()).toBe('chat');
  });

  it('returns nowhere once the user moved focus to the window\'s own page', () => {
    const focus = make();
    focus.activated();
    focus.focused('chat');
    focus.focused(SHELL);
    focus.deactivated();
    focus.focused(SHELL);
    expect(focus.activated()).toBeUndefined();
  });

  it('takes the latest view main focused while the window was inactive', () => {
    const focus = make();
    focus.activated();
    focus.focused('chat');
    focus.deactivated();
    focus.focused('page');
    expect(focus.activated()).toBe('page');
  });

  it('leaves focus to a key or button press made while the window was inactive, for that activation only', () => {
    const focus = make();
    focus.activated();
    focus.focused('chat');
    focus.deactivated();
    focus.userInput();
    expect(focus.activated()).toBeUndefined();
    focus.userInput();
    focus.deactivated();
    expect(focus.activated()).toBe('chat');
  });
});

function activatingWindow() {
  const window = fakeWindow();
  const activated = vi.fn();
  onWindowActivated(window as unknown as ActivatingWindow, activated);
  return { window, activated };
}

describe('window activation', () => {
  it('activates on a focus while the window is not minimized', () => {
    const { window, activated } = activatingWindow();
    window.emit('focus');
    expect(activated).toHaveBeenCalledTimes(1);
  });

  // A focus reported while the window is still minimized.
  it('activates once the window is restored when it gained focus while minimized', () => {
    const { window, activated } = activatingWindow();
    window.minimized = true;
    window.emit('focus');
    expect(activated).not.toHaveBeenCalled();
    window.minimized = false;
    window.emit('restore');
    window.emit('restore');
    expect(activated).toHaveBeenCalledTimes(1);
  });

  // X11 sends focus and blur to a window it is iconifying; its restore then activates it through a focus of its own.
  it('drops a focus gained while minimized that a blur followed, and activates on the focus after the restore', () => {
    const { window, activated } = activatingWindow();
    window.minimized = true;
    window.emit('focus');
    window.emit('blur');
    window.minimized = false;
    window.emit('restore');
    expect(activated).not.toHaveBeenCalled();
    window.emit('focus');
    expect(activated).toHaveBeenCalledTimes(1);
  });

  it('never activates on a restore alone', () => {
    const { window, activated } = activatingWindow();
    window.emit('focus');
    window.emit('restore');
    expect(activated).toHaveBeenCalledTimes(1);
  });
});

// Each restore replays the order macOS reports it in after the chat held focus: AppKit resigns the miniaturizing window's
// key status at once, and the window becomes key again, focusing its own page, before its 'restore'.
describe('restoring a minimized window on macOS', () => {
  function minimizedWithChatFocus() {
    const focus = make();
    const window = fakeWindow();
    const returnedTo: Array<string | undefined> = [];
    onWindowActivated(window as unknown as ActivatingWindow, () => returnedTo.push(focus.activated()));
    onWindowDeactivated(window as unknown as Pick<BrowserWindow, 'on'>, () => focus.deactivated());
    window.emit('focus');
    focus.focused('chat');
    window.minimized = true;
    window.emit('minimize');
    window.emit('hide');
    return { focus, window, returnedTo };
  }

  it('returns to the chat when the blur came before the restore', () => {
    const { focus, window, returnedTo } = minimizedWithChatFocus();
    window.emit('blur');
    window.minimized = false;
    focus.focused(SHELL);
    window.emit('restore');
    window.emit('show');
    window.emit('focus');
    expect(returnedTo).toEqual([undefined, 'chat']);
  });

  // A restore that starts before AppKit has reported the minimized window's blur.
  it('returns to the chat when the blur is reported only after the restore made the window key', () => {
    const { focus, window, returnedTo } = minimizedWithChatFocus();
    window.minimized = false;
    focus.focused(SHELL);
    window.emit('restore');
    window.emit('show');
    window.emit('blur');
    window.emit('focus');
    expect(returnedTo).toEqual([undefined, 'chat']);
  });
});

// Each restore replays the order windows-latest reported after the chat held focus, for ShowWindow(SW_RESTORE) and then
// SetForegroundWindow called from another process; Chromium's activation focuses a view itself before the focused 'focus'.
describe('restoring a minimized window from outside on Windows', () => {
  function minimizedWithChatFocus() {
    const focus = make();
    const window = fakeWindow();
    const steps: string[] = [];
    onWindowActivated(window as unknown as ActivatingWindow, () => steps.push(`returned to ${String(focus.activated())}`));
    onWindowDeactivated(window as unknown as Pick<BrowserWindow, 'on'>, () => focus.deactivated());
    window.emit('focus');
    focus.focused('chat');
    window.minimized = true;
    window.emit('minimize');
    window.focused = false;
    window.emit('blur');
    steps.length = 0;
    return { focus, window, steps };
  }

  // The first focus comes while isFocused() is still false; a return to the chat then lost to the activation's own focus.
  it('returns focus to the chat once, after the activation focused the window\'s own page, past the focus reported before it', () => {
    const { focus, window, steps } = minimizedWithChatFocus();
    window.minimized = false;
    window.emit('focus');
    window.emit('restore');
    window.focused = true;
    focus.focused(SHELL);
    steps.push('the activation focused the window\'s own page');
    window.emit('focus');
    expect(steps).toEqual(['the activation focused the window\'s own page', 'returned to chat']);
  });

  it('returns focus to the chat once when the restore reports two focus events', () => {
    const { focus, window, steps } = minimizedWithChatFocus();
    window.minimized = false;
    window.emit('restore');
    window.focused = true;
    focus.focused('chat');
    window.emit('focus');
    window.emit('focus');
    expect(steps).toEqual(['returned to chat']);
  });
});
