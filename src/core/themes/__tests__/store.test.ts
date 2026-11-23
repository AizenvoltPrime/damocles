import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import { LocalizedError } from '../../../shared/localized-text';
import { BUILTIN_THEME } from '../../../shared/themes/builtin';
import { validateTheme, type LookColors } from '../../../shared/themes/schema';
import { THEMES_DARK_SETTING, THEMES_LIGHT_SETTING } from '../../../desktop/local-services/desktop-configuration';
import { createAppearanceStore } from '../appearance-store';
import { createDraftStore } from '../drafts';
import { createThemeService, PREFERRED_LOOK_SETTINGS, type ThemeService } from '../index';
import { createThemePathRule } from '../network-rule';
import { createThemeStore, removeOrphanedTemps, writeFileAtomic } from '../store';
import { createWriteLane, LOCK_NAME } from '../write-lane';
import { collectionFont, sfntFont, woff2Font, woffFont } from './font-fixtures';
import { AGENT, draftOf, failReads, failWrites, fileSettings, named } from './service-fixtures';

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const COLORS: LookColors = { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' };

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-themes-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const themeFile = (id: string): string => path.join(root, 'themes', id, 'theme.json');

function writeTheme(id: string, json: unknown): void {
  fs.mkdirSync(path.dirname(themeFile(id)), { recursive: true });
  fs.writeFileSync(themeFile(id), typeof json === 'string' ? json : JSON.stringify(json));
}

const userTheme = (id: string, name = 'Night'): Record<string, unknown> => ({ schemaVersion: 1, id, name, looks: { dark: { colors: COLORS } }, future: { kept: true } });

function fakeSettings(file: string): SettingsStore & { readonly updates: Array<[string, unknown]> } {
  const updates: Array<[string, unknown]> = [];
  return {
    updates,
    get: () => undefined,
    inspect: () => ({}),
    update: async (key, value) => {
      updates.push([key, value]);
    },
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope) => (scope === 'user' ? file : undefined),
  } as SettingsStore & { readonly updates: Array<[string, unknown]> };
}

const service = (options: Partial<Parameters<typeof createThemeService>[0]> = {}): ThemeService =>
  createThemeService({ root, settings: fakeSettings(path.join(root, 'settings.json')), ...options });

