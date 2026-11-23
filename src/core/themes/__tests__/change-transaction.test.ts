// One theme change is one transaction: its history entry, its countdown mark and every file it writes land together or not at all.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_SETTING, THEMES_DARK_SETTING } from '../../../desktop/local-services/desktop-configuration';
import type { ThemeSchedule } from '../../../shared/themes/schedule';
import type { ProjectLook } from '../../../shared/themes/project-looks';
import { SCHEDULE_FOLD_GAP_MS } from '../history';
import { createThemeService, type ThemeService } from '../index';
import { AGENT, draftOf, failReads, failWrites, fileSettings, ID, named, OTHER, OWNER, readJson, themeJson, writeTheme } from './service-fixtures';

const SCHEDULE: ThemeSchedule = { enabled: true, rules: [{ days: ['mon', 'tue', 'wed', 'thu', 'fri'], minute: 19 * 60, theme: ID, look: 'dark' }] };
const LATER: ThemeSchedule = { enabled: true, rules: [{ days: ['mon'], minute: 7 * 60, theme: ID, look: 'dark' }] };
const PROJECT = '/work/site';

let root: string;
let settingsFile: string;
let clock: number;
let themes: ThemeService;
let changes: number;

const appearanceFile = (): string => path.join(root, 'appearance.json');
const historyFile = (): string => path.join(root, 'history', 'index.json');
const projectsFile = (): string => path.join(root, 'projects.json');
const themeFile = (id: string): string => path.join(root, 'themes', id, 'theme.json');
const settingsNow = (): Record<string, unknown> => (fs.existsSync(settingsFile) ? readJson(settingsFile) : {});
const noArrangement = async (): Promise<unknown> => undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-change-'));
  settingsFile = path.join(root, 'settings.json');
  clock = 1_000_000;
  themes = createThemeService({ root, settings: fileSettings(settingsFile), now: () => clock, owner: OWNER });
  changes = 0;
  themes.onDidChange(() => changes++);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('a theme change whose history cannot be read', () => {
  it('is refused, and leaves the history, the theme and the countdown\'s mark as they were', async () => {
    writeTheme(root, ID);
    await themes.rename(ID, 'Dusk');
    const [entry] = await themes.history();
    fs.writeFileSync(appearanceFile(), JSON.stringify({ version: 1, pendingConfirm: { entryId: entry!.id, startedAt: 5, owners: [OWNER] } }));
    const history = fs.readFileSync(historyFile(), 'utf8');
    const theme = fs.readFileSync(themeFile(ID), 'utf8');
    const busy = failReads((file) => file === historyFile());
    await expect(themes.rename(ID, 'Dawn')).rejects.toThrow(/EBUSY/);
    busy.restore();
    expect(fs.readFileSync(historyFile(), 'utf8')).toBe(history);
    expect(fs.readFileSync(themeFile(ID), 'utf8')).toBe(theme);
    expect(await themes.pendingConfirm()).toEqual({ entryId: entry!.id, startedAt: 5, owners: [OWNER] });
    expect(await themes.history()).toHaveLength(1);
  });
});

