import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, pressKeys, PRIMARY, recordedToasts, recordToasts, shellPage } from './support/shell';
import { menuItem, overlayMenu } from './support/overlay';
import { openProjectChat, settled } from './support/screenshots';
import { addProject } from './support/ui';
import { codeEditor, diffEditor, DOCUMENT_END, editorShows, editorState, editorTab, filesRow, openInEditor } from './support/editor';
import { writeUserSettings } from './support/hermetic';
import { selectedProjectKey } from './support/shell';

const searchQuery = (shell: Page): Locator => shell.getByTestId('search-query');
const fileRow = (shell: Page, relativePath: string): Locator => shell.locator(`[data-testid="search-row"][data-row-kind="file"][data-path="${relativePath}"]`);
const matchRows = (shell: Page, relativePath: string): Locator => shell.locator(`[data-testid="search-row"][data-row-kind="match"][data-path="${relativePath}"]`);
const resultFiles = (shell: Page): Locator => shell.locator('[data-testid="search-row"][data-row-kind="file"]');
// The primary modifier as Playwright names it in the page: Control, or Meta on macOS.
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

/** Find in Files (Replace in Files with `replace`) from the shell, as the accelerator does; resolves once the query has focus. */
async function openSearch(app: ElectronApplication, replace = false): Promise<Page> {
  const shell = await shellPage(app);
  await pressKeys(app, '/shell/', replace ? 'H' : 'F', [PRIMARY, 'shift']);
  await expect(searchQuery(shell)).toBeFocused();
  return shell;
}

/** Types `text` as the query and waits for the search it starts to finish. */
async function search(shell: Page, text: string): Promise<void> {
  await searchQuery(shell).fill(text);
  await searchQuery(shell).press('Enter');
  await expect(shell.getByTestId('search-progress')).toHaveCount(0);
}

async function toggle(shell: Page, option: 'matchCase' | 'wholeWord' | 'isRegex' | 'useExclude' | 'preserveCase' | 'onlyOpenEditors', on: boolean): Promise<void> {
  const button = shell.getByTestId(`search-option-${option}`);
  if ((await button.getAttribute('aria-pressed')) !== String(on)) await button.click();
  await expect(button).toHaveAttribute('aria-pressed', String(on));
}

async function openDetails(shell: Page): Promise<void> {
  const details = shell.getByTestId('search-toggle-details');
  if ((await details.getAttribute('aria-expanded')) !== 'true') await details.click();
}

