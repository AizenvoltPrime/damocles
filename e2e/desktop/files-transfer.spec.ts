import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, recordedToasts, recordToasts, shellPage, pressKeys, PRIMARY } from './support/shell';
import { menuItem, overlayMenu } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { activeTab, codeEditor, editorShows, editorTab, filesRow, saveWithKeyboard } from './support/editor';
import { expectNoAxeViolations } from './support/axe';
import { answerMessage, dragRow, dropOnRow, endedTransfers, messageDialog, partsUnder, pasteOnRow, recordTransfers, tree } from './support/file-drops';
import { answerOpenDialog } from './support/ui';
import { readUserSettings } from './support/hermetic';

const posix = process.platform !== 'win32';

// resolves once main reports this many transfers ended, each with state done unless said
async function transfersEnd(app: ElectronApplication, states: ReadonlyArray<'done' | 'failed' | 'cancelled'>): Promise<void> {
  await expect.poll(() => endedTransfers(app), { timeout: 60_000 }).toEqual(states);
}
const done = (count: number): Array<'done'> => Array.from({ length: count }, () => 'done' as const);

test('a dropped folder arrives with its tree, its script and its link, and the originals stay as they were', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const outside = path.join(home.root, 'outside');
  const source = path.join(outside, 'assets');
  fs.mkdirSync(path.join(source, 'img', 'icons'), { recursive: true });
  fs.writeFileSync(path.join(source, 'img', 'icons', 'logo.svg'), '<svg/>');
  fs.writeFileSync(path.join(source, 'img', 'photo.png'), Buffer.alloc(4096, 7));
  fs.writeFileSync(path.join(source, 'build.sh'), '#!/bin/sh\necho built\n', { mode: 0o755 });
  fs.symlinkSync(path.join('img', 'photo.png'), path.join(source, 'latest.png'), 'file');
  const before = tree(source);
  const { app } = await launch();
  await recordToasts(app);
  await recordTransfers(app);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect(filesRow(shell, 'src')).toBeVisible();

  expect(await dropOnRow(shell, 'src', [source])).toBe(true);
  const landed = path.join(home.project, 'src', 'assets');
  await transfersEnd(app, done(1));
  expect(fs.readFileSync(path.join(landed, 'img', 'photo.png'))).toEqual(Buffer.alloc(4096, 7));
  if (posix) {
    // a POSIX client keeps the script executable and the link a link
    expect(tree(landed)).toEqual(before);
    expect(fs.statSync(path.join(landed, 'build.sh')).mode & 0o777).toBe(0o755);
  } else {
    // a Windows host makes no link: it is skipped and listed, and NTFS has no executable bit
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message)).toContain('Copied 3 of 4 items to src. 1 skipped');
    expect(tree(landed)).toEqual(before.filter((entry) => !entry.startsWith('latest.png')));
  }
  expect(tree(source)).toEqual(before);
  expect(partsUnder(home.project)).toEqual([]);
  await expect(filesRow(shell, 'src/assets')).toBeVisible();
});