describe('an on-the-fly change and its countdown mark', () => {
  const apply = (themeId = OTHER) => {
    const draft = draftOf(themes.drafts.newId(), themeId);
    return { draft, run: () => themes.applyDraft({ draft, pick: ['dark'], actor: AGENT, onTheFly: true, currentArrangement: noArrangement }) };
  };

  it('is refused before anything is written when appearance.json is of another version', async () => {
    const appearance = JSON.stringify({ version: 2, later: true });
    fs.writeFileSync(appearanceFile(), appearance);
    const { draft, run } = apply();
    await themes.drafts.put(draft);
    await expect(run()).rejects.toThrow(/newer Damocles/);
    expect(fs.existsSync(path.dirname(themeFile(OTHER)))).toBe(false);
    expect(settingsNow()).toEqual({});
    expect(fs.existsSync(historyFile())).toBe(false);
    expect(fs.readFileSync(appearanceFile(), 'utf8')).toBe(appearance);
    expect(await themes.drafts.get(draft.id)).toBeDefined();
  });

  it('sets an appearance.json that is not JSON aside as .bad and carries on', async () => {
    fs.writeFileSync(appearanceFile(), '{ "version": 1, "sched');
    const applied = await apply().run();
    expect(applied).toMatchObject({ kind: 'applied' });
    if (applied.kind !== 'applied') throw new Error('not applied');
    expect(applied.pending).toBe(applied.entryId);
    expect(fs.readFileSync(`${appearanceFile()}.bad`, 'utf8')).toBe('{ "version": 1, "sched');
    expect(readJson(appearanceFile())).toEqual({ version: 1, pendingConfirm: { entryId: applied.entryId, startedAt: clock, owners: [OWNER] } });
  });

  it('takes its mark back when the change fails, and records nothing', async () => {
    const failing = failWrites(named('theme.json'));
    await expect(apply().run()).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(await themes.pendingConfirm()).toBeUndefined();
    expect(await themes.history()).toEqual([]);
    expect(fs.existsSync(path.dirname(themeFile(OTHER)))).toBe(false);
  });

  it('records the same chat\'s undo as its own entry, so Undo brings the applied change back', async () => {
    const applied = await apply().run();
    if (applied.kind !== 'applied') throw new Error('not applied');
    const undone = await themes.agentUndo(applied.entryId, AGENT, true, noArrangement);
    expect(undone).toMatchObject({ kind: 'undone', pending: applied.entryId });
    expect(fs.existsSync(themeFile(OTHER))).toBe(false);
    expect((await themes.history()).map((entry) => entry.change.kind)).toEqual(['restore', 'create']);
    await themes.undo();
    expect(fs.existsSync(themeFile(OTHER))).toBe(true);
    expect(settingsNow()[THEMES_DARK_SETTING]).toBe(OTHER);
  });
});

describe('a change that fails part-way', () => {
  it('puts the theme back when a save\'s pins cannot be written, and records nothing', async () => {
    const file = writeTheme(root, ID);
    const before = fs.readFileSync(file, 'utf8');
    const failing = failWrites(named('projects.json'));
    await expect(themes.saveTheme(ID, themeJson(ID, 'Renamed'), undefined, [{ projectKey: PROJECT, character: 'Pip' }])).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.existsSync(projectsFile())).toBe(false);
    expect(await themes.history()).toEqual([]);
    expect(changes).toBeGreaterThan(0);
  });

  it('puts the preferred look back when a pick\'s history entry cannot be written', async () => {
    writeTheme(root, ID);
    const failing = failWrites((file) => file === historyFile());
    await expect(themes.pick(ID, 'dark')).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(settingsNow()[THEMES_DARK_SETTING]).toBeUndefined();
    expect(await themes.history()).toEqual([]);
  });

  it('removes the theme an apply created and keeps its draft, so the same apply succeeds once the disk has room', async () => {
    const draft = draftOf(themes.drafts.newId(), OTHER);
    await themes.drafts.put(draft);
    const run = () => themes.applyDraft({ draft, pick: ['dark'], actor: AGENT, onTheFly: false, currentArrangement: noArrangement });
    const failing = failWrites((file) => file === historyFile());
    await expect(run()).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(fs.existsSync(path.dirname(themeFile(OTHER)))).toBe(false);
    expect(settingsNow()[THEMES_DARK_SETTING]).toBeUndefined();
    expect(await themes.drafts.get(draft.id)).toBeDefined();
    expect(await run()).toMatchObject({ kind: 'applied', themeId: OTHER });
    expect(await themes.drafts.get(draft.id)).toBeUndefined();
  });
});

describe('a pick or a hold queued behind a delete', () => {
  it('is refused, since the theme is checked inside the write lane', async () => {
    writeTheme(root, ID);
    const removing = themes.remove(ID);
    // the expectation is attached first: the delete's own later lane run settles after the pick is refused
    const refused = expect(themes.pick(ID, 'dark')).rejects.toThrow(/is missing, broken or needs a newer Damocles/);
    await removing;
    await refused;
    expect(settingsNow()[THEMES_DARK_SETTING]).toBeUndefined();
  });

  it('holds nothing over the schedule for a theme deleted first', async () => {
    writeTheme(root, ID);
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    const removing = themes.remove(ID);
    const refused = expect(themes.hold(ID, 'dark', 7)).rejects.toThrow(/is missing, broken or needs a newer Damocles/);
    await removing;
    await refused;
    expect((await themes.schedule()).override).toBeUndefined();
  });
});

