import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { git, initRepo, type GitHome } from './support/git';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { gitLog, pickItem, scmSection, setSection } from './support/scm';
import { openProjectChat } from './support/screenshots';
import { overlayPage, shellPage, shellState } from './support/shell';
import { clickSectionAction, cssString, sectionAction } from './support/shell-ui';
import { quickPick } from './support/editor';
import { addProject, answerDialogs, TRUST_PROMPT } from './support/ui';

// The Repositories section (slice 11a, D58): every acceptance criterion against real git in the hermetic home.
const HOOKS = { DAMOCLES_E2E_HOOKS: '1' };
const DAY = 86_400_000;

const section = (shell: Page): Locator => shell.getByTestId('repositories-section');
const rows = (shell: Page): Locator => section(shell).getByTestId('repositories-row');
const row = (shell: Page, kind: string, name: string): Locator => section(shell).locator(`[data-testid="repositories-row"][data-kind="${kind}"][data-name=${cssString(name)}]`);
const twistie = (target: Locator): Locator => target.getByTestId('repositories-twistie');

/** A commit dated `ago` ms before now, author and committer alike, so for-each-ref orders the branches by it. */
async function commitAt(h: GitHome, dir: string, file: string, message: string, ago: number): Promise<void> {
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  await git(h, dir, 'add', '-A');
  const date = new Date(Date.now() - ago).toISOString();
  await git(h, dir, { env: { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }, 'commit', '--quiet', '-m', message);
}

/** main, feat/a and feat/b each on its own commit, newer in that order, team/ax/fix alone under team, a tag v1.0 and a stash. */
async function seed(h: GitHome, dir: string): Promise<void> {
  await initRepo(h, dir);
  await commitAt(h, dir, 'main.ts', 'Main work', 3 * DAY);
  for (const [name, ago] of [['feat/a', 2 * DAY], ['feat/b', 1 * DAY], ['team/ax/fix', 4 * DAY]] as const) {
    await git(h, dir, 'switch', '--quiet', '-c', name, 'main');
    await commitAt(h, dir, `${name.replace(/\//g, '-')}.ts`, `${name} work`, ago);
  }
  await git(h, dir, 'switch', '--quiet', 'main');
  await git(h, dir, 'tag', 'v1.0');
  fs.writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
  await git(h, dir, 'stash', 'push', '-m', 'Parse JSON bodies');
}

/** The project open with Repositories the section that fills the sidebar: Chats and Files collapse, Source control stays. */
async function openRepositories(app: ElectronApplication, dir: string): Promise<Page> {
  await openProjectChat(app, dir);
  const shell = await shellPage(app);
  await setSection(shell, 'sidebar-chats', false);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'repositories-section', true);
  await expect(section(shell).getByTestId('repositories-tree')).toBeVisible({ timeout: 30_000 });
  return shell;
}

async function expand(target: Locator): Promise<void> {
  if ((await target.getAttribute('aria-expanded')) !== 'true') await twistie(target).click();
  await expect(target).toHaveAttribute('aria-expanded', 'true');
}

/** A row's inline action, shown as a user shows it: by hovering the row. */
async function hoverAction(target: Locator, action: string): Promise<void> {
  await target.hover();
  await target.getByTestId(`repositories-action-${action}`).click();
}

/** Opens a row's menu and chooses `itemId`. */
async function rowMenu(app: ElectronApplication, target: Locator, itemId: string): Promise<void> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await target.click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, itemId).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

const labelOf = (target: Locator): Locator => target.getByTestId('repositories-label');

