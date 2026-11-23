import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { writeUserSettings } from './support/hermetic';
import { onMainWindow, overlayPage, shellPage, shellState, viewBounds } from './support/shell';
import { cssToken, openThemeEditor, readTheme, themeDockView, writeTheme } from './support/themes';
import { promptReady } from './support/ui';

// The theme editor docked beside the window (docs/desktop-app.md "Appearance"): its own view at the right edge, panes and the
// chat view reflowing beside it, live edits painted on the window while the editor keeps the palette from before them.

const BLEACH = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
// The design's "Bleach (copy)": its text fails on the panel (3.8:1), everything else passes.
const DARK = { background: '#141413', panel: '#262624', text: '#848179', accent: '#d97757', success: '#788c5d', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' };
const LIGHT = { background: '#faf9f5', panel: '#f0eee6', text: '#141413', accent: '#a3461f', success: '#2f6b3a', warning: '#8a5a00', danger: '#a12a2a', info: '#2d5a99' };
const bleach = { schemaVersion: 1, id: BLEACH, name: 'Bleach (copy)', looks: { dark: { colors: DARK }, light: { colors: LIGHT } } };
const BUILTIN_DARK_BG = '#0b0f14';

const WIDTHS = [1280, 900] as const;

const openEditor = (app: ElectronApplication, width: number): Promise<Page> => openThemeEditor(app, 'Bleach (copy)', { width });

for (const width of WIDTHS) {
  test.describe(`at ${width} px`, () => {
    test('docks at the right edge, reflows the chat view, and paints the draft on the window but not on itself', async ({ home, launch }) => {
      writeTheme(home, BLEACH, bleach);
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
      const { app } = await launch();
      const tab = await activeChat(app);
      const editor = await openEditor(app, width);
      const dock = (await themeDockView(app))!;
      // 22rem at the right edge, under the title bar
      expect(dock.bounds.x + dock.bounds.width).toBe(dock.content.width);
      expect(dock.bounds.width).toBe(352);
      expect(dock.bounds.y).toBeGreaterThan(0);
      expect((await shellState(app)).dockInset).toBe(22);
      await expect.poll(async () => {
        const chat = await viewBounds(app, tab);
        return chat.x + chat.width <= dock.bounds.x;
      }).toBe(true);
      const docked = await viewBounds(app, tab);
      await expect(editor.getByRole('complementary', { name: 'Theme editor' })).toHaveAttribute('data-trusted', '');

      // the window shows the draft; the editor keeps the palette from before editing
      const shell = await shellPage(app);
      await expect.poll(() => cssToken(tab, '--d-bg')).toBe(DARK.background);
      await expect.poll(() => cssToken(shell, '--d-bg')).toBe(DARK.background);
      expect(await cssToken(editor, '--d-bg')).toBe(BUILTIN_DARK_BG);
      await expect(editor.getByRole('status', { name: 'Preview status', exact: true })).toContainText('Bleach (copy), dark look');
      await editor.getByRole('button', { name: 'Show my current theme', exact: true }).click();
      await expect.poll(() => cssToken(tab, '--d-bg')).toBe(BUILTIN_DARK_BG);
      await editor.getByRole('button', { name: 'Show my current theme', exact: true }).click();
      await expect.poll(() => cssToken(tab, '--d-bg')).toBe(DARK.background);

      // with an unsaved edit Cancel asks first, and Keep editing keeps the dock and the draft
      await editor.getByLabel('Background hex', { exact: true }).fill('#202020');
      await expect.poll(() => cssToken(tab, '--d-bg')).toBe('#202020');
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      const question = editor.getByRole('group', { name: 'Discard unsaved edits?', exact: true });
      await expect(question.getByRole('button', { name: 'Keep editing', exact: true })).toBeFocused();
      await question.getByRole('button', { name: 'Keep editing', exact: true }).click();
      await expect(question).toBeHidden();
      expect((await themeDockView(app))?.visible).toBe(true);
      await expect(editor.getByLabel('Background hex', { exact: true })).toHaveValue('#202020');

      // Discard ends the preview, closes the dock and returns to Settings › Appearance
      await editor.getByRole('button', { name: 'Cancel', exact: true }).click();
      await question.getByRole('button', { name: 'Discard', exact: true }).click();
      await expect.poll(async () => (await themeDockView(app))?.visible).toBe(false);
      await expect.poll(() => cssToken(tab, '--d-bg')).toBe(BUILTIN_DARK_BG);
      expect((await shellState(app)).dockInset).toBe(0);
      const overlay = await overlayPage(app);
      await expect(overlay.getByTestId('theme-gallery')).toBeVisible();
      // the panes reflow into the room the dock gave back
      await expect.poll(async () => (await viewBounds(app, tab)).width).toBeGreaterThan(docked.width);
    });

    test('replays the design journey: contrast warnings, a lightness fix, and the look switch', async ({ home, launch }) => {
      writeTheme(home, BLEACH, bleach);
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
      const { app } = await launch();
      await activeChat(app);
      const page = await openEditor(app, width);

      // the design's S5 steps for this editor's Colors section (Type and CSS come with their own sections)
      await expect(page.getByLabel('Contrast warnings', { exact: true })).toContainText('Text on Panel 3.8:1, needs 4.5:1');
      await page.getByLabel('Accent hex', { exact: true }).fill('#6b3a2a');
      await expect(page.getByLabel('Contrast warnings', { exact: true })).toContainText('Accent on Panel 1.6:1, needs 3:1');
      await page.getByRole('button', { name: 'Accent on Panel', exact: false }).click();
      await expect(page.getByRole('status', { name: 'Color fix', exact: true })).toContainText('Fixed: Accent moved from #6b3a2a');
      await page.getByRole('button', { name: 'Undo fix', exact: true }).click();
      await expect(page.getByLabel('Accent hex', { exact: true })).toHaveValue('#6b3a2a');
      await page.getByRole('radio', { name: 'Light', exact: true }).click();
      await expect(page.getByRole('status', { name: 'Preview status', exact: true })).toContainText('Bleach (copy), light look');

      // every warning fixed, the list says so
      await page.getByRole('radio', { name: 'Dark', exact: true }).click();
      for (const name of ['Text on Panel', 'Accent on Panel']) await page.getByRole('button', { name, exact: false }).click();
      await expect(page.getByLabel('Contrast warnings', { exact: true })).toHaveText('All colors pass');
      // the colors the two fixes left in the fields, which Save must write
      const fixed = { accent: await page.getByLabel('Accent hex', { exact: true }).inputValue(), text: await page.getByLabel('Text hex', { exact: true }).inputValue() };
      expect(fixed.accent).not.toBe('#6b3a2a');
      expect(fixed.text).not.toBe(DARK.text);

      // the swatch opens the color picker popover
      await page.getByRole('button', { name: /^Info color #6a9bcc, open picker$/ }).click();
      const picker = page.getByRole('dialog', { name: 'Info color #6a9bcc, open picker' });
      await expect(picker).toBeVisible();
      await expect(picker.getByRole('slider', { name: 'Hue' })).toBeVisible();
      // a main color has no transparency, so the picker offers none
      await expect(picker.getByRole('slider', { name: 'Opacity' })).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(picker).toBeHidden();

      // the Advanced table lists every token, and an override is counted and listed with its contrast
      await page.getByRole('button', { name: 'Advanced: every token' }).click();
      const table = page.getByRole('table', { name: 'Every token of this look' });
      await expect(table.getByRole('rowheader', { name: '--d-bg' })).toBeVisible();
      await expect(table.getByRole('rowheader', { name: '--d-ansi-15' })).toBeVisible();
      const muted = table.getByLabel('Override --d-muted', { exact: true });
      await muted.fill('#262624');
      await muted.press('Enter');
      await muted.blur();
      await expect(page.getByRole('button', { name: /Advanced: every token/ })).toContainText('1 override');
      await expect(table).toContainText('Override kept. --d-muted on --d-bg is');
      await table.getByRole('button', { name: 'Reset --d-muted', exact: true }).click();
      await expect(page.getByRole('button', { name: /Advanced: every token/ })).not.toContainText('override');

      // Save writes the theme; the file holds the fixes
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => (readTheme(home, BLEACH)['looks'] as { dark: { colors: Record<string, string> } }).dark.colors).toMatchObject(fixed);
      await expect(page.getByText('saved just now', { exact: false })).toBeVisible();
    });

    test('removes and adds a look from the Look options menu, includes the window arrangement, and checks the name', async ({ home, launch }) => {
      writeTheme(home, BLEACH, bleach);
      writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
      const { app } = await launch();
      await activeChat(app);
      const page = await openEditor(app, width);

      await page.getByRole('radio', { name: 'Light', exact: true }).click();
      await page.getByRole('button', { name: 'Look options', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Remove the light look' }).click();
      await expect(page.getByRole('radio', { name: 'Light', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Look options', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: 'Remove the dark look' })).toHaveAttribute('aria-disabled', 'true');
      await expect(page.getByText('A theme keeps at least one look.')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Add light look', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Light', exact: true })).toHaveAttribute('aria-checked', 'true');

      // the theme has no arrangement: turning the switch on captures the window's, which the tab says Save will write
      await page.getByRole('tab', { name: 'Arrangement', exact: true }).click();
      await expect(page.getByText('No window arrangement is saved with this theme', { exact: true })).toBeVisible();
      await page.getByLabel('Save a window arrangement with this theme').click();
      await expect(page.getByText('Captured from the window, saved with your next Save', { exact: true })).toBeVisible();

      // an invalid name keeps Save focusable and names the error, and both lead to the field
      await page.getByRole('tab', { name: 'Details', exact: true }).click();
      await page.getByLabel('Name', { exact: true }).fill('');
      const reason = page.getByRole('button', { name: 'Fix 1 error: Name is empty', exact: true });
      await expect(reason).toBeVisible();
      const save = page.getByRole('button', { name: 'Save', exact: true });
      await expect(save).toHaveAttribute('aria-disabled', 'true');
      // the reason, from another tab: it opens Details on the field
      await page.getByRole('tab', { name: 'Colors', exact: true }).click();
      await reason.click();
      await expect(page.getByRole('tab', { name: 'Details', exact: true })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
      // and Save, from another tab again
      await page.getByRole('tab', { name: 'Colors', exact: true }).click();
      // Playwright refuses to click an aria-disabled button, which a user can still press
      await save.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByLabel('Name', { exact: true })).toBeFocused();
      await page.getByLabel('Name', { exact: true }).fill('Bleach Day');
      await save.click();
      await expect.poll(() => readTheme(home, BLEACH)['name']).toBe('Bleach Day');
      const saved = readTheme(home, BLEACH) as { layout?: { sidebarWidth?: number }; looks: { light?: unknown } };
      expect(saved.layout).toMatchObject({ grid: { slots: { main: 'chat' } } });
      expect(saved.looks.light).toBeDefined();

      // the tab now shows that arrangement as the theme's, and a later save of something else writes it again as it is
      await page.getByRole('tab', { name: 'Arrangement', exact: true }).click();
      await expect(page.getByText('Saved with this theme', { exact: true })).toBeVisible();
      await page.getByRole('tab', { name: 'Details', exact: true }).click();
      await page.getByLabel('Author', { exact: true }).fill('Me');
      await save.click();
      await expect.poll(() => readTheme(home, BLEACH)['author']).toBe('Me');
      expect(readTheme(home, BLEACH)['layout']).toEqual(saved.layout);
    });
  });
}

test('a built-in theme opens read-only from View, with Duplicate to edit and Close', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const { app } = await launch();
  await activeChat(app);
  const page = await openThemeEditor(app, 'Damocles', { item: 'View' });
  await expect(page.getByText('Damocles is built in and read-only. Duplicate it to edit.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Background hex', { exact: true })).toHaveAttribute('readonly', '');
  await expect(page.getByRole('status', { name: 'Preview status' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Duplicate to edit', exact: true }).click();
  await expect(page.getByTestId('theme-editor-name')).toHaveText('Damocles copy');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect.poll(async () => (await themeDockView(app))?.visible).toBe(false);
});

test('covers a narrow window, peeks at it until Escape, and a relaunch restores neither the dock nor the draft', async ({ home, launch }) => {
  writeTheme(home, BLEACH, bleach);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  const { app } = await launch();
  const tab = await activeChat(app);
  const page = await openEditor(app, 900);
  // a zoomed shell makes the 900 px window narrower than 48rem, where the dock covers it
  await onMainWindow(app, (win) => win.webContents.setZoomFactor(1.4));
  await expect.poll(async () => (await themeDockView(app))?.bounds.x).toBe(0);
  const peek = page.getByRole('button', { name: 'Peek at the window', exact: true });
  await expect(peek).toBeVisible();
  await peek.click();
  await expect.poll(async () => (await themeDockView(app))?.visible).toBe(false);
  const shell = await shellPage(app);
  const back = shell.getByRole('button', { name: 'Back to the theme editor', exact: true });
  await expect(back).toBeFocused();
  // the window still shows the draft while it peeks
  expect(await cssToken(tab, '--d-bg')).toBe(DARK.background);
  await promptReady(shell.getByTestId('theme-dock-peek'));
  await shell.keyboard.press('Escape');
  await expect.poll(async () => (await themeDockView(app))?.visible).toBe(true);
  await peek.click();
  await back.click();
  await expect.poll(async () => (await themeDockView(app))?.visible).toBe(true);
  await onMainWindow(app, (win) => win.webContents.setZoomFactor(1));

  await page.getByLabel('Background hex', { exact: true }).fill('#202020');
  await expect.poll(() => cssToken(tab, '--d-bg')).toBe('#202020');
  await app.close();
  const relaunched = await launch();
  const again = await activeChat(relaunched.app);
  expect((await shellState(relaunched.app)).dockInset).toBe(0);
  expect(await themeDockView(relaunched.app)).toBeUndefined();
  expect(await cssToken(again, '--d-bg')).toBe(BUILTIN_DARK_BG);
  expect((readTheme(home, BLEACH)['looks'] as { dark: { colors: { background: string } } }).dark.colors.background).toBe(DARK.background);
});
