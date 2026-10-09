import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { saveScreenshot, settled, showTheme, THEMES } from '../support/screenshots';
import { setContentSize, settingsNav } from '../support/settings';
import { overlayPage, shellPage } from '../support/shell';
import { chatInput, clickMenu } from '../support/ui';
import { pushUpdateState, snapshotOf } from '../support/updates';

const NOTES = '### Fixed\n\n- **Restart to update** says it is restarting while the quit runs.';

async function openAbout(app: ElectronApplication): Promise<Page> {
  await clickMenu(app, 'damocles.about');
  const overlay = await overlayPage(app);
  await expect(settingsNav(overlay, 'about')).toHaveAttribute('aria-selected', 'true');
  return overlay;
}

test('the restarting update state in the title-bar pill and in Settings › About, in Dark and Light', async ({ launch }, testInfo) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setContentSize(app, 1280, 800);
  const shell = await shellPage(app);

  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'restarting', version: '9.9.0', notes: '' }));
    await expect(shell.getByTestId('update-pill')).toHaveAttribute('data-state', 'restarting');
    await settled(shell);
    await saveScreenshot(shell, testInfo, `pill-restarting-${theme}`, shell.getByTestId('title-bar'));

    const overlay = await openAbout(app);
    await pushUpdateState(app, 'overlay', snapshotOf({ kind: 'restarting', version: '9.9.0', notes: NOTES }, Date.now() - 60_000));
    await expect(overlay.getByTestId('about-restart')).toBeDisabled();
    await expect(overlay.getByTestId('about-update-status')).toHaveAttribute('data-state', 'restarting');
    await expect(overlay.locator('[data-testid="whats-new-notes"][data-version="9.9.0"] [data-testid="release-notes"]')).toBeVisible();
    await settled(overlay);
    await saveScreenshot(overlay, testInfo, `about-restarting-${theme}`);
    await saveScreenshot(overlay, testInfo, `about-card-restarting-${theme}`, overlay.getByTestId('settings-row-about-version'));
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('about-restart')).toHaveCount(0);
  }
});
