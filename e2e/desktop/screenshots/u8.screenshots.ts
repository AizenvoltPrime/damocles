import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { OVERLAY_CHANNELS } from '../../../src/desktop/preload/overlay-channels';
import { activeChat, expect, IPC_HANDLER_ERROR_ANNOTATION, test } from '../support/fixtures';
import { REPO_ROOT, writeUserSettings } from '../support/hermetic';
import { chromeEnv, openPage, startSite, systemChrome } from '../support/browser';
import { saveScreenshot, settled, showTheme, THEMES } from '../support/screenshots';
import { setContentSize, settingsModal, settingsNav } from '../support/settings';
import { OVERLAY_URL, overlayPage, popupPage, popupToasts, shellPage } from '../support/shell';
import { chatInput, clickMenu } from '../support/ui';

const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;

// Answers one of the overlay's channels with a failure, as main does when it cannot read CHANGELOG.md.
async function failChannel(app: ElectronApplication, channel: string): Promise<void> {
  test.info().annotations.push({ type: IPC_HANDLER_ERROR_ANNOTATION, description: channel });
  await app.evaluate(({ webContents }, [url, name]) => {
    const overlay = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
    overlay.ipc.removeHandler(name!);
    overlay.ipc.handle(name!, () => {
      throw new Error('The release notes could not be read');
    });
  }, [OVERLAY_URL, channel] as const);
}

async function openAbout(app: ElectronApplication): Promise<Page> {
  await clickMenu(app, 'damocles.about');
  const overlay = await overlayPage(app);
  await expect(settingsNav(overlay, 'about')).toHaveAttribute('aria-selected', 'true');
  return overlay;
}

async function closeSettings(overlay: Page): Promise<void> {
  await overlay.keyboard.press('Escape');
  await expect(settingsModal(overlay)).toHaveCount(0);
}

test('What\'s new says the notes or the release list could not load, in Dark and Light', async ({ launch }, testInfo) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setContentSize(app, 1280, 800);
  const shell = await shellPage(app);
  await openAbout(app).then(closeSettings);

  await failChannel(app, OVERLAY_CHANNELS.releaseNotesGet);
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    const overlay = await openAbout(app);
    const failed = overlay.locator(`[data-testid="whats-new-notes"][data-version="${VERSION}"] [role="alert"]`);
    await expect(failed).toHaveText('These notes could not load.');
    await settled(overlay);
    await saveScreenshot(overlay, testInfo, `whats-new-notes-failed-${theme}`);
    await closeSettings(overlay);
  }

  await failChannel(app, OVERLAY_CHANNELS.releaseNotesIndex);
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    const overlay = await openAbout(app);
    await expect(overlay.getByTestId('whats-new-failed')).toHaveText('The release notes could not load.');
    await settled(overlay);
    await saveScreenshot(overlay, testInfo, `whats-new-list-failed-${theme}`);
    await closeSettings(overlay);
  }
});

test('Open in system browser that the system cannot open, as its toast in Dark and Light', async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.skip(systemChrome() === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');
  test.setTimeout(240_000);
  const site = await startSite(() => 'Acme dashboard');
  try {
    writeUserSettings(home, { 'damocles.browser.enabled': true });
    const { app } = await launch({ env: chromeEnv() });
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await openPage(app, tab, `${site.url}/`);
    await app.evaluate(({ shell }) => {
      shell.openExternal = (() => Promise.reject(new Error('No application is registered for the URL'))) as typeof shell.openExternal;
    });
    const shell = await shellPage(app);
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await shell.getByTestId('browser-open-external').click();
      const popup = await popupPage(app);
      const toast = popupToasts(popup).filter({ hasText: 'Damocles could not open the page in the system browser.' });
      await expect(toast).toHaveCount(1);
      // The popup window is transparent; the capture paints the theme's background behind it.
      await popup.evaluate(() => {
        document.body.style.backgroundColor = 'var(--d-bg)';
      });
      await settled(popup);
      await saveScreenshot(popup, testInfo, `open-external-failed-${theme}`);
      await popup.evaluate(() => {
        document.body.style.backgroundColor = '';
      });
      await toast.getByTestId('overlay-toast-dismiss').click();
      await expect(toast).toHaveCount(0);
    }
  } finally {
    await site.close();
  }
});
