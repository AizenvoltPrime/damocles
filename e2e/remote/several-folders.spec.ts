import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { DEFAULT_GRID_LAYOUT } from '../../src/desktop/preload/shell-channels';
import { filesRow, quickPick } from '../desktop/support/editor';
import { chooseMenuItem, menuItem } from '../desktop/support/overlay';
import { dragRow, groupHeader, LOCAL_GROUP, projectGroup, projectsRefusal, showInFiles, showView, shownGroupOrder, shownProjectOrder, storedSidebar } from '../desktop/support/projects';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { clickSectionAction, projectRow } from '../desktop/support/shell-ui';
import { answerDialogs, askedDialogs, clickMenu } from '../desktop/support/ui';
import { connectDialog, folderBrowser, openConnect, openInBrowser } from './support/connect-ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, hostLogs, hostNamed, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';

const OPEN_FOLDER_ON_HOST = 'damocles.remote.openFolderOnHost';
const DISCONNECT_HOST = 'damocles.remote.disconnectHost';
const STAGING_HOST = 'h0e2estaging';
const STAGING_GROUP = `ssh+${STAGING_HOST}`;
// the daemon's line for each client connection it accepts (daemon/connections.ts)
const CLIENT_ATTACHED = /\[daemon\] \S+: client \S+ \(.*\) attached/g;

// One local project, and a saved host staging with one project that nothing in the test connects.
function seed(home: { readonly userData: string; readonly project: string }): void {
  fs.writeFileSync(path.join(home.userData, 'projects.json'), `${JSON.stringify({ version: 1, projects: [home.project] }, null, 2)}\n`);
  fs.writeFileSync(path.join(home.userData, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    authorities: { [STAGING_GROUP]: { projects: [{ path: '/srv/web', folderKey: '/srv/web', os: 'linux' }], trusted: ['/srv/web'] } },
    order: [],
    hosts: { [STAGING_HOST]: { id: STAGING_HOST, kind: 'ssh', destination: { kind: 'alias', alias: 'staging' }, name: 'staging', recentFolders: ['/srv/web'], settings: {} } },
    groupOrder: [],
  }, null, 2));
  // every grouped row in view at once, so a drag from one group to another needs no scrolling
  const collapsed = { collapsed: true, size: 200 };
  fs.writeFileSync(path.join(home.userData, 'window-layout.json'), JSON.stringify({
    version: 2,
    sidebar: {
      sidebarVisible: true,
      sidebarWidth: 264,
      sections: { projects: { collapsed: false, size: 400 }, chats: { collapsed: false }, files: { collapsed: false, size: 200 }, search: collapsed, repos: collapsed, scm: collapsed, graph: collapsed },
      grid: DEFAULT_GRID_LAYOUT,
    },
  }));
}

/** Waits for prod-1's folder browser, which every entry point opens, and closes it with Escape. */
async function browserReached(overlay: Page): Promise<void> {
  const browser = folderBrowser(overlay, 'prod-1');
  await expect(browser).toBeVisible({ timeout: 60_000 });
  // the host's recent folders are listed first
  await expect(browser.getByText('/srv/billing').first()).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(browser).toHaveCount(0);
}

