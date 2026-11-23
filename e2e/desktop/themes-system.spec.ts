import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { BUILTIN_PALETTES } from '../../src/shared/themes/builtin';
import { deriveLook } from '../../src/shared/themes/derive';
import { kdeRoles, LIBADWAITA_SEEDS } from '../../src/shared/themes/schemes';
import { systemTheme } from '../../src/shared/themes/system-theme';
import type { ThemePalette } from '../../src/shared/themes/tokens';
import { activeChat, expect, test } from './support/fixtures';
import { appData, readSettingsFile, readUserSettings, type HermeticHome } from './support/hermetic';
import { shellPage } from './support/shell';
import { cssToken, dockShown, HOOKS, openAppearance, openThemeEditor, readTheme, themeDir, themeDockView, themeEditorPage, themeHooks } from './support/themes';
import { chatInput, clickMenu, setLook } from './support/ui';

// The System colors theme (docs/themes.md "The System colors theme"): a new install starts on it, it follows the OS colors
// with no keep-changes banner, its copy is a snapshot, Reset lands on it, and a missing theme still shows Damocles. Main's
// `systemColors` hook stands in for the OS: no test here changes the machine's accent. The Linux cases give the launch a
// desktop's environment and its config files under the hermetic XDG_CONFIG_HOME.

const SYSTEM = 'damocles-system';
const DARK = 'damocles.desktop.themes.dark';
const LIGHT = 'damocles.desktop.themes.light';
const BLUE = '#0078d4';
const RED = '#e81123';
const GREEN = '#107c10';

/** The dark palette System colors derives for an OS accent, as main and the gallery derive it. */
function darkPalette(accent: string): ThemePalette {
  const look = systemTheme({ accent }).looks.dark!;
  return deriveLook(look.colors, 'dark', look.tokens);
}

const preferred = (home: HermeticHome): unknown[] => [readUserSettings(home)[DARK], readUserSettings(home)[LIGHT]];
const globalState = (home: HermeticHome): Record<string, unknown> => readSettingsFile(path.join(home.userData, 'state', 'global.json'));

async function expectAccent(pages: Page[], palette: ThemePalette): Promise<void> {
  for (const page of pages) {
    await expect.poll(() => cssToken(page, '--d-accent')).toBe(palette['--d-accent']);
    expect(await cssToken(page, '--d-accent-fill')).toBe(palette['--d-accent-fill']);
  }
}

/** The accent a card's miniature draws for its dark look: the first window group of its drawing. */
const miniatureAccent = (card: ReturnType<Page['getByTestId']>): Promise<string> =>
  card.getByTestId('theme-miniature').locator('g[style*="--m-accent"]').first().evaluate((group) => (group as SVGElement).style.getPropertyValue('--m-accent').trim());

const userThemeIds = (home: HermeticHome): string[] => {
  const dir = path.join(home.damoclesDir, 'themes', 'themes');
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
};

