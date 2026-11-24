import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileWatcherFactory } from '../../../../platform/file-watcher';
import type { LookColors, ThemeFile } from '../../../../shared/themes/schema';
import { systemTheme } from '../../../../shared/themes/system-theme';
import { shownChange, shownStoredName, shownThemeName, themeCopyName, ThemeLibrary, WATCH_DEBOUNCE_MS } from '../theme-files';
import greekBundle from '../../../../../l10n/bundle.l10n.el.json' with { type: 'json' };

// Main reads the theme files again WATCH_DEBOUNCE_MS after the last change its watcher saw, so a burst of events is one read,
// or at once when core says it wrote one, which also cancels that wait: core's write is the change the watcher reports.

const COLORS: LookColors = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const theme = (id: string, name: string): ThemeFile => ({ schemaVersion: 1, id, name, looks: { dark: { colors: COLORS } } });
const NIGHT = theme('0f8fad5b-d9cb-469f-a165-70867728950e', 'Night');
const DAWN = theme('7c9e6679-7425-40de-944b-e07fc1f90ae7', 'Dawn');

type Event = 'create' | 'change' | 'delete';

function fakeWatchers() {
  const listeners: Record<Event, Array<(fsPath: string) => void>> = { create: [], change: [], delete: [] };
  const watches: Array<{ readonly base: string; readonly glob: string }> = [];
  const disposed = vi.fn();
  const on = (event: Event) => (cb: (fsPath: string) => void) => {
    listeners[event].push(cb);
    return { dispose: () => undefined };
  };
  const factory: FileWatcherFactory = {
    watch: (base, glob) => {
      watches.push({ base, glob });
      return { ready: Promise.resolve(), onDidCreate: on('create'), onDidChange: on('change'), onDidDelete: on('delete'), dispose: disposed };
    },
    watchWorkspace: () => {
      throw new Error('the theme library watches no workspace');
    },
    onDidRenameFiles: () => ({ dispose: () => undefined }),
  };
  const fire = (event: Event, fsPath: string): void => {
    for (const cb of listeners[event]) cb(fsPath);
  };
  return { factory, watches, disposed, fire };
}

let root: string;
let readdir: ReturnType<typeof vi.spyOn>;
const libraries: ThemeLibrary[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-files-'));
  // ThemeLibrary lists the themes folder once per read
  readdir = vi.spyOn(fs.promises, 'readdir');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  for (const library of libraries.splice(0)) library.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const themesDir = (): string => path.join(root, 'themes');
function write(file: ThemeFile): string {
  const folder = path.join(themesDir(), file.id);
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, 'theme.json');
  fs.writeFileSync(target, JSON.stringify(file));
  return target;
}
const reads = (): number => readdir.mock.calls.filter((call: readonly unknown[]) => call[0] === themesDir()).length;

async function library(): Promise<{ library: ThemeLibrary; watchers: ReturnType<typeof fakeWatchers>; changes: () => number }> {
  const watchers = fakeWatchers();
  const created = new ThemeLibrary({ root, watchers: watchers.factory, log: () => undefined });
  libraries.push(created);
  await created.load();
  let changes = 0;
  created.onDidChange(() => {
    changes++;
  });
  readdir.mockClear();
  return { library: created, watchers, changes: () => changes };
}

/** Settles with the library's next change, once a read it started found the files changed. */
const nextChange = (themes: ThemeLibrary): Promise<void> => new Promise((resolve) => {
  const listening = themes.onDidChange(() => {
    listening.dispose();
    resolve();
  });
});

describe('the theme library\'s read of a file', () => {
  // core reads a theme.json past a byte order mark, so main must list the same file the same way
  it('reads a theme.json that starts with a byte order mark', async () => {
    const folder = path.join(themesDir(), NIGHT.id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'theme.json'), `\ufeff${JSON.stringify(NIGHT)}`);
    const { library: themes } = await library();
    expect(themes.entry(NIGHT.id)).toMatchObject({ status: 'ok', theme: { name: 'Night' } });
  });
});