test('a clash offers Replace, Keep both and Skip, Apply to all answers the rest, and a folder clash merges', async ({ home, launch }) => {
  const src = path.join(home.project, 'src');
  fs.mkdirSync(path.join(src, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(src, 'app.ts'), 'old app');
  fs.writeFileSync(path.join(src, 'b.ts'), 'old b');
  fs.writeFileSync(path.join(src, 'c.ts'), 'old c');
  fs.writeFileSync(path.join(src, 'lib', 'kept.ts'), 'kept');
  fs.writeFileSync(path.join(src, 'lib', 'util.ts'), 'old util');
  const incoming = path.join(home.root, 'incoming');
  fs.mkdirSync(path.join(incoming, 'lib'), { recursive: true });
  for (const name of ['app.ts', 'b.ts', 'c.ts']) fs.writeFileSync(path.join(incoming, name), `new ${name}`);
  fs.writeFileSync(path.join(incoming, 'lib', 'util.ts'), 'new util');
  fs.writeFileSync(path.join(incoming, 'lib', 'fresh.ts'), 'fresh');
  const { app } = await launch();
  await recordTransfers(app);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect(filesRow(shell, 'src')).toBeVisible();
  const at = (name: string): string => path.join(incoming, name);

  // Replace, then Keep both twice, then Skip
  expect(await dropOnRow(shell, 'src', [at('app.ts')])).toBe(true);
  const overlay = await overlayPage(app);
  await expect(messageDialog(overlay, '\'app.ts\' already exists in \'src\'')).toBeVisible();
  await expectNoAxeViolations(overlay, '[role="alertdialog"]');
  await answerMessage(app, '\'app.ts\' already exists in \'src\'', 'Replace');
  await transfersEnd(app, done(1));
  expect(fs.readFileSync(path.join(src, 'app.ts'), 'utf8')).toBe('new app.ts');
  for (const [index, expected] of ['app copy.ts', 'app copy 2.ts'].entries()) {
    await dropOnRow(shell, 'src', [at('app.ts')]);
    await answerMessage(app, '\'app.ts\' already exists', 'Keep both');
    await transfersEnd(app, done(2 + index));
    expect(fs.readFileSync(path.join(src, expected), 'utf8')).toBe('new app.ts');
  }
  await dropOnRow(shell, 'src', [at('b.ts')]);
  await answerMessage(app, '\'b.ts\' already exists', 'Skip');
  await transfersEnd(app, done(4));
  expect(fs.readFileSync(path.join(src, 'b.ts'), 'utf8')).toBe('old b');
  // Apply to all: one question answers both remaining clashes
  await dropOnRow(shell, 'src', [at('b.ts'), at('c.ts')]);
  await answerMessage(app, '\'b.ts\' already exists', 'Replace', true);
  await transfersEnd(app, done(5));
  expect([fs.readFileSync(path.join(src, 'b.ts'), 'utf8'), fs.readFileSync(path.join(src, 'c.ts'), 'utf8')]).toEqual(['new b.ts', 'new c.ts']);
  await expect(messageDialog(overlay, 'c.ts')).toHaveCount(0);
  // the folder merges and asks only about its file
  await dropOnRow(shell, 'src', [at('lib')]);
  await answerMessage(app, '\'util.ts\' already exists in \'lib\'', 'Skip');
  await transfersEnd(app, done(6));
  expect(fs.readFileSync(path.join(src, 'lib', 'fresh.ts'), 'utf8')).toBe('fresh');
  expect(fs.readFileSync(path.join(src, 'lib', 'util.ts'), 'utf8')).toBe('old util');
  expect(fs.readFileSync(path.join(src, 'lib', 'kept.ts'), 'utf8')).toBe('kept');
  expect(fs.readdirSync(path.join(src, 'lib')).sort()).toEqual(['fresh.ts', 'kept.ts', 'util.ts']);
});

test('files pasted from the OS file manager arrive after the confirm, and Don\'t ask again stops it', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const copied = path.join(home.root, 'copied');
  fs.mkdirSync(copied);
  fs.writeFileSync(path.join(copied, 'one.txt'), 'one');
  fs.writeFileSync(path.join(copied, 'two.txt'), 'two');
  const { app } = await launch();
  await recordTransfers(app);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect(filesRow(shell, 'src')).toBeVisible();

  await pasteOnRow(shell, 'src', [path.join(copied, 'one.txt'), path.join(copied, 'two.txt')]);
  await answerMessage(app, 'Paste 2 items into \'src\'?', 'Cancel');
  expect(fs.readdirSync(path.join(home.project, 'src'))).toEqual([]);
  await pasteOnRow(shell, 'src', [path.join(copied, 'one.txt'), path.join(copied, 'two.txt')]);
  await answerMessage(app, 'Paste 2 items into \'src\'?', 'Paste', true);
  await transfersEnd(app, done(1));
  expect(fs.readdirSync(path.join(home.project, 'src')).sort()).toEqual(['one.txt', 'two.txt']);
  // no question now: the paste goes straight in
  fs.writeFileSync(path.join(copied, 'three.txt'), 'three');
  await pasteOnRow(shell, 'src', [path.join(copied, 'three.txt')]);
  await transfersEnd(app, done(2));
  expect(fs.readFileSync(path.join(home.project, 'src', 'three.txt'), 'utf8')).toBe('three');
  const overlay = await overlayPage(app);
  await expect(overlay.locator('[role="alertdialog"]')).toHaveCount(0);
  expect(readUserSettings(home)['damocles.desktop.files.confirmPasteNative']).toBe(false);
});

