import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { PortsView } from '../../src/desktop/preload/ports-channels';
import { browserTabs, chromeEnv, PAGE_TIMEOUT } from '../desktop/support/browser';
import { writeUserSettings } from '../desktop/support/hermetic';
import { overlayPage, recordedPopupToasts, recordToasts, shellPage } from '../desktop/support/shell';
import { openTerminal, runInTerminal, waitForOutputLine } from '../desktop/support/terminal';
import { connectDialog, openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { storedHost } from './support/host-settings-ui';
import { expectPortsSectionAccessible, portMapping, portRow } from './support/ports-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import type { SshdFixture } from './support/sshd';
import { newRemoteChat } from './support/target-agent';

const APP = '/srv/app';

// A process outside Damocles, as the target's user: python3 listening on each port until killed.
const LISTENER = ['import socket, sys, time', 'held = []', 'for port in sys.argv[1:]:', '    s = socket.socket()', '    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)', "    s.bind(('0.0.0.0', int(port)))", '    s.listen()', '    held.append(s)', 'time.sleep(3600)', ''].join('\n');

async function listenOnTarget(fixture: SshdFixture, ports: readonly number[]): Promise<void> {
  await fixture.sh(`cat > /tmp/listen.py && (setsid python3 /tmp/listen.py ${ports.join(' ')} > /dev/null 2>&1 &)`, 'dev', LISTENER);
}

// a web server outside Damocles, as the target's user, so a page opened on its forward loads
async function webServerOnTarget(fixture: SshdFixture, port: number): Promise<void> {
  await fixture.sh(`cd ${APP} && (setsid python3 -m http.server ${port} > /dev/null 2>&1 &)`, 'dev');
}

async function stopTargetListeners(fixture: SshdFixture): Promise<void> {
  await fixture.sh('pkill -u dev -f python3; true', 'root');
}

const portsView = (shell: Page, hostId: string): Promise<PortsView | null> => shell.evaluate((id) => window.damoclesShell!.ports.get(id), hostId);

async function row(shell: Page, hostId: string, remotePort: number): Promise<PortsView['rows'][number] | undefined> {
  return (await portsView(shell, hostId))?.rows.find((candidate) => candidate.remotePort === remotePort);
}

const holdLocalPort = (port: number, host = '127.0.0.1'): Promise<net.Server> => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(port, host, () => resolve(server));
});

const closeServer = (server: net.Server): Promise<void> => new Promise((resolve) => server.close(() => resolve()));

async function connectRemote(app: ElectronApplication, hostId: string): Promise<{ key: string; shell: Page }> {
  await openRemoteFolder(app, hostId, APP);
  const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  return { key, shell };
}

// a row shows its actions while the pointer rests on it
async function clickRowAction(shell: Page, port: number, action: string): Promise<void> {
  await portRow(shell, port).hover();
  await portRow(shell, port).getByTestId(action).click();
}

const bodyOf = async (port: number): Promise<string> => (await fetch(`http://127.0.0.1:${port}/`)).text();

test('a server started in a remote terminal is listed and forwarded within 3 s and Open in pane shows it; a port another process of the user opens forwards too; a taken local port maps to the next, a reserved one elsewhere; Stop forwarding closes the listener and its connections', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never', 'damocles.browser.enabled': true });
  const fixture = await sshd('prod-1');
  // this computer's own server on 5173, as another project's dev server would be
  const local5173 = await holdLocalPort(5173);
  try {
    const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), ...chromeEnv() } });
    await recordToasts(app);
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const { key, shell } = await connectRemote(app, hostId);
    await newRemoteChat(app, key);

    await openTerminal(app);
    await runInTerminal(shell, 'cd /srv/app && echo ported > index.html && python3 -m http.server 8000');
    await waitForOutputLine(shell, 'Serving HTTP on 0.0.0.0 port 8000 (http://0.0.0.0:8000/) ...');
    await expect(portRow(shell, 8000)).toHaveAttribute('data-state', 'forwarded', { timeout: 3_000 });
    await expect(portMapping(portRow(shell, 8000))).toContainText('localhost:8000');
    expect(await row(shell, hostId, 8000)).toMatchObject({ localPort: 8000, processLabel: 'python3 (python3 -m http.server 8000)', origin: 'output' });
    expect(await bodyOf(8000)).toBe('ported\n');
    await expect.poll(async () => (await recordedPopupToasts(app)).some((toast) => toast.body.kind === 'notice' && toast.body.title === 'Port 8000 is available' && toast.body.host === 'prod-1')).toBe(true);

    // Open in pane: a page tab of the selected chat at the forward's address
    await clickRowAction(shell, 8000, 'port-open-pane');
    await expect.poll(async () => (await browserTabs(app)).map((tab) => [tab.browser.url, tab.browser.forwardedFrom?.targetUrl]), { timeout: PAGE_TIMEOUT }).toContainEqual(['http://localhost:8000/', 'http://localhost:8000/']);
    await expect(shell.getByTestId('browser-forwarded-from')).toContainText('prod-1:8000');

    // a listener of the user that Damocles did not start; 5173 is taken here and 1455 is ChatGPT's sign-in port
    await listenOnTarget(fixture, [8001, 5173, 1455]);
    await expect.poll(async () => (await row(shell, hostId, 8001))?.state, { timeout: 15_000 }).toBe('forwarded');
    await expect.poll(async () => (await row(shell, hostId, 5173))?.localPort, { timeout: 15_000 }).toBe(5174);
    await expect(portMapping(portRow(shell, 5173))).toContainText('localhost:5174');
    const reserved = await row(shell, hostId, 1455);
    expect(reserved?.state).toBe('forwarded');
    expect(reserved?.localPort).not.toBe(1455);
    expect(reserved?.localPort).not.toBe(1456);
    // a ChatGPT sign-in on this computer still binds its callback port
    await closeServer(await holdLocalPort(1455));
    await expectPortsSectionAccessible(shell);

    // Stop forwarding: the listener goes, and the connection it carried is reset
    const open = net.connect({ host: '127.0.0.1', port: 8000 });
    const closed = new Promise<void>((resolve) => open.once('close', () => resolve()));
    open.on('error', () => undefined);
    await new Promise<void>((resolve) => open.once('connect', () => resolve()));
    open.write('GET / HTTP/1.1\r\nHost: localhost\r\n');
    await expect.poll(async () => (await row(shell, hostId, 8000))?.liveConnections).toBeGreaterThan(0);
    await clickRowAction(shell, 8000, 'port-stop');
    await closed;
    await expect.poll(async () => (await row(shell, hostId, 8000))?.state).toBe('detected');
    await expect(fetch('http://127.0.0.1:8000/')).rejects.toThrow();

    await stopTargetListeners(fixture);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await closeServer(local5173);
  }
});