describe('the theme library\'s System colors entry', () => {
  function fakeSystem(accent: string) {
    const listeners = new Set<() => void>();
    let current = systemTheme({ accent });
    return {
      theme: () => current,
      looks: () => current.looks,
      onDidChange: (listener: () => void) => {
        listeners.add(listener);
        return { dispose: () => void listeners.delete(listener) };
      },
      set: (next: string): void => {
        current = systemTheme({ accent: next });
        for (const listener of [...listeners]) listener();
      },
      listeners,
    };
  }

  async function systemLibrary(accent = '#0078d4') {
    const system = fakeSystem(accent);
    const watchers = fakeWatchers();
    const themes = new ThemeLibrary({ root, watchers: watchers.factory, log: () => undefined, system });
    libraries.push(themes);
    return { themes, system, watchers };
  }

  it('is a built-in entry before the first listing, and without a source the Damocles seeds', async () => {
    const { themes, system } = await systemLibrary();
    expect(themes.entry('damocles-system')).toEqual({ status: 'ok', id: 'damocles-system', builtin: true, theme: system.theme() });
    const bare = new ThemeLibrary({ root, watchers: fakeWatchers().factory, log: () => undefined });
    libraries.push(bare);
    await bare.load();
    expect(bare.entry('damocles-system')).toEqual({ status: 'ok', id: 'damocles-system', builtin: true, theme: systemTheme({}) });
  });

  // core checks the same looks with the same builder, so main never paints System colors that core serves differently
  it('is the Damocles seeds, with a log line, for looks that are no valid theme', () => {
    const looks = systemTheme({}).looks;
    const lines: string[] = [];
    const themes = new ThemeLibrary({
      root,
      watchers: fakeWatchers().factory,
      log: (line) => lines.push(line),
      system: { looks: () => ({ ...looks, dark: { ...looks.dark, tokens: { '--d-muted': 'red' } } }), onDidChange: () => ({ dispose: () => undefined }) },
    });
    libraries.push(themes);
    expect(themes.entry('damocles-system')).toEqual({ status: 'ok', id: 'damocles-system', builtin: true, theme: systemTheme({}) });
    expect(lines.join(' ')).toContain('System colors');
  });

  it('lists after Damocles and before the user\'s themes, and names itself through t()', async () => {
    write(NIGHT);
    const { themes } = await systemLibrary();
    await themes.load();
    const ids = [...themes.entries().keys()];
    expect(ids.slice(0, 2)).toEqual(['damocles', 'damocles-system']);
    expect(ids.indexOf(NIGHT.id)).toBeGreaterThan(1);
  });

  // a copy's source, a character set's owner and Duplicate's "copy" name all read it, so each shows in the UI's language
  it('shows a built-in\'s name in the UI\'s language and any other theme\'s as its file says it', () => {
    const greek = { t: (message: string): string => ({ 'System colors': 'Χρώματα συστήματος', Aurora: 'Σέλας' })[message] ?? message };
    expect(shownThemeName({ id: 'damocles-system', builtin: true, theme: { name: 'System colors' } }, greek)).toBe('Χρώματα συστήματος');
    expect(shownThemeName({ id: 'damocles-aurora', builtin: true, theme: { name: 'Aurora' } }, greek)).toBe('Σέλας');
    // Damocles is a name, the same in every language
    expect(shownThemeName({ id: 'damocles', builtin: true, theme: { name: 'Damocles' } }, greek)).toBe('Damocles');
    // a user's theme keeps its own name even when it matches a built-in's
    expect(shownThemeName({ id: NIGHT.id, builtin: false, theme: { name: 'System colors' } }, greek)).toBe('System colors');
  });

  it('words a history change\'s built-ins by their ids in the UI\'s language, and every other name as it was stored', () => {
    const greek = { t: (message: string): string => (greekBundle as Record<string, string>)[message] ?? message };
    expect(shownChange({ kind: 'pick', look: 'dark', theme: 'System colors', themeId: 'damocles-system', was: 'Aurora', wasId: 'damocles-aurora' }, greek))
      .toEqual({ kind: 'pick', look: 'dark', theme: 'Χρώματα συστήματος', themeId: 'damocles-system', was: 'Σέλας', wasId: 'damocles-aurora' });
    expect(shownChange({ kind: 'restore', before: { kind: 'hold', theme: 'Aurora', themeId: 'damocles-aurora', look: 'light' } }, greek))
      .toEqual({ kind: 'restore', before: { kind: 'hold', theme: 'Σέλας', themeId: 'damocles-aurora', look: 'light' } });
    // an entry written before ids were stored, and a user's theme named like a built-in
    const older = { kind: 'pick', look: 'dark', theme: 'System colors', was: 'Aurora' } as const;
    expect(shownChange(older, greek)).toEqual(older);
    // a pick over a theme that was no longer installed names none, and gains none
    expect(shownChange({ kind: 'pick', look: 'dark', theme: 'Aurora', themeId: 'damocles-aurora', wasId: NIGHT.id }, greek))
      .toEqual({ kind: 'pick', look: 'dark', theme: 'Σέλας', themeId: 'damocles-aurora', wasId: NIGHT.id });
    const mine = { kind: 'hold', theme: 'System colors', themeId: NIGHT.id, look: 'dark' } as const;
    expect(shownChange(mine, greek)).toEqual(mine);
    expect(shownChange({ kind: 'projectPin', project: 'site', theme: 'Aurora', themeId: 'damocles-aurora', character: 'Pip' }, greek))
      .toEqual({ kind: 'projectPin', project: 'site', theme: 'Σέλας', themeId: 'damocles-aurora', character: 'Pip' });
    expect(shownStoredName('damocles-system', 'System colors', greek)).toBe('Χρώματα συστήματος');
    expect(shownStoredName(undefined, 'System colors', greek)).toBe('System colors');
  });

  it('names a copy as Duplicate and the agent\'s unnamed copy both do: a built-in by its id in the UI\'s language, cut to fit a theme name', () => {
    const translator = (bundle: Record<string, string>) => ({
      t: (message: string, ...args: string[]): string => (bundle[message] ?? message).replace(/\{(\d+)\}/g, (_, at: string) => args[Number(at)] ?? ''),
    });
    const greek = translator(greekBundle as Record<string, string>);
    expect(themeCopyName('damocles-system', 'System colors', greek)).toBe('Χρώματα συστήματος αντίγραφο');
    expect(themeCopyName('damocles-aurora', 'Aurora', greek)).toBe('Σέλας αντίγραφο');
    expect(themeCopyName(NIGHT.id, 'Aurora', greek)).toBe('Aurora αντίγραφο');
    for (const localization of [translator({}), greek]) {
      const copy = themeCopyName(NIGHT.id, 'N'.repeat(64), localization);
      const suffix = localization.t('{0} copy', '');
      expect([...copy]).toHaveLength(64);
      expect(copy).toBe(`${'N'.repeat(64 - [...suffix].length)}${suffix}`);
    }
  });

  // `current` is rebuilt by every listing, which reads no System colors file
  it('survives a re-listing of the theme files, with the colors of that moment', async () => {
    const { themes, system, watchers } = await systemLibrary();
    await themes.load();
    system.set('#e81123');
    watchers.fire('create', write(NIGHT));
    await themes.coreChanged();
    expect(themes.entry(NIGHT.id)).toMatchObject({ status: 'ok' });
    expect(themes.entry('damocles-system')).toEqual({ status: 'ok', id: 'damocles-system', builtin: true, theme: system.theme() });
    expect(themes.entry('damocles-system')).toMatchObject({ theme: { looks: { dark: { colors: { accent: '#e81123' } } } } });
    expect(themes.entries().get('damocles-system')).toEqual(themes.entry('damocles-system'));
  });

  it('fires its listeners at once on a System change, reading no file', async () => {
    const { themes, system } = await systemLibrary();
    await themes.load();
    readdir.mockClear();
    const seen: unknown[] = [];
    themes.onDidChange(() => seen.push(themes.entry('damocles-system')));
    system.set('#e81123');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'ok', builtin: true, theme: { looks: { dark: { colors: { accent: '#e81123' } }, light: { colors: { accent: '#e81123' } } } } });
    expect(reads()).toBe(0);
  });

  // a user folder may not take a reserved id, whatever it holds
  it('never lists a user folder named damocles-system', async () => {
    write({ ...NIGHT, id: 'damocles-system', name: 'Shadow' });
    const { themes, system } = await systemLibrary();
    await themes.load();
    expect(themes.entry('damocles-system')).toEqual({ status: 'ok', id: 'damocles-system', builtin: true, theme: system.theme() });
    expect(themes.entries().get('damocles-system')).toEqual(themes.entry('damocles-system'));
  });

  it('lets go of the source once disposed', async () => {
    const { themes, system } = await systemLibrary();
    await themes.load();
    expect(system.listeners.size).toBe(1);
    themes.dispose();
    expect(system.listeners.size).toBe(0);
  });
});

