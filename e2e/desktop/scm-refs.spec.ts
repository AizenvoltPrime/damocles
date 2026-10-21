import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { git, initRepo, type GitHome } from './support/git';
import { writeUserSettings } from './support/hermetic';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { answerInput, bareClone, gitLog, moreActions, openScmProject, pickItem, quickInput, quickInputField, scmSection, write } from './support/scm';
import { overlayPage, selectedProjectKey } from './support/shell';
import { clickSectionAction } from './support/shell-ui';
import { setContentSize } from './support/settings';
import { codeEditor, DOCUMENT_END, editorShows, editorTab, openInEditor, quickPick } from './support/editor';
import { answerDialogs, answerOpenDialog, askedDialogs } from './support/ui';
import { registryRecords } from './support/worktree-repo';

// Branches, stash, tags and worktrees (slice 11b) against temp repositories and local bare remotes, never the network. Core's
// integration tests cover each command's argv; this spec drives main's pickers, inputs and questions through the real app.
const branchButton = (shell: Page): Locator => scmSection(shell).getByTestId('scm-branch');
const stashGroup = (shell: Page): Locator => scmSection(shell).locator('[data-testid="scm-group"][data-group="stashes"]');
const stashCount = (shell: Page): Locator => stashGroup(shell).getByTestId('scm-group-count');
const stashRows = (shell: Page): Locator => scmSection(shell).getByTestId('scm-stash');

// VS Code's questions (extensions/git commands.ts and repository.ts), which main ports.
const UNMERGED = 'is not fully merged';
const DROP_STASH = 'Are you sure you want to drop the stash';
const DIRTY_WORKTREE = 'contains modified or untracked files';
const DELETE_WORKTREE = 'Are you sure you want to delete the worktree';
const UNSAVED = 'unsaved changes';

