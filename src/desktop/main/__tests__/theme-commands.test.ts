import { describe, expect, it, vi } from 'vitest';
import type { Arrangement, ThemeFile } from '../../../shared/themes/schema';
import { ThemeCommands, type ThemeCommandsClient, type ThemeCommandsDeps } from '../theme-commands';
import type { LibraryEntry } from '../themes/theme-files';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COLORS = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const ORDER = ['projects', 'chats', 'files', 'scm', 'graph', 'repos', 'search'] as const;
const NOW_LAYOUT: Arrangement = { sidebarWidth: 300 };
const ENGINE_DOWN = "This computer's Damocles engine is not running.";

function fakeClient(): { [K in keyof ThemeCommandsClient]: ReturnType<typeof vi.fn> } {
  return {
    themesHold: vi.fn(async () => undefined),
    themesSetMode: vi.fn(async () => undefined),
    themesReset: vi.fn(async () => undefined),
    themesPick: vi.fn(async () => ({ recorded: true })),
    themesUndo: vi.fn(async () => ({})),
    themesRestore: vi.fn(async () => ({})),
    themesDuplicate: vi.fn(async () => ({ themeId: 'copy' })),
    themesRename: vi.fn(async () => undefined),
    themesDelete: vi.fn(async () => undefined),
    themesSetScheduleMode: vi.fn(async () => undefined),
    themesSetScheduleRules: vi.fn(async () => undefined),
    themesResumeSchedule: vi.fn(async () => undefined),
  };
}

interface Setup {
  engine?: boolean;
  shown?: ReturnType<ThemeCommandsDeps['shown']>;
  // what the screen shows once main wrote both preferred looks
  shownAfterReset?: ReturnType<ThemeCommandsDeps['shown']>;
  entries?: readonly ThemeFile[];
  selectedProject?: string;
  noticeAnswer?: number;
}

function setup(options: Setup = {}) {
  const client = fakeClient();
  const written: Array<[string, unknown]> = [];
  const notices: Array<{ severity: string; message: string; actions: readonly string[] }> = [];
  const lines: string[] = [];
  const applied: Array<{ arrangement: Arrangement; density: number | undefined }> = [];
  const projectLooks: string[] = [];
  const safeStart = vi.fn();
  const openEditor = vi.fn(async () => true);
  const revealThemeFile = vi.fn(async () => undefined);
  const entries = new Map((options.entries ?? []).map((theme): [string, LibraryEntry] => [theme.id, { status: 'ok', id: theme.id, builtin: false, theme }]));
  const before = options.shown ?? { kind: 'dark' as const, decidedBy: 'mode' as const, builtin: false };
  const commands = new ThemeCommands({
    client: () => (options.engine === false ? undefined : (client as unknown as ThemeCommandsClient)),
    settings: {
      get: () => undefined,
      update: async (key, value) => {
        written.push([key, value]);
      },
    },
    shown: () => (written.length >= 2 && options.shownAfterReset ? options.shownAfterReset : before),
    shownKind: () => before.kind,
    preferred: () => ID,
    now: () => 1234,
    entry: (themeId) => entries.get(themeId),
    selectedProject: () => options.selectedProject,
    safeStart,
    arrangement: () => NOW_LAYOUT,
    applyArrangement: (arrangement, density) => applied.push({ arrangement, density }),
    openEditor,
    revealThemeFile,
    openProjectLook: (key) => projectLooks.push(key),
    notice: async (severity, message, actions) => {
      notices.push({ severity, message, actions });
      return options.noticeAnswer;
    },
    t: (message, ...args) => args.reduce((text, arg, index) => text.replace(`{${index}}`, arg), message),
    log: (line) => lines.push(line),
  });
  return { commands, client, written, notices, lines, applied, projectLooks, safeStart, openEditor, revealThemeFile };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('Toggle Theme', () => {
  it('flips the fixed mode', async () => {
    const { commands, written, client, notices } = setup();
    await commands.toggle();
    expect(written).toEqual([['damocles.desktop.theme', 'light']]);
    expect(client.themesHold).not.toHaveBeenCalled();
    expect(notices).toEqual([]);
  });

  it('holds the preferred look of the other kind while the schedule decides, and the built-in one when that theme lacks the kind', async () => {
    const night: ThemeFile = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS }, light: { colors: COLORS } } };
    const scheduled = setup({ shown: { kind: 'dark', decidedBy: 'schedule', builtin: false }, entries: [night] });
    await scheduled.commands.toggle();
    expect(scheduled.client.themesHold).toHaveBeenCalledWith({ themeId: ID, kind: 'light', at: 1234 });
    expect(scheduled.written).toEqual([]);

    const darkOnly = setup({ shown: { kind: 'dark', decidedBy: 'override', builtin: false }, entries: [{ ...night, looks: { dark: { colors: COLORS } } }] });
    await darkOnly.commands.toggle();
    expect(darkOnly.client.themesHold).toHaveBeenCalledWith({ themeId: 'damocles', kind: 'light', at: 1234 });
  });

  it("writes nothing while the selected project's own theme decides the look, and offers that project's look", async () => {
    const { commands, written, client, notices, projectLooks } = setup({ shown: { kind: 'dark', decidedBy: 'project', builtin: false }, selectedProject: 'c:/work/app', noticeAnswer: 0 });
    await commands.toggle();
    await settle();
    expect(written).toEqual([]);
    expect(client.themesHold).not.toHaveBeenCalled();
    expect(client.themesSetMode).not.toHaveBeenCalled();
    expect(notices).toEqual([{ severity: 'info', message: "This project has its own look, which decides the theme, so the title bar's theme button changed nothing.", actions: ['Open Project Look'] }]);
    expect(projectLooks).toEqual(['c:/work/app']);
  });

  it('opens no dialog when the notice is dismissed', async () => {
    const { commands, projectLooks } = setup({ shown: { kind: 'light', decidedBy: 'project', builtin: false }, selectedProject: 'c:/work/app' });
    await commands.toggle();
    await settle();
    expect(projectLooks).toEqual([]);
  });
});

