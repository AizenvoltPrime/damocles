import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { OVERLAY_CHANNELS, type OverlayToast } from '../../../src/desktop/preload/overlay-channels';
import type { NotificationBody } from '../../../src/desktop/preload/notifications';
import { SHELL_CHANNELS, type ShellChat, type ShellChatList, type ShellState } from '../../../src/desktop/preload/shell-channels';
import { activeChat, expect, nextChat, test } from '../support/fixtures';
import { seedStubModel } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { answerTagPicker, confirmDialog, overlayMenu, readyOverlay, tagPicker } from '../support/overlay';
import { openProjectChat, setPageSize, settled, showTheme, THEMES } from '../support/screenshots';
import { openSettingsModal, setContentSize, settingsModal } from '../support/settings';
import { NOTIFIER_URL, popupPage, SHELL_URL, setWindowFocused, shellPage, shellState } from '../support/shell';
import { chatRow, clickChat, clickRowAction, listChats, readyShell } from '../support/shell-ui';
import { addProject, answerOpenDialog, chatInput, clickMenu, sendAndAwaitEcho } from '../support/ui';
import { pushUpdateState, snapshotOf } from '../support/updates';

// Pixel comparisons of every desktop renderer surface against a stored baseline (`toHaveScreenshot`); run with
// --update-snapshots to record the baseline, and without it to prove a change moved no pixel. A config that sets
// snapshotPathTemplate decides where the baseline lives.

const SHOT = { maxDiffPixels: 0, animations: 'disabled' } as const;
const WIDTH = 1280;
const HEIGHT = 800;

// Texts that follow the wall clock are pinned before a capture, so a run a minute later compares equal.
const CHAT_ROW_TIME = '[role="option"][data-chat-id] > span:nth-child(2) > span:nth-child(2) > span:first-child';

async function pinText(page: Page, selector: string, text: string): Promise<void> {
  await page.locator(selector).evaluateAll((elements, value) => {
    for (const element of elements) element.textContent = value;
  }, text);
}

// Rewrites the matches of `pattern` in the text under `selector`, keeping the element structure.
async function pinMatches(page: Page, selector: string, pattern: RegExp, replacement: string): Promise<void> {
  await page.locator(selector).evaluateAll((elements, [source, flags, value]) => {
    const regex = new RegExp(source, flags);
    for (const element of elements) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) node.textContent = node.textContent!.replace(regex, value);
    }
  }, [pattern.source, pattern.flags, replacement] as const);
}

async function shoot(page: Page, name: string, target?: Locator, mask: Locator[] = []): Promise<void> {
  await settled(page);
  await pinText(page, CHAT_ROW_TIME, '12:00');
  await expect(target ?? page).toHaveScreenshot(`${name}.png`, { ...SHOT, mask });
}

// The overlay and the popup window are transparent over what lies beneath; a capture paints the theme's background behind.
async function shootOverlay(page: Page, name: string, mask: Locator[] = []): Promise<void> {
  await page.evaluate(() => {
    document.body.style.backgroundColor = 'var(--d-bg)';
  });
  await shoot(page, name, undefined, mask);
  await page.evaluate(() => {
    document.body.style.backgroundColor = '';
  });
}

async function pushShellState(app: ElectronApplication, state: ShellState): Promise<void> {
  await app.evaluate(({ webContents }, { url, channel, value }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (!contents) throw new Error(`no page at ${url}`);
    contents.send(channel, value);
  }, { url: SHELL_URL, channel: SHELL_CHANNELS.state, value: state });
}

async function sendToasts(app: ElectronApplication, toasts: readonly OverlayToast[]): Promise<void> {
  await app.evaluate(({ webContents }, { url, channel, list }) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    for (const toast of list) target.send(channel, toast);
  }, { url: NOTIFIER_URL, channel: OVERLAY_CHANNELS.toast, list: toasts });
}

function toast(id: string, body: NotificationBody, lifeMs: number, remainingMs: number): OverlayToast {
  return { id, at: Date.now() - 90_000, lifeMs, remainingMs, body };
}

const selectedChatId = async (app: ElectronApplication): Promise<string> => (await shellState(app)).selected.chatId ?? '';

async function storeChat(app: ElectronApplication, page: Page, prompt: string): Promise<string> {
  await sendAndAwaitEcho(page, prompt);
  await expect.poll(async () => (await selectedChatId(app)).startsWith('new:')).toBe(false);
  return selectedChatId(app);
}

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

