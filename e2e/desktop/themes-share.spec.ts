import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { mainLog, type DesktopApp, type LaunchOptions } from './support/app';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { call, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { setPageSize } from './support/screenshots';
import { setContentSize, settingsModal } from './support/settings';
import { overlayPage, shellPage, shellState } from './support/shell';
import { controlReady, cssToken, loadThemeTools, openAppearance, readTheme, themeHooks, windowShowsWallpapers, writeTheme } from './support/themes';
import { answerOpenDialog, answerSaveDialog, chatInput, saveDialogDefaults } from './support/ui';

// Sharing themes (docs/desktop-app.md "Appearance", docs/invariants.md "Desktop themes"): Import and Install from link end at
// the install card as a Settings dialog, Export writes one .damocles-theme file, the agent's ThemeSet install docks the same
// card in the chat, and a damocles:// link from a second launch opens it in Settings. Downloads read https://e2e.test/<name>
// from a fixture folder through the e2e hooks' seam, which replaces only the network transport.

const CHECKED = { timeout: 30_000 };
const ARCHIVE_ID = '5d1c2b3a-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const AURORA = 'Aurora Borealis';
const COLORS = { background: '#0b1a2a', panel: '#10263a', text: '#e8f4ff', accent: '#5be3c0', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const LIGHT = { background: '#f4fbff', panel: '#e6f2f8', text: '#10202a', accent: '#1f6f5c', success: '#2f6b3a', warning: '#8a5a00', danger: '#a12a2a', info: '#2d5a99' };
const ARCHIVE_THEME = { schemaVersion: 1, id: ARCHIVE_ID, name: AURORA, author: 'nlights', license: 'MIT', looks: { dark: { colors: COLORS }, light: { colors: LIGHT } }, layout: { sidebarWidth: 280 } };
const RECOLORED = '#ff4040';
const FILE_NAME = 'aurora-borealis.damocles-theme';
const BLEACH = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const bleach = { schemaVersion: 1, id: BLEACH, name: 'Bleach', looks: { dark: { colors: { ...COLORS, background: '#141413', panel: '#262624', text: '#f0eee6' } } } };

/** A .damocles-theme file holding only theme.json, written to `dir`. */
function writeArchive(dir: string, theme: unknown = ARCHIVE_THEME, name = FILE_NAME): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, zipSync({ 'theme.json': strToU8(JSON.stringify(theme)) }));
  return file;
}

/** The installed user themes core wrote, by name. */
function installed(home: HermeticHome): { id: string; name: string; theme: Record<string, unknown> }[] {
  const root = path.join(home.damoclesDir, 'themes', 'themes');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).flatMap((id) => {
    const file = path.join(root, id, 'theme.json');
    if (!fs.existsSync(file)) return [];
    const theme = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    return [{ id, name: String(theme['name']), theme }];
  });
}

const darkAccent = (theme: Record<string, unknown>): string => (theme['looks'] as { dark: { colors: { accent: string } } }).dark.colors.accent;

const DOWNLOADS = (home: HermeticHome): string => path.join(home.root, 'theme-downloads');
const seamEnv = (home: HermeticHome): Record<string, string> => ({ DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_THEME_DOWNLOADS: DOWNLOADS(home) });

const installCard = (page: Page, name = AURORA): Locator => page.getByRole('region', { name: `Install “${name}”?`, exact: true });
const installDialog = (overlay: Page): Locator => overlay.getByTestId('theme-install-dialog');

/** The install card once its visibility check lets its controls act: until then the trusted card holds every click. */
async function cardReady(page: Page, name = AURORA): Promise<Locator> {
  const card = installCard(page, name);
  await expect(card).toBeVisible(CHECKED);
  await controlReady(card.getByTestId('theme-install-go'));
  return card;
}