/** The project as a repository with `main` tracking a bare origin. */
async function trackedProject(h: GitHome, dir: string): Promise<string> {
  await initRepo(h, dir, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  const origin = await bareClone(h, dir, path.join(h.root, 'remotes'), 'origin');
  await git(h, dir, 'remote', 'add', 'origin', origin);
  await git(h, dir, 'fetch', '--quiet', 'origin');
  await git(h, dir, 'branch', '--set-upstream-to=origin/main', 'main');
  return origin;
}

/** Filters the open quick pick to `label` and chooses the item labelled exactly that. */
async function pick(app: ElectronApplication, label: string): Promise<void> {
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(label);
  await pickItem(overlay, label).first().click();
  await expect(pickItem(overlay, label)).toHaveCount(0);
}

/** Stash › `itemId`, then the optional stash message (VS Code's "Optionally provide a stash message"). */
async function stash(app: ElectronApplication, shell: Page, itemId: string, message: string): Promise<void> {
  await moreActions(app, shell, itemId, 'stash');
  await answerInput(app, message);
}

// read with toPass: git refuses refs/stash for a moment while a pop or drop rewrites it
const stashList = (h: GitHome, dir: string): Promise<string> => git(h, dir, 'stash', 'list', '--format=%gs');
const currentBranch = (h: GitHome, dir: string): Promise<string> => git(h, dir, 'branch', '--show-current');

async function gitAtLeast(h: GitHome, cwd: string, major: number, minor: number): Promise<boolean> {
  const match = /(\d+)\.(\d+)/.exec(await git(h, cwd, '--version'));
  const [have, haveMinor] = [Number(match?.[1] ?? 0), Number(match?.[2] ?? 0)];
  return have > major || (have === major && haveMinor >= minor);
}

test('Checkout to... lists local branches, remote branches and tags, creates a branch, and checks a remote branch out as its tracking branch', async ({ home, launch }) => {
  await trackedProject(home, home.project);
  await git(home, home.project, 'push', '--quiet', 'origin', 'main:feat/remote');
  await git(home, home.project, 'fetch', '--quiet', 'origin');
  await git(home, home.project, 'branch', 'feat/local');
  await git(home, home.project, 'tag', 'v1.0');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  const overlay = await readyOverlay(app);

  await expect(branchButton(shell)).toHaveAttribute('title', /^Checkout to\.\.\./);
  await branchButton(shell).click();
  await expect(quickPick(overlay)).toBeVisible();
  const groups = quickPick(overlay).getByTestId('quick-pick-group');
  await expect(groups).toHaveCount(3);
  for (const label of ['main', 'feat/local', 'origin/feat/remote', 'v1.0']) await expect(pickItem(overlay, label)).toHaveCount(1);
  await expect(pickItem(overlay, 'main')).toHaveAttribute('aria-checked', 'true');
  // a group label sits above its own items: local, then remote, then tags
  const order = await quickPick(overlay).locator('[data-testid="quick-pick-group"], [data-testid="quick-pick-item"]').allTextContents();
  const at = (text: string): number => order.findIndex((entry) => entry.includes(text));
  expect(at('feat/local')).toBeLessThan(at('origin/feat/remote'));
  expect(at('origin/feat/remote')).toBeLessThan(at('v1.0'));

  await pickItem(overlay, 'Create new branch...').click();
  await answerInput(app, 'topic');
  await expect.poll(() => currentBranch(home, home.project)).toBe('topic');
  await expect(branchButton(shell).getByTestId('scm-branch-label')).toHaveText('topic');
  await expect(branchButton(shell).getByTestId('scm-branch-local')).toBeVisible();

  await branchButton(shell).click();
  await pick(app, 'origin/feat/remote');
  await expect.poll(() => currentBranch(home, home.project)).toBe('feat/remote');
  expect(await git(home, home.project, 'rev-parse', '--abbrev-ref', 'feat/remote@{upstream}')).toBe('origin/feat/remote');
  await expect(branchButton(shell).getByTestId('scm-branch-label')).toHaveText('feat/remote');
  await expect(branchButton(shell).getByTestId('scm-branch-local')).toHaveCount(0);
});

for (const prefix of ['', 'me/']) {
  test(`the text typed in Checkout to... is echoed on Create new branch... and becomes the new branch's name${prefix ? ' behind branchPrefix' : ''}`, async ({ home, launch }) => {
    await initRepo(home, home.project);
    if (prefix) writeUserSettings(home, { 'damocles.desktop.git.branchPrefix': prefix });
    const { app } = await launch();
    const shell = await openScmProject(app, home.project);
    const overlay = await readyOverlay(app);

    await branchButton(shell).click();
    await expect(quickPick(overlay)).toBeVisible();
    await expect(pickItem(overlay, 'Create new branch...')).toHaveText('Create new branch...');
    await overlay.getByTestId('quick-pick-input').fill('fix login');
    await expect(pickItem(overlay, 'Create new branch...')).toContainText('\u201cfix login\u201d');
    await expect(pickItem(overlay, 'Create new branch from...')).toContainText('\u201cfix login\u201d');
    await expect(pickItem(overlay, 'Checkout detached...')).toHaveText('Checkout detached...');
    await pickItem(overlay, 'Create new branch...').click();
    await expect(quickInput(overlay)).toBeVisible();
    // cleaned as VS Code's sanitizeBranchName does, and shown for the user to confirm
    await expect(quickInputField(overlay)).toHaveValue(`${prefix}fix-login`);
    expect(await quickInputField(overlay).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([prefix.length, prefix.length + 'fix-login'.length]);
    await quickInputField(overlay).press('Enter');
    await expect.poll(() => currentBranch(home, home.project)).toBe(`${prefix}fix-login`);
    await expect(branchButton(shell).getByTestId('scm-branch-label')).toHaveText(`${prefix}fix-login`);
  });
}

test('Delete Branch... on an unmerged branch asks first, keeps it on Cancel, and forces the delete on Delete Branch', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  await git(home, home.project, 'switch', '--quiet', '-c', 'unmerged');
  write(home.project, 'c.ts', 'export const c = 1;\n');
  await git(home, home.project, 'add', '-A');
  await git(home, home.project, 'commit', '--quiet', '-m', 'Unmerged work');
  await git(home, home.project, 'switch', '--quiet', 'main');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);

  await answerDialogs(app, { [UNMERGED]: 'Cancel' });
  await moreActions(app, shell, 'deleteBranch', 'branch');
  await pick(app, 'unmerged');
  await expect.poll(async () => (await askedDialogs(app)).filter((dialog) => dialog.message.includes(UNMERGED)).length).toBe(1);
  expect(await git(home, home.project, 'branch', '--list', 'unmerged')).toContain('unmerged');

  await answerDialogs(app, { [UNMERGED]: 'Delete Branch' });
  await moreActions(app, shell, 'deleteBranch', 'branch');
  await pick(app, 'unmerged');
  await expect.poll(() => git(home, home.project, 'branch', '--list', 'unmerged')).toBe('');
  const asked = (await askedDialogs(app)).filter((dialog) => dialog.message.includes(UNMERGED));
  expect(asked.at(-1)).toMatchObject({ severity: 'danger', buttons: expect.arrayContaining(['Delete Branch', 'Cancel']) });
});

