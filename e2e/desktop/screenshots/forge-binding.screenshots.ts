import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn } from '../support/forge';
import { expect, test } from '../support/fixtures';
import { git, initRepo } from '../support/git';
import type { HermeticHome } from '../support/hermetic';
import { overlayMenu, readyOverlay } from '../support/overlay';
import { clickAccountChip, openScmProject, scmSection } from '../support/scm';
import { saveScreenshot, setPageSize, settled, showTheme, THEMES, windowShot } from '../support/screenshots';
import { closeSettingsModal, openSettingsModal, setContentSize } from '../support/settings';
import { shellPage } from '../support/shell';
import { clickMenu } from '../support/ui';

// Visual parity captures of the account chip and its menu, the Choose account dialog and Remote hosts' default accounts at
// the design's checked widths, in both themes. The stub's self-managed GitLab stands for gitlab.indigital.gr.

const WIDTHS = [390, 768, 1280] as const;
const GITLAB = 'gitlab.com';

async function project(home: HermeticHome, name: string, remotes: Readonly<Record<string, string>>): Promise<string> {
  const dir = path.join(home.root, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  await initRepo(home, dir);
  for (const [remote, url] of Object.entries(remotes)) await git(home, dir, 'remote', 'add', remote, url);
  await git(home, dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(home, dir, 'branch', '--set-upstream-to', 'origin/main', 'main');
  return dir;
}

/**
 * Each width and theme, named `${name}-${width}-${theme}`: the whole window at 768 and 1280 px, and at 390 px, below the
 * window's minimum width, `narrow` alone under device emulation (none: no 390 px capture).
 */
async function everyWidth(app: ElectronApplication, testInfo: TestInfo, name: string, show: () => Promise<void> = async () => {}, narrow?: Page): Promise<void> {
  for (const width of WIDTHS) {
    const emulated = width < 768;
    if (emulated && !narrow) continue;
    if (emulated) await setPageSize(narrow!, width, 900);
    else await setContentSize(app, width, 900);
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      await show();
      if (emulated) await saveScreenshot(narrow!, testInfo, `${name}-${width}-${theme}`);
      else await windowShot(app, testInfo, `${name}-${width}-${theme}`);
    }
    if (emulated) await (await narrow!.context().newCDPSession(narrow!)).send('Emulation.clearDeviceMetricsOverride');
  }
}

test('account chip, Choose account dialog and default accounts in Dark and Light at 390, 768 and 1280 px', async ({ home, launch }, testInfo: TestInfo) => {
  test.setTimeout(600_000);
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  const prod = 'host-prod-1';
  fs.writeFileSync(path.join(home.userData, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    authorities: {},
    order: [],
    hosts: { [prod]: { id: prod, kind: 'ssh', destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1', recentFolders: [], settings: {}, alwaysCredentialHosts: ['git.indigital.gr', 'bitbucket.org'] } },
    groupOrder: [],
  }));
  try {
    const { app } = await launchReady(launch, forgeEnv(started));

    let indigital = '';
    await inAccounts(app, async (accounts) => {
      await tokenSignIn(accounts, GITLAB, 'glpat-stubAlexiosSApi000000008', 'alexios-s');
      await tokenSignIn(accounts, GITLAB, 'glpat-stubWorkAlexiosApi000001', 'work-alexios');
      indigital = await addGitlabServer(accounts, stub.indigital, 'git.indigital.gr');
      await tokenSignIn(accounts, indigital, 'glpat-stubIndigitalAstefApi00006', 'astefanopoulos');
      await tokenSignIn(accounts, indigital, 'glpat-stubIndigitalAdminApi00007', 'astef-admin');
    });

    // the chip's default: astefanopoulos chosen automatically on the push server, alexios-s chosen by you on gitlab.com
    stub.indigital.projectAccess.get('platform/api')!.set('astef-admin', 20);
    const damocles = await project(home, 'damocles', { origin: 'https://git.indigital.gr/platform/api.git', upstream: `https://${GITLAB}/alexios-s/damocles.git` });
    let shell = await openScmProject(app, damocles);
    const chip = scmSection(shell).getByTestId('forge-account-chip');
    await expect(chip).toHaveAttribute('data-state', 'auto', { timeout: 30_000 });
    let overlay = await readyOverlay(app);
    await clickAccountChip(chip);
    await overlay.getByRole('menuitem', { name: new RegExp(`^${GITLAB.replace('.', '\\.')}`) }).click();
    await overlay.getByRole('menu', { name: GITLAB, exact: true }).getByRole('menuitemradio', { name: /^alexios-s/ }).click();
    await expect(overlayMenu(overlay)).toHaveCount(0);
    await expect(chip).toHaveAccessibleName(`Accounts: astefanopoulos on ${indigital}, chosen automatically; alexios-s on ${GITLAB}, chosen by you`);
    await everyWidth(app, testInfo, 's2-default', async () => {}, shell);

    // the chip's menu with the self-managed server's submenu open
    await everyWidth(app, testInfo, 's2-menu', async () => {
      await clickAccountChip(chip);
      await overlay.getByRole('menuitem', { name: new RegExp(`^${indigital.replace(/[.]/g, '\\.')}`) }).click();
      await expect(overlay.getByRole('menu', { name: indigital, exact: true })).toBeVisible();
      await settled(overlay);
    });
    await overlay.keyboard.press('Escape');
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);

    // the chip's choose and error states: a gitlab.com project nothing settles, whose check cannot reach the server
    // grp/sub/proj, which no check answered for yet, with both accounts able to push
    stub.gitlab.projectAccess.get('grp/sub/proj')!.set('work-alexios', 30);
    stub.gitlab.failAccess = true;
    const site = await project(home, 'personal-site', { origin: `${stub.gitlab.webUrl}/grp/sub/proj.git` });
    shell = await openScmProject(app, site);
    await expect(scmSection(shell).getByTestId('forge-check-failed')).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's2-choose-error', async () => {}, shell);
    stub.gitlab.failAccess = false;

    // the Choose account dialog answered: alexios-s owns grp/sub/proj, so it is preselected with the owner chip
    stub.gitlab.projectAccess.get('grp/sub/proj')!.set('alexios-s', 50);
    await clickMenu(app, 'damocles.git.push');
    const ask = (name: string) => overlay.getByRole('alertdialog', { name: `Which ${GITLAB} account should ${name} use?`, exact: true });
    await expect(ask('personal-site')).toBeVisible({ timeout: 30_000 });
    await expect(overlay.getByTestId('forge-ask-owner').filter({ visible: true })).toHaveCount(1);
    await everyWidth(app, testInfo, 's3-default', async () => {}, overlay);
    await overlay.keyboard.press('Escape');
    await expect(ask('personal-site')).toHaveCount(0);

    // the Choose account dialog checking: another repository, whose first check failed, so the push checks again, slowly
    stub.gitlab.projectAccess.get('indigital/tools/deploy')!.set('alexios-s', 30).set('work-alexios', 30);
    stub.gitlab.failAccess = true;
    const tools = await project(home, 'deploy', { origin: `${stub.gitlab.webUrl}/indigital/tools/deploy.git` });
    shell = await openScmProject(app, tools);
    await expect(scmSection(shell).getByTestId('forge-check-failed')).toBeVisible({ timeout: 30_000 });
    stub.gitlab.failAccess = false;
    stub.gitlab.accessDelayMs = 60_000;
    await clickMenu(app, 'damocles.git.push');
    await expect(ask('deploy')).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's3-checking', async () => {}, overlay);
    await overlay.keyboard.press('Escape');
    await expect(ask('deploy')).toHaveCount(0);
    stub.gitlab.accessDelayMs = 0;

    // Remote hosts: prod-1's default accounts
    overlay = await openSettingsModal(app, 'remoteHosts');
    const defaults = overlay.getByTestId('forge-defaults');
    await expect(defaults).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
    await overlay.getByLabel(`Default account on ${indigital}`, { exact: true }).click();
    await overlay.getByRole('option', { name: 'astefanopoulos', exact: true }).click();
    await expect(overlay.getByText('as astefanopoulos, the default', { exact: true })).toBeVisible();
    for (const width of WIDTHS) {
      await setPageSize(overlay, width, 900);
      for (const theme of THEMES) {
        await showTheme(app, await shellPage(app), theme);
        await defaults.evaluate((element) => element.closest('[data-testid^="settings-row-"]')?.scrollIntoView({ block: 'start' }));
        await settled(overlay);
        await saveScreenshot(overlay, testInfo, `s4-default-${width}-${theme}`);
      }
    }
    await closeSettingsModal(overlay);
  } finally {
    await stub.close();
  }
});
