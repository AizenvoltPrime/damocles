import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, popupPage, popupToasts, selectedProjectKey, shellPage, shellState } from './support/shell';
import { chooseMenuItem, menuItem, overlayMenu } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { chatInput } from './support/ui';
import { activeTab, bufferText, codeEditor, DOCUMENT_END, editorShows, editorTab, filesRow, filesTree, openInEditor, quickOpen, quickPick, saveWithKeyboard } from './support/editor';
import { FILE_DRAG_MIME } from '../../src/shared/file-drag';

test('the Files tree lists the project lazily, hides files.exclude matches, and opens a file in the editor on click', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, '.git'), { recursive: true });
  fs.writeFileSync(path.join(home.project, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  fs.mkdirSync(path.join(home.project, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'deep', 'x.ts'), 'export const x = 1;\n');
  fs.writeFileSync(path.join(home.project, 'README.md'), '# Readme\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  await expect(filesRow(shell, 'src')).toBeVisible();
  await expect(filesRow(shell, 'README.md')).toBeVisible();
  await expect(filesRow(shell, '.git')).toHaveCount(0);
  await expect(filesRow(shell, 'src/deep')).toHaveCount(0);
  await filesRow(shell, 'src').click();
  await expect(filesRow(shell, 'src')).toHaveAttribute('aria-expanded', 'true');
  await filesRow(shell, 'src/deep').click();
  await filesRow(shell, 'src/deep/x.ts').click();
  await expect(editorTab(shell, 'x.ts')).toHaveAttribute('aria-selected', 'true');
  await editorShows(shell, 'export const x = 1;');
  await expect(filesRow(shell, 'src/deep/x.ts')).toHaveAttribute('aria-selected', 'true');

  // Keyboard: the tree keeps one tab stop, arrows walk it and Left closes a folder.
  await filesRow(shell, 'src/deep/x.ts').focus();
  await shell.keyboard.press('ArrowLeft');
  await expect(filesRow(shell, 'src/deep')).toBeFocused();
  await shell.keyboard.press('ArrowLeft');
  await expect(filesRow(shell, 'src/deep')).toHaveAttribute('aria-expanded', 'false');
  await expect(filesTree(shell).locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);

  await shell.getByTestId('files-collapse-all').click();
  await expect(filesRow(shell, 'src')).toHaveAttribute('aria-expanded', 'false');
});

test('New file, New folder and Rename use inline inputs, Delete moves to the trash after asking, and the copy actions write the clipboard', async ({ clipboard, home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'old.ts'), 'export {};\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  await filesRow(shell, 'src').click();
  await filesRow(shell, 'src').focus();
  await shell.getByTestId('files-new-file').click();
  const input = shell.getByTestId('files-edit-input');
  await expect(input).toBeFocused();
  await input.fill('fresh.ts');
  await input.press('Enter');
  await expect.poll(() => fs.existsSync(path.join(home.project, 'src', 'fresh.ts'))).toBe(true);
  await expect(filesRow(shell, 'src/fresh.ts')).toBeVisible();
  await expect(editorTab(shell, 'fresh.ts')).toHaveAttribute('aria-selected', 'true');
  // Creating a file opens it and focuses its editor (a user action); the next step starts once that has happened.
  await expect(shell.getByTestId('code-editor').locator('.monaco-editor')).toHaveClass(/focused/);

  await filesRow(shell, 'src').focus();
  await shell.getByTestId('files-new-folder').click();
  await shell.getByTestId('files-edit-input').fill('nested');
  await shell.getByTestId('files-edit-input').press('Enter');
  await expect.poll(() => fs.statSync(path.join(home.project, 'src', 'nested'), { throwIfNoEntry: false })?.isDirectory()).toBe(true);

  // A name that exists is refused as it is typed: Enter does nothing, and leaving the box cancels it (VS Code's explorer).
  await filesRow(shell, 'src/old.ts').focus();
  await shell.keyboard.press('F2');
  await shell.getByTestId('files-edit-input').fill('fresh.ts');
  await expect(shell.getByTestId('files-edit-message')).toContainText('already exists');
  await expect(shell.getByTestId('files-edit-input')).toHaveAttribute('aria-invalid', 'true');
  await shell.getByTestId('files-edit-input').press('Enter');
  await expect(shell.getByTestId('files-edit-input')).toBeVisible();
  await filesRow(shell, 'src/nested').click();
  await expect(shell.getByTestId('files-edit-input')).toHaveCount(0);
  expect(fs.existsSync(path.join(home.project, 'src', 'old.ts'))).toBe(true);
  // The tree takes keys again, and leaving the box with a valid name renames.
  await filesRow(shell, 'src/old.ts').focus();
  await shell.keyboard.press('F2');
  await shell.getByTestId('files-edit-input').fill('renamed.ts');
  await expect(shell.getByTestId('files-edit-message')).toHaveCount(0);
  await filesRow(shell, 'src/nested').click();
  await expect.poll(() => fs.existsSync(path.join(home.project, 'src', 'renamed.ts'))).toBe(true);
  expect(fs.existsSync(path.join(home.project, 'src', 'old.ts'))).toBe(false);
  await expect(shell.getByTestId('files-edit-input')).toHaveCount(0);

  const overlay = await overlayPage(app);
  await filesRow(shell, 'src/renamed.ts').click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(overlay.getByTestId('overlay-menu-caption')).toHaveText('src/renamed.ts');
  expect(await overlayMenu(overlay).locator('[data-menu-item]').allTextContents()).toEqual([
    'OpenClick', 'Open in focus overlay', 'Mention in chatDrag', 'RenameF2', 'DeleteDel', 'Copy path', 'Copy relative path', 'Reveal in File Explorer',
  ]);
  await menuItem(overlay, 'copyRelativePath').click();
  await expect.poll(() => clipboard.readText(app)).toBe(path.join('src', 'renamed.ts'));

  await filesRow(shell, 'src/renamed.ts').focus();
  await shell.keyboard.press('Delete');
  const dialog = overlay.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: /Move to Trash|Delete/ }).click();
  await expect.poll(() => fs.existsSync(path.join(home.project, 'src', 'renamed.ts'))).toBe(false);
  await expect(filesRow(shell, 'src/renamed.ts')).toHaveCount(0);
});

