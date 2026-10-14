import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { git, initRepo, type GitHome } from '../support/git';
import { quickPick } from '../support/editor';
import { menuItem, overlayMenu } from '../support/overlay';
import { pickItem, scmSection, setSection, submenuItem, write } from '../support/scm';
import { dismiss, openProjectChat, rest, setFont, setReducedMotion, shot, showShellTheme, THEMES, windowShot, type Theme } from '../support/screenshots';
import { closeSettingsModal, openSettingsModal, setContentSize, settingsRow } from '../support/settings';
import { overlayPage, shellPage } from '../support/shell';
import { clickSectionAction } from '../support/shell-ui';
import { answerOpenDialog } from '../support/ui';

// Review captures of slice 11b (branches, stash, tags, worktrees, the section header rule): Dark and Light, the 13px default
// and a 16px host font, and a reduced-motion pass. Every remote is a local bare repository, never the network.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;
const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_200_000);

/**
 * The project (`alpha`): `main` tracking the local bare origin `acme-api.git` with `feat/users` and `release` on the
 * remote, the local branches `draft` (never published) and `experiment` (one commit main lacks), tags `v1.0` and `v1.1`,
 * and a linked worktree `acme-api-hotfix` holding an untracked file, so deleting it asks.
 */
async function seed(h: GitHome, project: string): Promise<string> {
  await initRepo(h, project, { 'src/app.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n", 'README.md': '# acme-api\n' }, { identity: ADA });
  const remotes = path.join(h.root, 'remotes');
  fs.mkdirSync(remotes, { recursive: true });
  const origin = path.join(remotes, 'acme-api.git');
  await git(h, h.root, 'clone', '--quiet', '--bare', project, origin);
  await git(h, project, 'remote', 'add', 'origin', origin);
  await git(h, project, 'push', '--quiet', 'origin', 'main:feat/users', 'main:release');
  await git(h, project, 'fetch', '--quiet', 'origin');
  await git(h, project, 'branch', '--set-upstream-to=origin/main', 'main');
  await git(h, project, 'tag', 'v1.0');
  await git(h, project, 'tag', '-a', 'v1.1', '-m', 'Release 1.1');
  await git(h, project, 'branch', 'draft');
  await git(h, project, 'switch', '--quiet', '-c', 'experiment');
  write(project, 'src/experiment.ts', 'export const experiment = true;\n');
  await git(h, project, 'add', '-A');
  await git(h, project, 'commit', '--quiet', '-m', 'Try an experiment');
  await git(h, project, 'switch', '--quiet', 'main');
  const hotfix = path.join(h.root, 'acme-api-hotfix');
  await git(h, project, 'worktree', 'add', '--quiet', '-b', 'hotfix/login', hotfix);
  write(hotfix, 'notes.md', '# hotfix\n');
  return hotfix;
}

/** Two stashes, the newer on a branch with untracked files, made as a terminal would. */
async function makeStashes(h: GitHome, project: string): Promise<void> {
  write(project, 'src/app.ts', "import express from 'express';\nconst app = express();\napp.use(express.json());\napp.listen(3000);\n");
  await git(h, project, 'stash', 'push', '-m', 'Parse JSON bodies');
  write(project, 'src/middleware/rate-limit.ts', 'export function rateLimit() {}\n');
  write(project, 'README.md', '# acme-api\n\nRate limits apply.\n');
  await git(h, project, 'stash', 'push', '--include-untracked', '-m', 'Rate limit sketch');
}

const dialog = (overlay: Page): Locator => overlay.getByRole('alertdialog');

async function openSubmenu(shell: Page, overlay: Page, submenu: string, firstItem: string): Promise<void> {
  if ((await overlayMenu(overlay).count()) === 0) {
    await clickSectionAction(shell, 'scm-more-actions');
    await expect(overlayMenu(overlay)).toBeVisible();
  }
  await menuItem(overlay, `submenu:${submenu}`).click();
  await expect(submenuItem(overlay, firstItem)).toBeVisible();
}

test('slice 11b captures', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const hotfix = await seed(home, home.project);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'scm-section', true);
  await expect(shell.getByTestId('scm-branch')).toBeVisible({ timeout: 30_000 });
  const sidebar = shell.getByTestId('sidebar');

  const pass = async (theme: Theme, font: number, suffix = ''): Promise<void> => {
    await showShellTheme(app, theme);
    await setFont(app, font);
    const t = (name: string): string => `${name}-${theme}-${font}${suffix}`;

    // Section headers: at rest every title reads in full; hovering or focusing a header shows its section's actions.
    await rest(shell);
    await expect(scmSection(shell).getByTestId('sidebar-section-actions')).toBeHidden();
    await shot(shell, testInfo, t('headers-rest'), sidebar);
    await scmSection(shell).getByTestId('sidebar-section-header').hover();
    await expect(scmSection(shell).getByTestId('sidebar-section-actions')).toBeVisible();
    await shot(shell, testInfo, t('headers-hover'), sidebar);
    await rest(shell);
    await shell.getByTestId('sidebar-chats').locator('h2 button').focus();
    await shell.keyboard.press('Tab');
    await shot(shell, testInfo, t('headers-keyboard'), sidebar);
    await rest(shell);

    // The branch button published, then on a branch never published, with its "local" marker.
    await expect(shell.getByTestId('scm-branch-label')).toHaveText('main');
    await shot(shell, testInfo, t('branch-published'), scmSection(shell));
    await git(home, home.project, 'switch', '--quiet', 'draft');
    await expect(shell.getByTestId('scm-branch-local')).toBeVisible();
    await shot(shell, testInfo, t('branch-local'), scmSection(shell));
    await git(home, home.project, 'switch', '--quiet', 'main');
    await expect(shell.getByTestId('scm-branch-local')).toHaveCount(0);

    // The branch picker: create, create from, detached, then local branches, remote branches and tags.
    await shell.getByTestId('scm-branch').click();
    await expect(pickItem(overlay, 'v1.1')).toBeAttached();
    await windowShot(app, testInfo, t('branch-picker'));
    await overlay.getByTestId('quick-pick-input').fill('feat');
    await expect(pickItem(overlay, 'origin/feat/users')).toBeVisible();
    await windowShot(app, testInfo, t('branch-picker-filtered'));
    // The text typed echoed on the create items, which name the new branch after it.
    await overlay.getByTestId('quick-pick-input').fill('fix login');
    await expect(pickItem(overlay, 'Create new branch...')).toContainText('\u201cfix login\u201d');
    await windowShot(app, testInfo, t('branch-picker-echo'));
    await shot(overlay, testInfo, t('branch-picker-echo-close'), quickPick(overlay));
    await dismiss(app, overlay, quickPick(overlay));

    // Each submenu of More Actions.
    await openSubmenu(shell, overlay, 'branch', 'merge');
    await windowShot(app, testInfo, t('menu-branch'));
    await openSubmenu(shell, overlay, 'stash', 'stash');
    await windowShot(app, testInfo, t('menu-stash'));
    await openSubmenu(shell, overlay, 'tags', 'createTag');
    await windowShot(app, testInfo, t('menu-tags'));
    await openSubmenu(shell, overlay, 'worktrees', 'createWorktree');
    await windowShot(app, testInfo, t('menu-worktrees'));
    // the first Escape closes the open submenu, the second the menu
    await overlay.keyboard.press('Escape');
    await dismiss(app, overlay, overlayMenu(overlay));

    // The Stashes group empty, then filled by two stashes made in a terminal.
    await expect(scmSection(shell).getByTestId('scm-stash-note')).toHaveText('No stashes.');
    await rest(shell);
    await shot(shell, testInfo, t('stashes-empty'), scmSection(shell));
    // Stash › with no stashes: each picker says why it is off, the hovered one too.
    await openSubmenu(shell, overlay, 'stash', 'stash');
    await expect(submenuItem(overlay, 'stashPopLatest').getByTestId('overlay-menu-reason')).toHaveText('No stashes');
    await windowShot(app, testInfo, t('menu-stash-disabled'));
    await submenuItem(overlay, 'stashPopLatest').hover();
    await shot(overlay, testInfo, t('menu-stash-disabled-hover'), overlay.getByTestId('overlay-submenu'));
    await overlay.keyboard.press('Escape');
    await dismiss(app, overlay, overlayMenu(overlay));
    await makeStashes(home, home.project);
    await expect(scmSection(shell).getByTestId('scm-stash')).toHaveCount(2);
    await rest(shell);
    await shot(shell, testInfo, t('stashes-filled'), scmSection(shell));
    await scmSection(shell).getByTestId('scm-stash').first().hover();
    await shot(shell, testInfo, t('stashes-row-hover'), scmSection(shell));
    await scmSection(shell).getByTestId('scm-stash').first().click({ button: 'right' });
    await expect(menuItem(overlay, 'applyStash')).toBeVisible();
    await windowShot(app, testInfo, t('menu-stash-row'));
    await dismiss(app, overlay, overlayMenu(overlay));

    // View Stash: the multi-file diff tab with Apply Stash and Drop Stash in its title.
    await scmSection(shell).getByTestId('scm-stash').first().click();
    const tab = shell.locator('[data-testid="changes-tab"][data-source="stash"]');
    await expect(tab.getByTestId('changes-stash-apply')).toBeVisible();
    await expect(tab.getByTestId('changes-stash-pop')).toBeVisible();
    await windowShot(app, testInfo, t('view-stash'));
    await tab.getByTestId('changes-stash-pop').hover();
    await shot(shell, testInfo, t('view-stash-actions'), tab.getByTestId('changes-count').locator('..'));
    await tab.getByTestId('changes-stash-drop').click();
    await expect(dialog(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('dialog-drop-stash'));
    await dismiss(app, overlay, dialog(overlay));
    await git(home, home.project, 'stash', 'clear');
    await expect(tab).toHaveCount(0);

    // The forced deletes always ask first, Cancel focused: an unmerged branch, then a worktree with changes.
    await clickSectionAction(shell, 'scm-more-actions');
    await menuItem(overlay, 'submenu:branch').click();
    await submenuItem(overlay, 'deleteBranch').click();
    await overlay.getByTestId('quick-pick-input').fill('experiment');
    await pickItem(overlay, 'experiment').click();
    await expect(dialog(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('dialog-delete-unmerged'));
    await dismiss(app, overlay, dialog(overlay));
    await clickSectionAction(shell, 'scm-more-actions');
    await menuItem(overlay, 'submenu:worktrees').click();
    await submenuItem(overlay, 'deleteWorktree').click();
    await overlay.getByTestId('quick-pick-input').fill(path.basename(hotfix));
    await pickItem(overlay, path.basename(hotfix)).click();
    await expect(dialog(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('dialog-delete-dirty-worktree'));
    await dismiss(app, overlay, dialog(overlay));

    // Create Worktree's path box with its folder button, then the button focused, then the path it picked.
    await clickSectionAction(shell, 'scm-more-actions');
    await menuItem(overlay, 'submenu:worktrees').click();
    await submenuItem(overlay, 'createWorktree').click();
    await overlay.getByTestId('quick-pick-input').fill('ui polish');
    await pickItem(overlay, 'Create new branch...').click();
    const box = overlay.getByTestId('quick-input-field');
    await expect(box).toHaveValue('ui-polish');
    await box.press('Enter');
    await expect(overlay.getByTestId('quick-input-browse')).toBeVisible();
    // the name box has left, so the field is the path box's
    await expect(overlay.getByTestId('quick-input')).toHaveCount(1);
    await windowShot(app, testInfo, t('worktree-path-browse'));
    await box.press('Tab');
    await expect(overlay.getByTestId('quick-input-browse')).toBeFocused();
    await shot(overlay, testInfo, t('worktree-path-browse-focus'), overlay.getByTestId('quick-input'));
    await answerOpenDialog(app, path.join(home.root, 'trees'));
    await overlay.getByTestId('quick-input-browse').click();
    await expect(box).toHaveValue(path.join(home.root, 'trees', 'ui-polish'));
    await shot(overlay, testInfo, t('worktree-path-picked'), overlay.getByTestId('quick-input'));
    await dismiss(app, overlay, overlay.getByTestId('quick-input'));

    // Settings: Pull before checkout and Save files before stash in Source control, Always show section actions in Appearance.
    const settings = await openSettingsModal(app, 'sourceControl');
    await setFont(app, font);
    await settingsRow(settings, 'damocles.desktop.git.pullBeforeCheckout').scrollIntoViewIfNeeded();
    await shot(settings, testInfo, t('settings-pull-before-checkout'));
    await settingsRow(settings, 'damocles.desktop.git.promptToSaveFilesBeforeStash').scrollIntoViewIfNeeded();
    await shot(settings, testInfo, t('settings-save-before-stash'));
    await settings.getByTestId('settings-nav-appearance').click();
    await expect(settingsRow(settings, 'damocles.desktop.sidebar.alwaysShowHeaderActions')).toBeVisible();
    await shot(settings, testInfo, t('settings-always-show-actions'));
    await closeSettingsModal(settings);
  };

  for (const theme of THEMES) {
    for (const font of FONTS) await pass(theme, font);
  }
  await setReducedMotion(app, true);
  for (const theme of THEMES) await pass(theme, FONTS[0], '-reduced');
  await setReducedMotion(app, false);
});
