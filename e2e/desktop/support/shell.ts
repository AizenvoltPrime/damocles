import { expect, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { OVERLAY_CHANNELS, type OverlayToast } from '../../../src/desktop/preload/overlay-channels';
import type { NoticeSeverity } from '../../../src/desktop/preload/notifications';
import type { ShellState } from '../../../src/desktop/preload/shell-channels';
import { macKeySequence, postMacKeyPress } from './mac-key-event';

export const SHELL_URL = 'app://damocles/shell/index.html';
export const OVERLAY_URL = 'app://damocles/overlay/index.html';
// The desktop popup window's page (D52); main opens the window for the first popup.
export const NOTIFIER_URL = 'app://damocles/notifier/index.html';

/** The window's own page, which draws the title bar and sidebar. */
export async function shellPage(app: ElectronApplication): Promise<Page> {
  const isShell = (p: Page): boolean => p.url() === SHELL_URL;
  return app.windows().find(isShell) ?? app.waitForEvent('window', { predicate: isShell });
}

/** The overlay view's page, which draws menus, dialogs and the settings modal above every other view. */
export async function overlayPage(app: ElectronApplication): Promise<Page> {
  const isOverlay = (p: Page): boolean => p.url() === OVERLAY_URL;
  const page = app.windows().find(isOverlay) ?? await app.waitForEvent('window', { predicate: isOverlay });
  await page.waitForFunction(() => window.damoclesOverlay !== undefined);
  return page;
}

/** The shell state main publishes, read through the shell's own preload API. */
export async function shellState(app: ElectronApplication): Promise<ShellState> {
  const shell = await shellPage(app);
  await shell.waitForFunction(() => window.damoclesShell !== undefined);
  return shell.evaluate(() => window.damoclesShell!.getState());
}

/**
 * Makes the main window report its focus as the test says, since the OS decides focus and a test runner's window may
 * never hold it; undefined restores the real answer.
 */
export async function setWindowFocused(app: ElectronApplication, focused: boolean | undefined): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [url, value]) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url) as unknown as { isFocused?: () => boolean };
    if (value === null) delete win.isFocused;
    else win.isFocused = () => value;
  }, [SHELL_URL, focused ?? null] as const);
}

/** Whether the page's view holds keyboard focus as main sees it; Playwright emulates focus, so `document.hasFocus()` is always true. */
export async function viewFocused(app: ElectronApplication, page: Page): Promise<boolean> {
  return app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.isFocused() ?? false, page.url());
}

/** The selected project's key, once main knows a project. */
export async function selectedProjectKey(app: ElectronApplication): Promise<string> {
  let key: string | undefined;
  await expect.poll(async () => (key = (await shellState(app)).selected.projectKey)).toBeDefined();
  return key!;
}

/** The desktop popup window's page, where every toast renders, once the first popup has opened the window. */
export async function popupPage(app: ElectronApplication): Promise<Page> {
  const isPopup = (page: Page): boolean => page.url() === NOTIFIER_URL;
  const page = app.windows().find(isPopup) ?? await app.waitForEvent('window', { predicate: isPopup });
  await page.waitForFunction(() => window.damoclesOverlay !== undefined);
  return page;
}

export const popupToasts = (popup: Page): Locator => popup.getByTestId('overlay-toast');

/** The popup window in main: a BaseWindow, so never among BrowserWindow.getAllWindows(); none before the first popup. */
export interface PopupWindow {
  readonly electron: typeof import('electron');
  readonly window: Electron.BaseWindow | undefined;
  readonly view: Electron.WebContentsView | undefined;
}

/** Runs `fn` in main on the popup window. Like app.evaluate's function, `fn` is serialized and closes over nothing. */
export async function evaluatePopupWindow<R, A>(app: ElectronApplication, fn: (popup: PopupWindow, arg: A) => R | Promise<R>, arg: A): Promise<R> {
  const handle = await app.evaluateHandle((electron, url): PopupWindow => {
    for (const window of electron.BaseWindow.getAllWindows()) {
      const view = (window.contentView.children as Electron.WebContentsView[]).find((child) => child.webContents?.getURL() === url);
      if (view) return { electron, window, view };
    }
    return { electron, window: undefined, view: undefined };
  }, NOTIFIER_URL);
  try {
    return await handle.evaluate(fn as (popup: PopupWindow, arg: unknown) => R | Promise<R>, arg);
  } finally {
    await handle.dispose();
  }
}