test('Stash, Stash (Include Untracked), View Stash and the stash tab\'s Apply and Drop, then Pop Latest Stash, work on a real repository', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await expect(scmSection(shell).getByTestId('scm-stash-note')).toHaveText('No stashes.');

  write(home.project, 'a.ts', 'export const a = 2;\n');
  write(home.project, 'new.ts', 'export const fresh = true;\n');
  await stash(app, shell, 'stash', 'first');
  await expect(async () => expect(await stashList(home, home.project)).toBe('On main: first')).toPass();
  // Stash leaves untracked files in place
  expect(fs.existsSync(path.join(home.project, 'new.ts'))).toBe(true);
  await expect(stashCount(shell)).toHaveText('1');

  await stash(app, shell, 'stashIncludeUntracked', 'second');
  await expect.poll(() => fs.existsSync(path.join(home.project, 'new.ts'))).toBe(false);
  await expect(stashCount(shell)).toHaveText('2');
  await expect(stashRows(shell).first().getByTestId('scm-stash-description')).toHaveText('second');

  // View Stash shows the stash's files, its untracked ones included, with Apply Stash and Drop Stash in the tab's title.
  await stashRows(shell).first().click();
  const tab = shell.locator('[data-testid="changes-tab"][data-source="stash"]');
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId('changes-entry')).toHaveAttribute('data-path', 'new.ts');
  await tab.getByTestId('changes-stash-apply').click();
  await expect.poll(() => fs.existsSync(path.join(home.project, 'new.ts'))).toBe(true);
  await expect(tab.getByTestId('changes-stash-apply')).toHaveAttribute('data-applied', 'true');
  // Apply leaves the stash, so its tab stays
  await expect(tab).toBeVisible();
  await expect(stashCount(shell)).toHaveText('2');
  await answerDialogs(app, { [DROP_STASH]: 'Yes' });
  await tab.getByTestId('changes-stash-drop').click();
  await expect(async () => expect(await stashList(home, home.project)).toBe('On main: first')).toPass();
  await expect(tab).toHaveCount(0);
  await expect(stashCount(shell)).toHaveText('1');

  fs.rmSync(path.join(home.project, 'new.ts'));
  await moreActions(app, shell, 'stashPopLatest', 'stash');
  await expect(async () => expect(await stashList(home, home.project)).toBe('')).toPass();
  expect(fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  await expect(scmSection(shell).getByTestId('scm-stash-note')).toHaveText('No stashes.');
});