describe('the theme library\'s watcher', () => {
  it('watches every theme.json under the themes folder, based at the store\'s root', async () => {
    const { watchers } = await library();
    expect(watchers.watches).toEqual([{ base: root, glob: 'themes/*/theme.json' }]);
  });

  // advanceTimersByTimeAsync also runs the microtasks a read starts with, so a read the timer began has listed the folder
  it('reads once, WATCH_DEBOUNCE_MS after the last of a burst of events', async () => {
    const { library: themes, watchers, changes } = await library();
    expect(WATCH_DEBOUNCE_MS).toBe(100);
    const night = write(NIGHT);
    watchers.fire('create', night);
    await vi.advanceTimersByTimeAsync(60);
    watchers.fire('change', night);
    const dawn = write(DAWN);
    await vi.advanceTimersByTimeAsync(60);
    watchers.fire('create', dawn);
    watchers.fire('change', dawn);
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 1);
    expect(reads()).toBe(0);
    expect(themes.entry(NIGHT.id)).toBeUndefined();

    const read = nextChange(themes);
    await vi.advanceTimersByTimeAsync(1);
    await read;
    expect(reads()).toBe(1);
    expect(themes.entry(NIGHT.id)).toMatchObject({ status: 'ok', theme: { name: 'Night' } });
    expect(themes.entry(DAWN.id)).toMatchObject({ status: 'ok', theme: { name: 'Dawn' } });
    expect(changes()).toBe(1);

    fs.rmSync(path.dirname(dawn), { recursive: true });
    watchers.fire('delete', dawn);
    const removed = nextChange(themes);
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
    await removed;
    expect(reads()).toBe(2);
    expect(themes.entry(DAWN.id)).toBeUndefined();
    expect(changes()).toBe(2);
  });

  it('reads at once on core\'s themes.changed, which cancels the watcher\'s pending read of the same write', async () => {
    const { library: themes, watchers, changes } = await library();
    watchers.fire('create', write(NIGHT));
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS / 2);
    expect(reads()).toBe(0);

    await themes.coreChanged();
    expect(reads()).toBe(1);
    expect(themes.entry(NIGHT.id)).toMatchObject({ status: 'ok' });
    expect(changes()).toBe(1);

    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 5);
    expect(reads()).toBe(1);
    expect(changes()).toBe(1);
  });

  it('reads nothing once disposed, and lets go of its watcher', async () => {
    const { library: themes, watchers } = await library();
    watchers.fire('change', write(NIGHT));
    themes.dispose();
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 5);
    expect(reads()).toBe(0);
    expect(watchers.disposed).toHaveBeenCalled();
  });
});
