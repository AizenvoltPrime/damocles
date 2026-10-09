import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';
import { activeChat, expect, nextChat, test } from '../support/fixtures';
import { seedStubModel } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { answerTagPicker, confirmDialog, overlayMenu, readyOverlay } from '../support/overlay';
import { openProjectChat, saveScreenshot, settled, showTheme, THEMES } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { shellState } from '../support/shell';
import { chatRow, clickChat, clickRowAction, readyShell } from '../support/shell-ui';
import { chatInput, sendAndAwaitEcho } from '../support/ui';

// Review captures of the title bar, the Projects and Chats sidebar, its row actions and its overlay menus and dialogs.

const selectedChatId = async (app: ElectronApplication): Promise<string> => (await shellState(app)).selected.chatId ?? '';

/** A new chat from the sidebar's New button, and its page once loaded. */
async function newChat(app: ElectronApplication, shell: Page, known: Page[]): Promise<Page> {
  const before = await selectedChatId(app);
  const opened = nextChat(app, known);
  await shell.getByTestId('new-chat').click();
  await expect.poll(async () => {
    const id = await selectedChatId(app);
    return id !== before && id.startsWith('new:');
  }).toBe(true);
  const page = await opened;
  await expect(chatInput(page)).toBeVisible();
  return page;
}

/** Sends one prompt and returns the chat's id once its session file exists. */
async function storeChat(app: ElectronApplication, page: Page, prompt: string): Promise<string> {
  await sendAndAwaitEcho(page, prompt);
  await expect.poll(async () => (await selectedChatId(app)).startsWith('new:')).toBe(false);
  return selectedChatId(app);
}

async function captureOverlay(app: ElectronApplication, overlay: Page, testInfo: TestInfo, name: string, open: () => Promise<void>, popup: (overlay: Page) => Locator): Promise<void> {
  await open();
  await expect(popup(overlay)).toBeVisible();
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, name);
  await overlay.keyboard.press('Escape');
  await expect(popup(overlay)).toHaveCount(0);
  await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isFocused())).toBe(true);
}

test('the sidebar in Dark and Light, its row actions, chat menus and delete warnings', async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const routes = path.join(home.project, 'routes.ts');
  fs.writeFileSync(routes, "export const login = '/login';\n");
  const stub = await startOpenAIStub();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const first = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 800);
    const shell = await readyShell(app);

    const limiter = await storeChat(app, first, 'Rate-limit the /login route');
    const second = await newChat(app, shell, [first]);
    const tests = await storeChat(app, second, 'Add a test for the 429 case');
    await clickRowAction(shell, tests, 'tag');
    await answerTagPicker(app, 'auth');
    await expect(chatRow(shell, tests).getByTestId('chat-tag')).toHaveText('auth');
    await newChat(app, shell, [first, second]);
    const unsaved = await selectedChatId(app);

    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await saveScreenshot(shell, testInfo, `shell-sidebar-${theme}`);
    }
    await showTheme(app, shell, 'dark');
    for (const [name, id] of [['saved', limiter], ['new', unsaved]] as const) {
      await chatRow(shell, id).hover();
      await settled(shell);
      await saveScreenshot(shell, testInfo, `shell-row-hover-${name}-dark`, shell.getByTestId('sidebar'));
    }
    await shell.mouse.move(900, 400);

    const overlay = await readyOverlay(app);
    await captureOverlay(app, overlay, testInfo, 'shell-chat-menu-dark', () => chatRow(shell, limiter).click({ button: 'right' }), overlayMenu);
    await captureOverlay(app, overlay, testInfo, 'shell-new-chat-menu-dark', () => chatRow(shell, unsaved).click({ button: 'right' }), overlayMenu);
    await captureOverlay(app, overlay, testInfo, 'shell-delete-idle-dark', () => clickRowAction(shell, limiter, 'delete'), confirmDialog);

    // A running chat: its reply holds after the first chunk. The title request may take one held reply first.
    await clickChat(shell, limiter);
    await expect.poll(() => selectedChatId(app)).toBe(limiter);
    stub.replies.push({ chunks: ['Echo: ', 'long turn'], holdAfterFirst: held }, { chunks: ['Echo: ', 'long turn'], holdAfterFirst: held });
    const running = await activeChat(app);
    await chatInput(running).fill('long turn');
    await chatInput(running).press('Enter');
    await expect(chatRow(shell, limiter)).toHaveAttribute('data-status', 'running');
    await captureOverlay(app, overlay, testInfo, 'shell-delete-running-dark', () => clickRowAction(shell, limiter, 'delete'), confirmDialog);
    release();
    await expect(chatRow(shell, limiter)).toHaveAttribute('data-status', 'idle');
    // The held reply no title request took would answer the next prompt.
    stub.replies.splice(0);

    // A chat waiting on the user: an edit awaits approval.
    await clickChat(shell, tests);
    await expect.poll(() => selectedChatId(app)).toBe(tests);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: routes, old_string: "export const login = '/login';", new_string: "export const login = '/login';\nexport const loginLimit = { windowMs: 60_000, max: 5 };" } }] });
    const waiting = await activeChat(app);
    await chatInput(waiting).fill('Add the limit settings');
    await chatInput(waiting).press('Enter');
    await expect(chatRow(shell, tests)).toHaveAttribute('data-status', 'waiting');
    await captureOverlay(app, overlay, testInfo, 'shell-delete-waiting-dark', () => clickRowAction(shell, tests, 'delete'), confirmDialog);
  } finally {
    release();
    await stub.close();
  }
});