describe('Reset Theme to Default', () => {
  it('is the engine\'s while it runs, for the selected project too', async () => {
    const { commands, client, written, safeStart } = setup({ selectedProject: 'c:/work/app' });
    await commands.reset();
    expect(client.themesReset).toHaveBeenCalledWith('c:/work/app');
    expect(written).toEqual([]);
    expect(safeStart).not.toHaveBeenCalled();
  });

  it('writes the two preferred looks itself while the engine is down, which shows the built-in look when they decided it', async () => {
    const { commands, written, safeStart } = setup({ engine: false, shownAfterReset: { kind: 'dark', decidedBy: 'mode', builtin: true } });
    await commands.reset();
    expect(written).toEqual([['damocles.desktop.themes.dark', 'damocles'], ['damocles.desktop.themes.light', 'damocles']]);
    expect(safeStart).not.toHaveBeenCalled();
  });

  it('shows the default theme for this run while the engine is down and the schedule or a project look still decides', async () => {
    for (const decidedBy of ['schedule', 'override', 'project'] as const) {
      const { commands, written, safeStart } = setup({ engine: false, shown: { kind: 'dark', decidedBy, builtin: false } });
      await commands.reset();
      expect(written).toHaveLength(2);
      expect(safeStart, decidedBy).toHaveBeenCalledOnce();
    }
  });
});

describe('Settings › Appearance actions', () => {
  it('sets the mode and resets while the engine is down, writing the settings itself', async () => {
    const mode = setup({ engine: false });
    expect(await mode.commands.act({ action: 'mode', mode: 'light' })).toEqual({ ok: true });
    expect(mode.written).toEqual([['damocles.desktop.theme', 'light']]);

    const reset = setup({ engine: false, shownAfterReset: { kind: 'dark', decidedBy: 'mode', builtin: true } });
    expect(await reset.commands.act({ action: 'reset' })).toEqual({ ok: true });
    expect(reset.written).toEqual([['damocles.desktop.themes.dark', 'damocles'], ['damocles.desktop.themes.light', 'damocles']]);
  });

  it('opens the editor and shows a theme\'s file while the engine is down', async () => {
    const { commands, openEditor, revealThemeFile } = setup({ engine: false });
    expect(await commands.act({ action: 'edit', themeId: ID })).toEqual({ ok: true });
    expect(await commands.act({ action: 'showFile', themeId: ID })).toEqual({ ok: true });
    expect(openEditor).toHaveBeenCalledWith(ID);
    expect(revealThemeFile).toHaveBeenCalledWith(ID);
  });

  it('answers every action only the engine can carry out with the localized engine text while it is down', async () => {
    const { commands } = setup({ engine: false });
    const actions = [
      { action: 'pick', themeId: ID, kind: 'dark' }, { action: 'duplicate', themeId: ID, name: 'Copy' }, { action: 'rename', themeId: ID, name: 'New' }, { action: 'delete', themeId: ID },
      { action: 'undo' }, { action: 'restore', entryId: 'e1' }, { action: 'scheduleMode', choice: 'schedule' }, { action: 'schedule', schedule: { enabled: false, rules: [] } }, { action: 'resume' },
    ] as Parameters<ThemeCommands['act']>[0][];
    for (const action of actions) expect(await commands.act(action), action.action).toEqual({ ok: false, error: ENGINE_DOWN });
  });

  it("names the entry an offered Undo was for, and answers the engine's refusal when another change was made since", async () => {
    const { commands, client } = setup();
    client.themesUndo.mockResolvedValueOnce({ undone: { kind: 'reset' } });
    expect(await commands.act({ action: 'undo', entryId: 'e1' })).toEqual({ ok: true, undone: { kind: 'reset' } });
    expect(client.themesUndo).toHaveBeenLastCalledWith('e1');
    client.themesUndo.mockRejectedValueOnce(new Error('Another theme change was made after this one, so nothing was undone.'));
    expect(await commands.act({ action: 'undo', entryId: 'e1' })).toEqual({ ok: false, error: 'Another theme change was made after this one, so nothing was undone.' });
    expect(await commands.act({ action: 'undo' })).toEqual({ ok: true });
    expect(client.themesUndo).toHaveBeenLastCalledWith(undefined);
  });

  it('sets the mode through the engine while it runs', async () => {
    const { commands, client, written } = setup();
    expect(await commands.act({ action: 'mode', mode: 'system' })).toEqual({ ok: true });
    expect(client.themesSetMode).toHaveBeenCalledWith({ mode: 'system' });
    expect(written).toEqual([]);
  });

  it('answers a failure of the engine with its message and logs it', async () => {
    const { commands, client, lines } = setup();
    client.themesDelete.mockRejectedValueOnce(new Error('in use'));
    expect(await commands.act({ action: 'delete', themeId: ID })).toEqual({ ok: false, error: 'in use' });
    expect(lines).toEqual([`[themes] delete of ${ID} failed: in use`]);
  });
});

