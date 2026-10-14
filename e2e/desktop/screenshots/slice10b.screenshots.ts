import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { git, initRepo, type GitHome } from '../support/git';
import { writeUserSettings } from '../support/hermetic';
import { menuItem, overlayMenu } from '../support/overlay';
import { quickPick } from '../support/editor';
import { commitMessage, quickInput, scmSection, selectRepo, setSection, submenuItem, write } from '../support/scm';
import { dismiss, openProjectChat, saveScreenshot, setFont, setReducedMotion, shot, showShellTheme, THEMES, windowShot, type Theme } from '../support/screenshots';
import { closeSettingsModal, openSettingsModal, setContentSize } from '../support/settings';
import { overlayPage, pressKeys, PRIMARY, shellPage } from '../support/shell';
import { clickSectionAction } from '../support/shell-ui';

// Review captures of the commit variants: Dark and Light, the 13px default and a 16px host font, and a reduced-motion pass.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;

test.describe.configure({ mode: 'serial' });
test.setTimeout(900_000);

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };

/**
 * The project: `main` (protected) with staged and unstaged changes; `merging` stopped on a merge conflict; `unstaged`, whose
 * changes are all unstaged, for the smart-commit question; `history` on `develop`, which the test commits in twice for Up.
 */
async function seed(h: GitHome, project: string): Promise<void> {
  await initRepo(h, project, {
    'src/app.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n",
    'src/routes/auth.ts': "export const login = '/login';\n",
    'README.md': '# acme-api\n',
  }, { identity: ADA });
  await git(h, project, 'commit', '--allow-empty', '-m', 'Add rate limiting to POST /login');
  const merging = path.join(project, 'merging');
  await initRepo(h, merging, { 'src/app.ts': 'app.listen(3000);\n' }, { identity: ADA });
  await git(h, merging, 'checkout', '-b', 'feat/users-docs');
  write(merging, 'src/app.ts', 'app.listen(env.PORT ?? 3000);\n');
  await git(h, merging, 'commit', '-am', 'Read the port from env');
  await git(h, merging, 'checkout', 'main');
  write(merging, 'src/app.ts', 'app.listen(8080);\n');
  await git(h, merging, 'commit', '-am', 'Move to 8080');
  await git(h, merging, 'merge', 'feat/users-docs').then(() => { throw new Error('the merge did not stop on a conflict'); }, () => undefined);
  const unstaged = path.join(project, 'unstaged');
  await initRepo(h, unstaged, { 'notes.md': '# Notes\n' }, { branch: 'develop', identity: ADA });
  write(unstaged, 'notes.md', '# Notes\n\n- rate limits\n');
  await initRepo(h, path.join(project, 'history'), { 'CHANGELOG.md': '# Changelog\n' }, { branch: 'develop', identity: ADA });
  write(project, 'src/app.ts', "import express from 'express';\nimport { rateLimit } from 'express-rate-limit';\nconst app = express();\napp.use(rateLimit({ limit: 5 }));\napp.listen(3000);\n");
  write(project, 'src/middleware/logger.ts', 'export function logger() {}\n');
  await git(h, project, 'add', 'src/middleware/logger.ts', 'src/app.ts');
  write(project, 'src/routes/users.ts', "export const users = '/users';\n");
}

const dialog = (overlay: Page): Locator => overlay.getByRole('alertdialog');

