import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { readUserSettings, writeUserSettings, type HermeticHome } from './support/hermetic';
import { chooseSegment, openSettingsModal, setContentSize, settingsRow } from './support/settings';
import { shellPage, shellState } from './support/shell';
import { cssToken, HOOKS, reportZone, themeHooks, themeTimeAt, writeTheme } from './support/themes';

// Settings › Appearance › Theme schedule and the schedule deciding the window's look (docs/desktop-app.md "Settings",
// docs/invariants.md "Desktop themes"). Main's schedule clock is set through its e2e hooks and runs on from there, and the
// zone is reported the way the shell page reports it, so every time below is Wednesday 12 June 2024 in Athens (UTC+3) unless a
// test moves it. While the clock is set main's own 30 s tick is stopped: the schedule is evaluated again only when an input
// changes, a power event arrives or a test fires the tick. The regional format is pinned the same way (en-GB: a 24-hour
// clock and a week from Monday), since the machine's would decide how every time reads.

const GALAXY = 'a1b2c3d4-0000-4000-8000-000000000001';
const BLEACH = 'a1b2c3d4-0000-4000-8000-000000000002';
const FOREST = 'a1b2c3d4-0000-4000-8000-000000000003';
const GONE = 'a1b2c3d4-0000-4000-8000-000000000009';
const AURORA = 'damocles-aurora';
const DARK = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const LIGHT = { background: '#fbf8f1', panel: '#f1ece0', text: '#1f1a12', accent: '#a3461f', success: '#2f6b3a', warning: '#8a5a00', danger: '#a12a2a', info: '#2d5a99' };
const FOREST_DARK = { ...DARK, background: '#0f1a12', panel: '#16241a' };
const ATHENS = 'Europe/Athens';
// Athens in June is UTC+3
const athens = (day: number, hour: number, minute = 0): number => Date.UTC(2024, 5, day, hour - 3, minute);
const WED_2015 = athens(12, 20, 15);
const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri'];
const RULES = [
  { days: WEEKDAYS, minute: 7 * 60, theme: BLEACH, look: 'light' },
  { days: WEEKDAYS, minute: 19 * 60, theme: GALAXY, look: 'dark' },
  { days: ['sat', 'sun'], minute: 9 * 60, theme: FOREST, look: 'auto' },
];
const WIDTHS = [1280, 900] as const;

const appearanceFile = (home: HermeticHome): string => path.join(home.damoclesDir, 'themes', 'appearance.json');
const readAppearance = (home: HermeticHome): Record<string, unknown> => JSON.parse(fs.readFileSync(appearanceFile(home), 'utf8')) as Record<string, unknown>;
const scheduleOf = (home: HermeticHome): { enabled: boolean; rules: Array<Record<string, unknown>> } => readAppearance(home)['schedule'] as { enabled: boolean; rules: Array<Record<string, unknown>> };

function seed(home: HermeticHome, options: { readonly mode: 'system' | 'dark' | 'light'; readonly enabled: boolean; readonly rules?: readonly unknown[]; readonly override?: unknown; readonly bleachLayout?: unknown }): void {
  writeTheme(home, GALAXY, { schemaVersion: 1, id: GALAXY, name: 'Midnight Galaxy', looks: { dark: { colors: DARK } } });
  writeTheme(home, BLEACH, { schemaVersion: 1, id: BLEACH, name: 'Bleach', looks: { dark: { colors: { ...DARK, background: '#141413' } }, light: { colors: LIGHT } }, ...(options.bleachLayout ? { layout: options.bleachLayout } : {}) });
  writeTheme(home, FOREST, { schemaVersion: 1, id: FOREST, name: 'Forest', looks: { dark: { colors: FOREST_DARK }, light: { colors: LIGHT } } });
  fs.writeFileSync(appearanceFile(home), JSON.stringify({ version: 1, schedule: { enabled: options.enabled, rules: options.rules ?? RULES }, ...(options.override ? { override: options.override } : {}) }));
  writeUserSettings(home, { 'damocles.desktop.theme': options.mode, 'damocles.desktop.themes.dark': GALAXY, 'damocles.desktop.themes.light': BLEACH });
}

