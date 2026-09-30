import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RELEASES_URL, releasePageUrl, startUpdater, type UpdaterDeps } from '../updater';

interface CheckResult {
  isUpdateAvailable: boolean;
  updateInfo: { version: string };
  downloadPromise: Promise<string[]> | null;
}

// Records every property write in order, so the channel-then-allowDowngrade sequence is observable.
class FakeUpdater extends EventEmitter {
  readonly writes: Array<[string, unknown]> = [];
  checkResult: Promise<CheckResult | null> = Promise.resolve(null);
  readonly checkForUpdates = vi.fn(() => this.checkResult);
  readonly quitAndInstall = vi.fn();
  readonly setFeedURL = vi.fn();
  private values: Record<string, unknown> = {};

  constructor() {
    super();
    for (const key of ['logger', 'allowPrerelease', 'disableWebInstaller', 'autoDownload', 'autoInstallOnAppQuit', 'allowDowngrade', 'forceDevUpdateConfig', 'updateConfigPath']) {
      Object.defineProperty(this, key, {
        get: () => this.values[key],
        set: (value: unknown) => {
          this.writes.push([key, value]);
          this.values[key] = value;
        },
      });
    }
    Object.defineProperty(this, 'channel', {
      get: () => this.values.channel,
      // electron-updater 6.8.9 AppUpdater: the channel setter also enables downgrades.
      set: (value: unknown) => {
        this.writes.push(['channel', value]);
        this.values.channel = value;
        this.values.allowDowngrade = true;
      },
    });
  }

  value(key: string): unknown {
    return this.values[key];
  }
}

let updater: FakeUpdater;
let lines: string[];
let answers: Array<string | undefined>;
let notices: Array<{ severity: string; message: string; actions: string[] }>;
let opened: string[];
let logShown: number;

function deps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  const notify = (severity: string) => (message: string, ...actions: string[]): Promise<string | undefined> => {
    notices.push({ severity, message, actions });
    return Promise.resolve(answers.shift());
  };
  return {
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
    notifications: { info: notify('info'), warn: notify('warning'), error: notify('error') } as UpdaterDeps['notifications'],
    shell: {
      openExternal: async (url: string) => {
        opened.push(url);
        return true;
      },
      openFolder: async () => true,
      revealPath: async () => undefined,
    },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])),
    log: (line) => lines.push(line),
    showLog: () => {
      logShown++;
    },
    load: () => updater as unknown as ReturnType<UpdaterDeps['load']>,
    ...overrides,
  };
}

function available(version: string, download: Promise<string[]> | null = Promise.resolve(['installer'])): Promise<CheckResult> {
  return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version }, downloadPromise: download });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  updater = new FakeUpdater();
  lines = [];
  answers = [];
  notices = [];
  opened = [];
  logShown = 0;
});

