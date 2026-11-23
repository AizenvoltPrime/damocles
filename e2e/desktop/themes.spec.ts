import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { readUserSettings, seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { readyOverlay } from './support/overlay';
import { hostMessage } from './support/screenshots';
import { openSettingsModal, settingsRow } from './support/settings';
import { shellPage } from './support/shell';
import { chatInput, clickMenu, menuItemState, sendAndAwaitEcho } from './support/ui';
import { cssToken, themeDir, themeEditorPage, windowBackground, writeTheme } from './support/themes';

// Desktop themes (docs/invariants.md "Desktop themes"): theme files under ~/.damocles/themes/themes/<id>/theme.json, the
// preferred looks in damocles.desktop.themes.dark and .light, main's own validation, and the trusted palette.

const NIGHT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const MURKY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const BROKEN = 'a1b2c3d4-0000-4000-8000-000000000001';
const NEWER = 'a1b2c3d4-0000-4000-8000-000000000002';
const COLORS = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const NIGHT_BG = 'rgb(26, 16, 51)';
// The built-in dark palette's --d-bg and --d-text (src/shared/themes/builtin.ts).
const BUILTIN_DARK_BG = 'rgb(11, 15, 20)';
const BUILTIN_DARK_TEXT = '#e6edf3';

const night = { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: COLORS } } };
// deriveLook keeps a seed text readable, so the failing text color is an Advanced override, which is saved but not enforced
const murky = { schemaVersion: 1, id: MURKY, name: 'Murky', looks: { dark: { colors: COLORS, tokens: { '--d-text': '#2a2040' } } } };

async function background(page: Page, selector: 'html' | 'body'): Promise<string> {
  return page.locator(selector).evaluate((element) => getComputedStyle(element).backgroundColor);
}

test('a user theme\'s --d-bg paints the window, every chat view and each page\'s html and body', async ({ home, launch }) => {
  const openai = await startOpenAIStub();
  try {
    seedStubModel(home, openai.baseUrl);
    writeTheme(home, NIGHT, night);
    writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': NIGHT });
    const { app } = await launch();
    const tab = await activeChat(app);
    const shell = await shellPage(app);
    await expect(chatInput(tab)).toBeVisible();
    expect(await windowBackground(app)).toBe(COLORS.background);
    for (const page of [tab, shell]) {
      await expect.poll(() => background(page, 'body')).toBe(NIGHT_BG);
      expect(await background(page, 'html')).toBe(NIGHT_BG);
      expect(await cssToken(page, '--d-bg')).toBe(COLORS.background);
    }

    // Every chat view takes the shown look's background when the theme changes: two chats, each view's colors recorded by
    // its page. The first chat holds a conversation, so main keeps its view when the second opens.
    await sendAndAwaitEcho(tab, 'keep this chat');
    await clickMenu(app, 'damocles.newChat');
    const second = await nextChat(app, [tab]);
    await expect(chatInput(second)).toBeVisible();
    await paintsEveryView(app, home, [tab, second], shell);
  } finally {
    await openai.close();
  }
});

/** Switches the dark look away and back, and expects every chat view, told apart by its page, to be given the shown look's color each time. */
async function paintsEveryView(app: ElectronApplication, home: HermeticHome, chats: Page[], shell: Page): Promise<void> {
  await app.evaluate(({ WebContentsView }) => {
    const calls: Array<{ readonly url: string; readonly color: string }> = [];
    (globalThis as { __e2eViewBackgrounds?: typeof calls }).__e2eViewBackgrounds = calls;
    const original = WebContentsView.prototype.setBackgroundColor;
    WebContentsView.prototype.setBackgroundColor = function setBackgroundColor(this: Electron.WebContentsView, color: string) {
      calls.push({ url: this.webContents.getURL(), color: color.toLowerCase() });
      return original.call(this, color);
    };
  });
  const viewColors = async (page: Page): Promise<string[]> => (await app.evaluate(() => (globalThis as { __e2eViewBackgrounds?: Array<{ url: string; color: string }> }).__e2eViewBackgrounds ?? []))
    .filter((call) => call.url === page.url()).map((call) => call.color);
  writeUserSettings(home, { 'damocles.desktop.themes.dark': 'damocles' });
  for (const page of [...chats, shell]) await expect.poll(() => background(page, 'body')).toBe(BUILTIN_DARK_BG);
  expect(await windowBackground(app)).toBe('#0b0f14');
  for (const page of chats) await expect.poll(async () => (await viewColors(page)).at(-1), { message: page.url() }).toBe('#0b0f14');
  writeUserSettings(home, { 'damocles.desktop.themes.dark': NIGHT });
  for (const page of chats) {
    await expect.poll(() => background(page, 'body')).toBe(NIGHT_BG);
    await expect.poll(async () => (await viewColors(page)).at(-1), { message: page.url() }).toBe(COLORS.background);
  }
  expect(await windowBackground(app)).toBe(COLORS.background);
}