// powerMonitor's unlock-screen, which re-evaluates the schedule as resume and the 30 s tick do
const unlockScreen = (app: ElectronApplication): Promise<void> => app.evaluate(({ powerMonitor }) => {
  powerMonitor.emit('unlock-screen');
});

const at = (app: ElectronApplication, now: number, zone = ATHENS, region = 'en-GB'): Promise<void> => themeTimeAt(app, now, zone, region);

async function schedulePage(app: ElectronApplication, width: number): Promise<Page> {
  await setContentSize(app, width, 820);
  const page = await openSettingsModal(app, 'appearance');
  await page.getByRole('button', { name: 'Edit schedule…', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Theme schedule', exact: true })).toBeVisible();
  return page;
}

const summary = (page: Page) => page.getByTestId('schedule-summary');
const startsAt = (page: Page, rule: number) => page.getByRole('group', { name: `Starts at, rule ${rule}`, exact: true });
const timeSegment = (page: Page, rule: number, part: 'hour' | 'minute' | 'dayPeriod') => startsAt(page, rule).locator(`[data-reka-time-field-segment="${part}"]`);

for (const width of WIDTHS) {
  test.describe(`at ${width} px`, () => {
    test('replays the S6 journey from Follow the computer, and the Mode row and the schedule\'s mode always agree', async ({ home, launch }) => {
      seed(home, { mode: 'system', enabled: false });
      const { app } = await launch(HOOKS);
      await activeChat(app);
      await at(app, WED_2015);
      const page = await schedulePage(app, width);
      await expect(page.getByRole('radio', { name: "Follow the computer's light and dark mode", exact: true })).toBeChecked();

      // the design's journey
      await page.getByRole('radio', { name: 'Use a schedule', exact: true }).click();
      await expect(page.getByText('Midnight Galaxy (dark) until 07:00 tomorrow, then Bleach (light).', { exact: true })).toBeVisible();
      // typed a segment at a time: nothing is written until Enter
      await timeSegment(page, 2, 'hour').click();
      await page.keyboard.type('21');
      await expect(startsAt(page, 2)).toHaveText('21:00');
      expect(scheduleOf(home).rules[1]).toMatchObject({ minute: 1140 });
      await page.keyboard.press('Enter');
      await expect(page.getByText('Bleach (light) until 21:00, then Midnight Galaxy (dark).', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Wednesday, rule 2', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Wednesday, rule 2', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByText('Bleach (light) until 21:00 tomorrow, then Midnight Galaxy (dark).', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Add rule', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Rule 4', exact: true })).toBeVisible();
      await expect(startsAt(page, 4)).toHaveText('12:00');
      await expect(timeSegment(page, 4, 'hour')).toBeFocused();

      // what the page wrote, and the window it decides
      await expect.poll(() => scheduleOf(home).rules.length).toBe(4);
      // the added rule starts as what shows now, Bleach's light look, so adding it changed nothing on screen
      expect(scheduleOf(home)).toMatchObject({ enabled: true, rules: [{ minute: 420 }, { minute: 1260, days: ['mon', 'tue', 'thu', 'fri'] }, {}, { minute: 720, theme: BLEACH, look: 'light' }] });
      const mode = readUserSettings(home)['damocles.desktop.theme'];
      expect(['dark', 'light']).toContain(mode);
      await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: BLEACH, kind: 'light', decidedBy: 'schedule', themeSource: 'light', until: athens(13, 21) });

      // the Mode row: a fixed mode while the schedule runs, its sentence names the schedule, and its System turns it off
      await page.getByRole('button', { name: 'Back to Appearance', exact: true }).click();
      const modeRow = settingsRow(page, 'damocles.desktop.theme');
      await expect(modeRow.getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await expect(modeRow.getByTestId('theme-mode-status')).toHaveText('Showing Bleach, light look. The schedule shows it until 21:00 tomorrow.');
      await expect(settingsRow(page, 'theme-schedule')).toContainText('Bleach (light) until 21:00 tomorrow, then Midnight Galaxy (dark).');
      await chooseSegment(modeRow, 'System');
      await expect.poll(() => scheduleOf(home).enabled).toBe(false);
      await page.getByRole('button', { name: 'Edit schedule…', exact: true }).click();
      await expect(page.getByRole('radio', { name: "Follow the computer's light and dark mode", exact: true })).toBeChecked();

      // Off from System fixes the mode at the kind on screen; the Mode row shows it and the radio says Off
      await page.getByRole('radio', { name: 'Off (manual only)', exact: true }).click();
      await expect(page.getByRole('radio', { name: 'Off (manual only)', exact: true })).toBeChecked();
      await expect.poll(() => readUserSettings(home)['damocles.desktop.theme']).not.toBe('system');
      await page.getByRole('button', { name: 'Back to Appearance', exact: true }).click();
      await expect(settingsRow(page, 'damocles.desktop.theme').getByRole('button', { name: 'System', exact: true })).toHaveAttribute('aria-pressed', 'false');
    });

    test('draws the whole week as spans in each theme\'s colors', async ({ home, launch }) => {
      seed(home, { mode: 'dark', enabled: true });
      const { app } = await launch(HOOKS);
      await activeChat(app);
      await at(app, WED_2015);
      const page = await schedulePage(app, width);
      const strip = page.getByTestId('schedule-strip');
      await expect(strip).toContainText('Today, Wednesday');
      await expect(strip.getByRole('list')).toHaveCount(1);
      await strip.getByRole('radio', { name: 'Whole week', exact: true }).click();
      await expect(strip).toContainText('This week');
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      for (const day of days) await expect(strip.getByRole('list', { name: day, exact: true })).toBeVisible();
      const wednesday = strip.getByRole('list', { name: 'Wednesday', exact: true }).getByRole('listitem');
      await expect(wednesday).toHaveCount(3);
      await expect(wednesday.nth(1)).toContainText('07:00 to 19:00: Bleach, light');
      const saturday = strip.getByRole('list', { name: 'Saturday', exact: true }).getByRole('listitem');
      await expect(saturday).toHaveCount(2);
      await expect(saturday.nth(1)).toContainText('09:00 to 24:00: Forest, auto');
      // each span is painted in its own theme's look
      await expect(wednesday.nth(1)).toHaveCSS('background-color', 'rgb(251, 248, 241)');
      await strip.getByRole('radio', { name: 'Today', exact: true }).click();
      await expect(strip.getByRole('list')).toHaveCount(1);
    });

    test('a pick or the title bar\'s theme button holds until the next rule, and Resume schedule now ends it', async ({ home, launch }) => {
      seed(home, { mode: 'dark', enabled: true, override: { themeId: AURORA, kind: 'dark', at: athens(12, 19, 52) } });
      const { app } = await launch(HOOKS);
      await activeChat(app);
      await at(app, WED_2015);
      await setContentSize(app, width, 820);
      const page = await openSettingsModal(app, 'appearance');
      const status = settingsRow(page, 'damocles.desktop.theme').getByTestId('theme-mode-status');
      await expect(status).toHaveText('Showing your pick, Aurora, dark look, until 07:00 tomorrow; then the schedule resumes.');
      await page.getByRole('button', { name: 'Edit schedule…', exact: true }).click();
      await expect(summary(page)).toHaveText('Your pick, Aurora (dark), holds until 07:00 tomorrow, then the schedule resumes.');
      await page.getByRole('button', { name: 'Resume schedule now', exact: true }).click();
      await expect(summary(page)).toHaveText('Midnight Galaxy (dark) until 07:00 tomorrow, then Bleach (light).');
      await expect(page.getByTestId('schedule-status')).toBeFocused();
      expect(readAppearance(home)['override']).toBeUndefined();
      await expect.poll(async () => (await themeHooks(app).shown()).themeId).toBe(GALAXY);

      // a pick in the gallery while the schedule runs holds from main's clock, and sets the preferred look as always
      await page.getByRole('button', { name: 'Back to Appearance', exact: true }).click();
      await page.getByRole('radio', { name: 'Bleach, dark', exact: true }).click();
      await expect(status).toHaveText('Showing your pick, Bleach, dark look, until 07:00 tomorrow; then the schedule resumes.');
      const picked = readAppearance(home)['override'] as { themeId: string; kind: string; at: number };
      expect(picked).toMatchObject({ themeId: BLEACH, kind: 'dark' });
      expect(picked.at).toBeGreaterThanOrEqual(WED_2015);
      expect(picked.at).toBeLessThan(WED_2015 + 10 * 60_000);
      expect(readUserSettings(home)['damocles.desktop.themes.dark']).toBe(BLEACH);
      await page.keyboard.press('Escape');

      // the title bar's theme button holds the preferred look of the other kind; the mode stays
      await (await shellPage(app)).getByTestId('toggle-theme').click();
      await expect.poll(async () => (await themeHooks(app).shown())).toMatchObject({ themeId: BLEACH, kind: 'light', decidedBy: 'override', themeSource: 'light' });
      expect(readUserSettings(home)['damocles.desktop.theme']).toBe('dark');
      expect(readAppearance(home)['override']).toMatchObject({ themeId: BLEACH, kind: 'light' });
    });

    test('a rule naming a missing theme is skipped and listed until a theme is picked for it', async ({ home, launch }) => {
      seed(home, { mode: 'dark', enabled: true, rules: [RULES[0], { ...RULES[1], theme: GONE }, RULES[2]] });
      const { app } = await launch(HOOKS);
      await activeChat(app);
      await at(app, WED_2015);
      await setContentSize(app, width, 820);
      const page = await openSettingsModal(app, 'appearance');
      await expect(settingsRow(page, 'theme-schedule').getByTestId('theme-schedule-skipped')).toHaveText('Rule 2 (19:00) is skipped: its theme is missing.');
      // skipped, so 07:00's rule still shows at 20:15
      await expect.poll(async () => (await themeHooks(app).shown()).themeId).toBe(BLEACH);
      await page.getByRole('button', { name: 'Edit schedule…', exact: true }).click();
      const banner = page.getByTestId('schedule-missing');
      await expect(banner).toContainText('The theme of rule 2 is missing, so the rule is skipped.');
      await expect(page.getByTestId('schedule-rule-warning-2')).toHaveText('Its theme is missing; this rule is skipped until you pick another theme.');
      await banner.getByRole('button', { name: 'Pick a theme for rule 2', exact: true }).click();
      const select = page.getByRole('combobox', { name: 'Theme, rule 2', exact: true });
      await expect(select).toBeFocused();
      await select.click();
      await page.getByRole('option', { name: 'Midnight Galaxy · dark only', exact: true }).click();
      await expect(banner).toBeHidden();
      await expect(page.getByTestId('schedule-rule-warning-2')).toBeHidden();
      await expect.poll(() => scheduleOf(home).rules[1]?.['theme']).toBe(GALAXY);
      await expect.poll(async () => (await themeHooks(app).shown()).themeId).toBe(GALAXY);
    });

    test('deletes rules down to the empty state, which starts again with day and night', async ({ home, launch }) => {
      seed(home, { mode: 'dark', enabled: true });
      const { app } = await launch(HOOKS);
      await activeChat(app);
      await at(app, WED_2015);
      const page = await schedulePage(app, width);
      await page.getByRole('button', { name: 'Delete rule 3', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Rule 3', exact: true })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete rule 2', exact: true })).toBeFocused();
      await page.getByRole('button', { name: 'Delete rule 2', exact: true }).click();
      await page.getByRole('button', { name: 'Delete rule 1', exact: true }).click();
      const empty = page.getByTestId('schedule-empty');
      await expect(empty.getByRole('heading', { name: 'Switch themes at the times you set', exact: true })).toBeVisible();
      await expect(empty.getByRole('button', { name: 'Add the first rule', exact: true })).toBeFocused();
      await expect(summary(page)).toHaveText('No rules yet, so your own pick shows: Midnight Galaxy (dark).');
      await expect.poll(() => scheduleOf(home).rules.length).toBe(0);
      await empty.getByRole('button', { name: 'Start with Day 07:00 and Night 19:00', exact: true }).click();
      await expect(page.getByRole('group', { name: 'Rule 2', exact: true })).toBeVisible();
      await expect(startsAt(page, 1)).toHaveText('07:00');
      await expect(startsAt(page, 2)).toHaveText('19:00');
      await expect.poll(() => scheduleOf(home).rules).toEqual([
        { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], minute: 420, theme: BLEACH, look: 'light' },
        { days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], minute: 1140, theme: GALAXY, look: 'dark' },
      ]);
      await expect(summary(page)).toHaveText('Midnight Galaxy (dark) until 07:00 tomorrow, then Bleach (light).');
    });

    test('sets Dark, Light and Auto per rule, and a theme without the rule\'s look turns it to Auto', async ({ home, launch }) => {
      seed(home, { mode: 'dark', enabled: true });
      const { app } = await launch(HOOKS);
      await activeChat(app);
      await at(app, WED_2015);
      const page = await schedulePage(app, width);
      const look = page.getByRole('radiogroup', { name: 'Look, rule 1', exact: true });
      await expect(look.getByRole('radio', { name: 'Light', exact: true })).toHaveAttribute('aria-checked', 'true');
      await look.getByRole('radio', { name: 'Dark', exact: true }).click();
      await expect.poll(() => scheduleOf(home).rules[0]?.['look']).toBe('dark');
      await look.getByRole('radio', { name: 'Auto', exact: true }).click();
      await expect.poll(() => scheduleOf(home).rules[0]?.['look']).toBe('auto');
      await look.getByRole('radio', { name: 'Light', exact: true }).click();
      await expect.poll(() => scheduleOf(home).rules[0]?.['look']).toBe('light');

      await page.getByRole('combobox', { name: 'Theme, rule 1', exact: true }).click();
      await page.getByRole('option', { name: 'Midnight Galaxy · dark only', exact: true }).click();
      await expect(look.getByRole('radio', { name: 'Auto', exact: true })).toHaveAttribute('aria-checked', 'true');
      await expect(look.getByRole('radio', { name: 'Light', exact: true })).toBeDisabled();
      await expect(look.getByRole('radio', { name: 'Dark', exact: true })).toBeEnabled();
      await expect.poll(() => scheduleOf(home).rules[0]).toMatchObject({ theme: GALAXY, look: 'auto' });
      await expect(page.getByRole('img', { name: 'Midnight Galaxy, dark look', exact: true }).first()).toBeVisible();
    });
  });
}

