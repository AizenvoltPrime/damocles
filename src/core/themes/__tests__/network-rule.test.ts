import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import type { ThemeFile, LookColors } from '../../../shared/themes/schema';
import { USER_ACTOR } from '../../../shared/themes/changes';
import { englishText } from '../../../shared/localized-text';
import { fileLinkedOntoDevice, folderOnAdminShare } from '../../../__mocks__/admin-share';
import { createThemeService } from '../index';
import { createWallpaperCache } from '../cache';
import { writeFileAtomic } from '../store';
import { createStoreList } from '../store/list';
import { createWriteLane, LOCK_NAME } from '../write-lane';
import { sfntFont } from './font-fixtures';

// A link at the store's root is followed; one below it onto a share or device is refused, each reader taking its unreadable path.

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const DRAFT = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SHA = 'a'.repeat(64);
const COLORS: LookColors = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };
const userTheme = (name = 'Night'): ThemeFile => ({ schemaVersion: 1, id: ID, name, looks: { dark: { colors: COLORS } } });
const refusedRead = (file: string): string => `${file} links to a network share or WSL path, so Damocles does not read it.`;

let root: string;
const cleanups: string[] = [];

beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-theme-rule-')), 'themes');
  fs.mkdirSync(root);
});
afterEach(() => {
  for (const folder of cleanups.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

const themeFile = (): string => path.join(root, 'themes', ID, 'theme.json');
function writeTheme(): void {
  fs.mkdirSync(path.dirname(themeFile()), { recursive: true });
  fs.writeFileSync(themeFile(), JSON.stringify(userTheme()));
}

function service(): { themes: ReturnType<typeof createThemeService>; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn(async () => undefined);
  const settings = {
    get: () => undefined,
    inspect: () => ({}),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? path.join(path.dirname(root), 'settings.json') : undefined),
  } as unknown as SettingsStore;
  return { themes: createThemeService({ root, settings, notifications: { warn } }), warn };
}

const warnedTexts = (warn: ReturnType<typeof vi.fn>): string[] => warn.mock.calls.map((call: unknown[]) => englishText(call[0] as never));

describe.runIf(process.platform === 'win32')('the theme store under the network rule (win32)', () => {
  it('reads and writes through a store root linked onto a share, as the user moved it there', async (ctx) => {
    fs.rmdirSync(root);
    const real = folderOnAdminShare(ctx, root);
    cleanups.push(real);
    const { themes } = service();
    const copy = await themes.duplicate('damocles', 'Mine');
    await themes.setSchedule({ enabled: true, rules: [] }, USER_ACTOR, false);
    expect((await themes.list()).find((entry) => entry.id === copy)).toMatchObject({ status: 'ok', name: 'Mine' });
    expect((await themes.history()).map((entry) => entry.change.kind)).toEqual(['schedule', 'create']);
    expect(fs.existsSync(path.join(real, 'themes', copy, 'theme.json'))).toBe(true);
  });

  it('lists a theme.json that links off the root as broken, names the refusal, tells it once, and never writes it', async (ctx) => {
    fileLinkedOntoDevice(ctx, themeFile());
    const { themes, warn } = service();
    const [first] = (await themes.list()).filter((entry) => entry.id === ID);
    expect(first).toMatchObject({ status: 'broken', reason: { message: 'theme.json could not be read: {0}' } });
    expect(JSON.stringify(first)).toContain('links to a network share or WSL path, so Damocles does not read it.');
    await themes.list();
    expect(warnedTexts(warn)).toEqual([refusedRead(themeFile())]);
    await expect(themes.rename(ID, 'Renamed')).rejects.toMatchObject({ name: 'ConfigWriteRefused', file: themeFile() });
    await expect(themes.saveTheme(ID, userTheme('Saved'))).rejects.toMatchObject({ name: 'ConfigWriteRefused' });
    await expect(themes.remove(ID)).rejects.toMatchObject({ name: 'ConfigWriteRefused' });
    expect(await themes.history()).toEqual([]);
    expect(fs.lstatSync(themeFile()).isSymbolicLink()).toBe(true);
  });

  it('refuses a theme change whose history file links off the root, so no change is made without its entry', async (ctx) => {
    writeTheme();
    const real = folderOnAdminShare(ctx, path.join(root, 'history'));
    cleanups.push(real);
    const { themes } = service();
    // a refused history is never read as empty, which the next change would write over it
    await expect(themes.history()).rejects.toMatchObject({ name: 'ConfigReadRefused', file: path.join(root, 'history', 'index.json') });
    await expect(themes.rename(ID, 'Renamed')).rejects.toMatchObject({ name: 'ConfigWriteRefused', file: path.join(root, 'history', 'index.json') });
    expect((JSON.parse(fs.readFileSync(themeFile(), 'utf8')) as ThemeFile).name).toBe('Night');
  });

  it('reads an appearance.json that links off the root as missing, and refuses its write with no history entry', async (ctx) => {
    const file = path.join(root, 'appearance.json');
    fileLinkedOntoDevice(ctx, file);
    const { themes, warn } = service();
    expect(await themes.appearance()).toBeUndefined();
    expect((await themes.schedule()).schedule.enabled).toBe(false);
    await expect(themes.setSchedule({ enabled: true, rules: [] }, USER_ACTOR, false)).rejects.toMatchObject({ name: 'ConfigWriteRefused', file });
    expect(await themes.history()).toEqual([]);
    expect(warnedTexts(warn)).toEqual([refusedRead(file)]);
  });

  it('refuses a projects.json that links off the root for its read and its write, with no history entry', async (ctx) => {
    const file = path.join(root, 'projects.json');
    fileLinkedOntoDevice(ctx, file);
    const { themes } = service();
    await expect(themes.projectLooks.shownLooks()).rejects.toMatchObject({ name: 'ConfigReadRefused', file });
    await expect(themes.setProjectLook('local:/work/api', { mode: 'touches', accent: '#ff00aa' }, { name: 'api' })).rejects.toMatchObject({ name: 'ConfigWriteRefused', file });
    expect(await themes.history()).toEqual([]);
  });

  it('judges the user settings file from its own folder: one that links off it refuses a pick, with no history entry', async (ctx) => {
    const file = path.join(path.dirname(root), 'settings.json');
    fileLinkedOntoDevice(ctx, file);
    const { themes, warn } = service();
    await expect(themes.pick('damocles', 'dark')).rejects.toMatchObject({ name: 'ConfigReadRefused', file });
    expect(await themes.history()).toEqual([]);
    expect(warnedTexts(warn)).toEqual([refusedRead(file)]);
  });

  it('refuses a blob that links off the root, and the blob collection keeps it', async (ctx) => {
    const font = sfntFont();
    const blob = path.join(root, 'blobs', createHash('sha256').update(font).digest('hex'));
    fileLinkedOntoDevice(ctx, blob);
    const { themes } = service();
    await expect(themes.importFont(font)).rejects.toMatchObject({ name: 'ConfigWriteRefused', file: blob });
    expect(await themes.collectBlobs()).toBe(0);
    expect(fs.lstatSync(blob).isSymbolicLink()).toBe(true);
  });

  it('refuses a draft that links off the root, and a text the blob collection cannot read stops it', async (ctx) => {
    const file = path.join(root, 'drafts', `${DRAFT}.json`);
    fileLinkedOntoDevice(ctx, file);
    const { themes } = service();
    const draft = { id: DRAFT, owner: { authority: 'local', sessionId: 's', toolCallId: 't' }, createdAt: 1, baseThemeId: null, baseHash: null, theme: userTheme() };
    await expect(themes.drafts.put(draft, null)).rejects.toMatchObject({ name: 'ConfigWriteRefused', file });
    await expect(themes.collectBlobs()).rejects.toMatchObject({ name: 'ConfigReadRefused', file });
  });

  it('refuses every lane run while the store\'s lock links off the root', async (ctx) => {
    const lock = path.join(root, LOCK_NAME);
    fileLinkedOntoDevice(ctx, lock);
    await expect(createWriteLane(root).run(async () => 'ran')).rejects.toMatchObject({ name: 'ConfigWriteRefused', file: lock });
  });

  it('reads a wallpaper analysis that links off the root as absent, and refuses to write it', async (ctx) => {
    fileLinkedOntoDevice(ctx, path.join(root, 'cache', SHA, 'stats.json'));
    const cache = createWallpaperCache(root, writeFileAtomic);
    expect(await cache.stats(SHA)).toBeUndefined();
    expect(await cache.has(SHA)).toBe(false);
    const analysis = { thumb: new Uint8Array([1]), stats: { p10: 0.1, p90: 0.9 }, palette: {} } as unknown as Parameters<typeof cache.write>[1];
    await expect(cache.write(SHA, analysis)).rejects.toMatchObject({ name: 'ConfigWriteRefused' });
  });

  it('refuses the community store list that links off the root', async (ctx) => {
    const file = path.join(root, 'store', 'list.json');
    fileLinkedOntoDevice(ctx, file);
    const list = createStoreList({ root, lane: createWriteLane(root), enabled: () => true, log: () => undefined });
    await expect(list.kept()).rejects.toMatchObject({ name: 'ConfigReadRefused', file });
  });
});
