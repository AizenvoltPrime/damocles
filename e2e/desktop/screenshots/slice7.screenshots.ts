import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { menuItem, overlayMenu } from '../support/overlay';
import { openProjectChat, settled, showTheme, THEMES, type Theme } from '../support/screenshots';
import { openSettingsModal, setContentSize } from '../support/settings';
import { overlayPage, selectedProjectKey, SHELL_URL, shellPage } from '../support/shell';
import { clickMenu } from '../support/ui';
import { activeTab, codeEditor, conflictBar, editorShows, filesRow, openInEditor, quickOpen, quickPick, toggleTerminal } from '../support/editor';

// Review captures for slice 7 (editor pane, layout grid, Files, Quick Open), saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice7');
const REFERENCE = path.join(REPO_ROOT, 'Damocles desktop UI revamp', 'export', 'damocles-revamp');
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
async function windowShot(app: ElectronApplication, name: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  const shell = await shellPage(app);
  await settled(shell);
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
  const data = await shell.evaluate(async ({ parts, area }) => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const scale = window.devicePixelRatio;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round((area?.width ?? width) * scale);
    canvas.height = Math.round((area?.height ?? height) * scale);
    const context = canvas.getContext('2d')!;
    context.scale(scale, scale);
    if (area) context.translate(-area.x, -area.y);
    for (const part of parts) {
      const image = new Image();
      image.src = part.png;
      await image.decode();
      context.drawImage(image, part.bounds.x, part.bounds.y, part.bounds.width, part.bounds.height);
    }
    return canvas.toDataURL('image/png');
  }, { parts: layers, area: clip ?? null });
  save(name, Buffer.from(data.split(',')[1]!, 'base64'));
}

