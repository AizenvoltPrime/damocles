import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsStore } from '../../../platform/settings-store';
import { foldAliases, NO_ALIASES, type RelocationAliases } from '../../project-relocation/aliases';
import { folderKey } from '../../workspace-folders/folder-key';
import { applyPinEdits, createProjectsStore } from '../characters';
import { createThemeService } from '../index';
import { createProjectLooks } from '../project-looks';
import { createWriteLane } from '../write-lane';
import { checkProjectLook, MAX_PROJECT_LOOKS, parseProjectLooks, type ProjectLook } from '../../../shared/themes/project-looks';
import type { ThemeFile } from '../../../shared/themes/schema';
import { MAX_PINNED_PROJECTS } from '../../../shared/themes/characters';

// Project looks and character pins in projects.json: how they follow a relocation, leave with Remove Project and Forget host,
// map through a pending relocation's aliases, and change as history entries.

const OLD = folderKey(path.resolve('/work/old-site'));
const NEW = folderKey(path.resolve('/work/new-site'));
const OTHER = folderKey(path.resolve('/work/notes'));
const REMOTE = 'ssh+prod|/srv/app';
const GONE_HOST = 'ssh+gone|/srv/app';
const THEME = '0f8fad5b-d9cb-469f-a165-70867728950e';
const TOUCHES: ProjectLook = { mode: 'touches', accent: '#3a86ff' };
const FULL: ProjectLook = { mode: 'full', themeId: THEME, look: 'dark' };

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-project-looks-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const file = (): string => path.join(root, 'projects.json');
const read = (): Record<string, unknown> => JSON.parse(fs.readFileSync(file(), 'utf8')) as Record<string, unknown>;
const write = (value: unknown): void => fs.writeFileSync(file(), JSON.stringify(value));

function looksStore(relocations: { aliases: RelocationAliases; pendingKeys: ReadonlySet<string> } = { aliases: NO_ALIASES, pendingKeys: new Set() }) {
  let changes = 0;
  const looks = createProjectLooks({
    projects: createProjectsStore(root, async (target, text) => fs.writeFileSync(target, text)),
    lane: createWriteLane(root),
    changed: () => void changes++,
    relocations: () => relocations,
  });
  return { looks, changes: () => changes };
}

function fakeSettings(): SettingsStore {
  const settingsFile = path.join(root, 'settings.json');
  return {
    get: () => undefined,
    inspect: () => ({}),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? settingsFile : undefined),
  } as unknown as SettingsStore;
}

describe('a project look as read', () => {
  it('keeps touches that set something and a whole theme, and drops anything else', () => {
    expect(checkProjectLook({ mode: 'touches', accent: '#3A86FF' })).toEqual({ mode: 'touches', accent: '#3a86ff' });
    expect(checkProjectLook({ mode: 'touches' })).toBeUndefined();
    expect(checkProjectLook({ mode: 'touches', accent: 'blue' })).toBeUndefined();
    expect(checkProjectLook({ mode: 'full', themeId: THEME, look: 'sideways' })).toBeUndefined();
    // a wallpaper must name an image the look's own assets describe
    const sha = 'a'.repeat(64);
    expect(checkProjectLook({ mode: 'touches', wallpaper: { span: { asset: sha, panels: ['chat'], fit: 'fill' } } })).toBeUndefined();
    const asset = { kind: 'image', mime: 'image/png', bytes: 30, width: 10, height: 10, license: {} };
    expect(checkProjectLook({ mode: 'touches', wallpaper: { span: { asset: sha, panels: ['chat'], fit: 'fill' } }, assets: { [sha]: asset, ['b'.repeat(64)]: asset } }))
      .toEqual({ mode: 'touches', wallpaper: { span: { asset: sha, panels: ['chat'], fit: 'fill' } }, assets: { [sha]: asset } });
    expect(parseProjectLooks({ version: 1, looks: { a: TOUCHES, b: { mode: 'nope' } } })).toEqual({ a: TOUCHES });
    expect(parseProjectLooks({ version: 2, looks: { a: TOUCHES } })).toEqual({});
  });
});

