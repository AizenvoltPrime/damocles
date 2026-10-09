import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { chooseMenuItem, menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { overlayPage, pressKeys, selectedProjectKey, SHELL_URL, shellPage, viewFocused } from './support/shell';
import { openProjectChat } from './support/screenshots';
import { chatInput } from './support/ui';
import {
  activeTab,
  activeTabTopRow,
  bufferText,
  codeEditor,
  conflictBar,
  diffEditor,
  DOCUMENT_END,
  DOCUMENT_START,
  editorPane,
  editorShows,
  editorState,
  editorTab,
  filesRow,
  lineEndings,
  openInEditor,
  quickOpen,
  saveWithKeyboard,
} from './support/editor';

const permissionPrompt = (tab: Page) => tab.getByRole('region', { name: 'Permission request' });

async function approve(tab: Page): Promise<void> {
  await expect(permissionPrompt(tab)).toBeVisible();
  await permissionPrompt(tab).getByRole('option', { name: 'Yes', exact: true }).click();
  await expect(permissionPrompt(tab)).toBeHidden();
}

async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

async function withStub(home: HermeticHome, run: (stub: OpenAIStub) => Promise<void>): Promise<void> {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    await run(stub);
  } finally {
    await stub.close();
  }
}

test('Ctrl+P opens src/a.ts, an edit and Ctrl+S save it, and the file keeps its CRLF line endings and its BOM', async ({ foreground: _foreground, home, launch }) => {
  const file = path.join(home.project, 'src', 'a.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from('\uFEFFexport const a = 1;\r\nexport const b = 2;\r\n', 'utf8'));
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);

  const overlay = await quickOpen(app, 'a.ts');
  await expect(overlay.locator('[data-testid="quick-pick-item"]', { hasText: 'a.ts' }).first()).toBeVisible();
  await overlay.getByTestId('quick-pick-input').press('Enter');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('aria-selected', 'true');
  await editorShows(shell, 'export const a = 1;');
  // Quick Open is a user action, so the editor takes keyboard focus and the keystrokes land in it.
  await expect.poll(() => viewFocused(app, shell)).toBe(true);
  await expect(codeEditor(shell).locator('.monaco-editor')).toHaveClass(/focused/);

  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// edited');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('data-dirty', 'true');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain('// edited');
  await expect(editorTab(shell, 'a.ts')).not.toHaveAttribute('data-dirty', 'true');
  const bytes = fs.readFileSync(file);
  expect(lineEndings(bytes)).toEqual({ bom: true, crlf: 2, loneLf: 0 });
  expect(bytes.toString('utf8')).toBe('\uFEFFexport const a = 1;\r\nexport const b = 2;\r\n// edited');
});

test('text typed while Ctrl+S is being written keeps the tab dirty, and the next Ctrl+S writes it', async ({ foreground: _foreground, home, launch }) => {
  const file = path.join(home.project, 'src', 'held.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const a = 1;\r\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  // Main's in-place write of held.ts waits at its open until the test releases it, and reports when its handle closed.
  await app.evaluate((_electron, target) => {
    const fs = process.getBuiltinModule('node:fs').promises;
    const path = process.getBuiltinModule('node:path');
    const open = fs.open.bind(fs);
    const hold = globalThis as { __e2eHeld?: boolean; __e2eRelease?: () => void; __e2eClosed?: boolean };
    fs.open = async (opened, flags, mode) => {
      if (flags !== 'r+' || path.basename(String(opened)) !== target || hold.__e2eHeld) return open(opened, flags, mode);
      hold.__e2eHeld = true;
      await new Promise<void>((resolve) => { hold.__e2eRelease = resolve; });
      const handle = await open(opened, flags, mode);
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        hold.__e2eClosed = true;
      };
      return handle;
    };
  }, 'held.ts');

  const overlay = await quickOpen(app, 'held.ts');
  await expect(overlay.locator('[data-testid="quick-pick-item"]', { hasText: 'held.ts' }).first()).toBeVisible();
  await overlay.getByTestId('quick-pick-input').press('Enter');
  await editorShows(shell, 'export const a = 1;');
  await expect.poll(() => viewFocused(app, shell)).toBe(true);
  const documentId = (await activeTab(app))!.documentId!;
  const mainText = (): Promise<string> => shell.evaluate(async (id) => {
    const content = await window.damoclesShell!.getDocument(id);
    return content.kind === 'text' ? content.text : '';
  }, documentId);

  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// one');
  await saveWithKeyboard(app);
  await expect.poll(() => app.evaluate(() => (globalThis as { __e2eHeld?: boolean }).__e2eHeld === true)).toBe(true);
  await shell.keyboard.type(' two');
  await expect.poll(mainText).toContain('// one two');
  await app.evaluate(() => (globalThis as { __e2eRelease?: () => void }).__e2eRelease!());
  await expect.poll(() => app.evaluate(() => (globalThis as { __e2eClosed?: boolean }).__e2eClosed === true)).toBe(true);

  expect(fs.readFileSync(file, 'utf8')).toBe('export const a = 1;\r\n// one');
  expect((await activeTab(app))?.dirty).toBe(true);
  await expect(editorTab(shell, 'held.ts')).toHaveAttribute('data-dirty', 'true');
  await saveWithKeyboard(app);
  await expect.poll(() => fs.readFileSync(file, 'utf8')).toBe('export const a = 1;\r\n// one two');
  await expect(editorTab(shell, 'held.ts')).not.toHaveAttribute('data-dirty', 'true');
});