test('in a 12-hour, Sunday-first region the time field and every time read 12-hour, the week starts on Sunday, and the file keeps 24-hour minutes', async ({ home, launch }) => {
  seed(home, { mode: 'dark', enabled: true });
  const { app } = await launch(HOOKS);
  await activeChat(app);
  await at(app, WED_2015, ATHENS, 'en-US');
  const page = await schedulePage(app, 1280);
  await expect(summary(page)).toHaveText('Midnight Galaxy (dark) until 7:00 AM tomorrow, then Bleach (light).');
  await expect(startsAt(page, 2)).toHaveText('7:00 PM');
  await expect(page.getByRole('group', { name: 'Days, rule 1', exact: true }).getByRole('button').first()).toHaveText('Sun');

  // an emptied segment writes nothing when focus leaves, and the field shows the rule's time again
  await timeSegment(page, 2, 'minute').click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.getByRole('button', { name: 'Delete rule 3', exact: true }).focus();
  await expect(startsAt(page, 2)).toHaveText('7:00 PM');
  expect(scheduleOf(home).rules[1]).toMatchObject({ minute: 1140 });

  // 9, then PM, written once when focus leaves the field
  await timeSegment(page, 2, 'hour').click();
  await page.keyboard.type('9');
  await timeSegment(page, 2, 'dayPeriod').click();
  await page.keyboard.press('p');
  expect(scheduleOf(home).rules[1]).toMatchObject({ minute: 1140 });
  await page.getByRole('button', { name: 'Delete rule 3', exact: true }).focus();
  await expect.poll(() => scheduleOf(home).rules[1]?.['minute']).toBe(1260);
  await expect(startsAt(page, 2)).toHaveText('9:00 PM');
  await expect(summary(page)).toHaveText('Bleach (light) until 9:00 PM, then Midnight Galaxy (dark).');

  const strip = page.getByTestId('schedule-strip');
  await strip.getByRole('radio', { name: 'Whole week', exact: true }).click();
  await expect(strip.getByRole('list').first()).toHaveAttribute('aria-label', 'Sunday');
  await expect(page.getByTestId('schedule-axis')).toHaveText('12 AM6 AM12 PM6 PM12 AM');
});

