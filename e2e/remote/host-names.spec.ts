import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { menuItem, readyOverlay } from '../desktop/support/overlay';
import { groupHeader, LOCAL_GROUP, projectGroup, showView, shownGroupOrder, storedSidebar } from '../desktop/support/projects';
import { holdToast, popupPage, popupToasts, recordToasts, setWindowFocused, shellPage, shellState } from '../desktop/support/shell';
import { projectRow, projectsList, readyShell } from '../desktop/support/shell-ui';
import { answerDialogs, awaitTurnEnd } from '../desktop/support/ui';
import { connectDialog, connectDialogClosed, folderBrowser, hostSearch, openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, control, expect, hostNamed, remoteEnv, remoteHosts, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { DEPLOY_USER } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const badgeOf = (shell: Page, key: string): Locator => projectRow(shell, key).getByTestId('host-badge');
// the shown permission card: one that answered leaves through a transition while the next one enters
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');
const groupName = (shell: Page, group: string): Locator => projectGroup(shell, group).getByTestId('project-group-name');

interface CoreState {
  readonly epoch: string | null;
  readonly phase: 'starting' | 'running' | 'restarting' | 'halted';
  readonly pid: number | null;
}

test('a host added as deploy@<address> and named billing-prod shows that name everywhere, the name rules refuse inline, and a rename on the host card or the group header relabels every place at once', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, DEPLOY_USER);
  try {
    const sshBefore = ssh.mtimes();
    const configBefore = fs.readFileSync(ssh.config, 'utf8');
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    await answerDialogs(app, { 'on billing-prod?': 'Trust Folder' });
    const overlay = await openConnect(app);
    const dialog = connectDialog(overlay);
    await hostSearch(overlay).fill(`ssh -p ${fixture.port} ${DEPLOY_USER}@127.0.0.1`);
    await dialog.getByRole('button', { name: /^Connect to deploy@127\.0\.0\.1/ }).click();
    // the Name view is the dialog under its own name, prefilled from the address
    const naming = overlay.getByRole('dialog', { name: 'Name this host' });
    await expect(naming.getByRole('textbox', { name: 'Name' })).toHaveValue('127.0.0.1');
    await naming.getByRole('textbox', { name: 'Name' }).fill('billing-prod');
    await naming.getByRole('button', { name: 'Connect', exact: true }).click();
    // the browser opens in the account's home, which becomes the project
    const browser = folderBrowser(overlay, 'billing-prod');
    await expect(browser).toBeVisible({ timeout: 120_000 });
    await browser.getByRole('button', { name: 'Open', exact: true }).click();
    await connectDialogClosed(overlay);
    const host = await hostNamed(app, 'billing-prod');
    const key = await remoteProjectKey(app, host, `/home/${DEPLOY_USER}`);
    const shell = await shellPage(app);
    await expect(badgeOf(shell, key)).toContainText('billing-prod');
    // the grouped view heads the host's projects with its name and state
    await showView(shell, 'grouped');
    await expect(groupName(shell, host.authorityKey)).toHaveText('billing-prod');
    await expect(projectGroup(shell, host.authorityKey)).toHaveAccessibleName('billing-prod');
    await expect(groupHeader(shell, host.authorityKey)).toHaveAttribute('aria-label', 'billing-prod, Connected, expanded');
    await showView(shell, 'flat');

    // A second host's name is checked as it is typed and refused on submit, against saved hosts' names and ssh aliases alike;
    // an alias of ~/.ssh/config that is no saved host blocks nothing, so prod-1 is saved first.
    await addHost(app, { alias: 'prod-1', name: 'prod-east' });
    await openConnect(app);
    await hostSearch(overlay).fill(`dev@127.0.0.1:${fixture.port}`);
    await dialog.getByRole('button', { name: /^Connect to dev@127\.0\.0\.1/ }).click();
    const name = naming.getByRole('textbox', { name: 'Name' });
    for (const [value, message] of [
      ['Billing-Prod', 'Another host is already called billing-prod'],
      ['PROD-1', 'Another host is already called prod-1'],
      ['Prod-East', 'Another host is already called prod-east'],
      ['billing\u202Eprod', 'Remove the text direction characters.'],
      ['', 'Enter a name.'],
    ] as const) {
      await name.fill(value);
      await naming.getByRole('button', { name: 'Connect', exact: true }).click();
      await expect(name).toHaveAttribute('aria-invalid', 'true');
      await expect(naming.getByRole('alert')).toHaveText(message);
      await expect(naming).toBeVisible();
    }
    await overlay.keyboard.press('Escape');
    await expect(naming).toHaveCount(0);
    expect((await remoteHosts(app)).map((saved) => saved.name).sort()).toEqual(['billing-prod', 'prod-east']);

    // The host's name on a done notification and on a chat page's permission card.
    const tab = await newRemoteChat(app, key);
    await recordToasts(app);
    await setWindowFocused(app, false);
    await sendPrompt(tab, 'Work while I look away');
    await expect(tab.getByText('Echo: Work while I look away', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    const popup = await popupPage(app);
    const toast = popupToasts(popup).filter({ hasText: 'Finished' });
    await holdToast(app, toast);
    await expect(toast.getByTestId('host-name-badge')).toHaveText('billing-prod');
    await setWindowFocused(app, true);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'printf named-%s ok' } }] }, { chunks: ['Ran it.'] });
    await sendPrompt(tab, 'Run a command');
    const title = permissionCard(tab).getByTestId('permission-title');
    await expect(title).toHaveText('Run this command on billing-prod?');

    // Rename on the host card: the badge, the open card and the held notification follow at once.
    await openConnect(app);
    await dialog.getByRole('button', { name: 'Details for billing-prod' }).click();
    // the card is the dialog's view under the host's own name
    const card = overlay.getByTestId('host-card');
    await card.getByRole('button', { name: 'Rename billing-prod' }).click();
    const field = card.getByRole('textbox', { name: 'Host name' });
    await field.fill('billing-east');
    await field.press('Enter');
    await expect(card.getByRole('heading', { name: 'billing-east', exact: true })).toBeVisible();
    await expect(badgeOf(shell, key)).toContainText('billing-east');
    await expect(title).toHaveText('Run this command on billing-east?');
    await expect(title.getByTestId('host-name-badge')).toHaveText('billing-east');
    await expect(toast.getByTestId('host-name-badge')).toHaveText('billing-east');
    await overlay.keyboard.press('Escape');
    await permissionCard(tab).getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(tab.getByText('Ran it.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);

    // The engine pill names the host by its name: four core kills within the restart budget halt the engine.
    for (let kill = 1; kill <= 4; kill++) {
      const state = (await control(app, host.hostId, 'coreState')) as CoreState;
      expect(state.phase).toBe('running');
      await fixture.sh(`kill -KILL ${state.pid}`);
      if (kill < 4) await expect.poll(async () => { const next = (await control(app, host.hostId, 'coreState')) as CoreState; return next.phase === 'running' && next.epoch !== state.epoch; }, { timeout: 90_000 }).toBe(true);
    }
    await expect.poll(async () => ((await control(app, host.hostId, 'coreState')) as CoreState).phase, { timeout: 60_000 }).toBe('halted');
    await expect(shell.getByTestId('engine-host-pill')).toHaveText('Engine stopped on billing-east');

    // Rename on the group header, inline: the header, the pill, the notification and the badge follow at once.
    await showView(shell, 'grouped');
    await groupHeader(shell, host.authorityKey).click({ button: 'right' });
    await expect(menuItem(overlay, 'rename')).toBeVisible();
    await menuItem(overlay, 'rename').click();
    const inline = projectGroup(shell, host.authorityKey).getByTestId('host-name-input');
    await expect(inline).toBeFocused();
    // a clash is refused on the header too, and Escape puts the old name back
    await inline.fill('Prod-East');
    await inline.press('Enter');
    await expect(projectGroup(shell, host.authorityKey).getByTestId('host-name-error')).toHaveText('Another host is already called prod-east');
    await inline.press('Escape');
    await expect(inline).toHaveCount(0);
    await expect(groupName(shell, host.authorityKey)).toHaveText('billing-east');
    await groupHeader(shell, host.authorityKey).click({ button: 'right' });
    await menuItem(overlay, 'rename').click();
    await inline.fill('billing-west');
    await inline.press('Enter');
    await expect(inline).toHaveCount(0);
    await expect(groupName(shell, host.authorityKey)).toHaveText('billing-west');
    await expect(shell.getByTestId('engine-host-pill')).toHaveText('Engine stopped on billing-west');
    await expect(toast.getByTestId('host-name-badge')).toHaveText('billing-west');
    await showView(shell, 'flat');
    await expect(badgeOf(shell, key)).toContainText('billing-west');
    expect((await remoteHosts(app)).map((saved) => saved.name).sort()).toEqual(['billing-west', 'prod-east']);

    // Damocles wrote nothing under ~/.ssh, its config included.
    expect(ssh.mtimes()).toEqual(sshBefore);
    expect(fs.readFileSync(ssh.config, 'utf8')).toBe(configBefore);
    await shutdownHostDaemon(app, host.hostId, fixture, DEPLOY_USER);
  } finally {
    await stub.close();
  }
});

