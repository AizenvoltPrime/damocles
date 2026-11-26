import type { Page } from '@playwright/test';
import { writeUserSettings } from '../desktop/support/hermetic';
import { confirmDialog, readyOverlay } from '../desktop/support/overlay';
import { activeTerminal, openTerminal, readFromTerminal, runInTerminal, terminalText } from '../desktop/support/terminal';
import { openConnect } from './support/connect-ui';
import { daemonPids, serverProcesses, shutdownHostDaemon } from './support/daemon-teardown';
import { removeServerDialog } from './support/host-settings-ui';
import { ANSWERS_AGAIN_MS, NOT_RESPONDING_MS, terminalStatus as statusOf } from './support/not-responding';
import { terminalHosts } from './support/older-server';
import { addHost, control, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { TARGET_HOME, type SshdFixture } from './support/sshd';

const APP = '/srv/app';

// gone, or a zombie (stat Z, Zs, Zs+) its stopped parent cannot reap yet
const dead = async (fixture: SshdFixture, pid: number): Promise<boolean> => /^(Z\S*)?$/.test((await fixture.sh(`ps -o stat= -p ${pid} || true`, 'dev')).trim());

/** A new terminal of the project, active, and its shell's pid as the shell prints it. */
async function newTerminal(shell: Page, projectKey: string): Promise<{ readonly id: string; readonly pid: number }> {
  const created = await shell.evaluate((project) => window.damoclesShell!.terminal.create({ profileId: null, target: { project } }), projectKey);
  if (!created.ok) throw new Error(`no terminal: ${created.reason}`);
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', created.id);
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  return { id: created.id, pid: await shellPid(shell) };
}

async function shellPid(shell: Page): Promise<number> {
  await runInTerminal(shell, "echo shell''-pid-$$");
  return Number(await readFromTerminal(shell, /^shell-pid-(\d+)$/m));
}

/** The names in the run folders' terminal-hosts/ that start with the host's pid: its record and its terminal list. */
const hostFiles = async (fixture: SshdFixture, pid: number): Promise<string[]> =>
  (await fixture.sh(`for f in ${TARGET_HOME}/.damocles/server/run-*/terminal-hosts/${pid}.*; do [ -e "$f" ] && echo "\${f##*/}"; done; true`, 'dev')).split('\n').filter(Boolean);

// ~/.damocles/server holds something of the server: a removal leaves only its removed marker there
const serverFolder = async (fixture: SshdFixture): Promise<boolean> => (await fixture.sh(`ls -A ${TARGET_HOME}/.damocles/server 2>/dev/null | grep -vx removed; true`)).trim() !== '';

test('a terminal host that stops answering shows not responding on its tabs and host card; Kill ends a terminal, End terminal host ends the host, and a host that answers again clears it', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  const projectKey = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(app);
  const killed = { id: (await activeTerminal(shell).getAttribute('data-terminal-id'))!, pid: await shellPid(shell) };
  // a job of the shell, which ends with it
  await runInTerminal(shell, "sleep 600 & echo sleep''-pid-$!");
  const job = Number(await readFromTerminal(shell, /^sleep-pid-(\d+)$/m));
  const ended = await newTerminal(shell, projectKey);
  const [hostA] = await terminalHosts(fixture);
  expect(hostA).toBeDefined();

  // Host A stops: both its terminals and its card rows say so.
  await fixture.sh(`kill -STOP ${hostA!.pid}`, 'dev');
  await expect.poll(() => statusOf(shell, ended.id), { timeout: NOT_RESPONDING_MS }).toBe('notResponding');
  await expect.poll(() => statusOf(shell, killed.id)).toBe('notResponding');
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'notResponding');
  await expect(activeTerminal(shell).getByTestId('terminal-not-responding')).toHaveText('The terminal host is not responding');
  const overlay = await openConnect(app);
  await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
  const card = overlay.getByTestId('host-card');
  await expect(card.locator('[data-testid="host-run"][data-state="notResponding"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(card.getByTestId('host-run-state').first()).toHaveText('Not responding');
  await expect(card.getByTestId('host-terminal-host-not-responding')).toBeVisible();

  // The tab's Kill ends one terminal at once, its shell's job with it, and drops its tab, while its host stays stopped.
  await shell.evaluate((id) => window.damoclesShell!.terminal.kill(id), killed.id);
  await expect.poll(() => statusOf(shell, killed.id), { timeout: 30_000 }).toBeUndefined();
  await expect.poll(() => dead(fixture, killed.pid), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => dead(fixture, job), { timeout: 30_000 }).toBe(true);
  expect(await dead(fixture, hostA!.pid)).toBe(false);
  await expect(card.locator('[data-testid="host-run"][data-state="notResponding"]')).toHaveCount(1, { timeout: 30_000 });

  // End terminal host, after its confirmation, ends host A and its other terminal.
  await card.getByTestId('host-end-terminal-host').click();
  const confirming = await readyOverlay(app);
  await expect(confirmDialog(confirming)).toContainText('End the terminal host on prod-1?');
  await expect(confirmDialog(confirming)).toContainText('Terminal: bash');
  await confirmDialog(confirming).getByRole('button', { name: 'End terminal host' }).click();
  await expect.poll(() => statusOf(shell, ended.id), { timeout: 30_000 }).toBe('exited');
  await expect.poll(() => dead(fixture, hostA!.pid), { timeout: 30_000 }).toBe(true);
  await expect.poll(() => dead(fixture, ended.pid), { timeout: 30_000 }).toBe(true);
  await expect(card.getByTestId('host-run')).toHaveCount(0, { timeout: 30_000 });
  await overlay.keyboard.press('Escape');

  // A new terminal starts host B; stopped it is not responding, and once it runs again it is running again.
  const resumed = await newTerminal(shell, projectKey);
  const hostB = (await terminalHosts(fixture)).find((host) => host.pid !== hostA!.pid);
  expect(hostB).toBeDefined();
  await fixture.sh(`kill -STOP ${hostB!.pid}`, 'dev');
  await expect.poll(() => statusOf(shell, resumed.id), { timeout: NOT_RESPONDING_MS }).toBe('notResponding');
  // typed while not responding, it never reaches the shell: the line typed after the host answers again shows, this one never
  await runInTerminal(shell, "echo typed''-unanswered");
  await fixture.sh(`kill -CONT ${hostB!.pid}`, 'dev');
  await expect.poll(() => statusOf(shell, resumed.id), { timeout: ANSWERS_AGAIN_MS }).toBe('running');
  await runInTerminal(shell, "echo answers''-again");
  await expect.poll(() => terminalText(shell)).toMatch(/^answers-again$/m);
  expect(await terminalText(shell)).not.toContain('typed');
  expect(await dead(fixture, hostB!.pid)).toBe(false);

  await shutdownHostDaemon(app, hostId, fixture);
});

test('Remove Damocles server ends a terminal host that is not responding and leaves no process and no file of the server but its removed marker', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  const shell = await openTerminal(app);
  const terminal = { id: (await activeTerminal(shell).getAttribute('data-terminal-id'))!, pid: await shellPid(shell) };
  const [host] = await terminalHosts(fixture);
  expect(host).toBeDefined();

  await fixture.sh(`kill -STOP ${host!.pid}`, 'dev');
  await expect.poll(() => statusOf(shell, terminal.id), { timeout: NOT_RESPONDING_MS }).toBe('notResponding');

  // The confirmation lists the terminal and says the removal ends terminals that are not responding too.
  const overlay = await openConnect(app);
  await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
  const card = overlay.getByTestId('host-card');
  await expect(card.locator('[data-testid="host-run"][data-state="notResponding"]')).toHaveCount(1, { timeout: 30_000 });
  await card.getByRole('button', { name: 'Remove Damocles server...', exact: true }).click();
  const dialog = removeServerDialog(overlay);
  await expect(dialog.locator('[data-testid="removal-run"][data-kind="terminal"]')).toHaveCount(1);
  await expect(dialog).toContainText('every terminal, terminals that are not responding included');
  await dialog.getByRole('button', { name: 'Remove server', exact: true }).click();
  await expect(card.getByTestId('remove-server-result')).toHaveRole('status', { timeout: 120_000 });

  // the removal ends Damocles' master connection too, so the account runs nothing
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
  expect(await dead(fixture, host!.pid)).toBe(true);
  expect(await dead(fixture, terminal.pid)).toBe(true);
  expect(await serverProcesses(fixture)).toEqual([]);
  expect(await serverFolder(fixture)).toBe(false);
  expect((await fixture.sh(`if [ -e '${host!.socketFolder}' ]; then echo yes; fi`)).trim()).toBe('');
  await overlay.keyboard.press('Escape');
});

