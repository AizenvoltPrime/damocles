import type { ElectronApplication, Page } from '@playwright/test';
import { OVERLAY_CHANNELS } from '../../src/desktop/preload/overlay-channels';
import { mainLog } from '../desktop/support/app';
import { IPC_HANDLER_ERROR_ANNOTATION } from '../desktop/support/fixtures';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { closeSettingsModal, markElement, openSettingsModal } from '../desktop/support/settings';
import { shellPage, shellState } from '../desktop/support/shell';
import { clickMenu } from '../desktop/support/ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { addHost, control, openRemoteFolder, remoteEnv, SSH_TAG } from './support/remote';
import { newRemoteChat } from './support/target-agent';

const APP = '/srv/app';

interface ConnectionHooks {
  __damoclesE2e: { remote: { dropConnection(hostId: string): void; cutTransport(hostId: string, options: { hold: boolean }): void; releaseTransport(hostId: string): void; reconnectNow(authorityKey: string): void } };
}

// Closes the host's connection, so the next one attaches fresh, and fails every reconnect until releaseHost; one evaluate, so no
// attempt runs in between.
const dropHost = (app: ElectronApplication, hostId: string): Promise<void> => app.evaluate((_electron, id) => {
  const remote = (globalThis as unknown as ConnectionHooks).__damoclesE2e.remote;
  remote.dropConnection(id);
  remote.cutTransport(id, { hold: true });
}, hostId);
const releaseHost = (app: ElectronApplication, hostId: string): Promise<void> => app.evaluate((_electron, id) => {
  const remote = (globalThis as unknown as ConnectionHooks).__damoclesE2e.remote;
  remote.releaseTransport(id);
  remote.reconnectNow(`ssh+${id}`);
}, hostId);
// Lets the next attempt through without starting one, for a host the user disconnected and reconnects.
const releaseTransport = (app: ElectronApplication, hostId: string): Promise<void> => app.evaluate((_electron, id) => {
  (globalThis as unknown as ConnectionHooks).__damoclesE2e.remote.releaseTransport(id);
}, hostId);
const DISCONNECT_HOST = 'damocles.remote.disconnectHost';

interface CoreState {
  readonly phase: 'starting' | 'running' | 'restarting' | 'halted';
  readonly pid: number | null;
}

// Records each state the waiting tab's banner shows from now on, 'none' while it shows none.
const recordAwayStates = (overlay: Page): Promise<void> => overlay.evaluate(() => {
  const seen: string[] = [];
  (window as unknown as { e2eAwayStates: string[] }).e2eAwayStates = seen;
  const record = (): void => {
    const state = document.querySelector('[data-testid="settings-scope-away"]')?.getAttribute('data-state') ?? 'none';
    if (seen.at(-1) !== state) seen.push(state);
  };
  new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-state'] });
  record();
});
const awayStates = (overlay: Page): Promise<string[]> => overlay.evaluate(() => (window as unknown as { e2eAwayStates: string[] }).e2eAwayStates);

// A tab is loaded once the remote core answered it: its banner replaces the loading line.
async function expectTabLoaded(overlay: Page, tab: 'host' | 'project'): Promise<void> {
  await expect(overlay.getByTestId(`settings-scope-${tab}`)).toHaveAttribute('aria-selected', 'true');
  await expect(overlay.getByTestId('settings-scope-loading')).toHaveCount(0);
  // the banner names the file the tab writes: the host's own, or the project's
  await expect(overlay.getByTestId('settings-scope-banner')).toContainText(tab === 'host' ? '~/.damocles/settings.json' : `${APP}/.damocles/settings.json`);
}

test('a remote chat\'s settings load on the host tab, the Project tab and the host tab again', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await newRemoteChat(app, key);

  const overlay = await openSettingsModal(app, 'defaults');
  await expectTabLoaded(overlay, 'host');
  // each switch attaches over the wire; what the modal asks meanwhile must reach the tab it asked for
  for (const tab of ['project', 'host', 'project', 'host'] as const) {
    await overlay.getByTestId(`settings-scope-${tab}`).click();
    await expectTabLoaded(overlay, tab);
  }
  await closeSettingsModal(overlay);

  await shutdownHostDaemon(app, hostId, fixture);
});

// A drop of an SSH host resumes inside the daemon's grace, so the tab stays attached to the same core and its page stays mounted.
test("a host's drop and resume while the Project tab shows keeps the page", { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(300_000);
  const target = await proxied('prod-1');
  await target.fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await newRemoteChat(app, key);

  const overlay = await openSettingsModal(app, 'defaults');
  await expectTabLoaded(overlay, 'host');
  await overlay.getByTestId('settings-scope-project').click();
  await expectTabLoaded(overlay, 'project');
  const banner = overlay.getByTestId('settings-scope-banner');
  await markElement(banner);

  target.proxy.cut();
  await expect.poll(() => mainLog(home), { timeout: 60_000 }).toContain(`[remote] ssh+${hostId}: resumed inside the grace`);
  await expectTabLoaded(overlay, 'project');
  await expect(banner).toHaveAttribute('data-e2e-kept', '');
  await closeSettingsModal(overlay);

  await shutdownHostDaemon(app, hostId, target.fixture);
});

