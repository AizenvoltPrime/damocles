import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { saveScreenshot, settled, showTheme, THEMES } from '../support/screenshots';
import { setContentSize, settingsModal, settingsNav } from '../support/settings';
import { overlayPage, popupPage, popupToasts, shellPage } from '../support/shell';
import { chatInput, clickMenu } from '../support/ui';
import { pushUpdateState, seedLastSeenVersion, snapshotOf } from '../support/updates';

const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
const RELEASES = [...fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8').matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]!);
const PREVIOUS = RELEASES[RELEASES.indexOf(VERSION) + 1]!;
const PENDING_NOTES = [
  '### Added',
  '',
  '- **Desktop: an update pill in the title bar.** It shows the download and offers **Restart to update** once it is ready.',
  '- **Settings › About** shows the version, the runtimes and `What\'s new` for every release.',
  '',
  '### Fixed',
  '',
  '- **Release notes open links in the browser.** See [the release page](https://github.com/AizenvoltPrime/damocles/releases).',
].join('\n');

const row = (overlay: Page, version: string) => overlay.locator(`[data-version-row="${version}"]`);

async function openAbout(app: ElectronApplication): Promise<Page> {
  await clickMenu(app, 'damocles.about');
  const overlay = await overlayPage(app);
  await expect(settingsNav(overlay, 'about')).toHaveAttribute('aria-selected', 'true');
  await expect(row(overlay, VERSION)).toHaveAttribute('aria-expanded', 'true');
  await expect(overlay.locator(`[data-testid="whats-new-notes"][data-version="${VERSION}"] [data-testid="release-notes"]`)).toBeVisible();
  await settled(overlay);
  return overlay;
}

test('Settings › About, What\'s new and the update pill in Dark and Light', async ({ launch }, testInfo) => {
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setContentSize(app, 1280, 800);
  const shell = await shellPage(app);

  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    let overlay = await openAbout(app);
    await saveScreenshot(overlay, testInfo, `about-${theme}`);

    await settingsNav(overlay, 'appearance').click();
    await settled(overlay);
    await saveScreenshot(overlay, testInfo, `appearance-${theme}-for-comparison`);
    await settingsNav(overlay, 'about').click();
    await expect(row(overlay, VERSION)).toBeVisible();

    await pushUpdateState(app, 'overlay', snapshotOf({ kind: 'ready', version: '9.9.0', notes: PENDING_NOTES }, Date.now() - 60_000));
    await expect(overlay.locator('[data-testid="whats-new-notes"][data-version="9.9.0"] [data-testid="release-notes"]')).toBeVisible();
    await settled(overlay);
    await saveScreenshot(overlay, testInfo, `about-ready-${theme}`);

    for (const [name, state] of [
      ['checking', { kind: 'checking' }],
      ['up-to-date', { kind: 'upToDate', checkedAt: Date.now() }],
      ['downloading', { kind: 'downloading', version: '9.9.0', percent: 42 }],
      ['error', { kind: 'error', reason: 'net::ERR_INTERNET_DISCONNECTED' }],
    ] as const) {
      await pushUpdateState(app, 'overlay', snapshotOf(state, Date.now() - 60_000));
      await expect(overlay.getByTestId('about-update-status')).toHaveAttribute('data-state', state.kind);
      await settled(overlay);
      await saveScreenshot(overlay, testInfo, `about-card-${name}-${theme}`, overlay.getByTestId('settings-row-about-version'));
    }
    await overlay.keyboard.press('Escape');
    await expect(settingsModal(overlay)).toHaveCount(0);

    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'downloading', version: '9.9.0', percent: 42 }));
    await expect(shell.getByTestId('update-pill')).toHaveAttribute('data-state', 'downloading');
    await settled(shell);
    await saveScreenshot(shell, testInfo, `pill-downloading-${theme}`, shell.getByTestId('title-bar'));
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'ready', version: '9.9.0', notes: '' }));
    await expect(shell.getByTestId('update-pill')).toHaveAttribute('data-state', 'ready');
    await settled(shell);
    await saveScreenshot(shell, testInfo, `pill-ready-${theme}`, shell.getByTestId('title-bar'));
    await shell.getByTestId('update-pill').click();
    overlay = await overlayPage(app);
    await expect(overlay.getByTestId('overlay-menu')).toBeVisible();
    await settled(overlay);
    await saveScreenshot(overlay, testInfo, `pill-menu-${theme}`);
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('overlay-menu')).toHaveCount(0);
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'disabled' }));
    await expect(shell.getByTestId('update-pill')).toHaveCount(0);
  }

  await showTheme(app, shell, 'dark');
  const overlay = await openAbout(app);
  const list = overlay.getByTestId('whats-new');
  await row(overlay, VERSION).click();
  await expect(row(overlay, VERSION)).toHaveAttribute('aria-expanded', 'false');
  await list.scrollIntoViewIfNeeded();
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'whats-new-collapsed', list);
  await saveScreenshot(overlay, testInfo, 'about-whats-new-collapsed-full');

  await row(overlay, VERSION).click();
  await expect(overlay.locator(`[data-testid="whats-new-notes"][data-version="${VERSION}"] [data-testid="release-notes"]`)).toBeVisible();
  await overlay.locator('.whats-new-scroll').evaluate((element) => element.scrollTo({ top: 0 }));
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'whats-new-expanded-current', list);
  // Only the list scrolls; scrollIntoView would also move the About page, whose overflow is hidden.
  await overlay.locator(`[data-testid="whats-new-notes"][data-version="${VERSION}"]`).evaluate((element) => {
    const scroller = element.closest('.whats-new-scroll')!;
    scroller.scrollTop += element.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top;
  });
  await row(overlay, PREVIOUS).click();
  await expect(overlay.locator(`[data-testid="whats-new-notes"][data-version="${PREVIOUS}"] [data-testid="release-notes"]`)).toBeVisible();
  await settled(overlay);
  await saveScreenshot(overlay, testInfo, 'whats-new-expanded-older', list);
});

test('the after-update notice in the popup window', async ({ foreground: _foreground, launch, home }, testInfo) => {
  seedLastSeenVersion(home, PREVIOUS);
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const popup = await popupPage(app);
  const notice = popupToasts(popup).filter({ hasText: `Damocles ${VERSION} is installed` });
  await expect(notice).toHaveCount(1);
  await notice.hover();
  await settled(popup);
  await saveScreenshot(popup, testInfo, 'after-update-popup');
});