export interface PopupWindowState {
  readonly visible: boolean;
  // the active window
  readonly focused: boolean;
  // its page holds keyboard focus
  readonly pageFocused: boolean;
  readonly alwaysOnTop: boolean;
  readonly bounds: Electron.Rectangle;
  readonly workArea: Electron.Rectangle;
}

/** The popup window as the OS has it, or undefined before the first popup opened it. */
export async function popupWindowState(app: ElectronApplication): Promise<PopupWindowState | undefined> {
  return evaluatePopupWindow(app, ({ electron, window, view }) => (window && view
    ? {
        visible: window.isVisible(),
        focused: window.isFocused(),
        pageFocused: view.webContents.isFocused(),
        alwaysOnTop: window.isAlwaysOnTop(),
        bounds: window.getBounds(),
        workArea: electron.screen.getPrimaryDisplay().workArea,
      }
    : undefined), undefined);
}

/**
 * Counts main's requests to focus the popup window from now on. Another worker's app may hold the foreground, so the OS
 * may not grant one; the request is what main controls.
 */
export async function countPopupFocus(app: ElectronApplication): Promise<void> {
  await evaluatePopupWindow(app, ({ window }) => {
    if (!window) throw new Error('no popup window');
    const g = globalThis as unknown as { __popupFocus: number };
    g.__popupFocus = 0;
    const focus = window.focus.bind(window);
    window.focus = () => {
      g.__popupFocus++;
      focus();
    };
  }, undefined);
}

export async function popupFocusRequests(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __popupFocus: number }).__popupFocus);
}

/**
 * Starts recording every toast main sends any page, every dismissal and the holds pages report, by wrapping each page's
 * send and listening on its channel in main: the popup window's page does not exist until the first popup, and a test
 * checks no other page gets one.
 */
export async function recordToasts(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, webContents }, { toastChannel, dismissChannel, holdChannel }) => {
    const g = globalThis as unknown as { __e2eToasts?: Array<{ url: string; toast: unknown }>; __e2eDismissed?: string[]; __e2eHeld?: Set<string> };
    if (g.__e2eToasts) return;
    const toasts: Array<{ url: string; toast: unknown }> = [];
    const dismissed: string[] = [];
    const held = new Set<string>();
    g.__e2eToasts = toasts;
    g.__e2eDismissed = dismissed;
    g.__e2eHeld = held;
    const wrap = (contents: Electron.WebContents): void => {
      const send = contents.send.bind(contents);
      contents.send = (channel: string, ...args: unknown[]): void => {
        if (channel === toastChannel) toasts.push({ url: contents.getURL(), toast: args[0] });
        if (channel === dismissChannel) dismissed.push(args[0] as string);
        send(channel, ...args);
      };
      contents.ipc.on(holdChannel, (_event, id: unknown, on: unknown) => {
        if (typeof id !== 'string') return;
        if (on === true) held.add(id);
        else held.delete(id);
      });
    };
    for (const contents of webContents.getAllWebContents()) wrap(contents);
    electronApp.on('web-contents-created', (_event, contents) => wrap(contents));
  }, { toastChannel: OVERLAY_CHANNELS.toast, dismissChannel: OVERLAY_CHANNELS.toastDismiss, holdChannel: OVERLAY_CHANNELS.toastHold });
}

/** The toasts a page last told main it holds, whose timers main has paused. Needs recordToasts. */
export async function heldToasts(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => [...((globalThis as unknown as { __e2eHeld?: Set<string> }).__e2eHeld ?? [])]);
}

