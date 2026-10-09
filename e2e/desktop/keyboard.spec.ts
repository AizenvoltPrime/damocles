import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { MAIN_SCRIPT } from './support/app';
import { activeChat, expect, nextChat, panelIdOf, test } from './support/fixtures';
import { hermeticEnv, seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { openProjectChat, saveScreenshot } from './support/screenshots';
import { codeEditor, editorShows, openInEditor } from './support/editor';
import {
  countPopupFocus,
  overlayPage,
  popupFocusRequests,
  popupPage,
  popupToasts,
  popupWindowState,
  pressKeys,
  PRIMARY,
  selectedProjectKey,
  setWindowFocused,
  SHELL_URL,
  shellState,
  viewFocused,
} from './support/shell';
import { addProject, answerDialogs, askedDialogs, chatInput, clickMenu, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho, TRUST_PROMPT } from './support/ui';
import { chatList, chatRow, listChats, projectKeyOf, readyShell } from './support/shell-ui';
import { outsideActivation, outsideRestore } from './support/window-activation';

const selectedChat = async (app: ElectronApplication): Promise<string | undefined> => (await shellState(app)).selected.chatId;
const urlOf = (page: Page): string => `/panel/${panelIdOf(page)}/`;

async function menuItemEnabled(app: ElectronApplication, id: string): Promise<boolean> {
  return app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? false, id);
}

/** Whether the window's own page (the shell) holds keyboard focus rather than a chat view. */
async function shellFocused(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isFocused());
}

/** Waits for the selection to move to a chat other than `previous`, and returns its page once it is ready. */
async function nextSelected(app: ElectronApplication, previous: string | undefined): Promise<{ id: string; page: Page }> {
  await expect.poll(async () => {
    const id = await selectedChat(app);
    return id !== undefined && id !== previous;
  }).toBe(true);
  const page = await activeChat(app);
  await expect(chatInput(page)).toBeVisible();
  return { id: (await selectedChat(app))!, page };
}

const HOLD_CHAT_PAGES = path.join(__dirname, 'support', 'hold-chat-pages.cjs');

interface ChatPages {
  held(): number;
  release(): void;
  focusGains(id: number): number;
  domReady(id: number): boolean;
}

async function heldChatPages(app: ElectronApplication): Promise<number> {
  return app.evaluate(() => (globalThis as unknown as { __e2eChatPages: ChatPages }).__e2eChatPages.held());
}

async function releaseChatPages(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => (globalThis as unknown as { __e2eChatPages: ChatPages }).__e2eChatPages.release());
}

/** How many times the page's view gained keyboard focus, and whether its document is ready, as main saw them. */
async function chatPageFocus(app: ElectronApplication, page: Page): Promise<{ gains: number; ready: boolean }> {
  return app.evaluate(({ webContents }, url) => {
    const pages = (globalThis as unknown as { __e2eChatPages: ChatPages }).__e2eChatPages;
    const id = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.id;
    return { gains: pages.focusGains(id), ready: pages.domReady(id) };
  }, page.url());
}

// The window's activation focuses the window's own page first; the chat's composer then takes focus once, from main.
test('a launch focuses the selected chat\'s composer once its page is ready, and New Chat focuses the chat it opens', async ({ foreground: _foreground, launch }) => {
  const { app } = await launch({ require: HOLD_CHAT_PAGES });
  await expect.poll(() => heldChatPages(app)).toBe(1);
  await expect.poll(() => shellFocused(app)).toBe(true);
  await releaseChatPages(app);
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeFocused();
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  expect(await shellFocused(app)).toBe(false);
  expect(await chatPageFocus(app, chat)).toEqual({ gains: 1, ready: true });

  await clickMenu(app, 'damocles.newChat');
  const opened = await nextChat(app, [chat]);
  await expect(chatInput(opened)).toBeVisible();
  await expect.poll(() => viewFocused(app, opened)).toBe(true);
  expect(await shellFocused(app)).toBe(false);
});

