import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type * as Koffi from 'koffi';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { overlayViewState, readyOverlay } from './support/overlay';
import { closeSettingsModal, openSettingsModal, settingsRow } from './support/settings';
import { openProjectChat } from './support/screenshots';
import {
  answerToast,
  dismissedToasts,
  evaluatePopupWindow,
  holdToast,
  leaveToasts,
  NOTIFIER_URL,
  popupPage,
  popupToasts as popupCards,
  popupWindowState,
  recordedPopupToasts,
  recordedToasts,
  recordToasts,
  setWindowFocused,
  SHELL_URL,
  shellPage,
  shellState,
  toastPages,
  viewFocused,
} from './support/shell';
import { chatInput, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho } from './support/ui';

// String from src/core/chat-panel/message-router/handlers/workspace-handlers.ts.
const NO_SESSION = 'No active session to view';
// NOTICE_LIFE_MS.info in src/desktop/main/notification-center.ts.
const INFO_LIFE_MS = 8_000;

// Records the sounds main asks the popup page to play from now on.
async function recordChimes(popup: Page): Promise<void> {
  await popup.evaluate(() => {
    const w = window as unknown as { __chimes?: string[] };
    w.__chimes = [];
    window.damoclesOverlay!.onChime((tone) => w.__chimes!.push(tone));
  });
}

async function chimes(popup: Page): Promise<string[]> {
  return popup.evaluate(() => (window as unknown as { __chimes?: string[] }).__chimes ?? []);
}

// Whether the popup window takes a click at `at` (DIPs from its top-left), read from the window's own state so another
// app's window over it cannot change the answer: on Windows its WS_EX_TRANSPARENT style, which setIgnoreMouseEvents sets
// for the whole window, on Linux its X shape, where the suite runs on X11. undefined on macOS, which has no such check here.
async function popupTakesClickAt(app: ElectronApplication, at: { x: number; y: number }): Promise<boolean | undefined> {
  return evaluatePopupWindow(app, ({ electron: { app: electronApp, screen }, window: win }, point) => {
    if (!win) throw new Error('no popup window');
    const { createRequire } = process.getBuiltinModule('node:module');
    const koffi = createRequire(`${electronApp.getAppPath()}/`)('koffi') as typeof Koffi;
    const handle = win.getNativeWindowHandle();
    if (process.platform === 'win32') {
      const user32 = koffi.load('user32.dll');
      const getWindowLongPtr = user32.func('__stdcall', 'GetWindowLongPtrW', 'intptr_t', ['uintptr_t', 'int']);
      const GWL_EXSTYLE = -20;
      const WS_EX_TRANSPARENT = 0x20;
      const exStyle = BigInt(getWindowLongPtr(handle.readBigUInt64LE(0), GWL_EXSTYLE) as number | bigint);
      return (exStyle & BigInt(WS_EX_TRANSPARENT)) === 0n;
    }
    if (process.platform === 'linux') {
      const x11 = koffi.load('libX11.so.6');
      const xext = koffi.load('libXext.so.6');
      const openDisplay = x11.func('XOpenDisplay', 'void*', ['str']);
      const closeDisplay = x11.func('XCloseDisplay', 'int', ['void*']);
      const xFree = x11.func('XFree', 'int', ['void*']);
      const rectangle = koffi.struct({ x: 'int16', y: 'int16', width: 'uint16', height: 'uint16' });
      const shapeRectangles = xext.func('XShapeGetRectangles', 'void*', ['void*', 'unsigned long', 'int', koffi.out(koffi.pointer('int')), koffi.out(koffi.pointer('int'))]);
      const SHAPE_BOUNDING = 0;
      const display = openDisplay(null) as unknown;
      try {
        const count = [0];
        const rects = shapeRectangles(display, handle.readUInt32LE(0), SHAPE_BOUNDING, count, [0]) as unknown;
        const boxes = rects === null ? [] : koffi.decode(rects, rectangle, count[0]!) as Array<{ x: number; y: number; width: number; height: number }>;
        if (rects !== null) xFree(rects);
        const scale = screen.getPrimaryDisplay().scaleFactor;
        const [x, y] = [point.x * scale, point.y * scale];
        return boxes.some((box) => x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height);
      } finally {
        closeDisplay(display);
      }
    }
    return undefined;
  }, at);
}