describe('a manual pick', () => {
  const withLayout = (layout: unknown): ThemeFile => ({ schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } }, style: { density: 1.1 }, layout } as ThemeFile);

  it("puts the theme's window arrangement in place after core recorded the one before it", async () => {
    const layout = { sidebarWidth: 400, sectionOrder: [...ORDER] };
    const { commands, client, applied } = setup({ entries: [withLayout(layout)] });
    expect(await commands.act({ action: 'pick', themeId: ID, kind: 'dark' })).toEqual({ ok: true });
    expect(client.themesPick).toHaveBeenCalledWith({ themeId: ID, kind: 'dark', at: 1234, arrangementBefore: NOW_LAYOUT });
    expect(applied).toEqual([{ arrangement: layout, density: 1.1 }]);
  });

  // The agent's path checks an arrangement with parseArrangement before main applies it; a manual pick holds to the same check.
  it('applies no arrangement parseArrangement refuses, and records none to undo', async () => {
    const { commands, client, applied, lines } = setup({ entries: [withLayout({ sidebarWidth: 400, sectionOrder: ['files', 'chats'] })] });
    expect(await commands.act({ action: 'pick', themeId: ID, kind: 'dark' })).toEqual({ ok: true });
    expect(client.themesPick).toHaveBeenCalledWith({ themeId: ID, kind: 'dark', at: 1234 });
    expect(applied).toEqual([]);
    expect(lines).toEqual([`[themes] the window arrangement of ${ID} is not valid, so the pick leaves the window as it is`]);
  });

  // with no history entry, Undo could not give the arrangement from before back
  it('leaves the window as it is when core recorded nothing, the look being the preferred one already', async () => {
    const { commands, client, applied } = setup({ entries: [withLayout({ sidebarWidth: 400, sectionOrder: [...ORDER] })] });
    client.themesPick.mockResolvedValueOnce({ recorded: false });
    expect(await commands.act({ action: 'pick', themeId: ID, kind: 'dark' })).toEqual({ ok: true });
    expect(applied).toEqual([]);
  });

  it('leaves the window as it is for a theme without an arrangement', async () => {
    const { commands, client, applied } = setup({ entries: [{ schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } } }] });
    await commands.act({ action: 'pick', themeId: ID, kind: 'dark' });
    expect(client.themesPick).toHaveBeenCalledWith({ themeId: ID, kind: 'dark', at: 1234 });
    expect(applied).toEqual([]);
  });
});

describe('the schedule screen\'s rules', () => {
  it('go to core as rules alone, so core keeps whether the schedule is on', async () => {
    const { commands, client } = setup();
    const rules = [{ days: ['mon' as const], minute: 420, theme: ID, look: 'auto' as const }];
    expect(await commands.act({ action: 'schedule', rules })).toEqual({ ok: true });
    expect(client.themesSetScheduleRules).toHaveBeenCalledWith({ rules });
  });
});

describe('Undo Theme Change', () => {
  it('says what it did, and puts back the window arrangement core answers', async () => {
    const { commands, client, notices, applied } = setup();
    client.themesUndo.mockResolvedValueOnce({ undone: { kind: 'pick' }, arrangement: { sidebarWidth: 280 } });
    await commands.undoCommand();
    expect(applied).toEqual([{ arrangement: { sidebarWidth: 280 }, density: undefined }]);
    await commands.undoCommand();
    expect(notices.map((notice) => notice.message)).toEqual(['The last theme change was undone.', 'There is no theme change to undo.']);
  });

  it('says the engine is not running, in the UI\'s words, while it is down', async () => {
    const { commands, notices } = setup({ engine: false });
    await commands.undoCommand();
    expect(notices).toEqual([{ severity: 'warning', message: ENGINE_DOWN, actions: [] }]);
  });
});

describe('a theme command that fails', () => {
  it('is told to the user as well as logged', async () => {
    const { commands, notices, lines } = setup();
    commands.failed('Next Wallpaper')(new Error('disk full'));
    expect(lines).toEqual(['[themes] Next Wallpaper failed: disk full']);
    expect(notices).toEqual([{ severity: 'warning', message: 'Damocles could not change the theme: disk full', actions: [] }]);
  });
});
