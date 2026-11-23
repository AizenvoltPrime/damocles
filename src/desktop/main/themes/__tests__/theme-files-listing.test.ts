// Main's listing of the theme folders: one folder's failure is that folder listed broken, a folder that is no theme's is
// left out, an unchanged file is not checked again, and a caller that waits for the entries gets current ones.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileWatcherFactory } from '../../../../platform/file-watcher';

const { checks } = vi.hoisted(() => ({ checks: { throwFor: undefined as string | undefined, folders: [] as string[] } }));
vi.mock('../../../../shared/themes/schema', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../shared/themes/schema')>();
  return {
    ...actual,
    validateTheme: (json: unknown, options?: { readonly folder?: string; readonly builtin?: boolean }) => {
      if (options?.folder !== undefined) checks.folders.push(options.folder);
      if (options?.folder !== undefined && options.folder === checks.throwFor) throw new RangeError('Maximum call stack size exceeded');
      return actual.validateTheme(json, options);
    },
  };
});

import { ThemeLibrary, themeEntry, WATCH_DEBOUNCE_MS } from '../theme-files';

const COLORS = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const theme = (id: string, name: string): Record<string, unknown> => ({ schemaVersion: 1, id, name, looks: { dark: { colors: COLORS } } });
const NIGHT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DAWN = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

let root: string;
let scheduled: (() => void) | undefined;
const libraries: ThemeLibrary[] = [];

const watchers: FileWatcherFactory = {
  watch: () => {
    const on = (cb: (fsPath: string) => void) => {
      scheduled = () => cb('');
      return { dispose: () => undefined };
    };
    return { ready: Promise.resolve(), onDidCreate: on, onDidChange: on, onDidDelete: on, dispose: () => undefined };
  },
  watchWorkspace: () => {
    throw new Error('the theme library watches no workspace');
  },
  onDidRenameFiles: () => ({ dispose: () => undefined }),
};

function write(id: string, value: unknown): string {
  const folder = path.join(root, 'themes', id);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, 'theme.json');
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

function library(log: (line: string) => void = () => undefined): ThemeLibrary {
  const created = new ThemeLibrary({ root, watchers, log });
  libraries.push(created);
  return created;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-listing-'));
  checks.throwFor = undefined;
  checks.folders.length = 0;
});
afterEach(() => {
  for (const created of libraries.splice(0)) created.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("main's theme listing", () => {
  it('lists a folder whose check throws as broken, and every other folder as it is', async () => {
    write(NIGHT, theme(NIGHT, 'Night'));
    write(DAWN, theme(DAWN, 'Dawn'));
    checks.throwFor = DAWN;
    const themes = library();
    await themes.load();
    expect(themes.entry(NIGHT)).toMatchObject({ status: 'ok', theme: { name: 'Night' } });
    expect(themes.entry(DAWN)).toEqual({ status: 'broken', id: DAWN, name: 'Dawn', error: 'Maximum call stack size exceeded' });
    expect(themeEntry(DAWN, theme(DAWN, 'Dawn'))).toMatchObject({ status: 'broken', name: 'Dawn' });
  });

  it('leaves out a folder whose name is no theme id, and says so once per run', async () => {
    write(NIGHT, theme(NIGHT, 'Night'));
    for (const stray of ['New folder', 'Backup', `${NIGHT} - Copy`, '.git', 'damocles-aurora', NIGHT.toUpperCase()]) write(stray, theme(NIGHT, 'Stray'));
    const lines: string[] = [];
    const themes = library((line) => lines.push(line));
    await themes.load();
    await themes.load();
    expect([...themes.entries().keys()]).toEqual(['damocles', NIGHT]);
    const told = lines.filter((line) => line.includes('is not named by a theme id'));
    // a file system that folds case holds the uppercase folder and the theme's as one
    expect(told.length).toBeGreaterThanOrEqual(5);
    expect(new Set(told).size).toBe(told.length);
    expect(told.some((line) => line.includes('"New folder"'))).toBe(true);
  });

  it('lists a theme.json that is no regular file as broken, without reading it', async () => {
    fs.mkdirSync(path.join(root, 'themes', NIGHT, 'theme.json'), { recursive: true });
    write(DAWN, theme(DAWN, 'Dawn'));
    const themes = library();
    await themes.load();
    expect(themes.entry(NIGHT)).toEqual({ status: 'broken', id: NIGHT, error: 'theme.json is not a file' });
    expect(themes.entry(DAWN)).toMatchObject({ status: 'ok' });
  });

  it('checks a file again only when it changed, and tells a change of one file alone', async () => {
    write(NIGHT, theme(NIGHT, 'Night'));
    const dawn = write(DAWN, theme(DAWN, 'Dawn'));
    const themes = library();
    let changes = 0;
    themes.onDidChange(() => changes++);
    await themes.load();
    expect(checks.folders.sort()).toEqual([NIGHT, DAWN].sort());
    expect(changes).toBe(1);
    checks.folders.length = 0;
    await themes.load();
    expect(checks.folders).toEqual([]);
    expect(changes).toBe(1);
    fs.writeFileSync(dawn, JSON.stringify(theme(DAWN, 'Dawn, later')));
    // a write within the clock's step of the first keeps its time on some file systems; its size differs here
    await themes.load();
    expect(checks.folders).toEqual([DAWN]);
    expect(themes.entry(DAWN)).toMatchObject({ status: 'ok', theme: { name: 'Dawn, later' } });
    expect(changes).toBe(2);
  });

  it('cuts a long name to 64 characters without splitting one', async () => {
    const name = `${'x'.repeat(63)}\u{1F600}${'y'.repeat(4000)}`;
    expect(themeEntry(NIGHT, { schemaVersion: 99, name })).toEqual({ status: 'needsNewer', id: NIGHT, name: `${'x'.repeat(63)}\u{1F600}`, version: 99 });
  });
});

describe('a read asked for while another runs', () => {
  it('settles only once a read that started after the call has the entries', async () => {
    const themes = library();
    // the first read is held at its listing of the folder
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    let first = true;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
      const listed = await readdir(...args);
      if (first) {
        first = false;
        await held;
      }
      return listed;
    }) as never);
    fs.mkdirSync(path.join(root, 'themes'), { recursive: true });
    const running = themes.load();
    await vi.waitFor(() => expect(first).toBe(false));
    write(NIGHT, theme(NIGHT, 'Night'));
    const asked = themes.coreChanged();
    const again = themes.load();
    release();
    await asked;
    expect(themes.entry(NIGHT)).toMatchObject({ status: 'ok' });
    await again;
    await running;
    // the two callers shared one read after the held one
    expect(vi.mocked(fs.promises.readdir).mock.calls.filter((call) => call[0] === path.join(root, 'themes'))).toHaveLength(2);
  });
});

describe('a change listener that throws', () => {
  it('is logged, and every other listener still hears the change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lines: string[] = [];
    const themes = library((line) => lines.push(line));
    const heard = vi.fn();
    themes.onDidChange(() => {
      throw new Error('a listener failed');
    });
    themes.onDidChange(heard);
    write(NIGHT, theme(NIGHT, 'Night'));
    // the watcher's read is awaited by nobody
    scheduled!();
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
    await vi.waitFor(() => expect(heard).toHaveBeenCalledOnce());
    expect(lines.some((line) => line.includes('a listener failed'))).toBe(true);
    expect(themes.entry(NIGHT)).toMatchObject({ status: 'ok' });
  });
});
