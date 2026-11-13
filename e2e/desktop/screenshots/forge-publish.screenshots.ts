import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, TestInfo } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn, trustForGit } from '../support/forge';
import { expect, test } from '../support/fixtures';
import { git } from '../support/git';
import type { HermeticHome } from '../support/hermetic';
import { bareRepo, openScmProject } from '../support/scm';
import { overlayPage, shellPage } from '../support/shell';
import { saveScreenshot, setPageSize, settled, showTheme, THEMES, windowShot } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { clickMenu } from '../support/ui';

// Visual parity captures of publish and of fork on a denied push at the design's checked widths, in both themes,
// against the forge stub: the design's states default, fork, upstream-exists and error (a refused name), and the timeline's
// running, failed and done states it draws in place.

const WIDTHS = [390, 768, 1280] as const;

/** Each width and theme, named `${name}-${width}-${theme}`: the window at 768 and 1280 px, the overlay alone emulated at 390 px. */
async function everyWidth(app: ElectronApplication, testInfo: TestInfo, name: string): Promise<void> {
  const overlay = await overlayPage(app);
  for (const width of WIDTHS) {
    const emulated = width < 768;
    if (emulated) await setPageSize(overlay, width, 900);
    else await setContentSize(app, width, 900);
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      await settled(overlay);
      if (emulated) await saveScreenshot(overlay, testInfo, `${name}-${width}-${theme}`);
      else await windowShot(app, testInfo, `${name}-${width}-${theme}`);
    }
    if (emulated) await (await overlay.context().newCDPSession(overlay)).send('Emulation.clearDeviceMetricsOverride');
  }
}

/** A repository at `dir` with one commit on main and no remote. */
async function localRepo(home: HermeticHome, dir: string): Promise<void> {
  fs.mkdirSync(dir, { recursive: true });
  await git(home, dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# damocles\n');
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '-m', 'Initial commit');
}

