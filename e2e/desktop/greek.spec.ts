import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { readUserSettings, REPO_ROOT } from './support/hermetic';
import { chatInput } from './support/ui';
import { shellPage } from './support/shell';
import { menuLabels } from './support/shell-ui';
import { chooseSegment, closeSettingsModal, openSettingsModal, settingsRow } from './support/settings';

const nlsEl = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.nls.el.json'), 'utf8')) as Record<string, string>;
const GREEK_PLACEHOLDER = 'Ρωτήστε τον Damocles οτιδήποτε…';

// Geist has no Greek glyphs; theme.ts puts Inter's greek subsets behind it, so rendered Greek loads an Inter face.
async function interInUse(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'Inter Variable' && face.status === 'loaded');
  });
}

async function menuLabel(app: ElectronApplication, id: string): Promise<string | undefined> {
  return (await menuLabels(app)).find((item) => item.id === id)?.label;
}

async function expectGreek(app: ElectronApplication, tab: Page): Promise<void> {
  await expect(tab.getByPlaceholder(GREEK_PLACEHOLDER)).toBeVisible();
  const shell = await shellPage(app);
  await expect(shell.getByRole('navigation', { name: 'Πλευρική στήλη' })).toBeVisible();
  await expect(shell.getByRole('heading', { name: 'Συνομιλίες' })).toBeVisible();
  await expect(shell.getByRole('button', { name: 'Damocles, μενού εφαρμογής' })).toBeVisible();
  await expect(shell.getByRole('listbox', { name: /^Συνομιλίες στο / })).toBeAttached();
  await expect(shell.locator('html')).toHaveAttribute('lang', 'el');
  await expect.poll(() => interInUse(tab)).toBe(true);
  await expect.poll(() => interInUse(shell)).toBe(true);
  // A package.nls.el.json command title and a host l10n bundle string.
  await expect.poll(() => menuLabel(app, 'damocles.showLog')).toBe(nlsEl['command.showLog.title']);
  expect((await menuLabels(app)).map((item) => item.label)).toContain('Προβολή');
}

test('the Language row saves Greek, offers Restart now, and the next launch is Greek everywhere', async ({ home, launch }) => {
  let desktop = await launch({ args: ['--lang=en-US'] });
  let tab = await activeChat(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  const shell = await shellPage(desktop.app);
  await expect(shell.getByRole('navigation', { name: 'Sidebar' })).toBeVisible();
  await expect(shell.getByRole('heading', { name: 'Chats' })).toBeVisible();
  expect(await menuLabel(desktop.app, 'damocles.showLog')).toBe('Show Log');

  const overlay = await openSettingsModal(desktop.app, 'application');
  await chooseSegment(settingsRow(overlay, 'damocles.desktop.language'), 'Ελληνικά');
  await expect.poll(() => readUserSettings(home)['damocles.desktop.language']).toBe('el');
  // The language applies at the next launch (D23); the running app stays English until then.
  await expect(overlay.getByTestId('settings-restart-banner').getByRole('button', { name: 'Restart now' })).toBeVisible();
  await expect(overlay.getByRole('heading', { name: 'Application' })).toBeVisible();
  await closeSettingsModal(overlay);

  // Restart now relaunches outside Playwright's control, so the test closes and launches as the relaunch would.
  await desktop.close();
  desktop = await launch();
  tab = await activeChat(desktop.app);
  await expectGreek(desktop.app, tab);
  const greekOverlay = await openSettingsModal(desktop.app, 'application');
  await expect(settingsRow(greekOverlay, 'damocles.desktop.language').getByRole('button', { name: 'Ελληνικά', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(greekOverlay.getByRole('heading', { name: 'Εφαρμογή' })).toBeVisible();
});

test('a first launch takes its language from the OS locale', async ({ launch }) => {
  const { app } = await launch({ args: ['--lang=el-GR'] });
  expect(await app.evaluate(({ app: electronApp }) => electronApp.getLocale())).toMatch(/^el/);
  const tab = await activeChat(app);
  await expectGreek(app, tab);
});