describe('desktop updater', () => {
  it('does nothing in the unpackaged app', async () => {
    const load = vi.fn();
    startUpdater(deps({ isPackaged: false, load }));
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.writes).toEqual([]);
    expect(lines).toEqual(['[updater] off: the app is not packaged']);
  });

  it('returns before the check runs, so startup never waits on the network', () => {
    updater.checkResult = new Promise(() => undefined);
    const load = vi.fn(() => updater as unknown as ReturnType<UpdaterDeps['load']>);
    const handle = startUpdater(deps({ load }));
    expect(handle.dispose).toBeTypeOf('function');
    expect(load).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('never loads electron-updater when disposed before the deferred start', async () => {
    const load = vi.fn(() => updater as unknown as ReturnType<UpdaterDeps['load']>);
    startUpdater(deps({ load })).dispose();
    await settle();
    expect(load).not.toHaveBeenCalled();
  });

  it('loads autoUpdater through require, where electron-updater defines it as an exports getter', () => {
    const exported = createRequire(import.meta.url)('electron-updater') as object;
    expect(typeof Object.getOwnPropertyDescriptor(exported, 'autoUpdater')?.get).toBe('function');
    const source = readFileSync(new URL('../updater.ts', import.meta.url), 'utf8');
    expect(source).toContain("require('electron-updater')");
    expect(source).not.toMatch(/import\(\s*'electron-updater'\s*\)/);
  });

  it.each(['x64', 'arm64'])('reads latest-%s.yml on Windows and turns downgrades off after setting the channel', async (arch) => {
    startUpdater(deps({ arch }));
    await settle();
    expect(updater.value('channel')).toBe(`latest-${arch}`);
    expect(updater.value('allowDowngrade')).toBe(false);
    const keys = updater.writes.map(([key]) => key);
    expect(keys.lastIndexOf('allowDowngrade')).toBeGreaterThan(keys.indexOf('channel'));
    expect(updater.value('autoDownload')).toBe(true);
    expect(updater.value('autoInstallOnAppQuit')).toBe(true);
    expect(updater.value('allowPrerelease')).toBe(false);
    expect(updater.value('disableWebInstaller')).toBe(true);
  });

  it.each(['linux', 'darwin'] as const)('keeps the default channel on %s', async (platform) => {
    startUpdater(deps({ platform, arch: 'arm64' }));
    await settle();
    expect(updater.writes.some(([key]) => key === 'channel')).toBe(false);
    expect(updater.value('allowDowngrade')).toBe(false);
  });

  it('takes the feed only from the packaged app-update.yml', async () => {
    startUpdater(deps());
    await settle();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    const keys = updater.writes.map(([key]) => key);
    expect(keys).not.toContain('forceDevUpdateConfig');
    expect(keys).not.toContain('updateConfigPath');
  });

  it('routes electron-updater logging to the log sink', async () => {
    startUpdater(deps());
    await settle();
    const logger = updater.value('logger') as { info(m: string): void; warn(m: string): void; error(m: string): void };
    logger.info('Checking for update');
    logger.warn('slow');
    logger.error('bad');
    expect(lines).toEqual(expect.arrayContaining(['[updater] Checking for update', '[updater] warning: slow', '[updater] error: bad']));
  });

  it('on Windows and Linux, offers a restart once the download finishes and installs on the restart action', async () => {
    let finish!: (paths: string[]) => void;
    updater.checkResult = available('2.37.0', new Promise((resolve) => (finish = resolve)));
    answers.push('Restart Now');
    startUpdater(deps({ platform: 'linux' }));
    await settle();
    expect(notices).toEqual([]);
    finish(['/tmp/damocles.deb']);
    await settle();
    expect(notices).toEqual([{ severity: 'info', message: 'Damocles 2.37.0 is ready. Restart now to install it, or it installs when you quit. Installing asks for an administrator password.', actions: ['Restart Now'] }]);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('leaves a declined update to install on quit', async () => {
    updater.checkResult = available('2.37.0');
    answers.push(undefined);
    startUpdater(deps());
    await settle();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.value('autoInstallOnAppQuit')).toBe(true);
    expect(lines).toContain('[updater] 2.37.0 installs when Damocles quits');
    expect(notices[0]!.message).toBe('Damocles 2.37.0 is ready. Restart now to install it, or it installs when you quit.');
  });

  it('on macOS, downloads nothing and opens only the release page of the new version', async () => {
    updater.checkResult = available('2.37.0', null);
    answers.push('Open Release Page');
    startUpdater(deps({ platform: 'darwin', arch: 'arm64' }));
    await settle();
    expect(updater.value('autoDownload')).toBe(false);
    expect(updater.value('autoInstallOnAppQuit')).toBe(false);
    expect(notices).toEqual([{ severity: 'info', message: 'Damocles 2.37.0 is available. Download it from the release page to update.', actions: ['Open Release Page'] }]);
    expect(opened).toEqual(['https://github.com/AizenvoltPrime/damocles/releases/tag/v2.37.0']);
    expect(lines).toContain('[updater] opening the release page https://github.com/AizenvoltPrime/damocles/releases/tag/v2.37.0');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('on macOS, a dismissed notice opens nothing', async () => {
    updater.checkResult = available('2.37.0', null);
    startUpdater(deps({ platform: 'darwin', arch: 'arm64' }));
    await settle();
    expect(notices).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('refuses a feed version that would change the release page URL', async () => {
    updater.checkResult = available('2.37.0/../../evil', null);
    startUpdater(deps({ platform: 'darwin', arch: 'arm64' }));
    await settle();
    expect(opened).toEqual([]);
    expect(notices.map((n) => n.severity)).toEqual(['warning']);
  });

  it.each(['1.0.0/../../evil', '1.0.0@evil.com', '1.0.0\n', ' 1.0.0', 'javascript:alert(1)', '1.2.3?x=1', '1.2.3#x', '1.2.3-a/b', ''])('refuses the hostile feed version %j', (version) => {
    expect(() => releasePageUrl(version)).toThrow();
  });

  it('builds a github.com release page URL for a release or prerelease version', () => {
    for (const version of ['2.37.0', '2.37.0-rc.1']) {
      const url = new URL(releasePageUrl(version));
      expect(url.origin).toBe('https://github.com');
      expect(url.pathname).toBe(`/AizenvoltPrime/damocles/releases/tag/v${version}`);
      expect(url.search + url.hash).toBe('');
    }
  });

  it('contains no feed override, dev update config or environment read', () => {
    const source = readFileSync(new URL('../updater.ts', import.meta.url), 'utf8');
    for (const banned of ['setFeedURL', 'forceDevUpdateConfig', 'updateConfigPath', 'process.env', 'process.argv', 'dev-app-update']) {
      expect(source).not.toContain(banned);
    }
  });

  it('has every notice string in the English and Greek bundles', () => {
    const source = readFileSync(new URL('../updater.ts', import.meta.url), 'utf8');
    const strings = [...source.matchAll(/\bt\('([^']+)'/g)].map((m) => m[1]!);
    expect(strings.length).toBeGreaterThanOrEqual(7);
    for (const bundle of ['bundle.l10n.json', 'bundle.l10n.el.json']) {
      const table = JSON.parse(readFileSync(new URL(`../../../../l10n/${bundle}`, import.meta.url), 'utf8')) as Record<string, string>;
      for (const message of strings) expect(table[message], `${bundle}: ${message}`).toBeTruthy();
    }
  });

  it('does nothing more when no update is available', async () => {
    updater.checkResult = Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '2.36.0' }, downloadPromise: null });
    startUpdater(deps());
    await settle();
    expect(notices).toEqual([]);
  });

  it('only logs a failed check, which being offline causes on every launch, with no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND github.com\nstack detail'), { code: 'ENOTFOUND' });
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit('error', err);
      return Promise.reject(err);
    });
    startUpdater(deps());
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.startsWith('[updater] failed:'))).toHaveLength(1);
    expect(notices).toEqual([]);
  });

  it('logs a download failure the updater both emits and rejects with once, and shows it once', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const err = new Error('sha512 checksum mismatch\nstack detail');
    let reject!: (err: Error) => void;
    updater.checkResult = available('2.37.0', new Promise((_resolve, rejectDownload) => (reject = rejectDownload)));
    answers.push('Show Log');
    startUpdater(deps());
    await settle();
    updater.emit('error', err);
    reject(err);
    await settle();
    updater.emit('error', new Error('install failed'));
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.startsWith('[updater] failed:'))).toHaveLength(2);
    expect(notices).toEqual([{ severity: 'warning', message: 'Damocles could not update itself: sha512 checksum mismatch', actions: ['Show Log'] }]);
    expect(logShown).toBe(1);
  });

  it('reports a failed download without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let reject!: (err: Error) => void;
    updater.checkResult = available('2.37.0', new Promise((_resolve, rejectDownload) => (reject = rejectDownload)));
    startUpdater(deps());
    await settle();
    reject(new Error('sha512 checksum mismatch'));
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(notices.map((n) => n.message)).toEqual(['Damocles could not update itself: sha512 checksum mismatch']);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('stops listening once disposed', async () => {
    const handle = startUpdater(deps());
    await settle();
    expect(updater.listenerCount('error')).toBe(1);
    handle.dispose();
    expect(updater.listenerCount('error')).toBe(0);
  });

  it('points the release page at the repository package.json names', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { repository: { url: string } };
    expect(`${manifest.repository.url.replace(/\.git$/, '')}/releases`).toBe(RELEASES_URL);
  });
});
