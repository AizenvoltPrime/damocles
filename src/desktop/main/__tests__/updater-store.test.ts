// The community store check that rides on the app's update check, end to end from main's UpdateService to core's store client,
// asserted on the store's fetch log: it fetches only with "Check for updates automatically" on, the store setting on and a store
// theme installed, and then applies a removed entry without Browse ever opening.
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { trust } = vi.hoisted(() => ({ trust: { pem: undefined as string | undefined } }));
// the list trusts the test key as the e2e hooks' key would be trusted
vi.mock('../../../core/themes/store-keys', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/themes/store-keys')>();
  return { ...actual, trustedStoreKeys: (pem?: string) => actual.trustedStoreKeys(pem ?? trust.pem) };
});

import type { SettingsStore } from '../../../platform/settings-store';
import { BUILTIN_THEME_ID } from '../../../shared/themes/builtin';
import { createThemeService, PREFERRED_LOOK_SETTINGS, type ThemeService } from '../../../core/themes';
import { createStoreClient } from '../../../core/themes/store/install';
import { createStoreList, type StoreFetch, type StoreFetcher } from '../../../core/themes/store/list';
import { entry, payload, SEEDS, signed, testKey } from '../../../core/themes/store/__tests__/store-fixtures';
import { UpdateService, type UpdaterDeps } from '../updater';

const NOW = Date.UTC(2026, 10, 19, 12);
const key = testKey();
const THEME_ID = '22222222-3333-4444-8555-666666666666';

let root: string;
let themes: ThemeService;
let fetchLog: StoreFetch[];
let automatic: boolean;
let storeOn: boolean;
let services: UpdateService[];
let checks: Array<Promise<{ readonly fetched: boolean }>>;

function fakeSettings(file: string): SettingsStore {
  return {
    get: () => undefined,
    inspect: () => ({}),
    update: async () => undefined,
    onDidChange: () => ({ dispose: () => undefined }),
    scopeFile: (scope: string) => (scope === 'user' ? file : undefined),
  } as unknown as SettingsStore;
}

const settingsFile = (): string => path.join(root, 'settings.json');

// A store theme as an earlier install left it, and the preferred dark look naming it.
function installStoreTheme(): void {
  const folder = path.join(root, 'themes', THEME_ID);
  fs.mkdirSync(folder, { recursive: true });
  const theme = {
    schemaVersion: 1, id: THEME_ID, name: 'Aurora', looks: { dark: { colors: SEEDS } },
    origin: { kind: 'store', store: { entryId: 'aurora', version: '1.0.0', sha256: 'a'.repeat(64) }, installedHash: 'f'.repeat(64), installedAt: 1 },
  };
  fs.writeFileSync(path.join(folder, 'theme.json'), `${JSON.stringify(theme, null, 2)}\n`);
  fs.writeFileSync(settingsFile(), `${JSON.stringify({ [PREFERRED_LOOK_SETTINGS.dark]: THEME_ID })}\n`);
}

// The signed list removes the installed theme's entry.
const listFetcher: StoreFetcher = async () => new Response(JSON.stringify(signed(key, payload(NOW, { entries: [entry({ id: 'borealis' })], removed: [{ id: 'aurora', reason: 'Takedown: unlicensed art' }] }))), { status: 200 });

function startUpdater({ isPackaged = true } = {}): UpdateService {
  const list = createStoreList({ root, lane: themes.lane, enabled: () => storeOn, fetch: listFetcher, now: () => NOW, log: () => undefined, onFetch: (fetch) => fetchLog.push(fetch) });
  const store = createStoreClient({ themes, list, enabled: () => storeOn, appVersion: '3.8.0', now: () => NOW });
  const feed = Object.assign(new EventEmitter(), { checkForUpdates: vi.fn(async () => null) });
  const deps: UpdaterDeps = {
    isPackaged,
    platform: 'win32',
    arch: 'x64',
    version: '3.8.0',
    notifications: { info: async () => undefined, warn: async () => undefined, error: async () => undefined } as unknown as UpdaterDeps['notifications'],
    shell: { openExternal: async () => true, openFolder: async () => true, revealPath: async () => undefined },
    state: { get: ((_key: string, fallback?: unknown) => fallback) as UpdaterDeps['state']['get'], update: async () => undefined },
    checkAutomatically: () => automatic,
    storeCheck: () => {
      const check = store.backgroundCheck();
      checks.push(check);
      return check;
    },
    onResume: () => ({ dispose: () => undefined }),
    t: (message) => message,
    log: () => undefined,
    showLog: () => undefined,
    load: () => feed as unknown as ReturnType<UpdaterDeps['load']>,
    quit: async () => false,
  };
  const service = new UpdateService(deps);
  services.push(service);
  service.start();
  return service;
}