test('View Stash\'s Pop Stash pops the tab\'s stash and closes the tab, which leaves the Stashes group', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  write(home.project, 'a.ts', 'export const a = 4;\n');
  await stash(app, shell, 'stash', 'to pop');
  await expect(stashRows(shell)).toHaveCount(1);
  expect(fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');

  await stashRows(shell).first().click();
  const tab = shell.locator('[data-testid="changes-tab"][data-source="stash"]');
  await expect(tab.getByTestId('changes-stash-pop')).toHaveAttribute('aria-label', 'Pop Stash');
  await tab.getByTestId('changes-stash-pop').click();
  await expect(async () => expect(await stashList(home, home.project)).toBe('')).toPass();
  await expect(tab).toHaveCount(0);
  await expect(stashRows(shell)).toHaveCount(0);
  await expect(scmSection(shell).getByTestId('scm-stash-note')).toHaveText('No stashes.');
  expect(fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toBe('export const a = 4;\n');
});

test('View Stash keeps its actions on the lead\'s line while both fit whole, and moves them under it only when they do not', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  write(home.project, 'a.ts', 'export const a = 4;\n');
  await stash(app, shell, 'stash', 'wip');
  await stashRows(shell).first().click();
  await expect(shell.locator('[data-testid="changes-tab"][data-source="stash"]').getByTestId('changes-stash-drop')).toBeVisible();
  await setContentSize(app, 900, 660);
  const top = () => shell.evaluate(() => {
    const tab = document.querySelector('[data-testid="changes-tab"][data-source="stash"]')!;
    const row = tab.querySelector('[data-testid="changes-top"]')!;
    const lead = tab.querySelector('[data-testid="changes-lead"] > span')!;
    const first = tab.querySelector('[data-testid="changes-stash-apply"]')!.getBoundingClientRect();
    const last = tab.querySelector('[data-testid="changes-stash-drop"]')!.getBoundingClientRect();
    const style = getComputedStyle(row);
    const inner = row.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return {
      fits: lead.scrollWidth + Number.parseFloat(style.columnGap) + (last.right - first.left) <= inner,
      sameLine: first.top < tab.querySelector('[data-testid="changes-heading"]')!.getBoundingClientRect().bottom,
      leadWhole: lead.scrollWidth <= lead.clientWidth,
    };
  });
  const setFont = (px: number) => shell.evaluate((size) => document.documentElement.style.setProperty('--d-font-size', `${size}px`), px);
  await setFont(16);
  await expect.poll(top).toEqual({ fits: true, sameLine: true, leadWhole: true });
  await setFont(20);
  await expect.poll(top).toEqual({ fits: false, sameLine: false, leadWhole: true });
});

test('More Actions › Stash says why Pop Latest Stash is off when the repository has no stashes', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await expect(scmSection(shell).getByTestId('scm-stash-note')).toHaveText('No stashes.');
  const overlay = await readyOverlay(app);
  await clickSectionAction(shell, 'scm-more-actions');
  await menuItem(overlay, 'submenu:stash').click();
  const pop = overlay.locator('[data-submenu-item][data-item-id="stashPopLatest"]');
  await expect(pop).toHaveAttribute('aria-disabled', 'true');
  await expect(pop.getByTestId('overlay-menu-reason')).toHaveText('No stashes');
  await expect(pop).toHaveAccessibleDescription('No stashes');
  // Stash itself needs no stash, so it says nothing
  await expect(overlay.locator('[data-submenu-item][data-item-id="stash"]').getByTestId('overlay-menu-reason')).toHaveCount(0);
  // Playwright refuses to click an aria-disabled item, so the click is dispatched; the menu stays open
  await pop.dispatchEvent('click');
  await expect(overlayMenu(overlay)).toBeVisible();
  await overlay.keyboard.press('Escape');
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);
});