test('a markdown file offers Open preview and Open source; Mention in chat and a drag from Files both mention the file in the composer', async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'NOTES.md'), '# Notes\n\nSome **bold** text.\n');
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);

  await filesRow(shell, 'NOTES.md').click({ button: 'right' });
  expect(await overlayMenu(overlay).locator('[data-menu-item]').allTextContents()).toContain('Open previewClick');
  await menuItem(overlay, 'openSource').click();
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('code');
  await filesRow(shell, 'NOTES.md').click();
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('markdownPreview');
  await expect(shell.getByTestId('markdown-preview').locator('h1')).toHaveText('Notes');
  await expect(shell.getByTestId('markdown-preview').locator('strong')).toHaveText('bold');

  await filesRow(shell, 'NOTES.md').click({ button: 'right' });
  await menuItem(overlay, 'mention').click();
  await expect(chatInput(chat)).toHaveValue('@NOTES.md ');
  await chatInput(chat).fill('');

  // A drag carries the project and relative path; the composer turns the drop into the same mention core resolves.
  const payload = await filesRow(shell, 'NOTES.md').evaluate((row, mime) => {
    const data = new DataTransfer();
    row.dispatchEvent(new DragEvent('dragstart', { dataTransfer: data, bubbles: true, cancelable: true }));
    return data.getData(mime);
  }, FILE_DRAG_MIME);
  expect(JSON.parse(payload)).toEqual({ projectKey: await selectedProjectKey(app), relativePath: 'NOTES.md' });
  const composer = chat.getByTestId('composer');
  await composer.evaluate((card, [mime, value]) => {
    const data = new DataTransfer();
    data.setData(mime, value);
    card.dispatchEvent(new DragEvent('dragenter', { dataTransfer: data, bubbles: true, cancelable: true }));
    card.dispatchEvent(new DragEvent('dragover', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [FILE_DRAG_MIME, payload] as const);
  await expect(chat.getByTestId('composer-drop-target')).toHaveText('Drop to mention in chat');
  await composer.evaluate((card, [mime, value]) => {
    const data = new DataTransfer();
    data.setData(mime, value);
    card.dispatchEvent(new DragEvent('drop', { dataTransfer: data, bubbles: true, cancelable: true }));
  }, [FILE_DRAG_MIME, payload] as const);
  await expect(chat.getByTestId('composer-drop-target')).toBeHidden();
  await expect(chatInput(chat)).toHaveValue('@NOTES.md ');
});

test('the active editor file is revealed in Files: its folders expand, its row is selected and scrolled into view, and focus stays in the editor', async ({ home, launch }) => {
  // Sixty folders above src push its rows below the fold.
  for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(home.project, `dir${String(i).padStart(2, '0')}`));
  fs.writeFileSync(path.join(home.project, 'dir00', 'a.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(home.project, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'deep', 'x.ts'), 'export const x = 1;\n');
  fs.mkdirSync(path.join(home.project, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect(filesRow(shell, 'dir00')).toBeVisible();

  const overlay = await quickOpen(app, 'deep/x.ts');
  await expect(quickPick(overlay).getByTestId('quick-pick-item').first()).toContainText('x.ts');
  await overlay.getByTestId('quick-pick-input').press('Enter');
  await editorShows(shell, 'export const x = 1;');
  const row = filesRow(shell, 'src/deep/x.ts');
  await expect(filesRow(shell, 'src/deep')).toHaveAttribute('aria-expanded', 'true');
  await expect(row).toHaveAttribute('aria-selected', 'true');
  await expect(row).toHaveAttribute('tabindex', '0');
  await expect(row).toBeInViewport();
  await expect(row).not.toBeFocused();

  await filesTree(shell).evaluate((tree) => { tree.scrollTop = 0; });
  await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'dir00/a.ts' });
  await expect(filesRow(shell, 'dir00/a.ts')).toHaveAttribute('aria-selected', 'true');
  // Switching back to the tab reveals its file again.
  await editorTab(shell, 'x.ts').click();
  await expect(row).toBeInViewport();
  await expect(row).toHaveAttribute('aria-selected', 'true');

  // node_modules is VS Code's autoRevealExclude default: the tree stays as it is.
  await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'node_modules/pkg/index.js' });
  await expect(editorTab(shell, 'index.js')).toHaveAttribute('aria-selected', 'true');
  await expect(filesRow(shell, 'node_modules')).toHaveAttribute('aria-expanded', 'false');
});