// The bell is clicked in the window, so the window has focus and the overlay takes it at once.
async function openCenter(app: ElectronApplication): Promise<Page> {
  await setWindowFocused(app, true);
  const shell = await shellPage(app);
  await shell.getByTestId('notification-bell').click();
  const overlay = await readyOverlay(app);
  await expect(overlay.getByTestId('notification-center')).toBeVisible();
  return overlay;
}

// The kinds of the toasts main sent, core notices left out.
async function entryKinds(app: ElectronApplication): Promise<string[]> {
  return (await recordedPopupToasts(app)).flatMap((toast) => (toast.body.kind !== 'notice' ? [toast.body.kind] : []));
}

test('core notices pop up only in the desktop popup window, focused or not, and resolve or time out in main', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const homeTab = await activeChat(app);
    await expect(chatInput(homeTab)).toBeVisible();
    await recordToasts(app);

    // A plain notice from a real core path: the webview asks for the session log before any conversation exists.
    await setWindowFocused(app, true);
    await postFromWebview(homeTab, { type: 'openSessionLog' });
    await expect.poll(async () => (await recordedToasts(app)).map((t) => t.message)).toEqual([NO_SESSION]);
    const [first] = await recordedToasts(app);
    expect(first).toMatchObject({ severity: 'info', actions: [] });
    // With the window focused the notice still renders only in the popup window, bottom-right of the work area, without
    // taking focus; the overlay view stays hidden.
    const popup = await popupPage(app);
    const card = popupCards(popup).filter({ hasText: NO_SESSION });
    // The pointer on the card holds its life through the checks below.
    await holdToast(app, card);
    await expect.poll(async () => {
      const shown = await popupWindowState(app);
      return shown !== undefined && shown.visible && shown.alwaysOnTop && !shown.focused
        && shown.bounds.x + shown.bounds.width === shown.workArea.x + shown.workArea.width
        && shown.bounds.y + shown.bounds.height === shown.workArea.y + shown.workArea.height;
    }).toBe(true);
    expect((await overlayViewState(app)).visible).toBe(false);
    await expect((await readyOverlay(app)).getByTestId('overlay-toast')).toHaveCount(0);
    // The card takes a click once the pointer is on it; the window's empty margin never does, so a click there reaches
    // whatever is under the popups.
    const box = (await card.boundingBox())!;
    await expect.poll(() => popupTakesClickAt(app, { x: box.x + box.width / 2, y: box.y + box.height / 2 })).not.toBe(false);
    await popup.mouse.move(4, 4);
    await expect.poll(() => popupTakesClickAt(app, { x: 4, y: 4 })).not.toBe(true);
    await expect.poll(() => popupTakesClickAt(app, { x: box.x / 2, y: box.y + box.height / 2 })).not.toBe(true);
    await answerToast(app, first!.id);
    await expect(popupCards(popup)).toHaveCount(0);

    // Unfocused, the next one pops up the same way, and main times it out.
    await setWindowFocused(app, false);
    await postFromWebview(homeTab, { type: 'openSessionLog' });
    await expect.poll(async () => (await recordedToasts(app)).length).toBe(2);
    await expect(popupCards(popup).filter({ hasText: NO_SESSION })).toBeVisible();
    const second = (await recordedToasts(app))[1]!;
    await expect.poll(() => dismissedToasts(app), { timeout: INFO_LIFE_MS + 10_000 }).toContain(second.id);
    await expect(popupCards(popup)).toHaveCount(0);
    // The popup page dropped the card it answered, so main never sent it a dismissal.
    expect(await dismissedToasts(app)).not.toContain(first!.id);
    expect(await toastPages(app)).toEqual([NOTIFIER_URL]);
    // Every notice is also an entry in the bell's center.
    expect((await shellState(app)).notifications.unseen).toBeGreaterThanOrEqual(2);
  } finally {
    await stub.close();
  }
});