test.describe('on a new install', () => {
  test.use({ newInstall: true });

  test('starts on System colors, repaints on an accent change with no keep-changes banner, and the Settings card and the read-only editor follow', async ({ home, launch }) => {
    // the premise of a new install: nothing of an earlier run, ~/.damocles included
    expect(fs.existsSync(path.join(home.userData, 'state'))).toBe(false);
    expect(fs.existsSync(home.damoclesDir)).toBe(false);

    const { app } = await launch(HOOKS);
    const hooks = themeHooks(app);
    const tab = await activeChat(app);
    const shell = await shellPage(app);
    await expect(chatInput(tab)).toBeVisible();
    expect(await hooks.shown()).toMatchObject({ themeId: SYSTEM, decidedBy: 'system', themeSource: 'system' });
    expect(preferred(home)).toEqual([SYSTEM, SYSTEM]);
    await expect.poll(() => globalState(home)['damocles.desktop.themes.defaultDecided']).toBe(true);

    await setLook(app, 'dark');
    await hooks.systemColors({ accent: BLUE });
    await expectAccent([tab, shell], darkPalette(BLUE));
    // the surfaces are Damocles' own: the accent is all that this platform's stand-in gives
    expect(await cssToken(tab, '--d-bg')).toBe(BUILTIN_PALETTES.dark['--d-bg']);

    // the premise of every repaint check below: the two accents derive different tokens
    expect(darkPalette(RED)['--d-accent']).not.toBe(darkPalette(BLUE)['--d-accent']);
    expect(darkPalette(GREEN)['--d-accent']).not.toBe(darkPalette(RED)['--d-accent']);
    await hooks.systemColors({ accent: RED });
    await expectAccent([tab, shell], darkPalette(RED));
    await expect(shell.getByTestId('keep-changes-banner')).toHaveCount(0);
    expect(await hooks.shown()).toMatchObject({ themeId: SYSTEM, kind: 'dark' });
    expect(preferred(home)).toEqual([SYSTEM, SYSTEM]);

    const overlay = await openAppearance(app, 1280);
    const card = overlay.getByTestId(`theme-card-${SYSTEM}`);
    await expect(card).toContainText('System colors');
    await expect(overlay.getByRole('radio', { name: 'System colors, dark, active', exact: true })).toBeVisible();
    await expect(overlay.getByRole('radio', { name: 'System colors, light, selected', exact: true })).toBeVisible();
    await expect(overlay.getByTestId('theme-mode-status')).toContainText('Showing System colors, dark look.');
    await expect.poll(() => miniatureAccent(card)).toBe(darkPalette(RED)['--d-accent-fill']);
    // Settings is trusted UI: it takes the shown palette only while every text passes, which System colors always does
    expect(await cssToken(overlay, '--d-accent')).toBe(darkPalette(RED)['--d-accent']);

    // with Settings open: the card follows at once, and neither the first launch nor an OS change is a theme change to undo
    await hooks.systemColors({ accent: GREEN });
    await expect.poll(() => miniatureAccent(card)).toBe(darkPalette(GREEN)['--d-accent-fill']);
    await expectAccent([tab, shell, overlay], darkPalette(GREEN));
    await expect(shell.getByTestId('keep-changes-banner')).toHaveCount(0);
    await overlay.getByRole('button', { name: 'History', exact: true }).click();
    await expect(overlay.getByRole('dialog', { name: 'Theme history' })).toContainText('No theme changes yet');
    await overlay.keyboard.press('Escape');

    await overlay.getByRole('button', { name: 'More actions for System colors', exact: true }).click();
    await expect(overlay.getByRole('menuitem')).toHaveText(['View', 'Duplicate to edit', 'Export…']);
    await overlay.keyboard.press('Escape');
    const editor = await openThemeEditor(app, 'System colors', { item: 'View', from: overlay });
    await expect(editor.getByText('System colors is built in and read-only. Duplicate it to edit.')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    const accentField = editor.getByLabel('Accent hex', { exact: true });
    await expect(accentField).toHaveAttribute('readonly', '');
    await expect(accentField).toHaveValue(GREEN);
    await hooks.systemColors({ accent: BLUE });
    await expect(accentField).toHaveValue(BLUE);
    await expect(editor.getByText('System colors is built in and read-only. Duplicate it to edit.')).toBeVisible();
    await expectAccent([tab, shell], darkPalette(BLUE));
  });

  test("gives the computer's own colors back when the stand-in for the OS ends", async ({ launch }) => {
    const { app } = await launch(HOOKS);
    const hooks = themeHooks(app);
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await setLook(app, 'dark');
    expect(await hooks.shown()).toMatchObject({ themeId: SYSTEM, kind: 'dark' });
    const own = await cssToken(tab, '--d-accent');
    // an accent the machine's own does not derive, so each step below changes the token
    const standIn = [RED, GREEN].find((accent) => darkPalette(accent)['--d-accent'] !== own)!;
    await hooks.systemColors({ accent: standIn });
    await expectAccent([tab], darkPalette(standIn));
    await hooks.systemColors(null);
    await expect.poll(() => cssToken(tab, '--d-accent')).toBe(own);
    expect(await hooks.shown()).toMatchObject({ themeId: SYSTEM, kind: 'dark' });
  });

  test('Duplicate copies the colors of that moment, Reset lands on System colors, and deleting the theme in use shows Damocles', async ({ home, launch }) => {
    const { app } = await launch(HOOKS);
    const hooks = themeHooks(app);
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await setLook(app, 'dark');
    await hooks.systemColors({ accent: BLUE });
    await expectAccent([tab], darkPalette(BLUE));

    const overlay = await openAppearance(app, 1280);
    await overlay.getByRole('button', { name: 'More actions for System colors', exact: true }).click();
    await overlay.getByRole('menuitem', { name: 'Duplicate to edit' }).click();
    const editor = await themeEditorPage(app);
    await expect(editor.getByTestId('theme-editor-name')).toHaveText('System colors copy');
    await dockShown(app);
    await expect(editor.getByLabel('Accent hex', { exact: true })).toHaveValue(BLUE);
    const [copyId, ...others] = userThemeIds(home);
    expect(others).toEqual([]);
    const blueLooks = systemTheme({ accent: BLUE }).looks;
    expect(readTheme(home, copyId!)).toMatchObject({ name: 'System colors copy', looks: blueLooks, origin: { kind: 'duplicate', from: SYSTEM } });

    // the OS changes afterwards: the copy does not, and its editor keeps painting its draft until it closes
    await hooks.systemColors({ accent: RED });
    await expect(editor.getByLabel('Accent hex', { exact: true })).toHaveValue(BLUE);
    await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(async () => (await themeDockView(app))?.visible).toBe(false);
    await expectAccent([tab], darkPalette(RED));
    expect(readTheme(home, copyId!)['looks']).toEqual(blueLooks);
    const settings = await openAppearance(app, 1280);
    await settings.getByRole('radio', { name: 'System colors copy, dark', exact: true }).click();
    await expect(settings.getByRole('radio', { name: 'System colors copy, dark, active', exact: true })).toBeVisible();
    await expect.poll(async () => (await hooks.shown()).themeId).toBe(copyId);
    await expectAccent([tab], darkPalette(BLUE));
    await hooks.systemColors({ accent: GREEN });
    await expect.poll(() => miniatureAccent(settings.getByTestId(`theme-card-${SYSTEM}`))).toBe(darkPalette(GREEN)['--d-accent-fill']);
    expect(await miniatureAccent(settings.getByTestId(`theme-card-${copyId}`))).toBe(darkPalette(BLUE)['--d-accent-fill']);
    expect(await cssToken(tab, '--d-accent')).toBe(darkPalette(BLUE)['--d-accent']);

    // Reset gives what a new install gets
    await clickMenu(app, 'damocles.themes.resetToDefault');
    await expect.poll(() => preferred(home)).toEqual([SYSTEM, SYSTEM]);
    await expect.poll(async () => (await hooks.shown()).themeId).toBe(SYSTEM);
    await expectAccent([tab], darkPalette(GREEN));
    await expect(settings.getByRole('radio', { name: 'System colors, dark, active', exact: true })).toBeVisible();

    // a deleted theme in use is a missing theme, which shows Damocles' fixed look and writes no setting
    await settings.getByRole('radio', { name: 'System colors copy, dark', exact: true }).click();
    await expect.poll(async () => (await hooks.shown()).themeId).toBe(copyId);
    await settings.getByRole('button', { name: 'More actions for System colors copy', exact: true }).click();
    await settings.getByRole('menuitem', { name: 'Delete…' }).click();
    const confirm = settings.getByRole('alertdialog', { name: 'Delete “System colors copy”?' });
    await expect(confirm).toContainText('It is your dark look now, so Damocles, dark look takes its place.');
    await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(settings.getByTestId('theme-missing-dark')).toBeVisible();
    await expect.poll(async () => (await hooks.shown()).themeId).toBe('damocles');
    await expectAccent([tab], BUILTIN_PALETTES.dark);
    expect(fs.existsSync(themeDir(home, copyId!))).toBe(false);
    expect(preferred(home)).toEqual([copyId, SYSTEM]);
  });
});

test.describe('on a Linux desktop', () => {
  test.skip(process.platform !== 'linux', "reads a Linux desktop's own files");
  test.use({ newInstall: true });

  // a dark KDE scheme written for this test, whose colors System colors keeps as they are
  const kdeglobals = (background: string): string => [
    '[Colors:View]', `BackgroundNormal=${background}`, 'ForegroundNormal=230,230,235', 'ForegroundInactive=160,165,175',
    'ForegroundActive=90,170,240', 'ForegroundNegative=240,90,100', 'ForegroundNeutral=240,170,60', 'ForegroundPositive=90,200,120',
    '[Colors:Window]', 'BackgroundNormal=38,42,51', '[Colors:Selection]', 'BackgroundNormal=90,140,230', '',
  ].join('\n');
  const keptBackground = (text: string): string | undefined => systemTheme({ palettes: kdeRoles(text, 'kdeglobals').palettes }).looks.dark?.colors.background;

  test("in a KDE session --d-bg follows kdeglobals' View background, and repaints when the file is replaced by a rename", async ({ home, launch }) => {
    expect([keptBackground(kdeglobals('30,32,40')), keptBackground(kdeglobals('20,22,30'))]).toEqual(['#1e2028', '#14161e']);
    const file = path.join(appData(home), 'kdeglobals');
    fs.writeFileSync(file, kdeglobals('30,32,40'));
    const { app } = await launch({ env: { ...HOOKS.env, XDG_CURRENT_DESKTOP: 'KDE' } });
    const tab = await activeChat(app);
    const shell = await shellPage(app);
    await expect(chatInput(tab)).toBeVisible();
    await setLook(app, 'dark');
    expect(await themeHooks(app).shown()).toMatchObject({ themeId: SYSTEM, kind: 'dark' });
    await expect.poll(() => cssToken(tab, '--d-bg')).toBe('#1e2028');

    // KConfig replaces kdeglobals through a temporary file renamed over it
    fs.writeFileSync(`${file}.new`, kdeglobals('20,22,30'));
    fs.renameSync(`${file}.new`, file);
    await expect.poll(() => cssToken(tab, '--d-bg')).toBe('#14161e');
    expect(await cssToken(shell, '--d-bg')).toBe('#14161e');
    await expect(shell.getByTestId('keep-changes-banner')).toHaveCount(0);
  });

  test("on GNOME it is libadwaita under the user's gtk.css, and switches with dark and light", async ({ home, launch }) => {
    const css = path.join(appData(home), 'gtk-4.0', 'gtk.css');
    fs.mkdirSync(path.dirname(css), { recursive: true });
    fs.writeFileSync(css, '@media (prefers-color-scheme: dark) {\n  @define-color view_bg_color #101418;\n}\n@media (prefers-color-scheme: light) {\n  @define-color view_bg_color #f4f6fa;\n}\n');
    // the premise: libadwaita's colors over these backgrounds keep contrast, so System colors keeps the backgrounds
    for (const [kind, background] of [['dark', '#101418'], ['light', '#f4f6fa']] as const) {
      const seeds = { ...LIBADWAITA_SEEDS[kind], background };
      expect(systemTheme({ palettes: { [kind]: { kind, seeds, tokens: {} } } }).looks[kind]?.colors.background).toBe(background);
    }
    const { app } = await launch({ env: { ...HOOKS.env, XDG_CURRENT_DESKTOP: 'ubuntu:GNOME' } });
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await setLook(app, 'dark');
    await expect.poll(() => cssToken(tab, '--d-bg')).toBe('#101418');
    await setLook(app, 'light');
    await expect.poll(() => cssToken(tab, '--d-bg')).toBe('#f4f6fa');
    expect(await cssToken(tab, '--d-panel')).toBe(deriveLook({ ...LIBADWAITA_SEEDS.light, background: '#f4f6fa' }, 'light')['--d-panel']);
  });
});

// a user of the VS Code extension has ~/.damocles and no app state; the seed cannot tell them from an earlier desktop install
test.describe('on a computer with ~/.damocles and no app state', () => {
  test.use({ newInstall: true });

  test('keeps the built-in look, writes no preferred look and decides once', async ({ home, launch }) => {
    fs.mkdirSync(path.join(home.damoclesDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home.damoclesDir, 'settings.json'), '{}\n');
    expect(fs.existsSync(path.join(home.userData, 'state'))).toBe(false);

    const { app } = await launch(HOOKS);
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    expect(await themeHooks(app).shown()).toMatchObject({ themeId: 'damocles', decidedBy: 'system' });
    expect(preferred(home)).toEqual([undefined, undefined]);
    await expect.poll(() => globalState(home)['damocles.desktop.themes.defaultDecided']).toBe(true);
  });
});

test('a home Damocles already ran on keeps the built-in look, whatever the OS colors are', async ({ home, launch }) => {
  const { app } = await launch(HOOKS);
  const hooks = themeHooks(app);
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  expect(await hooks.shown()).toMatchObject({ themeId: 'damocles', decidedBy: 'system' });
  expect(preferred(home)).toEqual([undefined, undefined]);

  await setLook(app, 'dark');
  await hooks.systemColors({ accent: RED });
  // System colors is installed and follows the OS; the window does not show it
  const overlay = await openAppearance(app, 1280);
  await expect.poll(() => miniatureAccent(overlay.getByTestId(`theme-card-${SYSTEM}`))).toBe(darkPalette(RED)['--d-accent-fill']);
  await expect(overlay.getByRole('radio', { name: 'Damocles, dark, active', exact: true })).toBeVisible();
  expect(await hooks.shown()).toMatchObject({ themeId: 'damocles', kind: 'dark' });
  for (const token of ['--d-accent', '--d-accent-fill', '--d-bg', '--d-text'] as const) expect(await cssToken(tab, token), token).toBe(BUILTIN_PALETTES.dark[token]);
  expect(preferred(home)).toEqual([undefined, undefined]);
});
