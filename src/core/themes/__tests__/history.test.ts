import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import type { ThemeActor } from '../../../shared/themes/changes';
import type { LookColors } from '../../../shared/themes/schema';
import { THEMES_DARK_SETTING, THEMES_LIGHT_SETTING } from '../../../desktop/local-services/desktop-configuration';
import { createThemeService } from '../index';
import { createThemeHistory, HISTORY_LIMIT, SCHEDULE_FOLD_GAP_MS, type SnapshotIo } from '../history';
import { writeFileAtomic } from '../store';
import { failReads } from './service-fixtures';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COLORS: LookColors = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };

let root: string;
let settingsFile: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-history-'));
  settingsFile = path.join(root, 'settings.json');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const themeFile = (id: string): string => path.join(root, 'themes', id, 'theme.json');
const readJson = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;

function writeTheme(id: string, name: string): void {
  fs.mkdirSync(path.dirname(themeFile(id)), { recursive: true });
  fs.writeFileSync(themeFile(id), JSON.stringify({ schemaVersion: 1, id, name, looks: { dark: { colors: COLORS } } }));
}

// A settings store over one user settings file, as the desktop store writes it.
function fileSettings(): SettingsStore {
  const read = (): Record<string, unknown> => (fs.existsSync(settingsFile) ? readJson(settingsFile) : {});
  return {
    get: (key: string) => read()[key],
    inspect: () => ({}),
    update: async (key: string, value: unknown) => {
      fs.writeFileSync(settingsFile, JSON.stringify({ ...read(), [key]: value }));
    },
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? settingsFile : undefined),
  } as unknown as SettingsStore;
}

