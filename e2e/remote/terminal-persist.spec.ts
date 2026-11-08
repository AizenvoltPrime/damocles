import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import type { TerminalInfo } from '../../src/desktop/preload/terminal-channels';
import type { PersistedPane } from '../../src/desktop/main/terminal/terminal-service';
import { writeUserSettings } from '../desktop/support/hermetic';
import { shellPage } from '../desktop/support/shell';
import { activeTerminal, openTerminal, runInTerminal, terminalText, waitForOutputLine } from '../desktop/support/terminal';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, holdFor, test } from './support/flaky';
import { addHost, hostState, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG } from './support/remote';

const APP = '/srv/app';
const DROP_MS = 120_000;

/** Seconds of the day of every `date` line on the terminal's screen (`Wed Oct 28 20:55:01 UTC 2026`), top to bottom. */
async function dateLines(shell: Page): Promise<number[]> {
  return (await terminalText(shell)).split('\n').flatMap((row) => {
    const found = /\b(\d\d):(\d\d):(\d\d)\b/.exec(row);
    return found && /\b\d{4}\s*$/.test(row) ? [Number(found[1]) * 3600 + Number(found[2]) * 60 + Number(found[3])] : [];
  });
}

test('a `while true; do date; sleep 1; done` terminal survives a 2-minute drop: input is off while it reconnects, and its output from the drop arrives', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const target = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  await shellPage(app);
  const shell = await openTerminal(app);
  await runInTerminal(shell, 'while true; do date; sleep 1; done');
  await expect.poll(async () => (await dateLines(shell)).length, { timeout: 30_000 }).toBeGreaterThan(2);
  // the shell running the loop: the parent of its newest sleep
  const loopShell = async (): Promise<string> => (await target.fixture.sh('p=$(pgrep -u dev -n -x sleep) && ps -o ppid= -p "$p" || true')).trim();
  let loop = '';
  await expect.poll(async () => (loop = await loopShell())).not.toBe('');
  const clock = async (): Promise<number> => {
    const [h, m, s] = (await target.fixture.sh('date +%T')).trim().split(':').map(Number);
    return h! * 3600 + m! * 60 + s!;
  };

  const droppedAt = await clock();
  target.proxy.refuse();
  const view = activeTerminal(shell);
  await expect(view).toHaveAttribute('data-status', 'reconnecting', { timeout: 30_000 });
  await expect(view).toContainText('Reconnecting');
  // stdin is off: keys typed now never reach the shell
  await view.locator('.xterm-screen').click();
  await shell.keyboard.type('typed-while-away');
  await holdFor(DROP_MS);
  const restoredAt = await clock();
  target.proxy.restore();

  await expect(view).toHaveAttribute('data-status', 'running', { timeout: 120_000 });
  // the loop kept printing on the host through the drop, and those lines reach the screen once it is back
  await expect.poll(async () => (await dateLines(shell)).some((at) => at > droppedAt + 5 && at < restoredAt), { timeout: 60_000 }).toBe(true);
  await expect.poll(async () => Math.max(...(await dateLines(shell))), { timeout: 30_000 }).toBeGreaterThan(restoredAt);
  expect(await terminalText(shell)).not.toContain('typed-while-away');
  // the same shell loop, never restarted
  await expect.poll(loopShell).toBe(loop);
  await shutdownHostDaemon(app, hostId, target.fixture);
});

const marks = (shell: Page): Locator => activeTerminal(shell).getByTestId('terminal-mark');
const markStatuses = (shell: Page): Promise<Array<string | null>> => marks(shell).evaluateAll((elements) => elements.map((element) => element.getAttribute('data-status')));