test('the window follows the schedule in the zone the shell reports, after a resume, and never takes a scheduled theme\'s arrangement', async ({ home, launch }) => {
  const layout = { grid: { slots: { main: 'chat', side: 'terminal', bottom: 'editor' }, visible: { editor: true, terminal: true }, sideWidth: 380, bottomHeight: 180 }, sidebarWidth: 300 };
  seed(home, { mode: 'dark', enabled: true, bleachLayout: layout });
  const { app } = await launch(HOOKS);
  const tab = await activeChat(app);
  await at(app, WED_2015);
  await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: GALAXY, kind: 'dark', decidedBy: 'schedule', themeSource: 'dark', zone: ATHENS, until: athens(13, 7) });
  await expect.poll(() => cssToken(tab, '--d-bg')).toBe(DARK.background);
  const before = await shellState(app);

  // 20:15 in Athens is 13:15 in New York, where the 07:00 rule shows
  await reportZone(app, 'America/New_York');
  await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: BLEACH, kind: 'light', themeSource: 'light', zone: 'America/New_York' });
  await expect.poll(() => cssToken(tab, '--d-bg')).toBe(LIGHT.background);
  const after = await shellState(app);
  expect(after.layoutRevision).toBe(before.layoutRevision);
  expect(after.layout.grid.slots).toEqual(before.layout.grid.slots);

  // time passes in sleep: setting the clock evaluates nothing and main's own tick is stopped, so the look stays until the
  // resume, which shows Wednesday 21:00's rule in New York
  await themeHooks(app).clock(Date.UTC(2024, 5, 13, 1, 0));
  expect((await themeHooks(app).shown()).themeId).toBe(BLEACH);
  await app.evaluate(({ powerMonitor }) => {
    powerMonitor.emit('resume');
  });
  await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: GALAXY, kind: 'dark', themeSource: 'dark' });

  // the clock moving backwards gives the state-based answer for that time
  await themeHooks(app).clock(Date.UTC(2024, 5, 12, 12, 0));
  await unlockScreen(app);
  await expect.poll(async () => (await themeHooks(app).shown()).themeId).toBe(BLEACH);
  expect((await shellState(app)).layoutRevision).toBe(before.layoutRevision);
});