test('Branches shows the feat folder first and main with the HEAD icon, b above a once feat opens, and team/ax as one merged folder', async ({ home, launch }) => {
  await seed(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);

  // the groups in VS Code's order, collapsed until opened
  await expect(rows(shell)).toHaveCount(4);
  await expect(rows(shell).getByTestId('repositories-label')).toHaveText(['Branches', 'Stashes', 'Tags', 'Worktrees']);
  await expand(row(shell, 'group', 'branches'));
  await expect(rows(shell).getByTestId('repositories-label')).toHaveText(['Branches', 'feat', 'team/ax', 'main', 'Stashes', 'Tags', 'Worktrees']);
  await expect(row(shell, 'folder', 'feat')).toHaveAttribute('aria-expanded', 'false');
  await expect(row(shell, 'branch', 'main')).toHaveAttribute('data-head', 'true');

  await expand(row(shell, 'folder', 'feat'));
  await expect(rows(shell).getByTestId('repositories-label')).toHaveText(['Branches', 'feat', 'b', 'a', 'team/ax', 'main', 'Stashes', 'Tags', 'Worktrees']);
  for (const [name, subject, time] of [['feat/b', 'feat/b work', '1 day ago'], ['feat/a', 'feat/a work', '2 days ago']] as const) {
    const hash = await git(home, home.project, 'rev-parse', '--short=7', name);
    await expect(row(shell, 'branch', name).getByTestId('repositories-description')).toHaveText(`${hash} \u2022 ${subject}`);
    await expect(row(shell, 'branch', name).getByTestId('repositories-time')).toHaveText(time);
  }
  // a chain of single-child folders is one row holding the branch
  await expand(row(shell, 'folder', 'team/ax'));
  await expect(labelOf(row(shell, 'branch', 'team/ax/fix'))).toHaveText('fix');
  await expect(row(shell, 'branch', 'team/ax/fix')).toHaveAttribute('aria-level', '3');
});

test('a click selects a row without expanding it, the twistie expands a folder, and the expanded rows and Source control\'s View as Tree come back after a restart', async ({ foreground: _foreground, home, launch }) => {
  await seed(home, home.project);
  let desktop = await launch({ env: HOOKS });
  let shell = await openRepositories(desktop.app, home.project);
  await expand(row(shell, 'group', 'branches'));
  await row(shell, 'folder', 'feat').click();
  await expect(row(shell, 'folder', 'feat')).toHaveAttribute('aria-selected', 'true');
  await expect(row(shell, 'folder', 'feat')).toHaveAttribute('aria-expanded', 'false');
  await row(shell, 'branch', 'main').click();
  await expect(row(shell, 'branch', 'main')).toHaveAttribute('aria-selected', 'true');
  await expect(rows(shell)).toHaveCount(7);
  await expand(row(shell, 'folder', 'feat'));
  await expect(row(shell, 'branch', 'feat/a')).toBeVisible();
  await clickSectionAction(shell, 'scm-view-mode');
  await expect(scmSection(shell).getByTestId('scm-tree')).toHaveAttribute('data-view-mode', 'tree');
  await expect.poll(async () => (await shellState(desktop.app)).layout.scm.viewMode).toBe('tree');

  await desktop.close();
  desktop = await launch({ env: HOOKS });
  shell = await shellPage(desktop.app);
  await expect(row(shell, 'branch', 'feat/a')).toBeVisible({ timeout: 30_000 });
  await expect(row(shell, 'folder', 'feat')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(shell, 'group', 'stashes')).toHaveAttribute('aria-expanded', 'false');
  await expect(scmSection(shell).getByTestId('scm-tree')).toHaveAttribute('data-view-mode', 'tree');
});

