import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import type { LookColors } from '../../../shared/themes/schema';
import { scheduleChoiceOf, type ThemeSchedule } from '../../../shared/themes/schedule';
import { THEME_SETTING, THEMES_DARK_SETTING } from '../../../desktop/local-services/desktop-configuration';
import { createThemeService, type ThemeService } from '../index';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COLORS: LookColors = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const AGENT = { kind: 'agent', chatId: 'chat-a', title: 'Evenings' } as const;
const SCHEDULE: ThemeSchedule = { enabled: true, rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], minute: 19 * 60, theme: ID, look: 'dark' }] };

let root: string;
let settingsFile: string;
let themes: ThemeService;

const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
const settingsNow = (): Record<string, unknown> => (fs.existsSync(settingsFile) ? readJson(settingsFile) : {});
const appearanceNow = (): Record<string, unknown> => readJson(path.join(root, 'appearance.json'));

function fileSettings(): SettingsStore {
  return {
    get: (key: string) => settingsNow()[key],
    inspect: () => ({}),
    update: async (key: string, value: unknown) => {
      fs.writeFileSync(settingsFile, JSON.stringify({ ...settingsNow(), [key]: value }));
    },
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? settingsFile : undefined),
  } as unknown as SettingsStore;
}

// What the Mode row and the schedule screen's radio read: the mode setting and appearance.json's schedule.
async function controls(): Promise<{ readonly modeRow: string; readonly radio: string }> {
  const mode = settingsNow()[THEME_SETTING];
  const modeRow = mode === 'dark' || mode === 'light' ? mode : 'system';
  const { schedule } = await themes.schedule();
  return { modeRow, radio: scheduleChoiceOf(modeRow, schedule.enabled) };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-schedule-'));
  settingsFile = path.join(root, 'settings.json');
  fs.mkdirSync(path.join(root, 'themes', ID), { recursive: true });
  fs.writeFileSync(path.join(root, 'themes', ID, 'theme.json'), JSON.stringify({ schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } } }));
  themes = createThemeService({ root, settings: fileSettings(), now: () => 1_000 });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the theme schedule in core', () => {
  it('Use a schedule from System makes the mode the kind on screen, and the Mode row and the radio agree at every step', async () => {
    await themes.setSchedule({ ...SCHEDULE, enabled: false }, { kind: 'user' }, false);
    expect(await controls()).toEqual({ modeRow: 'system', radio: 'system' });

    await themes.setScheduleMode('schedule', 'light');
    expect(settingsNow()[THEME_SETTING]).toBe('light');
    expect((await themes.schedule()).schedule.enabled).toBe(true);
    expect(await controls()).toEqual({ modeRow: 'light', radio: 'schedule' });

    // the Mode row's Dark keeps the schedule; its System turns it off
    await themes.setMode('dark');
    expect(await controls()).toEqual({ modeRow: 'dark', radio: 'schedule' });
    await themes.setMode('system');
    expect((await themes.schedule()).schedule.enabled).toBe(false);
    expect(await controls()).toEqual({ modeRow: 'system', radio: 'system' });

    // Off from System fixes the mode at the kind on screen
    await themes.setScheduleMode('off', 'dark');
    expect(await controls()).toEqual({ modeRow: 'dark', radio: 'off' });
    await themes.setScheduleMode('system', 'dark');
    expect(await controls()).toEqual({ modeRow: 'system', radio: 'system' });
  });

  it('records a change that turns the schedule on or off in the history, and Undo puts the mode and the schedule back together', async () => {
    await themes.setSchedule({ ...SCHEDULE, enabled: false }, AGENT, false);
    await themes.setScheduleMode('schedule', 'dark');
    const [entry, rules] = await themes.history();
    expect(entry).toMatchObject({ actor: { kind: 'user' }, change: { kind: 'schedule', enabled: true, rules: 1, mode: 'dark' } });
    expect(rules).toMatchObject({ actor: AGENT, change: { kind: 'schedule', enabled: false, rules: 1 } });
    await themes.undo();
    expect(settingsNow()[THEME_SETTING]).toBeUndefined();
    expect((await themes.schedule()).schedule).toEqual({ ...SCHEDULE, enabled: false });
    // a mode change alone is not a theme change the history keeps, whichever control makes it
    const count = (await themes.history()).length;
    await themes.setMode('light');
    expect(settingsNow()[THEME_SETTING]).toBe('light');
    await themes.setScheduleMode('system', 'dark');
    expect(settingsNow()[THEME_SETTING]).toBe('system');
    await themes.setScheduleMode('off', 'dark');
    expect(settingsNow()[THEME_SETTING]).toBe('dark');
    // nothing to change records nothing
    await themes.setScheduleMode('off', 'dark');
    expect((await themes.history()).length).toBe(count);
  });

  it('a write of the rules alone keeps whether the schedule is on as the file has it when the write runs', async () => {
    const RULES = [{ days: ['sat', 'sun'] as const, minute: 9 * 60, theme: ID, look: 'auto' as const }];
    // off stays off, under System mode too, where a schedule may never be on
    await themes.setScheduleRules(RULES);
    expect((await themes.schedule()).schedule).toEqual({ enabled: false, rules: RULES });
    expect(await controls()).toEqual({ modeRow: 'system', radio: 'system' });
    expect((await themes.history())[0]).toMatchObject({ actor: { kind: 'user' }, change: { kind: 'schedule', enabled: false, rules: 1 } });

    // a mode change and a rule edit sent one after the other: the edit, built before the mode change landed, does not undo it
    const mode = themes.setScheduleMode('schedule', 'dark');
    const edit = themes.setScheduleRules([...RULES, ...SCHEDULE.rules]);
    await Promise.all([mode, edit]);
    expect((await themes.schedule()).schedule).toEqual({ enabled: true, rules: [...RULES, ...SCHEDULE.rules] });
    expect(await controls()).toEqual({ modeRow: 'dark', radio: 'schedule' });

    // a pick that holds over the schedule outlives a rule edit, and rules equal to the stored ones record nothing
    await themes.hold('damocles', 'light', 7);
    const count = (await themes.history()).length;
    await themes.setScheduleRules([...RULES, ...SCHEDULE.rules]);
    expect((await themes.history()).length).toBe(count);
    await themes.setScheduleRules(RULES);
    expect((await themes.schedule())).toEqual({ schedule: { enabled: true, rules: RULES }, override: { themeId: 'damocles', kind: 'light', at: 7 } });
    await themes.undo();
    expect((await themes.schedule()).schedule.rules).toEqual([...RULES, ...SCHEDULE.rules]);
  });

  it('a pick while the schedule runs holds over it from its time; without a running schedule it only sets the preferred look', async () => {
    await themes.pick(ID, 'dark');
    expect((await themes.schedule()).override).toBeUndefined();
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    await themes.pick(ID, 'dark', { at: 42 });
    expect(settingsNow()[THEMES_DARK_SETTING]).toBe(ID);
    expect((await themes.schedule()).override).toEqual({ themeId: ID, kind: 'dark', at: 42 });
    // Undo of the pick takes the hold back with the preferred look
    await themes.undo();
    expect((await themes.schedule()).override).toBeUndefined();
  });

  it('Toggle Theme holds the other look over a running schedule, and Resume schedule now ends the hold', async () => {
    await themes.hold('damocles', 'light', 7);
    expect((await themes.schedule()).override).toBeUndefined();
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    await themes.hold('damocles', 'light', 7);
    expect((await themes.schedule()).override).toEqual({ themeId: 'damocles', kind: 'light', at: 7 });
    expect((await themes.history())[0]?.change).toEqual({ kind: 'hold', theme: 'Damocles', look: 'light' });
    await themes.resumeSchedule();
    expect((await themes.schedule()).override).toBeUndefined();
    expect((await themes.history())[0]?.change).toEqual({ kind: 'resume' });
    await expect(themes.hold(ID, 'light', 8)).rejects.toThrow();
  });

  it('Reset Theme to Default turns the schedule off and drops the hold in one entry that Undo reverses', async () => {
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    await themes.hold('damocles', 'light', 7);
    await themes.reset();
    expect(appearanceNow()['override']).toBeUndefined();
    expect((await themes.schedule()).schedule.enabled).toBe(false);
    expect((await themes.history())[0]?.change).toEqual({ kind: 'reset' });
    await themes.undo();
    expect((await themes.schedule())).toEqual({ schedule: SCHEDULE, override: { themeId: 'damocles', kind: 'light', at: 7 } });
  });
});
