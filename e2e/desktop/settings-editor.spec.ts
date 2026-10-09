import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { overlayPage, shellPage, shellState } from './support/shell';
import { chooseSegment, editSettingsFile, openSettingsModal, settingsRow } from './support/settings';
import { openProjectChat } from './support/screenshots';
import { activeTab, codeEditor, conflictBar, diffEditor, editorTab, saveWithKeyboard } from './support/editor';

const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

/** Selects all and pastes `text`; pasted text skips Monaco's auto-closing and auto-indent, which would alter typed JSON. */
async function replaceText(editor: Locator, text: string): Promise<void> {
  await editor.locator('.lines-content > .view-lines').click();
  await editor.page().keyboard.press(SELECT_ALL);
  await editor.locator('.native-edit-context, textarea.inputarea').first().evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

const ORIGINAL = '{\n  "damocles.maxTurns": 40\n}\n';
const MINE = '{\n  "damocles.maxTurns": 12\n}\n';
const THEIRS = '{\n  "damocles.maxTurns": 40,\n  "damocles.taskBudget": 5000\n}\n';

test('Edit settings.json opens a pane tab: the schema flags unknown keys, a valid save writes the text verbatim, text that does not parse is refused', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  writeUserSettings(home, { 'damocles.maxTurns': 40, 'damocles.notARealSetting': true });
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  await editSettingsFile(app, 'user');
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('settings');
  expect((await activeTab(app))?.settingsScope).toBe('user');
  await expect(editorTab(shell, 'settings.json')).toHaveAttribute('aria-selected', 'true');
  const editor = codeEditor(shell);
  await expect(editor).toHaveAttribute('data-monaco-ready', 'true');
  await expect(editor.locator('.view-line', { hasText: 'damocles.notARealSetting' })).toBeVisible();
  await expect(editor.locator('.squiggly-error, .squiggly-warning').first()).toBeAttached();

  await replaceText(editor, MINE);
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(userFile, 'utf8')).toBe(MINE);
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(false);

  await replaceText(editor, '{\n  "damocles.maxTurns": \n');
  await saveWithKeyboard(app);
  await expect(shell.getByTestId('editor-save-error')).toBeVisible();
  expect(fs.readFileSync(userFile, 'utf8')).toBe(MINE);
  expect((await activeTab(app))?.dirty).toBe(true);
});

test('a settings file changed on disk under unsaved edits shows the conflict bar; Overwrite asks first, Compare opens a diff tab', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, ORIGINAL);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);

  await editSettingsFile(app, 'user');
  const editor = codeEditor(shell);
  await expect(editor.locator('.view-line', { hasText: 'damocles.maxTurns' })).toBeVisible();
  await replaceText(editor, MINE);
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
  fs.writeFileSync(userFile, THEIRS);
  await expect(conflictBar(shell)).toBeVisible();

  await conflictBar(shell).getByTestId('conflict-overwrite').click();
  const dialog = overlay.getByRole('alertdialog');
  await expect(dialog).toBeVisible();
  expect(fs.readFileSync(userFile, 'utf8')).toBe(THEIRS);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(conflictBar(shell)).toBeVisible();
  expect(fs.readFileSync(userFile, 'utf8')).toBe(THEIRS);

  await conflictBar(shell).getByTestId('conflict-compare').click();
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
  await expect(diffEditor(shell).locator('.editor.original .view-line', { hasText: 'damocles.taskBudget' })).toBeVisible();
  await expect(diffEditor(shell).locator('.editor.modified .view-line', { hasText: '"damocles.maxTurns": 12' })).toBeVisible();
});

test('a project settings tab validates against the project schema, which flags a user-only key, and the Files and search row opens settings.json', async ({ home, launch }) => {
  const projectFile = path.join(home.project, '.damocles', 'settings.json');
  fs.mkdirSync(path.dirname(projectFile), { recursive: true });
  fs.writeFileSync(projectFile, JSON.stringify({ 'damocles.maxTurns': 7, 'damocles.permissionMode': 'plan' }, null, 2));
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  await editSettingsFile(app, 'project');
  await expect.poll(async () => (await activeTab(app))?.settingsScope).toBe('project');
  await expect(codeEditor(shell).locator('.view-line', { hasText: 'damocles.permissionMode' })).toBeVisible();
  await expect(codeEditor(shell).locator('.squiggly-error, .squiggly-warning').first()).toBeAttached();

  const settings = await openSettingsModal(app, 'files');
  await expect(settingsRow(settings, 'damocles.desktop.files.exclude').getByTestId('files-exclude-patterns')).toContainText('**/.git');
  await settings.getByTestId('files-exclude-edit').click();
  await expect.poll(async () => (await activeTab(app))?.settingsScope).toBe('user');
});

test('the Editor settings section applies a font size and word wrap to an open editor at once', async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'wide.ts'), `export const wide = '${'x'.repeat(400)}';\n`);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const projectKey = (await shellState(app)).selected.projectKey!;
  await shell.evaluate((key) => window.damoclesShell!.openEditor({ projectKey: key, relativePath: 'wide.ts' }), projectKey);
  await expect(codeEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  const lineHeight = (): Promise<number> => codeEditor(shell).locator('.view-line').first().evaluate((line) => line.getBoundingClientRect().height);
  const before = await lineHeight();

  const settings = await openSettingsModal(app, 'editor');
  const size = settingsRow(settings, 'damocles.desktop.editor.fontSize').getByRole('textbox');
  await size.fill('20');
  await size.press('Enter');
  await chooseSegment(settingsRow(settings, 'damocles.desktop.editor.wordWrap'), 'On');
  await expect.poll(lineHeight).toBeGreaterThan(before);
  await expect.poll(() => codeEditor(shell).locator('.view-line').count()).toBeGreaterThan(1);
});