const mainWindowFocused = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.isFocused(), SHELL_URL);

/** Activates another window of the app, as Alt+Tab away does. */
async function switchAway(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const other = new BrowserWindow({ width: 320, height: 240, show: false });
    (globalThis as unknown as { __e2eOther: Electron.BrowserWindow }).__e2eOther = other;
    other.show();
    other.focus();
  });
  await expect.poll(() => mainWindowFocused(app)).toBe(false);
}

/** Activates the main window again after switchAway, as Alt+Tab back does. */
async function switchBack(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }, url) => {
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.focus();
  }, SHELL_URL);
  await expect.poll(() => mainWindowFocused(app)).toBe(true);
  await app.evaluate(() => (globalThis as unknown as { __e2eOther: Electron.BrowserWindow }).__e2eOther.destroy());
}

async function switchAwayAndBack(app: ElectronApplication): Promise<void> {
  await switchAway(app);
  await switchBack(app);
}

test('switching to another window and back returns keyboard focus to the part the user left', async ({ foreground: _foreground, launch }) => {
  const { app } = await launch();
  const shell = await readyShell(app);
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeFocused();
  await expect.poll(() => viewFocused(app, chat)).toBe(true);

  await switchAwayAndBack(app);
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  expect(await shellFocused(app)).toBe(false);
  await expect(chatInput(chat)).toBeFocused();

  // A part of the window's own page keeps focus too.
  await pressKeys(app, urlOf(chat), 'F6');
  await expect(chatList(shell)).toBeFocused();
  await switchAwayAndBack(app);
  await expect.poll(() => shellFocused(app)).toBe(true);
  expect(await viewFocused(app, chat)).toBe(false);
  await expect(chatList(shell)).toBeFocused();
});

// A question asked while the window is inactive waits for it to activate to take focus and flashes the taskbar button; when
// it is answered first, as a test runner or another app holding the foreground makes happen, neither outlives it.
test('a question answered while the window is inactive leaves keyboard focus where the user left it, and its flash stops with it', async ({ foreground: _foreground, home, launch }) => {
  const { app } = await launch();
  await addProject(app, home.project, false);
  const shell = await readyShell(app);
  const chat = await activeChat(app);
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  await pressKeys(app, urlOf(chat), 'F6');
  await expect(chatList(shell)).toBeFocused();
  await app.evaluate(({ BrowserWindow }, url) => {
    const flashes: boolean[] = [];
    (globalThis as unknown as { __e2eFlashes: boolean[] }).__e2eFlashes = flashes;
    BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.flashFrame = (on) => {
      flashes.push(on);
    };
  }, SHELL_URL);

  await switchAway(app);
  await answerDialogs(app, { [TRUST_PROMPT]: "Don't Trust" });
  const key = await projectKeyOf(app, 'alpha');
  await shell.evaluate((projectKey) => window.damoclesShell!.grantTrust(projectKey), key);
  expect((await askedDialogs(app)).filter((dialog) => dialog.message.startsWith(TRUST_PROMPT)).map((dialog) => dialog.answered)).toEqual(["Don't Trust", "Don't Trust"]);
  expect(await app.evaluate(() => (globalThis as unknown as { __e2eFlashes: boolean[] }).__e2eFlashes)).toEqual([true, false]);

  await switchBack(app);
  await expect.poll(() => shellFocused(app)).toBe(true);
  expect(await viewFocused(app, chat)).toBe(false);
  await expect(chatList(shell)).toBeFocused();
});

async function mainWindowMinimized(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.isMinimized(), SHELL_URL);
}

/** Launches the app again on the same home; it hands its arguments to the running app, which shows its window, and exits. */
async function secondLaunch(home: HermeticHome): Promise<void> {
  const electronBinary = (await import('electron')).default as unknown as string;
  const child = spawn(electronBinary, [MAIN_SCRIPT, '--user-data-dir', home.userData], { env: hermeticEnv(home), stdio: 'ignore' });
  expect(await new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)))).toBe(0);
}

