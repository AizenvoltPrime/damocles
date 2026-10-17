import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { pressKeys, PRIMARY, selectedProjectKey, shellPage } from './support/shell';
import { codeEditor, diffEditor, editorShows, editorState, editorTab, openInEditor } from './support/editor';
import { openScmProject, scmSection } from './support/scm';
import { git, initRepo } from './support/git';
import { addProject } from './support/ui';
import type { HermeticHome } from './support/hermetic';

// Quick diff, the peek and selected ranges (plan slice 12, B25 to B27 and B47), against real git in the hermetic home.

const BASE = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;', 'const g = 7;', 'const h = 8;', 'const i = 9;', 'const j = 10;', ''].join('\n');

/** The editor's quick diff marks as main's shell draws them: start-end pairs, staged ones suffixed s. */
const marks = (shell: Page): Promise<string | null> => codeEditor(shell).getAttribute('data-quick-diff');

async function openFile(app: ElectronApplication, shell: Page, relativePath: string, text: string): Promise<void> {
  const result = await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath });
  expect(result.ok).toBe(true);
  await editorShows(shell, text);
}

/** Puts the caret on the line holding `text` by clicking it. */
async function caretOn(shell: Page, text: string): Promise<void> {
  await codeEditor(shell).locator('.view-line', { hasText: text }).first().click();
}

/** The top of the current-line highlight, which Monaco draws at the caret's line, as the line holding `text` is placed. */
async function caretIsOn(shell: Page, text: string): Promise<void> {
  const top = await codeEditor(shell).locator('.view-line', { hasText: text }).first().evaluate((line) => (line as HTMLElement).style.top);
  await expect.poll(() => codeEditor(shell).locator('.view-overlays .current-line').first().evaluate((highlight) => (highlight.parentElement as HTMLElement).style.top)).toBe(top);
}

const peek = (shell: Page): Locator => codeEditor(shell).getByTestId('quick-diff-peek');
const cached = (home: HermeticHome): Promise<string> => git(home, home.project, 'diff', '--cached', '--unified=0');

test('the gutter marks an edit, the peek stages one of two hunks, Unstage Selected Ranges in the staged diff takes it back, and Revert Hunk edits the buffer only', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'app.ts': BASE });
  fs.writeFileSync(path.join(home.project, 'app.ts'), BASE.replace('const b = 2;', 'const b = 20;').replace('const h = 8;', 'const h = 80;'));
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await openFile(app, shell, 'app.ts', 'const b = 20;');

  await expect.poll(() => marks(shell)).toBe('2-2,8-8');
  await expect(codeEditor(shell).locator('.qd-mark.qd-modified')).toHaveCount(2);

  // The peek opens from the first mark and stages that hunk alone.
  await codeEditor(shell).locator('.qd-mark').first().click();
  await expect(peek(shell)).toBeVisible();
  await expect(peek(shell)).toContainText('1 of 2 changes');
  await peek(shell).getByTestId('peek-stage').click();
  await expect.poll(() => cached(home)).toContain('+const b = 20;');
  expect(await cached(home)).not.toContain('const h = 80;');
  // the staged hunk's mark turns hollow, the other stays solid, and the peek stays on the hunk, now staged
  await expect.poll(() => marks(shell)).toBe('2-2s,8-8');
  await expect(codeEditor(shell).locator('.qd-mark.qd-staged')).toHaveCount(1);
  await expect(peek(shell).getByTestId('peek-unstage')).toBeVisible();

  // Revert Hunk on the second change edits the buffer alone: disk and index keep the edit.
  await peek(shell).getByTestId('peek-next').click();
  await expect(peek(shell)).toContainText('2 of 2 changes');
  await peek(shell).getByTestId('peek-revert').click();
  await editorShows(shell, 'const h = 8;');
  await expect(editorTab(shell, 'app.ts')).toHaveAttribute('data-dirty', 'true');
  expect(fs.readFileSync(path.join(home.project, 'app.ts'), 'utf8')).toContain('const h = 80;');
  expect(await git(home, home.project, 'show', ':app.ts')).not.toContain('const h = 80;');
  // no change is left below the reverted one, so the peek closes
  await expect(peek(shell)).toHaveCount(0);

  // Escape in the editor closes an open peek.
  await codeEditor(shell).locator('.qd-mark').first().click();
  await expect(peek(shell)).toBeVisible();
  await codeEditor(shell).locator('.view-line', { hasText: 'const j = 10;' }).first().click();
  await shell.keyboard.press('Escape');
  await expect(peek(shell)).toHaveCount(0);

  // Unstage Selected Ranges in the Staged Changes diff removes the staged hunk again (Ctrl+K Ctrl+N).
  await scmSection(shell).locator('[data-testid="scm-change"][data-group="index"][data-path="app.ts"]').click();
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  const modified = diffEditor(shell).locator('.editor.modified');
  await modified.locator('.view-line', { hasText: 'const b = 20;' }).click();
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'N', [PRIMARY]);
  await expect.poll(() => cached(home)).toBe('');
});