async function importFile(overlay: Page): Promise<void> {
  await overlay.getByRole('button', { name: 'Import…', exact: true }).click();
  const dialog = overlay.getByRole('dialog', { name: 'Import a theme', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Choose file…', exact: true }).click();
  await cardReady(overlay);
}

test('Import of an archive: Cancel installs nothing, Install installs it under a new id, a clash keeps both or replaces', async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const archive = writeArchive(path.join(home.root, 'shared'));
  const { app } = await launch();
  await activeChat(app);
  await answerOpenDialog(app, archive);
  const overlay = await openAppearance(app, 1280);

  // the card names the file, lists what it holds, and its arrangement opt-in starts off
  await importFile(overlay);
  const card = installCard(overlay);
  await expect(card.getByTestId('theme-install-source')).toHaveText(`From the file ${FILE_NAME}`);
  await expect(card.getByRole('img', { name: 'Aurora Borealis, dark and light looks', exact: true })).toBeVisible();
  await expect(card.getByLabel('Use this theme\'s window arrangement', { exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(card.getByText('Off: your arrangement stays as it is.', { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden();
  expect(installed(home)).toEqual([]);

  // install without a clash: a toast confirms, the gallery lists it, and the archive's id is not kept
  await importFile(overlay);
  await installCard(overlay).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  await expect(overlay.getByTestId('theme-toast')).toContainText('Installed Aurora Borealis. Pick it as your dark or light look on Installed.');
  await expect(overlay.getByRole('radio', { name: 'Aurora Borealis, dark', exact: true })).toBeVisible();
  const first = installed(home);
  expect(first.map((entry) => entry.name)).toEqual([AURORA]);
  expect(first[0]!.id).not.toBe(ARCHIVE_ID);

  // the same file again clashes: Keep both is the default and names the new theme
  await importFile(overlay);
  await expect(installCard(overlay).getByRole('radio', { name: 'Keep both', exact: true })).toHaveAttribute('aria-checked', 'true');
  await installCard(overlay).getByRole('button', { name: 'Install as “Aurora Borealis 2”', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  await expect(overlay.getByRole('radio', { name: 'Aurora Borealis 2, dark', exact: true })).toBeVisible();
  expect(installed(home).map((entry) => entry.name).sort()).toEqual([AURORA, 'Aurora Borealis 2']);

  // Replace writes the new file under the replaced theme's id, so its picks and references hold; the archive here has the
  // same name and another accent, so a Replace that wrote nothing would show
  const recolored = { ...ARCHIVE_THEME, looks: { ...ARCHIVE_THEME.looks, dark: { colors: { ...COLORS, accent: RECOLORED } } } };
  await answerOpenDialog(app, writeArchive(path.join(home.root, 'shared'), recolored, 'aurora-2.damocles-theme'));
  await importFile(overlay);
  await installCard(overlay).getByRole('radio', { name: 'Replace', exact: true }).click();
  await installCard(overlay).getByRole('button', { name: 'Replace and install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  const after = installed(home);
  expect(after.map((entry) => entry.name).sort()).toEqual([AURORA, 'Aurora Borealis 2']);
  const replaced = after.find((entry) => entry.name === AURORA)!;
  expect(replaced.id).toBe(first[0]!.id);
  expect(darkAccent(replaced.theme)).toBe(RECOLORED);
  expect(darkAccent(after.find((entry) => entry.name === 'Aurora Borealis 2')!.theme)).toBe(COLORS.accent);
});

test('Import of a base16 scheme: the card names the scheme and how it converts, and the installed theme paints base00 as the background', async ({ home, launch }) => {
  test.setTimeout(180_000);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const palette = ['#1d2021', '#3c3836', '#504945', '#665c54', '#bdae93', '#d5c4a1', '#ebdbb2', '#fbf1c7', '#fb4934', '#fe8019', '#fabd2f', '#b8bb26', '#8ec07c', '#83a598', '#d3869b', '#d65d0e'];
  const scheme = ['system: "base16"', 'name: "Fixture Gruvbox"', 'author: "e2e"', 'variant: "dark"', 'palette:', ...palette.map((color, i) => `  base0${i.toString(16).toUpperCase()}: "${color}"`)].join('\n');
  const file = path.join(home.root, 'shared', 'fixture-gruvbox.yaml');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, scheme);
  const { app } = await launch();
  await activeChat(app);
  await answerOpenDialog(app, file);
  const overlay = await openAppearance(app, 1280);

  await overlay.getByRole('button', { name: 'Import…', exact: true }).click();
  await overlay.getByRole('dialog', { name: 'Import a theme', exact: true }).getByRole('button', { name: 'Choose file…', exact: true }).click();
  const card = await cardReady(overlay, 'Fixture Gruvbox');
  await expect(card.getByTestId('theme-install-source')).toHaveText('A base16 or base24 scheme, from the file fixture-gruvbox.yaml');
  await expect(card.getByTestId('theme-install-conversion')).toBeVisible();
  // base03, the comment color, is about 2.5:1 on base00, so the card lists it
  await expect(card.getByTestId('theme-install-contrast')).toBeVisible();
  await card.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);

  const [entry] = installed(home);
  expect(entry!.theme['origin']).toMatchObject({ kind: 'base16' });
  const pick = overlay.getByRole('radio', { name: 'Fixture Gruvbox, dark', exact: true });
  await expect(overlay.getByText('Imported from a base16 or base24 scheme · Dark only', { exact: true })).toBeVisible();
  await pick.click();
  // the shell paints the shown look; Settings is trusted UI and keeps the built-in palette, since base03 is below 4.5:1 here
  await expect.poll(async () => cssToken(await shellPage(app), '--d-bg')).toBe(palette[0]);
});

test('Import of a KDE color scheme and a Qt palette: each card names its format, the Qt card says its status colors come from Damocles, and each installed theme paints its background', async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const dir = path.join(home.root, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  // written for this test in each format's layout
  const kde = path.join(dir, 'FixtureDusk.colors');
  fs.writeFileSync(kde, [
    '[Colors:View]', 'BackgroundNormal=24,26,36', 'ForegroundNormal=225,226,235', 'ForegroundPositive=90,200,120', 'ForegroundNeutral=235,175,60',
    'ForegroundNegative=240,95,100', 'ForegroundActive=110,165,250', '', '[Colors:Window]', 'BackgroundNormal=32,34,46', '',
    '[General]', 'AccentColor=200,120,240', 'Name=Fixture Dusk', 'Name[el]=Σούρουπο', '',
  ].join('\n'));
  const qtRoles: Readonly<Record<number, string>> = { 6: '#ffe6e9ef', 9: '#ff121820', 10: '#ff1a2230', 12: '#ff4c8bf5', 14: '#ff7fb0ff' };
  const qt = path.join(dir, 'fixture-graphite.conf');
  fs.writeFileSync(qt, `[ColorScheme]\nactive_colors=${Array.from({ length: 21 }, (_, i) => qtRoles[i] ?? '#ff808080').join(', ')}\n`);
  const { app } = await launch();
  await activeChat(app);
  await answerOpenDialog(app, kde);
  const overlay = await openAppearance(app, 1280);
  const importScheme = async (name: string): Promise<Locator> => {
    await overlay.getByRole('button', { name: 'Import…', exact: true }).click();
    await overlay.getByRole('dialog', { name: 'Import a theme', exact: true }).getByRole('button', { name: 'Choose file…', exact: true }).click();
    return cardReady(overlay, name);
  };
  const shownBackground = async (): Promise<string> => cssToken(await shellPage(app), '--d-bg');

  const kdeCard = await importScheme('Fixture Dusk');
  await expect(kdeCard.getByTestId('theme-install-source')).toHaveText('A KDE color scheme, from the file FixtureDusk.colors');
  await expect(kdeCard.getByTestId('theme-install-conversion')).toBeVisible();
  await kdeCard.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  expect(installed(home).find((entry) => entry.name === 'Fixture Dusk')!.theme['origin']).toMatchObject({ kind: 'kde' });
  await expect(overlay.getByText('Imported from a KDE color scheme · Dark only', { exact: true })).toBeVisible();
  await overlay.getByRole('radio', { name: 'Fixture Dusk, dark', exact: true }).click();
  await expect.poll(shownBackground).toBe('#181a24');

  await answerOpenDialog(app, qt);
  const qtCard = await importScheme('fixture-graphite');
  await expect(qtCard.getByTestId('theme-install-source')).toHaveText('A qt5ct or qt6ct palette, from the file fixture-graphite.conf');
  await expect(qtCard.getByTestId('theme-install-conversion')).toContainText('Qt has no success, warning or danger color, so those come from Damocles\' own look of that kind.');
  await qtCard.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  expect(installed(home).find((entry) => entry.name === 'fixture-graphite')!.theme['origin']).toMatchObject({ kind: 'qt' });
  await expect(overlay.getByText('Imported from a Qt palette · Dark only', { exact: true })).toBeVisible();
  await overlay.getByRole('radio', { name: 'fixture-graphite, dark', exact: true }).click();
  await expect.poll(shownBackground).toBe('#121820');
});

test('Import of a GTK color file: the card names it and the color it cannot read, the installed theme paints view_bg_color, and a file whose colors are in a .gresource is refused', async ({ home, launch }) => {
  test.setTimeout(240_000);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const dir = path.join(home.root, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  // written for this test in libadwaita's layout; color-mix() is CSS GTK accepts and Damocles does not evaluate
  const gtk = path.join(dir, 'fixture-dusk.css');
  fs.writeFileSync(gtk, [
    '@define-color window_bg_color #1e2030;', '@define-color view_bg_color #181926;', '@define-color view_fg_color #e6e9f5;',
    '@define-color accent_bg_color mix(#7aa2f7, #bb9af7, 0.5);', '@define-color success_bg_color color-mix(in srgb, #9ece6a 50%, white);', '',
  ].join('\n'));
  const packaged = path.join(dir, 'fixture-packaged.css');
  fs.writeFileSync(packaged, '@import url("resource:///org/gnome/fixture/gtk.css");\n');
  const { app } = await launch();
  await activeChat(app);
  await answerOpenDialog(app, gtk);
  const overlay = await openAppearance(app, 1280);
  const chooseFile = async (): Promise<void> => {
    await overlay.getByRole('button', { name: 'Import…', exact: true }).click();
    await overlay.getByRole('dialog', { name: 'Import a theme', exact: true }).getByRole('button', { name: 'Choose file…', exact: true }).click();
  };

  await chooseFile();
  const card = await cardReady(overlay, 'fixture-dusk');
  await expect(card.getByTestId('theme-install-source')).toHaveText('GTK colors, from the file fixture-dusk.css');
  await expect(card.getByTestId('theme-install-conversion')).toBeVisible();
  await expect(card.getByTestId('theme-install-warnings')).toContainText('success_bg_color');
  await expect(card.getByTestId('theme-install-warnings')).toContainText('which Damocles cannot read, so that color comes from libadwaita.');
  await card.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  expect(installed(home).find((entry) => entry.name === 'fixture-dusk')!.theme['origin']).toMatchObject({ kind: 'gtk' });
  await expect(overlay.getByText('Imported from GTK colors · Dark only', { exact: true })).toBeVisible();
  await overlay.getByRole('radio', { name: 'fixture-dusk, dark', exact: true }).click();
  await expect.poll(async () => cssToken(await shellPage(app), '--d-bg')).toBe('#181926');

  await answerOpenDialog(app, packaged);
  await chooseFile();
  await expect(overlay.getByTestId('theme-error')).toHaveText('fixture-packaged.css only imports a theme whose colors are compiled into a .gresource file, which Damocles cannot read. Import a gtk.css that defines the colors, such as ~/.config/gtk-4.0/gtk.css.');
  expect(installed(home).map((entry) => entry.name)).toEqual(['fixture-dusk']);
});

test("Import of a theme whose moving wallpaper flashes: the card blocks it with the seizure warning, Install without Allow leaves the file blocked, and only the user's Allow on the card allows it on this computer", async ({ home, launch }) => {
  test.setTimeout(300_000);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const flashing = fs.readFileSync(path.resolve(import.meta.dirname, 'fixtures', 'wallpapers', 'flash-4hz.png'));
  const sha = createHash('sha256').update(flashing).digest('hex');
  const theme = {
    ...ARCHIVE_THEME,
    looks: { dark: { colors: COLORS, wallpapers: [{ panels: { chat: { asset: sha, fit: 'fill', dim: 0.5, blur: 4 } } }] } },
    assets: { [sha]: { kind: 'animated', mime: 'image/png', bytes: flashing.length, width: 64, height: 64, frames: 16, license: {} } },
  };
  const dir = path.join(home.root, 'shared');
  fs.mkdirSync(dir, { recursive: true });
  const archive = path.join(dir, FILE_NAME);
  fs.writeFileSync(archive, zipSync({ 'theme.json': strToU8(JSON.stringify(theme)), [`assets/${sha}.png`]: new Uint8Array(flashing) }));
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await activeChat(app);
  // a window that never gets the OS focus, or a machine on battery, would pause the wallpaper whatever its flash check says
  await themeHooks(app).pinMotion({ focused: true, onBattery: false, batterySaver: false });
  await answerOpenDialog(app, archive);
  const overlay = await openAppearance(app, 1280);
  await importFile(overlay);
  const card = installCard(overlay);
  const blocked = card.getByTestId('theme-install-flash-blocked');
  await expect(blocked).toBeVisible({ timeout: 90_000 });
  await expect(blocked).toContainText('Blocked: flashes');
  await expect(blocked).toContainText('Seizure warning');
  const flashFile = path.join(home.damoclesDir, 'themes', 'cache', sha, 'flash.json');
  const flash = (): Record<string, unknown> => JSON.parse(fs.readFileSync(flashFile, 'utf8')) as Record<string, unknown>;
  expect(flash()).not.toHaveProperty('allowed');

  // Install without Allow: the theme installs, and picked it shows the file's still frame, never the animation
  await card.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  expect(installed(home).map((entry) => entry.name)).toEqual([AURORA]);
  expect(flash()).toMatchObject({ flagged: true });
  expect(flash()).not.toHaveProperty('allowed');
  await overlay.getByRole('radio', { name: 'Aurora Borealis, dark', exact: true }).click();
  await expect(overlay.getByRole('radio', { name: 'Aurora Borealis, dark, active', exact: true })).toBeVisible();
  if (await windowShowsWallpapers(app)) {
    await expect.poll(async () => (await shellState(app)).wallpapers?.[0]?.moving).toEqual({ kind: 'animated', still: `app://damocles/theme-cache/${sha}/still.png`, playable: false });
  } else test.info().annotations.push({ type: 'partly skipped', description: 'no GPU compositing here, so the window shows no wallpaper' });

  // the same file again: only the card's Allow allows it
  await importFile(overlay);
  await expect(blocked).toBeVisible(CHECKED);
  await blocked.getByRole('button', { name: 'Allow flashing for this file', exact: true }).click();
  await expect(card.getByTestId('theme-install-flash-allowed')).toBeVisible(CHECKED);
  expect(flash()).toMatchObject({ flagged: true, allowed: true });
  await card.getByRole('button', { name: 'Install as “Aurora Borealis 2”', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  // the allowance is this computer's: no installed theme file carries one
  const themes = installed(home);
  expect(themes).toHaveLength(2);
  for (const entry of themes) expect(JSON.stringify(entry.theme)).not.toContain('allowed');
});

test('Install from link refuses what is not an https link inline and opens the card for one at a 900 px window', async ({ home, launch }) => {
  test.setTimeout(180_000);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  writeArchive(DOWNLOADS(home));
  const { app } = await launch({ env: seamEnv(home) });
  await activeChat(app);
  const overlay = await openAppearance(app, 900);

  await overlay.getByRole('button', { name: 'Install from link…', exact: true }).click();
  const dialog = overlay.getByRole('dialog', { name: 'Install a theme from a link', exact: true });
  await expect(dialog).toBeVisible();
  const field = dialog.getByLabel('Theme link', { exact: true });
  for (const value of ['', 'http://e2e.test/aurora-borealis.damocles-theme', 'javascript:alert(1)', 'aurora borealis']) {
    await field.fill(value);
    await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Enter an https link, such as https://example.com/aurora.damocles-theme.');
    await expect(field).toHaveAttribute('aria-invalid', 'true');
  }
  await expect(installCard(overlay)).toBeHidden();

  // a file the host does not have: main's refusal shows in the dialog
  await field.fill('https://e2e.test/missing.damocles-theme');
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible(CHECKED);
  await expect(installCard(overlay)).toBeHidden();

  await field.fill(`https://e2e.test/${FILE_NAME}`);
  await dialog.getByRole('button', { name: 'Continue', exact: true }).click();
  await cardReady(overlay);
  await expect(dialog).toBeHidden();
  await expect(installCard(overlay).getByTestId('theme-install-host')).toHaveText('e2e.test');
  await installCard(overlay).getByRole('button', { name: 'Install', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden(CHECKED);
  await expect(overlay.getByTestId('theme-toast')).toContainText('Installed Aurora Borealis.');
  expect(installed(home).map((entry) => entry.name)).toEqual([AURORA]);
});

test('Export writes one theme file for a theme of yours and for a built-in, without its origin', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const origin = { kind: 'created', installedAt: 1 };
  writeTheme(home, BLEACH, { ...bleach, origin });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const { app } = await launch();
  await activeChat(app);
  const overlay = await openAppearance(app, 1280);
  const out = path.join(home.root, 'exports');
  fs.mkdirSync(out, { recursive: true });

  const exportTheme = async (name: string, file: string): Promise<Record<string, unknown>> => {
    await answerSaveDialog(app, file);
    await overlay.getByRole('button', { name: `More actions for ${name}`, exact: true }).click();
    await overlay.getByRole('menuitem', { name: 'Export…', exact: true }).click();
    await expect(overlay.getByTestId('theme-toast')).toContainText(`Exported ${path.basename(file)}`, CHECKED);
    const entries = unzipSync(new Uint8Array(fs.readFileSync(file)));
    expect(Object.keys(entries)).toContain('theme.json');
    return JSON.parse(new TextDecoder().decode(entries['theme.json'])) as Record<string, unknown>;
  };

  // the installed file has an origin, which says where this copy came from and never travels
  expect(readTheme(home, BLEACH)['origin']).toEqual(origin);
  const mine = await exportTheme('Bleach', path.join(out, 'mine.damocles-theme'));
  expect(mine['name']).toBe('Bleach');
  expect(mine).not.toHaveProperty('origin');
  const builtin = await exportTheme('Damocles', path.join(out, 'builtin.damocles-theme'));
  expect(builtin['name']).toBe('Damocles');
  expect(builtin).not.toHaveProperty('origin');
  // the save dialog proposed the theme's name as the file name
  const defaults = await saveDialogDefaults(app);
  expect(path.basename(defaults[0]!)).toBe('Bleach.damocles-theme');
  expect(path.basename(defaults[1]!)).toBe('Damocles.damocles-theme');
});

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function agentRun(home: HermeticHome, launch: (options?: LaunchOptions) => Promise<DesktopApp>): Promise<{ app: ElectronApplication; tab: Page; openai: OpenAIStub }> {
  const openai = await startOpenAIStub();
  closers.push(() => openai.close());
  seedStubModel(home, openai.baseUrl, ['text', 'image']);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.pi.webSearch.enabled': true });
  writeArchive(DOWNLOADS(home));
  const { app } = await launch({ env: seamEnv(home) });
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  return { app, tab, openai };
}

async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

for (const [label, width] of [['1280 px', 1280], ['a 300 px chat column', 300]] as const) {
  test(`S3 install journey at ${label}: the agent's ThemeSet install docks the card; Keep both installs with the arrangement`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    writeTheme(home, BLEACH, { ...bleach, name: AURORA });
    const { app, tab, openai } = await agentRun(home, launch);
    await setContentSize(app, 1280, 900);
    if (width === 300) await setPageSize(tab, 300, 900);
    await loadThemeTools(openai, tab);

    openai.replies.push(call('ThemeSet', { install: { url: `https://e2e.test/${FILE_NAME}` } }), { chunks: ['It\'s installed. Want me to switch to it?'] });
    await send(tab, `Install this one: e2e.test/${FILE_NAME}`);
    await cardReady(tab);
    await expect(installCard(tab).getByTestId('theme-install-source')).toHaveText('From a link on e2e.test');
    await expect(tab.getByTestId('theme-tool-card').last()).toContainText('install, e2e.test');

    // the design's S3 clash steps
    await tab.getByLabel('Use this theme\'s window arrangement', { exact: true }).click();
    await expect(tab.getByText('On: the arrangement applies when you pick this theme.', { exact: true })).toBeVisible();
    await tab.getByRole('radio', { name: 'Replace', exact: true }).click();
    await expect(tab.getByRole('button', { name: 'Replace and install', exact: true })).toBeVisible();
    await tab.getByRole('radio', { name: 'Keep both', exact: true }).click();
    await expect(tab.getByRole('button', { name: 'Install as “Aurora Borealis 2”', exact: true })).toBeVisible();
    await tab.getByRole('button', { name: 'Install as “Aurora Borealis 2”', exact: true }).click();
    await expect(installCard(tab)).toBeHidden(CHECKED);
    // the chat's transcript is no log region, so the ThemeSet tool card carries the outcome
    const toolCard = tab.getByTestId('theme-tool-card').last();
    await expect(toolCard).toContainText('Installed “Aurora Borealis 2”.', CHECKED);
    await expect(toolCard).toContainText('Its window arrangement applies when you pick it.');
    await expect(tab.getByText('It\'s installed. Want me to switch to it?', { exact: true })).toBeVisible(CHECKED);

    const copy = installed(home).find((entry) => entry.name === 'Aurora Borealis 2');
    expect(copy).toBeDefined();
    expect((copy!.theme['origin'] as { layoutOptIn?: boolean } | undefined)?.layoutOptIn).toBe(true);
  });
}

test('the agent\'s install Cancel installs nothing and its tool card says so', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const { tab, openai } = await agentRun(home, launch);
  await loadThemeTools(openai, tab);
  openai.replies.push(call('ThemeSet', { install: { url: `https://e2e.test/${FILE_NAME}` } }), { chunks: ['Okay, I didn\'t install it.'] });
  await send(tab, 'Install this one.');
  await cardReady(tab);
  await installCard(tab).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(installCard(tab)).toBeHidden();
  await expect(tab.getByTestId('theme-tool-card').last()).toContainText('Install cancelled.', CHECKED);
  await expect(tab.getByText('Okay, I didn\'t install it.', { exact: true })).toBeVisible(CHECKED);
  expect(installed(home)).toEqual([]);
});

test('a damocles:// link from a second launch opens the install card in Settings; an http one opens nothing', async ({ home, launch, secondLaunch }) => {
  test.setTimeout(180_000);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  writeArchive(DOWNLOADS(home));
  const { app } = await launch({ env: seamEnv(home) });
  await activeChat(app);
  // as the registered command passes it: after --, which ends the options, so no word of the link is read as a flag
  const open = (link: string): Promise<number | null> => secondLaunch(['--', link], seamEnv(home));
  // Listens in main before the second launch starts, and resolves a reader of how many arguments it handed over.
  const listenForSecond = async (): Promise<() => Promise<number>> => {
    await app.evaluate(({ app: electronApp }) => {
      (globalThis as unknown as { __e2eSecond: Promise<number> }).__e2eSecond = new Promise<number>((resolve) => {
        electronApp.prependOnceListener('second-instance', (_event, argv) => resolve(argv.length));
      });
    });
    return () => app.evaluate(() => (globalThis as unknown as { __e2eSecond: Promise<number> }).__e2eSecond);
  };
  const overlayOpen = (): Promise<boolean> => app.evaluate(({ BaseWindow }, url) => BaseWindow.getAllWindows().some((window) =>
    (window.contentView.children as Electron.WebContentsView[]).some((child) => child.webContents?.getURL() === url && child.getVisible())), 'app://damocles/overlay/index.html');

  const httpArrived = await listenForSecond();
  expect(await open(`damocles://theme/install?url=${encodeURIComponent(`http://e2e.test/${FILE_NAME}`)}`)).toBe(0);
  expect(await httpArrived()).toBeGreaterThan(0);
  // main refuses the link as it reads the command line, and says so; nothing opened
  await expect.poll(() => mainLog(home)).toContain('a theme link on the command line opened nothing');
  expect(await overlayOpen()).toBe(false);

  const httpsArrived = await listenForSecond();
  expect(await open(`damocles://theme/install?url=${encodeURIComponent(`https://e2e.test/${FILE_NAME}`)}`)).toBe(0);
  await httpsArrived();
  const overlay = await overlayPage(app);
  await expect(settingsModal(overlay)).toBeVisible(CHECKED);
  await cardReady(overlay);
  await expect(installCard(overlay).getByTestId('theme-install-source')).toHaveText('From a damocles:// link on e2e.test');
  // a link never installs on its own
  expect(installed(home)).toEqual([]);
  await installCard(overlay).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(installDialog(overlay)).toBeHidden();
  expect(installed(home)).toEqual([]);
});
