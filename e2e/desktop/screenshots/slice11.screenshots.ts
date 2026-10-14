import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { git, initRepo, type GitHome } from '../support/git';
import { startGitHttpServer, type GitHttpServer } from '../support/git-http-server';
import { writeUserSettings } from '../support/hermetic';
import { menuItem, overlayMenu } from '../support/overlay';
import { moreActions, quickInput, scmSection, selectRepo, setSection, submenuItem, write } from '../support/scm';
import { dismiss, openProjectChat, setFont, setReducedMotion, shot, showShellTheme, THEMES, windowShot, type Theme } from '../support/screenshots';
import { closeSettingsModal, openSettingsModal, setContentSize } from '../support/settings';
import { overlayPage, shellPage } from '../support/shell';
import { clickSectionAction } from '../support/shell-ui';
import { answerOpenDialog } from '../support/ui';

// Review captures of slice 11 (remotes, sync, clone, askpass): Dark and Light, the 13px default and a 16px host font, and a
// reduced-motion pass. Every remote is a local bare repository or the test's own git http-backend, never the network.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;
// An obviously fake credential; the captures show it masked.
const USER = 'ada';
const PASSWORD = 'not-a-real-password';

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_200_000);

const ADA = { name: 'Ada Lovelace', email: 'ada@example.com' };

interface Remotes {
  // a clone of the project's origin that pushes the commits the project is behind by
  readonly upstreamWork: string;
  readonly open: GitHttpServer;
  readonly locked: GitHttpServer;
}

/**
 * The project (`alpha`, tracking the local bare origin `acme-api.git`, one commit ahead, with a staged change) and three
 * nested repositories: `web` with a remote but an unpublished `main`; `held`, tracking a repository on the open http server,
 * which the test holds to catch an operation mid-flight; `secure`, tracking one on the http server with basic auth, whose
 * push asks for credentials.
 */