test('Stash Staged stashes the staged changes only, and is offered only with git 2.35 or later', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  const shell = await openScmProject(app, home.project);
  const capable = await gitAtLeast(home, home.project, 2, 35);
  await clickSectionAction(shell, 'scm-more-actions');
  const overlay = await overlayPage(app);
  await menuItem(overlay, 'submenu:stash').click();
  await expect(overlay.locator('[data-submenu-item][data-item-id="stashStaged"]')).toHaveCount(capable ? 1 : 0);
  await overlay.keyboard.press('Escape');
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);
  test.skip(!capable, 'git older than 2.35 has no stash --staged');

  write(home.project, 'a.ts', 'export const a = 2;\n');
  await git(home, home.project, 'add', 'a.ts');
  write(home.project, 'b.ts', 'export const b = 2;\n');
  await stash(app, shell, 'stashStaged', 'staged only');
  // git stash stores refs/stash before it resets the index, so the reads wait for the push's Git log line, written on exit
  await expect.poll(() => gitLog(app)).toContain('> git stash push --staged');
  expect(await stashList(home, home.project)).toBe('On main: staged only');
  expect(await git(home, home.project, 'diff', '--cached', '--name-only')).toBe('');
  expect(await git(home, home.project, 'diff', '--name-only')).toBe('b.ts');
});

test('a stash made in a terminal appears in the Stashes group within the watcher debounce, and Drop Stash on its row asks first', async ({ home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await expect(scmSection(shell).getByTestId('scm-stash-note')).toHaveText('No stashes.');

  write(home.project, 'a.ts', 'export const a = 3;\n');
  await git(home, home.project, 'stash', 'push', '-m', 'from the terminal');
  await expect(stashRows(shell)).toHaveCount(1, { timeout: 5_000 });
  await expect(stashRows(shell).getByTestId('scm-stash-description')).toHaveText('from the terminal');
  await expect(stashRows(shell).getByTestId('scm-stash-detail')).toHaveText(/^main · /);

  await answerDialogs(app, { [DROP_STASH]: 'Yes' });
  await stashRows(shell).click({ button: 'right' });
  const overlay = await overlayPage(app);
  await menuItem(overlay, 'dropStash').click();
  await expect(async () => expect(await stashList(home, home.project)).toBe('')).toPass();
  await expect(stashRows(shell)).toHaveCount(0);
  expect((await askedDialogs(app)).find((dialog) => dialog.message.includes(DROP_STASH))).toBeDefined();
});

test('Create Tag with a message makes an annotated tag, Push Tags pushes every tag, and Delete Remote Tag removes one from the bare remote', async ({ foreground: _foreground, home, launch }) => {
  const origin = await trackedProject(home, home.project);
  await git(home, home.project, 'tag', 'v1.0');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);

  await moreActions(app, shell, 'createTag', 'tags');
  await answerInput(app, 'v2.0');
  await answerInput(app, 'Release two');
  await expect.poll(() => git(home, home.project, 'tag', '--list', 'v2.0')).toBe('v2.0');
  expect(await git(home, home.project, 'cat-file', '-t', 'v2.0')).toBe('tag');
  expect(await git(home, home.project, 'tag', '--list', '--format=%(contents:subject)', 'v2.0')).toBe('Release two');

  await moreActions(app, shell, 'pushTags', 'tags');
  await expect.poll(async () => (await git(home, origin, 'tag')).split('\n')).toEqual(['v1.0', 'v2.0']);

  await moreActions(app, shell, 'deleteRemoteTag', 'tags');
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toBeVisible();
  // with one remote to push to, VS Code's first pick is that remote's tags
  await expect(quickPick(overlay).getByTestId('quick-pick-item')).toHaveCount(2);
  await expect(pickItem(overlay, 'v1.0')).toBeVisible();
  await expect(pickItem(overlay, 'v2.0')).toBeVisible();
  await pick(app, 'v1.0');
  await expect.poll(() => git(home, origin, 'tag')).toBe('v2.0');
  expect(await git(home, home.project, 'tag', '--list', 'v1.0')).toBe('v1.0');
});