test('a finished turn the user is not looking at raises done; the bell counts it, its center lists it and Do not disturb silences pop-ups', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(120_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await recordToasts(app);
    const shell = await shellPage(app);

    await setWindowFocused(app, false);
    await sendAndAwaitEcho(tab, 'work while I look away');
    await expect.poll(() => entryKinds(app)).toEqual(['done']);
    const popup = await popupPage(app);
    const popped = popupCards(popup).filter({ hasText: 'Finished' });
    await holdToast(app, popped);
    await expect(popped).toHaveAttribute('data-kind', 'done');
    await expect(shell.getByTestId('notification-badge')).toBeVisible();
    await expect(popped.getByRole('button', { name: 'Open chat' })).toBeVisible();
    // Reduced motion would draw the life bar empty from the start, so the bar is not drawn then.
    const lifeBarDisplay = (): Promise<string> => popped.getByTestId('overlay-toast-life').evaluate((bar) => getComputedStyle(bar).display);
    expect(await lifeBarDisplay()).toBe('block');
    await popup.emulateMedia({ reducedMotion: 'reduce' });
    expect(await lifeBarDisplay()).toBe('none');
    await popup.emulateMedia({ reducedMotion: null });
    await popup.evaluate(() => document.documentElement.setAttribute('data-reduced-motion', ''));
    expect(await lifeBarDisplay()).toBe('none');
    await popup.evaluate(() => document.documentElement.removeAttribute('data-reduced-motion'));
    await popped.getByTestId('overlay-toast-dismiss').click();
    await expect(popupCards(popup)).toHaveCount(0);

    // Opening the center marks the entry seen; it stays unread until chosen, or until the window has focus on its chat (D52),
    // so the bell is clicked in the focused window while another chat is selected.
    let tabChat: string | undefined;
    await expect.poll(async () => (tabChat = (await shellState(app)).selected.chatId)?.startsWith('new:')).toBe(false);
    await shell.evaluate(() => window.damoclesShell!.newChat());
    await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(tabChat);
    const overlay = await openCenter(app);
    await expect(shell.getByTestId('notification-badge')).toHaveCount(0);
    const done = overlay.locator('[data-testid="notification-row"][data-kind="done"]');
    await expect(done).toHaveCount(1);
    await expect(done.first()).toContainText('Unread');
    await expect(overlay.getByTestId('notification-dnd-subtitle')).toHaveText('Pop-ups show when a chat needs you');

    await overlay.getByTestId('notification-dnd').click();
    await expect(overlay.getByTestId('notification-dnd-subtitle')).toHaveText('No pop-ups. They still collect here');
    await expect(shell.getByTestId('notification-bell')).toHaveAttribute('title', 'Notifications · Do not disturb is on');
    // Escape closes the center and hands focus back to the bell.
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('notification-center')).toHaveCount(0);
    await expect(shell.getByTestId('notification-bell')).toBeFocused();

    // Under Do not disturb the entry still collects, with no toast and no popup.
    await setWindowFocused(app, false);
    await shell.evaluate((id) => window.damoclesShell!.selectChat(id), tabChat!);
    await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(tabChat);
    await sendAndAwaitEcho(tab, 'more work while I look away');
    await expect(shell.getByTestId('notification-badge')).toBeVisible();
    expect(await entryKinds(app)).toEqual(['done']);
    await expect(popupCards(popup)).toHaveCount(0);
    expect((await popupWindowState(app))!.visible).toBe(false);
    await setWindowFocused(app, undefined);

    // The center lists both, and its footer is only the caption.
    const again = await openCenter(app);
    await expect(again.locator('[data-testid="notification-row"][data-kind="done"]')).toHaveCount(2);
    await expect(again.getByTestId('notification-footer')).toHaveText('Approvals, plans, questions and finished chats');
    expect((await shellState(app)).notifications.doNotDisturb).toBe(true);
    expect((await shellState(app)).notifications.unseen).toBe(0);

    // Choosing a row reads it and opens its chat.
    await again.getByTestId('notification-row').last().click();
    await expect(again.getByTestId('notification-center')).toHaveCount(0);
    const reopened = await openCenter(app);
    await expect(reopened.getByTestId('notification-row').last()).toHaveAttribute('data-read', 'true');
    await reopened.getByTestId('notification-clear').click();
    await expect(reopened.getByTestId('notification-empty')).toHaveText('You’re all caught up');
    // Clear all went with the log while it had focus; focus stays in the center.
    await expect(reopened.getByTestId('notification-dnd')).toBeFocused();
  } finally {
    await stub.close();
  }
});