describe('theme store', () => {
  it('lists the built-in theme first, then every theme folder: valid, broken and needing a newer Damocles', async () => {
    writeTheme(ID, userTheme(ID));
    writeTheme(OTHER, '{ not json');
    writeTheme('a1b2c3d4-0000-4000-8000-000000000000', { ...userTheme('a1b2c3d4-0000-4000-8000-000000000000'), schemaVersion: 2 });
    writeTheme('b1b2c3d4-0000-4000-8000-000000000000', userTheme(ID, 'Wrong folder'));
    const listed = await createThemeStore({ root }).list();
    expect(listed[0]).toMatchObject({ status: 'ok', id: 'damocles', builtin: true });
    const byId = new Map(listed.map((entry) => [entry.id, entry]));
    expect(byId.get(ID)).toMatchObject({ status: 'ok', builtin: false, name: 'Night' });
    expect(byId.get(OTHER)).toMatchObject({ status: 'broken', reason: { message: 'theme.json could not be read: {0}' } });
    expect(byId.get('a1b2c3d4-0000-4000-8000-000000000000')).toMatchObject({ status: 'needsNewer', version: 2 });
    expect(byId.get('b1b2c3d4-0000-4000-8000-000000000000')).toMatchObject({ status: 'broken', name: 'Wrong folder', reason: { message: 'theme.json is not a valid theme: {0}' } });
  });

  it('skips a folder whose name is no theme id, telling the log once per run, and leaves it as it is', async () => {
    writeTheme(ID, userTheme(ID));
    for (const stray of ['backup', 'New folder', `${ID} - Copy`, '.git', ID.toUpperCase(), 'damocles-paper']) writeTheme(stray, userTheme(ID, stray));
    fs.writeFileSync(path.join(root, 'themes', 'notes.txt'), 'not a folder');
    const lines: string[] = [];
    const store = createThemeStore({ root, log: (line) => lines.push(line) });
    const ids = (await store.list()).map((entry) => entry.id);
    expect(ids).toEqual(['damocles', ID]);
    await store.list();
    // a file system that folds letter case holds the upper-case folder and the theme's own as one
    const strays = fs.readdirSync(path.join(root, 'themes')).filter((name) => name !== ID && name !== 'notes.txt');
    expect(lines).toHaveLength(strays.length);
    expect(lines.some((line) => line.includes('"backup"'))).toBe(true);
    expect(fs.existsSync(themeFile('backup'))).toBe(true);
    await expect(store.unlocked.remove('backup')).rejects.toThrow('backup is not the id of a theme.');
    await expect(store.unlocked.rename('backup', 'Mine')).rejects.toThrow('backup is not the id of a theme.');
  });

  it('lists a theme with no usable name or with a version no number can hold without a name or a version it cannot carry', async () => {
    const blank = 'a1b2c3d4-0000-4000-8000-000000000000';
    const spaces = 'b1b2c3d4-0000-4000-8000-000000000000';
    const huge = 'c1b2c3d4-0000-4000-8000-000000000000';
    writeTheme(blank, { ...userTheme(blank, ''), schemaVersion: 2 });
    writeTheme(spaces, userTheme(spaces, '   '));
    writeTheme(huge, { ...userTheme(huge), schemaVersion: 1e20 });
    const byId = new Map((await createThemeStore({ root }).list()).map((entry) => [entry.id, entry]));
    expect(byId.get(blank)).toEqual({ status: 'needsNewer', id: blank, version: 2 });
    expect(byId.get(spaces)).toMatchObject({ status: 'broken', id: spaces });
    expect(byId.get(spaces)).not.toHaveProperty('name');
    expect(byId.get(huge)).toMatchObject({ status: 'broken', id: huge, name: 'Night' });
  });

  // RFC 8259 section 8.1: a parser may ignore a byte order mark, so the file is valid as written and nothing rewrites it
  it('reads a theme.json that starts with a byte order mark, keeps it byte for byte until a change, and undoes that change to the same bytes', async () => {
    const text = `\ufeff${JSON.stringify(userTheme(ID))}`;
    writeTheme(ID, text);
    const themes = service();
    expect((await themes.list()).find((entry) => entry.id === ID)).toMatchObject({ status: 'ok', name: 'Night' });
    expect((await themes.editBase(ID))?.theme.name).toBe('Night');
    expect(fs.readFileSync(themeFile(ID), 'utf8')).toBe(text);
    await themes.rename(ID, 'Dusk');
    expect(JSON.parse(fs.readFileSync(themeFile(ID), 'utf8'))).toMatchObject({ name: 'Dusk', future: { kept: true } });
    await themes.undo();
    expect(fs.readFileSync(themeFile(ID), 'utf8')).toBe(text);
  });

  it('lists a theme.json past its size cap as broken, with a reason of its own', async () => {
    writeTheme(ID, `{"schemaVersion":1,"pad":"${'x'.repeat(4 * 1024 * 1024)}"}`);
    const [, entry] = await createThemeStore({ root }).list();
    expect(entry).toMatchObject({ status: 'broken', id: ID, reason: { message: '{0} is larger than {1} MB.', args: ['theme.json', '4'] } });
  });

  it('runs its writes one at a time in the order they were asked for', async () => {
    const lane = createWriteLane(root);
    const order: string[] = [];
    const slow = lane.run(async () => {
      order.push('first start');
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push('first end');
    });
    const fast = lane.run(async () => {
      order.push('second');
    });
    const failing = lane.run(async () => {
      throw new Error('boom');
    });
    const after = lane.run(async () => {
      order.push('after a failure');
    });
    await Promise.all([slow, fast, failing.catch(() => undefined), after]);
    expect(order).toEqual(['first start', 'first end', 'second', 'after a failure']);
  });

  it('replaces a file whole and leaves no temporary file behind', async () => {
    const file = path.join(root, 'a.json');
    await writeFileAtomic(file, 'one');
    await writeFileAtomic(file, 'two');
    expect(fs.readFileSync(file, 'utf8')).toBe('two');
    expect(fs.readdirSync(root)).toEqual(['a.json']);
  });

  it('flushes the temporary file before it renames it over the target', async () => {
    const order: string[] = [];
    const open = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, 'open').mockImplementation(async (...args: Parameters<typeof fs.promises.open>) => {
      const handle = await open(...args);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        order.push(`sync ${path.basename(String(args[0])).endsWith('.tmp') ? 'temp' : 'other'}`);
        return sync();
      };
      return handle;
    });
    const rename = fs.promises.rename.bind(fs.promises);
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      order.push('rename');
      return rename(from, to);
    });
    await writeFileAtomic(path.join(root, 'a.json'), 'one');
    expect(order.slice(0, 2)).toEqual(['sync temp', 'rename']);
  });

  it('removes its temporary file when the write or the rename fails, and replaces nothing once the lane\'s lock is lost', async () => {
    const file = path.join(root, 'a.json');
    await writeFileAtomic(file, 'one');
    const failing = failWrites(named('a.json'));
    await expect(writeFileAtomic(file, 'two')).rejects.toThrow(/ENOSPC/);
    failing.restore();
    await expect(writeFileAtomic(file, 'three', { held: () => {
      throw new Error('lock lost');
    } })).rejects.toThrow('lock lost');
    await expect(writeFileAtomic(path.join(root, 'missing', 'b.json'), 'four')).rejects.toThrow(/ENOENT/);
    expect(fs.readFileSync(file, 'utf8')).toBe('one');
    expect(fs.readdirSync(root)).toEqual(['a.json']);
  });

  it.skipIf(process.platform === 'win32')('keeps the store\'s files to their user, and gives a file written with a mode that mode under the umask', async () => {
    const own = path.join(root, 'own.json');
    const exported = path.join(root, 'exported.damocles-theme');
    await writeFileAtomic(own, 'one');
    await writeFileAtomic(exported, 'two', { mode: 0o666 });
    expect(fs.statSync(own).mode & 0o777).toBe(0o600);
    expect(fs.statSync(exported).mode & 0o777).toBe(0o666 & ~process.umask());
  });

  it('removes the temporary files a crash left once they are old, two folders deep, and nothing else', async () => {
    const temp = (dir: string, uuid: string): string => {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `theme.json.${uuid}.tmp`);
      fs.writeFileSync(file, 'half');
      return file;
    };
    const old = [temp(root, ID), temp(path.join(root, 'themes', ID), OTHER), temp(path.join(root, 'cache', 'a'.repeat(64)), ID)];
    const fresh = temp(path.join(root, 'history'), ID);
    const kept = path.join(root, 'notes.tmp');
    fs.writeFileSync(kept, 'mine');
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    for (const file of [...old, kept]) fs.utimesSync(file, past, past);
    expect(await removeOrphanedTemps(root, Date.now() - 24 * 60 * 60 * 1000, createThemePathRule(root))).toBe(3);
    expect(old.some((file) => fs.existsSync(file))).toBe(false);
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(kept)).toBe(true);
  });
});

