import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { selectedProjectKey, shellPage } from './support/shell';
import { codeEditor, editorShows, editorTab, openInEditor } from './support/editor';
import { confirmDialog, menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { openScmProject, scmSection } from './support/scm';
import { git, initRepo } from './support/git';
import { addProject } from './support/ui';
import type { HermeticHome } from './support/hermetic';

// The merge editor and inline conflicts (plan slice 12, B28, B29 and B47), against real git in the hermetic home.

const BASE = 'line 1\nshared 2\nline 3\nline 4\nline 5\nline 6\nline 7\nshared 8\nline 9\n';
const editor = (shell: Page): Locator => shell.getByTestId('merge-editor');
const status = (shell: Page): Locator => shell.getByTestId('merge-status');
const mergeRow = (shell: Page, file: string): Locator => scmSection(shell).locator(`[data-testid="scm-change"][data-group="merge"][data-path="${file}"]`);
const lens = (shell: Page, title: string): Locator => codeEditor(shell).locator('.codelens-decoration a', { hasText: title });

/** main and feature both change lines 2 and 8 of a.ts (and line 2 of b.ts); `operation` leaves the repository conflicted. */
async function conflicted(home: HermeticHome, operation: 'merge' | 'rebase'): Promise<void> {
  await initRepo(home, home.project, { 'a.ts': BASE, 'b.ts': BASE });
  await git(home, home.project, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(home.project, 'a.ts'), BASE.replace('shared 2', 'feature 2').replace('shared 8', 'feature 8'));
  fs.writeFileSync(path.join(home.project, 'b.ts'), BASE.replace('shared 2', 'feature b2'));
  await git(home, home.project, 'commit', '-q', '-am', 'Feature edits');
  await git(home, home.project, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(home.project, 'a.ts'), BASE.replace('shared 2', 'main 2').replace('shared 8', 'main 8'));
  fs.writeFileSync(path.join(home.project, 'b.ts'), BASE.replace('shared 2', 'main b2'));
  await git(home, home.project, 'commit', '-q', '-am', 'Main edits');
  if (operation === 'merge') await expect(git(home, home.project, 'merge', 'feature')).rejects.toThrow();
  else {
    await git(home, home.project, 'checkout', '-q', 'feature');
    await expect(git(home, home.project, 'rebase', 'main')).rejects.toThrow();
  }
}

/** Right-clicks a Merge Changes row and picks `itemId` from its menu. */
async function rowAction(app: ElectronApplication, shell: Page, file: string, itemId: string): Promise<void> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await mergeRow(shell, file).click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, itemId).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

async function moreAction(app: ElectronApplication, shell: Page, itemId: string): Promise<void> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await editor(shell).getByTestId('merge-more').click();
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, itemId).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

// A plain working-tree diff takes index.lock when a file matches a stage, which fails the app's git add meanwhile.
const unmerged = (home: HermeticHome): Promise<string> => git(home, home.project, '-c', 'diff.autoRefreshIndex=false', 'diff', '--name-only', '--diff-filter=U');

test('the merge editor names the branches, resolves every region, asks before completing with a conflict left, rebuilds with Compute Conflicts With Git (Diff3), and Complete Merge stages the file', async ({ foreground: _foreground, home, launch }) => {
  await conflicted(home, 'merge');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await expect(mergeRow(shell, 'a.ts')).toBeVisible();
  await rowAction(app, shell, 'a.ts', 'resolveInMergeEditor');
  await expect(editor(shell)).toBeVisible();
  await expect(editorTab(shell, 'Merging: a.ts')).toHaveAttribute('aria-selected', 'true');
  await expect(editor(shell).getByTestId('merge-incoming-label')).toContainText('feature');
  await expect(editor(shell).getByTestId('merge-current-label')).toContainText('main');
  await expect(status(shell)).toHaveText('2 of 2 conflicts left');
  // a merge shows Incoming first
  await expect(editor(shell).getByTestId('merge-incoming').getByTestId('merge-accept-incoming').first()).toBeVisible();
  expect((await editor(shell).getByTestId('merge-incoming').boundingBox())!.x).toBeLessThan((await editor(shell).getByTestId('merge-current').boundingBox())!.x);

  // Accept Incoming on the first region resolves it; one is left.
  await editor(shell).getByTestId('merge-incoming').getByTestId('merge-accept-incoming').first().click();
  await expect(status(shell)).toHaveText('1 of 2 conflicts left');
  await expect(editor(shell).getByTestId('merge-result').locator('.view-line', { hasText: 'feature 2' })).toBeVisible();

  // Complete Merge with a conflict left asks first; Cancel keeps the file conflicted.
  const overlay = await readyOverlay(app);
  await editor(shell).getByTestId('merge-complete').click();
  await expect(confirmDialog(overlay)).toContainText('1 unhandled conflict');
  await confirmDialog(overlay).getByRole('button', { name: 'Cancel' }).click();
  await expect(confirmDialog(overlay)).toHaveCount(0);
  expect((await unmerged(home)).split(/\s+/)).toEqual(['a.ts', 'b.ts']);

  // Compute Conflicts With Git (Diff3) rebuilds the Result with both conflicts and their base blocks.
  await moreAction(app, shell, 'computeDiff3');
  await expect(status(shell)).toHaveText('2 of 2 conflicts left');
  await expect(editor(shell).getByTestId('merge-result').locator('.view-line', { hasText: '|||||||' }).first()).toBeVisible();

  // Resolve both, then Complete Merge stages the file without asking.
  await moreAction(app, shell, 'acceptAllCurrent');
  await expect(status(shell)).toHaveText('All conflicts resolved');
  await editor(shell).getByTestId('merge-complete').click();
  await expect.poll(() => unmerged(home)).toBe('b.ts');
  expect(await git(home, home.project, 'show', ':a.ts')).toContain('main 8');
  expect(fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).not.toContain('<<<<<<<');
});