/** Runs a palette command: its title typed after ">", then its row clicked. */
async function runCommand(app: ElectronApplication, id: string, title: string): Promise<void> {
  const overlay = await overlayPage(app);
  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(`>${title}`);
  await overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`).click();
  await expect(quickPick(overlay)).toHaveCount(0);
}

test('slice 10b captures', async ({ foreground: _foreground, home, launch }, testInfo) => {
  await seed(home, home.project);
  writeUserSettings(home, {
    'damocles.desktop.git.branchProtection': ['main'],
    'damocles.desktop.git.branchPrefix': 'feature/',
    'damocles.desktop.git.allowNoVerifyCommit': true,
  });

  const { app } = await launch();
  await openProjectChat(app, home.project);
  await setContentSize(app, WIDTH, HEIGHT);
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  const projectName = path.basename(home.project);
  await setSection(shell, 'files-section', false);
  await setSection(shell, 'scm-section', true);
  await expect(shell.locator('[data-testid="scm-group"][data-group="index"]')).toBeVisible({ timeout: 30_000 });

  // Two commits in `history`, so Up has messages to recall.
  await selectRepo(shell, overlay, 'history');
  for (const [file, text] of [['CHANGELOG.md', 'Document the rate limits'], ['NOTES.md', 'Add the request id middleware\n\nEvery response carries X-Request-Id.']] as const) {
    write(path.join(home.project, 'history'), file, `${text}\n`);
    await git(home, path.join(home.project, 'history'), 'add', '-A');
    await expect(shell.locator('[data-testid="scm-group"][data-group="index"]')).toBeVisible();
    await commitMessage(shell).fill(text);
    await shell.getByTestId('scm-commit').click();
    await expect(commitMessage(shell)).toHaveValue('');
  }

  const pass = async (theme: Theme, font: number, suffix = ''): Promise<void> => {
    await showShellTheme(app, theme);
    await setFont(app, font);
    const t = (name: string): string => `${name}-${theme}-${font}${suffix}`;
    const commitButton = shell.getByTestId('scm-commit');
    await selectRepo(shell, overlay, projectName);

    // The split button with "Commit", ready, and its menu open.
    await commitMessage(shell).fill('Add rate limiting to POST /login');
    await shot(shell, testInfo, t('commit-split-commit'), scmSection(shell));
    await shell.getByTestId('scm-commit-menu').click();
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('commit-menu'));

    // Amend mode: the banner and "Commit (Amend)", then the menu whose items all amend; cancel restores the draft.
    await menuItem(overlay, 'toggleAmend').click();
    await expect(shell.getByTestId('scm-amend-banner')).toBeVisible();
    await expect(commitButton).toContainText('Commit (Amend)');
    await shot(shell, testInfo, t('commit-amend'), scmSection(shell));
    await shell.getByTestId('scm-commit-menu').click();
    await expect(overlayMenu(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('commit-menu-amend'));
    await dismiss(app, overlay, overlayMenu(overlay));
    await shell.getByTestId('scm-amend-cancel').click();
    await expect(shell.getByTestId('scm-amend-banner')).toHaveCount(0);
    await expect(commitMessage(shell)).toHaveValue('Add rate limiting to POST /login');

    // Commit › with the No Verify items (allowNoVerifyCommit is on).
    await clickSectionAction(shell, 'scm-more-actions');
    await expect(overlayMenu(overlay)).toBeVisible();
    await menuItem(overlay, 'submenu:commit').click();
    await expect(submenuItem(overlay, 'commitNoVerify')).toBeVisible();
    await windowShot(app, testInfo, t('commit-submenu-no-verify'));

    // The No Verify question.
    await submenuItem(overlay, 'commitNoVerify').click();
    await expect(dialog(overlay)).toBeVisible();
    await windowShot(app, testInfo, t('dialog-no-verify'));
    await dismiss(app, overlay, dialog(overlay));

    // The protected-branch question, then Commit to a New Branch's name box: prefilled, valid, and invalid.
    await expect(commitMessage(shell)).toHaveValue('Add rate limiting to POST /login');
    await commitButton.click();
    await expect(dialog(overlay)).toContainText('protected branch');
    await windowShot(app, testInfo, t('dialog-protected-branch'));
    await dialog(overlay).getByRole('button', { name: 'Commit to a New Branch' }).click();
    await expect(quickInput(overlay)).toBeVisible();
    const field = overlay.getByTestId('quick-input-field');
    await expect(field).toHaveValue('feature/');
    await windowShot(app, testInfo, t('quick-input-prefilled'));
    await field.press('End');
    await field.pressSequentially('rate-limit');
    await windowShot(app, testInfo, t('quick-input-valid'));
    await field.pressSequentially('..lock');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await windowShot(app, testInfo, t('quick-input-invalid'));
    await dismiss(app, overlay, quickInput(overlay));

    // Commit Merge in the merge in progress.
    await selectRepo(shell, overlay, 'merging');
    await expect(commitButton).toContainText('Commit Merge');
    await shot(shell, testInfo, t('commit-split-merge'), scmSection(shell));

    // The smart-commit question, in the repository with only unstaged changes.
    await selectRepo(shell, overlay, 'unstaged');
    await commitMessage(shell).fill('Note the rate limits');
    await commitButton.click();
    await expect(dialog(overlay)).toContainText('There are no staged changes to commit');
    await windowShot(app, testInfo, t('dialog-smart-commit'));
    await dismiss(app, overlay, dialog(overlay));

    // The empty-commit question from the palette, for the same box.
    await runCommand(app, 'damocles.git.commitEmpty', 'Git: Commit Empty');
    await expect(dialog(overlay)).toContainText('empty commit');
    await windowShot(app, testInfo, t('dialog-empty-commit'));
    await dismiss(app, overlay, dialog(overlay));
    await commitMessage(shell).fill('');

    // History: Up in the empty box recalls the last message; a mid-swap frame, then at rest.
    await selectRepo(shell, overlay, 'history');
    await commitMessage(shell).focus();
    await commitMessage(shell).press('ArrowUp');
    if (!suffix) {
      await shell.evaluate(() => {
        for (const animation of document.getAnimations()) {
          if (animation instanceof CSSAnimation && animation.animationName.startsWith('d-msg-')) {
            animation.pause();
            animation.currentTime = 70;
          }
        }
      });
      await saveScreenshot(shell, testInfo, t('commit-history-swap'), scmSection(shell));
      await shell.evaluate(() => {
        for (const animation of document.getAnimations()) animation.finish();
      });
    }
    await expect(commitMessage(shell)).toHaveValue(/Every response carries X-Request-Id/);
    await shot(shell, testInfo, t('commit-history'), scmSection(shell));
    await commitMessage(shell).fill('');

    // Settings › Source control: the top, then the commit rows.
    const settings = await openSettingsModal(app, 'sourceControl');
    await setFont(app, font);
    await shot(settings, testInfo, t('settings-source-control'));
    await settings.getByTestId('settings-row-damocles.desktop.git.branchPrefix').scrollIntoViewIfNeeded();
    await shot(settings, testInfo, t('settings-source-control-commit'));
    await closeSettingsModal(settings);
  };

  for (const theme of THEMES) {
    for (const font of FONTS) await pass(theme, font);
  }
  await setReducedMotion(app, true);
  for (const theme of THEMES) await pass(theme, FONTS[0], '-reduced');
  await setReducedMotion(app, false);
});