// Each restore starts as soon as the window reports itself minimized, which on macOS can be before AppKit reports its
// blur; X11 sends focus to a window it is minimizing.
test('restoring the minimized window returns keyboard focus to the chat composer', async ({ foreground: _foreground, home, launch }) => {
  const { app } = await launch();
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeFocused();
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  const activate = outsideActivation();
  const restoreFromOutside = outsideRestore();
  const restores: Array<[string, () => Promise<void>]> = [
    ['BrowserWindow.restore()', async () => {
      await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.restore(), SHELL_URL);
    }],
    ['a second launch', () => secondLaunch(home)],
    ...(activate ? [['an activation from outside the app', () => activate(app)] as [string, () => Promise<void>]] : []),
    // Windows reports 'focus' before 'restore' here while isFocused() is still false.
    ...(restoreFromOutside ? [['ShowWindow(SW_RESTORE) and SetForegroundWindow from outside the app', () => restoreFromOutside(app)] as [string, () => Promise<void>]] : []),
  ];

  for (const [how, restore] of restores) {
    await app.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL() === url)!.minimize(), SHELL_URL);
    await expect.poll(() => mainWindowMinimized(app), { message: how }).toBe(true);
    await restore();
    await expect.poll(() => viewFocused(app, chat), { message: how }).toBe(true);
    expect(await mainWindowMinimized(app), how).toBe(false);
    expect(await shellFocused(app), how).toBe(false);
    await expect(chatInput(chat), how).toBeFocused();
  }
});

// A CDP key press never reaches before-input-event, where main sees the user's keys, so the key goes through pressKeys.
for (const [action, act] of [
  ['a click', async (_app: ElectronApplication, shell: Page) => {
    await shell.getByTestId('chat-search-toggle').click();
    await expect(shell.getByTestId('chat-search')).toBeFocused();
  }],
  ['a key', async (app: ElectronApplication, shell: Page) => {
    await pressKeys(app, SHELL_URL, 'Tab');
    // On macOS the key reaches the page through the window server, after pressKeys returns.
    await expect(shell.getByTestId('app-menu')).toBeFocused();
  }],
] as const) {
  test(`${action} in the window before the chat's page is ready keeps keyboard focus where the user put it`, async ({ foreground: _foreground, launch }) => {
    const { app } = await launch({ require: HOLD_CHAT_PAGES });
    await expect.poll(() => heldChatPages(app)).toBe(1);
    const shell = await readyShell(app);
    await expect.poll(() => shellFocused(app)).toBe(true);
    await act(app, shell);
    const userFocus = await shell.evaluate(() => document.activeElement?.outerHTML.slice(0, 200));

    await releaseChatPages(app);
    const chat = await activeChat(app);
    await expect.poll(async () => (await chatPageFocus(app, chat)).ready).toBe(true);
    await expect(chatInput(chat)).toBeVisible();
    expect(await chatPageFocus(app, chat)).toEqual({ gains: 0, ready: true });
    expect(await viewFocused(app, chat)).toBe(false);
    expect(await shellFocused(app)).toBe(true);
    expect(await shell.evaluate(() => document.activeElement?.outerHTML.slice(0, 200))).toBe(userFocus);
  });
}

