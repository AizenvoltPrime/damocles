import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { LINUX_TARGET, serverPackage } from './support/release-mirror';
import { expectNoAxeViolations } from '../desktop/support/axe';
import { quickPick } from '../desktop/support/editor';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { projectRow } from '../desktop/support/shell-ui';
import { answerDialogs } from '../desktop/support/ui';
import { announcedSteps, browseTo, connectDialog, connectDialogClosed, CONNECT_TO_HOST_MENU, folderBrowser, hostCard, hostSearch, installPercents, openConnect, openInBrowser, recordTimeline, STEP_LABELS, stepOrder, stepRow, timeline, trustQuestion } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, hostNamed, lastConnectStep, openRemoteFolder, PACKAGED_TAG, remoteEnv, remoteHosts, remoteProjectKey, SSH_TAG, test } from './support/remote';

const badgeOf = (shell: Page, key: string): Locator => projectRow(shell, key).getByTestId('host-badge');

test('Connect to Host lists the ssh config hosts, shows every step with the download progress, and opens /srv/app as a project with the host badge', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  await fixture.sh('mkdir -p /srv/app/src && printf "# App\\n" > /srv/app/README.md', 'dev');
  const before = ssh.mtimes();
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });

  const overlay = await openConnect(app);
  await expect(hostCard(overlay, 'prod-1')).toBeVisible();
  await recordTimeline(overlay);
  // the stage reports the download's progress once a second, so a download held halfway shows it however fast the link is
  const held = mirror.holdDownloads();
  await hostCard(overlay, 'prod-1').click();
  await held.reached;
  await expect(timeline(overlay, 'prod-1')).toHaveAttribute('aria-valuetext', /^Installing, ([1-9]|[1-9]\d)%$/, { timeout: 60_000 });
  held.release();
  const browser = await browseTo(overlay, 'prod-1', '/srv/app');
  await browser.getByRole('button', { name: 'Open', exact: true }).click();
  // The trust question stacks over the Connect dialog and takes the keyboard and a real pointer press there; a press that
  // reached the dialog beneath would close it.
  const question = trustQuestion(overlay, '/srv/app', 'prod-1');
  await expect(question.getByRole('button', { name: 'Don\'t Trust' })).toBeFocused();
  await overlay.keyboard.press('Tab');
  await expect(question.getByRole('button', { name: 'Trust Folder' })).toBeFocused();
  await question.getByRole('button', { name: 'Trust Folder' }).click();
  await connectDialogClosed(overlay);

  // Every step in order, as main reports it to the timeline's rows, and the download's progress while Installing; the target
  // downloaded its package once. A step that passes between two frames never reaches the progressbar's text, so what it
  // announced is checked for order only.
  const host = await hostNamed(app, 'prod-1');
  expect((await lastConnectStep(app, host.hostId))?.visited).toEqual(Object.keys(STEP_LABELS));
  const announced = await announcedSteps(overlay);
  const order = stepOrder(announced);
  expect(order).toEqual(Object.values(STEP_LABELS).filter((label) => order.includes(label)));
  const percents = installPercents(announced);
  expect(percents.length).toBeGreaterThan(0);
  expect(percents).toEqual([...percents].sort((a, b) => a - b));
  expect(mirror.downloads).toEqual([serverPackage(LINUX_TARGET)]);

  const key = await remoteProjectKey(app, host, '/srv/app');
  const shell = await shellPage(app);
  await expect(badgeOf(shell, key)).toContainText('prod-1');
  await expect(badgeOf(shell, key).getByRole('img', { name: 'prod-1, Connected' })).toHaveAttribute('data-connection', 'connected');
  // selected once the trust question is answered
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(key);
  // Damocles changed nothing under ~/.ssh: ssh found the host key it already had.
  expect(ssh.mtimes()).toEqual(before);
  await shutdownHostDaemon(app, host.hostId, fixture);
});

test('a host whose ssh config sets RemoteCommand and RequestTTY yes still connects', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-tty', { config: ['RemoteCommand exec bash -l', 'RequestTTY yes'] });
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-tty', name: 'prod-tty' });
  const key = await openRemoteFolder(app, hostId, '/srv/app');
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === key)?.connection).toBe('connected');
  await shutdownHostDaemon(app, hostId, fixture);
});