const SEEDED_HOST = 'h0e2enames';
const SEEDED_GROUP = `ssh+${SEEDED_HOST}`;

// A saved SSH host with one project, which this launch has no reason to connect, beside one local project.
function seedSavedHost(home: { readonly userData: string; readonly project: string }): void {
  fs.writeFileSync(path.join(home.userData, 'projects.json'), `${JSON.stringify({ version: 1, projects: [home.project] }, null, 2)}\n`);
  fs.writeFileSync(path.join(home.userData, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    authorities: { [SEEDED_GROUP]: { projects: [{ path: '/srv/app', folderKey: '/srv/app', os: 'linux' }], trusted: ['/srv/app'] } },
    order: [],
    hosts: { [SEEDED_HOST]: { id: SEEDED_HOST, kind: 'ssh', destination: { kind: 'alias', alias: 'prod-1' }, name: 'prod-1', recentFolders: ['/srv/app'], settings: {} } },
    groupOrder: [],
  }, null, 2));
}

test('a group reorder and a rename made just before quitting are in remote-hosts.json after the relaunch', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh }) => {
  seedSavedHost(home);
  const configBefore = fs.readFileSync(ssh.config, 'utf8');
  const sshBefore = ssh.mtimes();
  const first = await launch({ env: remoteEnv(ssh, mirror) });
  const shell = await readyShell(first.app);
  const overlay = await readyOverlay(first.app);
  await expect(projectsList(shell).locator('[role="option"][data-project-key]')).toHaveCount(2);
  await showView(shell, 'grouped');
  expect(await shownGroupOrder(shell)).toEqual([LOCAL_GROUP, SEEDED_GROUP]);

  // the group header row moves its group with Alt+Up
  await projectsList(shell).focus();
  await shell.keyboard.press('End');
  await shell.keyboard.press('ArrowUp');
  await expect(projectsList(shell)).toHaveAttribute('aria-activedescendant', (await groupHeader(shell, SEEDED_GROUP).getAttribute('id'))!);
  await shell.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => shownGroupOrder(shell)).toEqual([SEEDED_GROUP, LOCAL_GROUP]);
  await groupHeader(shell, SEEDED_GROUP).click({ button: 'right' });
  await menuItem(overlay, 'rename').click();
  const inline = projectGroup(shell, SEEDED_GROUP).getByTestId('host-name-input');
  await inline.fill('prod-renamed');
  await inline.press('Enter');
  await expect(groupName(shell, SEEDED_GROUP)).toHaveText('prod-renamed');
  // the host was never contacted, so nothing but the store changed
  expect((await shellState(first.app)).projects.find((project) => project.authority.kind === 'ssh')?.connection).not.toBe('connected');

  // A rename and a reorder still in flight when the window closes: one renderer pipe orders the three calls, so main has
  // both writes under way when the quit starts, and the quit must land them.
  const flat = (await shellState(first.app)).projects.map((project) => project.key);
  const mainProcess = first.app.process();
  await shell.evaluate(([hostId, order]) => {
    void window.damoclesShell!.renameHost(hostId, 'prod-final');
    void window.damoclesShell!.reorderProjects(order);
    void window.damoclesShell!.windowControl('close');
  }, [SEEDED_HOST, [...flat].reverse()] as const);
  await expect.poll(() => mainProcess.exitCode, { timeout: 30_000 }).not.toBeNull();
  await first.close();

  const stored = JSON.parse(fs.readFileSync(path.join(home.userData, 'remote-hosts.json'), 'utf8')) as { hosts: Record<string, { name: string }> };
  expect(stored.hosts[SEEDED_HOST]?.name).toBe('prod-final');
  expect(storedSidebar(home.userData).groupOrder).toEqual([SEEDED_GROUP, LOCAL_GROUP]);
  expect(storedSidebar(home.userData).order).toEqual([...flat].reverse());
  const second = await launch({ env: remoteEnv(ssh, mirror) });
  const relaunched = await readyShell(second.app);
  await expect(groupName(relaunched, SEEDED_GROUP)).toHaveText('prod-final');
  expect(await shownGroupOrder(relaunched)).toEqual([SEEDED_GROUP, LOCAL_GROUP]);
  expect((await shellState(second.app)).projects.map((project) => project.key)).toEqual([...flat].reverse());
  expect((await remoteHosts(second.app)).map((saved) => saved.name)).toEqual(['prod-final']);
  expect(fs.readFileSync(ssh.config, 'utf8')).toBe(configBefore);
  expect(ssh.mtimes()).toEqual(sshBefore);
});