describe('theme service', () => {
  it('names the same settings as the desktop configuration', () => {
    expect(PREFERRED_LOOK_SETTINGS).toEqual({ dark: THEMES_DARK_SETTING, light: THEMES_LIGHT_SETTING });
  });

  it('never rewrites a broken file', async () => {
    writeTheme(OTHER, '{ not json');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(themeFile(OTHER), past, past);
    const themes = service();
    await expect(themes.saveTheme(OTHER, userTheme(OTHER))).rejects.toThrow(/cannot be changed/);
    await expect(themes.rename(OTHER, 'Fixed')).rejects.toThrow(/cannot be changed/);
    expect(fs.readFileSync(themeFile(OTHER), 'utf8')).toBe('{ not json');
    expect(fs.statSync(themeFile(OTHER)).mtimeMs).toBe(past.getTime());
    expect(await themes.history()).toEqual([]);
  });

  it('replaces a look\'s colors and keeps every key of the file this format does not know', async () => {
    writeTheme(ID, userTheme(ID));
    const themes = service();
    await themes.saveTheme(ID, { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } } } });
    const saved = JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')) as Record<string, unknown>;
    expect(saved['future']).toEqual({ kept: true });
    expect(saved['looks']).toEqual({ dark: { colors: { ...COLORS, accent: '#ff00aa' } } });
  });

  it('leaves a theme that changed since the editor opened it as it is, records nothing, and answers the hash of what a save wrote', async () => {
    writeTheme(ID, userTheme(ID));
    const themes = service();
    const edited = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } } } };
    const base = (await themes.editBase(ID))!.hash;
    // another writer renames the theme while the editor holds its draft
    await themes.rename(ID, 'Dusk');
    const renamed = fs.readFileSync(themeFile(ID), 'utf8');
    expect(await themes.saveTheme(ID, edited, undefined, undefined, base)).toEqual({ changed: true });
    expect(fs.readFileSync(themeFile(ID), 'utf8')).toBe(renamed);
    expect((await themes.history()).map((entry) => entry.change.kind)).toEqual(['rename']);

    const saved = await themes.saveTheme(ID, edited, undefined, undefined, (await themes.editBase(ID))!.hash);
    expect(saved).toEqual({ hash: createHash('sha256').update(fs.readFileSync(themeFile(ID), 'utf8')).digest('hex') });
    expect((JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')) as { name: string }).name).toBe('Night');
    // a save that names no base is made whatever the file holds
    expect(await themes.saveTheme(ID, { ...edited, name: 'Again' })).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it('keeps an unknown key whose name holds a slash, a tilde or is __proto__', async () => {
    const colors = JSON.stringify(COLORS);
    writeTheme(ID, `{"schemaVersion":1,"id":"${ID}","name":"Night","a/b":1,"x~y":2,"__proto__":{"kept":true},"looks":{"dark":{"colors":${colors},"p/q":3}}}`);
    await service().saveTheme(ID, { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } } } });
    const saved = JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')) as Record<string, unknown>;
    expect(saved['a/b']).toBe(1);
    expect(saved['x~y']).toBe(2);
    expect(Object.hasOwn(saved, '__proto__') && Object.getOwnPropertyDescriptor(saved, '__proto__')?.value).toEqual({ kept: true });
    expect((saved['looks'] as { dark: Record<string, unknown> }).dark['p/q']).toBe(3);
  });

  it('keeps no flash allowance a theme file was given, though it keeps every other key it does not know', async () => {
    const sha = 'c'.repeat(64);
    const asset = { kind: 'animated', mime: 'image/gif', bytes: 10, width: 8, height: 8, frames: 4, flash: { flagged: true, atMs: 100 }, license: {} };
    const look = { colors: COLORS, wallpapers: [{ panels: { chat: { asset: sha, fit: 'fill', dim: 0.5, blur: 2 } } }] };
    writeTheme(ID, { ...userTheme(ID), looks: { dark: look }, assets: { [sha]: { ...asset, flash: { flagged: true, atMs: 100, allowed: true } } } });
    await createThemeStore({ root }).unlocked.saveTheme(ID, { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: look }, assets: { [sha]: asset } });
    const saved = JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')) as { future?: unknown; assets: Record<string, { flash: unknown }> };
    expect(saved.future).toEqual({ kept: true });
    expect(saved.assets[sha]!.flash).toEqual({ flagged: true, atMs: 100 });
  });

  it('refuses to change the built-in theme, and its copy keeps only the 8 colors of each look', async () => {
    const themes = service({ store: createThemeStore({ root, newId: () => ID, now: () => 42 }) });
    await expect(themes.saveTheme('damocles', { schemaVersion: 1, id: 'damocles', name: 'Damocles', looks: { dark: { colors: COLORS } } })).rejects.toThrow(/built-in theme/);
    await expect(themes.remove('damocles')).rejects.toThrow(/built-in theme/);
    expect(await themes.duplicate('damocles', 'Mine')).toBe(ID);
    const copy = JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')) as unknown;
    expect(copy).toEqual({
      schemaVersion: 1,
      id: ID,
      name: 'Mine',
      looks: { dark: { colors: BUILTIN_THEME.looks.dark!.colors }, light: { colors: BUILTIN_THEME.looks.light!.colors } },
      origin: { kind: 'duplicate', from: 'damocles', installedAt: 42 },
    });
    expect(validateTheme(copy, { folder: ID }).ok).toBe(true);
  });

  it('waits for the lock another process holds on the store', async () => {
    fs.mkdirSync(root, { recursive: true });
    const release = await lockfile.lock(root, { realpath: false, lockfilePath: path.join(root, LOCK_NAME) });
    writeTheme(ID, userTheme(ID));
    const themes = service();
    let done = false;
    const renaming = themes.rename(ID, 'Renamed').then(() => (done = true));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(done).toBe(false);
    await release();
    await renaming;
    expect((JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')) as { name: string }).name).toBe('Renamed');
    expect(fs.existsSync(path.join(root, LOCK_NAME))).toBe(false);
  });

  it('names the theme when a write fails, leaves the previous file as it was and records nothing', async () => {
    writeTheme(ID, userTheme(ID));
    const before = fs.readFileSync(themeFile(ID), 'utf8');
    const themes = service({
      store: createThemeStore({
        root,
        writeText: async () => {
          throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
        },
      }),
    });
    await expect(themes.saveTheme(ID, { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } } } })).rejects.toThrow('Damocles could not save the theme Night: ENOSPC: no space left on device');
    expect(fs.readFileSync(themeFile(ID), 'utf8')).toBe(before);
    expect(await themes.history()).toEqual([]);
  });

  it('leaves no folder behind a first write that failed, so the same theme can be made again', async () => {
    const themes = service({ store: createThemeStore({ root, newId: () => ID }) });
    const failing = failWrites(named('theme.json'));
    await expect(themes.duplicate('damocles', 'Mine')).rejects.toThrow(/could not save the theme Mine/);
    failing.restore();
    expect(fs.existsSync(path.dirname(themeFile(ID)))).toBe(false);
    expect((await themes.list()).map((entry) => entry.id)).toEqual(['damocles']);
    expect(await themes.duplicate('damocles', 'Mine')).toBe(ID);
    const again = themes.applyDraft({ draft: draftOf(themes.drafts.newId(), ID, 'Again'), pick: [], actor: AGENT, onTheFly: false, currentArrangement: async () => undefined });
    await expect(again).rejects.toThrow('The theme Again was not saved: a theme folder of its id is already there.');
    expect((JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')) as { name: string }).name).toBe('Mine');
  });

  it('reports each change it made, and deletes a broken theme', async () => {
    writeTheme(OTHER, '{ not json');
    const themes = service();
    let changed = 0;
    themes.onDidChange(() => changed++);
    await themes.remove(OTHER);
    expect(fs.existsSync(path.dirname(themeFile(OTHER)))).toBe(false);
    expect(changed).toBe(1);
  });

  it('picks only an installed look of the asked kind', async () => {
    writeTheme(ID, userTheme(ID));
    const settings = fakeSettings(path.join(root, 'settings.json'));
    const themes = createThemeService({ root, settings });
    await themes.pick(ID, 'dark');
    await expect(themes.pick(ID, 'light')).rejects.toThrow('The theme Night has no light look.');
    await expect(themes.pick(OTHER, 'dark')).rejects.toThrow(/is missing, broken or needs a newer Damocles/);
    expect(settings.updates).toEqual([[THEMES_DARK_SETTING, ID]]);
  });

  it('reads a preferred look that names no theme as unset, so a pick replaces the built-in theme', async () => {
    writeTheme(ID, userTheme(ID));
    const file = path.join(root, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ [THEMES_DARK_SETTING]: '', [THEMES_LIGHT_SETTING]: 'My Theme!' }));
    const themes = createThemeService({ root, settings: fileSettings(file) });
    await themes.pick(ID, 'dark');
    expect((await themes.history())[0]!.change).toEqual({ kind: 'pick', look: 'dark', theme: 'Night', was: 'Damocles' });
    await themes.undo();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ [THEMES_LIGHT_SETTING]: 'My Theme!' });
  });

  it('resets both preferred looks in one settings write, keeping the other settings, and stops a pick or schedule in appearance.json', async () => {
    const file = path.join(root, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ 'damocles.model': 'x', [THEMES_DARK_SETTING]: ID, [THEMES_LIGHT_SETTING]: OTHER }));
    fs.writeFileSync(path.join(root, 'appearance.json'), JSON.stringify({ version: 1, override: { themeId: ID, kind: 'dark', at: 1 }, schedule: { enabled: true, rules: [] }, later: 3 }));
    const themes = createThemeService({ root, settings: fakeSettings(file) });
    await themes.reset();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ 'damocles.model': 'x', [THEMES_DARK_SETTING]: 'damocles', [THEMES_LIGHT_SETTING]: 'damocles' });
    expect(JSON.parse(fs.readFileSync(path.join(root, 'appearance.json'), 'utf8'))).toEqual({ version: 1, schedule: { enabled: false, rules: [] }, later: 3 });
  });

  it('saves a whole theme, keeping the keys a newer format added and the origin only core writes', async () => {
    writeTheme(ID, { ...userTheme(ID), looks: { dark: { colors: COLORS, later: 1 } }, origin: { kind: 'duplicate', from: 'damocles', installedAt: 7 } });
    const themes = service();
    await themes.saveTheme(ID, { schemaVersion: 1, id: ID, name: 'Renamed', looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' } }, light: { colors: COLORS } }, origin: { kind: 'store', installedAt: 1 } });
    expect(JSON.parse(fs.readFileSync(themeFile(ID), 'utf8'))).toEqual({
      schemaVersion: 1,
      id: ID,
      name: 'Renamed',
      looks: { dark: { colors: { ...COLORS, accent: '#ff00aa' }, later: 1 }, light: { colors: COLORS } },
      future: { kept: true },
      origin: { kind: 'duplicate', from: 'damocles', installedAt: 7 },
    });
    await expect(themes.saveTheme(ID, { schemaVersion: 1, id: OTHER, name: 'X', looks: { dark: { colors: COLORS } } })).rejects.toThrow(/was not saved/);
    await expect(themes.saveTheme('damocles', { schemaVersion: 1, id: 'damocles', name: 'X', looks: { dark: { colors: COLORS } } })).rejects.toThrow(/built-in theme/);
  });

  it('stores a font file once as a blob and names its family, embedding rights and license', async () => {
    const themes = service();
    const bytes = woff2Font();
    const font = await themes.importFont(bytes);
    expect(font).toMatchObject({ family: 'Fixture Sans', embedding: 'installable', asset: { kind: 'font', mime: 'font/woff2', bytes: bytes.length, family: 'Fixture Sans', license: { spdx: 'OFL-1.1', source: 'https://openfontlicense.org' } } });
    expect(font.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(new Uint8Array(fs.readFileSync(path.join(root, 'blobs', font.sha256)))).toEqual(bytes);
    expect((await themes.importFont(bytes)).sha256).toBe(font.sha256);
    expect(fs.readdirSync(path.join(root, 'blobs'))).toEqual([font.sha256]);
  });

  it('refuses a restricted font and a collection, storing nothing', async () => {
    const themes = service();
    await expect(themes.importFont(sfntFont({ fsType: 0x0002 }))).rejects.toThrow(/Fixture Sans forbids embedding/);
    await expect(themes.importFont(collectionFont())).rejects.toThrow(/font collection/);
    expect(fs.existsSync(path.join(root, 'blobs'))).toBe(false);
  });

  it('saves a theme bundling a font only while its blob is stored', async () => {
    writeTheme(ID, userTheme(ID));
    const themes = service();
    const font = await themes.importFont(woffFont());
    const theme = { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } }, style: { fonts: { ui: { asset: font.sha256, family: font.family } } }, assets: { [font.sha256]: font.asset } };
    await themes.saveTheme(ID, theme);
    expect(JSON.parse(fs.readFileSync(themeFile(ID), 'utf8')).style).toEqual(theme.style);
    fs.rmSync(path.join(root, 'blobs', font.sha256));
    await expect(themes.saveTheme(ID, { ...theme, name: 'Again' })).rejects.toThrow(/font file of dt-[0-9a-f]{8}-Fixture Sans is missing/);
  });

  it('lists the built-in examples after the built-in theme, read-only, and copies one with its style', async () => {
    const paper = { schemaVersion: 1, id: 'damocles-paper', name: 'Paper', looks: { light: { colors: COLORS } }, style: { radius: 0, density: 0.9, chatColumn: 40 } };
    const example = validateTheme(paper, { builtin: true, folder: 'damocles-paper' });
    if (!example.ok) throw new Error(example.errors.join('\n'));
    const store = createThemeStore({ root, examples: () => Promise.resolve([{ id: 'damocles-paper', theme: example.theme }]), newId: () => ID });
    const themes = service({ store });
    expect((await themes.list()).map((entry) => [entry.id, entry.status, entry.status === 'ok' && entry.builtin])).toEqual([['damocles', 'ok', true], ['damocles-paper', 'ok', true]]);
    await expect(themes.saveTheme('damocles-paper', paper)).rejects.toThrow(/built-in theme/);
    await expect(themes.rename('damocles-paper', 'Mine')).rejects.toThrow(/damocles-paper is a built-in theme/);
    expect(await themes.duplicate('damocles-paper', 'Paper copy')).toBe(ID);
    const copy = JSON.parse(fs.readFileSync(themeFile(ID), 'utf8'));
    expect(copy).toMatchObject({ id: ID, name: 'Paper copy', style: { radius: 0, density: 0.9, chatColumn: 40 }, origin: { kind: 'duplicate', from: 'damocles-paper' } });
    await themes.pick('damocles-paper', 'light');
  });

  it('sweeps every draft at core start and counts the drafts, not the other files beside them', async () => {
    const themes = service();
    for (const themeId of [ID, OTHER]) await themes.drafts.put(draftOf(themes.drafts.newId(), themeId));
    fs.writeFileSync(path.join(root, 'drafts', `${ID}.json.${OTHER}.tmp`), 'half');
    fs.writeFileSync(path.join(root, 'drafts', 'notes.txt'), 'mine');
    expect(await themes.sweepDrafts()).toBe(2);
    expect(fs.existsSync(path.join(root, 'drafts'))).toBe(false);
    expect(await createDraftStore(root, writeFileAtomic).sweep()).toBe(0);
  });
});