describe('a change that changes nothing the history keeps', () => {
  it('records no entry for a mode change the schedule screen makes while the schedule stays off', async () => {
    await themes.setScheduleMode('off', 'dark');
    expect(settingsNow()[THEME_SETTING]).toBe('dark');
    await themes.setScheduleMode('system', 'dark');
    expect(settingsNow()[THEME_SETTING]).toBe('system');
    expect(await themes.history()).toEqual([]);
  });

  it('records no entry for a schedule equal to the stored one', async () => {
    writeTheme(root, ID);
    expect(await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark')).toMatchObject({ entryId: expect.any(String) });
    const [entry] = await themes.history();
    clock += 5_000;
    expect(await themes.setSchedule({ enabled: true, rules: SCHEDULE.rules.map((rule) => ({ look: rule.look, theme: rule.theme, minute: rule.minute, days: [...rule.days] })) }, AGENT, false, 'dark')).toBeUndefined();
    expect(await themes.history()).toEqual([entry]);
  });
});

describe('a run of the user\'s schedule edits', () => {
  beforeEach(() => writeTheme(root, ID));

  it('is one history entry that keeps the first snapshot, so Undo returns to before the run', async () => {
    fs.writeFileSync(appearanceFile(), `${JSON.stringify({ version: 1, schedule: { enabled: false, rules: [] } }, null, 2)}\n`);
    await themes.setSchedule({ enabled: false, rules: SCHEDULE.rules }, { kind: 'user' }, false);
    clock += SCHEDULE_FOLD_GAP_MS;
    await themes.setScheduleMode('schedule', 'dark');
    clock += SCHEDULE_FOLD_GAP_MS;
    await themes.setSchedule(LATER, { kind: 'user' }, false, 'dark');
    const entries = await themes.history();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ at: clock, actor: { kind: 'user' }, change: { kind: 'schedule', enabled: true, rules: 1, mode: 'dark' } });
    await themes.undo();
    expect((await themes.schedule()).schedule).toEqual({ enabled: false, rules: [] });
    expect(settingsNow()[THEME_SETTING]).toBeUndefined();
    expect(await themes.history()).toEqual([]);
  });

  it('ends after the gap: a later edit is its own entry', async () => {
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    clock += SCHEDULE_FOLD_GAP_MS + 1;
    await themes.setSchedule(LATER, { kind: 'user' }, false, 'dark');
    expect(await themes.history()).toHaveLength(2);
    await themes.undo();
    expect((await themes.schedule()).schedule).toEqual(SCHEDULE);
  });

  it('never takes in an agent\'s entry, and an agent\'s entries never fold', async () => {
    await themes.setSchedule(SCHEDULE, AGENT, false, 'dark');
    await themes.setSchedule(LATER, AGENT, false, 'dark');
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    await themes.setSchedule(LATER, AGENT, false, 'dark');
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    expect((await themes.history()).map((entry) => entry.actor.kind)).toEqual(['user', 'agent', 'user', 'agent', 'agent']);
  });

  it('ends at an entry of another kind', async () => {
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    await themes.pick(ID, 'dark');
    await themes.setSchedule(LATER, { kind: 'user' }, false, 'dark');
    expect((await themes.history()).map((entry) => entry.change.kind)).toEqual(['schedule', 'pick', 'schedule']);
  });

  it('records nothing for an edit that is refused', async () => {
    const appearance = JSON.stringify({ version: 2 });
    fs.writeFileSync(appearanceFile(), appearance);
    await expect(themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark')).rejects.toThrow(/newer Damocles/);
    expect(fs.readFileSync(appearanceFile(), 'utf8')).toBe(appearance);
    expect(await themes.history()).toEqual([]);
    expect(settingsNow()).toEqual({});
  });

  it('keeps the run\'s first snapshot when a later edit of it fails', async () => {
    await themes.setSchedule(SCHEDULE, { kind: 'user' }, false, 'dark');
    const history = fs.readFileSync(historyFile(), 'utf8');
    const failing = failWrites((file) => file === historyFile());
    await expect(themes.setSchedule(LATER, { kind: 'user' }, false, 'dark')).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(fs.readFileSync(historyFile(), 'utf8')).toBe(history);
    expect((await themes.schedule()).schedule).toEqual(SCHEDULE);
  });
});