test('the markdown preview fills the pane, and a table keeps its short columns whole beside a long cell', async ({ home, launch }) => {
  const goal = 'Send any health-check photo that is not a hardcoded sample to the real detector over the speech service tailnet. '.repeat(4);
  fs.writeFileSync(path.join(home.project, 'PLAN.md'), `# Plan\n\n| Stream | Status | Goal |\n| --- | --- | --- |\n| green-ai | active | ${goal} |\n`);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await filesRow(shell, 'PLAN.md').click();
  const preview = shell.getByTestId('markdown-preview');
  await expect(preview.locator('th', { hasText: 'Status' })).toBeVisible();

  // A cell's word on one line: the anywhere wrap shrank these columns to one character, one letter per line.
  const lines = (cell: string): Promise<number> => preview.locator('th, td').filter({ hasText: new RegExp(`^${cell}$`) }).evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
  });
  // green-ai may still wrap at its hyphen, as in VS Code's preview.
  const cells = ['Stream', 'Status', 'active'];
  expect(Object.fromEntries(await Promise.all(cells.map(async (cell) => [cell, await lines(cell)] as const)))).toEqual(Object.fromEntries(cells.map((cell) => [cell, 1])));
  const widths = await preview.evaluate((container) => ({ pane: container.clientWidth, article: container.querySelector('article')!.getBoundingClientRect().width }));
  expect(widths.article).toBe(widths.pane);
});