test('Create Worktree adds a linked worktree; Delete Worktree always asks first, and on a dirty one asks again before forcing', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  await git(home, home.project, 'branch', 'wt-branch');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  const worktrees = async (): Promise<string[]> => (await git(home, home.project, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree '));

  await moreActions(app, shell, 'createWorktree', 'worktrees');
  const overlay = await overlayPage(app);
  // VS Code's flow: the branch or commit to start from, then the folder, prefilled beside the repository
  await pick(app, 'wt-branch');
  await expect(quickInput(overlay)).toBeVisible();
  const folder = await quickInputField(overlay).inputValue();
  expect(folder).not.toBe('');
  await quickInputField(overlay).press('Enter');
  await expect.poll(async () => (await worktrees()).length).toBe(2);
  const linked = (await worktrees())[1]!.slice('worktree '.length);
  expect(await git(home, linked, 'branch', '--show-current')).toBe('wt-branch');
  // slice 12a rule 16: Create Worktree records the worktree as adopted, and its delete retires the record
  const sameFolder = (a: string, b: string): boolean => (process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));
  const adopted = () => registryRecords(home).find((record) => record.kind === 'adopted' && sameFolder(record.worktreeRoot, linked));
  await expect.poll(() => adopted()?.branch).toBe('wt-branch');

  // a clean worktree still asks, since git deletes its ignored files too
  await answerDialogs(app, { [DELETE_WORKTREE]: 'Cancel' });
  await moreActions(app, shell, 'deleteWorktree', 'worktrees');
  await pick(app, path.basename(linked));
  await expect.poll(async () => (await askedDialogs(app)).filter((dialog) => dialog.message.includes(DELETE_WORKTREE)).length).toBe(1);
  const asked = (await askedDialogs(app)).find((dialog) => dialog.message.includes(DELETE_WORKTREE))!;
  expect(asked).toMatchObject({ severity: 'danger', detail: 'Its ignored files, such as .env and node_modules, are deleted too.' });
  expect(asked.message).toContain(path.basename(linked));
  expect(await worktrees()).toHaveLength(2);

  write(linked, 'dirty.ts', 'export const dirty = true;\n');
  await answerDialogs(app, { [DELETE_WORKTREE]: 'Delete Worktree', [DIRTY_WORKTREE]: 'Cancel' });
  await moreActions(app, shell, 'deleteWorktree', 'worktrees');
  await pick(app, path.basename(linked));
  await expect.poll(async () => (await askedDialogs(app)).filter((dialog) => (dialog.message + (dialog.detail ?? '')).includes(DIRTY_WORKTREE)).length).toBe(1);
  expect(await worktrees()).toHaveLength(2);

  await answerDialogs(app, { [DELETE_WORKTREE]: 'Delete Worktree', [DIRTY_WORKTREE]: 'Force Delete' });
  await moreActions(app, shell, 'deleteWorktree', 'worktrees');
  await pick(app, path.basename(linked));
  await expect.poll(async () => (await worktrees()).length).toBe(1);
  expect(fs.existsSync(linked)).toBe(false);
  expect((await askedDialogs(app)).filter((dialog) => (dialog.message + (dialog.detail ?? '')).includes(DIRTY_WORKTREE)).at(-1)).toMatchObject({ severity: 'danger' });
  // no chat names the deleted record, so it is removed rather than kept as a tombstone
  await expect.poll(() => adopted()).toBeUndefined();
});