async function seed(h: GitHome, project: string): Promise<Remotes> {
  const remotes = path.join(h.root, 'remotes');
  const served = path.join(h.root, 'served');
  const locked = path.join(h.root, 'locked');
  fs.mkdirSync(remotes, { recursive: true });

  await initRepo(h, project, { 'src/app.ts': "import express from 'express';\nconst app = express();\napp.listen(3000);\n", 'README.md': '# acme-api\n' }, { identity: ADA });
  const origin = path.join(remotes, 'acme-api.git');
  await git(h, h.root, 'clone', '--bare', project, origin);
  await git(h, project, 'remote', 'add', 'origin', origin);
  await git(h, project, 'fetch', 'origin');
  await git(h, project, 'branch', '--set-upstream-to=origin/main', 'main');
  const upstreamWork = path.join(h.root, 'upstream-work');
  await git(h, h.root, 'clone', origin, upstreamWork);
  await git(h, upstreamWork, 'config', 'user.name', 'Grace Hopper');
  await git(h, upstreamWork, 'config', 'user.email', 'grace@example.com');
  write(project, 'src/middleware/logger.ts', 'export function logger() {}\n');
  await git(h, project, 'add', '-A');
  await git(h, project, 'commit', '-m', 'Add the request logger');
  write(project, 'src/routes/users.ts', "export const users = '/users';\n");
  await git(h, project, 'add', 'src/routes/users.ts');

  const web = path.join(project, 'web');
  await initRepo(h, web, { 'index.html': '<!doctype html>\n' }, { identity: ADA });
  await git(h, h.root, 'init', '--bare', path.join(remotes, 'web.git'));
  await git(h, web, 'remote', 'add', 'origin', path.join(remotes, 'web.git'));

  fs.mkdirSync(served, { recursive: true });
  fs.mkdirSync(locked, { recursive: true });
  await git(h, h.root, 'clone', '--bare', project, path.join(served, 'acme-api.git'));
  const servers: GitHttpServer[] = [];
  try {
    const open = await startGitHttpServer({ root: served });
    servers.push(open);
    const lockedServer = await startGitHttpServer({ root: locked, user: USER, password: PASSWORD });
    servers.push(lockedServer);

    // Each served repository is a bare copy of its own working repository, so a pull is up to date and a push fast-forwards.
    for (const [name, root, url] of [['held', served, open.url('held.git')], ['secure', locked, lockedServer.url('secure.git')]] as const) {
      const dir = path.join(project, name);
      await initRepo(h, dir, { 'notes.md': `# ${name}\n` }, { identity: ADA });
      await git(h, h.root, 'clone', '--bare', dir, path.join(root, `${name}.git`));
      await git(h, dir, 'remote', 'add', 'origin', url);
      // The upstream is set without asking the server, so seeding needs no credentials.
      await git(h, dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      await git(h, dir, 'branch', '--set-upstream-to=origin/main', 'main');
      write(dir, 'notes.md', `# ${name}\n\n- rate limits\n`);
      await git(h, dir, 'commit', '-am', 'Note the rate limits');
    }
    return { upstreamWork, open, locked: lockedServer };
  } catch (err) {
    // the test closes them only once seed has returned them
    await Promise.all(servers.map((server) => server.close()));
    throw err;
  }
}

const dialog = (overlay: Page): Locator => overlay.getByRole('alertdialog');
const progress = (shell: Page, kind: string): Locator => shell.locator(`[data-testid="scm-progress"][data-kind="${kind}"]`);

type Thaw = { __thaw?: () => void };

/**
 * From now on, pauses each CSS animation whose name starts with one of `prefixes` at `ms` as it starts, for a mid-motion
 * frame: an animation shorter than the wait for its trigger would have ended before a later pause. A Vue transition's
 * animation cannot be held, since Vue ends the transition on its own timer.
 */
async function freezeAsTheyStart(page: Page, prefixes: readonly string[], ms: number): Promise<void> {
  await page.evaluate(([names, at]) => {
    const freeze = (event: AnimationEvent): void => {
      if (!names.some((name) => event.animationName.startsWith(name))) return;
      for (const animation of (event.target as Element).getAnimations()) {
        if (animation instanceof CSSAnimation && animation.animationName === event.animationName) {
          animation.pause();
          animation.currentTime = at;
        }
      }
    };
    document.addEventListener('animationstart', freeze);
    (window as Thaw).__thaw = () => document.removeEventListener('animationstart', freeze);
  }, [prefixes, ms] as const);
}

/** Each CSS animation whose name starts with one of `prefixes`, as `name:playState`, sorted. */
const animationsOf = (page: Page, prefixes: readonly string[]): Promise<string[]> => page.evaluate((names) => document.getAnimations()
  .flatMap((animation) => (animation instanceof CSSAnimation && names.some((name) => animation.animationName.startsWith(name)) ? [`${animation.animationName}:${animation.playState}`] : []))
  .sort(), prefixes);

async function finishAnimations(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) if (animation.effect?.getComputedTiming().endTime !== Infinity) animation.finish();
  });
}