test('an agent edit reloads a clean buffer in place; over a dirty buffer it shows the conflict bar, Compare opens a diff tab, and Revert there closes it', async ({ home, launch }) => {
  await withStub(home, async (stub) => {
    const file = path.join(home.project, 'notes.ts');
    fs.writeFileSync(file, "export const v = 'one';\n");
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    const projectKey = await selectedProjectKey(app);
    expect(await openInEditor(app, { projectKey, relativePath: 'notes.ts' })).toMatchObject({ ok: true });
    await editorShows(shell, "'one'");

    // A clean buffer follows the agent's write: the watcher reloads it, with no conflict.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: "'one'", new_string: "'two'" } }] });
    await send(tab, 'edit the notes');
    await approve(tab);
    await editorShows(shell, "'two'");
    await expect(conflictBar(shell)).toBeHidden();
    expect((await activeTab(app))?.dirty).toBe(false);

    // A dirty buffer keeps the user's text and shows the conflict bar instead.
    await codeEditor(shell).locator('.view-lines').click();
    await shell.keyboard.press(DOCUMENT_END);
    await shell.keyboard.type('// mine');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: "'two'", new_string: "'three'" } }] });
    await send(tab, 'edit them again');
    await approve(tab);
    await expect(conflictBar(shell)).toBeVisible();
    await editorShows(shell, '// mine');
    expect(fs.readFileSync(file, 'utf8')).toContain("'three'");
    await expect(conflictBar(shell)).toContainText('notes.ts changed on disk.');

    await conflictBar(shell).getByTestId('conflict-compare').click();
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(diffEditor(shell).locator('.editor.original .view-line', { hasText: "'three'" })).toBeVisible();
    await expect(diffEditor(shell).locator('.editor.modified .view-line', { hasText: '// mine' })).toBeVisible();
    // The diff's context menu is the overlay's too, without Format Document, which acts on a text tab.
    await diffEditor(shell).locator('.editor.modified .view-line', { hasText: '// mine' }).click({ button: 'right' });
    const overlay = await readyOverlay(app);
    await expect(overlayMenu(overlay)).toBeVisible();
    expect(await menuItemIds(overlay)).toEqual(expect.arrayContaining(['editor.action.revealDefinition', 'copy', 'commandPalette']));
    expect(await menuItemIds(overlay)).not.toContain('formatDocument');
    await expect(shell.locator('.context-view .monaco-menu')).toHaveCount(0);
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toBeHidden();

    // The Compare tab's bar names the file and offers only Revert and Overwrite; resolving closes the Compare tab and shows
    // the file's own tab (textFileSaveErrorHandler.ts).
    await expect(conflictBar(shell)).toContainText('notes.ts changed on disk.');
    await expect(conflictBar(shell).getByTestId('conflict-compare')).toHaveCount(0);
    await conflictBar(shell).getByTestId('conflict-revert').click();
    await expect.poll(async () => (await editorState(app)).tabs.map((editor) => editor.kind)).toEqual(['code']);
    await expect.poll(async () => (await activeTab(app))?.title).toBe('notes.ts');
    await expect(conflictBar(shell)).toBeHidden();
    await editorShows(shell, "'three'");
    expect((await activeTab(app))?.dirty).toBe(false);
  });
});