/**
 * Rests the pointer on a toast's card, as a user reading it does, and returns its id once main holds its life. Playwright's
 * pointer reaches the page directly, past the window's click-through. The pointer stays until the test moves it;
 * answerToast moves it away. Needs recordToasts.
 */
export async function holdToast(app: ElectronApplication, card: Locator): Promise<string> {
  await card.hover();
  const id = await card.getAttribute('data-toast-id');
  if (id === null) throw new Error('not a toast card');
  await expect.poll(() => heldToasts(app)).toContain(id);
  return id;
}

/** Moves the pointer off the popup's cards, so a card that lands under it later is not held. */
export async function leaveToasts(popup: Page): Promise<void> {
  await popup.mouse.move(0, 0);
}

/** The URL of every page main sent a toast to since recordToasts, once per page. */
export async function toastPages(app: ElectronApplication): Promise<string[]> {
  const sent = await app.evaluate(() => (globalThis as unknown as { __e2eToasts?: Array<{ url: string }> }).__e2eToasts ?? []);
  return [...new Set(sent.map((entry) => entry.url))];
}

/** Every toast main sent the popup page, once each: core notices and the seven kinds. */
export async function recordedPopupToasts(app: ElectronApplication): Promise<OverlayToast[]> {
  const sent = await app.evaluate((_electron, url) => ((globalThis as unknown as { __e2eToasts?: Array<{ url: string; toast: unknown }> }).__e2eToasts ?? [])
    .filter((entry) => entry.url === url)
    .map((entry) => entry.toast), NOTIFIER_URL) as OverlayToast[];
  // A page that reloads gets the toasts still showing again.
  return sent.filter((toast, index) => sent.findIndex((other) => other.id === toast.id) === index);
}

export interface RecordedNotice {
  id: string;
  severity: NoticeSeverity;
  message: string;
  actions: readonly string[];
}

/** The toasts of core NotificationService notices, flattened. */
export async function recordedToasts(app: ElectronApplication): Promise<RecordedNotice[]> {
  return (await recordedPopupToasts(app)).flatMap((toast) => (toast.body.kind === 'notice'
    ? [{ id: toast.id, severity: toast.body.severity, message: toast.body.message, actions: toast.body.actions }]
    : []));
}

export async function dismissedToasts(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eDismissed?: string[] }).__e2eDismissed ?? []);
}

/** Answers a toast with a click on its card in the popup window: one of its actions, else its close button. */
export async function answerToast(app: ElectronApplication, id: string, action?: string): Promise<void> {
  const popup = await popupPage(app);
  const card = popup.locator(`[data-testid="overlay-toast"][data-toast-id="${id}"]`);
  await (action === undefined ? card.getByTestId('overlay-toast-dismiss') : card.getByRole('button', { name: action, exact: true })).click();
  await leaveToasts(popup);
}

/**
 * Presses a key in the page whose URL contains `urlPart`, through the platform's native input path: AppKit's event
 * queue on macOS, Electron's `sendInputEvent` elsewhere. Unlike Playwright's CDP key presses, these reach the
 * application menu's accelerators when the page leaves them unhandled.
 */
export async function pressKeys(app: ElectronApplication, urlPart: string, keyCode: string, modifiers: Array<'control' | 'shift' | 'alt' | 'meta'> = []): Promise<void> {
  // Every platform checks the key against the macOS table, so a key only the macOS runner would reject fails here first.
  macKeySequence(keyCode, modifiers);
  if (process.platform === 'darwin') return postMacKeyPress(app, urlPart, keyCode, modifiers);
  await app.evaluate(({ webContents }, [part, key, mods]) => {
    const target = webContents.getAllWebContents().find((c) => c.getURL().includes(part));
    if (!target) throw new Error(`no page matching ${part}`);
    target.focus();
    target.sendInputEvent({ type: 'keyDown', keyCode: key, modifiers: mods });
    target.sendInputEvent({ type: 'keyUp', keyCode: key, modifiers: mods });
  }, [urlPart, keyCode, modifiers] as const);
}

/** The platform's primary modifier: Cmd on macOS, Ctrl elsewhere. */
export const PRIMARY: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control';
