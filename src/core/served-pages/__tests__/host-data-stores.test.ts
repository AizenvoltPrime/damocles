import { promises as fs, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mappedDrivePath } from '../../mapped-drives';
import { hostDataStores, hostDataStoresSync, hostStoreHost, linkedPreviewRefused } from '../host-data-stores';

vi.mock('../../mapped-drives', () => ({ mappedDrivePath: vi.fn(() => null) }));

// an env store this process reads on every OS
const STORE_VARIABLE = process.platform === 'win32' ? 'ProgramData' : 'XDG_CONFIG_HOME';

let dir: string;
const log = vi.fn();

beforeEach(async () => {
  dir = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'host-data-stores-')));
  log.mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.mocked(mappedDrivePath).mockReset().mockReturnValue(null);
  await fs.rm(dir, { recursive: true, force: true });
});

describe('this host\'s data stores', () => {
  it('reads this process\'s platform, env and home, and drive mounts on Linux only', () => {
    vi.stubEnv(STORE_VARIABLE, path.join(dir, 'store'));
    const host = hostStoreHost(log);
    expect(host.platform).toBe(process.platform);
    expect(host.env[STORE_VARIABLE]).toBe(path.join(dir, 'store'));
    if (process.platform !== 'linux') expect(host.drives).toEqual([]);
    expect(log).not.toHaveBeenCalled();
  });

  it('compares each store as its realpath too, resolved again once the env names another', async () => {
    for (const name of ['a', 'b']) {
      await fs.mkdir(path.join(dir, name));
      await fs.symlink(path.join(dir, name), path.join(dir, `${name}-link`), 'junction');
    }
    vi.stubEnv(STORE_VARIABLE, path.join(dir, 'a-link'));
    expect((await hostDataStores(log)).stores).toEqual(expect.arrayContaining([path.join(dir, 'a-link'), path.join(dir, 'a')]));
    expect(hostDataStoresSync(log).stores).toEqual(expect.arrayContaining([path.join(dir, 'a-link'), path.join(dir, 'a')]));
    vi.stubEnv(STORE_VARIABLE, path.join(dir, 'b-link'));
    for (const { stores } of [await hostDataStores(log), hostDataStoresSync(log)]) {
      expect(stores).toEqual(expect.arrayContaining([path.join(dir, 'b-link'), path.join(dir, 'b')]));
      expect(stores).not.toContain(path.join(dir, 'a'));
    }
  });

  it('answers a check that cannot await with each folder as spelled, never resolving one on that call, then with the realpaths', async () => {
    await fs.mkdir(path.join(dir, 'c'));
    await fs.symlink(path.join(dir, 'c'), path.join(dir, 'c-link'), 'junction');
    vi.stubEnv(STORE_VARIABLE, path.join(dir, 'c-link'));
    const sync = vi.spyOn(realpathSync, 'native');
    const first = hostDataStoresSync(log).stores;
    expect(first).toContain(path.join(dir, 'c-link'));
    expect(first).not.toContain(path.join(dir, 'c'));
    expect(sync).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(hostDataStoresSync(log).stores).toContain(path.join(dir, 'c')));
    expect(sync).not.toHaveBeenCalled();
  });

  it('keeps an answer a folder failed to resolve in, logged once, and resolves that folder again only after a minute', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const failing = path.join(dir, 'locked');
    vi.stubEnv(STORE_VARIABLE, failing);
    const realpath = fs.realpath;
    const resolved = vi.spyOn(fs, 'realpath').mockImplementation(async (folder, options) => {
      if (folder === failing) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return realpath(folder, options);
    });
    const tries = (): number => resolved.mock.calls.filter(([folder]) => folder === failing).length;
    expect((await hostDataStores(log)).stores).toContain(failing);
    expect((await hostDataStores(log)).stores).toContain(failing);
    hostDataStoresSync(log);
    expect(tries()).toBe(1);
    vi.setSystemTime(Date.now() + 61_000);
    await hostDataStores(log);
    await vi.waitFor(() => expect(tries()).toBe(2));
    await hostDataStores(log);
    expect(tries()).toBe(2);
    expect(log.mock.calls.filter(([line]) => String(line).includes(failing))).toEqual([[`[data-stores] ${failing} could not be resolved (EACCES); it is compared as spelled`]]);
  });

  it.runIf(process.platform === 'win32')('never resolves a folder on a drive Windows maps to a network host, comparing its share path instead', async () => {
    vi.mocked(mappedDrivePath).mockImplementation((root) => (root === 'H:\\' ? '\\\\nas\\home' : root === 'G:\\' ? '\\\\?\\GLOBALROOT\\Device\\Unreadable' : null));
    const resolved = vi.spyOn(fs, 'realpath');
    for (const [store, spellings] of [['H:\\Shared\\Data', ['H:\\Shared\\Data', '\\\\nas\\home\\Shared\\Data']], ['G:\\Data', ['G:\\Data']]] as const) {
      vi.stubEnv(STORE_VARIABLE, store);
      const { stores } = await hostDataStores(log);
      expect(stores.filter((folder) => /^(?:[GH]:|\\\\nas)/.test(folder))).toEqual(spellings);
    }
    expect(resolved.mock.calls.filter(([folder]) => /^[GH]:/.test(String(folder)))).toEqual([]);
  });

  it.runIf(process.platform === 'win32')('logs once and compares as spelled a folder on a drive Windows cannot place', async () => {
    vi.mocked(mappedDrivePath).mockImplementation(() => {
      throw new Error('QueryDosDeviceW(K:) failed with Win32 error 5');
    });
    vi.stubEnv(STORE_VARIABLE, 'K:\\Data');
    expect((await hostDataStores(log)).stores).toContain('K:\\Data');
    expect(log.mock.calls.filter(([line]) => String(line).includes('K:\\Data'))).toEqual([['[data-stores] K:\\Data could not be resolved (Error: QueryDosDeviceW(K:) failed with Win32 error 5); it is compared as spelled']]);
  });

  it('refuses a linked preview file under a denied segment or in a data store, and serves any other', async () => {
    vi.stubEnv(STORE_VARIABLE, path.join(dir, 'store'));
    expect(await linkedPreviewRefused(path.join(dir, 'store', 'app', 'x.html'), path.join(dir, 'store'), log)).toBe(true);
    expect(await linkedPreviewRefused(path.join(dir, 'site', '.git', 'config'), path.join(dir, 'site'), log)).toBe(true);
    expect(await linkedPreviewRefused(path.join(dir, 'site', 'GIT~1', 'config'), path.join(dir, 'site'), log)).toBe(true);
    expect(await linkedPreviewRefused(path.join(dir, 'site', 'index.html'), path.join(dir, 'site'), log)).toBe(false);
  });

  it('serves a pnpm package a workspace member links into node_modules/.pnpm, and refuses one under a dot folder before it', async () => {
    const workspace = path.join(dir, 'ws', 'node_modules', '.pnpm', 'x@1', 'node_modules', 'x');
    expect(await linkedPreviewRefused(path.join(workspace, 'index.js'), workspace, log)).toBe(false);
    const store = path.join(dir, '.local', 'share', 'pnpm', 'node_modules', '.pnpm', 'x');
    expect(await linkedPreviewRefused(path.join(store, 'index.js'), store, log)).toBe(true);
  });

  it('logs the first refusal under each link root, naming the denied segment or the data store', async () => {
    vi.stubEnv(STORE_VARIABLE, path.join(dir, 'store'));
    const site = path.join(dir, 'site');
    await linkedPreviewRefused(path.join(site, '.git', 'config'), site, log);
    await linkedPreviewRefused(path.join(site, '.git', 'HEAD'), site, log);
    await linkedPreviewRefused(path.join(dir, 'store', 'app', 'x.html'), path.join(dir, 'store', 'app'), log);
    expect(log.mock.calls).toEqual([
      [`[html-preview] a link at ${site} leads through .git, which a preview never serves; its files are not served`],
      [`[html-preview] a link at ${path.join(dir, 'store', 'app')} leads into ${path.join(dir, 'store')}, where applications or the system keep their data; its files are not served`],
    ]);
  });
});