test('an open unsaved file dragged onto a folder moves after the confirm, keeps its tab and text, and saves to the new path; Cut and Paste does the same', async ({ clipboard: _clipboard, home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.mkdirSync(path.join(home.project, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'app.ts'), 'export const app = 1;\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await filesRow(shell, 'src').click();
  await filesRow(shell, 'src/app.ts').click();
  await editorShows(shell, 'export const app = 1;');
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.press(process.platform === 'darwin' ? 'Meta+End' : 'Control+End');
  await shell.keyboard.type('// unsaved\n');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);

  await dragRow(shell, 'src/app.ts', 'lib', false);
  await answerMessage(app, 'Move \'app.ts\' into \'lib\'?', 'Move');
  await expect.poll(() => fs.existsSync(path.join(home.project, 'lib', 'app.ts'))).toBe(true);
  expect(fs.existsSync(path.join(home.project, 'src', 'app.ts'))).toBe(false);
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('lib/app.ts');
  expect((await activeTab(app))?.dirty).toBe(true);
  await editorShows(shell, '// unsaved');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(path.join(home.project, 'lib', 'app.ts'), 'utf8')).toContain('// unsaved');
  expect(fs.existsSync(path.join(home.project, 'src', 'app.ts'))).toBe(false);

  // Cut and Paste with the keyboard, through the Edit menu's accelerators as a user presses them
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.type('// again\n');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
  await filesRow(shell, 'lib/app.ts').focus();
  await pressKeys(app, '/shell/', 'X', [PRIMARY]);
  await expect(filesRow(shell, 'lib/app.ts')).toHaveAttribute('data-cut', /.*/);
  await filesRow(shell, 'src').focus();
  await pressKeys(app, '/shell/', 'V', [PRIMARY]);
  await expect.poll(() => fs.existsSync(path.join(home.project, 'src', 'app.ts'))).toBe(true);
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('src/app.ts');
  expect((await activeTab(app))?.dirty).toBe(true);
  await expect(editorTab(shell, 'app.ts')).toHaveCount(1);
  // Ctrl+S saves the editor that has focus, and the paste left it in Files
  await codeEditor(shell).locator('.view-lines').click();
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(path.join(home.project, 'src', 'app.ts'), 'utf8')).toContain('// again');
});

test('Copy files here... copies the picked files, the progress row and the menu pass axe and work from the keyboard, Cancel leaves no part, and a local project offers no Download', async ({ clipboard: _clipboard, home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const picked = path.join(home.root, 'picked');
  fs.mkdirSync(picked);
  fs.writeFileSync(path.join(picked, 'notes.md'), '# notes');
  // many small files keep a transfer running long enough to see, scan and cancel: each lands through its own part and sync
  const many = path.join(home.root, 'many');
  fs.mkdirSync(many);
  for (let index = 0; index < 3000; index++) fs.writeFileSync(path.join(many, `f${String(index).padStart(4, '0')}.txt`), 'x'.repeat(512));
  const { app } = await launch();
  await recordTransfers(app);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect(filesRow(shell, 'src')).toBeVisible();

  // the menu, from the keyboard
  await filesRow(shell, 'src').focus();
  await shell.keyboard.press('Shift+F10');
  const overlay = await overlayPage(app);
  await expect(overlayMenu(overlay)).toBeVisible();
  await expectNoAxeViolations(overlay, '[data-testid="overlay-menu"]');
  await expect(menuItem(overlay, 'download')).toHaveCount(0);
  await answerOpenDialog(app, path.join(picked, 'notes.md'));
  await menuItem(overlay, 'copyHere').focus();
  await overlay.keyboard.press('Enter');
  await transfersEnd(app, done(1));
  expect(fs.readFileSync(path.join(home.project, 'src', 'notes.md'), 'utf8')).toBe('# notes');

  expect(await dropOnRow(shell, 'src', [many])).toBe(true);
  const row = shell.getByTestId('files-transfer');
  await expect(row).toHaveAttribute('data-phase', 'running');
  await expect(shell.getByTestId('files-transfer-bar')).toHaveAttribute('role', 'progressbar');
  await expectNoAxeViolations(shell, '[data-testid="files-transfer"]');
  await shell.getByTestId('files-transfer-cancel').focus();
  await shell.keyboard.press('Enter');
  await expect(row).toHaveCount(0);
  await transfersEnd(app, ['done', 'cancelled']);
  // the row gives focus back to the tree as it leaves
  await expect(shell.getByTestId('files-tree').locator(':focus')).toHaveCount(1);
  // the row leaves at once; the file under way then removes its part and its claim
  await expect.poll(() => partsUnder(path.join(home.project, 'src'))).toEqual([]);
  const landed = fs.readdirSync(path.join(home.project, 'src', 'many'));
  expect(landed.length).toBeLessThan(3000);
  await expect.poll(() => landed.filter((name) => fs.existsSync(path.join(home.project, 'src', 'many', name)) && fs.readFileSync(path.join(home.project, 'src', 'many', name), 'utf8') !== 'x'.repeat(512))).toEqual([]);
});