describe('theme history', () => {
  it('undoes a pick, putting the previous preferred look and the window arrangement back', async () => {
    writeTheme(ID, 'Night');
    const themes = createThemeService({ root, settings: fileSettings() });
    const arrangement = { sidebarWidth: 300 };
    await themes.pick(ID, 'dark', { arrangementBefore: arrangement });
    expect(readJson(settingsFile)[THEMES_DARK_SETTING]).toBe(ID);
    const [entry] = await themes.history();
    expect(entry).toMatchObject({ actor: { kind: 'user' }, change: { kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' } });
    expect(await themes.undo()).toEqual({ undone: entry!.change, arrangement });
    expect(readJson(settingsFile)[THEMES_DARK_SETTING]).toBeUndefined();
    expect(await themes.history()).toEqual([]);
    expect(await themes.undo()).toEqual({});
  });

  it('records one entry for a look picked twice, and says which pick recorded it', async () => {
    writeTheme(ID, 'Night');
    const themes = createThemeService({ root, settings: fileSettings() });
    expect(await themes.pick(ID, 'dark')).toBe(true);
    expect(await themes.pick(ID, 'dark')).toBe(false);
    expect((await themes.history()).map((entry) => entry.change)).toEqual([{ kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' }]);
  });

  it('refuses an undo that names an entry another change was made after, and undoes the one it names while it is the newest', async () => {
    writeTheme(ID, 'Night');
    const themes = createThemeService({ root, settings: fileSettings() });
    await themes.pick(ID, 'dark');
    const [picked] = await themes.history();
    await themes.rename(ID, 'Dusk');
    await expect(themes.undo(undefined, picked!.id)).rejects.toThrow('Another theme change was made after this one, so nothing was undone.');
    expect((await themes.history()).map((entry) => entry.change.kind)).toEqual(['rename', 'pick']);
    expect(readJson(themeFile(ID))['name']).toBe('Dusk');
    const [renamed] = await themes.history();
    expect(await themes.undo(undefined, renamed!.id)).toEqual({ undone: renamed!.change });
    expect(await themes.undo(undefined, picked!.id)).toEqual({ undone: picked!.change });
    // nothing is left, so the entry it names is gone
    await expect(themes.undo(undefined, picked!.id)).rejects.toThrow('Another theme change was made after this one');
  });

  it('undoes a rename, a save, a delete and a duplicate by putting each theme.json back as it was', async () => {
    writeTheme(ID, 'Night');
    const original = fs.readFileSync(themeFile(ID), 'utf8');
    const themes = createThemeService({ root, settings: fileSettings() });
    await themes.rename(ID, 'Midnight');
    await themes.saveTheme(ID, { schemaVersion: 1, id: ID, name: 'Midnight', looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } } } });
    await themes.remove(ID);
    const copy = await themes.duplicate('damocles', 'Mine');
    expect(fs.existsSync(themeFile(copy))).toBe(true);
    await themes.undo();
    expect(fs.existsSync(path.dirname(themeFile(copy)))).toBe(false);
    await themes.undo();
    expect((readJson(themeFile(ID))['looks'] as { dark: { colors: LookColors } }).dark.colors.accent).toBe('#ff00aa');
    await themes.undo();
    expect(readJson(themeFile(ID))['name']).toBe('Midnight');
    await themes.undo();
    expect(fs.readFileSync(themeFile(ID), 'utf8')).toBe(original);
  });

  it('reverses Reset as one entry: both preferred looks and appearance.json', async () => {
    fs.writeFileSync(settingsFile, JSON.stringify({ [THEMES_DARK_SETTING]: ID, [THEMES_LIGHT_SETTING]: ID, other: 1 }));
    const appearance = `${JSON.stringify({ version: 1, schedule: { enabled: true, rules: [] } })}\n`;
    fs.writeFileSync(path.join(root, 'appearance.json'), appearance);
    const themes = createThemeService({ root, settings: fileSettings() });
    await themes.reset();
    expect(await themes.history()).toHaveLength(1);
    expect(readJson(settingsFile)).toMatchObject({ [THEMES_DARK_SETTING]: 'damocles', [THEMES_LIGHT_SETTING]: 'damocles' });
    await themes.undo();
    expect(readJson(settingsFile)).toEqual({ [THEMES_DARK_SETTING]: ID, [THEMES_LIGHT_SETTING]: ID, other: 1 });
    expect(fs.readFileSync(path.join(root, 'appearance.json'), 'utf8')).toBe(appearance);
  });

  it('restores to before an entry by applying it and every later one, newest first, as one entry Undo reverses', async () => {
    writeTheme(ID, 'Night');
    const original = fs.readFileSync(themeFile(ID), 'utf8');
    const themes = createThemeService({ root, settings: fileSettings() });
    await themes.rename(ID, 'Dusk');
    await themes.pick(ID, 'dark', { arrangementBefore: { sidebarWidth: 250 } });
    await themes.rename(ID, 'Dawn');
    const entries = await themes.history();
    const rename = entries.at(-1)!;
    expect(await themes.restore(rename.id, { sidebarWidth: 400 })).toEqual({ arrangement: { sidebarWidth: 250 } });
    expect(fs.readFileSync(themeFile(ID), 'utf8')).toBe(original);
    expect(readJson(settingsFile)[THEMES_DARK_SETTING]).toBeUndefined();
    const [restore] = await themes.history();
    expect(restore).toMatchObject({ change: { kind: 'restore', before: { kind: 'rename', theme: 'Dusk', was: 'Night' } } });
    expect(await themes.history()).toHaveLength(4);
    expect(await themes.undo()).toMatchObject({ arrangement: { sidebarWidth: 400 } });
    expect(readJson(themeFile(ID))['name']).toBe('Dawn');
    expect(readJson(settingsFile)[THEMES_DARK_SETTING]).toBe(ID);
  });

  it('turns Show wallpapers off as one agent entry, whose undo takes the key back out of the user settings file', async () => {
    const settings = fileSettings();
    const themes = createThemeService({ root, settings });
    const actor = { kind: 'agent', chatId: 'chat-a', title: 'Calm it down' } as const;
    const off = await themes.wallpapersOff(actor, false);
    expect(off).toMatchObject({ change: { kind: 'wallpapersOff' } });
    expect(off?.pending).toBeUndefined();
    expect(readJson(settingsFile)['damocles.desktop.themes.showWallpapers']).toBe(false);
    expect(await themes.wallpapersOff(actor, false)).toBeUndefined();
    expect(await themes.history()).toEqual([expect.objectContaining({ actor, change: { kind: 'wallpapersOff' } })]);
    expect(await themes.undo()).toEqual({ undone: { kind: 'wallpapersOff' } });
    expect(readJson(settingsFile)).not.toHaveProperty('damocles.desktop.themes.showWallpapers');
  });

  it('undoes an entry and every later one as the oldest held each item, and gives back the oldest arrangement', async () => {
    writeTheme(ID, 'Night');
    const themes = createThemeService({ root, settings: fileSettings() });
    await themes.pick(ID, 'dark', { arrangementBefore: { sidebarWidth: 300 } });
    await themes.rename(ID, 'Dusk');
    // back to the built-in look: a second pick of the same look would record nothing
    await themes.pick('damocles', 'dark', { arrangementBefore: { sidebarWidth: 400 } });
    const io: SnapshotIo = {
      readSettings: async () => ({ dark: null, light: null }), writeSettings: async () => undefined, readMode: async () => null, writeMode: async () => undefined,
      readShowWallpapers: async () => null, writeShowWallpapers: async () => undefined, readAppearance: async () => null, writeAppearance: async () => undefined,
      readTheme: async () => null, writeTheme: async () => undefined, readProjects: async () => null, writeProjects: async () => undefined,
    };
    const history = createThemeHistory({ root, io, writeText: writeFileAtomic });
    const [newest, middle, first] = await history.entries();
    expect(await history.undoThrough('no-such-entry')).toEqual({ undone: [] });
    const { undone, arrangement } = await history.undoThrough(first!.id);
    expect(undone.map((entry) => entry.id)).toEqual([newest!.id, middle!.id, first!.id]);
    expect(arrangement).toEqual({ sidebarWidth: 300 });
    expect(await history.entries()).toEqual([]);
  });

  it('keeps the newest HISTORY_LIMIT entries across a relaunch, and the agent actor its chat', async () => {
    const values = new Map<string, string | null>();
    const io: SnapshotIo = {
      readSettings: async () => ({ dark: null, light: null }),
      writeSettings: async () => undefined,
      readMode: async () => null,
      writeMode: async () => undefined,
      readShowWallpapers: async () => null,
      writeShowWallpapers: async () => undefined,
      readAppearance: async () => null,
      writeAppearance: async () => undefined,
      readTheme: async (id) => values.get(id) ?? null,
      writeTheme: async (id, text) => {
        values.set(id, text);
      },
      readProjects: async () => null,
      writeProjects: async () => undefined,
    };
    let tick = 0;
    const history = createThemeHistory({ root, io, writeText: writeFileAtomic, now: () => ++tick });
    const agent: ThemeActor = { kind: 'agent', chatId: 'chat-1', title: 'Warmer sidebar' };
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await history.record(i % 2 === 0 ? agent : { kind: 'user' }, { kind: 'save', theme: `Theme ${i}` }, { themes: { [ID]: `text ${i}` } });
    const relaunched = createThemeHistory({ root, io, writeText: writeFileAtomic });
    const entries = await relaunched.entries();
    expect(entries).toHaveLength(HISTORY_LIMIT);
    expect(entries[0]).toMatchObject({ change: { theme: `Theme ${HISTORY_LIMIT + 4}` }, actor: agent });
    expect(entries.at(-1)).toMatchObject({ change: { theme: 'Theme 5' } });
    await relaunched.undo();
    expect(values.get(ID)).toBe(`text ${HISTORY_LIMIT + 4}`);
  });

  it('starts empty from a history file that does not parse, and drops an entry with no actor', async () => {
    const io = {} as SnapshotIo;
    fs.mkdirSync(path.join(root, 'history'), { recursive: true });
    fs.writeFileSync(path.join(root, 'history', 'index.json'), '{ broken');
    expect(await createThemeHistory({ root, io, writeText: writeFileAtomic }).entries()).toEqual([]);
    fs.writeFileSync(path.join(root, 'history', 'index.json'), JSON.stringify({ version: 1, entries: [{ id: 'a', at: 1, change: { kind: 'reset' }, before: {} }] }));
    expect(await createThemeHistory({ root, io, writeText: writeFileAtomic }).entries()).toEqual([]);
  });

  it('never starts empty from a history file a read of it failed on, so its entries are not replaced by the next one', async () => {
    const file = path.join(root, 'history', 'index.json');
    const history = createThemeHistory({ root, io: {} as SnapshotIo, writeText: writeFileAtomic });
    await history.record({ kind: 'user' }, { kind: 'reset' }, {});
    const text = fs.readFileSync(file, 'utf8');
    for (const code of ['EBUSY', 'EACCES', 'EMFILE']) {
      const failing = failReads((read) => read === file, code);
      await expect(history.entries()).rejects.toThrow(code);
      await expect(history.record({ kind: 'user' }, { kind: 'reset' }, {})).rejects.toThrow(code);
      await expect(history.undo()).rejects.toThrow(code);
      failing.restore();
    }
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
    expect(await history.entries()).toHaveLength(1);
  });

  it('drops an entry whose before-snapshot holds a value it could not write back, and writes nothing for it', async () => {
    const written: string[] = [];
    const io: SnapshotIo = {
      readSettings: async () => ({ dark: null, light: null }), writeSettings: async () => void written.push('settings'), readMode: async () => null, writeMode: async () => void written.push('mode'),
      readShowWallpapers: async () => null, writeShowWallpapers: async () => void written.push('showWallpapers'), readAppearance: async () => null, writeAppearance: async () => void written.push('appearance'),
      readTheme: async () => null, writeTheme: async () => void written.push('theme'), readProjects: async () => null, writeProjects: async () => void written.push('projects'),
    };
    const entry = (id: string, before: unknown) => ({ id, at: 1, actor: { kind: 'user' }, change: { kind: 'reset' }, before });
    const malformed: unknown[] = [
      { settings: { sepia: 'x' } }, { settings: { dark: 7 } }, { settings: 'dark' }, { mode: 3 }, { showWallpapers: 'no' }, { appearance: { version: 1 } }, { projects: 5 },
      { themes: { '../escape': '{}' } }, { themes: { [ID]: { name: 'Night' } } }, { themes: [ID] },
    ];
    const kept = { settings: { dark: null, light: 'damocles' }, mode: null, showWallpapers: true, appearance: null, themes: { [ID]: null }, projects: '{}', arrangement: { any: 'shape' }, later: 1 };
    fs.mkdirSync(path.join(root, 'history'), { recursive: true });
    fs.writeFileSync(path.join(root, 'history', 'index.json'), JSON.stringify({ version: 1, entries: [entry('kept', kept), ...malformed.map((before, at) => entry(`bad-${at}`, before))] }));
    const history = createThemeHistory({ root, io, writeText: writeFileAtomic });
    expect((await history.entries()).map((stored) => stored.id)).toEqual(['kept']);
    expect(await history.undoThrough('bad-0')).toEqual({ undone: [] });
    expect(written).toEqual([]);
    await history.undo();
    expect(written).toEqual(['theme', 'appearance', 'projects', 'settings', 'mode', 'showWallpapers']);
  });

  it('folds only the user\'s schedule edits made within the gap into the newest entry, which keeps its oldest values', async () => {
    let clock = 0;
    const history = createThemeHistory({ root, io: {} as SnapshotIo, writeText: writeFileAtomic, now: () => clock });
    const user: ThemeActor = { kind: 'user' };
    const agent: ThemeActor = { kind: 'agent', chatId: 'chat-1', title: 'Evenings' };
    const first = await history.record(user, { kind: 'schedule', enabled: true, rules: 1, mode: 'dark' }, { appearance: null, mode: null });
    clock = SCHEDULE_FOLD_GAP_MS;
    expect(await history.record(user, { kind: 'schedule', enabled: true, rules: 2 }, { appearance: 'one' })).toBe(first);
    expect(await history.entries()).toEqual([{ id: first, at: clock, actor: user, change: { kind: 'schedule', enabled: true, rules: 2, mode: 'dark' }, before: { appearance: null, mode: null } }]);
    clock += SCHEDULE_FOLD_GAP_MS + 1;
    const later = await history.record(user, { kind: 'schedule', enabled: false, rules: 2 }, { appearance: 'two' });
    const fixed = await history.record(user, { kind: 'schedule', enabled: true, rules: 2 }, { appearance: 'three' }, { id: 'fixed-id' });
    const agents = await history.record(agent, { kind: 'schedule', enabled: false, rules: 2 }, { appearance: 'four' });
    const after = await history.record(user, { kind: 'schedule', enabled: true, rules: 2 }, { appearance: 'five' });
    const other = await history.record(user, { kind: 'resume' }, { appearance: 'six' });
    const last = await history.record(user, { kind: 'schedule', enabled: false, rules: 2 }, { appearance: 'seven' });
    expect(fixed).toBe('fixed-id');
    expect((await history.entries()).map((entry) => entry.id)).toEqual([last, other, after, agents, fixed, later, first]);
  });
});

describe('a history entry of a change kind a newer Damocles recorded', () => {
  const historyFile = (): string => path.join(root, 'history', 'index.json');
  const teleport = { kind: 'teleport', to: 'Mars', theme: '' };
  const stored = (id: string, change: unknown, before: unknown, actor: unknown = { kind: 'user' }) => ({ id, at: 1, actor, change, before, extra: 'kept' });
  const writeEntries = (entries: readonly unknown[]): void => {
    fs.mkdirSync(path.dirname(historyFile()), { recursive: true });
    fs.writeFileSync(historyFile(), JSON.stringify({ version: 1, entries }));
  };
  const fileEntries = (): unknown[] => (readJson(historyFile())['entries'] as unknown[]);

  it('stays in the file as written, is listed as other, and is undone when its snapshot can be written back', async () => {
    const newer = stored('newer', teleport, { settings: { dark: ID } });
    writeEntries([newer]);
    writeTheme(ID, 'Night');
    const themes = createThemeService({ root, settings: fileSettings() });
    expect(await themes.history()).toEqual([{ id: 'newer', at: 1, actor: { kind: 'user' }, change: { kind: 'other' } }]);
    await themes.rename(ID, 'Dusk');
    expect(fileEntries()[0]).toEqual(newer);
    await themes.undo();
    expect(await themes.undo()).toEqual({ undone: { kind: 'other' } });
    expect(readJson(settingsFile)[THEMES_DARK_SETTING]).toBe(ID);
    expect(await themes.history()).toEqual([]);
  });

  it('is restored to before as a change this Damocles names as other', async () => {
    writeEntries([stored('newer', teleport, { settings: { dark: ID } })]);
    const themes = createThemeService({ root, settings: fileSettings() });
    await themes.restore('newer');
    expect((await themes.history())[0]).toMatchObject({ change: { kind: 'restore', before: { kind: 'other' } } });
    expect(fileEntries()[0]).toMatchObject({ change: teleport });
  });

  it('blocks every undo that would reach a snapshot this Damocles cannot write back, and nothing is written', async () => {
    const older = stored('older', { kind: 'reset' }, { settings: { dark: ID } });
    const fixed = stored('fixed', teleport, { settings: { highContrast: 'x' }, projects: 7 });
    writeEntries([older, fixed]);
    const text = fs.readFileSync(historyFile(), 'utf8');
    const themes = createThemeService({ root, settings: fileSettings() });
    expect(await themes.history()).toEqual([
      { id: 'fixed', at: 1, actor: { kind: 'user' }, change: { kind: 'other' }, cannotUndo: true },
      { id: 'older', at: 1, actor: { kind: 'user' }, change: { kind: 'reset' } },
    ]);
    await expect(themes.undo()).rejects.toThrow('A newer Damocles made a theme change that this one cannot undo, so nothing was changed.');
    await expect(themes.restore('older')).rejects.toThrow(/cannot undo/);
    await expect(themes.restore('fixed')).rejects.toThrow(/cannot undo/);
    expect(fs.readFileSync(historyFile(), 'utf8')).toBe(text);
    expect(fs.existsSync(settingsFile)).toBe(false);
    // a projects.json rewrite of every snapshot leaves the one it cannot read alone
    await themes.projectLooks.forgetHost('ssh+gone');
    expect(fileEntries()).toEqual([older, fixed]);
  });

  it("refuses a chat's undo of its own change once such an entry followed it", async () => {
    const agent = { kind: 'agent', chatId: 'chat-1', title: 'Evenings' };
    writeEntries([stored('mine', { kind: 'reset' }, { settings: { dark: ID } }, agent), stored('fixed', teleport, { projects: 7 })]);
    const themes = createThemeService({ root, settings: fileSettings() });
    expect(await themes.agentUndoTarget('chat-1')).toMatchObject({ kind: 'refused', later: { change: { kind: 'other' } } });
  });

  it('drops an entry of a kind this Damocles records whose fields it cannot read, and one whose actor or id it cannot carry', async () => {
    writeEntries([
      stored('empty-name', { kind: 'delete', theme: '' }, {}),
      stored('long-chat', { kind: 'reset' }, {}, { kind: 'agent', chatId: 'c'.repeat(129), title: '' }),
      stored('i'.repeat(129), { kind: 'reset' }, {}),
      stored('kept', { kind: 'reset' }, {}),
    ]);
    const themes = createThemeService({ root, settings: fileSettings() });
    expect((await themes.history()).map((entry) => entry.id)).toEqual(['kept']);
  });
});