test('two folders on prod-1 share one connection, every entry point reaches its folder browser, Open as project adds after its parent, grouped drags persist, a cross-host drop is refused, and a disconnect takes both offline', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  seed(home);
  const fixture = await sshd('prod-1');
  await fixture.sh('mkdir -p /srv/billing /srv/app/src/packages/api && printf "export {};\\n" > /srv/app/src/packages/api/index.ts && chown -R dev:dev /srv/billing /srv/app');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const appKey = await openRemoteFolder(app, hostId, '/srv/app');
  const host = await hostNamed(app, 'prod-1');
  const prodGroup = host.authorityKey;
  await remoteProjectKey(app, host, '/srv/app');
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);

  // The host card's button opens the browser on prod-1, where /srv/billing becomes the second project.
  await openConnect(app);
  await connectDialog(overlay).getByRole('button', { name: 'Details for prod-1' }).click();
  await overlay.getByTestId('host-card').getByTestId('host-card-open-folder').click();
  await openInBrowser(overlay, 'prod-1', '/srv/billing');
  const billingKey = await remoteProjectKey(app, host, '/srv/billing');
  expect((await shellState(app)).projects.find((project) => project.key === appKey)?.connection).toBe('connected');
  // one connection: the daemon accepted one client connection, and one daemon runs
  expect([...(await hostLogs(app, hostId)).daemon.matchAll(CLIENT_ATTACHED)]).toHaveLength(1);
  expect(await daemonPids(fixture)).toHaveLength(1);

  // The project's right-click menu.
  await projectRow(shell, appKey).click({ button: 'right' });
  await expect(menuItem(overlay, 'openFolder')).toHaveText(/Open another folder on prod-1\.\.\./);
  await chooseMenuItem(app, 'openFolder');
  await browserReached(overlay);
  // The Projects add menu's entry for the host.
  await clickSectionAction(shell, 'add-project');
  await overlay.getByRole('menu').getByRole('menuitem', { name: 'Folder on prod-1...' }).click();
  await browserReached(overlay);
  // The palette, which asks for the host first.
  // showCommands settles only once the palette closes, so the page does not wait for it
  await shell.evaluate(() => { void window.damoclesShell!.showCommands(); });
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill('>Remote: Open Folder on Host');
  await overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${OPEN_FOLDER_ON_HOST}"]`).click();
  await overlay.getByTestId('quick-pick-item').filter({ hasText: 'prod-1' }).click();
  await browserReached(overlay);
  // The group header's context menu.
  await showView(shell, 'grouped');
  await groupHeader(shell, prodGroup).click({ button: 'right' });
  await expect(menuItem(overlay, 'openFolder')).toHaveText(/Open folder on prod-1\.\.\./);
  await chooseMenuItem(app, 'openFolder');
  await browserReached(overlay);
  expect([...(await hostLogs(app, hostId)).daemon.matchAll(CLIENT_ATTACHED)]).toHaveLength(1);

  // Files Open as project on prod-1: the trust question, then the subfolder right after /srv/app, selected.
  await projectRow(shell, appKey).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(appKey);
  await showInFiles(shell, 'src/packages/api');
  await filesRow(shell, 'src/packages/api').click({ button: 'right' });
  await chooseMenuItem(app, 'openAsProject');
  const apiKey = await remoteProjectKey(app, host, '/srv/app/src/packages/api');
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(apiKey);
  const order = (await shellState(app)).projects.map((project) => project.key);
  expect(order.indexOf(apiKey)).toBe(order.indexOf(appKey) + 1);
  expect((await askedDialogs(app)).filter((dialog) => dialog.message.includes('/srv/app/src/packages/api') && dialog.message.endsWith('on prod-1?'))).toHaveLength(1);

  // Grouped: prod-1's group above This computer, and app below billing.
  await dragRow(shell, groupHeader(shell, prodGroup), projectGroup(shell, LOCAL_GROUP), 'above', projectGroup(shell, prodGroup));
  await expect.poll(() => shownGroupOrder(shell)).toEqual([prodGroup, LOCAL_GROUP, STAGING_GROUP]);
  expect(storedSidebar(home.userData).groupOrder).toEqual([prodGroup, LOCAL_GROUP, STAGING_GROUP]);
  await dragRow(shell, projectRow(shell, appKey), projectRow(shell, billingKey), 'below');
  const prodRows = async (): Promise<string[]> => (await shownProjectOrder(shell)).filter((key) => [appKey, apiKey, billingKey].includes(key));
  await expect.poll(prodRows).toEqual([apiKey, billingKey, appKey]);
  const stored = storedSidebar(home.userData).order;
  expect(stored.indexOf(billingKey)).toBeLessThan(stored.indexOf(appKey));

  // A project dropped on another host's group slides back, and the alert under the list says why.
  const before = await shownProjectOrder(shell);
  const webKey = `${STAGING_GROUP}|/srv/web`;
  await dragRow(shell, projectRow(shell, billingKey), projectRow(shell, webKey), 'above');
  await expect(projectsRefusal(shell)).toHaveText(/billing is on prod-1\. Open a folder on staging instead\?/);
  await expect(projectsRefusal(shell)).toHaveAttribute('role', 'alert');
  expect(await shownProjectOrder(shell)).toEqual(before);
  expect(storedSidebar(home.userData).order).toEqual(stored);

  // Flat keeps the one order: billing before app.
  await showView(shell, 'flat');
  const flat = await shownProjectOrder(shell);
  expect(flat.indexOf(billingKey)).toBeLessThan(flat.indexOf(appKey));

  // Disconnect Host on the selected prod-1 project takes all of its projects offline at once.
  await clickMenu(app, DISCONNECT_HOST);
  const prodConnections = async (): Promise<string[]> => (await shellState(app)).projects.filter((project) => project.authority.key === prodGroup).map((project) => project.connection);
  await expect.poll(prodConnections).toEqual(['offline', 'offline', 'offline']);
  await shell.evaluate((id) => window.damoclesShell!.reconnectHost(id), hostId);
  await expect.poll(prodConnections, { timeout: 120_000 }).toEqual(['connected', 'connected', 'connected']);
  await shutdownHostDaemon(app, hostId, fixture);
});