// Main answers the shell's chat list with `list`, or rejects it for 'fail', then tells the shell to refetch. A deliberate
// rejection drops Electron's handler error line from main's log, which the launch fixture otherwise fails on.
async function serveChatList(app: ElectronApplication, projectKey: string, list: Omit<ShellChatList, 'projectKey'> | 'fail'): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, value }) => {
    const scope = globalThis as { originalConsoleError?: typeof console.error };
    const log = (scope.originalConsoleError ??= console.error);
    console.error = value === 'fail' ? (...args: unknown[]) => { if (!String(args[0]).includes(channel)) log(...args); } : log;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (_event, key: string) => {
      if (value === 'fail') throw new Error('chat list unavailable');
      return { ...value, projectKey: key };
    });
  }, { channel: SHELL_CHANNELS.chatsList, value: list });
  await app.evaluate(({ webContents }, { url, channel, key }) => {
    webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.send(channel, key);
  }, { url: SHELL_URL, channel: SHELL_CHANNELS.chatsChanged, key: projectKey });
}

const LISTED_AT = Date.UTC(2025, 0, 15, 12);
const listedChat = (id: string, title: string, tag: string): ShellChat => ({ id, title, tag, timestamp: LISTED_AT, status: 'idle', loaded: false });
const TAGGED_CHATS: readonly ShellChat[] = [
  listedChat('c1', 'Rate-limit the /login route', 'authentication'),
  listedChat('c2', 'Add a test for the 429 case', 'authentication'),
  listedChat('c3', 'Index the sessions table', 'database'),
  listedChat('c4', 'Split the settings bundle', 'performance'),
  listedChat('c5', 'Draft the 3.5 notes', 'release'),
  listedChat('c6', 'Document the lockout', 'docs'),
];

async function closeWith(overlay: Page, popup: Locator): Promise<void> {
  await overlay.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
}