test('menu accelerators work while focus is in the chat view: New Chat, Next and Previous Chat, Toggle Sidebar, F6 and the prompt navigator', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const shell = await readyShell(app);
    // A test runner's window may never hold OS focus, and a turn settling in an unfocused window raises a done popup,
    // which would make the popups an F6 stop; the window reports itself focused instead.
    await setWindowFocused(app, true);
    const first = await activeChat(app);
    await expect(chatInput(first)).toBeVisible();
    await sendAndAwaitEcho(first, 'first chat');
    await expect.poll(async () => (await selectedChat(app))?.startsWith('new:')).toBe(false);
    const firstId = (await selectedChat(app))!;

    // New Chat: Ctrl+N (Cmd+N on macOS) from the chat view starts a chat in the selected project.
    await pressKeys(app, urlOf(first), 'N', [PRIMARY]);
    const second = await nextSelected(app, firstId);
    expect(second.id.startsWith('new:')).toBe(true);
    await sendAndAwaitEcho(second.page, 'second chat');
    await expect.poll(async () => (await selectedChat(app))?.startsWith('new:')).toBe(false);
    const secondId = (await selectedChat(app))!;
    // Next and Previous Chat walk the sidebar's list, which lists the second chat once its first prompt is stored.
    await expect.poll(async () => (await listChats(app)).chats.map((chat) => chat.id).sort()).toEqual([firstId, secondId].sort());

    // Next and Previous Chat, with both key pairs.
    await pressKeys(app, urlOf(second.page), 'Tab', ['control']);
    await expect.poll(() => selectedChat(app)).toBe(firstId);
    await pressKeys(app, urlOf(first), 'Tab', ['control', 'shift']);
    await expect.poll(() => selectedChat(app)).toBe(secondId);
    await pressKeys(app, urlOf(second.page), 'PageDown', [PRIMARY]);
    await expect.poll(() => selectedChat(app)).toBe(firstId);
    await pressKeys(app, urlOf(first), 'PageUp', [PRIMARY]);
    await expect.poll(() => selectedChat(app)).toBe(secondId);

    // Toggle Sidebar: Ctrl+B (Cmd+B) from the chat view hides and shows the sidebar.
    await pressKeys(app, urlOf(second.page), 'B', [PRIMARY]);
    await expect.poll(async () => (await shellState(app)).layout.sidebarVisible).toBe(false);
    // The sidebar slides out of view and leaves the focus order.
    await expect(shell.getByTestId('sidebar')).toHaveAttribute('inert', '');
    await expect(shell.getByTestId('toggle-sidebar')).toHaveAttribute('aria-pressed', 'false');
    await pressKeys(app, urlOf(second.page), 'B', [PRIMARY]);
    await expect.poll(async () => (await shellState(app)).layout.sidebarVisible).toBe(true);
    await expect(shell.getByTestId('sidebar')).not.toHaveAttribute('inert');

    // F6 from the chat view lands on the sidebar's current row; the next F6 goes back to the chat.
    await pressKeys(app, urlOf(second.page), 'F6');
    await expect.poll(() => shellFocused(app)).toBe(true);
    await expect(chatList(shell)).toBeFocused();
    const activeRowId = await chatList(shell).getAttribute('aria-activedescendant');
    expect(activeRowId).toBe(await chatRow(shell, secondId).getAttribute('id'));
    // The listbox works by keyboard alone: Down moves the active row, Enter selects it.
    await shell.keyboard.press('ArrowDown');
    await expect(chatList(shell)).toHaveAttribute('aria-activedescendant', (await chatRow(shell, firstId).getAttribute('id'))!);
    await shell.keyboard.press('Enter');
    await expect.poll(() => selectedChat(app)).toBe(firstId);
    await pressKeys(app, '/shell/', 'F6');
    await expect.poll(() => shellFocused(app)).toBe(false);

    // Open Chat: Ctrl+Shift+U (Cmd+Shift+U) opens a chat as well.
    await pressKeys(app, urlOf(first), 'U', [PRIMARY, 'shift']);
    const third = await nextSelected(app, firstId);

    // Prompt navigator: Ctrl+K (Cmd+K) reaches the selected chat through the same message VS Code's command posts.
    await recordHostMessages(third.page);
    await pressKeys(app, urlOf(third.page), 'K', [PRIMARY]);
    await expect.poll(async () => (await hostMessages(third.page, 'togglePromptNavigator')).length).toBe(1);

    // Browser DevTools (F12) is bound only while a page tab is the active editor tab, and New Browser Page only with the browser feature on.
    expect(await menuItemEnabled(app, 'damocles.togglePromptNavigator')).toBe(true);
    expect(await menuItemEnabled(app, 'damocles.browser.toggleDevTools')).toBe(false);
    expect(await menuItemEnabled(app, 'damocles.browser.newPage')).toBe(false);
  } finally {
    await stub.close();
  }
});