describe('a project look', () => {
  it('is compared and stored in its checked form, whatever the caller\'s key order or letter case', async () => {
    const saved = await themes.setProjectLook(PROJECT, { accent: '#3A86FF', mode: 'touches' } as ProjectLook, { name: 'site' });
    expect(saved).toBeDefined();
    expect(readJson(projectsFile())['looks']).toEqual({ [PROJECT]: { mode: 'touches', accent: '#3a86ff' } });
    expect(await themes.setProjectLook(PROJECT, { mode: 'touches', accent: '#3a86ff' }, { name: 'site' })).toBeUndefined();
    expect(await themes.setProjectLook(PROJECT, { accent: '#3A86FF', mode: 'touches' } as ProjectLook, { name: 'site' })).toBeUndefined();
    expect(await themes.history()).toHaveLength(1);
    await expect(themes.setProjectLook(PROJECT, { mode: 'touches', accent: 'red' }, { name: 'site' })).rejects.toThrow(/not valid/);
    expect(await themes.history()).toHaveLength(1);
  });
});

describe('a projects.json of a newer version', () => {
  const NEWER = JSON.stringify({ version: 2, looks: { [PROJECT]: { mode: 'touches', accent: '#3a86ff' } }, later: true });

  it('shows no looks, and is refused and left alone by a look change and by a save with pins', async () => {
    const theme = writeTheme(root, ID);
    const before = fs.readFileSync(theme, 'utf8');
    fs.writeFileSync(projectsFile(), NEWER);
    expect(await themes.projectLooks.shownLooks()).toEqual({});
    await expect(themes.setProjectLook(PROJECT, { mode: 'touches', accent: '#ff0000' }, { name: 'site' })).rejects.toThrow(/newer Damocles/);
    await expect(themes.saveTheme(ID, themeJson(ID, 'Renamed'), undefined, [{ projectKey: PROJECT, character: 'Pip' }])).rejects.toThrow(/newer Damocles/);
    await themes.reset(undefined, PROJECT);
    expect(fs.readFileSync(projectsFile(), 'utf8')).toBe(NEWER);
    expect(fs.readFileSync(theme, 'utf8')).toBe(before);
    expect((await themes.history()).map((entry) => entry.change.kind)).toEqual(['reset']);
  });

  it('a projects.json that is not JSON is set aside as .bad and written again', async () => {
    fs.writeFileSync(projectsFile(), '{ "version": 1, "loo');
    await themes.setProjectLook(PROJECT, { mode: 'touches', accent: '#ff0000' }, { name: 'site' });
    expect(fs.readFileSync(`${projectsFile()}.bad`, 'utf8')).toBe('{ "version": 1, "loo');
    expect(await themes.projectLooks.shownLooks()).toEqual({ [PROJECT]: { mode: 'touches', accent: '#ff0000' } });
  });
});

describe('a history file of a newer version', () => {
  const NEWER = JSON.stringify({ version: 2, entries: [{ id: 'later', at: 1, actor: { kind: 'user' }, change: { kind: 'reset' }, before: {} }], later: true });

  it('lists no entries, and refuses every change, undo and restore before anything is written', async () => {
    const theme = writeTheme(root, ID);
    const before = fs.readFileSync(theme, 'utf8');
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), NEWER);
    fs.writeFileSync(appearanceFile(), JSON.stringify({ version: 1, pendingConfirm: { entryId: 'later', startedAt: 5, owners: [OWNER] } }));
    const appearance = fs.readFileSync(appearanceFile(), 'utf8');
    expect(await themes.history()).toEqual([]);
    await expect(themes.rename(ID, 'Dawn')).rejects.toThrow(/newer Damocles/);
    await expect(themes.pick(ID, 'dark')).rejects.toThrow(/newer Damocles/);
    await expect(themes.undo()).rejects.toThrow(/newer Damocles/);
    await expect(themes.undo('later')).rejects.toThrow(/newer Damocles/);
    await expect(themes.restore('later')).rejects.toThrow(/newer Damocles/);
    expect(fs.readFileSync(historyFile(), 'utf8')).toBe(NEWER);
    expect(fs.readFileSync(theme, 'utf8')).toBe(before);
    expect(fs.readFileSync(appearanceFile(), 'utf8')).toBe(appearance);
    expect(settingsNow()).toEqual({});
  });

  it('is left alone when a project is forgotten, whose looks leave projects.json all the same', async () => {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), NEWER);
    fs.writeFileSync(projectsFile(), JSON.stringify({ version: 1, looks: { [PROJECT]: { mode: 'touches', accent: '#3a86ff' } } }));
    await themes.projectLooks.forgetProject(PROJECT);
    expect(await themes.projectLooks.shownLooks()).toEqual({});
    expect(fs.readFileSync(historyFile(), 'utf8')).toBe(NEWER);
  });
});