test('the shell, its title bar, sidebar states, update pill, menus, pickers, dialogs and settings', async ({ foreground: _foreground, home, launch }) => {
  test.setTimeout(420_000);
  const routes = path.join(home.project, 'routes.ts');
  fs.writeFileSync(routes, "export const login = '/login';\n");
  const beta = path.join(path.dirname(home.project), 'beta');
  fs.mkdirSync(beta, { recursive: true });
  const stub = await startOpenAIStub();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const first = await openProjectChat(app, home.project);
    await setContentSize(app, WIDTH, HEIGHT);
    const shell = await readyShell(app);
    const alphaKey = (await shellState(app)).selected.projectKey!;

    const limiter = await storeChat(app, first, 'Rate-limit the /login route');
    const second = await newChat(app, shell, [first]);
    const tests = await storeChat(app, second, 'Add a test for the 429 case');
    await clickRowAction(shell, tests, 'tag');
    await answerTagPicker(app, 'auth');
    await expect(chatRow(shell, tests).getByTestId('chat-tag')).toHaveText('auth');

    // An untrusted second project, then back to alpha.
    await addProject(app, beta, false);
    await shell.locator(`[role="option"][data-project-key]`).first().click();
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(alphaKey);

    // A chat waiting on the user: an edit awaits approval.
    await clickChat(shell, tests);
    await expect.poll(() => selectedChatId(app)).toBe(tests);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: routes, old_string: "export const login = '/login';", new_string: "export const login = '/login';\nexport const loginLimit = 5;" } }] });
    const waiting = await activeChat(app);
    await chatInput(waiting).fill('Add the limit settings');
    await chatInput(waiting).press('Enter');
    await expect(chatRow(shell, tests)).toHaveAttribute('data-status', 'waiting');

    // A running chat: its reply holds after the first chunk. The title request may take one held reply first.
    await clickChat(shell, limiter);
    await expect.poll(() => selectedChatId(app)).toBe(limiter);
    stub.replies.push({ chunks: ['Echo: ', 'long turn'], holdAfterFirst: held }, { chunks: ['Echo: ', 'long turn'], holdAfterFirst: held });
    const running = await activeChat(app);
    await chatInput(running).fill('long turn');
    await chatInput(running).press('Enter');
    await expect(chatRow(shell, limiter)).toHaveAttribute('data-status', 'running');

    // The list orders by last activity; nothing writes to either chat while it runs held or waits.
    await expect.poll(async () => (await listChats(app, alphaKey)).chats.map((chat) => chat.id)).toEqual([limiter, tests]);

    // A new chat with no conversation yet, selected.
    await newChat(app, shell, [first, second, running, waiting]);
    await shell.mouse.move(900, 400);

    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await shoot(shell, `shell-${theme}`);
      await chatRow(shell, tests).hover();
      await shoot(shell, `sidebar-row-hover-${theme}`, shell.getByTestId('sidebar'));
      await shell.mouse.move(900, 400);
    }
    await showTheme(app, shell, 'dark');

    // Darwin's title bar: the traffic-light inset and no window controls.
    const state = await shellState(app);
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await pushShellState(app, { ...state, platform: 'darwin' });
      await expect(shell.getByTestId('title-bar')).toHaveClass(/title-bar-darwin/);
      await shoot(shell, `title-bar-darwin-${theme}`, shell.getByTestId('title-bar'));
      await pushShellState(app, await shell.evaluate(() => window.damoclesShell!.getState()));
      await expect(shell.getByTestId('title-bar')).not.toHaveClass(/title-bar-darwin/);
    }

    // The chat slot with no chat selected, which main's chat view otherwise covers.
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await pushShellState(app, { ...state, selected: state.selected.projectKey === undefined ? {} : { projectKey: state.selected.projectKey } });
      await expect(shell.getByTestId('chat-slot').getByRole('button')).toBeVisible();
      await shoot(shell, `chat-slot-empty-${theme}`, shell.getByTestId('chat-slot'));
      await pushShellState(app, await shell.evaluate(() => window.damoclesShell!.getState()));
      await expect(shell.getByTestId('chat-slot').getByRole('button')).toHaveCount(0);
    }

    // The update pill, downloading and ready.
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await pushUpdateState(app, 'shell', snapshotOf({ kind: 'downloading', version: '9.9.0', percent: 42 }));
      await expect(shell.getByTestId('update-pill')).toHaveAttribute('data-state', 'downloading');
      await shoot(shell, `pill-downloading-${theme}`, shell.getByTestId('title-bar'));
      await pushUpdateState(app, 'shell', snapshotOf({ kind: 'ready', version: '9.9.0', notes: '' }));
      await expect(shell.getByTestId('update-pill')).toHaveAttribute('data-state', 'ready');
      await shoot(shell, `pill-ready-${theme}`, shell.getByTestId('title-bar'));
      await pushUpdateState(app, 'shell', snapshotOf({ kind: 'disabled' }));
      await expect(shell.getByTestId('update-pill')).toHaveCount(0);
    }
    await showTheme(app, shell, 'dark');

    // The sidebar's search, tag filter, inline rename and a collapsed Projects section.
    await shell.getByTestId('chat-search-toggle').click();
    await expect(shell.getByTestId('chat-search')).toBeVisible();
    await shoot(shell, 'sidebar-search-open-dark', shell.getByTestId('sidebar'));
    await shell.getByTestId('chat-search').fill('zzzz');
    await expect(shell.getByTestId('chats-no-match')).toBeVisible();
    await shoot(shell, 'sidebar-search-no-match-dark', shell.getByTestId('sidebar'));
    await shell.getByTestId('chat-search').fill('');
    await shell.getByTestId('chat-search-toggle').click();
    await expect(shell.getByTestId('chat-search')).toHaveCount(0);
    await shell.getByTestId('tag-chip').first().click();
    await expect(shell.getByTestId('tag-chip').first()).toHaveAttribute('aria-pressed', 'true');
    await shoot(shell, 'sidebar-tag-filter-dark', shell.getByTestId('sidebar'));
    await shell.getByTestId('tag-chip').first().click();
    await expect(shell.getByTestId('tag-chip').first()).toHaveAttribute('aria-pressed', 'false');
    await clickRowAction(shell, tests, 'rename');
    await expect(shell.getByTestId('chat-rename')).toBeVisible();
    await shell.mouse.move(900, 400);
    await shoot(shell, 'sidebar-rename-dark', shell.getByTestId('sidebar'));
    await shell.getByTestId('chat-rename').getByRole('textbox').press('Escape');
    await expect(shell.getByTestId('chat-rename')).toHaveCount(0);
    const projectsHeader = shell.getByTestId('sidebar-projects').locator('h2 button');
    await projectsHeader.click();
    await expect(projectsHeader).toHaveAttribute('aria-expanded', 'false');
    await shoot(shell, 'sidebar-projects-collapsed-dark', shell.getByTestId('sidebar'));
    await projectsHeader.click();
    await expect(projectsHeader).toHaveAttribute('aria-expanded', 'true');

    // Overlay popups: the chat context menu, the tag picker and the delete confirmation of a running chat.
    const overlay = await readyOverlay(app);
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await chatRow(shell, tests).click({ button: 'right' });
      await expect(overlayMenu(overlay)).toBeVisible();
      await shootOverlay(overlay, `context-menu-${theme}`);
      await closeWith(overlay, overlayMenu(overlay));

      await clickRowAction(shell, tests, 'tag');
      await expect(tagPicker(overlay)).toBeVisible();
      await shootOverlay(overlay, `tag-picker-${theme}`);
      await closeWith(overlay, tagPicker(overlay));

      await clickRowAction(shell, limiter, 'delete');
      await expect(confirmDialog(overlay)).toBeVisible();
      await shootOverlay(overlay, `confirm-delete-running-${theme}`);
      await closeWith(overlay, confirmDialog(overlay));
      await shell.mouse.move(900, 400);
    }

    // The settings modal: two desktop sections and About, whose release list follows CHANGELOG.md and is masked.
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      for (const section of ['application', 'appearance', 'about'] as const) {
        const modal = await openSettingsModal(app, section);
        await shootOverlay(modal, `settings-${section}-${theme}`, section === 'about' ? [modal.getByTestId('whats-new')] : []);
        await closeWith(modal, settingsModal(modal));
      }
    }
  } finally {
    release();
    await stub.close();
  }
});

