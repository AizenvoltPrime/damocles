import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { canCheck, type UpdateSnapshot, type UpdateState } from '../../preload/updates';
import { CHECK_INTERVAL_MS, LAST_CHECKED_KEY, RELEASES_URL, releasePageUrl, UpdateService, versionInfoText, type UpdaterDeps } from '../updater';

interface CheckResult {
  isUpdateAvailable: boolean;
  updateInfo: { version: string; releaseNotes?: string | Array<{ version: string; note: string | null }> | null };
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
let stored: Map<string, unknown>;
let resume: (() => void) | undefined;
let services: UpdateService[];

function deps(overrides: Partial<UpdaterDeps> = {}): UpdaterDeps {
  const notify = (severity: string) => (message: string, ...actions: string[]): Promise<string | undefined> => {
    notices.push({ severity, message, actions });
    return Promise.resolve(answers.shift());
  };
  return {
    isPackaged: true,
    platform: 'win32',
    arch: 'x64',
    version: '2.36.0',
    notifications: { info: notify('info'), warn: notify('warning'), error: notify('error') } as UpdaterDeps['notifications'],
    shell: {
      openExternal: async (url: string) => {
        opened.push(url);
        return true;
      },
      openFolder: async () => true,
      revealPath: async () => undefined,
    },
    state: {
      get: ((key: string, fallback?: unknown) => (stored.has(key) ? stored.get(key) : fallback)) as UpdaterDeps['state']['get'],
      update: async (key: string, value: unknown) => {
        stored.set(key, value);
      },
    },
    onResume: (listener) => {
      resume = listener;
      return { dispose: () => { resume = undefined; } };
    },
    t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_m, i: string) => String(args[Number(i)])),
    log: (line) => lines.push(line),
    showLog: () => {
      logShown++;
    },
    load: () => updater as unknown as ReturnType<UpdaterDeps['load']>,
    quit: async () => false,
    ...overrides,
  };
}

// The service the app starts after the window is up.
function startUpdater(overrides: Partial<UpdaterDeps> = {}): UpdateService {
  const service = new UpdateService(deps(overrides));
  services.push(service);
  service.start();
  return service;
}

function available(version: string, download: Promise<string[]> | null = Promise.resolve(['installer']), releaseNotes: CheckResult['updateInfo']['releaseNotes'] = '<p>notes</p>'): Promise<CheckResult> {
  return Promise.resolve({ isUpdateAvailable: true, updateInfo: { version, releaseNotes }, downloadPromise: download });
}

function upToDate(): Promise<CheckResult> {
  return Promise.resolve({ isUpdateAvailable: false, updateInfo: { version: '2.36.0' }, downloadPromise: null });
}

function states(service: UpdateService): UpdateState[] {
  const seen: UpdateState[] = [];
  service.onDidChange((snapshot: UpdateSnapshot) => seen.push(snapshot.state));
  return seen;
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
  stored = new Map();
  resume = undefined;
  services = [];
});

afterEach(() => {
  for (const service of services) service.dispose();
  vi.useRealTimers();
});

