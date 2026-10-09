import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { overlayMenu } from '../support/overlay';
import { openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { overlayPage, pressKeys, PRIMARY, SHELL_URL, shellPage } from '../support/shell';
import { activeTab, diffEditor, quickPick } from '../support/editor';

// Review captures for slice 7a (Search, replace, the command palette), saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice7a');
const WIDTH = 1440;
const HEIGHT = 900;

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);

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
  write('logs/big.log', 'hit\n'.repeat(20_500));
}

const searchQuery = (shell: Page): Locator => shell.getByTestId('search-query');

async function search(shell: Page, text: string): Promise<void> {
  await searchQuery(shell).fill(text);
  await searchQuery(shell).press('Enter');
  await expect(shell.getByTestId('search-progress')).toHaveCount(0);
}

async function setToggle(shell: Page, option: string, on: boolean): Promise<void> {
  const button = shell.getByTestId(`search-option-${option}`);
  if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
}

async function openPalette(app: ElectronApplication, overlay: Page, query: string): Promise<void> {
  await expect(quickPick(overlay)).toHaveCount(0);
  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(query);
}

async function closePalette(overlay: Page): Promise<void> {
  await overlay.getByTestId('quick-pick-input').press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
}

test('slice 7a captures', async ({ foreground: _foreground, home, launch }) => {
  seed(home.project);
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  await pressKeys(app, '/shell/', 'F', [PRIMARY, 'shift']);
  await expect(searchQuery(shell)).toBeFocused();

  for (const theme of THEMES) {
    await showTheme(app, chat, theme);
    await settled(shell);
    const t = (name: string): string => `${name}-${theme}`;
    const sidebar = shell.getByTestId('sidebar');

    // Results for a regex with Match Case on, one match row hovered so its actions show.
    await setToggle(shell, 'isRegex', true);
    await setToggle(shell, 'matchCase', true);
    await search(shell, '(login|signup)Limiter');
    await expect(shell.getByTestId('search-summary')).toContainText('results in');
    await shell.locator('[data-testid="search-row"][data-row-kind="match"]').nth(1).hover();
    await windowShot(app, t('search-results-regex'));
    await shot(shell, t('search-results-regex-sidebar'), sidebar);

    // A match row focused from the keyboard, its focus ring whole around the actions it shows.
    await searchQuery(shell).focus();
    await shell.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+ArrowDown');
    await shell.keyboard.press('ArrowDown');
    await shell.mouse.move(0, 0);
    await shot(shell, t('search-row-keyboard-focus'), sidebar);

    // The result context menu.
    await shell.locator('[data-testid="search-row"][data-row-kind="match"]').first().click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, t('search-context-menu'));
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);

    // Replace mode: removed and inserted text in the rows, and the read-only preview diff tab.
    if ((await shell.getByTestId('search-toggle-replace').getAttribute('aria-expanded')) !== 'true') await shell.getByTestId('search-toggle-replace').click();
    await shell.getByTestId('search-replace').fill('$1Throttle');
    await shell.locator('[data-testid="search-row"][data-row-kind="match"]').first().click();
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await expect.poll(async () => (await activeTab(app))?.title).toContain('Replace Preview');
    await windowShot(app, t('replace-preview-diff'));

    // Replace All's question, declined.
    await shell.getByTestId('search-replace-all').click();
    const question = overlay.getByRole('alertdialog');
    await expect(question).toBeVisible();
    await windowShot(app, t('replace-all-confirm'));
    await question.getByRole('button', { name: 'Cancel' }).click();
    await expect(question).toHaveCount(0);
    await shell.getByTestId('search-toggle-replace').click();

    // The 20,000 result cap.
    await setToggle(shell, 'isRegex', false);
    await search(shell, 'hit');
    await expect(shell.getByTestId('search-limit')).toBeVisible();
    await shot(shell, t('search-limit-notice'), sidebar);

    // No results.
    await search(shell, 'nothing matches this');
    await expect(shell.getByTestId('search-no-results')).toBeVisible();
    await shot(shell, t('search-no-results'), sidebar);
    await setToggle(shell, 'matchCase', false);

    // The palette with categories and shortcuts, then a command the focus context disables.
    await openPalette(app, overlay, '>view');
    await windowShot(app, t('palette-categories-shortcuts'));
    await overlay.getByTestId('quick-pick-input').fill('>file: save');
    await expect(overlay.locator('[data-testid="quick-pick-item"][aria-disabled="true"]').first()).toBeVisible();
    await windowShot(app, t('palette-disabled-command'));
    await closePalette(overlay);

    // After running a command, it leads the palette under "recently used".
    await openPalette(app, overlay, '>context');
    await overlay.getByTestId('quick-pick-input').press('Enter');
    const contextDialog = chat.getByRole('dialog');
    await expect(contextDialog).toBeVisible();
    await chat.keyboard.press('Escape');
    await expect(contextDialog).toHaveCount(0);
    await openPalette(app, overlay, '>');
    await expect(quickPick(overlay).getByText('recently used')).toBeVisible();
    await windowShot(app, t('palette-recently-used'));
    await closePalette(overlay);
  }
});

test('slice 7a palette in Greek', async ({ launch }) => {
  const { app } = await launch({ args: ['--lang=el-GR'] });
  const chat = await activeChat(app);
  await setContentSize(app, WIDTH, HEIGHT);
  const overlay = await overlayPage(app);
  for (const theme of THEMES) {
    await showTheme(app, chat, theme);
    await openPalette(app, overlay, '>context usage');
    await expect(overlay.locator('[data-item-id="damocles.chat.contextUsage"]')).toBeVisible();
    await windowShot(app, `palette-greek-${theme}`);
    await closePalette(overlay);
  }
});
