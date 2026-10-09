import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { REPO_ROOT } from './support/hermetic';
import { menuItem, overlayMenu } from './support/overlay';
import { closeSettingsModal, setContentSize, settingsModal, settingsNav } from './support/settings';
import { overlayPage, popupPage, popupToasts, shellPage } from './support/shell';
import { chatInput, clickMenu } from './support/ui';
import { lastSeenVersion, openedExternally, pushUpdateState, recordOpenExternal, seedLastSeenVersion, snapshotOf } from './support/updates';
import { aboutRestart, aboutUpdateStatus, PILL_READY, updatePill } from './update/update-notice.mjs';

const VERSION = (JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
// The release CHANGELOG.md lists right under the running one, and an older one whose notes hold a link.
const CHANGELOG = fs.readFileSync(path.join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
const RELEASES = [...CHANGELOG.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((match) => match[1]!);
const PREVIOUS = RELEASES[RELEASES.indexOf(VERSION) + 1]!;
const LINKED = { version: '2.4.0', name: 'crbug.com/40269650', url: 'https://issues.chromium.org/issues/40269650' };

const versionRow = (overlay: Page, version: string): Locator => overlay.locator(`[data-version-row="${version}"]`);
const notesOf = (overlay: Page, version: string): Locator => overlay.locator(`[data-testid="whats-new-notes"][data-version="${version}"]`);

// About has no outer scroll: the page fits the modal, and What's new's list is the one thing that scrolls.
// A tinted chip's label is its tone's text shade (D48), resolved the way the page resolves the token.
async function expectTextToken(chip: Locator, token: string): Promise<void> {
  const expected = await chip.evaluate((_element, name) => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
  await expect(chip).toHaveCSS('color', expected);
}

async function expectOnlyListScrolls(overlay: Page): Promise<void> {
  await expect.poll(() => overlay.evaluate(() => {
    const content = document.querySelector('.sm-content')!;
    const list = document.querySelector('.whats-new-scroll')!;
    return {
      outer: getComputedStyle(content).overflowY,
      fits: content.scrollHeight <= content.clientHeight,
      listScrolls: getComputedStyle(list).overflowY === 'auto' && list.scrollHeight > list.clientHeight,
    };
  })).toEqual({ outer: 'hidden', fits: true, listScrolls: true });
}

async function openAbout(app: Parameters<typeof clickMenu>[0], menuId: 'damocles.about' | 'damocles.releaseNotes' = 'damocles.about'): Promise<Page> {
  await clickMenu(app, menuId);
  const overlay = await overlayPage(app);
  await expect(settingsModal(overlay)).toBeVisible();
  await expect(settingsNav(overlay, 'about')).toHaveAttribute('aria-selected', 'true');
  return overlay;
}

test.describe('Settings › About', () => {
  test('the version card, What\'s new with the running version expanded, an older version\'s notes and their links', async ({ launch }) => {
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    await recordOpenExternal(app);
    const overlay = await openAbout(app);

    const card = overlay.getByTestId('settings-row-about-version');
    await expect(card).toContainText(`Damocles ${VERSION}`);
    const electron = await app.evaluate(() => process.versions.electron);
    await expect(overlay.getByTestId('about-runtimes')).toContainText(`Electron${electron}`);
    await expect(aboutUpdateStatus(overlay)).toHaveAttribute('data-state', 'disabled');
    await expect(overlay.getByTestId('about-update-detail')).toHaveText('Updates are off in development builds.');
    await expect(overlay.getByTestId('about-check')).toBeDisabled();
    await expectOnlyListScrolls(overlay);
    await setContentSize(app, 1000, 620);
    await expectOnlyListScrolls(overlay);
    await setContentSize(app, 1600, 1000);
    await expectOnlyListScrolls(overlay);

    await expect(versionRow(overlay, VERSION)).toHaveAttribute('aria-expanded', 'true');
    await expect(versionRow(overlay, VERSION).getByTestId('whats-new-current')).toHaveText('Current');
    await expectTextToken(versionRow(overlay, VERSION).getByTestId('whats-new-current'), '--d-accent-text');
    await expect(notesOf(overlay, VERSION).getByTestId('release-notes')).toBeVisible();
    await expect(versionRow(overlay, PREVIOUS)).toHaveAttribute('aria-expanded', 'false');
    await expect(versionRow(overlay, PREVIOUS).getByTestId('whats-new-current')).toHaveCount(0);
    await expect(notesOf(overlay, PREVIOUS)).toHaveCount(0);

    // Closing the running version shrinks its item; the list renders the rows that now fill its viewport.
    await versionRow(overlay, VERSION).click();
    await expect(notesOf(overlay, VERSION)).toHaveCount(0);
    await expect.poll(() => overlay.locator('.whats-new-scroll').evaluate((list) => {
      const rows = [...list.querySelectorAll('[data-version-row]')];
      return rows.length > 0 && rows.at(-1)!.getBoundingClientRect().bottom >= list.getBoundingClientRect().bottom;
    })).toBe(true);
    await versionRow(overlay, VERSION).click();
    await expect(versionRow(overlay, VERSION)).toHaveAttribute('aria-expanded', 'true');

    await versionRow(overlay, PREVIOUS).click();
    await expect(versionRow(overlay, PREVIOUS)).toHaveAttribute('aria-expanded', 'true');
    await expect(notesOf(overlay, PREVIOUS).locator('h3[data-section="added"]')).toBeVisible();

    // The list is virtualized: a version far down renders only once the arrow keys scroll it in.
    await expect(versionRow(overlay, LINKED.version)).toHaveCount(0);
    await versionRow(overlay, PREVIOUS).focus();
    for (let step = RELEASES.indexOf(PREVIOUS); step < RELEASES.indexOf(LINKED.version); step++) await overlay.keyboard.press('ArrowDown');
    await expect(versionRow(overlay, LINKED.version)).toBeFocused();
    await overlay.keyboard.press('Enter');
    const link = notesOf(overlay, LINKED.version).getByRole('link', { name: LINKED.name });
    await expect(link).toHaveAttribute('target', '_blank');
    await link.click();
    await expect.poll(() => openedExternally(app)).toEqual([LINKED.url]);
    await expect(settingsModal(overlay)).toBeVisible();
  });

  test('Help › Release Notes opens What\'s new on the running version, and Copy version info fills the clipboard', async ({ clipboard, launch }) => {
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    const overlay = await openAbout(app, 'damocles.releaseNotes');
    await expect(versionRow(overlay, VERSION)).toHaveAttribute('aria-expanded', 'true');
    await expect(overlay.getByTestId('whats-new')).toBeInViewport();

    await clipboard.writeText(app, '');
    await overlay.getByTestId('about-copy').click();
    await expect(overlay.getByTestId('about-copy')).toHaveText('Copied');
    const copied = await clipboard.readText(app);
    expect(copied).toContain(VERSION);
    expect(copied).toContain(await app.evaluate(() => process.versions.electron));
    await closeSettingsModal(overlay);
  });

  test('renders the update state main pushes: the pill downloads, turns ready with its menu, says restarting with Restart disabled, and About follows', async ({ launch }) => {
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    const shell = await shellPage(app);
    await expect(updatePill(shell)).toHaveCount(0);

    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'downloading', version: '9.9.0', percent: 42 }));
    await expect(updatePill(shell)).toHaveAttribute('data-state', 'downloading');
    await expect(updatePill(shell)).toHaveText('Downloading 42%');
    await expect(shell.getByTestId('update-pill-fill')).toHaveAttribute('aria-valuenow', '42');
    // The fill slides by transform: the indicator sits 58% left of the track.
    await expect.poll(() => shell.getByTestId('update-pill-fill').locator('> *').evaluate((indicator) => indicator.style.transform)).toBe('translateX(-58%)');

    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'ready', version: '9.9.0', notes: '' }));
    await expect(updatePill(shell)).toHaveText(PILL_READY);
    await updatePill(shell).click();
    const overlay = await overlayPage(app);
    await expect(overlayMenu(overlay)).toBeVisible();
    await expect(menuItem(overlay, 'restart')).toBeEnabled();
    await expect(menuItem(overlay, 'releaseNotes')).toBeVisible();
    await expect(menuItem(overlay, 'showLog')).toBeVisible();
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);

    // While the quit that installs it runs, the pill says so and its menu's Restart is disabled.
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'restarting', version: '9.9.0', notes: '' }));
    await expect(updatePill(shell)).toHaveAttribute('data-state', 'restarting');
    await expect(updatePill(shell)).toHaveText('Restarting');
    await updatePill(shell).click();
    await expect(overlayMenu(overlay)).toBeVisible();
    await expect(menuItem(overlay, 'restart')).toBeDisabled();
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
    await pushUpdateState(app, 'shell', snapshotOf({ kind: 'ready', version: '9.9.0', notes: '' }));
    await expect(updatePill(shell)).toHaveText(PILL_READY);

    await openAbout(app);
    // Chromium's own sanitizing run on hostile feed notes: nothing executes or loads.
    const notes = '<h3>Added</h3><script>window.__ran = 1</script><p onclick="window.__ran = 2">New <img src="https://evil.example/a.png" onerror="window.__ran = 3">thing</p><iframe src="https://evil.example"></iframe><p><a href="javascript:window.__ran=4">bad</a> <a href="https://example.com/r">release</a></p>';
    await pushUpdateState(app, 'overlay', snapshotOf({ kind: 'ready', version: '9.9.0', notes }));
    await expect(aboutUpdateStatus(overlay)).toHaveAttribute('data-state', 'ready');
    await expect(aboutRestart(overlay)).toBeEnabled();
    await pushUpdateState(app, 'overlay', snapshotOf({ kind: 'restarting', version: '9.9.0', notes }));
    await expect(aboutUpdateStatus(overlay)).toHaveText('Restarting');
    await expect(aboutRestart(overlay)).toBeDisabled();
    await expect(aboutRestart(overlay)).toHaveText('Restarting');
    await pushUpdateState(app, 'overlay', snapshotOf({ kind: 'ready', version: '9.9.0', notes }));
    await expect(aboutRestart(overlay)).toBeEnabled();
    await expectOnlyListScrolls(overlay);
    await expect(versionRow(overlay, '9.9.0').getByTestId('whats-new-update')).toHaveText('Update');
    const pending = notesOf(overlay, '9.9.0');
    await expect(pending).toContainText('New thing');
    await expect(pending.locator('script, img, iframe, [onclick], [onerror], a[href^="javascript"]')).toHaveCount(0);
    await expect(pending.getByRole('link', { name: 'release' })).toHaveAttribute('href', 'https://example.com/r');
    expect(await overlay.evaluate(() => (window as unknown as { __ran?: number }).__ran)).toBeUndefined();

    await pushUpdateState(app, 'overlay', snapshotOf({ kind: 'upToDate', checkedAt: Date.now() }, Date.parse('2026-01-02T09:05:00')));
    await expect(aboutUpdateStatus(overlay)).toHaveAttribute('data-state', 'upToDate');
    await expect(aboutUpdateStatus(overlay)).toHaveText('Up to date');
    await expectTextToken(aboutUpdateStatus(overlay), '--d-success-text');
    await expect(versionRow(overlay, '9.9.0')).toHaveCount(0);
    await expect(overlay.getByTestId('about-check')).toBeEnabled();
    await closeSettingsModal(overlay);
  });
});