test('Remove Damocles server removes nothing while a terminal host it cannot prove its own runs, names its process ID, and Try again finishes once it ended', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  const shell = await openTerminal(app);
  const terminal = await shellPid(shell);
  const [host] = await terminalHosts(fixture);
  expect(host).toBeDefined();
  await expect.poll(() => hostFiles(fixture, host!.pid)).toEqual([`${host!.pid}.json`, `${host!.pid}.terminals`]);

  // Stopped, so it rewrites nothing, and its recorded start of a scheme no daemon reads, so no kill can prove it is the host.
  const terminals = `${TARGET_HOME}/.damocles/server/run-*/terminal-hosts/${host!.pid}.terminals`;
  await fixture.sh(`kill -STOP ${host!.pid}`, 'dev');
  await fixture.sh(`sed -i 's/"hostStart":"[^"]*"/"hostStart":"unread:1"/' ${terminals}`, 'dev');
  expect((await fixture.sh(`grep -c '"hostStart":"unread:1"' ${terminals}`, 'dev')).trim()).toBe('1');

  const overlay = await openConnect(app);
  await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
  const card = overlay.getByTestId('host-card');
  await card.getByRole('button', { name: 'Remove Damocles server...', exact: true }).click();
  await removeServerDialog(overlay).getByRole('button', { name: 'Remove server', exact: true }).click();
  const result = card.getByTestId('remove-server-result');
  await expect(result).toHaveRole('alert', { timeout: 120_000 });
  await expect(result).toHaveText(`A terminal host was still running on prod-1 (process ID ${host!.pid}), so nothing was removed. End it on prod-1, for example with kill ${host!.pid}, then choose Try again to finish the removal. You can also connect to prod-1 and use End terminal host on its card.`);
  expect(await daemonPids(fixture)).toEqual([]);
  expect([await dead(fixture, host!.pid), await dead(fixture, terminal)]).toEqual([false, false]);
  expect(await serverFolder(fixture)).toBe(true);

  // the command the result names; the stop is lifted so the host takes the signal, and ends its terminal
  await fixture.sh(`kill ${host!.pid} && kill -CONT ${host!.pid}`, 'dev');
  await expect.poll(async () => [await dead(fixture, host!.pid), await dead(fixture, terminal)], { timeout: 30_000 }).toEqual([true, true]);
  await card.getByTestId('remove-server-retry').click();
  await expect(card.getByTestId('remove-server-result')).toHaveRole('status', { timeout: 120_000 });
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
  expect(await serverFolder(fixture)).toBe(false);
  await overlay.keyboard.press('Escape');
});

