import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { FileWatcherFactory } from '../../../../platform/file-watcher';
import type { LookColors, ThemeFile } from '../../../../shared/themes/schema';
import { ThemeLibrary, WATCH_DEBOUNCE_MS } from '../theme-files';

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