// The checks the updater started, each run to its end.
async function settled(): Promise<ReadonlyArray<{ readonly fetched: boolean }>> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  return Promise.all(checks);
}

const preferredDark = (): unknown => (JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Record<string, unknown>)[PREFERRED_LOOK_SETTINGS.dark];

async function removedMark(): Promise<unknown> {
  const found = (await themes.list()).find((candidate) => candidate.id === THEME_ID);
  return found?.status === 'ok' ? found.theme.origin?.removedFromStore : undefined;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'damocles-updater-store-'));
  fs.writeFileSync(settingsFile(), '{}\n');
  themes = createThemeService({ root, settings: fakeSettings(settingsFile()), now: () => NOW });
  fetchLog = [];
  automatic = true;
  storeOn = true;
  services = [];
  checks = [];
  trust.pem = key.publicPem;
});

afterEach(() => {
  for (const service of services) service.dispose();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('the store check beside the app update check', () => {
  it('fetches the list with a store theme installed and applies its removed entry without Browse', async () => {
    installStoreTheme();
    startUpdater();
    expect(await settled()).toEqual([{ fetched: true }]);
    expect(await removedMark()).toEqual({ reason: 'Takedown: unlicensed art', at: NOW });
    expect(fetchLog.map((fetch) => fetch.purpose)).toEqual(['list']);
    expect(preferredDark()).toBe(BUILTIN_THEME_ID);
    expect((await themes.history())[0]?.change).toEqual({ kind: 'storeRemoved', themes: ['Aurora'] });
  });

  it('fetches nothing with "Check for updates automatically" off', async () => {
    installStoreTheme();
    automatic = false;
    startUpdater();
    expect(await settled()).toEqual([]);
    expect(fetchLog).toEqual([]);
    expect(await removedMark()).toBeUndefined();
    expect(preferredDark()).toBe(THEME_ID);
  });

  it('fetches nothing with the store setting off', async () => {
    installStoreTheme();
    storeOn = false;
    startUpdater();
    expect(await settled()).toEqual([{ fetched: false }]);
    expect(fetchLog).toEqual([]);
    expect(await removedMark()).toBeUndefined();
  });

  it('fetches nothing while no store theme is installed', async () => {
    startUpdater();
    expect(await settled()).toEqual([{ fetched: false }]);
    expect(fetchLog).toEqual([]);
  });
});

describe('the store check beside a check the user asks for', () => {
  it.each(['help', 'about'] as const)('a %s check fetches the list with "Check for updates automatically" off and applies its removed entry', async (origin) => {
    installStoreTheme();
    automatic = false;
    const service = startUpdater();
    expect(await settled()).toEqual([]);
    service.check(origin);
    expect(await settled()).toEqual([{ fetched: true }]);
    expect(fetchLog.map((fetch) => fetch.purpose)).toEqual(['list']);
    expect(await removedMark()).toEqual({ reason: 'Takedown: unlicensed art', at: NOW });
    expect(preferredDark()).toBe(BUILTIN_THEME_ID);
  });

  it('fetches nothing with the store setting off or no store theme installed', async () => {
    automatic = false;
    storeOn = false;
    installStoreTheme();
    startUpdater().check('help');
    expect(await settled()).toEqual([{ fetched: false }]);
    storeOn = true;
    fs.rmSync(path.join(root, 'themes', THEME_ID), { recursive: true });
    startUpdater().check('about');
    expect(await settled()).toEqual([{ fetched: false }, { fetched: false }]);
    expect(fetchLog).toEqual([]);
  });

  it('runs no store check in the unpackaged app', async () => {
    installStoreTheme();
    startUpdater({ isPackaged: false }).check('help');
    expect(await settled()).toEqual([]);
    expect(fetchLog).toEqual([]);
  });
});
