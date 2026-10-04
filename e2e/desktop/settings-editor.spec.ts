import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { addProject, chatInput } from './support/ui';
import { editSettingsFile as editFromModal } from './support/settings';

const SELECT_ALL = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';

/** Selects all and pastes `text`; pasted text skips Monaco's auto-closing and auto-indent, which would alter typed JSON. */
async function replaceText(editor: Locator, text: string): Promise<void> {
  // Below 900px the diff editor goes inline and draws deleted lines in a view zone with its own `.view-lines`.
  await editor.locator('.lines-content > .view-lines').click();
  await editor.page().keyboard.press(SELECT_ALL);
  await editor.locator('.native-edit-context, textarea.inputarea').first().evaluate((input, pasted) => {
    const data = new DataTransfer();
    data.setData('text/plain', pasted);
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, text);
}

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

async function openUserEditor(app: ElectronApplication, tab: Page): Promise<Locator> {
  await editFromModal(app, 'user');
  const monaco = tab.getByTestId('settings-json-editor-monaco');
  await expect(monaco).toHaveAttribute('data-monaco-ready', 'true');
  return monaco;
}

const ORIGINAL = '{\n  "damocles.maxTurns": 40\n}\n';
const MINE = '{\n  "damocles.maxTurns": 12\n}\n';
const THEIRS = '{\n  "damocles.maxTurns": 40,\n  "damocles.taskBudget": 5000\n}\n';
const MERGED = '{\n  "damocles.maxTurns": 12,\n  "damocles.taskBudget": 5000\n}\n';

/** Edits the user file in the editor, then lets another writer change it on disk, so the next save conflicts. */
async function conflictingSave(app: ElectronApplication, tab: Page, userFile: string): Promise<Locator> {
  const monaco = await openUserEditor(app, tab);
  await expect(monaco.locator('.view-line', { hasText: 'damocles.maxTurns' })).toBeVisible();
  await replaceText(monaco, MINE);
  await expect(tab.getByTestId('settings-json-editor')).toHaveAttribute('data-dirty', 'true');
  fs.writeFileSync(userFile, THEIRS);
  await expect(tab.getByTestId('settings-json-reload-prompt')).toBeVisible();
  await tab.getByTestId('settings-json-save').click();
  const conflict = tab.getByTestId('settings-json-conflict');
  await expect(conflict).toBeVisible();
  return conflict;
}

test('settings editor conflict: Compare merges in an editable diff and saves over the newer file', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  writeUserSettings(home, { 'damocles.maxTurns': 40 });
  fs.writeFileSync(userFile, ORIGINAL);
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();

  const conflict = await conflictingSave(app, tab, userFile);
  expect(fs.readFileSync(userFile, 'utf8')).toBe(THEIRS);
  await conflict.getByTestId('settings-json-compare').click();

  const editor = tab.getByTestId('settings-json-editor');
  const compareView = tab.getByTestId('settings-json-compare-view');
  await expect(editor).toHaveAttribute('data-comparing', 'true');
  await expect(tab.getByTestId('settings-json-compare-banner')).toBeVisible();
  await expect(compareView.locator('.editor.original .view-line', { hasText: 'damocles.taskBudget' })).toBeVisible();
  const modified = compareView.locator('.editor.modified');
  await expect(modified.locator('.view-line', { hasText: '"damocles.maxTurns": 12' })).toBeVisible();

  await replaceText(modified, MERGED);
  await tab.getByTestId('settings-json-save').click();
  await expect.poll(() => fs.readFileSync(userFile, 'utf8')).toBe(MERGED);
  await expect(editor).toHaveAttribute('data-comparing', 'false');
  await expect(editor).toHaveAttribute('data-dirty', 'false');
  await expect(tab.getByTestId('settings-json-conflict')).toBeHidden();
});

test('settings editor conflict: Overwrite asks first, and only then saves the user text over the newer file', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  writeUserSettings(home, { 'damocles.maxTurns': 40 });
  fs.writeFileSync(userFile, ORIGINAL);
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();

  const conflict = await conflictingSave(app, tab, userFile);
  await conflict.getByTestId('settings-json-overwrite').click();
  const confirm = tab.getByTestId('settings-json-overwrite-confirm');
  await expect(confirm).toBeVisible();
  await expect(confirm.getByTestId('settings-json-overwrite-path')).toHaveText(userFile);
  await confirm.getByTestId('settings-json-overwrite-cancel').click();
  await expect(confirm).toBeHidden();
  expect(fs.readFileSync(userFile, 'utf8')).toBe(THEIRS);
  await expect(tab.getByTestId('settings-json-editor')).toHaveAttribute('data-dirty', 'true');

  await conflict.getByTestId('settings-json-overwrite').click();
  await confirm.getByTestId('settings-json-overwrite-confirm-button').click();
  await expect.poll(() => fs.readFileSync(userFile, 'utf8')).toBe(MINE);
  await expect(tab.getByTestId('settings-json-editor')).toHaveAttribute('data-dirty', 'false');
  await expect(confirm).toBeHidden();
});

test('settings editor: opening a settings file while the editor holds unsaved edits never loses them', async ({ home, launch }) => {
  const userFile = path.join(home.damoclesDir, 'settings.json');
  writeUserSettings(home, { 'damocles.maxTurns': 40 });
  fs.writeFileSync(userFile, ORIGINAL);
  const { app } = await launch();
  const tab = await openProject(app, home);
  const editor = tab.getByTestId('settings-json-editor');

  const monaco = await openUserEditor(app, tab);
  await expect(monaco.locator('.view-line', { hasText: 'damocles.maxTurns' })).toBeVisible();
  await replaceText(monaco, MINE);
  await expect(editor).toHaveAttribute('data-dirty', 'true');
  await expect.poll(() => tab.evaluate(() => document.querySelector('[data-testid="settings-json-editor"]')?.contains(document.activeElement) === true)).toBe(true);

  // Settings opens over the editor; the same file brings the editor back as it was.
  await editFromModal(app, 'user');
  await expect(editor).toHaveAttribute('data-scope', 'user');
  await expect(editor).toHaveAttribute('data-dirty', 'true');
  await expect(tab.getByText('Loading settings file...')).toBeHidden();
  await expect(monaco.locator('.view-line', { hasText: '"damocles.maxTurns": 12' })).toBeVisible();
  await expect(tab.getByTestId('settings-json-save')).toBeEnabled();

  // Another file asks before discarding the edits, and keeping them keeps the editor.
  await editFromModal(app, 'project');
  const prompt = tab.getByTestId('settings-json-discard-prompt');
  await expect(prompt).toContainText('Open Project settings and discard your unsaved changes?');
  await tab.getByTestId('settings-json-keep-editing').click();
  await expect(prompt).toBeHidden();
  await expect(editor).toHaveAttribute('data-scope', 'user');
  await expect(monaco.locator('.view-line', { hasText: '"damocles.maxTurns": 12' })).toBeVisible();

  await editFromModal(app, 'project');
  await tab.getByTestId('settings-json-discard').click();
  await expect(editor).toHaveAttribute('data-scope', 'project');
  await expect(monaco).toHaveAttribute('data-monaco-ready', 'true');
  expect(fs.readFileSync(userFile, 'utf8')).toBe(ORIGINAL);
});
