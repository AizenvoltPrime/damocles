import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { chooseMenuItem, readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { closeSettingsModal, setContentSize } from './support/settings';
import { selectedProjectKey, shellPage, shellState } from './support/shell';
import { projectRow } from './support/shell-ui';
import { cssToken, HOOKS, openAppearance, themeDir, themeHooks, themeTimeAt, writeTheme, type ShownLook } from './support/themes';
import { answerDialogs, answerOpenDialog, TRUST_PROMPT } from './support/ui';

// A project's own look (design S7, docs/invariants.md "Desktop themes"): the Project look… dialog from the row's menu, touches
// on top of whatever shows, a theme of its own that beats the schedule, the row's palette mark, and the look following the
// project through Locate and leaving with Remove Project. Selecting a project never applies a window arrangement.

const NIGHT = 'a1b2c3d4-0000-4000-8000-000000000011';
const GALAXY = 'a1b2c3d4-0000-4000-8000-000000000012';
const DARK = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const LIGHT = { background: '#fbf8f1', panel: '#f1ece0', text: '#1f1a12', accent: '#a3461f', success: '#2f6b3a', warning: '#8a5a00', danger: '#a12a2a', info: '#2d5a99' };
const WIDTHS = [1280, 900] as const;
// Wednesday 12 June 2024, 20:15 in Athens (UTC+3)
const WED_2015 = Date.UTC(2024, 5, 12, 17, 15);
const ATHENS = 'Europe/Athens';
const CONFIRM_TITLE = '\'s chats to ';

const shown = (app: ElectronApplication): Promise<ShownLook> => themeHooks(app).shown();

const projectsFile = (home: HermeticHome): string => path.join(home.damoclesDir, 'themes', 'projects.json');
const looksOf = (home: HermeticHome): Record<string, Record<string, unknown>> =>
  (fs.existsSync(projectsFile(home)) ? (JSON.parse(fs.readFileSync(projectsFile(home), 'utf8')) as { looks?: Record<string, Record<string, unknown>> }).looks ?? {} : {});

/** The website project, added and selected beside the hermetic home's project. */
async function website(home: HermeticHome, app: ElectronApplication): Promise<{ readonly key: string; readonly other: string }> {
  await openProjectChat(app, home.project);
  const other = await selectedProjectKey(app);
  const dir = path.join(path.dirname(home.project), 'website');
  fs.mkdirSync(dir, { recursive: true });
  await openProjectChat(app, dir);
  return { key: await selectedProjectKey(app), other };
}

/** Project look… from the row's menu; the dialog in the overlay. */
async function openLook(app: ElectronApplication, key: string): Promise<Page> {
  const shell = await shellPage(app);
  await projectRow(shell, key).click({ button: 'right' });
  await chooseMenuItem(app, 'look');
  const overlay = await readyOverlay(app);
  await expect(overlay.getByRole('dialog', { name: 'Look for website', exact: true })).toBeVisible();
  return overlay;
}

for (const width of WIDTHS) {
  test.describe(`at ${width} px`, () => {
    test('replays the design journey: touches with an accent are saved, said under the list, marked on the row and shown on the window', async ({ home, launch }) => {
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
      const { app } = await launch(HOOKS);
      const { key } = await website(home, app);
      await setContentSize(app, width, 820);
      const layout = (await shellState(app)).layoutRevision;

      const page = await openLook(app, key);
      await page.getByRole('radio', { name: 'Add touches on top of the current theme', exact: true }).click();
      await expect(page.getByLabel('Accent color', { exact: true })).toBeVisible();
      await page.getByLabel('Accent color', { exact: true }).fill('#3a86ff');
      await expect(page.getByText('with accent.', { exact: false })).toBeVisible();
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Look for website', exact: true })).toBeHidden();
      const shell = await shellPage(app);
      await expect(shell.getByText('Saved the touches for website. It shows whenever website is open.', { exact: true })).toBeVisible();

      expect(looksOf(home)).toEqual({ [key]: { mode: 'touches', accent: '#3a86ff' } });
      await expect(projectRow(shell, key).getByRole('img', { name: 'Has touches on its theme', exact: true })).toBeVisible();
      await expect.poll(() => shown(app)).toMatchObject({ themeId: 'damocles', decidedBy: 'mode', touches: ['accent'] });
      await expect.poll(() => cssToken(shell, '--d-accent-fill')).toBe('#3a86ff');
      // the text color is derived from it, readable on the dark background
      expect(await cssToken(shell, '--d-accent')).toMatch(/^#[0-9a-f]{6}$/);
      expect((await shellState(app)).layoutRevision).toBe(layout);
    });
  });
}

test('the accent picker popover, wallpaper and character touches, Escape and Cancel, and reopening from the row menu', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const { app } = await launch(HOOKS);
  const { key } = await website(home, app);
  await setContentSize(app, 1280, 820);

  let page = await openLook(app, key);
  await page.getByRole('radio', { name: 'Add touches on top of the current theme', exact: true }).click();
  await page.getByRole('button', { name: 'Pick the accent color', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Pick the accent color', exact: true });
  await expect(picker).toBeVisible();
  const accent = page.getByLabel('Accent color', { exact: true });
  // the area moves saturation and brightness, the hue slider the hue, and the hex field takes a color as typed
  const area = picker.getByRole('slider', { name: 'Saturation and brightness', exact: true });
  const beforeArea = await accent.inputValue();
  await area.focus();
  await area.press('ArrowDown');
  await expect(accent).not.toHaveValue(beforeArea);
  const afterArea = await accent.inputValue();
  expect(afterArea).toMatch(/^#[0-9a-f]{6}$/);
  const hue = picker.getByRole('slider', { name: 'Hue', exact: true });
  await hue.focus();
  await hue.press('ArrowRight');
  await expect(accent).not.toHaveValue(afterArea);
  const hex = picker.getByRole('textbox', { name: 'Hex color', exact: true });
  await hex.fill('#e63946');
  await hex.press('Enter');
  await expect(accent).toHaveValue('#e63946');
  // Escape closes the popover alone, then the dialog, which saves nothing
  await page.keyboard.press('Escape');
  await expect(picker).toBeHidden();
  await expect(page.getByRole('dialog', { name: 'Look for website', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Look for website', exact: true })).toBeHidden();
  expect(looksOf(home)).toEqual({});

  page = await openLook(app, key);
  await expect(page.getByRole('radio', { name: 'Use the current theme', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Add touches on top of the current theme', exact: true }).click();
  await page.getByRole('radio', { name: 'From a theme', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Wallpaper from', exact: true })).toContainText('Aurora');
  await page.getByRole('combobox', { name: 'Character set', exact: true }).click();
  await page.getByRole('option', { name: 'Arcade', exact: true }).click();
  await expect(page.getByTestId('project-look-caption')).toHaveText('Damocles, dark, with wallpaper and characters.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Look for website', exact: true })).toBeHidden();
  await expect.poll(() => looksOf(home)[key]).toMatchObject({ mode: 'touches', characterSet: 'damocles-arcade', wallpaper: expect.anything() });
  await expect.poll(async () => (await shown(app)).touches).toEqual(['wallpaper', 'characters']);
  await expect.poll(async () => (await shellState(app)).characters?.characters.map((character) => character.name)).toContain('Pip');

  // reopening from the row's menu shows what was saved; Cancel keeps it
  page = await openLook(app, key);
  await expect(page.getByRole('radio', { name: 'Add touches on top of the current theme', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Image', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Use the current theme', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Look for website', exact: true })).toBeHidden();
  expect(looksOf(home)[key]).toMatchObject({ mode: 'touches', characterSet: 'damocles-arcade' });
});

test("a project's own theme beats the schedule while it is selected, its look picks the kind, and switching projects changes no arrangement", async ({ home, launch }) => {
  writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: DARK }, light: { colors: LIGHT } } });
  writeTheme(home, GALAXY, { schemaVersion: 1, id: GALAXY, name: 'Midnight Galaxy', looks: { dark: { colors: { ...DARK, background: '#0b0820' } } } });
  fs.writeFileSync(path.join(home.damoclesDir, 'themes', 'appearance.json'), JSON.stringify({ version: 1, schedule: { enabled: true, rules: [{ days: ['wed'], minute: 19 * 60, theme: GALAXY, look: 'dark' }] } }));
  writeUserSettings(home, { 'damocles.desktop.theme': 'light' });
  const { app } = await launch(HOOKS);
  // the schedule's clock is set and runs on from there
  await themeTimeAt(app, WED_2015, ATHENS);
  const shell = await shellPage(app);
  const { key, other } = await website(home, app);
  await setContentSize(app, 1280, 820);
  await expect.poll(() => shown(app)).toMatchObject({ themeId: GALAXY, decidedBy: 'schedule' });
  const layout = (await shellState(app)).layoutRevision;

  const page = await openLook(app, key);
  await page.getByRole('radio', { name: 'Use its own theme', exact: true }).click();
  await page.getByRole('combobox', { name: 'Theme', exact: true }).click();
  await page.getByRole('option', { name: 'Night', exact: true }).click();
  await page.getByRole('radio', { name: 'Light', exact: true }).click();
  await expect(page.getByTestId('project-look-caption')).toHaveText('Night, light.');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(shell.getByText('website now has its own theme: Night. It shows whenever website is open.', { exact: true })).toBeVisible();
  await expect(projectRow(shell, key).getByRole('img', { name: 'Has its own theme', exact: true })).toBeVisible();
  await expect.poll(() => shown(app)).toMatchObject({ themeId: NIGHT, kind: 'light', decidedBy: 'project' });
  await expect.poll(() => cssToken(shell, '--d-bg')).toBe(LIGHT.background);

  // another project shows what the schedule shows, and selecting back shows the project's theme again
  await projectRow(shell, other).click();
  await expect.poll(() => shown(app)).toMatchObject({ themeId: GALAXY, decidedBy: 'schedule' });
  await projectRow(shell, key).click();
  await expect.poll(() => shown(app)).toMatchObject({ themeId: NIGHT, decidedBy: 'project' });
  expect((await shellState(app)).layoutRevision).toBe(layout);

  // its theme deleted: Damocles' own look shows for the project, in the kind its look names, and its dialog says why
  const settings = await openAppearance(app, 1280);
  await settings.getByRole('button', { name: 'More actions for Night', exact: true }).click();
  await settings.getByRole('menuitem', { name: 'Delete…' }).click();
  await settings.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => fs.existsSync(themeDir(home, NIGHT))).toBe(false);
  await closeSettingsModal(settings);
  await expect.poll(() => shown(app)).toMatchObject({ themeId: 'damocles', kind: 'light' });
  await expect.poll(() => cssToken(shell, '--d-bg')).toBe('#f7f9fb');
  const missing = await openLook(app, key);
  await expect(missing.getByTestId('project-look-theme-missing')).toContainText("so Damocles' own look shows for");
  await missing.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(missing.getByRole('dialog', { name: 'Look for website', exact: true })).toBeHidden();
  // the other project still follows the schedule
  await projectRow(shell, other).click();
  await expect.poll(() => shown(app)).toMatchObject({ themeId: GALAXY, decidedBy: 'schedule' });
});

test('the look follows the project through Locate, and Remove Project drops its look and pins', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const dir = path.join(path.dirname(home.project), 'website');
  fs.mkdirSync(dir, { recursive: true });
  let desktop = await launch();
  await openProjectChat(desktop.app, dir);
  const oldKey = await selectedProjectKey(desktop.app);
  await desktop.close();
  // core is the only writer of this file while it runs, so the look and the pin are seeded between the two launches
  fs.writeFileSync(projectsFile(home), JSON.stringify({ version: 1, pins: { [oldKey]: { byTheme: { 'damocles-arcade': 'Pip' } } }, looks: { [oldKey]: { mode: 'touches', accent: '#3a86ff' } } }));

  const moved = `${dir}-renamed`;
  fs.renameSync(dir, moved);
  desktop = await launch();
  const { app } = desktop;
  await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder', [CONFIRM_TITLE]: 'Move Chats' });
  const shell = await shellPage(app);
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === oldKey)?.presence, { timeout: 30_000 }).toBe('missing');
  await answerOpenDialog(app, moved);
  await shell.locator(`[data-testid="project-locate"][data-project-key="${oldKey.replace(/\\/g, '\\\\')}"]`).getByTestId('project-locate-button').click();
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.fsPath === moved && project.relocation === undefined && project.presence === undefined)?.key, { timeout: 90_000 }).toBeDefined();
  const newKey = (await shellState(app)).projects.find((project) => project.fsPath === moved)!.key;
  expect(newKey).not.toBe(oldKey);
  await expect.poll(() => looksOf(home)).toEqual({ [newKey]: { mode: 'touches', accent: '#3a86ff' } });
  const pins = (JSON.parse(fs.readFileSync(projectsFile(home), 'utf8')) as { pins: Record<string, unknown> }).pins;
  expect(pins).toEqual({ [newKey]: { byTheme: { 'damocles-arcade': 'Pip' } } });
  await expect(projectRow(shell, newKey).getByRole('img', { name: 'Has touches on its theme', exact: true })).toBeVisible();

  await projectRow(shell, newKey).click({ button: 'right' });
  await chooseMenuItem(app, 'remove');
  await expect.poll(async () => (await shellState(app)).projects.some((project) => project.key === newKey)).toBe(false);
  await expect.poll(() => looksOf(home)).toEqual({});
  expect((JSON.parse(fs.readFileSync(projectsFile(home), 'utf8')) as { pins: Record<string, unknown> }).pins).toEqual({});
});