test('publish and fork in Dark and Light at 390, 768 and 1280 px', async ({ home, launch }, testInfo: TestInfo) => {
  test.setTimeout(1_200_000);
  const gitRoot = path.join(home.root, 'served');
  fs.mkdirSync(gitRoot, { recursive: true });
  const started = await startStubOnTestCa(home, { gitRoot });
  const { stub } = started;
  trustForGit(home, started.caFile);
  try {
    const { app } = await launchReady(launch, forgeEnv(started));
    await setContentSize(app, 1280, 900);

    // the design's three accounts: the self-managed GitLab (gitlab.indigital.gr's stand-in), gitlab.com and github.com
    let indigital = '';
    await inAccounts(app, async (accounts) => {
      indigital = await addGitlabServer(accounts, stub.indigital);
      await tokenSignIn(accounts, indigital, 'glpat-stubIndigitalAstefApi00006', 'astefanopoulos');
      await tokenSignIn(accounts, 'gitlab.com', 'glpat-stubAlexiosSApi000000008', 'alexios-s');
      await tokenSignIn(accounts, 'github.com', 'ghp_stubAstefanopoulosRepo0000000001', 'astefanopoulos');
    });

    // default: the design's own pick, grp on the self-managed server
    await localRepo(home, path.join(home.root, 'projects', 'damocles'));
    await openScmProject(app, path.join(home.root, 'projects', 'damocles'));
    const overlay = await overlayPage(app);
    await clickMenu(app, 'damocles.git.publish');
    const publish = overlay.getByRole('dialog', { name: 'Publish damocles', exact: true });
    await expect(publish).toBeVisible({ timeout: 30_000 });
    await overlay.getByLabel('Owner', { exact: true }).selectOption(`${indigital}|astefanopoulos|grp`);
    await everyWidth(app, testInfo, 's8-default');

    // error: the server refuses the name
    await overlay.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(overlay.getByTestId('forge-publish-refusal')).toBeVisible({ timeout: 60_000 });
    await everyWidth(app, testInfo, 's8-error');

    // the publish runs and is done
    await overlay.getByLabel('Name', { exact: true }).fill('damocles-desktop');
    await overlay.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(overlay.getByText(`Published ${indigital}/grp/damocles-desktop. This project now uses astefanopoulos on ${indigital}.`, { exact: true })).toBeVisible({ timeout: 60_000 });
    await everyWidth(app, testInfo, 's8-publish-done');
    await overlay.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(overlay.getByTestId('forge-publish')).toHaveCount(0);

    // fork: grp/damocles, which astefanopoulos reads but cannot push to
    stub.indigital.enforcePushAccess = true;
    const deniedClone = async (repoPath: string, dir: string): Promise<void> => {
      const upstream = await bareRepo(home, path.join(gitRoot, ...path.posix.dirname(repoPath).split('/')), path.posix.basename(repoPath), { 'README.md': '# damocles\n' });
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await git(home, path.dirname(dir), 'clone', '--quiet', upstream, dir);
      await git(home, dir, 'remote', 'set-url', 'origin', `${stub.indigital.webUrl}/${repoPath}.git`);
      await git(home, dir, 'checkout', '-b', 'fix/token-refresh');
      fs.writeFileSync(path.join(dir, 'token.ts'), 'export const refresh = true;\n');
      await git(home, dir, 'add', '-A');
      await git(home, dir, 'commit', '-m', 'Refresh the token');
      await openScmProject(app, dir);
    };
    const askFork = async (repoPath: string, pickOrigin: boolean): Promise<Locator> => {
      await clickMenu(app, 'damocles.git.publish');
      if (pickOrigin) await overlay.getByRole('option', { name: /^origin, / }).click();
      const ask = overlay.getByRole('alertdialog', { name: `You can't push to ${repoPath}` });
      await expect(ask).toBeVisible({ timeout: 60_000 });
      return ask;
    };
    const dir = path.join(home.root, 'forks', 'damocles');
    await deniedClone('grp/damocles', dir);
    const progress = overlay.getByRole('dialog', { name: 'Forking grp/damocles', exact: true });

    let ask = await askFork('grp/damocles', false);
    await everyWidth(app, testInfo, 's8-fork');
    await ask.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(ask).toHaveCount(0);

    // upstream-exists: a remote named upstream is there already
    await git(home, dir, 'remote', 'add', 'upstream', `${stub.indigital.webUrl}/grp/platform/intranet.git`);
    ask = await askFork('grp/damocles', true);
    await expect(ask.getByText('This repository already has a remote named upstream. Damocles names the original upstream-2 and leaves yours as it is.', { exact: true })).toBeVisible();
    await everyWidth(app, testInfo, 's8-upstream-exists');

    // failed: the server fails the fork, and the failure box shows under the fork step
    stub.indigital.failFork = true;
    await ask.getByRole('button', { name: 'Fork and Push', exact: true }).click();
    await expect(progress.getByRole('alert')).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's8-fork-failed');
    await progress.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(progress).toHaveCount(0);

    // done: the remotes table and Open Merge Request
    stub.indigital.failFork = false;
    stub.indigital.forkPolls = 1;
    ask = await askFork('grp/damocles', true);
    await ask.getByRole('button', { name: 'Fork and Push', exact: true }).click();
    const done = overlay.getByRole('dialog', { name: 'Pushed to your fork', exact: true });
    await expect(done).toBeVisible({ timeout: 90_000 });
    await everyWidth(app, testInfo, 's8-fork-done');
    await done.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(done).toHaveCount(0);

    // running: another read-only repository whose copy never finishes while the captures run; Cancel then stops it
    stub.indigital.projectAccess.set('grp/tools', new Map([['astefanopoulos', 20]]));
    await deniedClone('grp/tools', path.join(home.root, 'forks', 'tools'));
    ask = await askFork('grp/tools', false);
    stub.indigital.forkPolls = 1000;
    await ask.getByRole('button', { name: 'Fork and Push', exact: true }).click();
    const running = overlay.getByRole('dialog', { name: 'Forking grp/tools', exact: true });
    await expect(running.getByText(`Waiting for ${indigital} to copy the repository`, { exact: true })).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's8-fork-running');
    await running.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(running).toHaveCount(0);
  } finally {
    await stub.close();
  }
});
