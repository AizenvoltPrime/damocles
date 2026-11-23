import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileWatcherFactory } from '../../../../platform/file-watcher';
import type { LookColors, ThemeFile } from '../../../../shared/themes/schema';
import { englishText } from '../../../../shared/localized-text';
import { fileLinkedOntoDevice, folderOnAdminShare } from '../../../../__mocks__/admin-share';
import { readPendingBefore } from '../pending-confirm';
import { readThemeBlob, readWallpaperStats } from '../theme-blobs';
import { readThemeFiles, ThemeLibrary } from '../theme-files';
import { ThemeState, THEME_STATE_FILE } from '../theme-state';

// Main judges every theme file from the store's root itself, whatever core decided, before it paints anything of it.

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const SHA = 'a'.repeat(64);
const COLORS: LookColors = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const THEME: ThemeFile = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } } };

let top: string;
let root: string;
const cleanups: string[] = [];

beforeEach(() => {
  top = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-main-theme-rule-'));
  root = path.join(top, 'themes');
  fs.mkdirSync(root);
});
afterEach(() => {
  for (const folder of cleanups.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(top, { recursive: true, force: true });
});

const themeFile = (): string => path.join(root, 'themes', ID, 'theme.json');
function writeTheme(): void {
  fs.mkdirSync(path.dirname(themeFile()), { recursive: true });
  fs.writeFileSync(themeFile(), JSON.stringify(THEME));
}

const watchers: FileWatcherFactory = {
  watch: () => ({ ready: Promise.resolve(), onDidCreate: () => ({ dispose: () => undefined }), onDidChange: () => ({ dispose: () => undefined }), onDidDelete: () => ({ dispose: () => undefined }), dispose: () => undefined }),
  watchWorkspace: () => {
    throw new Error('the theme library watches no workspace');
  },
  onDidRenameFiles: () => ({ dispose: () => undefined }),
};

describe.runIf(process.platform === 'win32')('main\'s theme reads under the network rule (win32)', () => {
  it('reads a theme through a store root linked onto a share, as the user moved it there', async (ctx) => {
    fs.rmdirSync(root);
    const real = folderOnAdminShare(ctx, root);
    cleanups.push(real);
    writeTheme();
    expect((await readThemeFiles(root)).get(ID)).toMatchObject({ status: 'ok', theme: { name: 'Night' } });
  });

  it('lists a theme.json that links off the root as broken on its own read, naming the refusal, and tells it once', async (ctx) => {
    fileLinkedOntoDevice(ctx, themeFile());
    const warn = vi.fn(async () => undefined);
    const first = await readThemeFiles(root, [], { warn });
    await readThemeFiles(root, [], { warn });
    expect(first.get(ID)).toEqual({ status: 'broken', id: ID, error: `${themeFile()} links to a network share or WSL path, so Damocles does not read it.` });
    expect(warn.mock.calls.map((call: unknown[]) => englishText(call[0] as never))).toEqual([`${themeFile()} links to a network share or WSL path, so Damocles does not read it.`]);
  });

  it('keeps the themes it last read while the themes folder links off the root', async (ctx) => {
    writeTheme();
    const lines: string[] = [];
    const library = new ThemeLibrary({ root, watchers, log: (line) => lines.push(line) });
    await library.load();
    expect(library.entry(ID)).toMatchObject({ status: 'ok' });
    fs.rmSync(path.join(root, 'themes'), { recursive: true });
    const real = folderOnAdminShare(ctx, path.join(root, 'themes'));
    cleanups.push(real);
    await library.coreChanged();
    library.dispose();
    expect(library.entry(ID)).toMatchObject({ status: 'ok' });
    expect(lines).toEqual([`[themes] the theme files could not be listed: ${path.join(root, 'themes')} links to a network share or WSL path, so Damocles does not read it.`]);
  });

  it('reads no countdown, wallpaper analysis or blob that links off the root', async (ctx) => {
    fileLinkedOntoDevice(ctx, path.join(root, 'appearance.json'));
    fileLinkedOntoDevice(ctx, path.join(root, 'cache', SHA, 'stats.json'));
    fileLinkedOntoDevice(ctx, path.join(root, 'blobs', SHA));
    const lines: string[] = [];
    expect(await readPendingBefore(root, (line) => lines.push(line))).toBeUndefined();
    expect(lines).toEqual([`[themes] ${path.join(root, 'appearance.json')} could not be read: ${path.join(root, 'appearance.json')} links to a network share or WSL path, so Damocles does not read it.`]);
    expect(await readWallpaperStats(root, SHA)).toBeUndefined();
    expect(await readThemeBlob(root, SHA, () => ({ kind: 'font', mime: 'font/woff2' }))).toBeUndefined();
  });

  it('starts the wallpaper cycle empty from a theme-state.json that links off its folder, and refuses its write', async (ctx) => {
    const file = path.join(top, THEME_STATE_FILE);
    fileLinkedOntoDevice(ctx, file);
    const lines: string[] = [];
    const state = await ThemeState.open(top, (line) => lines.push(line));
    expect(state.position(ID, 'dark')).toBeUndefined();
    expect(lines).toEqual([`[themes] ${THEME_STATE_FILE} could not be read, so every look starts at its first wallpaper set: ${file} links to a network share or WSL path, so Damocles does not read it.`]);
    await expect(state.set(ID, 'dark', { index: 1, at: 5 })).rejects.toMatchObject({ name: 'ConfigWriteRefused', file });
    expect(state.position(ID, 'dark')).toBeUndefined();
  });
});