test('the notification bell, its center, the popup toast stack and the trust dialog', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const file = path.join(home.project, 'auth.ts');
    fs.writeFileSync(file, 'export const limit = 5;\n');
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    await setContentSize(app, WIDTH, HEIGHT);
    const shell = await shellPage(app);
    const overlay = await readyOverlay(app);

    // The trust question (OverlayDialog).
    await answerOpenDialog(app, beta);
    await clickMenu(app, 'damocles.addProject');
    const dialog = overlay.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    // The hermetic home's temp folder name changes every run.
    await pinMatches(overlay, '[role="alertdialog"]', /Temp\\[^\\]+\\/g, 'Temp\\d0Ab1Cd\\');
    for (const theme of THEMES) {
      await showTheme(app, overlay, theme);
      await shootOverlay(overlay, `dialog-trust-${theme}`);
    }
    await dialog.getByRole('button', { name: 'Trust Folder' }).click();
    await expect(dialog).toHaveCount(0);
    await showTheme(app, shell, 'dark');

    // Real entries: a finished turn, an approval in a chat that is not selected, and a core notice.
    const alpha = await openProjectChat(app, home.project);
    await setWindowFocused(app, false);
    await sendAndAwaitEcho(alpha, 'Rate-limit the /login route');
    const popup = await popupPage(app);
    await expect(popup.locator('[data-testid="overlay-toast"][data-kind="done"]')).toBeVisible({ timeout: 30_000 });
    let release!: () => void;
    stub.replies.push({
      chunks: ['Raising the limit.'],
      holdAfterFirst: new Promise<void>((resolve) => { release = resolve; }),
      toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: 'limit = 5', new_string: 'limit = 7' } }],
    });
    await chatInput(alpha).fill('Raise the limit to 7');
    await chatInput(alpha).press('Enter');
    await shell.evaluate(() => window.damoclesShell!.newChat());
    let fresh: string | undefined;
    await expect.poll(async () => (fresh = (await shellState(app)).selected.chatId)).toMatch(/^new:/);
    release();
    await expect(popup.locator('[data-testid="overlay-toast"][data-kind="approval"]')).toBeVisible({ timeout: 30_000 });
    await shell.evaluate((id) => window.damoclesShell!.renameChat(id, 'Notes'), fresh!);
    await expect.poll(async () => (await shellState(app)).notifications.unseen).toBeGreaterThanOrEqual(3);
    await setWindowFocused(app, undefined);
    await shell.mouse.move(900, 400);

    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await shoot(shell, `bell-unseen-${theme}`, shell.getByTestId('title-bar'));
    }

    // The popup window's stack: four toasts, so the oldest collapses into "1 more · Dismiss all".
    while (await popup.locator('[data-testid="overlay-toast"]:not([inert])').count() > 0) {
      await popup.locator('[data-testid="overlay-toast"]:not([inert])').last().getByTestId('overlay-toast-dismiss').click();
    }
    await expect(popup.getByTestId('overlay-toast')).toHaveCount(0);
    const chat = { project: { key: 'acme', name: 'acme' }, title: 'Per-account lockout' };
    await sendToasts(app, [
      toast('s-done', { kind: 'done', chat: { project: { key: 'acme', name: 'acme' }, title: 'Rate-limit the /login route' }, durationMs: 134_000 }, 9000, 9000),
      toast('s-team', { kind: 'team', chat, agentName: 'Theo', summary: 'Mira\'s lockout change is ready for your go-ahead.' }, 12_000, 9000),
      toast('s-notice', { kind: 'notice', severity: 'warning', message: 'The project settings file has a syntax error, so its values are ignored.', actions: ['Open settings', 'Ignore'] }, 12_000, 6000),
      toast('s-approval', { kind: 'approval', chat: { project: { key: 'acme', name: 'acme' }, title: 'Rate-limit the /login route' }, summary: 'edit src/routes/auth.ts (+7 lines).' }, 12_000, 11_000),
    ]);
    await expect(popup.getByTestId('overlay-toasts-more')).toHaveText('1 more · Dismiss all');
    for (const theme of THEMES) {
      await showTheme(app, popup, theme);
      await shootOverlay(popup, `toasts-${theme}`);
    }
    await popup.getByTestId('overlay-toasts-more').click();
    await expect(popup.getByTestId('overlay-toast')).toHaveCount(0);

    // The bell's center over the window, with the real entries.
    await setPageSize(overlay, WIDTH, HEIGHT);
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await shell.getByTestId('notification-bell').click();
      await expect(overlay.getByTestId('notification-center')).toBeVisible();
      await expect(overlay.getByTestId('notification-row').first()).toBeVisible();
      await pinText(overlay, '[data-testid="notification-row"] time', '2m ago');
      await pinMatches(overlay, '[data-testid="notification-row"]', /\bin \d+s\./g, 'in 1s.');
      await shootOverlay(overlay, `notification-center-${theme}`);
      await closeWith(overlay, overlay.getByTestId('notification-center'));
    }
  } finally {
    await stub.close();
  }
});