// Text of the crash notice in src/desktop/main/index.ts and of the notice src/core/chat-panel/message-router/handlers/workspace-handlers.ts shows.
const GAVE_UP = 'A chat stopped working because its page kept crashing.';
const NO_SESSION = 'No active session to view';

/** Whether the popup window is the active window and its page holds keyboard focus. */
async function popupFocused(app: ElectronApplication): Promise<boolean> {
  const popup = await popupWindowState(app);
  return popup !== undefined && popup.focused && popup.pageFocused;
}

async function popupVisible(app: ElectronApplication): Promise<boolean> {
  return (await popupWindowState(app))?.visible ?? false;
}

/** The accessible name of the popup page's focused control in the toast stack, with its focus ring showing. */
async function focusedToastControl(popup: Page): Promise<string | null> {
  return popup.evaluate(() => {
    const active = document.activeElement;
    if (!active?.matches(':focus-visible') || !active.closest('[data-testid="overlay-toasts"]')) return null;
    return active.getAttribute('aria-label') ?? active.textContent?.trim() ?? null;
  });
}

test('F6 reaches the desktop popups only while one shows, Tab stays in them, Enter runs an action and Escape leaves, and focus returns to the part it came from', async ({ foreground: _foreground, launch }, testInfo) => {
  test.setTimeout(180_000);
  const desktop = await launch();
  const { app } = desktop;
  const shell = await readyShell(app);
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeVisible();

  // F6 from the chat focuses the popup window and lands on a notice's Dismiss button with its ring showing; Tab stays in
  // the stack, and Escape leaves the popup showing and gives focus back to the chat in the main window.
  await postFromWebview(chat, { type: 'openSessionLog' });
  const popup = await popupPage(app);
  const notice = popupToasts(popup).filter({ hasText: NO_SESSION });
  await expect(notice).toBeVisible();
  expect(await popupFocused(app)).toBe(false);
  await countPopupFocus(app);
  await pressKeys(app, urlOf(chat), 'F6');
  await expect.poll(() => popupFocusRequests(app)).toBe(1);
  await expect.poll(() => focusedToastControl(popup)).toBe('Dismiss notification');
  await popup.keyboard.press('Tab');
  expect(await focusedToastControl(popup)).toBe('Dismiss notification');
  await popup.keyboard.press('Escape');
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  expect(await popupFocused(app)).toBe(false);
  await expect(notice).toBeVisible();

  // Shift+F6 from the sidebar wraps to it too; dismissing it there hides the window and gives focus back to the sidebar.
  await pressKeys(app, urlOf(chat), 'F6', ['shift']);
  await expect(chatList(shell)).toBeFocused();
  await pressKeys(app, '/shell/', 'F6', ['shift']);
  await expect.poll(() => popupFocusRequests(app)).toBe(2);
  await expect.poll(() => focusedToastControl(popup)).toBe('Dismiss notification');
  await popup.keyboard.press('Enter');
  await expect.poll(() => popupVisible(app)).toBe(false);
  await expect.poll(() => shellFocused(app)).toBe(true);
  await expect(chatList(shell)).toBeFocused();

  // With no popup showing, F6 skips it: Shift+F6 from the sidebar wraps to the chat.
  await pressKeys(app, '/shell/', 'F6', ['shift']);
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  expect(await popupFocusRequests(app)).toBe(2);

  // A chat whose page keeps crashing leaves a Reload Chat toast: the fourth crash within a minute is not reloaded.
  const panelId = panelIdOf(chat);
  const loadedRenderer = (): Promise<number> => app.evaluate(({ webContents }, id) => {
    const w = webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`));
    return w && !w.isCrashed() && !w.isLoading() ? w.getOSProcessId() : 0;
  }, panelId);
  for (let i = 0; i < 4; i++) {
    await expect.poll(loadedRenderer).not.toBe(0);
    await app.evaluate(({ webContents }, id) => {
      webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`))!.forcefullyCrashRenderer();
    }, panelId);
    await expect.poll(() => desktop.output().split(`[views] panel ${panelId} renderer gone`).length - 1).toBe(i + 1);
  }
  await expect(popupToasts(popup).filter({ hasText: GAVE_UP })).toBeVisible();

  // F6 reaches the toast's action; Enter runs it: the chat loads again, which focuses it, and the emptied popup window hides without keeping focus.
  await pressKeys(app, '/shell/', 'F6', ['shift']);
  await expect.poll(() => popupFocusRequests(app)).toBe(3);
  await expect.poll(() => focusedToastControl(popup)).toBe('Reload Chat');
  await saveScreenshot(popup, testInfo, 'toast-keyboard-focus');
  await popup.keyboard.press('Enter');
  await expect.poll(loadedRenderer).not.toBe(0);
  await expect.poll(() => popupVisible(app)).toBe(false);
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  expect(await popupFocused(app)).toBe(false);
});

