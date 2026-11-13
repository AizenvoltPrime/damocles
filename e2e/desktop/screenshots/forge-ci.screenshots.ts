import * as path from 'node:path';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn } from '../support/forge';
import { CI_UI_FIXTURES } from '../support/forge-stub';
import { expect, test } from '../support/fixtures';
import { git, initRepo } from '../support/git';
import { overlayViewState, readyOverlay } from '../support/overlay';
import { openScmProject, scmSection, setSection } from '../support/scm';
import { saveScreenshot, setPageSize, showTheme, THEMES, windowShot } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { shellPage } from '../support/shell';

// Visual parity captures of the CI chip and its job list, the job log tab and the commit's CI status row at the design's
// checked widths, in both themes, against the forge stub's pipeline #4312 on gitlab.com.

const WIDTHS = [390, 768, 1280] as const;
const GITLAB = 'gitlab.com';

/** Each width and theme, named `${name}-${width}-${theme}`: the window at 768 and 1280 px, the shell alone emulated at 390 px. */
async function everyWidth(app: ElectronApplication, testInfo: TestInfo, name: string, shell: Page, show: () => Promise<void> = async () => {}): Promise<void> {
  for (const width of WIDTHS) {
    const emulated = width < 768;
    if (emulated) await setPageSize(shell, width, 900);
    else await setContentSize(app, width, 900);
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      await show();
      if (emulated) await saveScreenshot(shell, testInfo, `${name}-${width}-${theme}`);
      else await windowShot(app, testInfo, `${name}-${width}-${theme}`);
    }
    if (emulated) await (await shell.context().newCDPSession(shell)).send('Emulation.clearDeviceMetricsOverride');
  }
}

test('CI chip and job list, job log tab and CI status row in Dark and Light at 390, 768 and 1280 px', async ({ home, launch }, testInfo: TestInfo) => {
  test.setTimeout(600_000);
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  try {
    const { app } = await launchReady(launch, forgeEnv(started));
    await inAccounts(app, (accounts) => tokenSignIn(accounts, GITLAB, 'glpat-stubAlexiosSApi000000008', 'alexios-s'));

    const dir = path.join(home.root, 'projects', 'damocles');
    await initRepo(home, dir, { 'a.ts': 'export const a = 1;\n' }, { branch: CI_UI_FIXTURES.branch });
    await git(home, dir, 'remote', 'add', 'origin', `${stub.gitlab.webUrl}/alexios-s/damocles.git`);
    await git(home, dir, 'update-ref', `refs/remotes/origin/${CI_UI_FIXTURES.branch}`, 'HEAD');
    await git(home, dir, 'branch', '--set-upstream-to', `origin/${CI_UI_FIXTURES.branch}`, CI_UI_FIXTURES.branch);
    stub.gitlab.ci.reset();
    const shell = await openScmProject(app, dir);
    const chip = scmSection(shell).getByTestId('forge-ci-chip');
    await expect(chip).toHaveAccessibleName('Pipeline #4312 running, 3 of 5 jobs done', { timeout: 30_000 });

    // the running CI chip, then its job list
    await everyWidth(app, testInfo, 's2-ci-chip', shell);
    const overlay = await readyOverlay(app);
    for (const width of [768, 1280] as const) {
      await setContentSize(app, width, 900);
      for (const theme of THEMES) {
        await showTheme(app, shell, theme);
        await chip.click();
        await expect(overlay.getByRole('dialog', { name: 'Pipeline #4312', exact: true })).toBeVisible();
        await windowShot(app, testInfo, `s2-job-list-${width}-${theme}`);
        await overlay.keyboard.press('Escape');
        await expect.poll(async () => (await overlayViewState(app)).visible).toBe(false);
      }
    }

    // the job log tab: the unit log, with a few grown lines, frozen so every capture shows the same log
    await chip.click();
    await overlay.getByRole('button', { name: 'Open log: unit', exact: true }).click();
    await expect.poll(async () => (await overlayViewState(app)).visible).toBe(false);
    const log = shell.getByRole('log', { name: 'unit log', exact: true });
    await expect(log).toContainText('npm ci', { timeout: 30_000 });
    await expect(log.getByTestId('job-log-row')).not.toHaveCount(0);
    stub.gitlab.ci.freezeLog(true);
    await everyWidth(app, testInfo, 's5-running', shell);

    // the job log tab finished: unit failed, its tail line and Retry job
    stub.gitlab.ci.finishUnit('failed');
    await expect(shell.getByTestId('job-log-tail')).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's5-finished', shell);

    // the commit's CI status row
    stub.gitlab.ci.sha = (await git(home, dir, 'rev-parse', 'HEAD')).trim();
    stub.gitlab.ci.pipelineState = 'success';
    await setSection(shell, 'graph-section', true);
    const graph = shell.getByTestId('graph-section');
    await graph.getByTestId('graph-row').first().click();
    await expect(graph.getByRole('link', { name: 'Pipeline #4312 passed', exact: true })).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's6-status', shell);
  } finally {
    await stub.close();
  }
});
