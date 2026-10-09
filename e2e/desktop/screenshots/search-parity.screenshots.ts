import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { REPO_ROOT, writeUserSettings } from '../support/hermetic';
import { overlayMenu } from '../support/overlay';
import { openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { closeSettingsModal, openSettingsModal, setContentSize } from '../support/settings';
import { overlayPage, pressKeys, PRIMARY, selectedProjectKey, SHELL_URL, shellPage } from '../support/shell';
import { codeEditor, editorShows, editorTab, filesRow, openInEditor } from '../support/editor';

// Review captures for Search's VS Code parity and the Search Editor, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'search-parity');
const WIDTH = 1440;
const HEIGHT = 900;

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

function save(name: string, png: Buffer): void {
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), png);
}

async function shot(page: Page, name: string, target?: Locator): Promise<void> {
  await settled(page);
  save(name, await (target ?? page).screenshot());
}

/** The whole window as the user sees it: the shell page with every visible child view (chat, overlay) drawn at its bounds. */
async function windowShot(app: ElectronApplication, name: string): Promise<void> {
  const shell = await shellPage(app);
  await settled(shell);
  const overlay = await overlayPage(app);
  await settled(overlay);
  const layers = await app.evaluate(async ({ BrowserWindow }, url) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => candidate.webContents.getURL() === url)!;
    const capture = async (contents: Electron.WebContents, bounds: Electron.Rectangle) => ({ bounds, png: (await contents.capturePage()).toDataURL() });
    const { width, height } = win.getContentBounds();
    const out = [await capture(win.webContents, { x: 0, y: 0, width, height })];
    for (const child of win.contentView.children as Electron.WebContentsView[]) {
      if (!child.webContents || !child.getVisible() || child.getBounds().width === 0) continue;
      out.push(await capture(child.webContents, child.getBounds()));
    }
    return out;
  }, SHELL_URL);
  const data = await shell.evaluate(async (parts) => {
    const scale = window.devicePixelRatio;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(window.innerWidth * scale);
    canvas.height = Math.round(window.innerHeight * scale);
    const context = canvas.getContext('2d')!;
    context.scale(scale, scale);
    for (const part of parts) {
      const image = new Image();
      image.src = part.png;
      await image.decode();
      context.drawImage(image, part.bounds.x, part.bounds.y, part.bounds.width, part.bounds.height);
    }
    return canvas.toDataURL('image/png');
  }, layers);
  save(name, Buffer.from(data.split(',')[1]!, 'base64'));
}

