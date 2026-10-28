import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { activeTab, codeEditor, diffEditor, editorShows, openInEditor } from './support/editor';
import { git, initRepo } from './support/git';
import type { HermeticHome } from './support/hermetic';
import { cleanUp, endLeftoverDaemon, LOOPBACK_ENV, LOOPBACK_TAG, openThroughLocalDaemon, shutdownDaemon } from './support/loopback';
import { answerInput, commitMessage, moreActions, pickItem, quickInput, quickInputField, scmSection, setSection, write } from './support/scm';
import { overlayPage, pressKeys, PRIMARY, shellPage, shellState } from './support/shell';
import { quickPick } from './support/editor';
import { addProject, answerDialogs, clickMenu } from './support/ui';

const BASE = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;', 'const g = 7;', 'const h = 8;', 'const i = 9;', 'const j = 10;', ''].join('\n');
const DELETE_WORKTREE = 'Are you sure you want to delete the worktree';

const change = (shell: Page, group: 'workingTree' | 'index', file: string): Locator =>
  scmSection(shell).locator(`[data-testid="scm-change"][data-group="${group}"][data-path="${file}"]`);
const marks = (shell: Page): Promise<string | null> => codeEditor(shell).getAttribute('data-quick-diff');
const peek = (shell: Page): Locator => codeEditor(shell).getByTestId('quick-diff-peek');
const modifiedLine = (shell: Page, text: string): Locator => diffEditor(shell).locator('.editor.modified .view-line', { hasText: text });
const originalLine = (shell: Page, text: string): Locator => diffEditor(shell).locator('.editor.original .view-line', { hasText: text });
const cached = (home: HermeticHome, folder: string): Promise<string> => git(home, folder, 'diff', '--cached', '--unified=0');

/** Opens a file of `projectKey` and waits until the editor shows `text`. */
async function openFile(app: ElectronApplication, shell: Page, projectKey: string, relativePath: string, text: string): Promise<void> {
  expect(await openInEditor(app, { projectKey, relativePath })).toMatchObject({ ok: true });
  await editorShows(shell, text);
}

/** Appends `text` to the line holding `line` in the active code editor, leaving the caret there. */
async function appendToLine(shell: Page, line: string, text: string): Promise<void> {
  await codeEditor(shell).locator('.view-line', { hasText: line }).first().click();
  await shell.keyboard.press('End');
  await shell.keyboard.type(text);
}

/** Filters the open quick pick to `label` and chooses the item labelled exactly that. */
async function pick(app: ElectronApplication, label: string): Promise<void> {
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(label);
  await pickItem(overlay, label).first().click();
  await expect(pickItem(overlay, label)).toHaveCount(0);
}