// Past a drop the next connection attaches fresh, here to a daemon that restarted meanwhile, so the old core's chats close.
test("a host's daemon restart while the Project tab shows keeps that tab, inert under a reconnecting banner, until the host is back", { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await newRemoteChat(app, key);

  const overlay = await openSettingsModal(app, 'defaults');
  await expectTabLoaded(overlay, 'host');
  await overlay.getByTestId('settings-scope-project').click();
  await expectTabLoaded(overlay, 'project');
  const banner = overlay.getByTestId('settings-scope-banner');
  await markElement(banner);

  await dropHost(app, hostId);
  const [pid] = await daemonPids(fixture);
  await fixture.sh(`kill -KILL ${pid}`);
  await expect.poll(() => daemonPids(fixture), { timeout: 30_000 }).not.toContain(pid);
  const away = overlay.getByTestId('settings-scope-away');
  await expect(away).toHaveAttribute('data-state', 'reconnecting', { timeout: 60_000 });
  await expect(away).toHaveText('Reconnecting to prod-1…');
  await expect(overlay.getByTestId('settings-scope-project')).toHaveAttribute('aria-selected', 'true');
  const content = overlay.getByTestId('settings-content');
  await expect(content).toHaveAttribute('inert', '');
  await expect(content).toHaveAttribute('aria-busy', 'true');
  await expect(banner).toHaveAttribute('data-e2e-kept', '');

  await releaseHost(app, hostId);
  await expect(away).toHaveCount(0, { timeout: 120_000 });
  await expectTabLoaded(overlay, 'project');
  await expect(content).not.toHaveAttribute('inert');
  // the same tab of the same project: the page stayed mounted
  await expect(banner).toHaveAttribute('data-e2e-kept', '');
  await closeSettingsModal(overlay);

  await shutdownHostDaemon(app, hostId, fixture);
});

// A new chat with no conversation that holds a message reopens in a new view after a fresh attach, named by its page's token;
// the host tab lists This chat rows, so its page stays only when that token names the chat.
test("a new remote chat holding a message keeps its host tab's page when a daemon restart reopens it in a new view", { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, proxied }) => {
  test.setTimeout(300_000);
  const target = await proxied('prod-1');
  await target.fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  const chat = await newRemoteChat(app, key);

  const overlay = await openSettingsModal(app, 'defaults');
  await expectTabLoaded(overlay, 'host');
  const banner = overlay.getByTestId('settings-scope-banner');
  await markElement(banner);

  // inside the grace the chat page stays and holds what is sent, which keeps the chat with no conversation in remote-state.json
  target.proxy.refuse();
  await expect(chat.getByTestId('chat-connection-banner')).toBeVisible({ timeout: 30_000 });
  await sendPrompt(chat, 'Held for the host');
  await expect(chat.getByTestId('held-message')).toHaveCount(1);
  // the daemon restarts meanwhile, so the next connection attaches fresh and the chat closes with the old core
  const [pid] = await daemonPids(target.fixture);
  await target.fixture.sh(`kill -KILL ${pid}`);
  await expect.poll(() => daemonPids(target.fixture), { timeout: 30_000 }).not.toContain(pid);
  target.proxy.restore();
  await expect.poll(() => chat.isClosed(), { timeout: 120_000 }).toBe(true);

  const away = overlay.getByTestId('settings-scope-away');
  await expect(away).toHaveCount(0, { timeout: 120_000 });
  await expectTabLoaded(overlay, 'host');
  // the reopened chat's new view: the same chat, so the page stayed mounted
  await expect(banner).toHaveAttribute('data-e2e-kept', '');
  await closeSettingsModal(overlay);

  await shutdownHostDaemon(app, hostId, target.fixture);
});

