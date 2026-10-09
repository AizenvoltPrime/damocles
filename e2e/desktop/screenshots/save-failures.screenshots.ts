import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { setWindowContentSize } from '../support/browser';
import { activeTab, conflictBar, editorShows, editorTab, openInEditor, saveWithKeyboard } from '../support/editor';
import { openProjectChat, saveScreenshot, showTheme, THEMES } from '../support/screenshots';
import { selectedProjectKey, shellPage } from '../support/shell';

// Review captures of a save the disk refused, a Revert that could not read the file and a Revert of a file deleted on disk,
// saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
test.setTimeout(300_000);

async function both(app: ElectronApplication, shell: Page, testInfo: TestInfo, name: string): Promise<void> {
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await saveScreenshot(shell, testInfo, `${name}-${theme}`);
  }
}

async function typeAtEnd(app: ElectronApplication, shell: Page, relativePath: string, shown: string, typed: string): Promise<void> {
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath })).toMatchObject({ ok: true });
  await editorShows(shell, shown);
  await shell.keyboard.press('Control+End');
  await shell.keyboard.type(typed);
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
}

test('a save whose file became a folder and a Revert of a file that became binary say why under the tab; a Revert of a deleted file keeps its text', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const src = path.join(home.project, 'src');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'notes.ts'), "export const notes = 'one';\n");
  fs.writeFileSync(path.join(src, 'data.ts'), 'export const data = 1;\n');
  fs.writeFileSync(path.join(src, 'gone.ts'), 'export const gone = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setWindowContentSize(app, 1440, 900);
  const shell = await shellPage(app);

  await typeAtEnd(app, shell, 'src/notes.ts', "'one'", '// unsaved');
  fs.rmSync(path.join(src, 'notes.ts'));
  fs.mkdirSync(path.join(src, 'notes.ts'));
  await saveWithKeyboard(app);
  await expect(shell.getByTestId('editor-save-error')).toHaveText("Failed to save 'notes.ts': The path is a folder.");
  await expect(editorTab(shell, 'notes.ts')).toHaveAttribute('data-dirty', 'true');
  await both(app, shell, testInfo, 'save-failed');

  await typeAtEnd(app, shell, 'src/data.ts', 'export const data = 1;', '// unsaved');
  fs.writeFileSync(path.join(src, 'data.ts'), Buffer.from([1, 0, 2]));
  await saveWithKeyboard(app);
  await expect(conflictBar(shell)).toBeVisible();
  await shell.getByTestId('conflict-revert').click();
  await expect(shell.getByTestId('editor-save-error')).toContainText('data.ts');
  await expect(conflictBar(shell)).toBeVisible();
  await both(app, shell, testInfo, 'revert-failed');

  await typeAtEnd(app, shell, 'src/gone.ts', 'export const gone = 1;', '// kept after Revert');
  fs.writeFileSync(path.join(src, 'gone.ts'), 'export const gone = 2;\n');
  await expect(conflictBar(shell)).toBeVisible();
  fs.rmSync(path.join(src, 'gone.ts'));
  await expect(editorTab(shell, 'gone.ts')).toHaveAttribute('data-deleted', 'true');
  await shell.getByTestId('conflict-revert').click();
  await expect(conflictBar(shell)).toBeHidden();
  await expect(editorTab(shell, 'gone.ts')).not.toHaveAttribute('data-dirty', 'true');
  await editorShows(shell, '// kept after Revert');
  await both(app, shell, testInfo, 'revert-deleted');
});
