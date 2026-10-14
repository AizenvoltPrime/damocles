import { createRequire } from 'node:module';
import type { ElectronApplication } from '@playwright/test';
import type * as Koffi from 'koffi';
import { SHELL_URL } from './shell';

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

// Far enough from the window's edge that its resize border never reaches the cursor.
const PARKING_GAP = 24;
const MAIN_WINDOW_WAIT_MS = 30_000;

const inside = (rect: Rect, point: Point): boolean => point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;

export interface Display {
  readonly bounds: Rect;
  readonly workArea: Rect;
}

/**
 * A point outside every one of `windows` on `display`: beside `main` (left, right, above, below) inside the work area, else
 * the middle of a bar the work area leaves out (the taskbar, the menu bar, the Dock), which a window filling the work area
 * leaves free; undefined if none.
 */
export function parkingSpot(main: Rect, windows: readonly Rect[], display: Display): Point | undefined {
  const { bounds, workArea } = display;
  const free = (point: Point): boolean => !windows.some((window) => inside(window, point));
  const middle = { x: Math.round(main.x + main.width / 2), y: Math.round(main.y + main.height / 2) };
  const beside: Point[] = [
    { x: main.x - PARKING_GAP, y: middle.y },
    { x: main.x + main.width + PARKING_GAP, y: middle.y },
    { x: middle.x, y: main.y - PARKING_GAP },
    { x: middle.x, y: main.y + main.height + PARKING_GAP },
  ];
  const centre = { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) };
  const bars: Point[] = [
    { x: centre.x, y: Math.floor((bounds.y + workArea.y) / 2) },
    { x: centre.x, y: Math.floor((workArea.y + workArea.height + bounds.y + bounds.height) / 2) },
    { x: Math.floor((bounds.x + workArea.x) / 2), y: centre.y },
    { x: Math.floor((workArea.x + workArea.width + bounds.x + bounds.width) / 2), y: centre.y },
  ];
  return beside.find((point) => inside(workArea, point) && free(point)) ?? bars.find((point) => inside(bounds, point) && !inside(workArea, point) && free(point));
}

// The OS cursor in the coordinates the platform's warp takes: physical pixels on Windows, display points on macOS, X pixels.
interface Cursor {
  get(): Point;
  set(point: Point): void;
}

const loadKoffi = (): typeof Koffi => createRequire(__filename)('koffi') as typeof Koffi;

function bindWindows(koffi: typeof Koffi): Cursor {
  const user32 = koffi.load('user32.dll');
  // registers the name the prototype below refers to
  koffi.struct('E2EPoint', { x: 'long', y: 'long' });
  const getPhysicalCursorPos = user32.func('int __stdcall GetPhysicalCursorPos(_Out_ E2EPoint *point)');
  const setPhysicalCursorPos = user32.func('int __stdcall SetPhysicalCursorPos(int x, int y)');
  return {
    get: () => {
      const point = { x: 0, y: 0 };
      if (!getPhysicalCursorPos(point)) throw new Error('GetPhysicalCursorPos failed');
      return point;
    },
    set: ({ x, y }) => {
      if (!setPhysicalCursorPos(x, y)) throw new Error('SetPhysicalCursorPos failed');
    },
  };
}