test('Stage Selected Ranges (Ctrl+K Ctrl+Alt+S) stages only the caret line of a hunk, and Alt+F5 and Shift+Alt+F5 walk the changes', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'app.ts': BASE });
  fs.writeFileSync(path.join(home.project, 'app.ts'), BASE.replace('const c = 3;', 'const c = 30;').replace('const d = 4;', 'const d = 40;').replace('const e = 5;', 'const e = 50;').replace('const j = 10;', 'const j = 100;'));
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await openFile(app, shell, 'app.ts', 'const d = 40;');
  await expect.poll(() => marks(shell)).toBe('3-5,10-10');

  await caretOn(shell, 'const a = 1;');
  await pressKeys(app, '/shell/', 'F5', ['alt']);
  await caretIsOn(shell, 'const c = 30;');
  await pressKeys(app, '/shell/', 'F5', ['alt']);
  await caretIsOn(shell, 'const j = 100;');
  await pressKeys(app, '/shell/', 'F5', ['shift', 'alt']);
  await caretIsOn(shell, 'const c = 30;');

  await caretOn(shell, 'const d = 40;');
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'S', [PRIMARY, 'alt']);
  await expect.poll(() => cached(home)).toContain('+const d = 40;');
  const staged = await cached(home);
  expect(staged).not.toContain('const c = 30;');
  expect(staged).not.toContain('const e = 50;');
  expect(staged).not.toContain('const j = 100;');
});

test('a diff against the index stages a block and a selection from its gutter, and its index side follows', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'app.ts': BASE });
  fs.writeFileSync(path.join(home.project, 'app.ts'), BASE.replace('const b = 2;', 'const b = 20;').replace('const g = 7;', 'const g = 70;\nconst g2 = 71;'));
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await scmSection(shell).locator('[data-testid="scm-change"][data-group="workingTree"][data-path="app.ts"]').click();
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  const original = diffEditor(shell).locator('.editor.original');
  const modified = diffEditor(shell).locator('.editor.modified');
  await expect(modified.locator('.qd-stage-block')).toHaveCount(2);

  // Stage Block on the first hunk: the index has it, and the tab's index side shows it.
  await modified.locator('.qd-stage-block').first().click();
  await expect.poll(() => cached(home)).toContain('+const b = 20;');
  await expect(original.locator('.view-line', { hasText: 'const b = 20;' })).toBeVisible();
  await expect(modified.locator('.qd-stage-block')).toHaveCount(1);

  // Stage Selection on the second hunk's first line stages that line alone.
  await modified.locator('.view-line', { hasText: 'const g = 70;' }).click({ clickCount: 3 });
  await expect(modified.locator('.qd-stage-selection')).toHaveCount(1);
  await modified.locator('.qd-stage-selection').click();
  await expect.poll(() => cached(home)).toContain('+const g = 70;');
  expect(await cached(home)).not.toContain('const g2 = 71;');
  await expect(original.locator('.view-line', { hasText: 'const g = 70;' })).toBeVisible();
});

test('an untracked file and a binary file show no gutter marks', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'app.ts': BASE, 'blob.bin': 'seed\n' });
  fs.writeFileSync(path.join(home.project, 'app.ts'), BASE.replace('const a = 1;', 'const a = 10;'));
  fs.writeFileSync(path.join(home.project, 'new.ts'), 'export const fresh = true;\n');
  fs.writeFileSync(path.join(home.project, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255, 0, 3]));
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);

  // A tracked edit is marked, which shows the quick diff runs in this window.
  await openFile(app, shell, 'app.ts', 'const a = 10;');
  await expect.poll(() => marks(shell)).toBe('1-1');

  await openFile(app, shell, 'new.ts', 'export const fresh = true;');
  // main refuses the base of an untracked file, after which no mark can come
  await expect(codeEditor(shell)).toHaveAttribute('data-quick-diff-state', 'none');
  await expect(codeEditor(shell)).toHaveAttribute('data-quick-diff', '');
  await expect(codeEditor(shell).locator('.qd-mark')).toHaveCount(0);

  const binary = await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'blob.bin' });
  expect(binary.ok).toBe(true);
  await expect(shell.getByTestId('editor-not-displayed')).toBeVisible();
  await expect(shell.locator('.qd-mark')).toHaveCount(0);
});

test('a file of an untrusted project shows no gutter marks', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'app.ts': BASE });
  fs.writeFileSync(path.join(home.project, 'app.ts'), BASE.replace('const a = 1;', 'const a = 10;'));
  const { app } = await launch();
  const first = await activeChat(app);
  const opened = nextChat(app, [first]);
  await addProject(app, home.project, false);
  await opened;
  const shell = await shellPage(app);
  await openFile(app, shell, 'app.ts', 'const a = 10;');
  // the tab of an untrusted project has no git resource, so its quick diff never starts
  await expect(codeEditor(shell)).toHaveAttribute('data-quick-diff-state', 'none');
  expect((await editorState(app)).tabs.find((tab) => tab.title === 'app.ts')?.git).toBeUndefined();
  await expect(codeEditor(shell)).toHaveAttribute('data-quick-diff', '');
  await expect(codeEditor(shell).locator('.qd-mark')).toHaveCount(0);
});