test('an approval in a chat that is not selected raises a toast and leaves the selection and focus alone; Review selects that chat, focuses it and asks it to focus the permission card', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(120_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'auth.ts');
    fs.writeFileSync(file, 'export const limit = 5;\n');
    const { app } = await launch();
    const alpha = await openProjectChat(app, home.project);
    await recordToasts(app);
    await recordHostMessages(alpha);
    const alphaId = (await shellState(app)).selected.chatId;

    let release!: () => void;
    stub.replies.push({
      chunks: ['Changing the limit.'],
      holdAfterFirst: new Promise<void>((resolve) => { release = resolve; }),
      toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'limit = 5', new_string: 'limit = 7' } }],
    });
    await chatInput(alpha).fill('raise the limit');
    await chatInput(alpha).press('Enter');
    // Another chat is selected when the approval arrives.
    const shell = await shellPage(app);
    await shell.evaluate(() => window.damoclesShell!.newChat());
    await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(alphaId);
    const looking = (await shellState(app)).selected.chatId;
    release();

    await expect.poll(() => entryKinds(app), { timeout: 30_000 }).toContain('approval');
    // The agent's approval diff waits in its own chat for the card's Open diff; only the user's Review moves there.
    await expect.poll(async () => (await hostMessages(alpha, 'editorShowDiff')).length).toBe(1);
    expect((await shellState(app)).selected.chatId).toBe(looking);
    expect(await viewFocused(app, alpha)).toBe(false);
    const popup = await popupPage(app);
    const toast = popup.locator('[data-testid="overlay-toast"][data-kind="approval"]');
    const toastId = await holdToast(app, toast);
    await expect(toast).toContainText('Needs your approval');
    await expect(popup.getByTestId('overlay-toasts-assertive')).toContainText('Needs your approval');
    await answerToast(app, toastId, 'Review');

    await expect.poll(async () => (await activeChat(app)).url()).toBe(alpha.url());
    await expect.poll(async () => (await hostMessages(alpha, 'focusAttention')).map((m) => m['kind'])).toEqual(['approval']);
    await expect.poll(() => viewFocused(app, alpha)).toBe(true);
    const card = alpha.getByRole('region', { name: 'Permission request' });
    await expect(card).toBeVisible();
    await expect.poll(() => card.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(toast).toHaveCount(0);
  } finally {
    await stub.close();
  }
});

type TaskbarCall =
  | { kind: 'overlay'; png: string | null; description: string }
  | { kind: 'badge'; count: number }
  | { kind: 'flash'; on: boolean };

// Replaces the main window's taskbar overlay and flash and the app badge with recorders.
async function recordTaskbar(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow }, url) => {
    const g = globalThis as unknown as { __taskbar?: unknown[] };
    const calls: unknown[] = [];
    g.__taskbar = calls;
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)!;
    win.setOverlayIcon = (overlay, description) => {
      calls.push({ kind: 'overlay', png: overlay ? overlay.toPNG().toString('base64') : null, description });
    };
    win.flashFrame = (on) => {
      calls.push({ kind: 'flash', on });
    };
    electronApp.setBadgeCount = (count?: number) => {
      calls.push({ kind: 'badge', count: count ?? 0 });
      return true;
    };
  }, SHELL_URL);
}

async function taskbarCalls(app: ElectronApplication): Promise<TaskbarCall[]> {
  return app.evaluate(() => JSON.parse(JSON.stringify((globalThis as unknown as { __taskbar: unknown[] }).__taskbar)));
}