test('on a loopback repository Open Changes, a timeline commit diff, a stash diff and Create and Delete Worktree and Git: Rename run through the daemon', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(420_000);
  const folder = path.join(home.root, 'p', 'remote');
  await initRepo(home, folder, { 'app.ts': BASE, 'notes.md': '# Notes\n' });
  write(folder, 'app.ts', BASE.replace('const a = 1;', 'const a = 10;'));
  await git(home, folder, 'commit', '-q', '-am', 'Grow a');
  await git(home, folder, 'branch', 'wt-branch');
  write(folder, 'app.ts', BASE.replace('const a = 1;', 'const a = 10;').replace('const b = 2;', 'const b = 20;'));
  write(folder, 'notes.md', '# Notes\nstaged line\n');
  await git(home, folder, 'add', 'notes.md');
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    const shell = await shellPage(app);
    const key = await openThroughLocalDaemon(app, folder);
    await setSection(shell, 'scm-section', true);
    await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });

    // Open Changes on a working-tree change: the index against the daemon's file, which stays the loopback project's.
    await expect(change(shell, 'workingTree', 'app.ts')).toHaveAttribute('data-letter', 'M', { timeout: 60_000 });
    await change(shell, 'workingTree', 'app.ts').click();
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(modifiedLine(shell, 'const b = 20;')).toBeVisible();
    await expect(originalLine(shell, 'const b = 2;')).toBeVisible();
    expect(await activeTab(app)).toMatchObject({ kind: 'diff', projectKey: key, relativePath: 'app.ts' });

    // Open Changes on a staged change: HEAD against the index.
    await change(shell, 'index', 'notes.md').click();
    await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('notes.md');
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(modifiedLine(shell, 'staged line')).toBeVisible();
    await expect(originalLine(shell, 'staged line')).toHaveCount(0);

    // The timeline of a daemon file lists its commits, and an entry opens that commit's diff.
    await openFile(app, shell, key, 'app.ts', 'const b = 20;');
    const grow = await git(home, folder, 'rev-parse', 'HEAD');
    await clickMenu(app, 'damocles.git.openTimeline');
    const timeline = shell.getByTestId('timeline-tab');
    await expect(timeline).toBeVisible();
    await expect(timeline.getByTestId('timeline-entry')).toHaveCount(2);
    await timeline.locator(`[data-testid="timeline-entry"][data-hash="${grow}"]`).click();
    await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await expect(modifiedLine(shell, 'const a = 10;')).toBeVisible();
    await expect(originalLine(shell, 'const a = 1;')).toBeVisible();
    await expect(modifiedLine(shell, 'const b = 20;')).toHaveCount(0);

    // A stash made through the daemon opens in a stash tab, and its file's diff shows the stashed text.
    await moreActions(app, shell, 'stash', 'stash');
    await answerInput(app, 'on the daemon');
    await expect.poll(() => git(home, folder, 'stash', 'list', '--format=%gs')).toBe('On main: on the daemon');
    await scmSection(shell).getByTestId('scm-stash').first().click();
    const stashTab = shell.locator('[data-testid="changes-tab"][data-source="stash"]');
    await expect(stashTab).toBeVisible();
    const stashed = stashTab.locator('[data-testid="changes-entry"][data-path="app.ts"]');
    await expect(stashed).toBeVisible();
    await stashed.click();
    await expect(stashTab.getByTestId('changes-diff')).toContainText('const b = 20;');

    // Create Worktree from a branch, at the folder main suggests on the target, then Delete Worktree after its question.
    const worktrees = async (): Promise<string[]> => (await git(home, folder, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree '));
    await moreActions(app, shell, 'createWorktree', 'worktrees');
    await pick(app, 'wt-branch');
    const overlay = await overlayPage(app);
    await expect(quickInput(overlay)).toBeVisible();
    expect(await quickInputField(overlay).inputValue()).not.toBe('');
    await quickInputField(overlay).press('Enter');
    await expect.poll(async () => (await worktrees()).length).toBe(2);
    const linked = (await worktrees())[1]!.slice('worktree '.length);
    expect(await git(home, linked, 'branch', '--show-current')).toBe('wt-branch');
    await answerDialogs(app, { [DELETE_WORKTREE]: 'Delete Worktree' });
    await moreActions(app, shell, 'deleteWorktree', 'worktrees');
    await pick(app, path.basename(linked));
    await expect.poll(async () => (await worktrees()).length).toBe(1);
    expect(fs.existsSync(linked)).toBe(false);

    // Git: Rename of a daemon file moves it through the daemon's git, and its tab follows it as the host's project file.
    await openFile(app, shell, key, 'notes.md', '# Notes');
    await expect.poll(() => app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('damocles.git.rename')?.enabled)).toBe(true);
    await clickMenu(app, 'damocles.git.rename');
    await expect(quickInput(overlay)).toBeVisible();
    await expect(quickInputField(overlay)).toHaveValue('notes.md');
    await quickInputField(overlay).fill('renamed.md');
    await quickInputField(overlay).press('Enter');
    await expect.poll(() => fs.existsSync(path.join(folder, 'renamed.md'))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'notes.md'))).toBe(false);
    await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('renamed.md');
    expect((await activeTab(app))?.projectKey).toBe(key);

    await shutdownDaemon(app, home);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
  }
});