async function seed(project: string): Promise<void> {
  fs.mkdirSync(path.join(project, 'src', 'routes'), { recursive: true });
  fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(project, 'src', 'routes', 'auth.ts'), [
    "import { Router } from 'express';",
    "import { rateLimit } from 'express-rate-limit';",
    '',
    '// Five attempts per IP every fifteen minutes.',
    'export const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5 });',
    '',
    'export function authRoutes(router: Router): Router {',
    "  router.post('/login', loginLimiter, async (req, res) => {",
    '    const user = await verify(req.body);',
    '    res.json({ ok: Boolean(user) });',
    '  });',
    '  return router;',
    '}',
  ].join('\n'));
  fs.writeFileSync(path.join(project, 'src', 'app.ts'), "export const app = 'acme';\n");
  fs.writeFileSync(path.join(project, 'README.md'), '# Acme API\n\nA small **Express** service with rate-limited `/login`.\n\n## Running\n\n- `npm ci`\n- `npm start`\n\n```ts\nexport const port = 3000;\n```\n');
  fs.writeFileSync(path.join(project, 'docs', 'logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAPklEQVR42mNk+M9Qz0AEYBxVSFAhMfwHqWwYxQyYkBgGWg0jHgIGzFQwBg1MDKMG0EwhIzETzcMwqsCgQAEAN1oP0V9XMg8AAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(project, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 0, 7]));
  for (let i = 1; i <= 7; i++) fs.writeFileSync(path.join(project, 'src', `feature_module_${i}.ts`), `export const feature${i} = ${i};\n`);
}

async function open(app: ElectronApplication, relativePath: string, as?: 'preview' | 'source'): Promise<void> {
  const projectKey = await selectedProjectKey(app);
  expect(await openInEditor(app, { projectKey, relativePath, ...(as ? { as } : {}) })).toMatchObject({ ok: true });
}

async function typeAtEnd(shell: Page, text: string): Promise<void> {
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.press('Control+End');
  await shell.keyboard.type(text);
}

/** The prototype's Desktop template served read-only from the reference folder, in its own window and session. */
async function shootReference(app: ElectronApplication, theme: Theme): Promise<Buffer | null> {
  if (!fs.existsSync(REFERENCE)) return null;
  const server = http.createServer((req, res) => {
    const file = path.join(REFERENCE, decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname));
    if (!file.startsWith(REFERENCE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.png') ? 'image/png' : 'text/javascript';
    res.writeHead(200, { 'content-type': type }).end(fs.readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/Damocles%20Desktop.dc.html`;
  try {
    const opened = app.waitForEvent('window', (page) => page.url().startsWith(url));
    await app.evaluate(({ BrowserWindow }, [target, w, h]) => {
      const win = new BrowserWindow({ width: w, height: h, show: true, useContentSize: true, webPreferences: { partition: 'reference-capture' } });
      void win.loadURL(target);
    }, [url, WIDTH, HEIGHT] as const);
    const page = await opened;
    await expect(page.getByTitle('Mention this file in chat')).toBeVisible({ timeout: 60_000 });
    if (theme === 'light') await page.getByTitle('Switch theme').click();
    await settled(page);
    return await page.screenshot();
  } finally {
    await app.evaluate(({ BrowserWindow }, target) => {
      BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith(target))?.destroy();
    }, url);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function sideBySide(shell: Page, name: string, left: Buffer, right: Buffer): Promise<void> {
  const data = await shell.evaluate(async ([a, b]) => {
    const images = await Promise.all([a, b].map(async (src) => {
      const image = new Image();
      image.src = `data:image/png;base64,${src}`;
      await image.decode();
      return image;
    }));
    const canvas = document.createElement('canvas');
    canvas.width = images[0]!.width + images[1]!.width;
    canvas.height = Math.max(images[0]!.height, images[1]!.height);
    const context = canvas.getContext('2d')!;
    context.drawImage(images[0]!, 0, 0);
    context.drawImage(images[1]!, images[0]!.width, 0);
    return canvas.toDataURL('image/png');
  }, [left.toString('base64'), right.toString('base64')] as const);
  save(name, Buffer.from(data.split(',')[1]!, 'base64'));
}

test('slice 7 captures', async ({ foreground: _foreground, home, launch }) => {
  await seed(home.project);
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);

  for (const theme of THEMES) {
    await showTheme(app, chat, theme);
    await settled(shell);
    const t = (name: string): string => `${name}-${theme}`;
    await closeAllTabs(app, overlay);

    // The default layout with a dirty code tab, and the pane tops side by side.
    await open(app, 'src/routes/auth.ts');
    await editorShows(shell, 'loginLimiter');
    await typeAtEnd(shell, '\n// unsaved edit');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    await windowShot(app, t('layout-default-code-dirty'));
    await windowShot(app, t('pane-tops-side-by-side'), { x: 0, y: 40, width: WIDTH, height: 140 });
    await shot(shell, t('breadcrumbs-mention-button'), shell.getByTestId('editor-pane').locator('header'));

    // Each tab kind.
    await open(app, 'README.md', 'preview');
    await expect(shell.getByTestId('markdown-preview').locator('h1')).toBeVisible();
    await shot(shell, t('tab-markdown-preview'), shell.getByTestId('editor-pane'));
    await open(app, 'docs/logo.png');
    await expect(shell.getByTestId('image-preview').locator('img')).toBeVisible();
    await shot(shell, t('tab-image'), shell.getByTestId('editor-pane'));
    await open(app, 'blob.bin');
    await expect(shell.getByTestId('editor-not-displayed')).toBeVisible();
    await shot(shell, t('tab-not-displayed'), shell.getByTestId('editor-pane'));
    await clickMenu(app, 'damocles.showLog');
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('log');
    await shot(shell, t('tab-log'), shell.getByTestId('editor-pane'));

    // A conflict over the dirty buffer, then Compare's diff tab.
    await open(app, 'src/routes/auth.ts');
    fs.appendFileSync(path.join(home.project, 'src', 'routes', 'auth.ts'), '\n// changed on disk\n');
    await expect(conflictBar(shell)).toBeVisible();
    await shot(shell, t('conflict-bar'), shell.getByTestId('editor-pane'));
    await conflictBar(shell).getByTestId('conflict-compare').click();
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
    await shot(shell, t('tab-diff'), shell.getByTestId('editor-pane'));

    // The tab strip overflowing: at rest, hovered with VS Code's slider, and scrolled with the active tab mid-strip.
    for (let i = 1; i <= 7; i++) await open(app, `src/feature_module_${i}.ts`);
    await shell.getByTestId('editor-tab').filter({ hasText: 'feature_module_3.ts' }).click();
    await shell.mouse.move(5, 300);
    // At rest the slider has faded out (500 ms after the pointer left, then an 800 ms fade).
    await expect(shell.getByTestId('editor-tab-scrollbar')).not.toHaveClass(/editor-tab-scrollbar-shown/);
    await shot(shell, t('tab-strip-overflow-rest'), shell.getByTestId('editor-pane').locator('header'));
    await shell.getByTestId('editor-tabs').hover();
    await shot(shell, t('tab-strip-overflow-hover-slider'), shell.getByTestId('editor-pane').locator('header'));
    // The active tab in the middle of the strip, with tabs clipped at both ends.
    await shell.getByTestId('editor-tabs').evaluate((element) => {
      const active = element.querySelector<HTMLElement>('[aria-selected="true"]')!;
      element.scrollLeft = active.offsetLeft - (element.clientWidth - active.offsetWidth) / 2;
    });
    await shell.getByTestId('editor-tabs').hover();
    await shot(shell, t('tab-strip-scrolled-active-mid'), shell.getByTestId('editor-pane').locator('header'));

    // The settings.json tab.
    await openSettingsModal(app, 'files');
    await shot(overlay, t('settings-files-and-search'));
    await overlay.getByTestId('files-exclude-edit').click();
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('settings');
    await shot(shell, t('tab-settings-json'), shell.getByTestId('editor-pane'));

    // The Editor settings section.
    await openSettingsModal(app, 'editor');
    await shot(overlay, t('settings-editor-section'));
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('settings-modal')).toHaveCount(0);

    // Files: the inline new-file input and a file's context menu.
    await filesRow(shell, 'src').click();
    await filesRow(shell, 'src').focus();
    await shell.getByTestId('files-new-file').click();
    await shell.getByTestId('files-edit-input').fill('rate-limit.ts');
    await shot(shell, t('files-inline-new-file'), shell.getByTestId('sidebar'));
    await shell.getByTestId('files-edit-input').press('Escape');
    await filesRow(shell, 'README.md').click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, t('files-context-menu'));
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toBeHidden();

    // Quick Open with highlights and project chips.
    const picker = await quickOpen(app, 'rauth');
    await expect(quickPick(picker).getByTestId('quick-pick-item').first()).toBeVisible();
    await windowShot(app, t('quick-open-highlights'));
    await picker.keyboard.press('Escape');
    const empty = await quickOpen(app, '');
    await expect(quickPick(empty).getByText('recently opened')).toBeVisible();
    await windowShot(app, t('quick-open-recent-groups'));
    await empty.keyboard.press('Escape');

    // Drop zones mid-drag.
    const grip = (await shell.getByTestId('pane-grip-editor').boundingBox())!;
    const grid = (await shell.getByTestId('layout-grid').boundingBox())!;
    await shell.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(grid.x + grid.width * 0.4, grid.y + grid.height * 0.8, { steps: 6 });
    await expect(overlay.getByTestId('drop-zones')).toBeVisible();
    await windowShot(app, t('drop-zones-mid-drag'));
    await overlay.keyboard.press('Escape');
    await shell.mouse.up();

    // A swapped layout with the terminal's empty state.
    await toggleTerminal(app);
    await shell.getByTestId('pane-grip-terminal').focus();
    await shell.keyboard.press('Enter');
    await menuItem(overlay, 'side').click();
    await expect(shell.getByTestId('grid-pane-terminal')).toHaveAttribute('data-slot', 'side');
    await windowShot(app, t('layout-swapped-terminal-empty'));
    await shell.getByTestId('pane-grip-editor').focus();
    await shell.keyboard.press('Enter');
    await menuItem(overlay, 'side').click();
    await toggleTerminal(app);
    await expect(shell.getByTestId('grid-pane-editor')).toHaveAttribute('data-slot', 'side');

    // The focus overlay.
    await open(app, 'src/app.ts');
    await shell.getByTestId('editor-focus-toggle').click();
    await expect(shell.getByTestId('focus-overlay-placeholder')).toBeVisible();
    await windowShot(app, t('focus-overlay'));
    for (const [w, h] of [[1280, 800], [1600, 1000]] as const) {
      await setContentSize(app, w, h);
      await windowShot(app, t(`focus-overlay-${w}x${h}`));
    }
    await setContentSize(app, WIDTH, HEIGHT);
    await shell.keyboard.press('Escape');
    await expect(shell.getByTestId('focus-overlay-placeholder')).toHaveCount(0);

    // The dirty save prompt: Save and Don't Save only.
    // A dirty tab whose document no other tab shows asks before it closes.
    await open(app, 'src/app.ts');
    await typeAtEnd(shell, '\n// close me');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    const dirtyTab = (await activeTab(app))!.id;
    // Not awaited: the close resolves only once the prompt is answered.
    void shell.evaluate((tabId) => window.damoclesShell!.editorTab({ action: 'close', tabId }), dirtyTab);
    await expect(overlay.getByRole('alertdialog')).toBeVisible();
    await windowShot(app, t('save-prompt'));
    await overlay.getByRole('button', { name: "Don't Save", exact: true }).click();
    await expect(overlay.getByRole('alertdialog')).toHaveCount(0);

    // The composer's drop target.
    await chat.getByTestId('composer').evaluate((card) => {
      const data = new DataTransfer();
      data.setData('application/x-damocles-file', JSON.stringify({ projectKey: 'x', relativePath: 'README.md' }));
      card.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await expect(chat.getByTestId('composer-drop-target')).toBeVisible();
    await windowShot(app, t('composer-drop-to-mention'));
    await chat.getByTestId('composer').evaluate((card) => {
      card.dispatchEvent(new DragEvent('dragleave', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }));
      card.dispatchEvent(new DragEvent('drop', { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true }));
    });
    await expect(chat.getByTestId('composer-drop-target')).toHaveCount(0);

    // The prototype's editor pane next to ours.
    const reference = await shootReference(app, theme);
    if (reference) {
      await showTheme(app, chat, theme);
    await settled(shell);
      await open(app, 'src/routes/auth.ts');
      await editorShows(shell, 'loginLimiter');
      await windowShot(app, t('ours-full'));
      const ours = fs.readFileSync(path.join(OUT, `${t('ours-full')}.png`));
      await sideBySide(shell, t('prototype-vs-ours'), reference, ours);
    }
  }
});

/** Closes every tab, answering Don't Save for a dirty one, so each theme's captures start from the same strip. */
async function closeAllTabs(app: ElectronApplication, overlay: Page): Promise<void> {
  const shell = await shellPage(app);
  for (let tab = await activeTab(app); tab; tab = await activeTab(app)) {
    const tabId = tab.id;
    const closing = shell.evaluate((id) => window.damoclesShell!.editorTab({ action: 'close', tabId: id }), tabId);
    // Only a dirty document no other tab shows asks; any other tab just closes.
    const dialog = overlay.getByRole('alertdialog');
    const asked = dialog.waitFor({ timeout: 5_000 }).then(() => true, () => false);
    if (await Promise.race([closing.then(() => false), asked])) await dialog.getByRole('button', { name: "Don't Save", exact: true }).click();
    await closing;
    await expect.poll(async () => (await activeTab(app))?.id).not.toBe(tabId);
  }
}