test('a pasted ssh command is refused naming its option, and a -J hop is accepted and shown as written', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  await sshd('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const overlay = await openConnect(app);
  const dialog = connectDialog(overlay);
  for (const [input, option] of [
    ['ssh -o ProxyCommand="nc %h %p" deploy@10.0.0.9', 'ProxyCommand'],
    ['ssh -F /tmp/other-config deploy@10.0.0.9', '-F'],
    ['ssh -o StrictHostKeyChecking=no deploy@10.0.0.9', 'StrictHostKeyChecking=no'],
  ] as const) {
    await hostSearch(overlay).fill(input);
    await expect(dialog.getByRole('alert')).toHaveText(`${option} is not allowed. Damocles passes only -l, -p, -i, -J, -4, -6, -C and allowed -o options to ssh.`);
    await expect(dialog.getByRole('button', { name: /^Connect to / })).toHaveCount(0);
  }
  await hostSearch(overlay).fill('ssh -J bastion.example.com -p 2222 deploy@10.0.0.9');
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  // the hop's value exactly as written, under the option it sets
  await expect(dialog.getByRole('list', { name: 'Parsed options' }).getByRole('listitem')).toHaveText(['ProxyJump bastion.example.com']);
  await expect(dialog.getByRole('button', { name: /^Connect to deploy@10\.0\.0\.9/ })).toBeVisible();
  // nothing was saved while typing
  expect(await remoteHosts(app)).toEqual([]);
});

test('the Connect dialog, the step timeline and the folder browser pass an axe scan', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });
  const overlay = await openConnect(app);
  await expect(hostCard(overlay, 'prod-1')).toBeVisible();
  await expectNoAxeViolations(overlay, '[role="dialog"]');
  await hostSearch(overlay).fill('deploy@10.0.0.9');
  await expect(connectDialog(overlay).getByRole('button', { name: /^Connect to deploy@10\.0\.0\.9/ })).toBeVisible();
  await expectNoAxeViolations(overlay, '[role="dialog"]');
  await hostSearch(overlay).fill('');
  // the download held halfway keeps the timeline at Installing with its progress, so the scan sees a step active
  const held = mirror.holdDownloads();
  await hostCard(overlay, 'prod-1').click();
  await held.reached;
  await expect(timeline(overlay, 'prod-1')).toHaveAttribute('aria-valuetext', /^Installing, ([1-9]|[1-9]\d)%$/, { timeout: 60_000 });
  await expect(stepRow(overlay, 'installing')).toHaveAttribute('data-state', 'active');
  await expectNoAxeViolations(overlay, '[role="dialog"]');
  held.release();
  await expect(folderBrowser(overlay, 'prod-1')).toBeVisible({ timeout: 120_000 });
  await expectNoAxeViolations(overlay, '[role="dialog"]');
  await openInBrowser(overlay, 'prod-1', '/srv/app');
  const host = await hostNamed(app, 'prod-1');
  await remoteProjectKey(app, host, '/srv/app');
  await shutdownHostDaemon(app, host.hostId, fixture);
});

// A saved SSH host with one project: what a user who connected before has in remote-hosts.json.
function seedRemoteProject(userData: string): void {
  const hostId = 'h0e2esaved';
  fs.writeFileSync(path.join(userData, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    authorities: { [`ssh+${hostId}`]: { projects: [{ path: '/srv/app', folderKey: '/srv/app', os: 'linux' }], trusted: ['/srv/app'] } },
    order: [`ssh+${hostId}|/srv/app`],
    hosts: { [hostId]: { id: hostId, kind: 'ssh', destination: { kind: 'alias', alias: 'saved-host' }, name: 'saved-host', recentFolders: ['/srv/app'], settings: {} } },
    groupOrder: [],
  }, null, 2));
}

test('a remote project saved in remote-hosts.json is restored in a development build', { tag: SSH_TAG }, async ({ home, launch, mirror, ssh }) => {
  seedRemoteProject(home.userData);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await expect.poll(async () => (await shellState(app)).projects.filter((project) => project.authority.kind === 'ssh').map((project) => project.fsPath)).toEqual(['/srv/app']);
});

test('a packaged build with no extra environment shows Connect to Host, Remote folder... and the saved remote project', { tag: PACKAGED_TAG }, async ({ home, launch }) => {
  seedRemoteProject(home.userData);
  fs.writeFileSync(path.join(home.userData, 'projects.json'), `${JSON.stringify({ version: 1, projects: [home.project] }, null, 2)}\n`);
  const { app } = await launch();
  const shell = await shellPage(app);
  await expect.poll(() => shell.evaluate(async () => (await window.damoclesShell!.getState()).projects.map((project) => project.fsPath).sort())).toEqual([home.project, '/srv/app'].sort());
  const state = await shell.evaluate(() => window.damoclesShell!.getState());
  expect(state.hosts.map((host) => host.name)).toEqual(['saved-host']);
  // The Projects add button opens its menu, which holds Remote folder... and the saved host.
  const overlay = await overlayPage(app);
  const add = shell.getByTestId('add-project');
  await expect(add).toHaveAttribute('aria-haspopup', 'menu');
  // Show All Commands lists Connect to Host.
  // showCommands settles only once the palette closes, so the page does not wait for it
  await shell.evaluate(() => { void window.damoclesShell!.showCommands(); });
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill('>connect to host');
  await expect(overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${CONNECT_TO_HOST_MENU}"]`)).toHaveCount(1);
  // closed before the quit, which would otherwise end the palette's request with the window
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);
});