test('a pick held over the schedule ends at the next rule on its own, at the tick that passes it', async ({ home, launch }) => {
  seed(home, { mode: 'dark', enabled: true, override: { themeId: AURORA, kind: 'dark', at: athens(12, 19, 52) } });
  const { app } = await launch(HOOKS);
  const tab = await activeChat(app);
  await at(app, WED_2015);
  await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: AURORA, kind: 'dark', decidedBy: 'override', until: athens(13, 7) });

  // one minute before Thursday 07:00's rule the pick still holds
  await themeHooks(app).clock(athens(13, 6, 59));
  await themeHooks(app).tick();
  expect(await themeHooks(app).shown()).toMatchObject({ themeId: AURORA, decidedBy: 'override' });
  // one minute after it nothing has evaluated the schedule yet; the tick does, and the rule shows with no word from the user
  await themeHooks(app).clock(athens(13, 7, 1));
  expect(await themeHooks(app).shown()).toMatchObject({ themeId: AURORA, decidedBy: 'override' });
  await themeHooks(app).tick();
  await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: BLEACH, kind: 'light', decidedBy: 'schedule', themeSource: 'light', until: athens(13, 19) });
  await expect.poll(() => cssToken(tab, '--d-bg')).toBe(LIGHT.background);
});

test('safe start pauses the schedule until Use my theme', async ({ home, launch }) => {
  seed(home, { mode: 'dark', enabled: true });
  const { app } = await launch({ ...HOOKS, args: ['--damocles-safe-theme'] });
  await activeChat(app);
  await at(app, WED_2015);
  await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: 'damocles', decidedBy: 'safeStart' });
  const shell = await shellPage(app);
  await shell.getByRole('region', { name: 'Started with the Damocles theme.' }).getByRole('button', { name: 'Use my theme', exact: true }).click();
  await expect.poll(async () => themeHooks(app).shown()).toMatchObject({ themeId: GALAXY, decidedBy: 'schedule' });
});
