import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { git, initRepo, type GitHome } from '../support/git';
import { quickPick } from '../support/editor';
import { menuItem, overlayMenu } from '../support/overlay';
import { pickItem, setSection, write } from '../support/scm';
import { dismiss, openProjectChat, rest, setFont, setReducedMotion, shot, showShellTheme, THEMES, windowShot, type Theme } from '../support/screenshots';
import { cssString } from '../support/shell-ui';
import { setContentSize } from '../support/settings';
import { overlayPage, shellPage, shellState } from '../support/shell';
import { addProject } from '../support/ui';

// Review captures of slice 11a (the Repositories section, D58): Dark and Light, the 13px default and a 16px host font, and a
// reduced-motion pass. Three projects: alpha with one repository, mono with a nested one, and an untrusted vendor folder.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_500_000);

/** The project: main, feat/rate-limit, feat/users-docs and team/ax/login-fix, tags v1.0 and v1.1 and release/v2.0-rc, two stashes and a linked worktree. */
async function seed(h: GitHome, project: string): Promise<void> {
  await initRepo(h, project, { 'src/app.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n", 'README.md': '# acme-api\n' }, { identity: ADA });
  await git(h, project, 'tag', 'v1.0');
  for (const [branch, file, subject] of [['feat/users-docs', 'docs/users.md', 'Document the /users endpoints'], ['feat/rate-limit', 'src/rate-limit.ts', 'Rate-limit the /login route'], ['team/ax/login-fix', 'src/login.ts', 'Fix the login redirect']] as const) {
    await git(h, project, 'switch', '--quiet', '-c', branch, 'main');
    write(project, file, `// ${subject}\n`);
    await git(h, project, 'add', '-A');
    await git(h, project, 'commit', '--quiet', '-m', subject);
  }
  await git(h, project, 'switch', '--quiet', 'main');
  write(project, 'src/app.ts', "import express from 'express';\nconst app = express();\napp.use(express.json());\napp.listen(3000);\n");
  await git(h, project, 'commit', '--quiet', '-am', 'Parse JSON bodies');
  await git(h, project, 'tag', '-a', 'v1.1', '-m', 'Release 1.1');
  await git(h, project, 'tag', 'release/v2.0-rc');
  write(project, 'src/app.ts', "import express from 'express';\nconst app = express();\napp.use(express.json());\napp.use(cors());\napp.listen(3000);\n");
  await git(h, project, 'stash', 'push', '-m', 'Allow CORS');
  write(project, 'src/middleware/audit.ts', 'export function audit() {}\n');
  await git(h, project, 'stash', 'push', '--include-untracked', '-m', 'Audit sketch');
  await git(h, project, 'worktree', 'add', '--quiet', '-b', 'hotfix/login', path.join(h.root, 'acme-api-hotfix'));
}

const repos = (shell: Page): Locator => shell.getByTestId('repositories-section');
const row = (shell: Page, kind: string, name: string): Locator => repos(shell).locator(`[data-testid="repositories-row"][data-kind="${kind}"][data-name=${cssString(name)}]`);

async function setExpanded(target: Locator, open: boolean): Promise<void> {
  if ((await target.getAttribute('aria-expanded')) !== String(open)) await target.getByTestId('repositories-twistie').click();
  await expect(target).toHaveAttribute('aria-expanded', String(open));
}

// Projects stays collapsed so Repositories fills the sidebar; the shell selects a project as its Projects row does.
async function selectProject(app: ElectronApplication, shell: Page, dir: string): Promise<void> {
  const key = (await shellState(app)).projects.find((project) => project.fsPath === dir)!.key;
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(key);
}

test('slice 11a captures', async ({ foreground: _foreground, home, launch }) => {
  const testInfo = test.info();
  await seed(home, home.project);
  const mono = path.join(home.root, 'mono');
  await initRepo(home, mono, { 'package.json': '{ "name": "mono" }\n' }, { identity: ADA });
  await initRepo(home, path.join(mono, 'ui'), { 'index.ts': 'export {};\n' }, { identity: ADA });
  const vendor = path.join(home.root, 'vendor-sdk');
  await initRepo(home, vendor, { 'sdk.ts': 'export {};\n' }, { identity: ADA });

  const { app } = await launch();
  await openProjectChat(app, mono);
  await openProjectChat(app, home.project);
  await addProject(app, vendor, false);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  await selectProject(app, shell, home.project);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'sidebar-chats', false);
  await setSection(shell, 'sidebar-projects', false);
  await setSection(shell, 'scm-section', true);
  await expect(shell.getByTestId('scm-branch')).toBeVisible({ timeout: 30_000 });
  const sidebar = shell.getByTestId('sidebar');

  const pass = async (theme: Theme, font: number, suffix = ''): Promise<void> => {
    await showShellTheme(app, theme);
    await setFont(app, font);
    const t = (name: string): string => `${name}-${theme}-${font}${suffix}`;
    await selectProject(app, shell, home.project);

    // Collapsed between Source control and Search, then expanded with its groups closed.
    await setSection(shell, 'repositories-section', false);
    await rest(shell);
    await shot(shell, testInfo, t('collapsed'), sidebar);
    await setSection(shell, 'repositories-section', true);
    for (const group of ['branches', 'stashes', 'tags', 'worktrees']) await setExpanded(row(shell, 'group', group), false);
    await rest(shell);
    await shot(shell, testInfo, t('single-groups'), sidebar);

    // Branches: the feat folder and the merged team/ax chain, main with the HEAD icon; then feat open.
    await setExpanded(row(shell, 'group', 'branches'), true);
    await expect(row(shell, 'branch', 'main')).toBeVisible();
    await rest(shell);
    await shot(shell, testInfo, t('branches'), repos(shell));
    await setExpanded(row(shell, 'folder', 'feat'), true);
    await setExpanded(row(shell, 'folder', 'team/ax'), true);
    await rest(shell);
    await shot(shell, testInfo, t('branches-folders'), repos(shell));
    await row(shell, 'branch', 'feat/rate-limit').click();
    await row(shell, 'branch', 'feat/rate-limit').hover();
    await shot(shell, testInfo, t('branch-hover-selected'), repos(shell));
    await row(shell, 'branch', 'feat/rate-limit').click({ button: 'right' });
    await expect(menuItem(overlay, 'compareRef')).toBeVisible();
    await windowShot(app, testInfo, t('menu-branch'));
    await menuItem(overlay, 'compareRef').click();
    await expect(quickPick(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('compare-picker'));
    await overlay.getByTestId('quick-pick-input').fill('main');
    await pickItem(overlay, 'main').click();
    const compare = shell.locator('[data-testid="changes-tab"][data-source="refs"]');
    await expect(compare).toBeVisible();
    await windowShot(app, testInfo, t('compare-tab'));
    await setExpanded(row(shell, 'group', 'branches'), false);

    // Stashes, with the group's Stash menu and a stash row's menu.
    await setExpanded(row(shell, 'group', 'stashes'), true);
    await expect(repos(shell).locator('[data-kind="stash"]')).toHaveCount(2);
    await rest(shell);
    await shot(shell, testInfo, t('stashes'), repos(shell));
    await row(shell, 'group', 'stashes').hover();
    await shot(shell, testInfo, t('group-hover'), repos(shell));
    await row(shell, 'group', 'stashes').getByTestId('repositories-action-stash').click();
    await expect(menuItem(overlay, 'stashIncludeUntracked')).toBeVisible();
    await windowShot(app, testInfo, t('menu-group-stash'));
    await dismiss(app, overlay, overlayMenu(overlay));
    await repos(shell).locator('[data-kind="stash"]').first().click({ button: 'right' });
    await expect(menuItem(overlay, 'applyStash')).toBeVisible();
    await windowShot(app, testInfo, t('menu-stash'));
    await dismiss(app, overlay, overlayMenu(overlay));
    await setExpanded(row(shell, 'group', 'stashes'), false);

    // Tags with a release folder, and a tag's menu.
    await setExpanded(row(shell, 'group', 'tags'), true);
    await setExpanded(row(shell, 'folder', 'release'), true);
    await rest(shell);
    await shot(shell, testInfo, t('tags'), repos(shell));
    await row(shell, 'tag', 'v1.1').click({ button: 'right' });
    await expect(menuItem(overlay, 'checkoutRefDetached')).toBeVisible();
    await windowShot(app, testInfo, t('menu-tag'));
    await dismiss(app, overlay, overlayMenu(overlay));
    await setExpanded(row(shell, 'group', 'tags'), false);

    // Worktrees: the main one first, then the linked one; hover shows Open with its tooltip, then its menu.
    await setExpanded(row(shell, 'group', 'worktrees'), true);
    const linked = repos(shell).locator('[data-kind="worktree"]').nth(1);
    await expect(linked).toBeVisible();
    await rest(shell);
    await shot(shell, testInfo, t('worktrees'), repos(shell));
    await linked.hover();
    await shot(shell, testInfo, t('worktree-hover'), repos(shell));
    await linked.click({ button: 'right' });
    await expect(menuItem(overlay, 'openWorktree')).toBeVisible();
    await windowShot(app, testInfo, t('menu-worktree'));
    await dismiss(app, overlay, overlayMenu(overlay));
    await setExpanded(row(shell, 'group', 'worktrees'), false);

    // mono: one row per repository; a repository's menu; Close on the nested one, then Reopen Closed Repositories in the title.
    await selectProject(app, shell, mono);
    await expect(row(shell, 'repo', 'ui')).toBeVisible({ timeout: 30_000 });
    await setExpanded(row(shell, 'repo', 'mono'), true);
    await rest(shell);
    await shot(shell, testInfo, t('multiple'), sidebar);
    await row(shell, 'repo', 'ui').click();
    await expect(shell.getByTestId('scm-repo-name')).toHaveText('ui');
    await row(shell, 'repo', 'ui').hover();
    await shot(shell, testInfo, t('multiple-selected-hover'), sidebar);
    await row(shell, 'repo', 'ui').click({ button: 'right' });
    await expect(menuItem(overlay, 'closeOtherRepositories')).toBeVisible();
    await windowShot(app, testInfo, t('menu-repository'));
    await menuItem(overlay, 'closeRepository').click();
    await expect(row(shell, 'repo', 'ui')).toHaveCount(0);
    await repos(shell).getByTestId('sidebar-section-header').hover();
    await expect(repos(shell).getByTestId('repositories-reopen-closed')).toBeVisible();
    await shot(shell, testInfo, t('reopen-closed-title'), sidebar);
    await repos(shell).getByTestId('repositories-reopen-closed').click();
    await expect(quickPick(overlay)).toBeVisible();
    await quickPick(overlay).getByTestId('quick-pick-item').filter({ hasText: path.join(mono, 'ui') }).click();
    await expect(row(shell, 'repo', 'ui')).toBeVisible();
    await setExpanded(row(shell, 'repo', 'mono'), false);

    // vendor-sdk is untrusted: the Repositories section's trust state.
    await selectProject(app, shell, vendor);
    await expect(repos(shell).getByTestId('scm-state')).toHaveAttribute('data-state', 'untrusted');
    await rest(shell);
    await shot(shell, testInfo, t('untrusted'), sidebar);
  };

  for (const theme of THEMES) {
    for (const font of FONTS) await pass(theme, font);
  }
  await setReducedMotion(app, true);
  for (const theme of THEMES) await pass(theme, FONTS[0], '-reduced');
  await setReducedMotion(app, false);
});