describe('desktop updater guards', () => {
  it('does nothing in the unpackaged app', async () => {
    const load = vi.fn();
    const service = startUpdater({ isPackaged: false, load });
    await settle();
    service.check('help');
    await settle();
    expect(load).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(updater.writes).toEqual([]);
    expect(service.snapshot()).toEqual({ state: { kind: 'disabled' }, lastCheckedAt: null, platform: 'win32' });
    expect(resume).toBeUndefined();
    expect(lines[0]).toBe('[updater] off: the app is not packaged');
    expect(notices).toEqual([]);
  });

  it('returns before the check runs, so startup never waits on the network', () => {
    updater.checkResult = new Promise(() => undefined);
    const load = vi.fn(() => updater as unknown as ReturnType<UpdaterDeps['load']>);
    startUpdater({ load });
    expect(load).not.toHaveBeenCalled();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('never loads electron-updater when disposed before the deferred start', async () => {
    const load = vi.fn(() => updater as unknown as ReturnType<UpdaterDeps['load']>);
    startUpdater({ load }).dispose();
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
    startUpdater({ arch });
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
    startUpdater({ platform, arch: 'arm64' });
    await settle();
    expect(updater.writes.some(([key]) => key === 'channel')).toBe(false);
    expect(updater.value('allowDowngrade')).toBe(false);
  });

  it('configures electron-updater once across checks', async () => {
    updater.checkResult = upToDate();
    const service = startUpdater();
    await settle();
    service.check('about');
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(updater.writes.filter(([key]) => key === 'channel')).toHaveLength(1);
    expect(updater.listenerCount('error')).toBe(1);
  });

  it('takes the feed only from the packaged app-update.yml', async () => {
    startUpdater();
    await settle();
    expect(updater.setFeedURL).not.toHaveBeenCalled();
    const keys = updater.writes.map(([key]) => key);
    expect(keys).not.toContain('forceDevUpdateConfig');
    expect(keys).not.toContain('updateConfigPath');
  });

  it('routes electron-updater logging to the log sink', async () => {
    startUpdater();
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
    startUpdater({ platform: 'linux' });
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
    startUpdater();
    await settle();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(updater.value('autoInstallOnAppQuit')).toBe(true);
    expect(lines).toContain('[updater] 2.37.0 installs when Damocles quits');
    expect(notices[0]!.message).toBe('Damocles 2.37.0 is ready. Restart now to install it, or it installs when you quit.');
  });

  it('on macOS, downloads nothing and opens only the release page of the new version', async () => {
    updater.checkResult = available('2.37.0', null);
    answers.push('Open Release Page');
    startUpdater({ platform: 'darwin', arch: 'arm64' });
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
    startUpdater({ platform: 'darwin', arch: 'arm64' });
    await settle();
    expect(notices).toHaveLength(1);
    expect(opened).toEqual([]);
  });

  it('refuses a feed version that would change the release page URL', async () => {
    updater.checkResult = available('2.37.0/../../evil', null);
    const service = startUpdater({ platform: 'darwin', arch: 'arm64' });
    await settle();
    expect(opened).toEqual([]);
    expect(notices.map((n) => n.severity)).toEqual(['warning']);
    expect(service.snapshot().state.kind).toBe('error');
    await expect(service.openReleasePage()).rejects.toThrow('No update is available');
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
    expect(strings.length).toBeGreaterThanOrEqual(9);
    for (const bundle of ['bundle.l10n.json', 'bundle.l10n.el.json']) {
      const table = JSON.parse(readFileSync(new URL(`../../../../l10n/${bundle}`, import.meta.url), 'utf8')) as Record<string, string>;
      for (const message of strings) {
        expect(table[message], `${bundle}: ${message}`).toBeTruthy();
        expect(table[message], `${bundle}: ${message}`).not.toContain('\u2014');
      }
    }
  });

  it('posts nothing when an automatic check finds no update', async () => {
    updater.checkResult = upToDate();
    startUpdater();
    await settle();
    expect(notices).toEqual([]);
  });

  it('only logs a failed automatic check, which being offline causes on every launch, with no unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const err = Object.assign(new Error('getaddrinfo ENOTFOUND github.com\nstack detail'), { code: 'ENOTFOUND' });
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit('error', err);
      return Promise.reject(err);
    });
    const service = startUpdater();
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.startsWith('[updater] failed:'))).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(service.snapshot().state).toEqual({ kind: 'error', reason: 'getaddrinfo ENOTFOUND github.com' });
  });

  it('logs a download failure the updater both emits and rejects with once, and shows it once per run', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const err = new Error('sha512 checksum mismatch\nstack detail');
    let reject!: (err: Error) => void;
    updater.checkResult = available('2.37.0', new Promise((_resolve, rejectDownload) => (reject = rejectDownload)));
    answers.push('Show Log');
    const service = startUpdater();
    await settle();
    updater.emit('error', err);
    reject(err);
    await settle();
    updater.emit('error', new Error('install failed'));
    await settle();
    let rejectSecond!: (err: Error) => void;
    updater.checkResult = available('2.37.0', new Promise((_resolve, rejectDownload) => (rejectSecond = rejectDownload)));
    service.check('help');
    await settle();
    rejectSecond(new Error('second run failure'));
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(lines.filter((line) => line.startsWith('[updater] failed:'))).toHaveLength(3);
    expect(notices).toEqual([{ severity: 'warning', message: 'Damocles could not update itself: sha512 checksum mismatch', actions: ['Show Log'] }]);
    expect(logShown).toBe(1);
  });

  it('reports a failed download without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    let reject!: (err: Error) => void;
    updater.checkResult = available('2.37.0', new Promise((_resolve, rejectDownload) => (reject = rejectDownload)));
    startUpdater();
    await settle();
    reject(new Error('sha512 checksum mismatch'));
    await settle();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(notices.map((n) => n.message)).toEqual(['Damocles could not update itself: sha512 checksum mismatch']);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('stops listening and timing once disposed', async () => {
    updater.checkResult = upToDate();
    const service = startUpdater();
    await settle();
    expect(updater.listenerCount('error')).toBe(1);
    expect(updater.listenerCount('download-progress')).toBe(1);
    expect(resume).toBeDefined();
    service.dispose();
    expect(updater.listenerCount('error')).toBe(0);
    expect(updater.listenerCount('download-progress')).toBe(0);
    expect(resume).toBeUndefined();
  });

  it('points the release page at the repository package.json names', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8')) as { repository: { url: string } };
    expect(`${manifest.repository.url.replace(/\.git$/, '')}/releases`).toBe(RELEASES_URL);
  });
});

