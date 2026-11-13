import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn } from '../support/forge';
import { expect, test } from '../support/fixtures';
import { overlayPage, shellPage } from '../support/shell';
import { saveScreenshot, setPageSize, settled, showTheme, THEMES, windowShot } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { clickMenu } from '../support/ui';

// Visual parity captures of the clone picker at the design's checked widths, in both themes, against the forge
// stub's listings: empty (no account), default, a query's highlights, per-account loading, a server that did not answer, no
// results and a pasted URL.

const WIDTHS = [390, 768, 1280] as const;

/** Each width and theme, named `${name}-${width}-${theme}`: the window at 768 and 1280 px, the overlay alone emulated at 390 px. */
async function everyWidth(app: ElectronApplication, testInfo: TestInfo, name: string, widths: readonly number[] = WIDTHS): Promise<void> {
  const overlay = await overlayPage(app);
  for (const width of widths) {
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

async function openPicker(app: ElectronApplication): Promise<Page> {
  const overlay = await overlayPage(app);
  await clickMenu(app, 'damocles.git.cloneFromAccount');
  await expect(overlay.getByRole('dialog', { name: 'Clone a repository', exact: true })).toBeVisible();
  return overlay;
}

async function closePicker(overlay: Page): Promise<void> {
  await overlay.getByRole('combobox', { name: 'Repository', exact: true }).press('Escape');
  await expect(overlay.getByRole('dialog', { name: 'Clone a repository', exact: true })).toHaveCount(0);
}

test('clone picker in Dark and Light at 390, 768 and 1280 px', async ({ home, launch }, testInfo: TestInfo) => {
  test.setTimeout(900_000);
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  try {
    const { app } = await launchReady(launch, forgeEnv(started));

    // empty: no account yet
    let overlay = await openPicker(app);
    await expect(overlay.getByText('No GitHub or GitLab account yet.', { exact: true })).toBeVisible();
    await everyWidth(app, testInfo, 's7-empty');
    await closePicker(overlay);

    // the design's three accounts: the self-managed GitLab (gitlab.indigital.gr's stand-in), gitlab.com and github.com
    let indigital = '';
    await inAccounts(app, async (accounts) => {
      indigital = await addGitlabServer(accounts, stub.indigital);
      await tokenSignIn(accounts, indigital, 'glpat-stubIndigitalAstefApi00006', 'astefanopoulos');
      await tokenSignIn(accounts, 'gitlab.com', 'glpat-stubAlexiosSApi000000008', 'alexios-s');
      await tokenSignIn(accounts, 'github.com', 'ghp_stubAstefanopoulosRepo0000000001', 'astefanopoulos');
    });

    // default: every section listed
    overlay = await openPicker(app);
    await expect(overlay.getByTestId('clone-picker-loading')).toHaveCount(0, { timeout: 30_000 });
    await everyWidth(app, testInfo, 's7-default');
    const combobox = overlay.getByRole('combobox', { name: 'Repository', exact: true });

    // a query's highlights
    await combobox.fill('damo');
    await expect(overlay.getByRole('option', { name: `grp/damocles, private, astefanopoulos on ${indigital}`, exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(overlay.getByTestId('clone-picker-loading')).toHaveCount(0, { timeout: 30_000 });
    await everyWidth(app, testInfo, 's7-query');

    // no results
    await combobox.fill('zzzz');
    await expect(overlay.getByTestId('clone-picker-no-results')).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's7-no-results');

    // a pasted URL
    await combobox.fill(`${stub.indigital.webUrl}/grp/platform/intranet.git`);
    await expect(overlay.getByTestId('clone-picker-paste')).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's7-paste');
    await closePicker(overlay);

    // error: github.com does not answer, the others list
    stub.github.unreachable = true;
    overlay = await openPicker(app);
    await expect(overlay.getByRole('option', { name: 'github.com did not answer. Try again', exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(overlay.getByTestId('clone-picker-loading')).toHaveCount(0, { timeout: 30_000 });
    await everyWidth(app, testInfo, 's7-error');
    await closePicker(overlay);
    stub.github.unreachable = false;

    // loading: gitlab.com and github.com still searching while the self-managed server listed
    stub.gitlab.listingDelayMs = 20_000;
    stub.github.listingDelayMs = 20_000;
    overlay = await openPicker(app);
    await expect(overlay.getByRole('option', { name: `grp/damocles, private, astefanopoulos on ${indigital}`, exact: true })).toBeVisible({ timeout: 30_000 });
    await everyWidth(app, testInfo, 's7-loading', [1280, 768]);
    await closePicker(overlay);
  } finally {
    await stub.close();
  }
});