test('a Files rename moves the open tab, its unsaved text and caret to a model at the new path, and a deleted file\'s tab is marked Deleted, clean, until a save recreates it', async ({ foreground: _foreground, home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const notes = path.join(home.project, 'src', 'notes.js');
  const renamed = path.join(home.project, 'src', 'renamed.ts');
  fs.writeFileSync(notes, 'const typed: number = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const errors = codeEditor(shell).locator('.squiggly-error');
  await filesRow(shell, 'src').click();
  await filesRow(shell, 'src/notes.js').click();
  await expect(editorTab(shell, 'notes.js')).toHaveAttribute('aria-selected', 'true');
  await editorShows(shell, 'const typed');
  // A type annotation is a syntax error in a .js file.
  await expect(errors.first()).toBeVisible();
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// unsaved');
  await expect(editorTab(shell, 'notes.js')).toHaveAttribute('data-dirty', 'true');
  const tabId = (await activeTab(app))!.id;

  await filesRow(shell, 'src/notes.js').focus();
  await shell.keyboard.press('F2');
  await shell.getByTestId('files-edit-input').fill('renamed.ts');
  await shell.getByTestId('files-edit-input').press('Enter');
  await expect.poll(() => fs.existsSync(renamed)).toBe(true);
  await expect.poll(() => activeTab(app)).toMatchObject({ id: tabId, title: 'renamed.ts', relativePath: 'src/renamed.ts', dirty: true });
  await expect(shell.getByTestId('editor-tab')).toHaveCount(1);
  await expect(filesRow(shell, 'src/renamed.ts')).toBeFocused();
  await editorShows(shell, '// unsaved');
  // The model now lives at renamed.ts, so the TypeScript service reads the annotation as TypeScript.
  await expect(errors).toHaveCount(0);
  // As in VS Code, undo starts afresh on the moved model, and the caret stays where it was.
  await editorTab(shell, 'renamed.ts').click();
  await expect(codeEditor(shell).locator('.monaco-editor')).toHaveClass(/focused/);
  await shell.keyboard.press('ControlOrMeta+Z');
  await shell.keyboard.type('!');
  await expect.poll(() => bufferText(shell)).toContain('// unsaved!');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(renamed, 'utf8')).toContain('// unsaved!');
  expect(fs.existsSync(notes)).toBe(false);
  await expect(editorTab(shell, 'renamed.ts')).not.toHaveAttribute('data-dirty', 'true');

  // Deleted on disk: the tab stays, struck through and clean, and Ctrl+S writes the file back (VS Code's orphaned editor).
  fs.rmSync(renamed);
  await expect(editorTab(shell, 'renamed.ts')).toHaveAttribute('data-deleted', 'true');
  await expect(editorTab(shell, 'renamed.ts').getByTestId('editor-tab-title')).toHaveCSS('text-decoration-line', 'line-through');
  await expect(editorTab(shell, 'renamed.ts')).toHaveAttribute('title', /renamed\.ts\nDeleted$/);
  expect((await activeTab(app))?.dirty).toBe(false);
  await codeEditor(shell).locator('.view-lines').click();
  await saveWithKeyboard(app);
  await expect.poll(() => fs.existsSync(renamed)).toBe(true);
  expect(fs.readFileSync(renamed, 'utf8')).toContain('// unsaved!');
  await expect(editorTab(shell, 'renamed.ts')).not.toHaveAttribute('data-deleted');
});

const HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };

async function failFiles(app: ElectronApplication, failure: { trash?: string; remove?: string }): Promise<void> {
  await app.evaluate((_electron, arg) => {
    (globalThis as unknown as { __damoclesE2e: { failFiles(failure: object): void } }).__damoclesE2e.failFiles(arg);
  }, failure);
}

test('a failed move to the trash offers Delete Permanently after a confirmation, and a failed delete is one toast naming the file and the reason', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const locked = path.join(home.project, 'src', 'locked.ts');
  const kept = path.join(home.project, 'src', 'kept.ts');
  fs.writeFileSync(locked, 'export {};\n');
  fs.writeFileSync(kept, 'export {};\n');
  const { app } = await launch(HOOKS);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  const dialog = overlay.getByRole('alertdialog');
  await failFiles(app, { trash: 'The Recycle Bin is not available' });

  await filesRow(shell, 'src').click();
  await filesRow(shell, 'src/locked.ts').focus();
  await shell.keyboard.press('Delete');
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();
  await expect(dialog).toContainText("'locked.ts' could not be moved to the trash. Do you want to delete it permanently instead?");
  await expect(dialog).toContainText('The Recycle Bin is not available');
  await expect(dialog).toContainText('This action is irreversible.');
  await dialog.getByRole('button', { name: 'Delete Permanently' }).click();
  await expect.poll(() => fs.existsSync(locked)).toBe(false);
  await expect(filesRow(shell, 'src/locked.ts')).toHaveCount(0);

  await failFiles(app, { remove: 'EBUSY: resource busy or locked' });
  await filesRow(shell, 'src/kept.ts').focus();
  await shell.keyboard.press('Delete');
  await dialog.getByRole('button', { name: 'Move to Trash' }).click();
  await dialog.getByRole('button', { name: 'Delete Permanently' }).click();
  const toast = popupToasts(await popupPage(app)).filter({ hasText: 'Damocles could not delete' });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('Damocles could not delete kept.ts: EBUSY: resource busy or locked');
  expect(fs.existsSync(kept)).toBe(true);
  // The tree stays as the disk is and takes keys again.
  await expect(filesRow(shell, 'src/kept.ts')).toBeVisible();
  await filesRow(shell, 'src/kept.ts').focus();
  await shell.keyboard.press('Delete');
  await expect(dialog).toContainText("Are you sure you want to delete 'kept.ts'?");
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(toast).toHaveCount(1);
});