async function activeInfo(shell: Page): Promise<TerminalInfo> {
  const id = await activeTerminal(shell).getAttribute('data-terminal-id');
  const found = (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((terminal) => terminal.id === id);
  if (!found) throw new Error(`no terminal ${id}`);
  return found;
}

test('a relaunch keeps a remote terminal\'s command marks, its running command and its folder', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const env = { env: remoteEnv(ssh, mirror) };
  const first = await launch(env);
  const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(first.app, hostId, APP);
  await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(first.app);
  await expect.poll(async () => (await activeInfo(shell)).integrated, { timeout: 30_000 }).toBe(true);
  // the marker on screen is the output, never the command line that prints it
  await runInTerminal(shell, "echo persist''-one");
  await waitForOutputLine(shell, 'persist-one');
  await expect.poll(() => markStatuses(shell), { timeout: 20_000 }).toEqual(['success']);
  await runInTerminal(shell, 'mkdir -p persist-sub');
  await expect.poll(() => markStatuses(shell), { timeout: 20_000 }).toEqual(['success', 'success']);
  await runInTerminal(shell, 'cd persist-sub');
  await expect.poll(async () => (await activeInfo(shell)).description, { timeout: 20_000 }).toBe('persist-sub');
  await runInTerminal(shell, 'sleep 600');
  await expect.poll(() => markStatuses(shell), { timeout: 20_000 }).toEqual(['success', 'success', 'success', 'running']);
  const before = await activeInfo(shell);
  expect(before).toMatchObject({ integrated: true, running: 'sleep 600', title: 'sleep 600', description: 'persist-sub' });
  await first.close();

  const second = await launch(env);
  await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
  const relaunched = await shellPage(second.app);
  await expect(activeTerminal(relaunched)).toHaveAttribute('data-terminal-id', before.id, { timeout: 60_000 });
  await expect(activeTerminal(relaunched)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  await expect(activeTerminal(relaunched).locator('.terminal-host')).not.toHaveClass(/invisible/);
  await expect.poll(() => markStatuses(relaunched), { timeout: 20_000 }).toEqual(['success', 'success', 'success', 'running']);
  expect(await activeInfo(relaunched)).toMatchObject({ integrated: true, running: 'sleep 600', title: 'sleep 600', description: 'persist-sub' });
  expect((await terminalText(relaunched)).split('\n').filter((row) => row === 'persist-one')).toHaveLength(1);
  await shutdownHostDaemon(second.app, hostId, fixture);
});

const terminalState = (shell: Page) => shell.evaluate(() => window.damoclesShell!.terminal.getState());
const paneIds = async (shell: Page): Promise<string[][]> => (await terminalState(shell)).groups.map((group) => [...group.paneIds]);

test('a remote terminal joined into a local group keeps its slot across a relaunch with the host offline and rejoins on connect', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const env = { env: remoteEnv(ssh, mirror) };
  const first = await launch(env);
  const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(first.app, hostId, APP);
  await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(first.app);
  const remoteId = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;
  await runInTerminal(shell, "echo joined''-slot");
  await waitForOutputLine(shell, 'joined-slot');
  // a local terminal in this computer's home folder, whose split group the remote terminal joins on the right
  const local = await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: null, target: { home: true } }));
  if (!local.ok) throw new Error(`no local terminal: ${local.reason}`);
  await shell.evaluate(({ id, target }) => window.damoclesShell!.terminal.move({ kind: 'join', id, target, side: 'after' }), { id: remoteId, target: local.id });
  await expect.poll(() => paneIds(shell)).toEqual([[local.id, remoteId]]);
  await first.close();

  // The host goes away; its daemon and terminal keep running behind the refused port.
  await fixture.stopSshd();
  const second = await launch(env);
  const app = second.app;
  const relaunched = await shellPage(app);
  await expect.poll(async () => (await lastConnectStep(app, hostId))?.step, { timeout: 60_000 }).toBe('failed');
  // the local pane starts again under a new id, and the remote one holds its slot beside it
  let restoredLocal = '';
  await expect.poll(async () => {
    const groups = await paneIds(relaunched);
    restoredLocal = groups[0]?.[0] ?? '';
    return groups.map((group) => group.map((id) => (id === remoteId ? 'remote' : 'local')));
  }, { timeout: 60_000 }).toEqual([['local', 'remote']]);
  const waiting = relaunched.locator(`[data-testid="terminal-view"][data-terminal-id="${remoteId}"]`);
  await expect(waiting).toHaveAttribute('data-status', 'reconnecting');
  await expect(waiting).toContainText('Reconnecting');

  // The host is back: the reconnect loop reattaches the same terminal in its slot, with its screen.
  await fixture.startSshd();
  await expect.poll(() => hostState(app, hostId), { timeout: 180_000 }).toBe('connected');
  await expect(waiting).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  expect(await paneIds(relaunched)).toEqual([[restoredLocal, remoteId]]);
  // both panes of the group show, so the remote pane's screen is read from its own view
  const rows = (): Promise<string[]> => waiting.locator('.xterm-rows').evaluate((element) => [...element.children].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()));
  await expect.poll(async () => (await rows()).filter((row) => row === 'joined-slot'), { timeout: 30_000 }).toHaveLength(1);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('a remote terminal whose shell exited stays shown with its exit code for the run, and only the running one comes back after a relaunch', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const env = { env: remoteEnv(ssh, mirror) };
  const first = await launch(env);
  const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(first.app, hostId, APP);
  const projectKey = await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(first.app);
  const runningId = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;
  await runInTerminal(shell, "echo still''-running");
  await waitForOutputLine(shell, 'still-running');
  const exiting = await shell.evaluate((project) => window.damoclesShell!.terminal.create({ profileId: null, target: { project } }), projectKey);
  if (!exiting.ok) throw new Error(`no second terminal: ${exiting.reason}`);
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', exiting.id);
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
  await runInTerminal(shell, 'exit 3');
  const statuses = async (page: Page): Promise<Array<[string, string, number | null]>> => (await terminalState(page)).terminals.map((terminal) => [terminal.id, terminal.status, terminal.exitCode]);
  await expect.poll(() => statuses(shell), { timeout: 30_000 }).toEqual([[runningId, 'running', null], [exiting.id, 'exited', 3]]);
  await first.close();
  // neither the host-scoped record nor the window layout names the exited terminal
  const saved = (file: string): unknown => JSON.parse(fs.readFileSync(path.join(home.userData, file), 'utf8'));
  const records = saved('remote-state.json') as { authorities: Record<string, { terminals: Array<{ id: string }> }> };
  expect(records.authorities[`ssh+${hostId}`]!.terminals.map((record) => record.id)).toEqual([runningId]);
  const layout = saved('window-layout.json') as { terminals: { groups: Array<{ panes: PersistedPane[] }>; editor: PersistedPane[] } };
  expect([...layout.terminals.groups.flatMap((group) => group.panes), ...layout.terminals.editor]).toEqual([{ kind: 'remote', id: runningId }]);

  const second = await launch(env);
  await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
  const relaunched = await shellPage(second.app);
  await expect(activeTerminal(relaunched)).toHaveAttribute('data-terminal-id', runningId, { timeout: 60_000 });
  await expect(activeTerminal(relaunched)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  expect(await statuses(relaunched)).toEqual([[runningId, 'running', null]]);
  await expect.poll(async () => (await terminalText(relaunched)).split('\n').filter((row) => row === 'still-running'), { timeout: 20_000 }).toHaveLength(1);
  await shutdownHostDaemon(second.app, hostId, fixture);
});