test('with damocles.desktop.remote.autoForwardPorts off a new listener is listed with Forward and nothing listens here until it is forwarded', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.remote.autoForwardPorts': false });
  const fixture = await sshd('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const { key, shell } = await connectRemote(app, hostId);
  const free = await holdLocalPort(0);
  const port = (free.address() as net.AddressInfo).port;
  await closeServer(free);
  await listenOnTarget(fixture, [port]);
  await expect.poll(async () => (await row(shell, hostId, port))?.state, { timeout: 15_000 }).toBe('detected');
  await expect(portRow(shell, port)).toHaveAttribute('data-state', 'detected');
  // nothing listens here: the port is still free on this computer
  await closeServer(await holdLocalPort(port));
  await portRow(shell, port).getByTestId('port-forward').click();
  await expect.poll(async () => (await row(shell, hostId, port))?.state).toBe('forwarded');
  expect((await row(shell, hostId, port))?.origin).toBe('manual');
  await expect(holdLocalPort(port)).rejects.toMatchObject({ code: 'EADDRINUSE' });
  expect(key).toContain(`ssh+${hostId}`);
  await stopTargetListeners(fixture);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('Forward a Port 9000 with a label, Change local port to 9100 and a taken one refused; Open in pane and Ignore attributes; the forward, its local port and label come back after a relaunch; Forget host removes them', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.browser.enabled': true });
  const fixture = await sshd('prod-1');
  const env = { env: { ...remoteEnv(ssh, mirror), ...chromeEnv() } };
  const first = await launch(env);
  const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
  let { key, shell } = await connectRemote(first.app, hostId);
  await newRemoteChat(first.app, key);
  await listenOnTarget(fixture, [9000]);

  // Forward a Port from the section's header: the target's port, then its label
  await shell.getByTestId('ports-section').hover();
  await shell.getByTestId('ports-forward').click();
  let overlay = await overlayPage(first.app);
  // an answered box plays its exit while the next one enters, so each box is found by its prompt
  const box = (prompt: string) => overlay.getByTestId('quick-input').filter({ hasText: prompt }).getByTestId('quick-input-field');
  await box('Port on prod-1').fill('9000');
  await box('Port on prod-1').press('Enter');
  await box('Label (optional)').fill('api');
  await box('Label (optional)').press('Enter');
  await expect.poll(async () => await row(shell, hostId, 9000), { timeout: 15_000 }).toMatchObject({ state: 'forwarded', localPort: 9000, label: 'api', origin: 'manual' });

  // Change local port: 9100, then a port this computer already uses, which is refused in the box and changes nothing
  const taken = await holdLocalPort(0);
  const takenPort = (taken.address() as net.AddressInfo).port;
  const changeLocalPort = async (value: string): Promise<void> => {
    await clickRowAction(shell, 9000, 'port-more');
    overlay = await overlayPage(first.app);
    await overlay.getByRole('menuitem', { name: 'Change local port…' }).click();
    await box('Local port on this computer').fill(value);
    await box('Local port on this computer').press('Enter');
  };
  await changeLocalPort('9100');
  await expect.poll(async () => (await row(shell, hostId, 9000))?.localPort).toBe(9100);
  await changeLocalPort(String(takenPort));
  await expect(overlay.locator('[data-testid="quick-input-problem"][data-code="refused"]')).toHaveText(`Port ${takenPort} is in use on this computer`);
  // the re-ask shows the refusal in place of its prompt
  await overlay.getByTestId('quick-input').filter({ has: overlay.locator('[data-code="refused"]') }).getByTestId('quick-input-field').press('Escape');
  expect((await row(shell, hostId, 9000))?.localPort).toBe(9100);
  expect(await bodyOfRaw(9100)).toBe('connected');
  await closeServer(taken);

  // When detected: 47201 opens a pane tab when it is detected; 47202 is ignored and never forwarded by itself
  await shell.evaluate(([projectKey]) => Promise.all([window.damoclesShell!.ports.setOnDetect(projectKey!, 47201, 'openPane'), window.damoclesShell!.ports.setOnDetect(projectKey!, 47202, 'ignore')]), [key]);
  await webServerOnTarget(fixture, 47201);
  await listenOnTarget(fixture, [47202]);
  await expect.poll(async () => (await browserTabs(first.app)).some((tab) => tab.browser.forwardedFrom?.targetUrl.startsWith('http://localhost:47201') === true), { timeout: PAGE_TIMEOUT }).toBe(true);
  await expect.poll(async () => (await row(shell, hostId, 47202))?.state, { timeout: 15_000 }).toBe('ignored');
  await expect(portRow(shell, 47202)).toHaveAttribute('data-state', 'ignored');
  await first.close();

  // relaunch: the host connects with the selected project, and the manual forward comes back on 9100 with its label
  const second = await launch(env);
  key = await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
  shell = await shellPage(second.app);
  await expect.poll(async () => await row(shell, hostId, 9000), { timeout: 60_000 }).toMatchObject({ state: 'forwarded', localPort: 9100, label: 'api', origin: 'manual' });
  const hostsFile = path.join(home.userData, 'remote-hosts.json');
  expect(fs.readFileSync(hostsFile, 'utf8')).toContain('"47201"');

  await stopTargetListeners(fixture);
  await shutdownHostDaemon(second.app, hostId, fixture);
  // Forget host from its card: the record goes, with its port attributes and restore entries
  expect(JSON.parse(fs.readFileSync(hostsFile, 'utf8')).hosts[hostId].ports.attributes['47201']).toEqual({ onDetect: 'openPane' });
  const connect = await openConnect(second.app);
  await connectDialog(connect).getByRole('button', { name: 'Details for prod-1' }).click();
  await connect.getByTestId('host-card').getByRole('button', { name: 'Forget host', exact: true }).click();
  await connect.getByRole('alertdialog', { name: 'Forget prod-1?' }).getByRole('button', { name: 'Forget host', exact: true }).click();
  await expect.poll(() => storedHost(home, hostId)).toBeUndefined();
  expect(fs.readFileSync(hostsFile, 'utf8')).not.toMatch(/"(9000|47201|47202)"/);
  expect(fs.existsSync(path.join(home.damoclesDir, 'browser-profiles', `ssh+${hostId}`))).toBe(false);
});

test('25 listeners: 20 forward, the 21st switches the host to output-only with a notice, Undo forwards them all and it never switches again', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await recordToasts(app);
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const { shell } = await connectRemote(app, hostId);
  const ports = Array.from({ length: 25 }, (_, index) => 47_000 + index);
  await listenOnTarget(fixture, ports);
  await expect.poll(async () => (await portsView(shell, hostId))?.rows.filter((entry) => ports.includes(entry.remotePort)).length, { timeout: 30_000 }).toBe(25);
  const view = (await portsView(shell, hostId))!;
  expect(view.autoForwardMode).toBe('outputOnly');
  expect(view.rows.filter((entry) => entry.state === 'forwarded')).toHaveLength(20);
  await expect(shell.getByTestId('ports-output-only')).toBeVisible();
  const notices = (await recordedPopupToasts(app)).filter((toast) => toast.body.kind === 'notice' && toast.body.title === 'prod-1 now forwards only ports seen in terminal output');
  expect(notices).toHaveLength(1);
  await shell.getByTestId('ports-undo-fallback').click();
  await expect.poll(async () => (await portsView(shell, hostId))?.rows.filter((entry) => entry.state === 'forwarded').length, { timeout: 30_000 }).toBe(25);
  expect((await portsView(shell, hostId))?.autoForwardMode).toBe('all');
  await listenOnTarget(fixture, Array.from({ length: 5 }, (_, index) => 47_100 + index));
  await expect.poll(async () => (await portsView(shell, hostId))?.rows.filter((entry) => entry.state === 'forwarded').length, { timeout: 30_000 }).toBe(30);
  expect((await recordedPopupToasts(app)).filter((toast) => toast.body.kind === 'notice' && toast.body.title === 'prod-1 now forwards only ports seen in terminal output')).toHaveLength(1);
  await stopTargetListeners(fixture);
  await shutdownHostDaemon(app, hostId, fixture);
});

// a raw connection through the forward to a listener that accepts and says nothing: it connected
async function bodyOfRaw(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve('connected');
    });
    socket.once('error', reject);
  });
}