test('New file in a folder that cannot be listed opens no name box, is one toast naming the folder, and the tree takes keys again', async ({ home, launch }) => {
  // A junction to a folder outside the project lists as a folder, and main refuses to list what it points to.
  const outside = path.join(path.dirname(home.project), 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(home.project, 'linked'), 'junction');
  fs.writeFileSync(path.join(home.project, 'notes.txt'), 'notes\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  await expect(filesRow(shell, 'linked')).toBeVisible();
  await filesRow(shell, 'linked').focus();
  await shell.getByTestId('files-new-file').click();
  const toast = popupToasts(await popupPage(app)).filter({ hasText: 'Damocles could not open the folder' });
  await expect(toast).toHaveCount(1);
  await expect(toast).toContainText('Damocles could not open the folder linked: That location is outside the project.');
  await expect(shell.getByTestId('files-edit-input')).toHaveCount(0);
  await filesRow(shell, 'notes.txt').focus();
  await shell.keyboard.press('F2');
  await expect(shell.getByTestId('files-edit-input')).toBeFocused();
  await shell.keyboard.press('Escape');
});

test('expanding a folder that cannot be listed, by click or by key, collapses it and is one toast per expand', async ({ home, launch }) => {
  const outside = path.join(path.dirname(home.project), 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, path.join(home.project, 'linked'), 'junction');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  await filesRow(shell, 'linked').click();
  const toast = popupToasts(await popupPage(app)).filter({ hasText: 'Damocles could not open the folder linked: That location is outside the project.' });
  await expect(toast).toHaveCount(1);
  await expect(filesRow(shell, 'linked')).toHaveAttribute('aria-expanded', 'false');
  await filesRow(shell, 'linked').focus();
  await shell.keyboard.press('ArrowRight');
  await expect(toast).toHaveCount(2);
  await expect(filesRow(shell, 'linked')).toHaveAttribute('aria-expanded', 'false');
});

// VS Code's reveal opens the side bar: the tab menu's Reveal in Files shows a hidden sidebar and leaves the focus overlay.
test('Reveal in Files from the editor tab menu shows a hidden sidebar, leaves the focus overlay and focuses the row of the file', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src', 'deep'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'deep', 'x.ts'), 'export const x = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'src/deep/x.ts' });
  await editorShows(shell, 'export const x = 1;');
  const row = filesRow(shell, 'src/deep/x.ts');

  await shell.getByTestId('toggle-sidebar').click();
  await expect(shell.getByTestId('sidebar')).toHaveAttribute('inert', '');
  await editorTab(shell, 'x.ts').click({ button: 'right' });
  await chooseMenuItem(app, 'revealInFiles');
  await expect(shell.getByTestId('sidebar')).not.toHaveAttribute('inert');
  expect((await shellState(app)).layout.sidebarVisible).toBe(true);
  await expect(row).toBeFocused();
  await expect(row).toBeInViewport();

  await shell.getByTestId('editor-focus-toggle').click();
  await expect(shell.getByTestId('focus-overlay-scrim')).toBeVisible();
  await editorTab(shell, 'x.ts').click({ button: 'right' });
  await chooseMenuItem(app, 'revealInFiles');
  await expect(shell.getByTestId('focus-overlay-scrim')).toHaveCount(0);
  await expect(row).toBeFocused();
});