test.describe('after an update', () => {
  test('the first launch of a higher version posts one notice whose action opens that version in What\'s new; the next launch posts none', async ({ launch, home }) => {
    seedLastSeenVersion(home, PREVIOUS);
    const first = await launch();
    await expect(chatInput(await activeChat(first.app))).toBeVisible();
    const popup = await popupPage(first.app);
    const notice = popupToasts(popup).filter({ hasText: `Damocles ${VERSION} is installed` });
    await expect(notice).toHaveCount(1);
    await expect.poll(() => lastSeenVersion(home)).toBe(VERSION);
    // Nothing opened by itself.
    await expect(settingsModal(await overlayPage(first.app))).toHaveCount(0);

    await notice.getByRole('button', { name: 'See what\'s new', exact: true }).click();
    const overlay = await overlayPage(first.app);
    await expect(settingsModal(overlay)).toBeVisible();
    await expect(settingsNav(overlay, 'about')).toHaveAttribute('aria-selected', 'true');
    await expect(versionRow(overlay, VERSION)).toHaveAttribute('aria-expanded', 'true');
    await closeSettingsModal(overlay);
    await first.close();

    const second = await launch();
    await expect(chatInput(await activeChat(second.app))).toBeVisible();
    // The bell lists every notice of the run; the announcement would be there by the time the first chat is up.
    const shell = await shellPage(second.app);
    await shell.getByTestId('notification-bell').click();
    const center = (await overlayPage(second.app)).getByTestId('notification-center');
    await expect(center).toBeVisible();
    await expect(center).not.toContainText('is installed');
  });
});
