import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { activeTab, codeEditor, conflictBar, DOCUMENT_END, editorShows, editorTab, openInEditor, saveWithKeyboard } from './support/editor';
import { openProjectChat } from './support/screenshots';
import { selectedProjectKey, shellPage } from './support/shell';

async function typeAtEnd(app: ElectronApplication, shell: Page, relativePath: string, shown: string, typed: string): Promise<void> {
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath })).toMatchObject({ ok: true });
  await editorShows(shell, shown);
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type(typed);
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
}

test('a save the disk refuses names the file and the reason under the tab, keeps it dirty, and the next save writes it', async ({ foreground: _foreground, home, launch }) => {
  const file = path.join(home.project, 'src', 'locked.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const locked = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  try {
    await typeAtEnd(app, shell, 'src/locked.ts', 'locked = 1', '// unsaved');
    // Read-only: the in-place write fails with EPERM on Windows and EACCES elsewhere, after the disk check passed.
    fs.chmodSync(file, 0o444);
    await saveWithKeyboard(app);
    await expect(shell.getByTestId('editor-save-error')).toHaveText("Failed to save 'locked.ts': Insufficient permissions.");
    await expect(editorTab(shell, 'locked.ts')).toHaveAttribute('data-dirty', 'true');
    expect(fs.readFileSync(file, 'utf8')).toBe('export const locked = 1;\n');

    fs.chmodSync(file, 0o644);
    await saveWithKeyboard(app);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('// unsaved');
    await expect(shell.getByTestId('editor-save-error')).toBeHidden();
    await expect(editorTab(shell, 'locked.ts')).not.toHaveAttribute('data-dirty', 'true');
  } finally {
    fs.chmodSync(file, 0o644);
  }
});

test('Revert of a file deleted on disk keeps the text in a clean Deleted tab, and Save writes it back', async ({ foreground: _foreground, home, launch }) => {
  const file = path.join(home.project, 'src', 'gone.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const gone = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await typeAtEnd(app, shell, 'src/gone.ts', 'gone = 1', '// mine');
  fs.writeFileSync(file, 'export const gone = 2;\n');
  await expect(conflictBar(shell)).toBeVisible();
  fs.rmSync(file);
  const tab = editorTab(shell, 'gone.ts');
  await expect(tab).toHaveAttribute('data-deleted', 'true');

  await conflictBar(shell).getByTestId('conflict-revert').click();
  await expect(conflictBar(shell)).toBeHidden();
  await expect(tab).not.toHaveAttribute('data-dirty', 'true');
  await expect(tab).toHaveAttribute('data-deleted', 'true');
  await editorShows(shell, '// mine');
  await expect(shell.getByTestId('editor-save-error')).toBeHidden();
  expect(fs.existsSync(file)).toBe(false);

  await codeEditor(shell).locator('.view-lines').click();
  await saveWithKeyboard(app);
  await expect.poll(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8')).toContain('// mine');
  await expect(tab).not.toHaveAttribute('data-deleted');
});
