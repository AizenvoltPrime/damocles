import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakePlatform } from '../../../../__mocks__/fake-platform';
import { parseContributedConfiguration } from '../../../../core/config/contributed-configuration';
import { THEMES_DARK_SETTING, THEMES_LIGHT_SETTING } from '../../../local-services/desktop-configuration';
import { createDesktopKeyValueState } from '../../../local-services/key-value-state';
import { DesktopSettingsStore } from '../../../local-services/settings-store';
import { DEFAULT_DECIDED_KEY, homeExisted, seedSystemDefault, type SeedDefaultDeps } from '../default-theme';

// The first-launch seed must never change the look of an install that already ran: it writes only where ~/.damocles and
// both state files were absent at the start, and once it has decided it never runs again.

interface Setup {
  homeExisted?: boolean;
  stateAbsent?: Partial<SeedDefaultDeps['stateAbsent']>;
  marker?: unknown;
  // the settings file as the locked write finds it; undefined while it does not exist
  file?: Record<string, unknown>;
  failWrite?: boolean;
  failMarker?: boolean;
}

function setup(options: Setup = {}) {
  const state = new Map<string, unknown>(options.marker === undefined ? [] : [[DEFAULT_DECIDED_KEY, options.marker]]);
  const disk: { file: Record<string, unknown> | undefined } = { file: options.file };
  const writes: Array<Readonly<Record<string, unknown>>> = [];
  const lines: string[] = [];
  const deps: SeedDefaultDeps = {
    homeExisted: options.homeExisted ?? false,
    stateAbsent: { global: true, workspace: true, ...options.stateAbsent },
    state: {
      get: <T>(key: string) => state.get(key) as T | undefined,
      update: async (key, value) => {
        if (options.failMarker) throw new Error('state is read-only');
        state.set(key, value);
      },
    },
    settings: {
      updateUserUnless: async (values, keep) => {
        if (options.failWrite) throw new Error('disk full');
        if (disk.file !== undefined && keep(disk.file)) return false;
        writes.push(values);
        disk.file = { ...disk.file, ...values };
        return true;
      },
    },
    log: (line) => lines.push(line),
  };
  const preferred = (): unknown[] => [disk.file?.[THEMES_DARK_SETTING], disk.file?.[THEMES_LIGHT_SETTING]];
  return { deps, state, writes, lines, preferred };
}

const BOTH = { [THEMES_DARK_SETTING]: 'damocles-system', [THEMES_LIGHT_SETTING]: 'damocles-system' };

describe('seedSystemDefault', () => {
  it('writes System colors to both preferred looks of a new install in one write, then the marker', async () => {
    const { deps, state, writes, preferred } = setup();
    expect(await seedSystemDefault(deps)).toBe('seeded');
    expect(writes).toEqual([BOTH]);
    expect(preferred()).toEqual(['damocles-system', 'damocles-system']);
    expect(state.get('damocles.desktop.themes.defaultDecided')).toBe(true);
    expect(DEFAULT_DECIDED_KEY).toBe('damocles.desktop.themes.defaultDecided');
  });

  it.each<[string, Setup]>([
    ['~/.damocles was there at the start', { homeExisted: true }],
    ['the global state file was there', { stateAbsent: { global: false } }],
    ['the workspace state file was there', { stateAbsent: { workspace: false } }],
  ])('writes no setting when %s, and never asks again', async (_name, options) => {
    const { deps, state, writes } = setup(options);
    expect(await seedSystemDefault(deps)).toBe('existing');
    expect(writes).toEqual([]);
    expect(state.get(DEFAULT_DECIDED_KEY)).toBe(true);
    // the files that made it an existing install are gone at the next launch, and it still is one
    expect(await seedSystemDefault({ ...deps, homeExisted: false, stateAbsent: { global: true, workspace: true } })).toBe('decided');
    expect(writes).toEqual([]);
  });

  // the file cannot exist when ~/.damocles did not, unless another writer made it since; that writer's choice stands
  it('writes nothing when the locked write finds a damocles.desktop.* key, and keeps any other file', async () => {
    const taken = setup({ file: { 'damocles.desktop.themes.dark': 'damocles', 'damocles.model': 'x' } });
    expect(await seedSystemDefault(taken.deps)).toBe('existing');
    expect(taken.writes).toEqual([]);
    expect(taken.preferred()).toEqual(['damocles', undefined]);
    expect(taken.state.get(DEFAULT_DECIDED_KEY)).toBe(true);

    const other = setup({ file: { 'damocles.model': 'x', 'damocles.desktopish': 1 } });
    expect(await seedSystemDefault(other.deps)).toBe('seeded');
    expect(other.preferred()).toEqual(['damocles-system', 'damocles-system']);
  });

  it('writes nothing once the marker is set', async () => {
    const { deps, writes } = setup({ marker: true });
    expect(await seedSystemDefault(deps)).toBe('decided');
    expect(writes).toEqual([]);
  });

  it('leaves a new user on Damocles when the settings write fails, with no marker, and says so in the log', async () => {
    const { deps, state, preferred, lines } = setup({ failWrite: true });
    expect(await seedSystemDefault(deps)).toBe('failed');
    expect(preferred()).toEqual([undefined, undefined]);
    expect(state.has(DEFAULT_DECIDED_KEY)).toBe(false);
    expect(lines.join('\n')).toContain('disk full');
  });

  it('never rejects: a marker that cannot be written is logged', async () => {
    const seeded = setup({ failMarker: true });
    expect(await seedSystemDefault(seeded.deps)).toBe('seeded');
    expect(seeded.preferred()).toEqual(['damocles-system', 'damocles-system']);
    expect(seeded.lines.join('\n')).toContain('state is read-only');

    const existing = setup({ failMarker: true, homeExisted: true });
    expect(await seedSystemDefault(existing.deps)).toBe('existing');
    expect(existing.writes).toEqual([]);
    expect(existing.lines.join('\n')).toContain('state is read-only');
  });
});

