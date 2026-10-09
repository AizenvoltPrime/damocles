import { expect, type ElectronApplication } from '@playwright/test';
import type * as Koffi from 'koffi';

type Modifier = 'control' | 'shift' | 'alt' | 'meta';

// Virtual key codes from Carbon's Events.h (kVK_*); the window server derives each event's characters from the layout.
const KEYS: Record<string, { code: number; functionKey?: boolean }> = {
  A: { code: 0x00 },
  B: { code: 0x0b },
  C: { code: 0x08 },
  F: { code: 0x03 },
  H: { code: 0x04 },
  K: { code: 0x28 },
  N: { code: 0x2d },
  P: { code: 0x23 },
  R: { code: 0x0f },
  S: { code: 0x01 },
  T: { code: 0x11 },
  U: { code: 0x20 },
  V: { code: 0x09 },
  W: { code: 0x0d },
  '5': { code: 0x17 },
  ',': { code: 0x2b },
  '\\': { code: 0x2a },
  Left: { code: 0x7b, functionKey: true },
  Right: { code: 0x7c, functionKey: true },
  Tab: { code: 0x30 },
  Escape: { code: 0x35 },
  F4: { code: 0x76, functionKey: true },
  F6: { code: 0x61, functionKey: true },
  F10: { code: 0x6d, functionKey: true },
  F12: { code: 0x6f, functionKey: true },
  PageUp: { code: 0x74, functionKey: true },
  PageDown: { code: 0x79, functionKey: true },
};

// Pressed in this order and released in reverse, as Chromium's ui_controls_mac.mm sequences them. The flags are
// CGEventFlags, whose modifier bits equal NSEventModifierFlags'.
const MODIFIERS: ReadonlyArray<{ modifier: Modifier; flag: number; code: number }> = [
  { modifier: 'control', flag: 1 << 18, code: 0x3b },
  { modifier: 'shift', flag: 1 << 17, code: 0x38 },
  { modifier: 'alt', flag: 1 << 19, code: 0x3a },
  { modifier: 'meta', flag: 1 << 20, code: 0x37 },
];
// kCGEventFlagMaskSecondaryFn, which a keyboard sets on the arrow, function and page keys.
const FUNCTION_FLAG = 1 << 23;

interface MacKeyEvent {
  keyCode: number;
  down: boolean;
  flags: number;
}

/**
 * The key events a keyboard produces for `key` with `modifiers` held: each modifier's own press carries its flag, as
 * Chromium reads the modifier state from those events.
 */
export function macKeySequence(key: string, modifiers: readonly Modifier[]): MacKeyEvent[] {
  const spec = KEYS[key];
  if (!spec) throw new Error(`no macOS key code for ${key}; add it to KEYS`);
  const held = MODIFIERS.filter((m) => modifiers.includes(m.modifier));
  const flags = held.reduce((sum, m) => sum | m.flag, 0) | (spec.functionKey ? FUNCTION_FLAG : 0);

  const events: MacKeyEvent[] = [];
  let down = 0;
  for (const m of held) {
    down |= m.flag;
    events.push({ keyCode: m.code, down: true, flags: down });
  }
  events.push({ keyCode: spec.code, down: true, flags }, { keyCode: spec.code, down: false, flags });
  for (const m of [...held].reverse()) {
    down &= ~m.flag;
    events.push({ keyCode: m.code, down: false, flags: down });
  }
  return events;
}

/**
 * Presses `key` in the page whose URL contains `urlPart` by posting the keyboard's events to the app's process through
 * the window server (CGEventPostToPid), where they take the path a physical key takes. `webContents.sendInputEvent`
 * builds its events without an NSEvent, which Electron's macOS path needs for the application menu, and an NSEvent
 * posted with -[NSApplication postEvent:atStart:] skips the window server: with a non-editable element focused, a menu
 * key equivalent with Shift held never fires from it.
 */
export async function postMacKeyPress(app: ElectronApplication, urlPart: string, key: string, modifiers: readonly Modifier[]): Promise<void> {
  const events = macKeySequence(key, modifiers);
  // AppKit delivers a key event to the key window only, and macOS activates an app asynchronously.
  await expect.poll(() => app.evaluate(({ BrowserWindow, webContents }, part) => {
    const target = webContents.getAllWebContents().find((c) => c.getURL().includes(part));
    if (!target) throw new Error(`no page matching ${part}`);
    const win = BrowserWindow.fromWebContents(target);
    if (!win) throw new Error(`no window owns ${part}`);
    win.focus();
    target.focus();
    return win.isFocused();
  }, urlPart)).toBe(true);

  await app.evaluate(({ app: electronApp }, sequence) => {
    type Ptr = unknown;
    type Keyboard = { post: (e: MacKeyEvent) => void };
    const state = globalThis as { __e2eKeyboard?: Keyboard };
    state.__e2eKeyboard ??= ((): Keyboard => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const koffi = createRequire(`${electronApp.getAppPath()}/`)('koffi') as typeof Koffi;
      const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
      const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
      const createKeyboardEvent = cg.func('CGEventCreateKeyboardEvent', 'void*', ['void*', 'uint16', 'bool']);
      const setFlags = cg.func('CGEventSetFlags', 'void', ['void*', 'uint64']);
      const postToPid = cg.func('CGEventPostToPid', 'void', ['int', 'void*']);
      const release = cf.func('CFRelease', 'void', ['void*']);
      return {
        post: (e) => {
          const event = createKeyboardEvent(null, e.keyCode, e.down) as Ptr;
          if (!event) throw new Error('CGEventCreateKeyboardEvent returned no event');
          setFlags(event, e.flags);
          postToPid(process.pid, event);
          release(event);
        },
      };
    })();
    for (const e of sequence) state.__e2eKeyboard.post(e);
  }, events);
}