test('on a loopback file the quick diff stages a hunk from its peek, Unstage Selected Ranges takes it back, Revert edits the buffer only, and Stage Selected Ranges stages the daemon buffer\'s line, never the local editor\'s of the same file', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(420_000);
  const folder = path.join(home.root, 'p', 'remote');
  await initRepo(home, folder, { 'app.ts': BASE });
  write(folder, 'app.ts', BASE.replace('const b = 2;', 'const b = 20;').replace('const h = 8;', 'const h = 80;'));
  const { app } = await launch(LOOPBACK_ENV);
  let failure: unknown;
  try {
    const shell = await shellPage(app);
    // The same folder as a local project first, its editor holding an unsaved line the index must never take.
    await addProject(app, folder, true);
    const localKey = (await shellState(app)).projects.find((project) => project.authority.kind === 'local' && project.fsPath === folder)!.key;
    await openFile(app, shell, localKey, 'app.ts', 'const b = 20;');
    await appendToLine(shell, 'const c = 3;', ' // local-only');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);

    const key = await openThroughLocalDaemon(app, folder);
    await setSection(shell, 'scm-section', true);
    await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });
    await openFile(app, shell, key, 'app.ts', 'const b = 20;');
    expect(await activeTab(app)).toMatchObject({ kind: 'code', projectKey: key });
    await expect.poll(() => marks(shell), { timeout: 60_000 }).toBe('2-2,8-8');

    // The peek stages the first hunk alone in the daemon's repository.
    await codeEditor(shell).locator('.qd-mark').first().click();
    await expect(peek(shell)).toBeVisible();
    await expect(peek(shell)).toContainText('1 of 2 changes');
    await peek(shell).getByTestId('peek-stage').click();
    await expect.poll(() => cached(home, folder)).toContain('+const b = 20;');
    expect(await cached(home, folder)).not.toContain('const h = 80;');
    await expect.poll(() => marks(shell)).toBe('2-2s,8-8');

    // Revert on the second hunk edits the daemon buffer only: the target's file and index keep the change.
    await peek(shell).getByTestId('peek-next').click();
    await expect(peek(shell)).toContainText('2 of 2 changes');
    await peek(shell).getByTestId('peek-revert').click();
    await editorShows(shell, 'const h = 8;');
    await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
    expect(fs.readFileSync(path.join(folder, 'app.ts'), 'utf8')).toContain('const h = 80;');
    await expect(peek(shell)).toHaveCount(0);

    // Stage Selected Ranges on an unsaved line of the daemon's buffer stages that buffer's text, never the local editor's.
    await appendToLine(shell, 'const c = 3;', ' // daemon-buffer');
    await pressKeys(app, '/shell/', 'K', [PRIMARY]);
    await pressKeys(app, '/shell/', 'S', [PRIMARY, 'alt']);
    await expect.poll(() => cached(home, folder)).toContain('+const c = 3; // daemon-buffer');
    expect(await cached(home, folder)).not.toContain('local-only');
    expect(fs.readFileSync(path.join(folder, 'app.ts'), 'utf8')).not.toContain('daemon-buffer');

    // Unstage Selected Ranges in the Staged Changes diff takes the first hunk back and leaves the buffer's line staged.
    await change(shell, 'index', 'app.ts').click();
    await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
    await modifiedLine(shell, 'const b = 20;').click();
    await pressKeys(app, '/shell/', 'K', [PRIMARY]);
    await pressKeys(app, '/shell/', 'N', [PRIMARY]);
    await expect.poll(() => cached(home, folder)).not.toContain('const b = 20;');
    const staged = await cached(home, folder);
    expect(staged).toContain('+const c = 3; // daemon-buffer');
    expect(staged).not.toContain('local-only');

    // Stage Selected Ranges right as the code tab opens, before its marks are drawn, stages the hunk again.
    await openFile(app, shell, key, 'app.ts', 'const b = 20;');
    await codeEditor(shell).locator('.view-line', { hasText: 'const b = 20;' }).first().click();
    await pressKeys(app, '/shell/', 'K', [PRIMARY]);
    await pressKeys(app, '/shell/', 'S', [PRIMARY, 'alt']);
    await expect.poll(() => cached(home, folder)).toContain('+const b = 20;');
    await expect.poll(() => marks(shell)).toBe('2-3s');

    await shutdownDaemon(app, home);
    // the quit's question about the unsaved buffers, whose text the test leaves unsaved
    await answerDialogs(app, { 'Do you want to save': "Don't Save" });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
  }
});