test('the tag chips and their overflow, the empty and failed chat lists, and the update pill under the pointer', async ({ foreground: _foreground, launch }) => {
  test.setTimeout(180_000);
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await readyShell(app);
  let projectKey: string | undefined;
  await expect.poll(async () => (projectKey = (await shellState(app)).selected.projectKey)).toBeDefined();
  const sidebar = shell.getByTestId('sidebar');
  const park = (): Promise<void> => shell.mouse.move(900, 400);

  await serveChatList(app, projectKey!, { chats: TAGGED_CHATS, tags: [...new Set(TAGGED_CHATS.map((chat) => chat.tag!))].sort() });
  await expect(shell.getByTestId('all-tags')).toBeVisible();
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await park();
    await shoot(shell, `sidebar-tags-overflow-${theme}`, sidebar);
    await shell.getByTestId('tag-chip').first().hover();
    await shoot(shell, `sidebar-tag-chip-hover-${theme}`, sidebar);
    await shell.getByTestId('all-tags').hover();
    await shoot(shell, `sidebar-more-tags-hover-${theme}`, sidebar);
    await shell.getByTestId('chat-tag').first().hover();
    await shoot(shell, `sidebar-chat-tag-hover-${theme}`, sidebar);
    await shell.getByTestId('tag-chip').first().click();
    await expect(shell.getByTestId('tag-chip').first()).toHaveAttribute('aria-pressed', 'true');
    await park();
    await shoot(shell, `sidebar-tag-chip-pressed-${theme}`, sidebar);
    await shell.getByTestId('tag-chip').first().click();
    await expect(shell.getByTestId('tag-chip').first()).toHaveAttribute('aria-pressed', 'false');
  }

  await serveChatList(app, projectKey!, 'fail');
  const failed = shell.getByTestId('chats-load-failed');
  await expect(failed).toBeVisible();
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await park();
    await shoot(shell, `sidebar-chats-load-failed-${theme}`, sidebar);
    await failed.getByRole('button').hover();
    await shoot(shell, `sidebar-chats-load-failed-hover-${theme}`, sidebar);
  }

  await serveChatList(app, projectKey!, { chats: [], tags: [] });
  const empty = shell.getByTestId('chats-empty');
  await expect(empty).toBeVisible();
  await expect(failed).toHaveCount(0);
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await park();
    await shoot(shell, `sidebar-chats-empty-${theme}`, sidebar);
    await empty.getByRole('button').hover();
    await shoot(shell, `sidebar-chats-empty-hover-${theme}`, sidebar);
  }

  const pill = shell.getByTestId('update-pill');
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'downloading', version: '9.9.0', percent: 42 }));
    await expect(pill).toHaveAttribute('data-state', 'downloading');
    await pill.hover();
    await shoot(shell, `pill-downloading-hover-${theme}`, shell.getByTestId('title-bar'));
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'ready', version: '9.9.0', notes: '' }));
    await expect(pill).toHaveAttribute('data-state', 'ready');
    await shoot(shell, `pill-ready-hover-${theme}`, shell.getByTestId('title-bar'));
    await park();
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'disabled' }));
    await expect(pill).toHaveCount(0);
  }
});
