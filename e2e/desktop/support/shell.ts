import type { ElectronApplication, Page } from '@playwright/test';
import type { ShellState, ShellToast } from '../../../src/desktop/preload/shell-channels';
import { postMacKeyPress } from './mac-key-event';

export const SHELL_URL = 'app://damocles/shell/index.html';

/** The window's own page, which hosts the project list, tab strip and toasts. */
export async function shellPage(app: ElectronApplication): Promise<Page> {
  const isShell = (p: Page): boolean => p.url() === SHELL_URL;
  return app.windows().find(isShell) ?? app.waitForEvent('window', { predicate: isShell });
}

/** The shell state main publishes, read through the shell's own preload API. */
export async function shellState(app: ElectronApplication): Promise<ShellState> {
  const shell = await shellPage(app);
  await shell.waitForFunction(() => window.damoclesShell !== undefined);
  return shell.evaluate(() => window.damoclesShell!.getState());
}

/** Starts recording every toast main sends the shell, through a second listener on the shell API. */
export async function recordToasts(app: ElectronApplication): Promise<void> {
  const shell = await shellPage(app);
  await shell.waitForFunction(() => window.damoclesShell !== undefined);
  await shell.evaluate(() => {
    const w = window as unknown as { __e2eToasts?: ShellToast[]; __e2eDismissed?: string[] };
    if (w.__e2eToasts) return;
    w.__e2eToasts = [];
    w.__e2eDismissed = [];
    window.damoclesShell!.onToast((toast) => w.__e2eToasts!.push(toast));
    window.damoclesShell!.onToastDismiss((id) => w.__e2eDismissed!.push(id));
  });
}

export async function recordedToasts(app: ElectronApplication): Promise<ShellToast[]> {
  const shell = await shellPage(app);
  return shell.evaluate(() => (window as unknown as { __e2eToasts?: ShellToast[] }).__e2eToasts ?? []);
}

export async function dismissedToasts(app: ElectronApplication): Promise<string[]> {
  const shell = await shellPage(app);
  return shell.evaluate(() => (window as unknown as { __e2eDismissed?: string[] }).__e2eDismissed ?? []);
}

/** Answers a toast as the shell's action button does. */
export async function answerToast(app: ElectronApplication, id: string, action?: string): Promise<void> {
  const shell = await shellPage(app);
  await shell.evaluate(([toastId, choice]) => window.damoclesShell!.resolveToast(toastId!, choice), [id, action] as const);
}

/**
 * Presses a key in the page whose URL contains `urlPart`, through the platform's native input path: AppKit's event
 * queue on macOS, Electron's `sendInputEvent` elsewhere. Unlike Playwright's CDP key presses, these reach the
 * application menu's accelerators when the page leaves them unhandled.
 */
export async function pressKeys(app: ElectronApplication, urlPart: string, keyCode: string, modifiers: Array<'control' | 'shift' | 'alt' | 'meta'> = []): Promise<void> {
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

/** Replaces the OS notification service in main with a recorder of each notification body, one that is always available. */
export async function recordOsNotifications(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ Notification }) => {
    const g = globalThis as unknown as { __e2eOsNotifications?: string[] };
    g.__e2eOsNotifications = [];
    // A Linux session without a notification daemon reports no support, and the app then rightly shows none.
    Notification.isSupported = () => true;
    Notification.prototype.show = function show(this: { body: string }): void {
      g.__e2eOsNotifications!.push(this.body);
    };
  });
}

export async function osNotifications(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eOsNotifications?: string[] }).__e2eOsNotifications ?? []);
}
