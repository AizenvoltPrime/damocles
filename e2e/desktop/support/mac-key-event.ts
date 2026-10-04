import { expect, type ElectronApplication } from '@playwright/test';
import type * as Koffi from 'koffi';

type Modifier = 'control' | 'shift' | 'alt' | 'meta';

// Virtual key codes from Carbon's Events.h (kVK_*) and the characters AppKit reports for each key on a US layout.
const KEYS: Record<string, { code: number; chars: string; shifted?: string; functionKey?: boolean }> = {
  A: { code: 0x00, chars: 'a' },
  B: { code: 0x0b, chars: 'b' },
  C: { code: 0x08, chars: 'c' },
  K: { code: 0x28, chars: 'k' },
  N: { code: 0x2d, chars: 'n' },
  T: { code: 0x11, chars: 't' },
  U: { code: 0x20, chars: 'u' },
  V: { code: 0x09, chars: 'v' },
  W: { code: 0x0d, chars: 'w' },
  ',': { code: 0x2b, chars: ',', shifted: '<' },
  Tab: { code: 0x30, chars: '\t', shifted: '\x19' },
  Escape: { code: 0x35, chars: '\x1b' },
  F6: { code: 0x61, chars: '\uf709', functionKey: true },
  F12: { code: 0x6f, chars: '\uf70f', functionKey: true },
  PageUp: { code: 0x74, chars: '\uf72c', functionKey: true },
  PageDown: { code: 0x79, chars: '\uf72d', functionKey: true },
};

// Pressed in this order and released in reverse, as Chromium's ui_controls_mac.mm sequences them.
const MODIFIERS: ReadonlyArray<{ modifier: Modifier; flag: number; code: number }> = [
  { modifier: 'control', flag: 1 << 18, code: 0x3b },
  { modifier: 'shift', flag: 1 << 17, code: 0x38 },
  { modifier: 'alt', flag: 1 << 19, code: 0x3a },
  { modifier: 'meta', flag: 1 << 20, code: 0x37 },
];
const FUNCTION_FLAG = 1 << 23;
// NSEventType values.
const KEY_DOWN = 10;
const KEY_UP = 11;
const FLAGS_CHANGED = 12;

interface MacKeyEvent {
  type: number;
  keyCode: number;
  flags: number;
  characters: string;
  charactersIgnoringModifiers: string;
}

/** The NSEvents a keyboard produces for `key` with `modifiers` held; the character rules follow cocoa_test_event_utils.mm. */
export function macKeySequence(key: string, modifiers: readonly Modifier[]): MacKeyEvent[] {
  const spec = KEYS[key];
  if (!spec) throw new Error(`no macOS key code for ${key}; add it to KEYS`);
  if (modifiers.includes('alt') && !spec.functionKey) throw new Error('Option changes the characters by layout; not modeled');
  const held = MODIFIERS.filter((m) => modifiers.includes(m.modifier));
  const flags = held.reduce((sum, m) => sum | m.flag, 0);
  const ignoring = modifiers.includes('shift') ? (spec.shifted ?? spec.chars.toUpperCase()) : spec.chars;
  const characters = modifiers.includes('control') ? '' : modifiers.includes('meta') ? spec.chars : ignoring;
  const press = { keyCode: spec.code, flags: flags | (spec.functionKey ? FUNCTION_FLAG : 0), characters, charactersIgnoringModifiers: ignoring };

  const events: MacKeyEvent[] = [];
  let down = 0;
  for (const m of held) {
    down |= m.flag;
    events.push({ type: FLAGS_CHANGED, keyCode: m.code, flags: down, characters: '', charactersIgnoringModifiers: '' });
  }
  events.push({ type: KEY_DOWN, ...press }, { type: KEY_UP, ...press });
  for (const m of [...held].reverse()) {
    down &= ~m.flag;
    events.push({ type: FLAGS_CHANGED, keyCode: m.code, flags: down, characters: '', charactersIgnoringModifiers: '' });
  }
  return events;
}

/**
 * Presses `key` in the page whose URL contains `urlPart` by posting the keyboard's NSEvents to AppKit's event queue, as
 * Chromium's own interactive UI tests do. `webContents.sendInputEvent` builds its events without an NSEvent, and
 * Electron's macOS path hands only an NSEvent to the application menu, so a key sent that way never reaches a menu
 * accelerator or an Edit menu role.
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
    type AppKit = { post: (e: MacKeyEvent) => void };
    const state = globalThis as { __e2eAppKit?: AppKit };
    state.__e2eAppKit ??= ((): AppKit => {
      const { createRequire } = process.getBuiltinModule('node:module');
      const koffi = createRequire(`${electronApp.getAppPath()}/`)('koffi') as typeof Koffi;
      const objc = koffi.load('/usr/lib/libobjc.A.dylib');
      const getClass = objc.func('objc_getClass', 'void*', ['str']);
      const sel = objc.func('sel_registerName', 'void*', ['str']);
      // objc_msgSend is called through one exact prototype per selector shape, as the arm64 ABI requires.
      const sendId = objc.func('objc_msgSend', 'void*', ['void*', 'void*']);
      const sendInt = objc.func('objc_msgSend', 'int64', ['void*', 'void*']);
      const sendDouble = objc.func('objc_msgSend', 'double', ['void*', 'void*']);
      const sendStr = objc.func('objc_msgSend', 'void*', ['void*', 'void*', 'str']);
      const sendPost = objc.func('objc_msgSend', 'void', ['void*', 'void*', 'void*', 'bool']);
      const point = koffi.struct({ x: 'double', y: 'double' });
      const sendKeyEvent = objc.func('objc_msgSend', 'void*', ['void*', 'void*', 'uint64', point, 'uint64', 'double', 'int64', 'void*', 'void*', 'void*', 'bool', 'uint16']);
      const nsApp = sendId(getClass('NSApplication'), sel('sharedApplication')) as Ptr;
      const nsString = (text: string): Ptr => sendStr(getClass('NSString'), sel('stringWithUTF8String:'), text) as Ptr;
      const keyEventSel = sel('keyEventWithType:location:modifierFlags:timestamp:windowNumber:context:characters:charactersIgnoringModifiers:isARepeat:keyCode:');
      return {
        post: (e) => {
          const keyWindow = sendId(nsApp, sel('keyWindow')) as Ptr;
          if (!keyWindow) throw new Error('AppKit reports no key window');
          const uptime = sendDouble(sendId(getClass('NSProcessInfo'), sel('processInfo')), sel('systemUptime')) as number;
          const nsEvent = sendKeyEvent(
            getClass('NSEvent'), keyEventSel, e.type, { x: 0, y: 0 }, e.flags, uptime, sendInt(keyWindow, sel('windowNumber')),
            null, nsString(e.characters), nsString(e.charactersIgnoringModifiers), false, e.keyCode,
          ) as Ptr;
          sendPost(nsApp, sel('postEvent:atStart:'), nsEvent, false);
        },
      };
    })();
    for (const e of sequence) state.__e2eAppKit.post(e);
  }, events);
}