test('a tool card click opens its file in the pane and focuses it; an approval diff opens only in the chat overlay from Open diff', async ({ foreground: _foreground, home, launch }) => {
  await withStub(home, async (stub) => {
    const file = path.join(home.project, 'card.ts');
    fs.writeFileSync(file, "export const card = 'old';\n");
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    const tabsBefore = (await editorState(app)).tabs.length;

    stub.replies.push({ chunks: [], toolCalls: [{ name: 'Edit', arguments: { file_path: file, old_string: "'old'", new_string: "'new'" } }] });
    await send(tab, 'edit the card');
    await expect(permissionPrompt(tab)).toBeVisible();
    // The proposal waits for its card: no chat overlay, no pane tab, and the composer keeps focus.
    await expect(tab.getByTestId('editor-overlay')).toBeHidden();
    expect((await editorState(app)).tabs.length).toBe(tabsBefore);
    await expect(tab.getByRole('textbox', { name: 'Message Damocles' })).toBeFocused();
    await permissionPrompt(tab).getByRole('button', { name: 'Open diff' }).click();
    await expect(tab.getByTestId('editor-overlay')).toHaveAttribute('data-purpose', 'proposal');
    await expect(tab.getByTestId('editor-diff-view')).toHaveAttribute('data-monaco-ready', 'true');
    expect((await editorState(app)).tabs.length).toBe(tabsBefore);
    await tab.getByTestId('editor-overlay-close').click();
    await approve(tab);
    await expect.poll(() => fs.readFileSync(file, 'utf8')).toContain("'new'");

    await tab.getByTitle(file, { exact: true }).first().click();
    await expect(editorTab(shell, 'card.ts')).toHaveAttribute('aria-selected', 'true');
    await editorShows(shell, "'new'");
    await expect.poll(() => viewFocused(app, shell)).toBe(true);
    await expect(codeEditor(shell).locator('.monaco-editor')).toHaveClass(/focused/);
  });
});