describe('project looks follow the project', () => {
  it("re-keys a moved project's look and pins to its new key, once however often the step runs", async () => {
    write({ version: 1, kept: 'a newer field', pins: { [OLD]: { byTheme: { [THEME]: 'Pip' } }, [OTHER]: { byTheme: { [THEME]: 'Bolt' } } }, looks: { [OLD]: TOUCHES } });
    const { looks, changes } = looksStore();
    await looks.relocateProject(OLD, NEW);
    const moved = read();
    expect(moved['looks']).toEqual({ [NEW]: TOUCHES });
    expect(moved['pins']).toEqual({ [OTHER]: { byTheme: { [THEME]: 'Bolt' } }, [NEW]: { byTheme: { [THEME]: 'Pip' } } });
    expect(moved['kept']).toBe('a newer field');
    expect(changes()).toBe(1);
    await looks.relocateProject(OLD, NEW);
    expect(read()).toEqual(moved);
    expect(changes()).toBe(1);
  });

  it('keeps what the new key already holds in a merge: its look, and its pin of a theme both name', async () => {
    write({ version: 1, pins: { [OLD]: { byTheme: { [THEME]: 'Pip', other: 'Mochi' } }, [NEW]: { byTheme: { [THEME]: 'Bolt' } } }, looks: { [OLD]: TOUCHES, [NEW]: FULL } });
    const { looks } = looksStore();
    await looks.relocateProject(OLD, NEW);
    expect(read()['looks']).toEqual({ [NEW]: FULL });
    expect(read()['pins']).toEqual({ [NEW]: { byTheme: { [THEME]: 'Bolt', other: 'Mochi' } } });
  });

  it('drops a removed project\'s look and pins, and every project of a forgotten host', async () => {
    write({ version: 1, pins: { [OLD]: { byTheme: { [THEME]: 'Pip' } }, [REMOTE]: { byTheme: { [THEME]: 'Pip' } } }, looks: { [OLD]: TOUCHES, [OTHER]: FULL, [REMOTE]: TOUCHES, [GONE_HOST]: FULL } });
    const { looks } = looksStore();
    await looks.forgetProject(OLD);
    expect(read()['looks']).toEqual({ [OTHER]: FULL, [REMOTE]: TOUCHES, [GONE_HOST]: FULL });
    expect(read()['pins']).toEqual({ [REMOTE]: { byTheme: { [THEME]: 'Pip' } } });
    await looks.forgetHost('ssh+prod');
    expect(read()['looks']).toEqual({ [OTHER]: FULL, [GONE_HOST]: FULL });
    expect(read()['pins']).toEqual({});
    // a host forgotten while the engine was halted: every authority outside those kept goes, this computer's never
    expect(await looks.keepHosts(new Set(['ssh+prod']))).toEqual(['ssh+gone']);
    expect(read()['looks']).toEqual({ [OTHER]: FULL });
    expect(await looks.keepHosts(new Set())).toEqual([]);
  });

  it('maps a look stored under the folder a pending relocation moves from to where the aliases lead, and only while it is pending', async () => {
    write({ version: 1, pins: {}, looks: { [OLD]: TOUCHES } });
    const aliases = foldAliases([{ seq: 1, startedAt: 1_000, folders: [{ from: path.resolve('/work/old-site'), to: path.resolve('/work/new-site') }] }]);
    const pending = looksStore({ aliases, pendingKeys: new Set([OLD, NEW]) });
    expect(await pending.looks.projectLookOf(NEW)).toEqual(TOUCHES);
    expect(await pending.looks.projectLookOf(OLD)).toEqual(TOUCHES);
    expect(await pending.looks.shownLooks()).toEqual({ [OLD]: TOUCHES, [NEW]: TOUCHES });
    // a look stored under the new key itself wins over the mapped one
    write({ version: 1, pins: {}, looks: { [OLD]: TOUCHES, [NEW]: FULL } });
    expect(await pending.looks.projectLookOf(NEW)).toEqual(FULL);
    // once the relocation is not pending the old key is a folder of its own again
    write({ version: 1, pins: {}, looks: { [OLD]: TOUCHES } });
    const done = looksStore({ aliases, pendingKeys: new Set() });
    expect(await done.looks.projectLookOf(NEW)).toBeUndefined();
    // setting the new key's look replaces the one the aliases mapped to it
    expect(pending.looks.withLook(read(), NEW, FULL)['looks']).toEqual({ [NEW]: FULL });
  });

  it('lists no more looks than the core protocol carries, however many pending relocations add a copy', async () => {
    const looks = Object.fromEntries(Array.from({ length: MAX_PROJECT_LOOKS - 1 }, (_, at) => [folderKey(path.resolve(`/work/site-${at}`)), TOUCHES]));
    write({ version: 1, pins: {}, looks: { ...looks, [OLD]: TOUCHES } });
    const aliases = foldAliases([{ seq: 1, startedAt: 1_000, folders: [{ from: path.resolve('/work/old-site'), to: path.resolve('/work/new-site') }] }]);
    const pending = looksStore({ aliases, pendingKeys: new Set([OLD, NEW]) });
    const shown = await pending.looks.shownLooks();
    expect(Object.keys(shown)).toHaveLength(MAX_PROJECT_LOOKS);
    expect(shown[OLD]).toEqual(TOUCHES);
    expect(shown[NEW]).toBeUndefined();
    // the moved project still shows its look
    expect(await pending.looks.projectLookOf(NEW)).toEqual(TOUCHES);
  });

  it("keeps the looks when the theme editor's save changes pins", () => {
    const theme: ThemeFile = { schemaVersion: 1, id: THEME, name: 'Night', looks: { dark: { colors: { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' } } } };
    expect(applyPinEdits({ version: 1, pins: {}, looks: { [OLD]: TOUCHES } }, theme, [{ projectKey: OLD, character: null }])['looks']).toEqual({ [OLD]: TOUCHES });
  });
});

describe('a project look as a theme change', () => {
  it('is one history entry naming the project, which Undo reverses; the same look again records nothing', async () => {
    const themes = createThemeService({ root, settings: fakeSettings(), relocations: () => ({ aliases: NO_ALIASES, pendingKeys: new Set() }) });
    const saved = await themes.setProjectLook(OLD, TOUCHES, { name: 'old-site' });
    expect(saved).toMatchObject({ change: { kind: 'projectLook', project: 'old-site', look: 'touches' } });
    expect(await themes.projectLooks.projectLookOf(OLD)).toEqual(TOUCHES);
    expect(await themes.setProjectLook(OLD, TOUCHES, { name: 'old-site' })).toBeUndefined();
    expect(await themes.history()).toHaveLength(1);
    await themes.undo();
    expect(await themes.projectLooks.projectLookOf(OLD)).toBeUndefined();
  });

  it("Reset Theme to Default turns the selected project's look off in its one entry, and Undo brings it back", async () => {
    const themes = createThemeService({ root, settings: fakeSettings(), relocations: () => ({ aliases: NO_ALIASES, pendingKeys: new Set() }) });
    await themes.setProjectLook(OLD, FULL, { name: 'old-site' });
    await themes.setProjectLook(OTHER, TOUCHES, { name: 'notes' });
    await themes.reset(undefined, OLD);
    expect(await themes.projectLooks.shownLooks()).toEqual({ [OTHER]: TOUCHES });
    const [entry] = await themes.history();
    expect(entry!.change).toEqual({ kind: 'reset' });
    await themes.undo();
    expect(await themes.projectLooks.shownLooks()).toEqual({ [OLD]: FULL, [OTHER]: TOUCHES });
  });

  it('an undo after a relocation brings the look back under the new key, and after Forget host leaves the forgotten project out', async () => {
    const themes = createThemeService({ root, settings: fakeSettings(), relocations: () => ({ aliases: NO_ALIASES, pendingKeys: new Set() }) });
    await themes.setProjectLook(OLD, TOUCHES, { name: 'old-site' });
    await themes.setProjectLook(REMOTE, TOUCHES, { name: 'app' });
    await themes.setProjectLook(OLD, FULL, { name: 'old-site' });
    await themes.projectLooks.relocateProject(OLD, NEW);
    await themes.projectLooks.forgetHost('ssh+prod');
    expect(await themes.projectLooks.shownLooks()).toEqual({ [NEW]: FULL });
    await themes.undo();
    expect(await themes.projectLooks.shownLooks()).toEqual({ [NEW]: TOUCHES });
    await themes.undo();
    expect(await themes.projectLooks.shownLooks()).toEqual({ [NEW]: TOUCHES });
    await themes.undo();
    expect(await themes.projectLooks.shownLooks()).toEqual({});
  });

  it('says whether a look would change anything, as the change judges it, writing nothing', async () => {
    const themes = createThemeService({ root, settings: fakeSettings(), relocations: () => ({ aliases: NO_ALIASES, pendingKeys: new Set() }) });
    expect(await themes.projectLookChanges(OLD, null)).toBe(false);
    expect(await themes.projectLookChanges(OLD, TOUCHES)).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
    await themes.setProjectLook(OLD, TOUCHES, { name: 'old-site' });
    expect(await themes.projectLookChanges(OLD, { accent: '#3A86FF', mode: 'touches' } as ProjectLook)).toBe(false);
    await expect(themes.projectLookChanges(OLD, { mode: 'touches', accent: 'red' })).rejects.toThrow(/not valid/);
  });
});

describe('a character pin as a theme change', () => {
  const SPRITE = 'e'.repeat(64);
  function pals(): ReturnType<typeof createThemeService> {
    const folder = path.join(root, 'themes', THEME);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'theme.json'), JSON.stringify({
      schemaVersion: 1, id: THEME, name: 'Pals', origin: { kind: 'created', installedAt: 1 },
      looks: { dark: { colors: { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' } } },
      characters: { name: 'Pals', characters: [{ name: 'Pip', states: { idle: { asset: SPRITE } } }] },
      assets: { [SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license: {} } },
    }));
    return createThemeService({ root, settings: fakeSettings(), relocations: () => ({ aliases: NO_ALIASES, pendingKeys: new Set() }) });
  }

  it("records the pinned theme's id beside its name, and says whether a pin would change anything, writing nothing", async () => {
    const themes = pals();
    expect(await themes.projectPinChanges(OLD, { themeId: THEME, character: null })).toBe(false);
    expect(await themes.projectPinChanges(OLD, { themeId: THEME, character: 'Pip' })).toBe(true);
    expect(fs.existsSync(file())).toBe(false);
    const saved = await themes.setProjectPin(OLD, { themeId: THEME, character: 'Pip' }, { name: 'old-site' });
    expect(saved?.change).toEqual({ kind: 'projectPin', project: 'old-site', theme: 'Pals', themeId: THEME, character: 'Pip' });
    expect(await themes.projectPinChanges(OLD, { themeId: THEME, character: 'Pip' })).toBe(false);
    expect(await themes.projectPinChanges(OLD, { themeId: THEME, character: 'Pip', everyTheme: true })).toBe(true);
    await expect(themes.projectPinChanges(OLD, { themeId: THEME, character: 'Nobody' })).rejects.toThrow('has no character');
  });

  it(`refuses a new project's pin once ${MAX_PINNED_PROJECTS} projects have pins, and still changes a pinned one's`, async () => {
    const themes = pals();
    const others = Array.from({ length: MAX_PINNED_PROJECTS - 1 }, (_, at) => [`/work/other-${at}`, { byTheme: { [THEME]: 'Pip' } }]);
    write({ version: 1, pins: Object.fromEntries([[OLD, { byTheme: { [THEME]: 'Pip' } }], ...others]) });
    const refusal = `Damocles keeps character pins for at most ${MAX_PINNED_PROJECTS} projects; remove the pin of another project first.`;
    await expect(themes.setProjectPin(NEW, { themeId: THEME, character: 'Pip' }, { name: 'new-site' })).rejects.toThrow(refusal);
    await expect(themes.projectPinChanges(NEW, { themeId: THEME, character: 'Pip' })).rejects.toThrow(refusal);
    expect(await themes.setProjectPin(NEW, { themeId: THEME, character: null }, { name: 'new-site' })).toBeUndefined();
    expect(await themes.history()).toEqual([]);
    expect(await themes.setProjectPin(OLD, { themeId: THEME, character: 'Pip', everyTheme: true }, { name: 'old-site' })).toMatchObject({ change: { everyTheme: true } });
    await themes.setProjectPin(OLD, { themeId: THEME, character: null, everyTheme: true }, { name: 'old-site' });
    await themes.setProjectPin(OLD, { themeId: THEME, character: null }, { name: 'old-site' });
    expect(await themes.setProjectPin(NEW, { themeId: THEME, character: 'Pip' }, { name: 'new-site' })).toMatchObject({ change: { project: 'new-site', character: 'Pip' } });
  });
});
