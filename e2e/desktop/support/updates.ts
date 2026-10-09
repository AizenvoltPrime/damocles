import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { OVERLAY_CHANNELS } from '../../../src/desktop/preload/overlay-channels';
import { SHELL_CHANNELS } from '../../../src/desktop/preload/shell-channels';
import type { UpdateSnapshot, UpdateState } from '../../../src/desktop/preload/updates';
import { LAST_SEEN_VERSION_KEY } from '../../../src/desktop/main/release-notes';
import type { HermeticHome } from './hermetic';
import { OVERLAY_URL, SHELL_URL } from './shell';

// main's global KeyValueState file, where the after-update rule (D56) keeps the version it last saw.
const GLOBAL_STATE = ['state', 'global.json'];

export function snapshotOf(state: UpdateState, lastCheckedAt: number | null = null): UpdateSnapshot {
  const platform = process.platform === 'darwin' || process.platform === 'linux' ? process.platform : 'win32';
  return { state, lastCheckedAt, platform };
}

/**
 * Sends an update state to the title bar (shell) or Settings › About (overlay) on main's own push channel, as main's
 * UpdateService does; the unpackaged app is `disabled` and pushes nothing of its own, so the state stays until replaced.
 */
export async function pushUpdateState(app: ElectronApplication, to: 'shell' | 'overlay', snapshot: UpdateSnapshot): Promise<void> {
  const target = to === 'shell' ? { url: SHELL_URL, channel: SHELL_CHANNELS.updateState } : { url: OVERLAY_URL, channel: OVERLAY_CHANNELS.updateState };
  await app.evaluate(({ webContents }, { url, channel, value }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL() === url);
    if (!contents) throw new Error(`no page at ${url}`);
    contents.send(channel, value);
  }, { ...target, value: snapshot });
}

/** Seeds the version main last saw before a launch, keeping any other global state. */
export function seedLastSeenVersion(home: HermeticHome, version: string): void {
  const file = path.join(home.userData, ...GLOBAL_STATE);
  const state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown> : {};
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...state, [LAST_SEEN_VERSION_KEY]: version }));
}

export function lastSeenVersion(home: HermeticHome): unknown {
  const file = path.join(home.userData, ...GLOBAL_STATE);
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>)[LAST_SEEN_VERSION_KEY] : undefined;
}

/** Records shell.openExternal in main instead of launching the OS browser. */
export async function recordOpenExternal(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ shell }) => {
    const g = globalThis as unknown as { __e2eOpened: string[] };
    g.__e2eOpened = [];
    shell.openExternal = ((url: string) => {
      g.__e2eOpened.push(url);
      return Promise.resolve();
    }) as typeof shell.openExternal;
  });
}

export async function openedExternally(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eOpened: string[] }).__e2eOpened);
}