function seed(project: string): void {
  const write = (relativePath: string, content: string): void => {
    const file = path.join(project, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('src/routes/auth.ts', [
    "import { Router } from 'express';",
    "import { rateLimit } from 'express-rate-limit';",
    '',
    'export const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 });',
    'export const signupLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3 });',
    '',
    'export function authRoutes(router: Router): Router {',
    "  router.post('/login', loginLimiter, async (req, res) => res.json({ ok: true }));",
    "  router.post('/signup', signupLimiter, async (req, res) => res.json({ ok: true }));",
    '  return router;',
    '}',
  ].join('\n'));
  write('src/routes/users.ts', "import { rateLimit } from 'express-rate-limit';\nexport const usersLimiter = rateLimit({ windowMs: 60_000, limit: 30 });\n");
  write('src/app.ts', "import { loginLimiter } from './routes/auth';\nexport const limiters = [loginLimiter];\n");
  write('test/auth.spec.ts', "it('applies loginLimiter to POST /login', () => {});\n");
}

const searchQuery = (shell: Page): Locator => shell.getByTestId('search-query');
const matchRow = (shell: Page): Locator => shell.locator('[data-testid="search-row"][data-row-kind="match"]');

async function search(shell: Page, text: string): Promise<void> {
  await searchQuery(shell).fill(text);
  await searchQuery(shell).press('Enter');
  await expect(shell.getByTestId('search-progress')).toHaveCount(0);
}

async function setToggle(shell: Page, option: string, on: boolean): Promise<void> {
  const button = shell.getByTestId(`search-option-${option}`);
  if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(on));
}

async function setOpen(button: Locator, open: boolean): Promise<void> {
  if ((await button.getAttribute('aria-expanded')) !== String(open)) await button.click();
  await expect(button).toHaveAttribute('aria-expanded', String(open));
}

async function setViewMode(shell: Page, mode: 'list' | 'tree'): Promise<void> {
  const button = shell.getByTestId('search-view-mode');
  if ((await button.getAttribute('data-view-mode')) !== mode) await button.click();
  await expect(button).toHaveAttribute('data-view-mode', mode);
}

/** Opens or collapses a sidebar section by its header, so Search gets the sidebar's height in the captures. */
async function setSection(shell: Page, testId: string, open: boolean): Promise<void> {
  await setOpen(shell.getByTestId(testId).locator('button[aria-expanded]').first(), open);
}

async function menuShot(app: ElectronApplication, row: Locator, name: string): Promise<void> {
  const overlay = await overlayPage(app);
  await row.click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await windowShot(app, name);
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

test('search parity captures', async ({ foreground: _foreground, home, launch }) => {
  seed(home.project);
  // A long on-type debounce holds a typed search in its running state for the cancel capture; Enter searches at once.
  writeUserSettings(home, { 'damocles.desktop.search.searchOnTypeDebouncePeriod': 10_000, 'damocles.desktop.search.showLineNumbers': true });
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);
  await openInEditor(app, { projectKey, relativePath: 'src/app.ts' });
  await editorShows(shell, 'limiters');
  await pressKeys(app, '/shell/', 'F', [PRIMARY, 'shift']);
  await expect(searchQuery(shell)).toBeFocused();
  const sidebar = shell.getByTestId('sidebar');
  await setSection(shell, 'sidebar-chats', false);
  await setSection(shell, 'files-section', false);

  for (const theme of THEMES) {
    await showTheme(app, chat, theme);
    await settled(shell);
    const t = (name: string): string => `${name}-${theme}`;

    // The full widget: replace and details open, every toggle shown, Preserve Case and Search only in Open Editors on.
    await setOpen(shell.getByTestId('search-toggle-replace'), true);
    await setOpen(shell.getByTestId('search-toggle-details'), true);
    await setToggle(shell, 'onlyOpenEditors', false);
    await setViewMode(shell, 'list');
    await search(shell, 'Limiter');
    await shell.getByTestId('search-replace').fill('Throttle');
    await setToggle(shell, 'preserveCase', true);
    await setToggle(shell, 'onlyOpenEditors', true);
    await expect(shell.getByTestId('search-summary')).toContainText('searching only in open files');
    await shot(shell, t('widget-full'), sidebar);
    await windowShot(app, t('widget-full-window'));
    await setToggle(shell, 'onlyOpenEditors', false);
    await setOpen(shell.getByTestId('search-toggle-replace'), false);

    // List view (by file, the default) and tree view (by folder), with line numbers on.
    await search(shell, 'Limiter');
    await shot(shell, t('list-view'), sidebar);
    await setViewMode(shell, 'tree');
    await shot(shell, t('tree-view'), sidebar);

    // The three context menus: a match, a file and a folder.
    await menuShot(app, matchRow(shell).first(), t('menu-match'));
    await menuShot(app, shell.locator('[data-testid="search-row"][data-row-kind="file"]').first(), t('menu-file'));
    await menuShot(app, shell.locator('[data-testid="search-row"][data-row-kind="folder"]').first(), t('menu-folder'));
    await setViewMode(shell, 'list');

    // History: Up shows the previous query in place, with the history hint in the placeholder.
    await search(shell, 'rateLimit');
    await searchQuery(shell).focus();
    await shell.keyboard.press('ArrowUp');
    await expect(searchQuery(shell)).toHaveValue('Limiter');
    await shot(shell, t('history-up'), sidebar);
    await shell.keyboard.press('ArrowDown');
    await shell.keyboard.press('ArrowDown');
    await expect(searchQuery(shell)).toHaveValue('');
    await shot(shell, t('history-cleared'), sidebar);

    // Cancel while running: a typed query waits on the debounce with the progress line and Cancel Search in the title bar.
    await searchQuery(shell).fill('signupLimiter');
    await expect(shell.getByTestId('search-cancel')).toBeVisible();
    await shot(shell, t('cancel-running'), sidebar);
    await shell.getByTestId('search-cancel').click();
    await expect(shell.getByTestId('search-no-results')).toContainText('Search was canceled');
    await shot(shell, t('cancel-done'), sidebar);

    // The Search Editor with two context lines and its match highlights.
    await shell.getByTestId('search-new-editor').click();
    const editor = shell.getByTestId('search-editor');
    await expect(editor).toBeVisible();
    await editor.getByTestId('search-editor-query').fill('Limiter');
    await editor.getByTestId('search-editor-context-lines').fill('2');
    await editor.getByTestId('search-editor-query').press('Enter');
    await expect(editor.locator('.search-editor-match').first()).toBeVisible();
    await setOpen(editor.getByTestId('search-editor-toggle-details'), true);
    await windowShot(app, t('search-editor-context'));

    // Saved as .code-search, closed, then reopened from Files.
    const target = path.join(home.project, `saved-${theme}.code-search`);
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = (() => Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
    }, target);
    await codeEditor(shell).first().click();
    await pressKeys(app, '/shell/', 'S', [PRIMARY]);
    await expect.poll(() => fs.existsSync(target)).toBe(true);
    await pressKeys(app, '/shell/', 'W', [PRIMARY]);
    await expect(editorTab(shell, `Search: saved-${theme}`)).toHaveCount(0);
    await setSection(shell, 'files-section', true);
    await expect(filesRow(shell, `saved-${theme}.code-search`)).toBeVisible();
    await filesRow(shell, `saved-${theme}.code-search`).click();
    await expect(shell.getByTestId('search-editor')).toBeVisible();
    await windowShot(app, t('code-search-reopened'));
    await setSection(shell, 'files-section', false);
    // Every Search Editor tab of this theme closes, so the next theme's frames start from the same state.
    const searchTabs = shell.locator('[data-testid="editor-tab"][data-kind="searchEditor"]');
    while ((await searchTabs.count()) > 0) {
      const count = await searchTabs.count();
      await searchTabs.first().hover();
      await searchTabs.first().getByTestId('editor-tab-close').click();
      await expect(searchTabs).toHaveCount(count - 1);
    }

    // The Search and Search Editor groups in Settings > Files and search.
    const overlay = await openSettingsModal(app, 'files');
    await expect(overlay.getByTestId('settings-group-search')).toBeVisible();
    await overlay.getByTestId('settings-group-search').scrollIntoViewIfNeeded();
    await windowShot(app, t('settings-search-group'));
    await overlay.getByTestId('settings-group-search-editor').scrollIntoViewIfNeeded();
    await windowShot(app, t('settings-search-editor-group'));
    await closeSettingsModal(overlay);

    await pressKeys(app, '/shell/', 'F', [PRIMARY, 'shift']);
    await expect(searchQuery(shell)).toBeFocused();
  }
});