test('a deleted theme falls back to Damocles and Settings names it; a broken or newer theme is listed and never applied', async ({ home, launch }) => {
  writeTheme(home, NIGHT, night);
  writeTheme(home, BROKEN, '{ "schemaVersion": 1, "id": ');
  writeTheme(home, NEWER, { schemaVersion: 2, id: NEWER, name: 'From the future', looks: {} });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': NIGHT, 'damocles.desktop.themes.light': BROKEN });
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect.poll(() => background(tab, 'body')).toBe(NIGHT_BG);

  fs.rmSync(themeDir(home, NIGHT), { recursive: true, force: true });
  await expect.poll(() => background(tab, 'body')).toBe(BUILTIN_DARK_BG);

  const overlay = await openSettingsModal(app, 'appearance');
  const gallery = settingsRow(overlay, 'theme-gallery');
  await expect(gallery.getByTestId('theme-missing-dark')).toContainText('The theme of your dark look is missing or can\'t be read, so Damocles, dark look shows instead.');
  const broken = gallery.getByTestId(`theme-card-${BROKEN}`);
  await expect(broken).toContainText('Can\'t read this theme');
  await expect(broken).toContainText('theme.json could not be read');
  await expect(broken.locator('[role="radio"]').first()).toHaveAttribute('aria-disabled', 'true');
  const newer = gallery.getByTestId(`theme-card-${NEWER}`);
  await expect(newer).toContainText('Needs a newer Damocles');
  await expect(newer.locator('[role="radio"]').first()).toHaveAttribute('aria-disabled', 'true');
  await overlay.keyboard.press('Escape');
  // the light pick names a broken theme, which the light look never shows
  writeUserSettings(home, { 'damocles.desktop.theme': 'light' });
  await expect.poll(() => background(tab, 'body')).toBe('rgb(247, 249, 251)');
  expect(fs.readFileSync(path.join(themeDir(home, BROKEN), 'theme.json'), 'utf8')).toBe('{ "schemaVersion": 1, "id": ');
});

test('a theme that fails the contrast check leaves the overlay and a permission card on the built-in palette', async ({ home, launch }) => {
  writeTheme(home, MURKY, murky);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': MURKY });
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  await expect.poll(() => cssToken(tab, '--d-text')).toBe('#2a2040');

  await hostMessage(app, tab, { type: 'requestPermission', toolUseId: 'e2e-theme-permission', toolName: 'Bash', toolInput: { command: 'echo hi' }, command: 'echo hi', owner: { kind: 'main' } });
  const card = tab.getByTestId('permission-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-trusted', '');
  expect(await cssToken(tab, '--d-text', '[data-testid="permission-card"]')).toBe(BUILTIN_DARK_TEXT);
  expect(await card.evaluate((element) => getComputedStyle(element).color)).toBe('rgb(230, 237, 243)');
  expect(await card.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe('rgb(20, 26, 34)');

  const overlay = await readyOverlay(app);
  expect(await cssToken(overlay, '--d-text')).toBe(BUILTIN_DARK_TEXT);
  expect(await cssToken(overlay, '--d-bg')).toBe('#0b0f14');
  // the shell keeps the theme everywhere but its trusted window controls and host chip
  const shell = await shellPage(app);
  expect(await cssToken(shell, '--d-text')).toBe('#2a2040');
});

test('Reset Theme to Default sets both preferred looks back to Damocles from the View menu as one undoable change, and Duplicate makes an editable copy', async ({ home, launch }) => {
  writeTheme(home, NIGHT, night);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': NIGHT, 'damocles.desktop.themes.light': NIGHT });
  const { app } = await launch();
  const tab = await activeChat(app);
  await expect.poll(() => background(tab, 'body')).toBe(NIGHT_BG);

  expect(await menuItemState(app, 'damocles.themes.resetToDefault')).toEqual({ accelerator: 'CmdOrCtrl+Alt+Shift+0', enabled: true, visible: true });
  await clickMenu(app, 'damocles.themes.resetToDefault');
  await expect.poll(() => background(tab, 'body')).toBe(BUILTIN_DARK_BG);
  await expect.poll(() => {
    const settings = readUserSettings(home);
    return [settings['damocles.desktop.themes.dark'], settings['damocles.desktop.themes.light']];
  }).toEqual(['damocles', 'damocles']);

  // one change: a single Undo Theme Change gives both looks back
  await clickMenu(app, 'damocles.themes.undo');
  await expect.poll(() => {
    const settings = readUserSettings(home);
    return [settings['damocles.desktop.themes.dark'], settings['damocles.desktop.themes.light']];
  }).toEqual([NIGHT, NIGHT]);
  await expect.poll(() => background(tab, 'body')).toBe(NIGHT_BG);
  await clickMenu(app, 'damocles.themes.resetToDefault');
  await expect.poll(() => background(tab, 'body')).toBe(BUILTIN_DARK_BG);

  const overlay = await openSettingsModal(app, 'appearance');
  await overlay.getByRole('button', { name: 'History', exact: true }).click();
  await expect(overlay.getByRole('dialog', { name: 'Theme history' }).getByRole('listitem')).toHaveText([/Reset to Damocles, dark and light/]);
  await overlay.keyboard.press('Escape');
  await overlay.getByRole('button', { name: 'More actions for Damocles', exact: true }).click();
  await overlay.getByRole('menuitem', { name: 'Duplicate to edit' }).click();
  const editor = await themeEditorPage(app);
  await expect(editor.getByTestId('theme-editor-name')).toHaveText('Damocles copy');
  await expect(editor.getByLabel('Background hex', { exact: true })).toBeVisible();
  await expect(editor.getByLabel('Contrast warnings', { exact: true })).toBeVisible();
  const copies = fs.readdirSync(path.join(home.damoclesDir, 'themes', 'themes')).filter((id) => id !== NIGHT);
  expect(copies).toHaveLength(1);
  const copy = JSON.parse(fs.readFileSync(path.join(themeDir(home, copies[0]!), 'theme.json'), 'utf8')) as { name: string; origin: { kind: string; from: string } };
  expect(copy).toMatchObject({ name: 'Damocles copy', origin: { kind: 'duplicate', from: 'damocles' } });
});