test('the shell channel refuses a path outside every project', async ({ home, launch }) => {
  const outside = path.join(home.root, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const projectKey = await selectedProjectKey(app);
  const before = (await editorState(app)).tabs.length;
  for (const relativePath of ['../../secret.txt', '../secret.txt', outside.replace(/\\/g, '/'), 'C:/Windows/win.ini']) {
    expect(await openInEditor(app, { projectKey, relativePath })).toEqual({ ok: false, reason: 'outside' });
  }
  expect((await editorState(app)).tabs.length).toBe(before);
});

test('a PNG opens as an image preview and a binary file as "not displayed" with Reveal in File Explorer', async ({ home, launch }) => {
  // A 1x1 transparent PNG.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  fs.writeFileSync(path.join(home.project, 'pixel.png'), png);
  fs.writeFileSync(path.join(home.project, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 7, 0]));
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);

  expect(await openInEditor(app, { projectKey, relativePath: 'pixel.png' })).toMatchObject({ ok: true });
  const image = shell.getByTestId('image-preview').locator('img');
  await expect(image).toBeVisible();
  expect(await image.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  expect(await image.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBe(1);

  expect(await openInEditor(app, { projectKey, relativePath: 'blob.bin' })).toMatchObject({ ok: true });
  const notDisplayed = shell.getByTestId('editor-not-displayed');
  await expect(notDisplayed).toContainText('This file is not displayed');
  await expect(notDisplayed).toContainText('It is a binary file.');
  await expect(notDisplayed.getByTestId('editor-reveal')).toBeVisible();
  await expect(editorPane(shell).getByTestId('code-editor')).toHaveCount(0);
});

test('a code tab keeps its caret and scroll position while an image tab shows in its place', async ({ foreground: _foreground, home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'long.ts'), Array.from({ length: 900 }, (_, i) => `export const line${i + 1} = ${i + 1};\n`).join(''));
  fs.writeFileSync(path.join(home.project, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);
  // The caret's line number, and the first line number in view, which says where the editor is scrolled to.
  const position = (): Promise<{ caret: string; top: string }> => codeEditor(shell).evaluate((editor) => {
    const numbers = [...editor.querySelectorAll<HTMLElement>('.line-numbers')].sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
    const box = editor.getBoundingClientRect();
    return {
      caret: editor.querySelector('.line-numbers.active-line-number')?.textContent ?? '',
      top: numbers.find((number) => number.getBoundingClientRect().top >= box.top)?.textContent ?? '',
    };
  });

  expect(await openInEditor(app, { projectKey, relativePath: 'long.ts', line: 500 })).toMatchObject({ ok: true });
  await editorShows(shell, 'export const line500 = 500;');
  await expect.poll(async () => (await position()).caret).toBe('500');
  const before = await position();
  expect(Number(before.top)).toBeGreaterThan(400);

  expect(await openInEditor(app, { projectKey, relativePath: 'pixel.png' })).toMatchObject({ ok: true });
  await expect(shell.getByTestId('image-preview').locator('img')).toBeVisible();
  await expect(codeEditor(shell)).toHaveCount(0);

  await editorTab(shell, 'long.ts').click();
  await editorShows(shell, 'export const line500 = 500;');
  await expect.poll(position).toEqual(before);
});

test('the markdown preview renders the source tab\'s unsaved text, and follows the buffer while it shows', async ({ foreground: _foreground, home, launch }) => {
  const notes = path.join(home.project, 'NOTES.md');
  fs.writeFileSync(notes, '# Notes\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);
  const preview = shell.getByTestId('markdown-preview');
  const sourceTab = shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'NOTES.md' });

  expect(await openInEditor(app, { projectKey, relativePath: 'NOTES.md', as: 'source' })).toMatchObject({ ok: true });
  await editorShows(shell, '# Notes');
  await expect(codeEditor(shell).locator('.monaco-editor')).toHaveClass(/focused/);
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('## Typed');
  await expect(sourceTab).toHaveAttribute('data-dirty', 'true');

  expect(await openInEditor(app, { projectKey, relativePath: 'NOTES.md', as: 'preview' })).toMatchObject({ ok: true });
  await expect(preview.locator('h2')).toHaveText('Typed');

  // Saved, the buffer reloads in place when the file changes on disk, and the preview showing it follows.
  await sourceTab.click();
  await saveWithKeyboard(app);
  await expect(sourceTab).not.toHaveAttribute('data-dirty', 'true');
  expect(await openInEditor(app, { projectKey, relativePath: 'NOTES.md', as: 'preview' })).toMatchObject({ ok: true });
  await expect(preview.locator('h2')).toHaveText('Typed');
  fs.writeFileSync(notes, '# Notes\n\n## From disk\n');
  await expect(preview.locator('h2')).toHaveText('From disk');
});