// The unread count the taskbar shows now: the last overlay description on Windows, the last app badge elsewhere.
async function taskbarCount(app: ElectronApplication): Promise<number> {
  const calls = await taskbarCalls(app);
  if (process.platform === 'win32') {
    const last = calls.filter((call): call is Extract<TaskbarCall, { kind: 'overlay' }> => call.kind === 'overlay').at(-1);
    if (!last || last.png === null) return 0;
    return Number(/^(\d+)/.exec(last.description)?.[1] ?? NaN);
  }
  return calls.filter((call): call is Extract<TaskbarCall, { kind: 'badge' }> => call.kind === 'badge').at(-1)?.count ?? 0;
}

// Counts apply once per frame, so a read right after a change can precede it. A scale change makes the counter show its
// count again, so the count it shows next includes every change made before this call.
async function settledTaskbarCount(app: ElectronApplication): Promise<number> {
  const shown = async (): Promise<number> => (await taskbarCalls(app)).filter((call) => call.kind !== 'flash').length;
  const before = await shown();
  await app.evaluate(({ screen }) => {
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['scaleFactor']);
  });
  await expect.poll(shown).toBeGreaterThan(before);
  return taskbarCount(app);
}

async function flashCalls(app: ElectronApplication): Promise<boolean[]> {
  return (await taskbarCalls(app)).flatMap((call) => (call.kind === 'flash' ? [call.on] : []));
}

async function lastFlash(app: ElectronApplication): Promise<boolean | undefined> {
  return (await flashCalls(app)).at(-1);
}

// A real focus event (the window shown for a click) may stop a flash at any time, so tests count the starts.
async function flashesOn(app: ElectronApplication): Promise<number> {
  return (await flashCalls(app)).filter((on) => on).length;
}

function pngSize(png: Buffer): { width: number; height: number } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function focusWindow(app: ElectronApplication): Promise<void> {
  await setWindowFocused(app, true);
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)!.emit('focus');
  }, SHELL_URL);
}