function bindMac(koffi: typeof Koffi): Cursor {
  const cg = koffi.load('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cgPoint = koffi.struct('E2ECGPoint', { x: 'double', y: 'double' });
  const createEvent = cg.func('CGEventCreate', 'void*', ['void*']);
  const location = cg.func('CGEventGetLocation', cgPoint, ['void*']);
  const warp = cg.func('CGWarpMouseCursorPosition', 'int', [cgPoint]);
  const release = cf.func('CFRelease', 'void', ['void*']);
  return {
    get: () => {
      const event = createEvent(null);
      try {
        return location(event) as Point;
      } finally {
        release(event);
      }
    },
    set: (point) => {
      if (warp(point) !== 0) throw new Error('CGWarpMouseCursorPosition failed');
    },
  };
}

function bindX11(koffi: typeof Koffi): Cursor {
  const lib = koffi.load('libX11.so.6');
  const openDisplay = lib.func('void *XOpenDisplay(const char *name)');
  const closeDisplay = lib.func('int XCloseDisplay(void *display)');
  const rootWindow = lib.func('unsigned long XDefaultRootWindow(void *display)');
  const queryPointer = lib.func('int XQueryPointer(void *display, unsigned long window, _Out_ unsigned long *root, _Out_ unsigned long *child, _Out_ int *rootX, _Out_ int *rootY, _Out_ int *winX, _Out_ int *winY, _Out_ unsigned int *mask)');
  const warpPointer = lib.func('int XWarpPointer(void *display, unsigned long src, unsigned long dest, int srcX, int srcY, unsigned int srcWidth, unsigned int srcHeight, int destX, int destY)');
  const flush = lib.func('int XFlush(void *display)');
  const withDisplay = <T>(use: (display: unknown) => T): T => {
    const display = openDisplay(null);
    if (!display) throw new Error(`cannot open the X display ${process.env.DISPLAY ?? '(DISPLAY unset)'}`);
    try {
      return use(display);
    } finally {
      closeDisplay(display);
    }
  };
  return {
    get: () => withDisplay((display) => {
      const [root, child, rootX, rootY, winX, winY, mask] = [[0], [0], [0], [0], [0], [0], [0]];
      queryPointer(display, rootWindow(display), root, child, rootX, rootY, winX, winY, mask);
      return { x: rootX[0]!, y: rootY[0]! };
    }),
    set: ({ x, y }) => withDisplay((display) => {
      warpPointer(display, 0, rootWindow(display), 0, 0, 0, 0, x, y);
      flush(display);
    }),
  };
}

let cursor: Cursor | undefined;
// Where the user's cursor was before the first park of the current foreground hold.
let saved: Point | undefined;

function boundCursor(): Cursor | undefined {
  // Linux without X (Wayland alone) has no way to warp the pointer.
  if (process.platform === 'linux' && !process.env.DISPLAY) return undefined;
  cursor ??= process.platform === 'win32' ? bindWindows(loadKoffi()) : process.platform === 'darwin' ? bindMac(loadKoffi()) : bindX11(loadKoffi());
  return cursor;
}

/**
 * Moves the OS cursor beside the app's main window and outside every window of the app, remembering where it was, so the
 * user's resting cursor never hovers the page: Chromium replays the OS cursor's position into the page when it repaints
 * under it, which ends a hover a test made with Playwright's mouse. Called for each launch while the foreground is held.
 */
export async function parkPointer(app: ElectronApplication): Promise<void> {
  const target = boundCursor();
  if (!target) return;
  // a launch resolves before main shows its window; an app that exits first (a second instance handing off) has none
  const proc = app.process();
  const exited = (): boolean => proc.exitCode !== null || proc.signalCode !== null;
  const layout = () => app.evaluate(({ BrowserWindow, screen }, url) => {
    const all = BrowserWindow.getAllWindows().filter((window) => window.isVisible());
    const main = all.find((window) => window.webContents.getURL() === url);
    if (!main) return undefined;
    const mainBounds = main.getBounds();
    const { bounds, workArea } = screen.getDisplayMatching(mainBounds);
    return { main: mainBounds, windows: all.map((window) => window.getBounds()), display: { bounds, workArea } };
  }, SHELL_URL).catch((err: unknown) => {
    if (exited()) return undefined;
    throw err;
  });
  const deadline = Date.now() + MAIN_WINDOW_WAIT_MS;
  let spot = exited() ? undefined : await layout();
  while (!spot) {
    if (exited()) return;
    if (Date.now() > deadline) throw new Error(`the main window did not show within ${MAIN_WINDOW_WAIT_MS / 1000} s, so the pointer was not parked`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    spot = await layout();
  }
  const point = parkingSpot(spot.main, spot.windows, spot.display);
  if (!point) throw new Error('no point beside the app window or in a bar of its display lies outside the app\'s windows, so the pointer cannot be parked');
  // Electron's bounds are DIPs; Windows' physical cursor takes screen pixels.
  const native = process.platform === 'win32' ? await app.evaluate(({ screen }, dip) => screen.dipToScreenPoint(dip), point) : point;
  saved ??= target.get();
  target.set(native);
}

/** Puts the OS cursor back where the current foreground hold found it. */
export function restorePointer(): void {
  if (saved === undefined) return;
  const point = saved;
  saved = undefined;
  boundCursor()?.set(point);
}
