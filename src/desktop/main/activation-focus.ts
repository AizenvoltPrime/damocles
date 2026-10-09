import type { BrowserWindow } from 'electron';

/**
 * The view keyboard focus returns to when the main window activates again: Electron may focus the window's own page as the
 * window activates, and AppKit does as it restores a minimized window, so that focus counts only while the window is
 * active. Input while inactive decides instead.
 */
export class ActivationFocus<T> {
  private active = false;
  private last: T | undefined;
  private inputWhileInactive = false;
  private readonly isWindowPage: (contents: T) => boolean;

  constructor(isWindowPage: (contents: T) => boolean) {
    this.isWindowPage = isWindowPage;
  }

  focused(contents: T): void {
    if (!this.isWindowPage(contents)) this.last = contents;
    else if (this.active) this.last = undefined;
  }

  userInput(): void {
    if (!this.active) this.inputWhileInactive = true;
  }

  deactivated(): void {
    this.active = false;
    this.inputWhileInactive = false;
  }

  // The view to focus now, if any; the caller checks it is still shown.
  activated(): T | undefined {
    this.active = true;
    const target = this.inputWhileInactive ? undefined : this.last;
    this.inputWhileInactive = false;
    return target;
  }
}

/**
 * Calls `activated` once per activation: at a 'focus' the window reports itself focused and not minimized at, and not again
 * until a blur or minimize. Windows can emit 'focus' before 'restore' while isFocused() is still false; X11 sends 'focus' to
 * a window it iconifies, then 'blur', so a focus gained while minimized activates at the restore unless a blur came first.
 */
export function onWindowActivated(window: Pick<BrowserWindow, 'on' | 'isMinimized' | 'isFocused'>, activated: () => void): void {
  let active = false;
  let focusedWhileMinimized = false;
  const activate = (): void => {
    if (active || !window.isFocused() || window.isMinimized()) return;
    active = true;
    activated();
  };
  window.on('focus', () => {
    focusedWhileMinimized = window.isMinimized();
    activate();
  });
  window.on('restore', () => {
    if (!focusedWhileMinimized) return;
    focusedWhileMinimized = false;
    activate();
  });
  window.on('blur', () => {
    active = false;
    focusedWhileMinimized = false;
  });
  window.on('minimize', () => {
    active = false;
  });
}

/**
 * Calls `deactivated` when the window blurs or is minimized. AppKit resigns a miniaturizing window's key status before
 * 'minimize' but may report its 'blur' only after a restore has made it key again, focusing its own page.
 */
export function onWindowDeactivated(window: Pick<BrowserWindow, 'on'>, deactivated: () => void): void {
  window.on('blur', deactivated);
  window.on('minimize', deactivated);
}
