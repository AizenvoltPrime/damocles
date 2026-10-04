import { activeChat, expect, test } from '../support/fixtures';
import { saveScreenshot, setPageSize, settled, showTheme } from '../support/screenshots';
import { chooseSegment, closeSettingsModal, openSettingsModal, setContentSize, settingsNav, settingsRow } from '../support/settings';
import { shellPage } from '../support/shell';
import { chatInput } from '../support/ui';

test('the settings modal in Dark and Light, searched, narrow, and with the restart banner', async ({ launch }, testInfo) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setContentSize(app, 1280, 800);
  await showTheme(app, await shellPage(app), 'dark');

  let overlay = await openSettingsModal(app);
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'settings-dark-1280x800');

  await settingsNav(overlay, 'accounts').click();
  await expect(settingsNav(overlay, 'accounts')).toHaveAttribute('aria-selected', 'true');
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'settings-accounts-dark');

  await overlay.getByTestId('settings-search').fill('model');
  await expect(overlay.getByRole('heading', { name: 'Search results' })).toBeVisible();
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'settings-search-dark');
  // The highlight inside a mono key chip at 3x, where an overlap of the mark and its neighbouring glyphs would show.
  const chip = settingsRow(overlay, 'damocles.team.implementorModel').locator('.sm-badge').first();
  await chip.evaluate((element) => Object.assign((element as HTMLElement).style, { transform: 'scale(3)', transformOrigin: 'left top', position: 'relative', zIndex: '1' }));
  await saveScreenshot(overlay, testInfo, 'settings-search-key-chip-3x', chip);
  await chip.evaluate((element) => Object.assign((element as HTMLElement).style, { transform: '', transformOrigin: '', position: '', zIndex: '' }));
  await closeSettingsModal(overlay);

  overlay = await openSettingsModal(app, 'application');
  await chooseSegment(settingsRow(overlay, 'damocles.desktop.language'), 'Ελληνικά');
  const banner = overlay.getByTestId('settings-restart-banner');
  await expect(banner).toBeVisible();
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'settings-restart-banner');
  await banner.getByRole('button', { name: 'Later' }).click();
  await expect(banner).toHaveCount(0);
  await chooseSegment(settingsRow(overlay, 'damocles.desktop.language'), 'System');
  await closeSettingsModal(overlay);

  await showTheme(app, await shellPage(app), 'light');
  overlay = await openSettingsModal(app, 'workspace');
  await expect(overlay.locator('body')).toHaveAttribute('data-vscode-theme-kind', 'vscode-light');
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'settings-light-1280x800');

  // VS Code panels are often 400px wide; the modal turns into a list there (M8).
  await setPageSize(overlay, 400, 760);
  await saveScreenshot(overlay, testInfo, 'settings-narrow-400-section');
  await overlay.getByRole('button', { name: 'Back to all settings' }).click();
  await expect(overlay.getByRole('button', { name: 'Back to all settings' })).toHaveCount(0);
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'settings-narrow-400-list');
  await closeSettingsModal(overlay);
});