test('copy, paste and select all work in the chat input through the platform shortcuts', async ({ clipboard, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await activeChat(app);
    const input = chatInput(tab);
    await expect(input).toBeVisible();
    const page = urlOf(tab);
    await clipboard.writeText(app, '');

    await input.fill('copy me across');
    await input.focus();
    await pressKeys(app, page, 'A', [PRIMARY]);
    await expect.poll(() => tab.evaluate(() => {
      const el = document.activeElement as HTMLTextAreaElement | null;
      return el ? el.value.slice(el.selectionStart, el.selectionEnd) : '';
    })).toBe('copy me across');
    await pressKeys(app, page, 'C', [PRIMARY]);
    await expect.poll(() => clipboard.readText(app)).toBe('copy me across');

    await input.fill('');
    await input.focus();
    await pressKeys(app, page, 'V', [PRIMARY]);
    await expect(input).toHaveValue('copy me across');
  } finally {
    await stub.close();
  }
});

test('Find in Files, Replace in Files and Show All Commands work from the chat view and the editor; Find in Files seeds the editor\'s selection', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'a.ts'), 'const seededWord = 1;\n');
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  const shell = await readyShell(app);
  const query = shell.getByTestId('search-query');

  // From the chat view: the sidebar's Search section opens with its query focused.
  await pressKeys(app, urlOf(chat), 'F', [PRIMARY, 'shift']);
  await expect(query).toBeFocused();
  await expect(shell.getByTestId('search-section').locator('button[aria-expanded]').first()).toHaveAttribute('aria-expanded', 'true');
  await expect(shell.getByTestId('search-replace')).toHaveCount(0);
  await pressKeys(app, urlOf(chat), 'H', [PRIMARY, 'shift']);
  await expect(shell.getByTestId('search-replace')).toBeVisible();
  await expect(query).toBeFocused();

  // From the editor: a single-line selection becomes the query, selected so typing replaces it.
  await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'src/a.ts' });
  await editorShows(shell, 'seededWord');
  await codeEditor(shell).locator('.view-line', { hasText: 'seededWord' }).getByText('seededWord').dblclick();
  await pressKeys(app, '/shell/', 'F', [PRIMARY, 'shift']);
  await expect(query).toHaveValue('seededWord');
  await expect(query).toBeFocused();
  expect(await query.evaluate((input) => [(input as HTMLInputElement).selectionStart, (input as HTMLInputElement).selectionEnd])).toEqual([0, 'seededWord'.length]);

  const overlay = await overlayPage(app);
  await pressKeys(app, urlOf(chat), 'P', [PRIMARY, 'shift']);
  await expect(overlay.getByTestId('quick-pick')).toBeVisible();
  await expect(overlay.getByTestId('quick-pick-input')).toHaveValue('>');
  await overlay.getByTestId('quick-pick-input').press('Escape');
  await expect(overlay.getByTestId('quick-pick')).toHaveCount(0);
});