function write(root: string, relativePath: string, content: string | Buffer): string {
  const file = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

test('a regex with Match Case groups its matches by file, and a click opens the file at the match with it selected', async ({ home, launch }) => {
  write(home.project, 'src/auth.ts', 'const Token = 1;\nconst token = 2;\nexport function makeToken42() {}\n');
  write(home.project, 'src/util/strings.ts', '// Token here\n');
  write(home.project, 'README.md', 'token only in lower case\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await toggle(shell, 'isRegex', true);
  await toggle(shell, 'matchCase', true);
  await search(shell, 'Tok[a-z]+(\\d*)');

  await expect(resultFiles(shell)).toHaveCount(2);
  await expect(fileRow(shell, 'src/auth.ts').getByTestId('search-row-count')).toHaveText('2');
  await expect(fileRow(shell, 'src/util/strings.ts')).toContainText('src/util');
  await expect(fileRow(shell, 'README.md')).toHaveCount(0);
  await expect(shell.getByTestId('search-summary')).toHaveText('3 results in 2 files - Open in editor');
  await expect(matchRows(shell, 'src/auth.ts').first().getByTestId('search-row-match')).toHaveText('Token');
  await expect(shell.getByTestId('search-tree')).toHaveAttribute('role', 'tree');
  await expect(fileRow(shell, 'src/auth.ts')).toHaveAttribute('aria-expanded', 'true');

  await matchRows(shell, 'src/auth.ts').nth(1).click();
  await expect(editorTab(shell, 'auth.ts')).toHaveAttribute('aria-selected', 'true');
  await editorShows(shell, 'makeToken42');
  // The match is selected: Monaco draws the selection on the match's line.
  const line = codeEditor(shell).locator('.view-line', { hasText: 'makeToken42' });
  const lineTop = await line.evaluate((element) => (element as HTMLElement).style.top);
  await expect.poll(() => codeEditor(shell).locator('.selected-text').first().evaluate((element) => (element.parentElement as HTMLElement).style.top)).toBe(lineTop);

  // The keyboard walks the tree from the query: Focus Next Input (Ctrl+Down) returns to the opened match, Left goes to its
  // file and then collapses it.
  await searchQuery(shell).focus();
  await shell.keyboard.press(`${MOD}+ArrowDown`);
  await expect(matchRows(shell, 'src/auth.ts').nth(1)).toBeFocused();
  await shell.keyboard.press('ArrowLeft');
  const first = resultFiles(shell).first();
  await expect(first).toBeFocused();
  await shell.keyboard.press('ArrowLeft');
  await expect(first).toHaveAttribute('aria-expanded', 'false');
  await expect(shell.getByTestId('search-tree').locator('[role="treeitem"][tabindex="0"]')).toHaveCount(1);
});

test('include and exclude globs limit the results, a glob leaving the project is refused, and a pattern starting with "-" is text', async ({ home, launch }) => {
  write(home.project, 'src/a.ts', 'needle\n');
  write(home.project, 'src/a.test.ts', 'needle\n');
  write(home.project, 'lib/b.ts', 'needle\nrun grep -e pattern\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await search(shell, 'needle');
  await expect(resultFiles(shell)).toHaveCount(3);

  await openDetails(shell);
  await shell.getByTestId('search-include').fill('src/**');
  await shell.getByTestId('search-include').press('Enter');
  await expect(resultFiles(shell)).toHaveCount(2);
  await shell.getByTestId('search-exclude').fill('*.test.ts');
  await shell.getByTestId('search-exclude').press('Enter');
  await expect(resultFiles(shell)).toHaveCount(1);
  await expect(fileRow(shell, 'src/a.ts')).toBeVisible();

  for (const glob of ['../**', path.join(path.dirname(home.project), '**').replace(/\\/g, '/')]) {
    await shell.getByTestId('search-include').fill(glob);
    await shell.getByTestId('search-include').press('Enter');
    await expect(shell.getByTestId('search-invalid-glob')).toContainText(glob);
    await expect(resultFiles(shell)).toHaveCount(0);
  }
  await shell.getByTestId('search-include').fill('');
  await shell.getByTestId('search-exclude').fill('');
  await search(shell, '-e');
  await expect(resultFiles(shell)).toHaveCount(1);
  await expect(matchRows(shell, 'lib/b.ts').getByTestId('search-row-match')).toHaveText('-e');
});

test('node_modules is skipped until the exclude toggle is off, and a symlink to a folder outside the project yields nothing', async ({ home, launch }) => {
  write(home.project, 'src/a.ts', 'needle\n');
  write(home.project, 'node_modules/pkg/index.js', 'needle\n');
  const outside = path.join(path.dirname(home.project), 'outside');
  write(outside, 'secret.txt', 'outsideneedle\n');
  fs.symlinkSync(outside, path.join(home.project, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await search(shell, 'needle');
  await expect(resultFiles(shell)).toHaveCount(1);
  await expect(fileRow(shell, 'node_modules/pkg/index.js')).toHaveCount(0);

  await openDetails(shell);
  await toggle(shell, 'useExclude', false);
  await expect(fileRow(shell, 'node_modules/pkg/index.js')).toBeVisible();
  await expect(resultFiles(shell)).toHaveCount(2);

  await search(shell, 'outsideneedle');
  await expect(shell.getByTestId('search-no-results')).toHaveText('No results found. Review your configured exclusions and check your gitignore files - Open Settings');
  await expect(resultFiles(shell)).toHaveCount(0);
});

test('a dirty buffer is searched as the buffer, not the disk', async ({ home, launch }) => {
  write(home.project, 'src/a.ts', 'const disk = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const projectKey = await selectedProjectKey(app);
  const shell = await shellPage(app);
  await openInEditor(app, { projectKey, relativePath: 'src/a.ts' });
  await editorShows(shell, 'const disk = 1;');
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// onlyinbuffer');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('data-dirty', 'true');

  await openSearch(app);
  await search(shell, 'onlyinbuffer');
  await expect(fileRow(shell, 'src/a.ts')).toBeVisible();
  await expect(matchRows(shell, 'src/a.ts').getByTestId('search-row-match')).toHaveText('onlyinbuffer');
  expect(fs.readFileSync(path.join(home.project, 'src', 'a.ts'), 'utf8')).not.toContain('onlyinbuffer');
});

test('a query reaching 20,000 results stops and says so, and a new query replaces it', async ({ home, launch }) => {
  write(home.project, 'big.txt', 'hit\n'.repeat(20_500));
  write(home.project, 'small.txt', 'other\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await search(shell, 'hit');
  await expect(shell.getByTestId('search-limit')).toHaveText('The result set only contains a subset of all matches. Be more specific in your search to narrow down the results.');
  await expect(shell.getByTestId('search-summary')).toHaveText('20,000 results in 1 file - Open in editor');

  await search(shell, 'other');
  await expect(shell.getByTestId('search-limit')).toHaveCount(0);
  await expect(shell.getByTestId('search-summary')).toHaveText('1 result in 1 file - Open in editor');
  await expect(resultFiles(shell)).toHaveCount(1);
  await expect(fileRow(shell, 'small.txt')).toBeVisible();
});

test('Replace All asks first; an open buffer turns dirty and one undo restores it; closed files keep their encoding, BOM and EOL', async ({ home, launch }) => {
  const openFile = write(home.project, 'open.ts', 'let foo = 1;\nlet foo2 = foo;\n');
  const bom = write(home.project, 'bom.txt', Buffer.from('\uFEFFfoo one\r\nfoo two\r\n', 'utf8'));
  const utf16 = write(home.project, 'wide.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('foo wide\r\n', 'utf16le')]));
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const projectKey = await selectedProjectKey(app);
  const shell = await shellPage(app);
  await openInEditor(app, { projectKey, relativePath: 'open.ts' });
  await editorShows(shell, 'let foo = 1;');

  await openSearch(app, true);
  await search(shell, 'foo');
  await expect(shell.getByTestId('search-summary')).toHaveText('6 results in 3 files - Open in editor');
  await shell.getByTestId('search-replace').fill('bar');
  // In replace mode each row shows what goes and what comes.
  await expect(matchRows(shell, 'bom.txt').first().getByTestId('search-row-removed')).toHaveText('foo');
  await expect(matchRows(shell, 'bom.txt').first().getByTestId('search-row-inserted')).toHaveText('bar');

  const overlay = await overlayPage(app);
  await shell.getByTestId('search-replace-all').click();
  const question = overlay.getByRole('alertdialog');
  await expect(question).toContainText('Replace 6 occurrences across 3 files with "bar"?');
  await question.getByRole('button', { name: 'Cancel' }).click();
  await expect(question).toHaveCount(0);
  expect(fs.readFileSync(bom, 'utf8')).toContain('foo one');
  await expect(shell.getByTestId('search-summary')).toHaveText('6 results in 3 files - Open in editor');

  await shell.getByTestId('search-replace-all').click();
  await question.getByRole('button', { name: 'Replace', exact: true }).click();
  await expect(resultFiles(shell)).toHaveCount(0);
  await expect.poll(() => fs.readFileSync(bom)).toEqual(Buffer.from('\uFEFFbar one\r\nbar two\r\n', 'utf8'));
  await expect.poll(() => fs.readFileSync(utf16)).toEqual(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('bar wide\r\n', 'utf16le')]));
  // The open file changed in its buffer only: dirty, the disk untouched, and one undo brings the buffer back.
  await expect(editorTab(shell, 'open.ts')).toHaveAttribute('data-dirty', 'true');
  await editorShows(shell, 'let bar = 1;');
  expect(fs.readFileSync(openFile, 'utf8')).toBe('let foo = 1;\nlet foo2 = foo;\n');
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press('ControlOrMeta+Z');
  await editorShows(shell, 'let foo2 = foo;');
  await expect(codeEditor(shell).locator('.view-line', { hasText: 'bar' })).toHaveCount(0);
});

test('a closed file changed after the search, even to the same size, and a Latin-1 file are skipped and reported, never rewritten', async ({ home, launch }) => {
  const changed = write(home.project, 'changed.txt', 'foo here\n');
  const latin1 = write(home.project, 'latin1.txt', Buffer.from('caf\xe9 foo\n', 'latin1'));
  const fine = write(home.project, 'fine.txt', 'foo fine\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await recordToasts(app);
  const shell = await openSearch(app, true);
  await search(shell, 'foo');
  await expect(resultFiles(shell)).toHaveCount(3);

  // Same size and the same modification time: only the recorded text tells the change apart.
  const { mtime, atime } = fs.statSync(changed);
  fs.writeFileSync(changed, 'fob here\n');
  fs.utimesSync(changed, atime, mtime);
  const latinBefore = fs.readFileSync(latin1);

  await shell.getByTestId('search-replace').fill('bar');
  await shell.getByTestId('search-replace-all').click();
  const overlay = await overlayPage(app);
  await overlay.getByRole('alertdialog').getByRole('button', { name: 'Replace', exact: true }).click();
  await expect.poll(() => fs.readFileSync(fine, 'utf8')).toBe('bar fine\n');
  expect(fs.readFileSync(changed, 'utf8')).toBe('fob here\n');
  expect(fs.readFileSync(latin1)).toEqual(latinBefore);
  await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message).join('\n')).toMatch(/changed\.txt[\s\S]*latin1\.txt|latin1\.txt[\s\S]*changed\.txt/);
  await expect(fileRow(shell, 'changed.txt')).toBeVisible();
  await expect(fileRow(shell, 'latin1.txt')).toBeVisible();
  await expect(fileRow(shell, 'fine.txt')).toHaveCount(0);
});

test('a regex with a lookbehind and $1 replaces in a closed file, and replace mode opens the read-only preview diff', async ({ foreground: _foreground, home, launch }) => {
  const file = write(home.project, 'vars.ts', 'let alpha = 1;\nconst beta = 2;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app, true);
  await toggle(shell, 'isRegex', true);
  await search(shell, '(?<=let )(\\w+)');
  await shell.getByTestId('search-replace').fill('my_$1');
  await expect(matchRows(shell, 'vars.ts').getByTestId('search-row-inserted')).toHaveText('my_alpha');

  await matchRows(shell, 'vars.ts').click();
  await expect(editorTab(shell, 'Replace Preview')).toHaveAttribute('aria-selected', 'true');
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await expect(diffEditor(shell).locator('.modified .view-line', { hasText: 'my_alpha' })).toBeVisible();
  const preview = (await editorState(app)).tabs.find((tab) => tab.title.includes('Replace Preview'));
  expect(preview).toMatchObject({ kind: 'diff', readOnly: true });

  await fileRow(shell, 'vars.ts').hover();
  await fileRow(shell, 'vars.ts').getByTestId('search-row-replace').click();
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('let my_alpha = 1;\nconst beta = 2;\n');
});

test('a result\'s context menu opens, mentions, copies its paths and dismisses it; Dismiss on hover moves nothing', async ({ clipboard, home, launch }) => {
  write(home.project, 'src/a.ts', 'needle one\nneedle two\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await search(shell, 'needle');
  const overlay = await overlayPage(app);

  await matchRows(shell, 'src/a.ts').first().click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect.poll(() => overlayMenu(overlay).locator('[data-menu-item]').evaluateAll((items) => items.map((entry) => entry.getAttribute('data-item-id')))).toEqual(['open', 'openToSide', 'mention', 'dismiss', 'copy', 'copyPath', 'copyRelativePath', 'copyAll', 'revealInFiles', 'reveal']);
  await menuItem(overlay, 'copyRelativePath').click();
  await expect.poll(() => clipboard.readText(app)).toBe(path.join('src', 'a.ts'));

  const row = matchRows(shell, 'src/a.ts').first();
  const before = await row.boundingBox();
  await row.hover();
  const dismiss = row.getByTestId('search-row-dismiss');
  await expect(dismiss).toBeVisible();
  expect(await row.boundingBox()).toEqual(before);
  await dismiss.click();
  await expect(matchRows(shell, 'src/a.ts')).toHaveCount(1);
  await expect(shell.getByTestId('search-summary')).toHaveText('1 result in 1 file - Open in editor');
});

test('Search works in an untrusted project, and the query and toggles come back after a relaunch without running', async ({ home, launch }) => {
  const untrusted = path.join(path.dirname(home.project), 'untrusted');
  write(untrusted, 'notes.txt', 'needle in an untrusted folder\n');
  const first = await launch();
  await openProjectChat(first.app, home.project);
  await addProject(first.app, untrusted, false);
  const shell = await openSearch(first.app);
  await toggle(shell, 'wholeWord', true);
  await search(shell, 'needle');
  await expect(fileRow(shell, 'notes.txt')).toBeVisible();
  // The view state reaches the window layout once typing settles.
  const layoutFile = path.join(home.userData, 'window-layout.json');
  await expect.poll(() => (fs.existsSync(layoutFile) ? JSON.stringify(JSON.parse(fs.readFileSync(layoutFile, 'utf8')).sidebar.search) : '')).toContain('"pattern":"needle"');
  await first.close();

  const second = await launch();
  const again = await shellPage(second.app);
  await expect(searchQuery(again)).toHaveValue('needle');
  await expect(again.getByTestId('search-option-wholeWord')).toHaveAttribute('aria-pressed', 'true');
  await expect(resultFiles(again)).toHaveCount(0);
});

test('the Replace row comes back after a relaunch with the text it held, and a closed row keeps none', async ({ home, launch }) => {
  write(home.project, 'a.ts', 'const foo = 1;\n');
  const first = await launch();
  await openProjectChat(first.app, home.project);
  const shell = await openSearch(first.app, true);
  await search(shell, 'foo');
  await shell.getByTestId('search-replace').fill('bar');
  const layoutFile = path.join(home.userData, 'window-layout.json');
  const savedSearch = (): string => (fs.existsSync(layoutFile) ? JSON.stringify(JSON.parse(fs.readFileSync(layoutFile, 'utf8')).sidebar.search) : '');
  await expect.poll(savedSearch).toContain('"replaceText":"bar"');
  await first.close();

  const second = await launch();
  const again = await shellPage(second.app);
  await expect(searchQuery(again)).toHaveValue('foo');
  await expect(again.getByTestId('search-replace')).toHaveValue('bar');
  await again.getByTestId('search-toggle-replace').click();
  await expect(again.getByTestId('search-replace')).toHaveCount(0);
  await expect.poll(savedSearch).toContain('"replaceText":""');
});

const HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };
const folderRow = (shell: Page, relativePath: string): Locator => shell.locator(`[data-testid="search-row"][data-row-kind="folder"][data-path="${relativePath}"]`);
const treePaths = (shell: Page): Promise<string[]> => shell.locator('[data-testid="search-row"]:not([data-row-kind="match"])').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path') ?? ''));
const menuIds = (overlay: Page): Promise<string[]> => overlayMenu(overlay).locator('[data-menu-item]').evaluateAll((items) => items.map((entry) => entry.getAttribute('data-item-id') ?? ''));

async function chooseFromMenu(app: ElectronApplication, row: Locator, itemId: string): Promise<void> {
  const overlay = await overlayPage(app);
  await row.click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, itemId).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

async function replaceAllConfirmed(app: ElectronApplication, shell: Page): Promise<void> {
  const overlay = await overlayPage(app);
  await shell.getByTestId('search-replace-all').click();
  await overlay.getByRole('alertdialog').getByRole('button', { name: 'Replace', exact: true }).click();
}

test('Preserve Case replaces each match in its own case, in a closed file and in an open buffer as one undo step', async ({ home, launch }) => {
  const closed = write(home.project, 'closed.ts', 'foo Foo FOO\n');
  const open = write(home.project, 'open.ts', 'Foo here\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const projectKey = await selectedProjectKey(app);
  const shell = await shellPage(app);
  await openInEditor(app, { projectKey, relativePath: 'open.ts' });
  await editorShows(shell, 'Foo here');

  await openSearch(app, true);
  await search(shell, 'foo');
  await shell.getByTestId('search-replace').fill('bar');
  await toggle(shell, 'preserveCase', true);
  await expect(matchRows(shell, 'closed.ts').nth(1).getByTestId('search-row-inserted')).toHaveText('Bar');
  await expect(matchRows(shell, 'closed.ts').nth(2).getByTestId('search-row-inserted')).toHaveText('BAR');
  await replaceAllConfirmed(app, shell);
  await expect.poll(() => fs.readFileSync(closed, 'utf8')).toBe('bar Bar BAR\n');
  await editorShows(shell, 'Bar here');
  expect(fs.readFileSync(open, 'utf8')).toBe('Foo here\n');
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(`${MOD}+Z`);
  await editorShows(shell, 'Foo here');
});

test('Search only in Open Editors searches the open buffers, dirty or clean, and untitled tabs; an untitled row offers no path action', async ({ home, launch }) => {
  write(home.project, 'open.ts', 'const a = 1;\n');
  write(home.project, 'closed.ts', 'needle on disk\n');
  const { app } = await launch(HOOKS);
  await openProjectChat(app, home.project);
  const projectKey = await selectedProjectKey(app);
  const shell = await shellPage(app);
  await openInEditor(app, { projectKey, relativePath: 'open.ts' });
  await editorShows(shell, 'const a = 1;');
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// needle in the buffer');
  await expect(editorTab(shell, 'open.ts')).toHaveAttribute('data-dirty', 'true');
  await app.evaluate(async () => {
    const hooks = (globalThis as unknown as { __damoclesE2e: { editor: { openUntitled(content: string, language: string): Promise<void> } } }).__damoclesE2e;
    await hooks.editor.openUntitled('needle in an untitled tab\n', 'plaintext');
  });
  await expect.poll(async () => (await editorState(app)).tabs.some((tab) => tab.kind === 'untitled')).toBe(true);

  await openSearch(app);
  await openDetails(shell);
  await toggle(shell, 'onlyOpenEditors', true);
  await search(shell, 'needle');
  await expect(resultFiles(shell)).toHaveCount(2);
  await expect(fileRow(shell, 'open.ts')).toBeVisible();
  await expect(fileRow(shell, 'closed.ts')).toHaveCount(0);
  await expect(shell.getByTestId('search-summary')).toContainText('2 results in 2 files - searching only in open files (disable) - Open in editor');
  expect(fs.readFileSync(path.join(home.project, 'open.ts'), 'utf8')).not.toContain('needle');

  const untitledRow = shell.locator('[data-testid="search-row"][data-row-kind="file"]:not([data-path="open.ts"])');
  await untitledRow.click({ button: 'right' });
  const overlay = await overlayPage(app);
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect.poll(() => menuIds(overlay)).toEqual(['open', 'openToSide', 'dismiss', 'copy', 'copyAll']);
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);

  await shell.getByTestId('search-disable-open-editors').click();
  await expect(shell.getByTestId('search-option-onlyOpenEditors')).toHaveAttribute('aria-pressed', 'false');
  await expect(fileRow(shell, 'closed.ts')).toBeVisible();
});

test('Enter adds a query to its history; Up and Down walk it inside the input without moving anything, and the layout keeps it', async ({ home, launch }) => {
  write(home.project, 'a.ts', 'alpha beta\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  // Chats and Files fold so Search has room: a section shorter than its widget scrolls it to keep the caret in view.
  for (const id of ['sidebar-chats', 'files-section']) {
    const header = shell.getByTestId(id).locator('button[aria-expanded]').first();
    await header.click();
    await expect(header).toHaveAttribute('aria-expanded', 'false');
  }
  await search(shell, 'alpha');
  await search(shell, 'beta');
  await expect(searchQuery(shell)).toHaveAttribute('placeholder', 'Search (⇅ for history)');
  // Positions within the Search section, which the sections above it may move as they load.
  const section = shell.getByTestId('search-section');
  const tree = shell.getByTestId('search-tree');
  const within = async (target: Locator): Promise<{ y: number; height: number }> => {
    const [box, top] = [await target.boundingBox(), await section.boundingBox()];
    return { y: box!.y - top!.y, height: box!.height };
  };
  // The sections' folding transition and the last search's layout finish first; only the history steps are measured.
  await settled(shell);
  const before = { query: await within(searchQuery(shell)), tree: await within(tree) };

  await searchQuery(shell).focus();
  await shell.keyboard.press('ArrowUp');
  await expect(searchQuery(shell)).toHaveValue('alpha');
  await shell.keyboard.press('ArrowUp');
  await expect(searchQuery(shell)).toHaveValue('alpha');
  await shell.keyboard.press('ArrowDown');
  await expect(searchQuery(shell)).toHaveValue('beta');
  await shell.keyboard.press('ArrowDown');
  await expect(searchQuery(shell)).toHaveValue('');
  await expect(shell.getByRole('status').filter({ hasText: 'Cleared Input' })).toHaveCount(1);
  await shell.keyboard.press('Alt+ArrowUp');
  await expect(searchQuery(shell)).toHaveValue('beta');
  expect(await within(searchQuery(shell))).toEqual(before.query);
  expect((await within(tree)).y).toBe(before.tree.y);

  const layoutFile = path.join(home.userData, 'window-layout.json');
  await expect.poll(() => (fs.existsSync(layoutFile) ? fs.readFileSync(layoutFile, 'utf8').replace(/\s/g, '') : '')).toContain('"query":["alpha","beta"]');
});

test('Ctrl+Enter adds a line to the query, which grows in place with its toggles pinned, and a multi-line regex matches across lines', async ({ home, launch }) => {
  write(home.project, 'two.ts', 'foo\nbar\n');
  write(home.project, 'one.ts', 'foo bar\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await toggle(shell, 'isRegex', true);
  const option = shell.getByTestId('search-option-matchCase');
  const toggleBefore = await option.boundingBox();
  const heightBefore = (await searchQuery(shell).boundingBox())!.height;
  await searchQuery(shell).focus();
  await shell.keyboard.type('foo');
  await shell.keyboard.press(`${MOD}+Enter`);
  await shell.keyboard.type('bar');
  await expect(searchQuery(shell)).toHaveValue('foo\nbar');
  expect((await searchQuery(shell).boundingBox())!.height).toBeGreaterThan(heightBefore);
  expect(await option.boundingBox()).toEqual(toggleBefore);
  await shell.keyboard.press('Enter');
  await expect(shell.getByTestId('search-progress')).toHaveCount(0);
  await expect(resultFiles(shell)).toHaveCount(1);
  await expect(fileRow(shell, 'two.ts')).toBeVisible();
});

test('View as Tree groups by folder in the sort order from settings; Collapse All folds files then folders, and Expand All restores them', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.desktop.search.sortOrder': 'countDescending' });
  write(home.project, 'src/app/one.ts', 'hit\n');
  write(home.project, 'src/two.ts', 'hit\nhit\nhit\n');
  write(home.project, 'z.ts', 'hit\nhit\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await search(shell, 'hit');
  await expect.poll(() => treePaths(shell)).toEqual(['src/two.ts', 'z.ts', 'src/app/one.ts']);

  const viewMode = shell.getByTestId('search-view-mode');
  await expect(viewMode).toHaveAttribute('aria-label', 'View as Tree');
  await viewMode.click();
  await expect(viewMode).toHaveAttribute('aria-label', 'View as List');
  await expect.poll(() => treePaths(shell)).toEqual(['src', 'src/app', 'src/app/one.ts', 'src/two.ts', 'z.ts']);
  await expect(folderRow(shell, 'src')).toHaveAttribute('aria-label', '4 matches in folder root src, Search result');
  await expect(fileRow(shell, 'src/two.ts')).toHaveAttribute('aria-label', '3 matches in file two.ts of folder src, Search result');
  await expect(fileRow(shell, 'src/two.ts')).toHaveAttribute('aria-level', '2');

  const collapse = shell.getByTestId('search-collapse-all');
  await collapse.click();
  await expect(shell.locator('[data-testid="search-row"][data-row-kind="match"]')).toHaveCount(0);
  await expect.poll(() => treePaths(shell)).toEqual(['src', 'src/app', 'src/app/one.ts', 'src/two.ts', 'z.ts']);
  await collapse.click();
  await expect.poll(() => treePaths(shell)).toEqual(['src', 'z.ts']);
  await expect(collapse).toHaveAttribute('aria-label', 'Expand All');
  await collapse.click();
  await expect(shell.locator('[data-testid="search-row"][data-row-kind="match"]')).toHaveCount(6);
  await expect(collapse).toHaveAttribute('aria-label', 'Collapse All');
});

test('Restrict Search to Folder, Exclude Folder, Exclude and Include File Type rewrite the globs and search again', async ({ home, launch }) => {
  write(home.project, 'src/a.ts', 'needle\n');
  write(home.project, 'src/b.test.ts', 'needle\n');
  write(home.project, 'lib/c.ts', 'needle\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await search(shell, 'needle');
  await shell.getByTestId('search-view-mode').click();
  await expect(resultFiles(shell)).toHaveCount(3);

  await chooseFromMenu(app, folderRow(shell, 'src'), 'restrict');
  await expect(shell.getByTestId('search-include')).toHaveValue('./src');
  await expect(resultFiles(shell)).toHaveCount(2);
  await chooseFromMenu(app, fileRow(shell, 'src/b.test.ts'), 'excludeType');
  await expect(shell.getByTestId('search-exclude')).toHaveValue('*.test.ts');
  await expect(resultFiles(shell)).toHaveCount(1);
  await chooseFromMenu(app, fileRow(shell, 'src/a.ts'), 'includeType');
  // Include globs are alternatives (VS Code's and ripgrep's), so *.ts brings lib/c.ts back while the exclude holds.
  await expect(shell.getByTestId('search-include')).toHaveValue('./src, *.ts');
  await expect(resultFiles(shell)).toHaveCount(2);
  await expect(fileRow(shell, 'lib/c.ts')).toBeVisible();

  await shell.getByTestId('search-include').fill('');
  await shell.getByTestId('search-exclude').fill('');
  await shell.getByTestId('search-exclude').press('Enter');
  await expect(resultFiles(shell)).toHaveCount(3);
  await chooseFromMenu(app, folderRow(shell, 'lib'), 'excludeFolder');
  await expect(shell.getByTestId('search-exclude')).toHaveValue('./lib');
  await expect(resultFiles(shell)).toHaveCount(2);
  await expect(fileRow(shell, 'lib/c.ts')).toHaveCount(0);
});

test('Replace All in a folder\'s menu replaces that folder\'s files only', async ({ home, launch }) => {
  const inside = write(home.project, 'src/a.ts', 'foo\n');
  const deeper = write(home.project, 'src/deep/b.ts', 'foo foo\n');
  const outside = write(home.project, 'lib/c.ts', 'foo\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app, true);
  await search(shell, 'foo');
  await shell.getByTestId('search-replace').fill('bar');
  await shell.getByTestId('search-view-mode').click();
  await chooseFromMenu(app, folderRow(shell, 'src'), 'replace');
  // Main writes the folder's files one at a time, src/deep/b.ts first, and drops their matches after the last write.
  await expect(resultFiles(shell)).toHaveCount(1);
  await expect(fileRow(shell, 'lib/c.ts')).toBeVisible();
  expect(fs.readFileSync(deeper, 'utf8')).toBe('bar bar\n');
  expect(fs.readFileSync(inside, 'utf8')).toBe('bar\n');
  expect(fs.readFileSync(outside, 'utf8')).toBe('foo\n');
});

test('Cancel Search stops a run and offers Search again; Escape in the query cancels without clearing it', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.desktop.search.searchOnTypeDebouncePeriod': 10_000 });
  write(home.project, 'a.ts', 'needle\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await searchQuery(shell).fill('needle');
  const cancel = shell.getByTestId('search-cancel');
  await expect(cancel).toBeVisible();
  await expect(shell.getByTestId('search-refresh')).toHaveCount(0);
  await cancel.click();
  await expect(shell.getByTestId('search-no-results')).toHaveText('Search was canceled before any results could be found - Search again');
  await expect(shell.getByTestId('search-refresh')).toBeVisible();
  await shell.getByTestId('search-message-link').click();
  await expect(fileRow(shell, 'a.ts')).toBeVisible();

  await searchQuery(shell).fill('needle2');
  await expect(cancel).toBeVisible();
  await searchQuery(shell).press('Escape');
  await expect(shell.getByTestId('search-no-results')).toContainText('Search was canceled');
  await expect(searchQuery(shell)).toHaveValue('needle2');
  await expect(searchQuery(shell)).toBeFocused();
});

test('F4 and Shift+F4 walk the matches and show each in the editor, without moving focus into it', async ({ home, launch }) => {
  write(home.project, 'a.ts', 'hit one\nhit two\n');
  write(home.project, 'b.ts', 'hit three\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openSearch(app);
  await search(shell, 'hit');
  await pressKeys(app, '/shell/', 'F4');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(matchRows(shell, 'a.ts').first()).toHaveAttribute('aria-selected', 'true');
  await pressKeys(app, '/shell/', 'F4');
  await pressKeys(app, '/shell/', 'F4');
  await expect(editorTab(shell, 'b.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(matchRows(shell, 'b.ts').first()).toHaveAttribute('aria-selected', 'true');
  await pressKeys(app, '/shell/', 'F4', ['shift']);
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(matchRows(shell, 'a.ts').nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(codeEditor(shell).locator('textarea')).not.toBeFocused();
});

test('Find in Folder... on a Files folder opens Search with that folder as files to include', async ({ home, launch }) => {
  write(home.project, 'src/a.ts', 'needle\n');
  write(home.project, 'other.ts', 'needle\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect(filesRow(shell, 'src')).toBeVisible();
  const overlay = await overlayPage(app);
  await filesRow(shell, 'src').click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(menuItem(overlay, 'findInFolder')).toContainText('Find in Folder...');
  await menuItem(overlay, 'findInFolder').click();
  await expect(shell.getByTestId('search-include')).toHaveValue('./src');
  await expect(searchQuery(shell)).toBeFocused();
  await search(shell, 'needle');
  await expect(resultFiles(shell)).toHaveCount(1);
  await expect(fileRow(shell, 'src/a.ts')).toBeVisible();

  // Shift+Alt+F on a focused folder row does the same.
  await shell.getByTestId('search-include').fill('');
  await filesRow(shell, 'src').focus();
  await shell.keyboard.press('Shift+Alt+F');
  await expect(shell.getByTestId('search-include')).toHaveValue('./src');
});
