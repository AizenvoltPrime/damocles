import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { saveScreenshot } from './support/screenshots';
import {
  countPopupFocus,
  popupFocusRequests,
  popupPage,
  popupToasts,
  popupWindowState,
  pressKeys,
  PRIMARY,
  setWindowFocused,
  shellState,
  viewFocused,
} from './support/shell';
import { chatInput, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho } from './support/ui';
import { chatList, chatRow, listChats, readyShell } from './support/shell-ui';

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

test('menu accelerators work while focus is in the chat view: New Chat, Next and Previous Chat, Toggle Sidebar, F6 and the prompt navigator', async ({ home, launch }) => {
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

    // Browser DevTools (F12) and Close Page are bound only to a shown page, and the pane toggle only with the browser feature on.
    expect(await menuItemEnabled(app, 'damocles.togglePromptNavigator')).toBe(true);
    expect(await menuItemEnabled(app, 'damocles.browser.toggleDevTools')).toBe(false);
    expect(await menuItemEnabled(app, 'damocles.browser.togglePane')).toBe(false);
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

test('F6 reaches the desktop popups only while one shows, Tab stays in them, Enter runs an action and Escape leaves, and focus returns to the part it came from', async ({ launch }, testInfo) => {
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

test('copy, paste and select all work in the chat input through the platform shortcuts', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await activeChat(app);
    const input = chatInput(tab);
    await expect(input).toBeVisible();
    const page = urlOf(tab);
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));

    await input.fill('copy me across');
    await input.focus();
    await pressKeys(app, page, 'A', [PRIMARY]);
    await expect.poll(() => tab.evaluate(() => {
      const el = document.activeElement as HTMLTextAreaElement | null;
      return el ? el.value.slice(el.selectionStart, el.selectionEnd) : '';
    })).toBe('copy me across');
    await pressKeys(app, page, 'C', [PRIMARY]);
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toBe('copy me across');

    await input.fill('');
    await input.focus();
    await pressKeys(app, page, 'V', [PRIMARY]);
    await expect(input).toHaveValue('copy me across');
  } finally {
    await stub.close();
  }
});