describe('blob collection', () => {
  const day = 24 * 60 * 60 * 1000;
  let now: number;
  let themes: ThemeService;

  beforeEach(() => {
    now = 1_000_000_000_000;
    themes = service({ now: () => now });
  });

  // a named font in a saved theme, and an old blob nothing names
  async function stored(): Promise<{ readonly named: string; readonly old: string }> {
    writeTheme(ID, userTheme(ID));
    const font = await themes.importFont(woffFont());
    const old = await themes.importFont(woff2Font());
    await themes.saveTheme(ID, { schemaVersion: 1, id: ID, name: 'Night', looks: { dark: { colors: COLORS } }, style: { fonts: { mono: { asset: font.sha256, family: 'Fixture Sans' } } }, assets: { [font.sha256]: font.asset } });
    now = Date.now() + day;
    return { named: font.sha256, old: old.sha256 };
  }

  it('removes only the blobs no theme file or history entry names, once they are a day old', async () => {
    const young = await themes.importFont(sfntFont());
    const { named: kept, old } = await stored();
    fs.utimesSync(path.join(root, 'blobs', young.sha256), new Date(now - 1000), new Date(now - 1000));
    expect(await themes.collectBlobs()).toBe(1);
    expect(fs.readdirSync(path.join(root, 'blobs')).sort()).toEqual([kept, young.sha256].sort());
    expect(fs.existsSync(path.join(root, 'blobs', old))).toBe(false);
  });

  it('removes nothing when a theme file cannot be read, since reading it as empty would remove the blobs it names', async () => {
    const { named: kept, old } = await stored();
    const denied = failReads((file) => file === themeFile(ID), 'EACCES');
    await expect(themes.collectBlobs()).rejects.toThrow(/EACCES/);
    denied.restore();
    expect(fs.readdirSync(path.join(root, 'blobs')).sort()).toEqual([kept, old].sort());
  });

  it('removes nothing, derived files included, when the themes folder or the blobs folder cannot be listed', async () => {
    const { named: kept, old } = await stored();
    const cache = path.join(root, 'cache', old);
    fs.mkdirSync(cache, { recursive: true });
    const readdir = fs.promises.readdir.bind(fs.promises) as (...args: unknown[]) => Promise<unknown>;
    for (const folder of ['themes', 'blobs']) {
      const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation((async (...args: unknown[]) => {
        if (args[0] === path.join(root, folder)) throw Object.assign(new Error('EMFILE: too many open files'), { code: 'EMFILE' });
        return readdir(...args);
      }) as never);
      await expect(themes.collectBlobs()).rejects.toThrow(/EMFILE/);
      spy.mockRestore();
      expect(fs.existsSync(cache)).toBe(true);
    }
    expect(fs.readdirSync(path.join(root, 'blobs')).sort()).toEqual([kept, old].sort());
  });

  it('removes the temporary files a crash left, once they are a day old', async () => {
    await stored();
    const temp = path.join(root, `appearance.json.${OTHER}.tmp`);
    fs.writeFileSync(temp, 'half');
    fs.utimesSync(temp, new Date(now - 1000), new Date(now - 1000));
    await themes.collectBlobs();
    expect(fs.existsSync(temp)).toBe(true);
    now += day;
    await themes.collectBlobs();
    expect(fs.existsSync(temp)).toBe(false);
  });
});