describe('an undo or a restore that fails part-way', () => {
  // two changes of one countdown: a theme created and picked, then the schedule turned on
  const twoChanges = async (): Promise<string> => {
    const draft = draftOf(themes.drafts.newId(), OTHER);
    const applied = await themes.applyDraft({ draft, pick: ['dark'], actor: AGENT, onTheFly: true, currentArrangement: noArrangement });
    if (applied.kind !== 'applied') throw new Error('not applied');
    await themes.setSchedule(SCHEDULE, { kind: 'agent', chatId: 'chat-b', title: 'Evenings' }, true);
    return applied.entryId;
  };
  const state = (): unknown => ({
    theme: fs.readFileSync(themeFile(OTHER), 'utf8'),
    // as an object: a write that keeps the mark may order the file's keys anew
    appearance: readJson(appearanceFile()),
    history: fs.readFileSync(historyFile(), 'utf8'),
    settings: settingsNow(),
  });

  it('leaves everything as it was when an undo cannot write projects.json', async () => {
    writeTheme(root, ID);
    await themes.setProjectLook(PROJECT, { mode: 'touches', accent: '#3a86ff' }, { name: 'site' });
    await themes.saveTheme(ID, themeJson(ID, 'Renamed'), undefined, [{ projectKey: PROJECT, character: 'Pip' }]);
    const before = { theme: fs.readFileSync(themeFile(ID), 'utf8'), projects: fs.readFileSync(projectsFile(), 'utf8'), history: fs.readFileSync(historyFile(), 'utf8') };
    const failing = failWrites(named('projects.json'));
    await expect(themes.undo()).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect({ theme: fs.readFileSync(themeFile(ID), 'utf8'), projects: fs.readFileSync(projectsFile(), 'utf8'), history: fs.readFileSync(historyFile(), 'utf8') }).toEqual(before);
  });

  it('leaves everything as it was when the banner\'s revert cannot write the history', async () => {
    const entryId = await twoChanges();
    const before = state();
    const failing = failWrites((file) => file === historyFile());
    await expect(themes.undo(entryId)).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(state()).toEqual(before);
    expect((await themes.pendingConfirm())?.entryId).toBe(entryId);
    // the same revert succeeds once the disk has room
    await themes.undo(entryId);
    expect(fs.existsSync(themeFile(OTHER))).toBe(false);
    expect(await themes.history()).toEqual([]);
  });

  it('leaves everything as it was when a restore cannot write the history', async () => {
    const entryId = await twoChanges();
    const before = state();
    const failing = failWrites((file) => file === historyFile());
    await expect(themes.restore(entryId)).rejects.toThrow(/ENOSPC/);
    failing.restore();
    expect(state()).toEqual(before);
  });

  it('keeps a launch\'s unsettled change whole when its revert fails, and reports it kept', async () => {
    const entryId = await twoChanges();
    const { appearance: _mark, ...before } = state() as Record<string, unknown>;
    const failing = failWrites((file) => file === historyFile());
    expect(await themes.settlePendingAtStart()).toEqual({ entryId, outcome: 'kept' });
    failing.restore();
    const { appearance: _cleared, ...after } = state() as Record<string, unknown>;
    expect(after).toEqual(before);
    expect(await themes.pendingConfirm()).toBeUndefined();
    expect((await themes.schedule()).schedule.enabled).toBe(true);
  });
});