test('Checkout on feat/a switches the branch, and the branch button, the Projects label and the HEAD icon follow', async ({ foreground: _foreground, home, launch }) => {
  await seed(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  await expand(row(shell, 'group', 'branches'));
  await expand(row(shell, 'folder', 'feat'));
  // the checked-out branch offers no Checkout of its own
  await row(shell, 'branch', 'main').hover();
  await expect(row(shell, 'branch', 'main').getByTestId('repositories-action-checkoutRef')).toHaveCount(0);

  await hoverAction(row(shell, 'branch', 'feat/a'), 'checkoutRef');
  await expect.poll(() => git(home, home.project, 'branch', '--show-current')).toBe('feat/a');
  await expect(scmSection(shell).getByTestId('scm-branch-label')).toHaveText('feat/a');
  await expect(shell.getByTestId('project-branch')).toHaveText('feat/a');
  await expect(row(shell, 'branch', 'feat/a')).toHaveAttribute('data-head', 'true');
  await expect(row(shell, 'branch', 'main')).not.toHaveAttribute('data-head', 'true');
});

test('with a nested repository, a repository row selects it in Source control, and the picker selects the other row', async ({ home, launch }) => {
  await initRepo(home, home.project);
  await initRepo(home, path.join(home.project, 'nested'), { 'n.ts': 'export {};\n' });
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  const name = path.basename(home.project);
  await expect(rows(shell)).toHaveCount(2);
  await expect(row(shell, 'repo', name)).toHaveAttribute('aria-selected', 'true');

  await row(shell, 'repo', 'nested').click();
  await expect(scmSection(shell).getByTestId('scm-repo-name')).toHaveText('nested');
  await expect(row(shell, 'repo', 'nested')).toHaveAttribute('aria-selected', 'true');
  await expect(row(shell, 'repo', name)).toHaveAttribute('aria-selected', 'false');

  const overlay = await readyOverlay(app);
  await scmSection(shell).getByTestId('scm-repo-picker').click();
  await expect(overlayMenu(overlay)).toBeVisible();
  await overlayMenu(overlay).locator('[data-item-id^="repo:"]').first().click();
  await expect(scmSection(shell).getByTestId('scm-repo-name')).toHaveText(name);
  await expect(row(shell, 'repo', name)).toHaveAttribute('aria-selected', 'true');
  await expect(row(shell, 'repo', 'nested')).toHaveAttribute('aria-selected', 'false');
});

test('Apply Stash from the row and from the Stashes group run the same operation, and both lists follow every change', async ({ foreground: _foreground, home, launch }) => {
  await seed(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  await expand(row(shell, 'group', 'stashes'));
  const hash = await git(home, home.project, 'rev-parse', 'stash@{0}');
  const stashRow = row(shell, 'stash', hash);
  await expect(labelOf(stashRow)).toHaveText('Parse JSON bodies');
  await expect(scmSection(shell).getByTestId('scm-stash')).toHaveCount(1);
  const applies = async (): Promise<string[]> => (await gitLog(app)).split('\n').filter((line) => / stash apply /.test(line)).map((line) => line.replace(/ \[\d+ms.*$/, ''));

  await hoverAction(stashRow, 'applyStash');
  await expect.poll(() => fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  await git(home, home.project, 'checkout', '--', 'a.ts');
  await scmSection(shell).getByTestId('scm-stash').hover();
  await scmSection(shell).getByTestId('scm-stash-apply').click();
  await expect.poll(() => fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  await expect.poll(async () => (await applies()).length).toBe(2);
  const [fromRow, fromGroup] = await applies();
  expect(fromRow).toBe(fromGroup);

  // a stash made in a terminal and one dropped from the row reach both lists
  await git(home, home.project, 'stash', 'push', '-m', 'Second');
  await expect(section(shell).locator('[data-kind="stash"]')).toHaveCount(2, { timeout: 5_000 });
  await expect(scmSection(shell).getByTestId('scm-stash')).toHaveCount(2);
  await answerDialogs(app, { 'Are you sure you want to drop the stash': 'Yes' });
  await rowMenu(app, row(shell, 'stash', await git(home, home.project, 'rev-parse', 'stash@{0}')), 'dropStash');
  await expect(section(shell).locator('[data-kind="stash"]')).toHaveCount(1);
  await expect(scmSection(shell).getByTestId('scm-stash')).toHaveCount(1);
  await expect(row(shell, 'group', 'stashes').getByTestId('repositories-count')).toHaveText('1');
});

test('Compare with... from feat/a to main opens one multi-file diff tab', async ({ home, launch }) => {
  await seed(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  await expand(row(shell, 'group', 'branches'));
  await expand(row(shell, 'folder', 'feat'));
  await rowMenu(app, row(shell, 'branch', 'feat/a'), 'compareRef');
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toBeVisible();
  await expect(pickItem(overlay, 'feat/a')).toHaveCount(0);
  await overlay.getByTestId('quick-pick-input').fill('main');
  await pickItem(overlay, 'main').click();
  const tab = shell.locator('[data-testid="changes-tab"][data-source="refs"]');
  await expect(tab).toHaveCount(1);
  await expect(tab.getByTestId('changes-entry')).toHaveCount(1);
  await expect(tab.getByTestId('changes-entry')).toHaveAttribute('data-path', 'feat-a.ts');
  await expect(shell.locator('[data-testid="editor-tab"]').filter({ hasText: 'main \u2194 feat/a' })).toHaveCount(1);
});

test('each Copy action puts the expected text on the clipboard', async ({ clipboard, home, launch }) => {
  await seed(home, home.project);
  const linked = path.join(home.root, 'acme-hotfix');
  await git(home, home.project, 'worktree', 'add', '--quiet', '-b', 'hotfix/login', linked);
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  for (const group of ['branches', 'stashes', 'tags', 'worktrees']) await expand(row(shell, 'group', group));
  await expand(row(shell, 'folder', 'feat'));
  const stash = await git(home, home.project, 'rev-parse', 'stash@{0}');
  const linkedRow = section(shell).locator('[data-kind="worktree"]').filter({ has: shell.getByTestId('repositories-label').getByText('acme-hotfix', { exact: true }) });
  await expect(linkedRow).toBeVisible();
  // the row names the worktree as git lists it, which is the path Copy Worktree Path copies
  const linkedPath = (await linkedRow.getAttribute('data-name'))!;
  expect(fs.realpathSync.native(linkedPath)).toBe(fs.realpathSync.native(linked));
  const copies: Array<[Locator, string, string]> = [
    [row(shell, 'branch', 'feat/a'), 'copyBranchName', 'feat/a'],
    [row(shell, 'branch', 'feat/a'), 'copyCommitHash', await git(home, home.project, 'rev-parse', 'feat/a')],
    [row(shell, 'tag', 'v1.0'), 'copyTagName', 'v1.0'],
    [row(shell, 'tag', 'v1.0'), 'copyCommitHash', await git(home, home.project, 'rev-parse', 'v1.0^{commit}')],
    [row(shell, 'stash', stash), 'copyBranchName', 'main'],
    [row(shell, 'stash', stash), 'copyStashName', 'Parse JSON bodies'],
    [linkedRow, 'copyBranchName', 'hotfix/login'],
    [linkedRow, 'copyCommitHash', await git(home, linked, 'rev-parse', 'HEAD')],
    [linkedRow, 'copyWorktreePath', linkedPath],
  ];
  for (const [target, action, text] of copies) {
    await clipboard.writeText(app, '');
    await rowMenu(app, target, action);
    await expect.poll(() => clipboard.readText(app), `${action} of ${await target.getAttribute('data-name')}`).toBe(text);
  }
});

test('a worktree added in a terminal appears within the debounce; its Open adds it as a project after the trust question, and Open on the main worktree selects its project', async ({ foreground: _foreground, home, launch }) => {
  await seed(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  await expand(row(shell, 'group', 'worktrees'));
  await expect(section(shell).locator('[data-kind="worktree"]')).toHaveCount(1);
  const mainOpen = section(shell).locator('[data-kind="worktree"]').first();
  await mainOpen.hover();
  await expect(mainOpen.getByTestId('repositories-action-openWorktree')).toHaveAttribute('title', 'Show project folder');

  const linked = path.join(home.root, 'acme-review');
  await git(home, home.project, 'worktree', 'add', '--quiet', '-b', 'review', linked);
  const linkedRow = section(shell).locator('[data-kind="worktree"]').nth(1);
  await expect(linkedRow).toBeVisible({ timeout: 5_000 });
  await expect(labelOf(linkedRow)).toHaveText('acme-review');
  await linkedRow.hover();
  await expect(linkedRow.getByTestId('repositories-action-openWorktree')).toHaveAttribute('title', 'Add as project');

  await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
  await hoverAction(linkedRow, 'openWorktree');
  await expect.poll(async () => {
    const state = await shellState(app);
    const added = state.projects.find((project) => path.basename(project.fsPath) === 'acme-review');
    return added !== undefined && added.trusted && state.selected.projectKey === added.key;
  }).toBe(true);

  // the worktree project's own Repositories lists the main worktree, whose Open selects the first project; until the shell
  // renders that project, the rows are still the first project's, whose Worktrees group is open
  await expect(scmSection(shell).getByTestId('scm-branch-label')).toHaveText('review');
  await expand(row(shell, 'group', 'worktrees'));
  const mainRow = section(shell).locator('[data-kind="worktree"]').first();
  await expect(labelOf(mainRow)).toHaveText(path.basename(home.project));
  await hoverAction(mainRow, 'openWorktree');
  await expect.poll(async () => {
    const state = await shellState(app);
    return state.projects.find((project) => project.key === state.selected.projectKey)?.fsPath;
  }).toBe(home.project);
});

test('Close Repository on a row hides it from the section and the picker, and Reopen Closed Repositories... in the title brings it back', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  await initRepo(home, path.join(home.project, 'nested'), { 'n.ts': 'export {};\n' });
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toContainText('1 of 2');
  await expect(section(shell).getByTestId('repositories-reopen-closed')).toHaveCount(0);

  await hoverAction(row(shell, 'repo', 'nested'), 'closeRepository');
  await expect(row(shell, 'repo', 'nested')).toHaveCount(0);
  // one repository left: its groups are the top level, and Source control shows no picker
  await expect(rows(shell).getByTestId('repositories-label')).toHaveText(['Branches', 'Stashes', 'Tags', 'Worktrees']);
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toHaveCount(0);

  await (await sectionAction(shell, 'repositories-reopen-closed')).click();
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toBeVisible();
  await quickPick(overlay).getByTestId('quick-pick-item').filter({ hasText: path.join(home.project, 'nested') }).click();
  await expect(row(shell, 'repo', 'nested')).toBeVisible();
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toContainText('of 2');
  await expect(section(shell).getByTestId('repositories-reopen-closed')).toHaveCount(0);
});

test('an untrusted project shows the trust state in Repositories and runs no git', async ({ home, launch }) => {
  await seed(home, home.project);
  const { app } = await launch({ env: HOOKS });
  await addProject(app, home.project, false);
  const shell = await shellPage(app);
  await setSection(shell, 'repositories-section', true);
  await expect(section(shell).getByTestId('scm-state')).toHaveAttribute('data-state', 'untrusted');
  await expect(section(shell).getByTestId('scm-state')).toContainText('Trust this folder to use source control');
  await expect(rows(shell)).toHaveCount(0);
  expect(await gitLog(app)).toBe('');
});

test('with 5,000 tags, Tags reads its rows only once expanded, and fewer than 100 rows are in the DOM while scrolling it', async ({ home, launch }) => {
  await initRepo(home, home.project);
  const head = await git(home, home.project, 'rev-parse', 'HEAD');
  const lines = Array.from({ length: 5_000 }, (_, index) => `create refs/tags/t${String(index).padStart(4, '0')} ${head}\n`).join('');
  await git(home, home.project, { input: lines }, 'update-ref', '--stdin');
  const { app } = await launch({ env: HOOKS });
  const shell = await openRepositories(app, home.project);
  const tagReads = async (): Promise<number> => (await gitLog(app)).split('\n').filter((line) => line.includes('for-each-ref') && line.includes('refs/tags')).length;
  await expect(rows(shell)).toHaveCount(4);
  expect(await tagReads()).toBe(0);

  await expand(row(shell, 'group', 'tags'));
  await expect(row(shell, 'group', 'tags').getByTestId('repositories-count')).toHaveText('5000', { timeout: 30_000 });
  expect(await tagReads()).toBe(1);
  const tree = section(shell).getByTestId('repositories-tree');
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    await tree.evaluate((element, at) => {
      element.scrollTop = (element.scrollHeight - element.clientHeight) * at;
    }, fraction);
    await expect(rows(shell).first()).toBeVisible();
    expect(await rows(shell).count()).toBeLessThan(100);
  }
  // scrolled back up, the virtual list mounts the group's own row again
  await tree.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(row(shell, 'group', 'tags')).toBeVisible();
  expect(await rows(shell).count()).toBeLessThan(100);
});