test('a terminal host stopped before handOver now shows not responding on the next server\'s tabs and host card, and End terminal host ends it', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  const projectKey = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(app);
  const first = { id: (await activeTerminal(shell).getAttribute('data-terminal-id'))!, pid: await shellPid(shell) };
  const second = await newTerminal(shell, projectKey);
  const [host] = await terminalHosts(fixture);
  expect(host).toBeDefined();
  await expect.poll(() => hostFiles(fixture, host!.pid)).toEqual([`${host!.pid}.json`, `${host!.pid}.terminals`]);
  const [daemon] = await daemonPids(fixture);

  // The host stops, then the server switches before the old daemon judged it: the next daemon never attaches it.
  await fixture.sh(`kill -STOP ${host!.pid}`, 'dev');
  await control(app, hostId, 'handOver', { when: 'now' });
  await expect.poll(() => daemonPids(fixture), { timeout: 30_000 }).not.toContain(daemon);
  await openRemoteFolder(app, hostId, APP);
  expect(await daemonPids(fixture)).not.toContain(daemon);

  // Both remembered tabs stay, not responding, and their shells still run.
  await expect.poll(() => statusOf(shell, second.id), { timeout: NOT_RESPONDING_MS }).toBe('notResponding');
  await expect.poll(() => statusOf(shell, first.id)).toBe('notResponding');
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'notResponding');
  await expect(activeTerminal(shell).getByTestId('terminal-not-responding')).toHaveText('The terminal host is not responding');
  expect([await dead(fixture, first.pid), await dead(fixture, second.pid)]).toEqual([false, false]);
  const overlay = await openConnect(app);
  await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
  const card = overlay.getByTestId('host-card');
  await expect(card.locator('[data-testid="host-run"][data-state="notResponding"]')).toHaveCount(2, { timeout: 30_000 });
  await expect(card.getByTestId('host-terminal-host-not-responding')).toBeVisible();

  // End terminal host, after its confirmation, ends the host, its shells and its files, and the tabs show them ended.
  await card.getByTestId('host-end-terminal-host').click();
  const confirming = await readyOverlay(app);
  await expect(confirmDialog(confirming)).toContainText('End the terminal host on prod-1?');
  await confirmDialog(confirming).getByRole('button', { name: 'End terminal host' }).click();
  await expect.poll(() => statusOf(shell, first.id), { timeout: 30_000 }).toBe('exited');
  await expect.poll(() => statusOf(shell, second.id), { timeout: 30_000 }).toBe('exited');
  await expect.poll(() => dead(fixture, host!.pid), { timeout: 30_000 }).toBe(true);
  await expect.poll(async () => [await dead(fixture, first.pid), await dead(fixture, second.pid)], { timeout: 30_000 }).toEqual([true, true]);
  await expect.poll(() => hostFiles(fixture, host!.pid), { timeout: 30_000 }).toEqual([]);
  await expect(card.getByTestId('host-run')).toHaveCount(0, { timeout: 30_000 });
  await overlay.keyboard.press('Escape');

  await shutdownHostDaemon(app, hostId, fixture);
});