test('Create Worktree\'s folder button sets the path to the picked folder and the name, and the next Create Worktree starts there', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  const overlay = await readyOverlay(app);
  const picked = path.join(home.root, 'trees');
  fs.mkdirSync(picked, { recursive: true });

  await moreActions(app, shell, 'createWorktree', 'worktrees');
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill('wt one');
  await pickItem(overlay, 'Create new branch...').click();
  await answerInput(app, 'wt-one');
  await expect(quickInput(overlay)).toBeVisible();
  const suggested = await quickInputField(overlay).inputValue();
  expect(path.basename(suggested)).toBe('wt-one');
  const browse = overlay.getByTestId('quick-input-browse');
  await expect(browse).toHaveAccessibleName('Select Worktree Destination');
  await answerOpenDialog(app, picked);
  await browse.click();
  await expect(quickInputField(overlay)).toHaveValue(path.join(picked, 'wt-one'));
  await expect(quickInputField(overlay)).toBeFocused();
  expect(await quickInputField(overlay).evaluate((input: HTMLInputElement) => input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0))).toBe('wt-one');
  await quickInputField(overlay).press('Enter');
  // git writes the worktree's .git file before its HEAD; main records the adopted worktree only after `worktree add` exited
  await expect.poll(() => registryRecords(home).find((record) => record.kind === 'adopted')?.branch).toBe('wt-one');
  expect(await git(home, path.join(picked, 'wt-one'), 'branch', '--show-current')).toBe('wt-one');

  // the folder of the first worktree is remembered for this repository
  await moreActions(app, shell, 'createWorktree', 'worktrees');
  await expect(quickPick(overlay)).toBeVisible();
  await pickItem(overlay, 'Create new branch...').click();
  await answerInput(app, 'wt-two');
  await expect(quickInputField(overlay)).toHaveValue(path.join(picked, 'wt-two'));
  await quickInputField(overlay).press('Escape');
  await expect(quickInput(overlay)).toHaveCount(0);
});

test('with pullBeforeCheckout on, checking out a branch that is behind with no outgoing commits fast-forwards it first', async ({ home, launch }) => {
  const origin = await trackedProject(home, home.project);
  await git(home, home.project, 'push', '--quiet', 'origin', 'main:feat');
  await git(home, home.project, 'fetch', '--quiet', 'origin');
  await git(home, home.project, 'branch', '--track', 'feat', 'origin/feat');
  // someone else pushes to feat
  const other = path.join(home.root, 'other');
  await git(home, home.root, 'clone', '--quiet', '--branch', 'feat', origin, other);
  write(other, 'upstream.ts', 'export const upstream = 1;\n');
  await git(home, other, 'add', '-A');
  await git(home, other, 'commit', '--quiet', '-m', 'Upstream work');
  await git(home, other, 'push', '--quiet', 'origin', 'feat');
  await git(home, home.project, 'fetch', '--quiet', 'origin');
  const upstream = await git(home, home.project, 'rev-parse', 'origin/feat');
  writeUserSettings(home, { 'damocles.desktop.git.pullBeforeCheckout': true });
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);

  await branchButton(shell).click();
  await pick(app, 'feat');
  await expect.poll(() => currentBranch(home, home.project)).toBe('feat');
  await expect.poll(() => git(home, home.project, 'rev-parse', 'HEAD')).toBe(upstream);
  expect(fs.existsSync(path.join(home.project, 'upstream.ts'))).toBe(true);
});

test('with promptToSaveFilesBeforeStash at always, a dirty editor tab of a changed file asks to save before stashing', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  write(home.project, 'a.ts', 'export const a = 2;\n');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);

  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'a.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'export const a = 2;');
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// unsaved');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('data-dirty', 'true');

  await answerDialogs(app, { [UNSAVED]: 'Save All & Stash' });
  await stash(app, shell, 'stash', 'saved first');
  await expect(async () => expect(await stashList(home, home.project)).toBe('On main: saved first')).toPass();
  const asked = (await askedDialogs(app)).find((dialog) => (dialog.message + (dialog.detail ?? '')).includes(UNSAVED));
  expect(asked?.buttons).toEqual(expect.arrayContaining(['Save All & Stash', 'Stash Anyway']));
  // the saved edit went into the stash, so the working tree is back at HEAD
  expect(await git(home, home.project, 'stash', 'show', '-p', 'stash@{0}')).toContain('// unsaved');
  expect(fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
});
