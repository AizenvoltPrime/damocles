import * as fs from 'node:fs';
import * as path from 'node:path';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat } from '../support/screenshots';
import { shellPage } from '../support/shell';
import { chatInput } from '../support/ui';
import { activeTab, conflictBar, editorShows, editorTab, filesRow } from '../support/editor';

// Review captures for the Files name box, renamed and deleted tabs and the conflict bar, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'i29-i32');
const WIDTH = 1440;
const HEIGHT = 900;

test.setTimeout(600_000);

test('Files name box, renamed and deleted tabs, and conflict bar captures', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'notes.txt'), 'first line\n');
  fs.writeFileSync(path.join(home.project, 'src', 'todo.md'), '# Todo\n');
  const appFile = path.join(home.project, 'src', 'app.ts');
  fs.writeFileSync(appFile, "export const v = 'one';\n");
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await filesRow(shell, 'src').click();

  // I30: the name is checked as it is typed.
  await filesRow(shell, 'src/notes.txt').focus();
  await shell.keyboard.press('F2');
  await shell.getByTestId('files-edit-input').fill('todo.md');
  await expect(shell.getByTestId('files-edit-message')).toBeVisible();
  await captureThemes(app, OUT, 'files-name-exists');
  await shell.getByTestId('files-edit-input').press('Escape');

  // I31: a renamed tab keeps its unsaved text; a deleted file's tab is struck through.
  await filesRow(shell, 'src/notes.txt').click();
  await editorShows(shell, 'first line');
  await shell.getByTestId('code-editor').locator('.view-lines').click();
  await shell.keyboard.press('Control+End');
  await shell.keyboard.type('unsaved');
  await expect(editorTab(shell, 'notes.txt')).toHaveAttribute('data-dirty', 'true');
  await filesRow(shell, 'src/notes.txt').focus();
  await shell.keyboard.press('F2');
  await shell.getByTestId('files-edit-input').fill('renamed.txt');
  await shell.getByTestId('files-edit-input').press('Enter');
  await expect.poll(async () => (await activeTab(app))?.title).toBe('renamed.txt');
  await filesRow(shell, 'src/todo.md').click();
  await expect(editorTab(shell, 'todo.md')).toBeVisible();
  await editorTab(shell, 'renamed.txt').click();
  await captureThemes(app, OUT, 'renamed-tab');
  fs.rmSync(path.join(home.project, 'src', 'todo.md'));
  await expect(editorTab(shell, 'todo.md')).toHaveAttribute('data-deleted', 'true');
  await captureThemes(app, OUT, 'deleted-tab');

  // I32: the conflict bar on the file's tab, then on its Compare tab.
  await filesRow(shell, 'src/app.ts').click();
  await editorShows(shell, "'one'");
  await shell.getByTestId('code-editor').locator('.view-lines').click();
  await shell.keyboard.press('Control+End');
  await shell.keyboard.type('// mine');
  await expect(editorTab(shell, 'app.ts')).toHaveAttribute('data-dirty', 'true');
  fs.writeFileSync(appFile, "export const v = 'two';\n");
  await expect(conflictBar(shell)).toBeVisible();
  await captureThemes(app, OUT, 'conflict-file-tab');
  await conflictBar(shell).getByTestId('conflict-compare').click();
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
  await expect(shell.getByTestId('diff-editor')).toHaveAttribute('data-monaco-ready', 'true');
  await captureThemes(app, OUT, 'conflict-compare-tab');
});