describe('update states', () => {
  it('goes from idle through checking to upToDate, and records when the check reached the feed', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    updater.checkResult = upToDate();
    const service = new UpdateService(deps());
    services.push(service);
    expect(service.snapshot()).toEqual({ state: { kind: 'idle' }, lastCheckedAt: null, platform: 'win32' });
    const seen = states(service);
    service.start();
    await settle();
    expect(seen).toEqual([{ kind: 'checking' }, { kind: 'upToDate', checkedAt: 1_000_000 }]);
    expect(service.snapshot().lastCheckedAt).toBe(1_000_000);
    expect(stored.get(LAST_CHECKED_KEY)).toBe(1_000_000);
  });

  it('carries on with a found update when recording the check time fails, and logs the failed write', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: 1_000_000 });
    updater.checkResult = available('2.37.0');
    answers.push(undefined);
    const failing = deps().state;
    const service = startUpdater({ state: { get: failing.get, update: async () => { throw new Error('disk full'); } } });
    const seen = states(service);
    await settle();
    expect(seen.map((state) => state.kind)).toEqual(['checking', 'downloading', 'ready']);
    expect(service.snapshot().lastCheckedAt).toBe(1_000_000);
    expect(notices.map((notice) => notice.message)).toEqual(['Damocles 2.37.0 is ready. Restart now to install it, or it installs when you quit.']);
    expect(lines).toContain('[updater] could not record the check time: disk full');
  });

  it('reads the last check of an earlier run', () => {
    stored.set(LAST_CHECKED_KEY, 42);
    expect(new UpdateService(deps()).snapshot().lastCheckedAt).toBe(42);
    stored.set(LAST_CHECKED_KEY, 'yesterday');
    expect(new UpdateService(deps()).snapshot().lastCheckedAt).toBeNull();
  });

  it('downloads with an integer percent, pushes only changes, and holds the feed notes once ready', async () => {
    let finish!: (paths: string[]) => void;
    updater.checkResult = available('2.37.0', new Promise((resolve) => (finish = resolve)), '<h2>Fixed</h2>');
    const service = new UpdateService(deps());
    services.push(service);
    const seen = states(service);
    service.start();
    await settle();
    updater.emit('download-progress', { percent: 41.7 });
    updater.emit('download-progress', { percent: 41.9 });
    updater.emit('download-progress', { percent: 120 });
    finish(['installer']);
    await settle();
    expect(seen).toEqual([
      { kind: 'checking' },
      { kind: 'downloading', version: '2.37.0', percent: 0 },
      { kind: 'downloading', version: '2.37.0', percent: 41 },
      { kind: 'downloading', version: '2.37.0', percent: 100 },
      { kind: 'ready', version: '2.37.0', notes: '<h2>Fixed</h2>' },
    ]);
  });

  it('joins a full-changelog feed\'s notes and bounds them', async () => {
    updater.checkResult = available('2.37.0', null, [{ version: '2.37.0', note: 'a' }, { version: '2.36.1', note: null }, { version: '2.36.0', note: 'b'.repeat(70_000) }]);
    const service = startUpdater({ platform: 'darwin' });
    await settle();
    const state = service.snapshot().state as Extract<UpdateState, { kind: 'available' }>;
    expect(state.kind).toBe('available');
    expect(state.notes.startsWith('a\n\nbbb')).toBe(true);
    expect(state.notes).toHaveLength(64 * 1024);
  });

  it('treats a manual check while checking or downloading as a no-op', async () => {
    let finish!: (paths: string[]) => void;
    let found!: (result: CheckResult) => void;
    updater.checkResult = new Promise((resolve) => (found = resolve));
    const service = startUpdater();
    await settle();
    expect(service.snapshot().state.kind).toBe('checking');
    service.check('help');
    service.check('about');
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    found({ isUpdateAvailable: true, updateInfo: { version: '2.37.0' }, downloadPromise: new Promise((resolve) => (finish = resolve)) });
    await settle();
    expect(service.snapshot().state.kind).toBe('downloading');
    service.check('help');
    service.check('about');
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    finish(['installer']);
    await settle();
    service.check('help');
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(notices).toHaveLength(1);
  });

  it('refuses a restart unless an update is ready', async () => {
    updater.checkResult = upToDate();
    const service = startUpdater();
    await settle();
    expect(() => service.restart()).toThrow('No update is ready to install');
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it('runs the installer only once the quit was not cancelled, so a cancelled restart can restart again later', async () => {
    const quits: Array<(vetoed: boolean) => void> = [];
    const quit = vi.fn(() => new Promise<boolean>((resolve) => quits.push(resolve)));
    updater.checkResult = available('2.37.0');
    const service = startUpdater({ quit });
    await settle();
    expect(service.snapshot().state.kind).toBe('ready');

    service.restart();
    await settle();
    expect(quit).toHaveBeenCalledOnce();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    quits.shift()!(true);
    await settle();
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.snapshot().state.kind).toBe('ready');
    expect(lines).toContain('[updater] the restart to install 2.37.0 was cancelled');

    service.restart();
    await settle();
    expect(quit).toHaveBeenCalledTimes(2);
    quits.shift()!(false);
    await settle();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('shows restarting while the quit runs and refuses a second restart, then shows ready again when the quit is cancelled', async () => {
    const quits: Array<(vetoed: boolean) => void> = [];
    const quit = vi.fn(() => new Promise<boolean>((resolve) => quits.push(resolve)));
    updater.checkResult = available('2.37.0');
    const service = startUpdater({ quit });
    await settle();
    const seen = states(service);

    service.restart();
    expect(service.snapshot().state).toEqual({ kind: 'restarting', version: '2.37.0', notes: '<p>notes</p>' });
    expect(canCheck(service.snapshot().state)).toBe(false);
    expect(() => service.restart()).toThrow('No update is ready to install');
    await settle();
    expect(quit).toHaveBeenCalledOnce();

    quits.shift()!(true);
    await settle();
    expect(seen).toEqual([
      { kind: 'restarting', version: '2.37.0', notes: '<p>notes</p>' },
      { kind: 'ready', version: '2.37.0', notes: '<p>notes</p>' },
    ]);
    expect(lines).toContain('[updater] state restarting 2.37.0');
  });

  it("leaves the notice's Restart Now alone while a restart from About already quits", async () => {
    let answer!: (label: string | undefined) => void;
    const quit = vi.fn(() => new Promise<boolean>(() => undefined));
    updater.checkResult = available('2.37.0');
    const service = startUpdater({
      quit,
      notifications: { info: () => new Promise<string | undefined>((resolve) => (answer = resolve)), warn: async () => undefined, error: async () => undefined } as unknown as UpdaterDeps['notifications'],
    });
    await settle();
    service.restart();
    answer('Restart Now');
    await settle();
    expect(quit).toHaveBeenCalledOnce();
    expect(service.snapshot().state.kind).toBe('restarting');
    expect(lines.some((line) => line.startsWith('[updater] failed'))).toBe(false);
  });

  it('logs an installer that fails after the teardown, with nothing left to tell', async () => {
    updater.quitAndInstall.mockImplementation(() => {
      throw new Error('pkexec was dismissed');
    });
    updater.checkResult = available('2.37.0');
    const service = startUpdater();
    await settle();
    service.restart();
    await settle();
    expect(lines.some((line) => line.startsWith('[updater] the installer did not start: Error: pkexec was dismissed'))).toBe(true);
  });
});

describe('check origins', () => {
  it('answers a Help check that finds nothing with one notice, and an About check with none', async () => {
    updater.checkResult = upToDate();
    const service = startUpdater();
    await settle();
    expect(notices).toEqual([]);
    service.check('about');
    await settle();
    expect(notices).toEqual([]);
    service.check('help');
    await settle();
    expect(notices).toEqual([{ severity: 'info', message: 'Damocles 2.36.0 is up to date.', actions: [] }]);
  });

  it('tells a Help check that failed, and an About check nothing, since the version card shows the error', async () => {
    const err = new Error('getaddrinfo ENOTFOUND github.com');
    updater.checkForUpdates.mockImplementation(() => {
      updater.emit('error', err);
      return Promise.reject(err);
    });
    answers.push('Show Log');
    const service = startUpdater();
    await settle();
    service.check('about');
    await settle();
    expect(notices).toEqual([]);
    service.check('help');
    await settle();
    expect(notices).toEqual([{ severity: 'warning', message: 'Damocles could not check for updates: getaddrinfo ENOTFOUND github.com', actions: ['Show Log'] }]);
    expect(logShown).toBe(1);
  });

  it('posts the ready notice for an update an About check found, since the user may have left Settings', async () => {
    updater.checkForUpdates.mockImplementationOnce(() => upToDate());
    const service = startUpdater();
    await settle();
    updater.checkResult = available('2.37.0');
    service.check('about');
    await settle();
    expect(service.snapshot().state).toEqual({ kind: 'ready', version: '2.37.0', notes: '<p>notes</p>' });
    expect(notices.map((n) => n.actions)).toEqual([['Restart Now']]);
    service.restart();
    await settle();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });

  it('warns once when the download an About check started fails', async () => {
    updater.checkForUpdates.mockImplementationOnce(() => upToDate());
    const service = startUpdater();
    await settle();
    let reject!: (err: Error) => void;
    updater.checkResult = available('2.37.0', new Promise((_resolve, rejectDownload) => (reject = rejectDownload)));
    service.check('about');
    await settle();
    reject(new Error('sha512 checksum mismatch'));
    await settle();
    expect(service.snapshot().state).toEqual({ kind: 'error', reason: 'sha512 checksum mismatch' });
    expect(notices).toEqual([{ severity: 'warning', message: 'Damocles could not update itself: sha512 checksum mismatch', actions: ['Show Log'] }]);
  });

  it('allows a check only from idle, upToDate and error', () => {
    const allowed = (['disabled', 'idle', 'checking', 'upToDate', 'available', 'downloading', 'ready', 'error'] as const)
      .filter((kind) => canCheck({ kind, checkedAt: 0, version: '1.0.0', notes: '', percent: 0, reason: '' } as UpdateState));
    expect(allowed).toEqual(['idle', 'upToDate', 'error']);
  });

  it('on macOS, opens the release page from About only while the update is available', async () => {
    updater.checkResult = available('2.37.0', null);
    const service = startUpdater({ platform: 'darwin', arch: 'arm64' });
    await settle();
    await service.openReleasePage();
    expect(opened).toEqual(['https://github.com/AizenvoltPrime/damocles/releases/tag/v2.37.0']);
  });
});

describe('check timing', () => {
  it('checks again every CHECK_INTERVAL_MS after the first check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    updater.checkResult = upToDate();
    startUpdater();
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS - 1);
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('restarts the interval from a manual check', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    updater.checkResult = upToDate();
    const service = startUpdater();
    await settle();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS / 2);
    service.check('about');
    await settle();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS / 2);
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(CHECK_INTERVAL_MS / 2);
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(3);
  });

  it('checks on resume from sleep only when the last check is CHECK_INTERVAL_MS old', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: 0 });
    updater.checkResult = upToDate();
    startUpdater();
    await settle();
    vi.setSystemTime(CHECK_INTERVAL_MS - 1);
    resume!();
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);
    vi.setSystemTime(CHECK_INTERVAL_MS);
    resume!();
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('checks on resume when no check ever reached the feed', async () => {
    const err = new Error('offline');
    updater.checkForUpdates.mockImplementationOnce(() => Promise.reject(err));
    const service = startUpdater();
    await settle();
    expect(service.snapshot().lastCheckedAt).toBeNull();
    updater.checkResult = upToDate();
    resume!();
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('skips a periodic check while an update waits', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    updater.checkResult = available('2.37.0');
    startUpdater();
    await settle();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(lines).toContain('[updater] auto check skipped while ready');
  });

  it('keeps the periodic check going after one skipped during a download that then failed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let reject!: (err: Error) => void;
    updater.checkResult = available('2.37.0', new Promise((_resolve, rejectDownload) => (reject = rejectDownload)));
    const service = startUpdater();
    await settle();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    await settle();
    expect(lines).toContain('[updater] auto check skipped while downloading');
    reject(new Error('connection reset'));
    await settle();
    expect(service.snapshot().state.kind).toBe('error');
    updater.checkResult = upToDate();
    vi.advanceTimersByTime(CHECK_INTERVAL_MS);
    await settle();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe('versionInfoText', () => {
  it('lists the versions and the platform', () => {
    expect(versionInfoText({ version: '3.4.0', packaged: true, platform: 'win32', arch: 'x64', electron: '39.2.0', chromium: '142.0.1', node: '24.11.0' }))
      .toBe('Damocles 3.4.0\nElectron 39.2.0\nChromium 142.0.1\nNode.js 24.11.0\nwin32 x64');
  });
});