test('D52: an approval in an unfocused window pops up on the desktop, counts on the taskbar and flashes; Review reviews it and an answer in the app takes it down', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'auth.ts');
    fs.writeFileSync(file, 'export const limit = 5;\n');
    const { app } = await launch();
    const alpha = await openProjectChat(app, home.project);
    await recordToasts(app);
    await recordHostMessages(alpha);
    await recordTaskbar(app);
    // Adding the project raised a notice; the center marks it seen, so the count starts at 0.
    const center = await openCenter(app);
    await center.keyboard.press('Escape');
    await expect.poll(() => taskbarCount(app)).toBe(0);

    stub.replies.push(
      { chunks: ['Raising the limit.'], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'limit = 5', new_string: 'limit = 7' } }] },
      { chunks: ['Once more.'], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'limit = 7', new_string: 'limit = 9' } }] },
    );
    await setWindowFocused(app, false);
    await chatInput(alpha).fill('raise the limit');
    await chatInput(alpha).press('Enter');

    // The popup shows the entry under its id, in an always-on-top window at the bottom-right that took no focus.
    const popup = await popupPage(app);
    const card = popup.locator('[data-testid="overlay-toast"][data-kind="approval"]');
    await expect(card).toBeVisible({ timeout: 30_000 });
    await holdToast(app, card);
    const approval = (await recordedPopupToasts(app)).find((toast) => toast.body.kind === 'approval')!;
    await expect(card).toHaveAttribute('data-toast-id', approval.id);
    await expect(card).toContainText(('chat' in approval.body && approval.body.chat.title) || 'New chat');
    await expect(card).toContainText('Needs your approval');
    await expect(card.getByRole('button', { name: 'Review' })).toBeVisible();
    await expect.poll(async () => {
      const shown = await popupWindowState(app);
      return shown !== undefined && shown.visible && shown.alwaysOnTop && !shown.focused
        && shown.bounds.x + shown.bounds.width === shown.workArea.x + shown.workArea.width
        && shown.bounds.y + shown.bounds.height === shown.workArea.y + shown.workArea.height;
    }).toBe(true);

    // The taskbar counts it, drawn on Windows at 16 px times the primary display's scale, and flashes for a prompt that
    // waits on the user.
    await expect.poll(() => taskbarCount(app)).toBe(1);
    if (process.platform === 'win32') {
      const overlay = (await taskbarCalls(app)).filter((call): call is Extract<TaskbarCall, { kind: 'overlay' }> => call.kind === 'overlay').at(-1)!;
      expect(overlay.description).toBe('1 new notification');
      const pixels = Math.round(16 * await app.evaluate(({ screen }) => screen.getPrimaryDisplay().scaleFactor));
      expect(pngSize(Buffer.from(overlay.png!, 'base64'))).toEqual({ width: pixels, height: pixels });
    }
    expect(await flashesOn(app)).toBe(1);

    // Review on the popup shows the window, selects the chat and focuses the permission card; the entry is read.
    await answerToast(app, approval.id, 'Review');
    await expect.poll(async () => (await hostMessages(alpha, 'focusAttention')).map((m) => m['kind'])).toEqual(['approval']);
    const prompt = alpha.getByRole('region', { name: 'Permission request' });
    await expect.poll(() => prompt.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect.poll(() => taskbarCount(app)).toBe(0);
    await expect(card).toHaveCount(0);
    await recordChimes(popup);
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();

    // The second approval is answered in the app: main takes its popup down while the pointer holds its life, so the
    // answer did it, and the flash stops. It chimes as a prompt does.
    const second = popup.locator('[data-testid="overlay-toast"][data-kind="approval"]');
    await expect(second).toBeVisible({ timeout: 30_000 });
    const secondId = await holdToast(app, second);
    await expect.poll(() => chimes(popup)).toEqual(['attention']);
    await expect.poll(() => taskbarCount(app)).toBe(1);
    expect(await flashesOn(app)).toBe(2);
    await expect(prompt).toHaveCount(1);
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect.poll(() => dismissedToasts(app)).toContain(secondId);
    await expect(second).toHaveCount(0);
    await leaveToasts(popup);
    await expect.poll(() => lastFlash(app)).toBe(false);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('export const limit = 9;\n');
    // The turn then finishes while the window is away, which pops up and counts too.
    await expect(popup.locator('[data-testid="overlay-toast"][data-kind="done"]')).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => taskbarCount(app)).toBe(2);
    await expect.poll(() => chimes(popup)).toEqual(['attention', 'done']);

    // Unread until the user looks at that chat: not while another chat has focus, but once it is selected in a focused window.
    const alphaId = (await shellState(app)).selected.chatId!;
    const shell = await shellPage(app);
    await shell.evaluate(() => window.damoclesShell!.newChat());
    await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(alphaId);
    await focusWindow(app);
    expect(await settledTaskbarCount(app)).toBe(2);
    await shell.evaluate((id) => window.damoclesShell!.selectChat(id), alphaId);
    await expect.poll(() => taskbarCount(app)).toBe(0);
    expect((await shellState(app)).notifications.unseen).toBe(0);
  } finally {
    await stub.close();
  }
});