describe('the seed on disk', () => {
  let root: string;
  let home: string;
  let userData: string;
  const stores: DesktopSettingsStore[] = [];
  beforeEach(() => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-default-theme-')));
    home = path.join(root, 'h', '.damocles');
    userData = path.join(root, 'ud');
  });
  afterEach(async () => {
    for (const store of stores.splice(0)) {
      await store.flush();
      store.dispose();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  // the store main's platform builds, over the user file under `home`
  function settingsStore(): DesktopSettingsStore {
    const fake = createFakePlatform();
    const none = { dispose: () => undefined };
    const store = new DesktopSettingsStore({
      userFile: path.join(home, 'settings.json'),
      contributed: parseContributedConfiguration({ contributes: { configuration: { properties: {} } } }),
      fileWatchers: fake.fileWatchers,
      projects: fake.workspaceFolders,
      trust: fake.trust,
      defaultProject: { folder: () => undefined, onDidChange: () => none },
      chatFolders: { folders: () => [], onDidChange: () => none },
      notifications: undefined,
      log: () => undefined,
    });
    stores.push(store);
    return store;
  }

  async function launch(): Promise<{ outcome: string; store: DesktopSettingsStore }> {
    const existed = homeExisted(home);
    const state = createDesktopKeyValueState(userData, () => undefined);
    const store = settingsStore();
    const outcome = await seedSystemDefault({ homeExisted: existed, stateAbsent: state.absentAtStart, state: state.global, settings: store, log: () => undefined });
    await state.flush();
    return { outcome, store };
  }

  const marker = (): unknown => (JSON.parse(fs.readFileSync(path.join(userData, 'state', 'global.json'), 'utf8')) as Record<string, unknown>)[DEFAULT_DECIDED_KEY];

  it("writes both looks into the store's own user file on a computer with no ~/.damocles, and decides once", async () => {
    const { outcome, store } = await launch();
    expect(outcome).toBe('seeded');
    const file = store.scopeFile('user')!;
    expect(file).toBe(path.join(home, 'settings.json'));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(BOTH);
    expect([store.get(THEMES_DARK_SETTING), store.get(THEMES_LIGHT_SETTING)]).toEqual(['damocles-system', 'damocles-system']);
    expect(marker()).toBe(true);
    expect((await launch()).outcome).toBe('decided');
  });

  it('writes only the marker where a state file holds no marker, as an install from before the seed', async () => {
    fs.mkdirSync(path.join(userData, 'state'), { recursive: true });
    fs.writeFileSync(path.join(userData, 'state', 'global.json'), JSON.stringify({ 'damocles.language': 'el' }));
    expect((await launch()).outcome).toBe('existing');
    expect(fs.existsSync(home)).toBe(false);
    expect(marker()).toBe(true);
  });

  it('writes only the marker where ~/.damocles holds anything, as for a user of the VS Code extension', async () => {
    fs.mkdirSync(path.join(home, 'sessions'), { recursive: true });
    const { outcome, store } = await launch();
    expect(outcome).toBe('existing');
    expect(fs.existsSync(path.join(home, 'settings.json'))).toBe(false);
    expect(store.inspect(THEMES_DARK_SETTING).userValue).toBeUndefined();
    expect(marker()).toBe(true);
  });

  it("leaves a settings file the store's locked write finds holding a damocles.desktop.* key as it is, byte for byte", async () => {
    fs.mkdirSync(home, { recursive: true });
    const text = '{\r\n    "damocles.desktop.textSize": 14\r\n}';
    fs.writeFileSync(path.join(home, 'settings.json'), text);
    const store = settingsStore();
    const keep = (current: Readonly<Record<string, unknown>>): boolean => Object.keys(current).some((key) => key.startsWith('damocles.desktop.'));
    expect(await store.updateUserUnless(BOTH, keep)).toBe(false);
    expect(fs.readFileSync(path.join(home, 'settings.json'), 'utf8')).toBe(text);
  });

  it('counts anything at the path, a file included, as there, and only its absence as not', () => {
    expect(homeExisted(home)).toBe(false);
    fs.mkdirSync(path.dirname(home), { recursive: true });
    fs.writeFileSync(home, '');
    expect(homeExisted(home)).toBe(true);
  });
});