test('slice 11 captures', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const remotes = await seed(home, home.project);
  const cloneParent = path.join(home.root, 'clones');
  fs.mkdirSync(cloneParent, { recursive: true });
  writeUserSettings(home, {
    'damocles.desktop.git.allowForcePush': true,
    'damocles.desktop.git.defaultCloneDirectory': cloneParent,
  });

  try {
    const { app } = await launch();
    // Clone asks for the parent folder in a picker that opens at defaultCloneDirectory
    await answerOpenDialog(app, cloneParent);
    await openProjectChat(app, home.project);
    await setContentSize(app, WIDTH, HEIGHT);
    const shell = await shellPage(app);
    const overlay = await overlayPage(app);
    const projectName = path.basename(home.project);
    await setSection(shell, 'files-section', false);
    await setSection(shell, 'scm-section', true);
    await expect(shell.getByTestId('scm-sync')).toBeVisible({ timeout: 30_000 });
    let upstreamCommits = 0;

    const pass = async (theme: Theme, font: number, suffix = ''): Promise<void> => {
      await showShellTheme(app, theme);
      await setFont(app, font);
      const t = (name: string): string => `${name}-${theme}-${font}${suffix}`;
      const sync = shell.getByTestId('scm-sync');

      // Counts: the upstream gains a commit, Fetch brings it in, and the behind count rolls up with its arrow lit.
      await selectRepo(shell, overlay, projectName);
      write(remotes.upstreamWork, 'CHANGELOG.md', `# Changelog\n\n${'- entry\n'.repeat(++upstreamCommits)}`);
      await git(home, remotes.upstreamWork, 'add', '-A');
      await git(home, remotes.upstreamWork, 'commit', '-m', `Changelog entry ${upstreamCommits}`);
      await git(home, remotes.upstreamWork, 'push', 'origin', 'main');
      await clickSectionAction(shell, 'scm-more-actions');
      await expect(overlayMenu(overlay)).toBeVisible();
      await windowShot(app, testInfo, t('menu-more-actions'));
      if (!suffix) await freezeAsTheyStart(shell, ['d-count', 'd-flash'], 110);
      await menuItem(overlay, 'fetch').click();
      await expect(shell.getByTestId('scm-sync-behind')).toHaveText(String(upstreamCommits));
      if (!suffix) {
        // the arrow's bump and glow held mid-motion; the number's roll and the Fetch row are over, so the rest is at rest
        await expect.poll(() => animationsOf(shell, ['d-swap', 'd-count', 'd-flash'])).toEqual(['d-count-bump:paused', 'd-flash:paused']);
        await expect(shell.locator('[data-testid="scm-progress"]')).toHaveCount(0);
        await shot(shell, testInfo, t('sync-counts-change'), scmSection(shell));
        await shell.evaluate(() => (window as Thaw).__thaw?.());
        await finishAnimations(shell);
      }
      await expect(sync).toHaveAttribute('data-mode', 'counts');
      // the Fetch row holds its check for a moment, then leaves; the counts capture shows the section at rest
      await expect(shell.locator('[data-testid="scm-progress"]')).toHaveCount(0);
      await shot(shell, testInfo, t('sync-counts'), scmSection(shell));

      // The Pull, Push and Remote submenus (force variants on), and the commit split button's menu.
      await clickSectionAction(shell, 'scm-more-actions');
      await menuItem(overlay, 'submenu:pullPush').click();
      await expect(submenuItem(overlay, 'pullPush:pushToForce')).toBeVisible();
      await windowShot(app, testInfo, t('menu-pull-push'));
      await menuItem(overlay, 'submenu:remote').hover();
      await expect(submenuItem(overlay, 'addRemote')).toBeVisible();
      await windowShot(app, testInfo, t('menu-remote'));
      await dismiss(app, overlay, overlayMenu(overlay));
      await shell.getByTestId('scm-commit-menu').click();
      await expect(menuItem(overlay, 'commitSync')).toBeVisible();
      await windowShot(app, testInfo, t('menu-commit-split'));
      await dismiss(app, overlay, overlayMenu(overlay));

      // Publish: the sync button and the commit box's Publish Branch on an unpublished branch with nothing to commit.
      await selectRepo(shell, overlay, 'web');
      await expect(sync).toHaveAttribute('data-mode', 'publish');
      await expect(shell.getByTestId('scm-publish')).toBeVisible();
      await shot(shell, testInfo, t('sync-publish'), scmSection(shell));

      // Sync against a held server: the confirmation, then the spinning arrows and "Syncing…" with Cancel, then Cancel.
      await selectRepo(shell, overlay, 'held');
      remotes.open.hold();
      await sync.click();
      await expect(dialog(overlay)).toBeVisible();
      await windowShot(app, testInfo, t('dialog-confirm-sync'));
      await dialog(overlay).getByRole('button', { name: 'OK', exact: true }).click();
      await expect(progress(shell, 'sync')).toBeVisible();
      await expect(sync).toHaveAttribute('aria-busy', 'true');
      await shot(shell, testInfo, t('progress-syncing'), scmSection(shell));
      await shell.getByTestId('scm-progress-cancel').click();
      await expect(progress(shell, 'sync')).toHaveCount(0);
      remotes.open.release();

      // Pull against the held server, then its success check once the server lets it through.
      remotes.open.hold();
      await moreActions(app, shell, 'pullPush:pull', 'pullPush');
      await expect(progress(shell, 'pull')).toBeVisible();
      await shot(shell, testInfo, t('progress-pulling'), scmSection(shell));
      remotes.open.release();
      await expect(progress(shell, 'pull')).toHaveAttribute('data-phase', 'done');
      await shot(shell, testInfo, t('progress-done'), scmSection(shell));
      await expect(progress(shell, 'pull')).toHaveCount(0);

      // Push to the server with basic auth: git asks for the username, then the password, in the quick input.
      await selectRepo(shell, overlay, 'secure');
      await moreActions(app, shell, 'push');
      await expect(quickInput(overlay)).toBeVisible();
      await expect(quickInput(overlay)).not.toHaveAttribute('data-password');
      await windowShot(app, testInfo, t('askpass-username'));
      await overlay.getByTestId('quick-input-field').fill(USER);
      await overlay.getByTestId('quick-input-field').press('Enter');
      await expect(quickInput(overlay)).toHaveAttribute('data-password', 'true');
      await overlay.getByTestId('quick-input-field').fill(PASSWORD);
      await windowShot(app, testInfo, t('askpass-password'));
      // Dismissing the password fails the push, and its row leaves with the danger tint.
      await dismiss(app, overlay, quickInput(overlay));
      await expect(progress(shell, 'push')).toHaveAttribute('data-phase', 'failed');
      await shot(shell, testInfo, t('progress-failed'), scmSection(shell));
      await expect(progress(shell, 'push')).toHaveCount(0);

      // Clone: the URL box, "Cloning acme-api…" while the server holds it, then the question whether to add it as a project.
      await moreActions(app, shell, 'clone');
      await expect(quickInput(overlay)).toBeVisible();
      await overlay.getByTestId('quick-input-field').fill(remotes.open.url('acme-api.git'));
      await windowShot(app, testInfo, t('clone-url'));
      remotes.open.hold();
      await overlay.getByTestId('quick-input-field').press('Enter');
      await expect(progress(shell, 'clone')).toBeVisible();
      await expect(progress(shell, 'clone')).toContainText('Cloning acme-api…');
      await shot(shell, testInfo, t('progress-cloning'), scmSection(shell));
      remotes.open.release();
      await expect(dialog(overlay)).toBeVisible({ timeout: 30_000 });
      await windowShot(app, testInfo, t('dialog-open-clone'));
      await dismiss(app, overlay, dialog(overlay));
      fs.rmSync(path.join(cloneParent, 'acme-api'), { recursive: true, force: true });

      // Settings › Source control: the fetch and sync rows, then the clone rows.
      const settings = await openSettingsModal(app, 'sourceControl');
      await setFont(app, font);
      await shot(settings, testInfo, t('settings-fetch-sync'));
      await settings.getByTestId('settings-row-damocles.desktop.git.openAfterClone').scrollIntoViewIfNeeded();
      await shot(settings, testInfo, t('settings-clone'));
      await closeSettingsModal(settings);
    };

    for (const theme of THEMES) {
      for (const font of FONTS) await pass(theme, font);
    }
    await setReducedMotion(app, true);
    for (const theme of THEMES) await pass(theme, FONTS[0], '-reduced');
    await setReducedMotion(app, false);
  } finally {
    await remotes.open.close();
    await remotes.locked.close();
  }
});