test('the user\'s case: a chat finishing behind another selected chat while the window is away pops up outside, and focusing the window leaves that same popup up with no toast in the overlay', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(120_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const alpha = await openProjectChat(app, home.project);
    await recordToasts(app);
    const shell = await shellPage(app);
    const alphaId = (await shellState(app)).selected.chatId;

    // Chat A streams, chat B is selected, the user switches to another app, then chat A finishes.
    let release!: () => void;
    stub.replies.push({ chunks: ['Working on it.', ' Done.'], holdAfterFirst: new Promise<void>((resolve) => { release = resolve; }) });
    await chatInput(alpha).fill('take your time');
    await chatInput(alpha).press('Enter');
    await expect(alpha.getByText('Working on it.')).toBeVisible();
    await shell.evaluate(() => window.damoclesShell!.newChat());
    await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(alphaId);
    await setWindowFocused(app, false);
    release();

    const popup = await popupPage(app);
    const card = popup.locator('[data-testid="overlay-toast"][data-kind="done"]:not([inert])');
    await expect(card).toBeVisible({ timeout: 30_000 });
    // Held, the popup cannot reach the end of its life, so only focus could take it down below.
    await holdToast(app, card);
    const done = (await recordedPopupToasts(app)).find((toast) => toast.body.kind === 'done')!;
    await expect(card).toHaveAttribute('data-toast-id', done.id);
    expect((await popupWindowState(app))!.visible).toBe(true);

    // Back in Damocles: the same popup stays in the popup window, and the overlay page never gets a toast.
    await focusWindow(app);
    expect(await dismissedToasts(app)).not.toContain(done.id);
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute('data-toast-id', done.id);
    expect((await popupWindowState(app))!.visible).toBe(true);
    expect(await toastPages(app)).toEqual([NOTIFIER_URL]);
    await expect((await readyOverlay(app)).getByTestId('overlay-toast')).toHaveCount(0);
    expect((await overlayViewState(app)).visible).toBe(false);
  } finally {
    await stub.close();
  }
});

test('D52: the window gaining focus on the chat reads its entries; the sound setting mutes the popup; Do not disturb silences the popup and the flash but still counts', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(120_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await recordTaskbar(app);
    await recordToasts(app);

    await setWindowFocused(app, false);
    await sendAndAwaitEcho(tab, 'work while I look away');
    await expect.poll(() => taskbarCount(app)).toBe(1);
    const popup = await popupPage(app);
    const done = popup.locator('[data-testid="overlay-toast"][data-kind="done"]');
    // Held, the popup cannot reach the end of its life, so only focus could take it down.
    const doneId = await holdToast(app, done);
    await expect(done).toContainText('Finished');
    await expect(done.getByRole('button', { name: 'Open chat' })).toBeVisible();
    // A finished chat only counts and pops up; it does not flash. Focus reads it, leaves its popup up and has no flash to stop.
    expect(await flashesOn(app)).toBe(0);
    await focusWindow(app);
    await expect.poll(() => taskbarCount(app)).toBe(0);
    await expect(done).toBeVisible();
    expect(await dismissedToasts(app)).not.toContain(doneId);
    expect(await flashCalls(app)).toEqual([]);
    await answerToast(app, doneId);
    await expect(done).toHaveCount(0);

    // The sound row turns the chime off; the popup still shows.
    const settings = await openSettingsModal(app, 'application');
    const sound = settingsRow(settings, 'damocles.desktop.notifications.sound').getByRole('switch', { name: 'Play a sound with desktop pop-ups' });
    await expect(sound).toBeChecked();
    await sound.click();
    await expect(sound).not.toBeChecked();
    await closeSettingsModal(settings);
    await recordChimes(popup);
    await setWindowFocused(app, false);
    await sendAndAwaitEcho(tab, 'quietly now');
    const quiet = popup.locator('[data-testid="overlay-toast"][data-kind="done"]');
    const quietId = await holdToast(app, quiet);
    expect(await chimes(popup)).toEqual([]);
    await focusWindow(app);
    await expect.poll(() => taskbarCount(app)).toBe(0);
    await answerToast(app, quietId);
    await expect.poll(async () => (await popupWindowState(app))!.visible).toBe(false);

    // Main sends no toast for the entry raised under Do not disturb; the entry still counts.
    const overlay = await openCenter(app);
    await overlay.getByTestId('notification-dnd').click();
    // Main applies Do not disturb once its state file is written, then pushes the subtitle.
    await expect(overlay.getByTestId('notification-dnd-subtitle')).toHaveText('No pop-ups. They still collect here');
    await overlay.keyboard.press('Escape');
    await setWindowFocused(app, false);
    await sendAndAwaitEcho(tab, 'more work while I look away');
    await expect.poll(() => taskbarCount(app)).toBe(1);
    expect(await entryKinds(app)).toEqual(['done', 'done']);
    await expect(popupCards(popup)).toHaveCount(0);
    expect((await popupWindowState(app))!.visible).toBe(false);
  } finally {
    await stub.close();
  }
});
