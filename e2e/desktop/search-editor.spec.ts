import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, pressKeys, PRIMARY, selectedProjectKey, shellPage } from './support/shell';
import { menuItem, overlayMenu } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { activeTab, editorState, editorTab, filesRow, saveWithKeyboard } from './support/editor';
import { writeUserSettings } from './support/hermetic';

// The primary modifier as Playwright names it in the page: Control, or Meta on macOS.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

const searchEditor = (shell: Page): Locator => shell.getByTestId('search-editor');
const editorQuery = (shell: Page): Locator => shell.getByTestId('search-editor-query');
const body = (shell: Page): Locator => searchEditor(shell).getByTestId('code-editor');
// A file line's path uses the platform's separator, as VS Code's label service writes it.
const fileLine = (relativePath: string): string => `${relativePath.split('/').join(path.sep)}:`;

function write(root: string, relativePath: string, content: string): string {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

/** The body's visible lines as Monaco draws them, with its non-breaking spaces read as spaces. */
async function bodyLines(shell: Page): Promise<string[]> {
  return body(shell).locator('.view-line').evaluateAll((lines) => lines
    .map((line) => ({ top: Number.parseFloat((line as HTMLElement).style.top), text: (line.textContent ?? '').replace(/\u00a0/g, ' ') }))
    .sort((a, b) => a.top - b.top)
    .map((line) => line.text));
}

/** Opens a blank Search Editor from the Search section's title bar. */
async function newSearchEditor(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await pressKeys(app, '/shell/', 'F', [PRIMARY, 'shift']);
  await shell.getByTestId('search-new-editor').click();
  await expect(searchEditor(shell)).toBeVisible();
  await expect(body(shell)).toHaveAttribute('data-monaco-ready', 'true');
  return shell;
}

async function runQuery(shell: Page, query: string): Promise<void> {
  await editorQuery(shell).fill(query);
  await editorQuery(shell).press('Enter');
  await expect(shell.getByTestId('search-editor-progress')).toHaveCount(0);
}

test('a Search Editor runs a query with context lines in VS Code\'s layout, highlights the matches, and a double-click opens the match', async ({ home, launch }) => {
  write(home.project, 'src/a.ts', 'one\nneedle here\nthree\nfour\nfive\nneedle again\n');
  write(home.project, 'b.md', 'needle\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await newSearchEditor(app);
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('searchEditor');
  await expect(shell.getByTestId('search-editor-option-context')).toHaveAttribute('aria-pressed', 'true');
  await expect(shell.getByTestId('search-editor-context-lines')).toHaveValue('1');
  await runQuery(shell, 'needle');
  await expect.poll(() => bodyLines(shell)).toEqual([
    '3 results - 2 files',
    '',
    'b.md:',
    '  1: needle',
    '',
    fileLine('src/a.ts'),
    '  1  one',
    '  2: needle here',
    '  3  three',
    '',
    '  5  five',
    '  6: needle again',
    '',
  ]);
  await expect(body(shell).locator('.search-editor-match')).toHaveCount(3);
  await expect(editorTab(shell, 'Search: needle')).toBeVisible();

  // Context lines off, then back to two with the number input.
  await shell.getByTestId('search-editor-option-context').click();
  await expect.poll(() => bodyLines(shell)).not.toContain('  1  one');
  await shell.getByTestId('search-editor-context-lines').fill('2');
  await expect(shell.getByTestId('search-editor-option-context')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => bodyLines(shell)).toContain('  4  four');

  await body(shell).locator('.view-line', { hasText: 'needle again' }).dblclick();
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('src/a.ts');
});

test('Open in editor copies the Search view\'s results into a Search Editor, and Go to Definition on a result line opens the file', async ({ home, launch }) => {
  write(home.project, 'lib/x.ts', 'const target = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await pressKeys(app, '/shell/', 'F', [PRIMARY, 'shift']);
  await shell.getByTestId('search-query').fill('target');
  await shell.getByTestId('search-query').press('Enter');
  await expect(shell.getByTestId('search-summary')).toContainText('1 result in 1 file - Open in editor');
  await shell.getByTestId('search-open-in-editor').click();
  await expect(searchEditor(shell)).toBeVisible();
  await expect(editorQuery(shell)).toHaveValue('target');
  await expect.poll(() => bodyLines(shell)).toContain(fileLine('lib/x.ts'));
  await expect.poll(() => bodyLines(shell)).toContain('  1: const target = 1;');

  await body(shell).locator('.view-line', { hasText: 'const target' }).click();
  await shell.keyboard.press('F12');
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('lib/x.ts');
});

test('Enter runs, Ctrl+Enter adds a line to the query, Search Again re-runs after a file changes, and Escape in the body returns to the query', async ({ home, launch }) => {
  const file = write(home.project, 'a.ts', 'alpha\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await newSearchEditor(app);
  await runQuery(shell, 'alpha');
  await expect.poll(() => bodyLines(shell)).toContain('  1: alpha');

  fs.writeFileSync(file, 'alpha\nalpha twice\n');
  await body(shell).locator('.view-line').first().click();
  await pressKeys(app, '/shell/', 'R', [PRIMARY, 'shift']);
  await expect.poll(() => bodyLines(shell)).toContain('  2: alpha twice');
  await shell.keyboard.press('Escape');
  await expect(editorQuery(shell)).toBeFocused();

  await shell.keyboard.press('End');
  await shell.keyboard.press(`${MOD}+Enter`);
  await shell.keyboard.type('x');
  await expect(editorQuery(shell)).toHaveValue('alpha\nx');
});

test('Save As writes VS Code\'s .code-search format, and opening the file again restores its query with Run Search', async ({ home, launch }) => {
  write(home.project, 'a.ts', 'needle\n');
  const target = path.join(home.project, 'saved.code-search');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await newSearchEditor(app);
  await runQuery(shell, 'needle');
  await expect.poll(() => bodyLines(shell)).toContain('  1: needle');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(false);

  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = (() => Promise.resolve({ canceled: false, filePath })) as typeof dialog.showSaveDialog;
  }, target);
  await body(shell).locator('.view-line').first().click();
  await saveWithKeyboard(app);
  // A save creates the file before it writes it, and the tab takes the file's name only once the write is done.
  await expect(editorTab(shell, 'Search: saved')).toBeVisible();
  expect(fs.readFileSync(target, 'utf8')).toBe('# Query: needle\n# ContextLines: 1\n\n1 result - 1 file\n\na.ts:\n  1: needle\n');

  const searchTab = (await activeTab(app))!;
  await pressKeys(app, '/shell/', 'W', [PRIMARY]);
  await expect.poll(async () => (await editorState(app)).tabs.some((tab) => tab.id === searchTab.id)).toBe(false);

  await expect(filesRow(shell, 'saved.code-search')).toBeVisible();
  await filesRow(shell, 'saved.code-search').click();
  await expect(searchEditor(shell)).toBeVisible();
  await expect(editorQuery(shell)).toHaveValue('needle');
  await expect.poll(() => bodyLines(shell)).toContain('  1: needle');
  // A reopened file holds results but no highlights; VS Code offers Run Search only when it holds none.
  await expect(body(shell).locator('.search-editor-match')).toHaveCount(0);
});

test('a dirty untitled Search Editor survives quit and relaunch', async ({ home, launch }) => {
  write(home.project, 'a.ts', 'needle\n');
  {
    const { app, close } = await launch();
    await openProjectChat(app, home.project);
    const shell = await newSearchEditor(app);
    await runQuery(shell, 'needle');
    await expect.poll(() => bodyLines(shell)).toContain('  1: needle');
    await body(shell).locator('.view-line', { hasText: 'needle' }).last().click();
    await shell.keyboard.press('End');
    await shell.keyboard.type(' // note');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    await close();
  }
  const { app } = await launch();
  const shell = await shellPage(app);
  await expect.poll(async () => (await editorState(app)).tabs.map((tab) => `${tab.kind}:${tab.title}:${tab.dirty}`)).toContain('searchEditor:Search: needle:true');
  const restored = editorTab(shell, 'Search: needle');
  await expect(restored).toHaveAttribute('data-dirty', 'true');
  await restored.click();
  await expect(editorQuery(shell)).toHaveValue('needle');
  await expect.poll(() => bodyLines(shell)).toContain('  1: needle // note');
});

test('Find in Folder... with search.mode newEditor opens a Search Editor scoped to the folder', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.desktop.search.mode': 'newEditor' });
  write(home.project, 'src/a.ts', 'needle\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const projectKey = await selectedProjectKey(app);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  await filesRow(shell, 'src').click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, 'findInFolder').click();
  await expect(searchEditor(shell)).toBeVisible();
  await expect(shell.getByTestId('search-editor-include')).toHaveValue('./src');
  expect((await activeTab(app))?.projectKey).toBe(projectKey);
});
