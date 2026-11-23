import * as fs from 'node:fs';
import type { Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { readUserSettings, writeUserSettings } from './support/hermetic';
import { openSettingsModal, setContentSize, settingsRow } from './support/settings';
import { shellPage, shellState } from './support/shell';
import { chatInput, clickMenu, menuItemState } from './support/ui';
import { cssToken, dockShown, openAppearance, themeDir, themeEditorPage, writeTheme } from './support/themes';

// Settings › Appearance's theme gallery, the theme history, safe start and a picked theme's window arrangement
// (docs/desktop-app.md "Appearance", docs/invariants.md "Desktop themes"). Each test runs at the 1280 px window the design
// was drawn at and at the 900 px minimum.

const AURORA = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BLEACH = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const COLORS = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const LIGHT = { background: '#fbf8f1', panel: '#f1ece0', text: '#1f1a12', accent: '#a3461f', success: '#2f6b3a', warning: '#8a5a00', danger: '#a12a2a', info: '#2d5a99' };
// a user theme; its name is not the built-in example Aurora's
const aurora = { schemaVersion: 1, id: AURORA, name: 'Borealis', looks: { dark: { colors: COLORS }, light: { colors: LIGHT } } };
const BUILTIN_AURORA = 'damocles-aurora';
const BUILTIN_AURORA_BG = '#0b1020';
const bleach = { schemaVersion: 1, id: BLEACH, name: 'Bleach', looks: { dark: { colors: { ...COLORS, background: '#141413', panel: '#262624', text: '#f0eee6' } } } };
const AURORA_BG = 'rgb(26, 16, 51)';
const BUILTIN_DARK_BG = 'rgb(11, 15, 20)';

const WIDTHS = [1280, 900] as const;

async function background(page: Page): Promise<string> {
  return page.locator('body').evaluate((element) => getComputedStyle(element).backgroundColor);
}

for (const width of WIDTHS) {
  test.describe(`at ${width} px`, () => {
    // the design's Aurora is the built-in example, whose chat pane shows a wallpaper, so the look is read from --d-bg
    test('replays the design journey: a pick shows, and the arrow keys move the dark look across cards', async ({ home, launch }) => {
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': BUILTIN_AURORA });
      const { app } = await launch();
      const tab = await activeChat(app);
      await expect.poll(() => cssToken(tab, '--d-bg')).toBe(BUILTIN_AURORA_BG);
      const page = await openAppearance(app, width);

      await expect(page.getByRole('radiogroup', { name: 'Dark look', exact: true })).toBeAttached();
      await expect(page.getByRole('radiogroup', { name: 'Light look', exact: true })).toBeAttached();
      await expect(page.getByRole('radio', { name: 'Aurora, dark, active', exact: true })).toBeVisible();
      await expect(page.getByRole('img', { name: 'Aurora, dark and light looks', exact: true })).toBeVisible();
      await expect(page.getByTestId('theme-mode-status')).toHaveText('Showing Aurora, dark look. The mode is Dark. Your light look, Damocles, shows when the mode is Light.');

      // the design's S1 Installed steps
      await page.getByRole('radio', { name: 'Damocles, dark', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Damocles, dark, active', exact: true })).toBeVisible();
      await expect.poll(() => background(tab)).toBe(BUILTIN_DARK_BG);
      await page.getByRole('radio', { name: 'Damocles, dark, active', exact: true }).press('ArrowRight');
      await expect(page.getByRole('radio', { name: 'Aurora, dark, active', exact: true })).toBeVisible();
      await expect(page.getByRole('radio', { name: 'Aurora, dark, active', exact: true })).toBeFocused();
      await expect.poll(() => readUserSettings(home)['damocles.desktop.themes.dark']).toBe(BUILTIN_AURORA);
      await expect.poll(() => cssToken(tab, '--d-bg')).toBe(BUILTIN_AURORA_BG);

      // a light pick in Dark mode is pressed but not showing
      await page.getByRole('radio', { name: 'Aurora, light', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Aurora, light, selected', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(page.getByTestId('theme-toast')).toContainText('Light look: Aurora');
      // the toast's Undo takes the light pick back
      await page.getByTestId('theme-toast').getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Damocles, light, selected', exact: true })).toBeVisible();
      await expect.poll(() => readUserSettings(home)['damocles.desktop.themes.light']).toBeUndefined();
    });

    test('renames, duplicates and deletes from a card\'s More menu, and Undo brings a deleted theme back', async ({ home, launch }) => {
      writeTheme(home, BLEACH, bleach);
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': BLEACH });
      const { app } = await launch();
      await activeChat(app);
      const page = await openAppearance(app, width);

      // a built-in's menu holds only View, Duplicate and Export
      await page.getByRole('button', { name: 'More actions for Damocles', exact: true }).click();
      await expect(page.getByRole('menuitem')).toHaveText(['View', 'Duplicate to edit', 'Export…']);
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'More actions for Bleach', exact: true }).click();
      await expect(page.getByRole('menuitem')).toHaveText(['Edit', 'Duplicate', 'Rename…', 'Export…', 'Delete…']);
      await page.getByRole('menuitem', { name: 'Rename…' }).click();
      const rename = page.getByRole('dialog', { name: 'Rename theme' });
      await expect(rename).toBeVisible();
      await rename.getByLabel('Name', { exact: true }).fill('   ');
      await rename.getByRole('button', { name: 'Rename', exact: true }).click();
      await expect(rename).toContainText('Enter a name.');
      await rename.getByLabel('Name', { exact: true }).fill('Bleach Nights');
      await rename.getByRole('button', { name: 'Rename', exact: true }).click();
      await expect(rename).toBeHidden();
      await expect(page.getByTestId('theme-toast')).toContainText('Renamed to Bleach Nights.');
      await expect(page.getByRole('radio', { name: 'Bleach Nights, dark, active', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'More actions for Bleach Nights', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Delete…' }).click();
      const confirm = page.getByRole('alertdialog', { name: 'Delete “Bleach Nights”?' });
      await expect(confirm).toContainText('It is your dark look now, so Damocles, dark look takes its place.');
      await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(confirm).toBeHidden();
      await expect(page.getByTestId('theme-toast')).toContainText('Deleted Bleach Nights.');
      await expect(page.getByTestId('theme-missing-dark')).toBeVisible();
      expect(fs.existsSync(themeDir(home, BLEACH))).toBe(false);
      await page.getByTestId('theme-toast').getByRole('button', { name: 'Undo', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Bleach Nights, dark, active', exact: true })).toBeVisible();
      expect(fs.existsSync(themeDir(home, BLEACH))).toBe(true);

      // Duplicate makes a copy and opens it in the editor beside the window, Settings closed
      await page.getByRole('button', { name: 'More actions for Bleach Nights', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Duplicate', exact: true }).click();
      const editor = await themeEditorPage(app);
      await expect(editor.getByTestId('theme-editor-name')).toHaveText('Bleach Nights copy');
      await dockShown(app);
      await expect(page.getByTestId('settings-modal')).toBeHidden();
    });

    test('lists every change with who made it, and Restore puts back an entry and every later one as one change', async ({ home, launch }) => {
      writeTheme(home, AURORA, aurora);
      writeTheme(home, BLEACH, bleach);
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
      const { app } = await launch();
      const tab = await activeChat(app);
      const page = await openAppearance(app, width);
      const history = page.getByRole('dialog', { name: 'Theme history' });

      await page.getByRole('button', { name: 'History', exact: true }).click();
      await expect(history).toContainText('No theme changes yet');
      await page.keyboard.press('Escape');

      await page.getByRole('radio', { name: 'Borealis, dark', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Borealis, dark, active', exact: true })).toBeVisible();
      await page.getByRole('radio', { name: 'Bleach, dark', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Bleach, dark, active', exact: true })).toBeVisible();

      await page.getByRole('button', { name: 'History', exact: true }).click();
      await expect(history.getByRole('listitem')).toHaveCount(2);
      await expect(history.getByRole('listitem').first()).toContainText('Dark look: Bleach (was Borealis)');
      await expect(history.getByRole('listitem').first()).toContainText('You · ');
      await history.getByRole('button', { name: 'Restore: before Dark look: Borealis (was Damocles)', exact: true }).click();
      await expect(history).toBeHidden();
      await expect(page.getByRole('radio', { name: 'Damocles, dark, active', exact: true })).toBeVisible();
      await expect.poll(() => background(tab)).toBe(BUILTIN_DARK_BG);
      await expect(page.getByTestId('theme-toast')).toContainText('Restored to before: Dark look: Borealis (was Damocles)');

      // the restore is one change Undo reverses
      await page.getByRole('button', { name: 'Undo theme change', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Bleach, dark, active', exact: true })).toBeVisible();
      await expect(page.getByTestId('theme-toast')).toContainText('Undid: Restored to before: Dark look: Borealis (was Damocles)');

      // the history outlives a relaunch
      await app.close();
      const relaunched = await launch();
      await activeChat(relaunched.app);
      const again = await openAppearance(relaunched.app, width);
      await again.getByRole('button', { name: 'History', exact: true }).click();
      await expect(again.getByRole('dialog', { name: 'Theme history' }).getByRole('listitem')).toHaveCount(2);
    });

    test('a manual pick applies the theme\'s window arrangement, and Undo Theme Change gives the previous one back', async ({ home, launch }) => {
      const layout = { grid: { slots: { main: 'chat', side: 'terminal', bottom: 'editor' }, visible: { editor: true, terminal: true }, sideWidth: 380, bottomHeight: 180 }, sidebarWidth: 300 };
      writeTheme(home, AURORA, { ...aurora, layout });
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
      const { app } = await launch();
      await activeChat(app);
      const before = await shellState(app);
      const page = await openAppearance(app, width);
      await page.getByRole('radio', { name: 'Borealis, dark', exact: true }).click();
      await expect.poll(async () => (await shellState(app)).layout.grid.slots).toEqual(layout.grid.slots);
      const after = await shellState(app);
      expect(after.layoutRevision).toBeGreaterThan(before.layoutRevision);
      expect(after.layout.grid.visible).toEqual({ editor: true, terminal: true });
      expect(after.layout.sidebarWidth).toBe(300);

      // a pick of the built-in look, which has none, keeps the window's arrangement
      await page.getByRole('radio', { name: 'Damocles, dark', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Damocles, dark, active', exact: true })).toBeVisible();
      expect((await shellState(app)).layout.grid.slots).toEqual(layout.grid.slots);
      await page.keyboard.press('Escape');

      // Undo Theme Change from the View menu: never hidden or disabled
      const undo = async (): Promise<void> => {
        expect(await menuItemState(app, 'damocles.themes.undo')).toMatchObject({ enabled: true, visible: true });
        await clickMenu(app, 'damocles.themes.undo');
      };
      await undo();
      await expect.poll(() => readUserSettings(home)['damocles.desktop.themes.dark']).toBe(AURORA);
      await undo();
      await expect.poll(async () => (await shellState(app)).layout.grid.slots).toEqual(before.layout.grid.slots);
      expect((await shellState(app)).layout.sidebarWidth).toBe(before.layout.sidebarWidth);
      expect(await menuItemState(app, 'damocles.themes.restartWithDefault')).toEqual({ enabled: true, visible: true, accelerator: null });
      expect(await menuItemState(app, 'damocles.themes.undo')).toMatchObject({ enabled: true, visible: true });
    });
  });
}

test('safe start shows the default theme with its banner until Use my theme', async ({ home, launch }) => {
  writeTheme(home, AURORA, aurora);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AURORA });
  const { app } = await launch({ args: ['--damocles-safe-theme'] });
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  await expect(chatInput(tab)).toBeVisible();
  const banner = shell.getByRole('region', { name: 'Started with the default theme.' });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('data-trusted', '');
  expect(await background(tab)).toBe(BUILTIN_DARK_BG);
  for (const width of WIDTHS) {
    await setContentSize(app, width, 820);
    await expect(banner.getByRole('button', { name: 'Use my theme', exact: true })).toBeVisible();
  }
  const overlay = await openSettingsModal(app, 'appearance');
  await expect(settingsRow(overlay, 'damocles.desktop.theme').getByTestId('theme-mode-status')).toHaveText('Showing Damocles, dark look: your theme is paused for this run.');
  await overlay.keyboard.press('Escape');
  await banner.getByRole('button', { name: 'Use my theme', exact: true }).click();
  await expect(banner).toBeHidden();
  await expect.poll(() => background(tab)).toBe(AURORA_BG);
  // safe start is the run's: the preferred look is untouched
  expect(readUserSettings(home)['damocles.desktop.themes.dark']).toBe(AURORA);
});

test('two renderer crashes within a minute under a custom theme switch the run to safe start and say why', async ({ home, launch }) => {
  test.skip(process.platform === 'linux', 'Electron ignores forcefullyCrashRenderer for sandboxed renderers on Linux; crash-loop.test.ts covers the count');
  writeTheme(home, AURORA, aurora);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': AURORA });
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect.poll(() => background(tab)).toBe(AURORA_BG);
  const crash = (part: string): Promise<void> => app.evaluate(({ webContents }, urlPart) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL().includes(urlPart));
    if (!target) throw new Error(`no webContents shows ${urlPart}`);
    target.forcefullyCrashRenderer();
  }, part);
  // read through main, since Playwright's page of a crashed renderer stays unusable after main reloads it
  const inShell = (script: string): Promise<string> => app.evaluate(async ({ webContents }, code) => {
    const shell = webContents.getAllWebContents().find((contents) => contents.getURL().endsWith('/shell/index.html'));
    if (!shell || shell.isCrashed() || shell.isLoading()) return '';
    // a renderer forcefullyCrashRenderer just ended may not say so yet, and its frame goes while the script waits
    return String(await shell.executeJavaScript(code).catch(() => ''));
  }, script);
  const banner = `document.querySelector('[data-testid="safe-start-banner"]')?.textContent ?? 'none'`;
  await crash('/shell/index.html');
  await expect.poll(() => inShell(banner), { timeout: 20_000 }).toBe('none');
  await crash('/panel/');
  await expect.poll(() => inShell(banner), { timeout: 20_000 }).toContain('Damocles switched to the default theme because the window kept crashing.');
  expect(await inShell(`getComputedStyle(document.documentElement).getPropertyValue('--d-bg').trim()`)).toBe('#0b0f14');
});
