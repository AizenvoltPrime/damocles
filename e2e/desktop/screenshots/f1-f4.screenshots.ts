import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { overlayPage, popupPage, popupToasts, selectedProjectKey, shellPage } from '../support/shell';
import { chatInput } from '../support/ui';
import { activeTab, codeEditor, editorShows, editorTab, filesRow, openInEditor } from '../support/editor';

// Review captures for a restored Deleted tab and a failed Files delete, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'f1-f4');
const WIDTH = 1440;
const HEIGHT = 900;
const HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };

test.setTimeout(600_000);

test('a restored Deleted tab with its text', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const file = path.join(home.project, 'src', 'draft.ts');
  fs.writeFileSync(file, "export const draft = 'one';\n");
  {
    const { app, close } = await launch();
    await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'src/draft.ts' })).toMatchObject({ ok: true });
    await editorShows(shell, "'one'");
    await shell.keyboard.press('Control+End');
    await shell.keyboard.type('// unsaved before the file was deleted');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    fs.rmSync(file);
    await expect(editorTab(shell, 'draft.ts')).toHaveAttribute('data-deleted', 'true');
    await close();
  }
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  await editorTab(shell, 'draft.ts').click();
  await editorShows(shell, '// unsaved before the file was deleted');
  await expect(editorTab(shell, 'draft.ts')).toHaveAttribute('data-deleted', 'true');
  await expect(editorTab(shell, 'draft.ts')).toHaveAttribute('data-dirty', 'true');
  // The dirty dot shows while the tab is neither hovered nor focused.
  await codeEditor(shell).locator('.view-lines').click();
  await shell.mouse.move(600, 600);
  await captureThemes(app, OUT, 'f1-restored-deleted-tab');
});

test('a failed move to the trash and a failed delete', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'locked.ts'), 'export {};\n');
  const { app } = await launch(HOOKS);
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, home.project);
  await app.evaluate(() => {
    (globalThis as unknown as { __damoclesE2e: { failFiles(failure: object): void } }).__damoclesE2e.failFiles({
      trash: 'The Recycle Bin is not available for this drive.',
      remove: "EBUSY: resource busy or locked, rmdir 'src\\locked.ts'",
    });
  });
  const shell = await shellPage(app);
  const dialog = (await overlayPage(app)).getByRole('alertdialog');
  await filesRow(shell, 'src').click();
  await filesRow(shell, 'src/locked.ts').focus();
  await shell.keyboard.press('Delete');
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(dialog.getByRole('button', { name: 'Delete Permanently' })).toBeVisible();
  await captureThemes(app, OUT, 'f4-delete-permanently');

  await dialog.getByRole('button', { name: 'Delete Permanently' }).click();
  const popup = await popupPage(app);
  const toast = popupToasts(popup).filter({ hasText: 'Damocles could not delete' });
  await expect(toast).toHaveCount(1);
  for (const theme of THEMES) {
    await showTheme(app, popup, theme);
    await popup.evaluate(() => {
      document.body.style.backgroundColor = 'var(--d-bg)';
    });
    await settled(popup);
    await toast.screenshot({ path: path.join(OUT, `f4-delete-failed-toast-${theme}.png`) });
  }
});