test('a dirty buffer survives quit and relaunch with "Reopen where I left off" on; with it off, quit asks to save', async ({ home, launch }) => {
  const file = path.join(home.project, 'draft.ts');
  fs.writeFileSync(file, 'export const draft = 1;\n');
  {
    const { app, close } = await launch();
    await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    const projectKey = await selectedProjectKey(app);
    expect(await openInEditor(app, { projectKey, relativePath: 'draft.ts' })).toMatchObject({ ok: true });
    await editorShows(shell, 'draft = 1');
    await shell.keyboard.press(DOCUMENT_END);
    await shell.keyboard.type('// unsaved');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    await close();
  }
  expect(fs.readFileSync(file, 'utf8')).not.toContain('// unsaved');
  {
    const { app, close } = await launch();
    const shell = await shellPage(app);
    await expect(editorTab(shell, 'draft.ts')).toHaveAttribute('data-dirty', 'true');
    await editorTab(shell, 'draft.ts').click();
    await editorShows(shell, '// unsaved');
    await close();
  }

  writeUserSettings(home, { 'damocles.desktop.restoreLayout': false });
  const { app, close } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);
  expect(await openInEditor(app, { projectKey, relativePath: 'draft.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'draft = 1');
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// ask');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
  const overlay = await overlayPage(app);
  const quitting = close();
  const dialog = overlay.getByRole('alertdialog');
  await expect(dialog).toContainText('draft.ts');
  // Only Save and Don't Save: Escape and the scrim cancel.
  expect((await dialog.getByRole('button').allTextContents()).map((label) => label.trim())).toEqual(['Save', "Don't Save"]);
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await quitting;
  expect(fs.readFileSync(file, 'utf8')).toContain('// ask');
});

test('the unsaved text of a file deleted on disk comes back after a relaunch in a dirty Deleted tab, and Save recreates the file', async ({ foreground: _foreground, home, launch }) => {
  const file = path.join(home.project, 'src', 'gone.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'export const gone = 1;\n');
  {
    const { app, close } = await launch();
    await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    const projectKey = await selectedProjectKey(app);
    expect(await openInEditor(app, { projectKey, relativePath: 'src/gone.ts' })).toMatchObject({ ok: true });
    await editorShows(shell, 'gone = 1');
    await shell.keyboard.press(DOCUMENT_END);
    await shell.keyboard.type('// unsaved');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    // The folder goes too, so the save has to recreate it.
    fs.rmSync(path.dirname(file), { recursive: true });
    await expect(editorTab(shell, 'gone.ts')).toHaveAttribute('data-deleted', 'true');
    await close();
  }
  expect(fs.existsSync(file)).toBe(false);
  const { app, close } = await launch();
  const shell = await shellPage(app);
  const tab = editorTab(shell, 'gone.ts');
  await expect(tab).toHaveAttribute('data-deleted', 'true');
  await expect(tab).toHaveAttribute('data-dirty', 'true');
  await tab.click();
  await editorShows(shell, '// unsaved');
  await codeEditor(shell).locator('.view-lines').click();
  await saveWithKeyboard(app);
  await expect.poll(() => fs.existsSync(file) && fs.readFileSync(file, 'utf8')).toContain('// unsaved');
  await expect(tab).not.toHaveAttribute('data-deleted');
  await expect(tab).not.toHaveAttribute('data-dirty', 'true');
  await close();
});

const HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };

test('an agent openFile and a showDiff without approvalId open pane tabs without taking focus: text typed in the composer stays there', async ({ foreground: _foreground, home, launch }) => {
  const file = path.join(home.project, 'agent.ts');
  fs.writeFileSync(file, "export const agent = 'disk';\n");
  const { app } = await launch(HOOKS);
  const tab = await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const composer = tab.getByRole('textbox', { name: 'Message Damocles' });
  await composer.click();
  await tab.keyboard.type('typing while ');

  await app.evaluate(async (_electron, target) => {
    const hooks = (globalThis as unknown as { __damoclesE2e: { editor: { openFile(path: string, options: object): Promise<void> } } }).__damoclesE2e;
    await hooks.editor.openFile(target, { preserveFocus: true, line: 1 });
  }, file);
  await expect(editorTab(shell, 'agent.ts')).toHaveAttribute('aria-selected', 'true');
  await editorShows(shell, "'disk'");
  await tab.keyboard.type('the agent opens ');

  await app.evaluate(async (_electron, target) => {
    const hooks = (globalThis as unknown as { __damoclesE2e: { editor: { showDiff(request: object): Promise<unknown> } } }).__damoclesE2e;
    await hooks.editor.showDiff({ title: (name: string) => `${name} (changes)`, filePath: target, left: { name: 'agent.ts', content: "export const agent = 'before';\n" }, right: { path: target }, purpose: 'checkpoint', preserveFocus: true });
  }, file);
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await tab.keyboard.type('files');

  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('typing while the agent opens files');
  expect(await viewFocused(app, shell)).toBe(false);
});

test('a diff tab of the agent\'s takes its file\'s new name and path after a Files rename, and its snapshot side keeps its text', async ({ home, launch }) => {
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const file = path.join(home.project, 'src', 'agent.ts');
  fs.writeFileSync(file, "export const agent = 'disk';\n");
  const { app } = await launch(HOOKS);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await app.evaluate(async (_electron, target) => {
    const hooks = (globalThis as unknown as { __damoclesE2e: { editor: { showDiff(request: object): Promise<unknown> } } }).__damoclesE2e;
    await hooks.editor.showDiff({ title: (name: string) => `${name} (At checkpoint ↔ Current)`, filePath: target, left: { name: 'cp-agent.ts', content: "export const agent = 'checkpoint';\n" }, right: { path: target }, purpose: 'checkpoint', preserveFocus: true });
  }, file);
  await expect(editorTab(shell, 'agent.ts (At checkpoint ↔ Current)')).toBeVisible();
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');

  // Files reveals the active diff tab's file.
  await expect(filesRow(shell, 'src/agent.ts')).toBeVisible();
  await filesRow(shell, 'src/agent.ts').focus();
  await shell.keyboard.press('F2');
  await shell.getByTestId('files-edit-input').fill('renamed.ts');
  await shell.getByTestId('files-edit-input').press('Enter');
  const renamed = path.join(home.project, 'src', 'renamed.ts');
  await expect.poll(() => fs.existsSync(renamed)).toBe(true);
  await expect.poll(async () => (await activeTab(app))?.title).toBe('renamed.ts (At checkpoint ↔ Current)');
  expect(await activeTab(app)).toMatchObject({ kind: 'diff', relativePath: 'src/renamed.ts', displayPath: renamed });
  await expect(editorTab(shell, 'renamed.ts (At checkpoint ↔ Current)')).toHaveAttribute('title', renamed);
  await expect(diffEditor(shell).locator('.editor.original .view-line', { hasText: "'checkpoint'" })).toBeVisible();
  await expect(diffEditor(shell).locator('.editor.modified .view-line', { hasText: "'disk'" })).toBeVisible();
});

test('Show Log opens the app log as a read-only tab that follows its end until the reader scrolls up', async ({ home, launch }) => {
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu()!.getMenuItemById('damocles.showLog')!.click());
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('log');
  const tab = (await activeTab(app))!;
  expect(tab).toMatchObject({ readOnly: true, readOnlyReason: 'log' });
  await expect(codeEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await expect(shell.getByTestId('editor-read-only')).toBeVisible();
  // Typing in a read-only log changes nothing. The click targets the editor, not .view-lines: that layer is as large as the
  // whole log, so its centre can sit outside the pane.
  await codeEditor(shell).click();
  await shell.keyboard.type('zzz-typed');
  await expect(codeEditor(shell).locator('.view-line', { hasText: 'zzz-typed' })).toHaveCount(0);
  // Its context menu has nothing that edits.
  await codeEditor(shell).click({ button: 'right' });
  const overlay = await readyOverlay(app);
  await expect.poll(() => menuItemIds(overlay)).toEqual(['copy', 'commandPalette']);
});

async function menuItemIds(overlay: Page): Promise<string[]> {
  return overlayMenu(overlay).locator('[data-menu-item]').evaluateAll((items) => items.map((item) => item.getAttribute('data-item-id') ?? ''));
}

test("a right click in a .ts file opens VS Code's editor context menu in the overlay, and its items act on the buffer", async ({ clipboard, home, launch }) => {
  const file = path.join(home.project, 'a.ts');
  fs.writeFileSync(file, 'const value=1\nconsole.log(value)\n');
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'a.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'const value=1');
  await expect(codeEditor(shell).locator('.monaco-editor')).toHaveClass(/focused/);
  const token = (text: string): Locator => codeEditor(shell).locator('.view-line span span').filter({ hasText: new RegExp(`^${text}$`) }).first();
  const overlay = await readyOverlay(app);

  await token('value').click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  // The TypeScript service's go-to commands, the edits, the clipboard and the palette; Monaco draws no menu of its own.
  expect(await menuItemIds(overlay)).toEqual(['editor.action.revealDefinition', 'editor.action.goToReferences', 'editor.action.rename', 'editor.action.changeAll', 'formatDocument', 'cut', 'copy', 'paste', 'commandPalette']);
  await expect(menuItem(overlay, 'editor.action.revealDefinition')).toContainText('F12');
  await expect(shell.locator('.context-view .monaco-menu')).toHaveCount(0);
  await chooseMenuItem(app, 'editor.action.changeAll');
  await expect(codeEditor(shell).locator('.cursors-layer .cursor')).toHaveCount(2);
  await shell.keyboard.type('count');
  await expect.poll(() => bufferText(shell)).toBe('const count=1\nconsole.log(count)\n');

  await token('count').first().click({ button: 'right' });
  await chooseMenuItem(app, 'formatDocument');
  await expect.poll(() => bufferText(shell)).toBe('const count = 1\nconsole.log(count)\n');

  // Cut the first line through the menu, then paste it at the end from the keyboard's Shift+F10.
  await shell.keyboard.press(DOCUMENT_START);
  await shell.keyboard.press('Shift+End');
  await token('const').click({ button: 'right' });
  await chooseMenuItem(app, 'cut');
  await expect.poll(() => bufferText(shell)).toBe('\nconsole.log(count)\n');
  expect(await clipboard.readText(app)).toBe('const count = 1');
  await shell.keyboard.press(DOCUMENT_END);
  // Main's own key event, which main sees as the user's: Playwright's keys skip before-input-event, so its menu would lose Paste.
  await pressKeys(app, '/shell/', 'F10', ['shift']);
  await chooseMenuItem(app, 'paste');
  await expect.poll(() => bufferText(shell)).toBe('\nconsole.log(count)\nconst count = 1');
  expect(fs.readFileSync(file, 'utf8')).toBe('const value=1\nconsole.log(value)\n');
});

test("an overflowing tab strip scrolls under VS Code's overlay slider, and the active tab's bar stays on that tab through scrolling and closing", async ({ foreground: _foreground, home, launch }) => {
  const names = Array.from({ length: 9 }, (_, i) => `module_number_${i + 1}.ts`);
  for (const name of names) fs.writeFileSync(path.join(home.project, name), `export const n = '${name}';${'\n'}`);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);
  for (const name of names) expect(await openInEditor(app, { projectKey, relativePath: name })).toMatchObject({ ok: true });
  const strip = shell.getByTestId('editor-tabs');
  await expect.poll(() => strip.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
  // VS Code's slider overlays the strip's bottom edge: no native scrollbar takes height, and at rest the slider is hidden.
  expect(await strip.evaluate((element) => (element as HTMLElement).offsetHeight - element.clientHeight)).toBe(0);
  const scrollbar = shell.getByTestId('editor-tab-scrollbar');
  await shell.mouse.move(5, 5);
  await expect(scrollbar).not.toHaveClass(/editor-tab-scrollbar-shown/);
  await strip.hover();
  await expect(scrollbar).toHaveClass(/editor-tab-scrollbar-shown/);
  expect(await scrollbar.evaluate((element) => element.getBoundingClientRect().height)).toBe(3);

  // A vertical wheel scrolls the strip sideways, and dragging the slider scrolls it too.
  await strip.evaluate((element) => { element.scrollLeft = 0; });
  await shell.mouse.wheel(0, 120);
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await strip.evaluate((element) => { element.scrollLeft = 0; });
  const slider = (await scrollbar.locator('.editor-tab-slider').boundingBox())!;
  await shell.mouse.move(slider.x + slider.width / 2, slider.y + 1);
  await shell.mouse.down();
  await shell.mouse.move(slider.x + slider.width / 2 + 80, slider.y + 1, { steps: 4 });
  await shell.mouse.up();
  await expect.poll(() => strip.evaluate((element) => element.scrollLeft)).toBeGreaterThan(80);

  /** How far the bar's box is from the active tab's left, right (separator excluded) and top edges, in px; 0 is on the tab exactly. */
  async function barOffset(): Promise<number> {
    return shell.evaluate(() => {
      const active = document.querySelector<HTMLElement>('[data-editor-tab][aria-selected="true"]:not(.editor-tab-leave-active)')!;
      // The tab's own box without its right-hand separator, which belongs between tabs.
      const outer = active.getBoundingClientRect();
      const tab = { left: outer.left, right: outer.right - Number.parseFloat(getComputedStyle(active).borderRightWidth), top: outer.top };
      const pieces = [...document.querySelectorAll('[data-testid="editor-tab-indicator"] > span')]
        .map((piece) => piece.getBoundingClientRect())
        .filter((rect) => rect.width > 0);
      if (pieces.length === 0) return Infinity;
      const left = Math.min(...pieces.map((piece) => piece.left));
      const right = Math.max(...pieces.map((piece) => piece.right));
      const top = Math.min(...pieces.map((piece) => piece.top));
      return Math.max(Math.abs(left - tab.left), Math.abs(right - tab.right), Math.abs(top - tab.top));
    });
  }
  /**
   * The bar as painted: one run of accent pixels across the tab's top row, starting at the tab's left edge, and ending right
   * before the tab's separator, which keeps the border colour; nothing to either side is tinted.
   */
  async function barPaintsOnTab(): Promise<string> {
    // The overflow fade masks the strip's ends and a clipped tab hides part of its bar, so the tab is read whole and unmasked.
    await strip.evaluate((element) => {
      element.style.maskImage = 'none';
      element.querySelector('[aria-selected="true"]')!.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    const near = (a: readonly number[], b: readonly number[]): boolean => a.every((value, i) => Math.abs(value - b[i]!) <= 6);
    const { row, start, left, right, accent, border } = await activeTabTopRow(app);
    const lit = row.map((pixel) => near(pixel, accent));
    const first = lit.indexOf(true);
    const last = lit.lastIndexOf(true);
    if (first < 0 || lit.slice(first, last + 1).includes(false)) return `no single accent run: ${lit.map((on) => (on ? 1 : 0)).join('')} ${JSON.stringify(row.filter((_, i) => i > first && i < last && !lit[i]).slice(0, 3))}`;
    const separator = row[last + 1]!;
    if (!near(separator, border)) return `separator ${separator.join(',')} is not the border ${border.join(',')}; run ${start + first}..${start + last}, tab ${left}..${right}, row ${JSON.stringify(row.slice(Math.max(0,last-2), last+4))}`;
    if (Math.abs(start + first - left) > 1 || Math.abs(start + last + 2 - right) > 1) return `run ${start + first}..${start + last} against the tab ${left}..${right}`;
    return 'ok';
  }
  const settle = (): Promise<void> => shell.evaluate(() => Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => undefined))).then(() => undefined));

  await editorTab(shell, 'module_number_4.ts').click();
  await settle();
  await expect.poll(barOffset).toBeLessThanOrEqual(0.5);
  await expect.poll(barPaintsOnTab).toBe('ok');
  // Scrolled away, the active tab and its bar are clipped together.
  await strip.evaluate((element) => { element.scrollLeft = element.scrollWidth; });
  await settle();
  await expect.poll(barOffset).toBeLessThanOrEqual(0.5);
  // Scrolled so the active tab sits mid-strip, with a fractional scroll offset.
  await strip.evaluate((element) => {
    const active = element.querySelector<HTMLElement>('[aria-selected="true"]')!;
    element.scrollLeft = active.offsetLeft - (element.clientWidth - active.offsetWidth) / 2 + 0.4;
  });
  await expect.poll(barOffset).toBeLessThanOrEqual(0.5);
  await expect.poll(barPaintsOnTab).toBe('ok');
  await editorTab(shell, 'module_number_3.ts').getByTestId('editor-tab-close').click({ force: true });
  await settle();
  await expect.poll(barOffset).toBeLessThanOrEqual(0.5);
  await expect.poll(barPaintsOnTab).toBe('ok');
  // Both ends round the same way at a fractional scale too.
  await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.setZoomFactor(1.25), SHELL_URL);
  await settle();
  // Edges snap to device px, so the box may differ from the unsnapped tab box by less than one device pixel (0.8 CSS px).
  await expect.poll(barOffset).toBeLessThan(0.8);
  await expect.poll(barPaintsOnTab).toBe('ok');
});
