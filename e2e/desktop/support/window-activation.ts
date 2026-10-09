import { createRequire } from 'node:module';
import type { ElectronApplication } from '@playwright/test';
import type * as Koffi from 'koffi';
import { SHELL_URL } from './shell';

// X.h: the ClientMessage event type, and the masks a request to the window manager is sent with.
const CLIENT_MESSAGE = 33;
const SUBSTRUCTURE_NOTIFY_MASK = 1 << 19;
const SUBSTRUCTURE_REDIRECT_MASK = 1 << 20;
// EWMH _NET_ACTIVE_WINDOW source indication: a pager or taskbar.
const SOURCE_PAGER = 2;
// XEvent is a union of 24 longs; XClientMessageEvent fills 12 of them.
const XEVENT_PADDING_LONGS = 12;
// WinUser.h: ShowWindow's command that restores a minimized window and activates it.
const SW_RESTORE = 9;

type Activate = (handle: bigint) => void;

let bound: Activate | undefined;
let boundRestore: Activate | undefined;

function bindWindows(koffi: typeof Koffi): Activate {
  const switchToThisWindow = koffi.load('user32.dll').func('void __stdcall SwitchToThisWindow(intptr_t hwnd, int altTab)');
  return (handle) => switchToThisWindow(handle, 1);
}

function bindX11(koffi: typeof Koffi): Activate {
  const lib = koffi.load('libX11.so.6');
  const openDisplay = lib.func('void *XOpenDisplay(const char *name)');
  const closeDisplay = lib.func('int XCloseDisplay(void *display)');
  const rootWindow = lib.func('unsigned long XDefaultRootWindow(void *display)');
  const internAtom = lib.func('unsigned long XInternAtom(void *display, const char *name, int onlyIfExists)');
  const event = koffi.struct('E2EClientMessage', {
    type: 'int',
    serial: 'unsigned long',
    send_event: 'int',
    display: 'void *',
    window: 'unsigned long',
    message_type: 'unsigned long',
    format: 'int',
    l: koffi.array('long', 5),
    padding: koffi.array('long', XEVENT_PADDING_LONGS),
  });
  const sendEvent = lib.func('XSendEvent', 'int', ['void *', 'unsigned long', 'int', 'long', koffi.pointer(event)]);
  const flush = lib.func('int XFlush(void *display)');
  return (handle) => {
    const display = openDisplay(null);
    if (!display) throw new Error(`cannot open the X display ${process.env.DISPLAY ?? '(DISPLAY unset)'}`);
    try {
      sendEvent(display, rootWindow(display), 0, SUBSTRUCTURE_REDIRECT_MASK | SUBSTRUCTURE_NOTIFY_MASK, {
        type: CLIENT_MESSAGE,
        serial: 0,
        send_event: 1,
        display,
        window: handle,
        message_type: internAtom(display, '_NET_ACTIVE_WINDOW', 0),
        format: 32,
        l: [SOURCE_PAGER, 0, 0, 0, 0],
        padding: new Array<number>(XEVENT_PADDING_LONGS).fill(0),
      });
      flush(display);
    } finally {
      closeDisplay(display);
    }
  };
}

function bindWindowsRestore(koffi: typeof Koffi): Activate {
  const user32 = koffi.load('user32.dll');
  const showWindow = user32.func('int __stdcall ShowWindow(intptr_t hwnd, int cmd)');
  const setForegroundWindow = user32.func('int __stdcall SetForegroundWindow(intptr_t hwnd)');
  return (handle) => {
    showWindow(handle, SW_RESTORE);
    setForegroundWindow(handle);
  };
}

const loadKoffi = (): typeof Koffi => createRequire(__filename)('koffi') as typeof Koffi;

async function mainWindowHandle(app: ElectronApplication): Promise<bigint> {
  const handle = await app.evaluate(({ BrowserWindow }, url) => {
    const native = BrowserWindow.getAllWindows().find((window) => window.webContents.getURL() === url)!.getNativeWindowHandle();
    return (native.length >= 8 ? native.readBigUInt64LE() : BigInt(native.readUInt32LE())).toString();
  }, SHELL_URL);
  return BigInt(handle);
}

/**
 * Activates the main window from outside the app, as the OS shell does: on Windows the switch Alt+Tab and a taskbar click
 * make, on X11 a taskbar's request to the window manager. Undefined on macOS.
 */
export function outsideActivation(): ((app: ElectronApplication) => Promise<void>) | undefined {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  return async (app) => {
    bound ??= process.platform === 'win32' ? bindWindows(loadKoffi()) : bindX11(loadKoffi());
    bound(await mainWindowHandle(app));
  };
}

/**
 * Restores and activates the minimized main window from another process, as an app calling ShowWindow(SW_RESTORE) and
 * then SetForegroundWindow does. Windows only; undefined elsewhere.
 */
export function outsideRestore(): ((app: ElectronApplication) => Promise<void>) | undefined {
  if (process.platform !== 'win32') return undefined;
  return async (app) => {
    boundRestore ??= bindWindowsRestore(loadKoffi());
    boundRestore(await mainWindowHandle(app));
  };
}