describe('appearance.json', () => {
  const file = (): string => path.join(root, 'appearance.json');
  const appearance = () => createAppearanceStore(root, writeFileAtomic);

  it('leaves a file of another version alone: Reset skips it, and every other writer refuses it in words a user can read', async () => {
    const text = JSON.stringify({ version: 2, override: { themeId: ID } });
    fs.writeFileSync(file(), text);
    await service().reset();
    const store = appearance();
    for (const write of [() => store.setSchedule({ enabled: true, rules: [] }), () => store.setOverride(undefined), () => store.setPendingConfirm({ entryId: 'a', startedAt: 1, owners: ['a'.repeat(32)] })]) {
      const refusal = await write().then(() => undefined, (err: unknown) => err);
      expect(refusal).toBeInstanceOf(LocalizedError);
      expect((refusal as LocalizedError).text).toEqual({ message: '{0} was written by a newer Damocles, so this one leaves it as it is. Update Damocles to change it.', args: ['appearance.json'] });
    }
    expect(fs.readFileSync(file(), 'utf8')).toBe(text);
    expect(fs.existsSync(`${file()}.bad`)).toBe(false);
  });

  it('sets a file that is not JSON aside as appearance.json.bad and starts again, from any writer and from Reset', async () => {
    for (const bad of ['{ "version": 1, "sched', '[1, 2]', '{}', 'null']) {
      fs.writeFileSync(file(), bad);
      await appearance().setSchedule({ enabled: true, rules: [] });
      expect(fs.readFileSync(`${file()}.bad`, 'utf8')).toBe(bad);
      expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, schedule: { enabled: true, rules: [] } });
    }
    fs.writeFileSync(file(), '{ truncated');
    const themes = createThemeService({ root, settings: fileSettings(path.join(root, 'settings.json')) });
    await themes.reset();
    expect(fs.readFileSync(`${file()}.bad`, 'utf8')).toBe('{ truncated');
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1 });
    // Undo puts the text back as it was, since the entry's snapshot holds it
    await themes.undo();
    expect(fs.readFileSync(file(), 'utf8')).toBe('{ truncated');
  });

  it('reads and changes a file that starts with a byte order mark', async () => {
    fs.writeFileSync(file(), `\uFEFF${JSON.stringify({ version: 1, schedule: { enabled: true, rules: [] }, later: 3 })}`);
    const store = appearance();
    expect((await store.schedule()).schedule.enabled).toBe(true);
    await store.setOverride({ themeId: ID, kind: 'dark', at: 5 });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8'))).toEqual({ version: 1, schedule: { enabled: true, rules: [] }, later: 3, override: { themeId: ID, kind: 'dark', at: 5 } });
    expect(fs.existsSync(`${file()}.bad`)).toBe(false);
  });
});