// The daemon restarts the engine on a live connection. The old core is stopped first, so the daemon's restart waits on its
// exit and the restart lasts until the test continues it.
test("an engine restart on a live connection while the Project tab shows keeps that tab, inert under a restarting banner, until the new core is ready", { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await newRemoteChat(app, key);

  const overlay = await openSettingsModal(app, 'defaults');
  await expectTabLoaded(overlay, 'host');
  await overlay.getByTestId('settings-scope-project').click();
  await expectTabLoaded(overlay, 'project');
  const banner = overlay.getByTestId('settings-scope-banner');
  await markElement(banner);

  const { pid } = (await control(app, hostId, 'coreState')) as CoreState;
  expect(pid).not.toBeNull();
  await recordAwayStates(overlay);
  await fixture.sh(`kill -STOP ${pid}`);
  await control(app, hostId, 'restartCore');
  const away = overlay.getByTestId('settings-scope-away');
  await expect(away).toHaveAttribute('data-state', 'restarting', { timeout: 30_000 });
  await expect(away).toHaveText('Restarting the engine on prod-1');
  await expect(overlay.getByTestId('settings-scope-project')).toHaveAttribute('aria-selected', 'true');
  const content = overlay.getByTestId('settings-content');
  await expect(content).toHaveAttribute('inert', '');
  await expect(content).toHaveAttribute('aria-busy', 'true');
  // a tab clicked meanwhile is refused at once rather than held until the restart is over
  test.info().annotations.push({ type: IPC_HANDLER_ERROR_ANNOTATION, description: OVERLAY_CHANNELS.settingsScope });
  await overlay.getByTestId('settings-scope-host').click();
  await expect(overlay.getByTestId('settings-scope-failed')).toHaveText('The prod-1 settings could not be opened.', { timeout: 10_000 });
  await expect(overlay.getByTestId('settings-scope-project')).toHaveAttribute('aria-selected', 'true');
  await expect(away).toHaveAttribute('data-state', 'restarting');
  await expect(banner).toHaveAttribute('data-e2e-kept', '');

  await fixture.sh(`kill -CONT ${pid}`);
  await expect(away).toHaveCount(0, { timeout: 120_000 });
  await expectTabLoaded(overlay, 'project');
  await expect(content).not.toHaveAttribute('inert');
  await expect(banner).toHaveAttribute('data-e2e-kept', '');
  await expect(overlay.getByTestId('settings-scope-failed')).toHaveText('');
  // the connection never dropped, so the banner never said reconnecting, not even while the new core attached
  expect(await awayStates(overlay)).toEqual(['none', 'restarting', 'none']);
  await closeSettingsModal(overlay);

  await shutdownHostDaemon(app, hostId, fixture);
});

// Disconnect Host ends the wait as offline: nothing reconnects the host until the user does, which resumes the tab.
test("a host disconnected while the Project tab waits shows it offline, a reconnect resumes the tab, and Show User settings opens the User tab with the remote chat's project still selected", { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await newRemoteChat(app, key);
  const shell = await shellPage(app);
  const connection = async (): Promise<string | undefined> => (await shellState(app)).projects.find((project) => project.key === key)?.connection;

  const overlay = await openSettingsModal(app, 'defaults');
  await expectTabLoaded(overlay, 'host');
  await overlay.getByTestId('settings-scope-project').click();
  await expectTabLoaded(overlay, 'project');
  const away = overlay.getByTestId('settings-scope-away');
  const showUser = overlay.getByTestId('settings-scope-away-user');

  await dropHost(app, hostId);
  await expect(away).toHaveAttribute('data-state', 'reconnecting', { timeout: 60_000 });
  await expect(showUser).toHaveCount(0);
  await clickMenu(app, DISCONNECT_HOST);
  await expect(away).toHaveAttribute('data-state', 'offline');
  await expect(overlay.getByTestId('settings-scope-away-text')).toHaveText('prod-1 is offline.');
  await expect(showUser).toHaveText('Show User settings');
  await expect(overlay.getByTestId('settings-scope-project')).toHaveAttribute('aria-selected', 'true');
  await expect(overlay.getByTestId('settings-content')).toHaveAttribute('inert', '');

  await releaseTransport(app, hostId);
  await shell.evaluate((id) => window.damoclesShell!.reconnectHost(id), hostId);
  await expect(away).toHaveCount(0, { timeout: 120_000 });
  await expectTabLoaded(overlay, 'project');
  await expect(overlay.getByTestId('settings-content')).not.toHaveAttribute('inert');

  await clickMenu(app, DISCONNECT_HOST);
  await expect(away).toHaveAttribute('data-state', 'offline', { timeout: 60_000 });
  await showUser.click();
  await expect(overlay.getByTestId('settings-scope-user')).toHaveAttribute('aria-selected', 'true');
  await expect(overlay.getByTestId('settings-scope-user')).toBeFocused();
  await expect(away).toHaveCount(0);
  // the User tab's chat stays hidden: the remote chat's project is still the one selected
  expect((await shellState(app)).selected.projectKey).toBe(key);
  await closeSettingsModal(overlay);

  await shell.evaluate((id) => window.damoclesShell!.reconnectHost(id), hostId);
  await expect.poll(connection, { timeout: 120_000 }).toBe('connected');
  await shutdownHostDaemon(app, hostId, fixture);
});