test('during a rebase the merge editor swaps the sides, as VS Code does', async ({ foreground: _foreground, home, launch }) => {
  await conflicted(home, 'rebase');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await expect(mergeRow(shell, 'a.ts')).toBeVisible();
  await rowAction(app, shell, 'a.ts', 'resolveInMergeEditor');
  await expect(editor(shell)).toBeVisible();
  // Current is the branch being rebased onto; Incoming is the commit being replayed.
  await expect(editor(shell).getByTestId('merge-current-label')).toContainText('main');
  await expect(editor(shell).getByTestId('merge-incoming-label')).not.toContainText('main');
  await expect(editor(shell).getByTestId('merge-current').locator('.view-line', { hasText: 'main 2' })).toBeVisible();
  await expect(editor(shell).getByTestId('merge-incoming').locator('.view-line', { hasText: 'feature 2' })).toBeVisible();
  // and Current shows first, its label and its pane alike
  const left = async (testId: string): Promise<number> => (await editor(shell).getByTestId(testId).boundingBox())!.x;
  expect(await left('merge-current')).toBeLessThan(await left('merge-incoming'));
  expect(await left('merge-current-label')).toBeLessThan(await left('merge-incoming-label'));
});


test('code lenses resolve a second file, and Accept All Incoming from the Merge Changes group leaves the buffer edited and unsaved', async ({ foreground: _foreground, home, launch }) => {
  await conflicted(home, 'merge');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);

  // Clicking a merge row still opens the file, which shows the inline conflict lenses.
  await mergeRow(shell, 'b.ts').click();
  await editorShows(shell, 'main b2');
  await expect(lens(shell, 'Accept Incoming Change')).toBeVisible();
  for (const title of ['Accept Current Change', 'Accept Both Changes', 'Compare Changes']) await expect(lens(shell, title)).toBeVisible();
  await lens(shell, 'Compare Changes').click();
  await expect(codeEditor(shell).getByTestId('conflict-compare')).toBeVisible();
  await codeEditor(shell).getByTestId('conflict-compare-close').click();
  await lens(shell, 'Accept Incoming Change').click();
  await editorShows(shell, 'feature b2');
  await expect(codeEditor(shell).locator('.view-line', { hasText: '<<<<<<<' })).toHaveCount(0);
  await expect(editorTab(shell, 'b.ts')).toHaveAttribute('data-dirty', 'true');

  // Accept All Incoming on a.ts opens it and edits its buffer, leaving the file on disk as it was.
  await rowAction(app, shell, 'a.ts', 'acceptAllIncoming');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('data-dirty', 'true');
  await editorShows(shell, 'feature 8');
  await expect(codeEditor(shell).locator('.view-line', { hasText: '>>>>>>>' })).toHaveCount(0);
  expect(fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toContain('<<<<<<<');
});

test('a file with conflict markers outside git shows the lenses too, in an untrusted project', async ({ foreground: _foreground, home, launch }) => {
  fs.mkdirSync(home.project, { recursive: true });
  fs.writeFileSync(path.join(home.project, 'notes.txt'), 'top\n<<<<<<< mine\nalpha\n=======\nbeta\n>>>>>>> theirs\nbottom\n');
  const { app } = await launch();
  const first = await activeChat(app);
  const opened = nextChat(app, [first]);
  await addProject(app, home.project, false);
  await opened;
  const shell = await shellPage(app);
  expect((await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'notes.txt' })).ok).toBe(true);
  await editorShows(shell, 'alpha');
  await expect(lens(shell, 'Accept Both Changes')).toBeVisible();
  await lens(shell, 'Accept Both Changes').click();
  await editorShows(shell, 'beta');
  await expect(codeEditor(shell).locator('.view-line', { hasText: '=======' })).toHaveCount(0);
});
