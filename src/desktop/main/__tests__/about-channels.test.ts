import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OVERLAY_CHANNELS } from '../../preload/overlay-channels';
import { isUpdateAction, type UpdateState, type VersionInfo } from '../../preload/updates';
import type { SettingsTarget } from '../../../shared/settings-sections';
import { handleAboutChannels, runUpdateAction, type AboutDeps } from '../about-channels';
import { ReleaseNotesSource } from '../release-notes';
import type { UpdateService } from '../updater';

const INFO: VersionInfo = { version: '3.4.0', packaged: true, platform: 'linux', arch: 'x64', electron: '39.2.0', chromium: '142.0.1', node: '24.11.0' };

let dir: string;
let state: UpdateState;
let open: boolean;
let calls: string[];
let copied: string[];
let opened: SettingsTarget[];
let handlers: Map<string, (...args: unknown[]) => unknown>;
let deps: AboutDeps;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'about'));
  const file = join(dir, 'CHANGELOG.md');
  writeFileSync(file, '# Changelog\n\n## [3.4.0] - 2026-10-05\n### Added\n- About\n\n## [3.3.0] - 2026-09-01\n### Fixed\n- [a link](https://example.com)\n');
  state = { kind: 'idle' };
  open = true;
  calls = [];
  copied = [];
  opened = [];
  handlers = new Map();
  const updates = {
    snapshot: () => ({ state, lastCheckedAt: null, platform: 'linux' }),
    check: (origin: string) => calls.push(`check:${origin}`),
    restart: () => {
      if (state.kind !== 'ready') throw new Error('No update is ready to install');
      calls.push('restart');
    },
    openReleasePage: async () => {
      if (state.kind !== 'available') throw new Error('No update is available');
      calls.push('releasePage');
    },
  } as unknown as UpdateService;
  deps = {
    updates,
    releaseNotes: new ReleaseNotesSource(file, '3.4.0', () => undefined),
    versionInfo: () => INFO,
    clipboard: { writeText: async (text) => { copied.push(text); } },
    showLog: () => calls.push('showLog'),
    openSettings: (target) => opened.push(target),
  };
  handleAboutChannels({ handle: (channel, handler) => handlers.set(channel, handler), isOpen: (kind) => open && kind === 'settings' }, deps);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => handlers.get(channel)!(...args);

describe('About channels', () => {
  it('refuses every channel while the settings modal is closed', async () => {
    open = false;
    const channels = [
      OVERLAY_CHANNELS.updateGet, OVERLAY_CHANNELS.updateCheck, OVERLAY_CHANNELS.updateRestart, OVERLAY_CHANNELS.updateShowLog,
      OVERLAY_CHANNELS.updateCopyInfo, OVERLAY_CHANNELS.updateVersionInfo, OVERLAY_CHANNELS.updateOpenReleasePage,
      OVERLAY_CHANNELS.releaseNotesIndex, OVERLAY_CHANNELS.releaseNotesGet,
    ];
    expect([...handlers.keys()].sort()).toEqual([...channels].sort());
    for (const channel of channels) await expect(invoke(channel, '3.4.0'), channel).rejects.toThrow('The settings are not open');
    expect(calls).toEqual([]);
    expect(copied).toEqual([]);
  });

  it('checks as About, which posts no notice, and copies the version info through the clipboard service', async () => {
    await invoke(OVERLAY_CHANNELS.updateCheck);
    await invoke(OVERLAY_CHANNELS.updateShowLog);
    await invoke(OVERLAY_CHANNELS.updateCopyInfo);
    expect(calls).toEqual(['check:about', 'showLog']);
    expect(copied).toEqual(['Damocles 3.4.0\nElectron 39.2.0\nChromium 142.0.1\nNode.js 24.11.0\nlinux x64']);
    await expect(invoke(OVERLAY_CHANNELS.updateVersionInfo)).resolves.toEqual(INFO);
    await expect(invoke(OVERLAY_CHANNELS.updateGet)).resolves.toEqual({ state: { kind: 'idle' }, lastCheckedAt: null, platform: 'linux' });
  });

  it('restarts and opens the release page only in the states that offer them', async () => {
    await expect(invoke(OVERLAY_CHANNELS.updateRestart)).rejects.toThrow('No update is ready to install');
    await expect(invoke(OVERLAY_CHANNELS.updateOpenReleasePage)).rejects.toThrow('No update is available');
    state = { kind: 'ready', version: '3.5.0', notes: '' };
    await invoke(OVERLAY_CHANNELS.updateRestart);
    state = { kind: 'available', version: '3.5.0', notes: '' };
    await invoke(OVERLAY_CHANNELS.updateOpenReleasePage);
    expect(calls).toEqual(['restart', 'releasePage']);
  });

  it('serves the release index and the notes of a version in it', async () => {
    await expect(invoke(OVERLAY_CHANNELS.releaseNotesIndex)).resolves.toEqual({
      current: '3.4.0',
      versions: [{ version: '3.4.0', date: '2026-10-05' }, { version: '3.3.0', date: '2026-09-01' }],
    });
    await expect(invoke(OVERLAY_CHANNELS.releaseNotesGet, '3.3.0')).resolves.toEqual({ version: '3.3.0', markdown: '### Fixed\n- [a link](https://example.com)' });
  });

  it.each([['a version not in the index', '9.9.9'], ['a path', '../CHANGELOG.md'], ['an overlong string', `3.4.0-${'a'.repeat(100)}`], ['a number', 3.4], ['an object', { version: '3.4.0' }], ['nothing', undefined]])('refuses release notes for %s', async (_label, version) => {
    await expect(invoke(OVERLAY_CHANNELS.releaseNotesGet, version)).rejects.toThrow('Not a version of the release index');
  });
});

describe('the pill actions', () => {
  it('runs each action only in a state that offers it', async () => {
    await expect(runUpdateAction('restart', deps)).rejects.toThrow('No update is ready to install');
    await expect(runUpdateAction('releasePage', deps)).rejects.toThrow('No update is available');
    await expect(runUpdateAction('releaseNotes', deps)).rejects.toThrow('No update has release notes');
    await runUpdateAction('showLog', deps);
    state = { kind: 'ready', version: '3.5.0', notes: '' };
    await runUpdateAction('releaseNotes', deps);
    await runUpdateAction('restart', deps);
    state = { kind: 'available', version: '3.5.0', notes: '' };
    await runUpdateAction('releaseNotes', deps);
    await runUpdateAction('releasePage', deps);
    expect(calls).toEqual(['showLog', 'restart', 'releasePage']);
    expect(opened).toEqual([{ section: 'about' }, { section: 'about' }]);
  });

  it('names only the four actions', () => {
    expect(['restart', 'releaseNotes', 'showLog', 'releasePage'].every(isUpdateAction)).toBe(true);
    for (const value of ['install', 'openExternal', '', null, 1, ['restart']]) expect(isUpdateAction(value)).toBe(false);
  });
});
