import type { Page, TestInfo } from '@playwright/test';
import { addGitlabServer, forgeEnv, launchReady, startStubOnTestCa, tokenSignIn } from '../support/forge';
import { expect, test } from '../support/fixtures';
import { saveScreenshot, setPageSize, settled, showTheme, THEMES } from '../support/screenshots';
import { openSettingsModal } from '../support/settings';
import { shellPage } from '../support/shell';

// Visual parity captures of Settings › Models & accounts › Git hosting at the design's checked widths, in both themes.

const WIDTHS = [390, 768, 1280] as const;

/** The Git hosting group at the top of the modal's scrolled content. */
async function showGroup(overlay: Page): Promise<void> {
  await overlay.getByTestId('forge-hosting-head').evaluate((head) => head.scrollIntoView({ block: 'start' }));
  await settled(overlay);
}

test('Git hosting in Dark and Light at 390, 768 and 1280 px: default, the Token sign-in with Manage open, the server form and the sign-out dialog', async ({ home, launch }, testInfo: TestInfo) => {
  test.setTimeout(300_000);
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  try {
    const { app } = await launchReady(launch, forgeEnv(started));
    await app.evaluate(({ shell }) => {
      shell.openExternal = (() => Promise.resolve()) as typeof shell.openExternal;
    });

    // the design's sample: alexios-s on gitlab.com, and the company's self-managed GitLab with a token account.
    const overlay = await openSettingsModal(app, 'accounts');
    await setPageSize(overlay, 1280, 900);
    await overlay.getByRole('button', { name: 'Add account: gitlab.com', exact: true }).click();
    await overlay.getByRole('radio', { name: 'Device code', exact: true }).click();
    await overlay.getByRole('button', { name: 'Get a code', exact: true }).click();
    await expect(overlay.getByTestId('provider-sign-in-code')).toBeVisible();
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      await showGroup(overlay);
      await saveScreenshot(overlay, testInfo, `forge-device-code-1280-${theme}`);
    }
    stub.gitlab.approveDevice('alexios-s');
    await expect(overlay.getByText('Signed in as alexios-s', { exact: true })).toBeVisible({ timeout: 30_000 });
    const indigital = await addGitlabServer(overlay, stub.indigital);
    await tokenSignIn(overlay, indigital, 'glpat-stubIndigitalWorkApi00004', 'work-alexios');
    await expect(overlay.getByTestId(`settings-row-forge-server-${indigital}`).getByTestId('forge-version-badge')).toBeVisible();

    for (const width of WIDTHS) {
      await setPageSize(overlay, width, 900);
      for (const theme of THEMES) {
        await showTheme(app, await shellPage(app), theme);
        await showGroup(overlay);
        await saveScreenshot(overlay, testInfo, `forge-default-${width}-${theme}`);
      }
    }

    await overlay.getByRole('button', { name: 'Add account: gitlab.com', exact: true }).click();
    await overlay.getByRole('radio', { name: 'Token', exact: true }).click();
    await overlay.getByLabel('Personal access token', { exact: true }).fill('glpat-stubWorkAlexiosRead00002');
    await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(overlay.getByRole('alert').filter({ hasText: 'missing the api scope' })).toBeVisible();
    await overlay.getByTestId('forge-account-work-alexios').getByRole('button', { name: `Manage: work-alexios on ${indigital}` }).click();
    for (const width of WIDTHS) {
      await setPageSize(overlay, width, 900);
      for (const theme of THEMES) {
        await showTheme(app, await shellPage(app), theme);
        await showGroup(overlay);
        await saveScreenshot(overlay, testInfo, `forge-token-refused-${width}-${theme}`);
        await overlay.getByTestId('forge-manage').evaluate((panel) => panel.scrollIntoView({ block: 'center' }));
        await settled(overlay);
        await saveScreenshot(overlay, testInfo, `forge-manage-${width}-${theme}`);
      }
    }
    await overlay.getByTestId('forge-sign-in-cancel').click();

    await overlay.getByTestId('settings-row-forge-add-server').getByRole('button', { name: 'Add server', exact: true }).click();
    await overlay.getByLabel('Server URL', { exact: true }).fill('http://gitlab.example.com');
    await overlay.getByTestId('forge-server-submit').click();
    await expect(overlay.getByTestId('forge-server-refusal')).toBeVisible();
    for (const width of WIDTHS) {
      await setPageSize(overlay, width, 900);
      for (const theme of THEMES) {
        await showTheme(app, await shellPage(app), theme);
        await overlay.getByTestId('forge-server-form').evaluate((form) => form.scrollIntoView({ block: 'start' }));
        await settled(overlay);
        await saveScreenshot(overlay, testInfo, `forge-server-form-${width}-${theme}`);
      }
    }
    await overlay.getByTestId('forge-server-cancel').click();

    await setPageSize(overlay, 1280, 900);
    await overlay.getByTestId('forge-account-alexios-s').getByRole('button', { name: 'Manage: alexios-s on gitlab.com' }).click();
    await overlay.getByTestId('forge-account-alexios-s').getByRole('button', { name: 'Sign out', exact: true }).click();
    const dialog = overlay.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      await saveScreenshot(overlay, testInfo, `forge-sign-out-1280-${theme}`);
    }
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  } finally {
    await stub.close();
  }
});