test('a Kill of a terminal still reconnecting ends its shell on the host when the host is back after another relaunch, and it never comes back', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const env = { env: remoteEnv(ssh, mirror) };
  const first = await launch(env);
  const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(first.app, hostId, APP);
  await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(first.app);
  const id = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;
  await runInTerminal(shell, "echo shell''-pid-$$");
  let pid = '';
  await expect.poll(async () => (pid = /^shell-pid-(\d+)$/m.exec(await terminalText(shell))?.[1] ?? '')).not.toBe('');
  await first.close();
  const alive = async (): Promise<boolean> => (await fixture.sh(`kill -0 ${pid} 2>/dev/null && echo alive || echo gone`)).trim() === 'alive';
  expect(await alive()).toBe(true);

  // The host is away: the terminal comes back as a reconnecting placeholder, and Kill closes it.
  await fixture.stopSshd();
  const second = await launch(env);
  const away = await shellPage(second.app);
  await expect.poll(async () => (await lastConnectStep(second.app, hostId))?.step, { timeout: 60_000 }).toBe('failed');
  await expect(away.locator(`[data-testid="terminal-view"][data-terminal-id="${id}"]`)).toHaveAttribute('data-status', 'reconnecting', { timeout: 60_000 });
  await away.evaluate((terminal) => window.damoclesShell!.terminal.kill(terminal), id);
  await expect.poll(async () => (await terminalState(away)).terminals.map((terminal) => terminal.id)).toEqual([]);
  await second.close();
  const kept = JSON.parse(fs.readFileSync(path.join(home.userData, 'remote-state.json'), 'utf8')) as { authorities: Record<string, { terminals: Array<{ id: string }>; pendingKills: string[] }> };
  expect(kept.authorities[`ssh+${hostId}`]).toMatchObject({ terminals: [], pendingKills: [id] });
  expect(await alive()).toBe(true);

  // The host is back at the next launch: its reattach kills the shell, which gets no tab.
  await fixture.startSshd();
  const third = await launch(env);
  const back = await shellPage(third.app);
  await expect.poll(() => hostState(third.app, hostId), { timeout: 180_000 }).toBe('connected');
  await expect.poll(alive, { timeout: 30_000 }).toBe(false);
  expect((await terminalState(back)).terminals.map((terminal) => terminal.id)).not.toContain(id);
  await shutdownHostDaemon(third.app, hostId, fixture);
});
