import type { Locator, Page } from '@playwright/test';
import type { TerminalInfo } from '../../src/desktop/preload/terminal-channels';
import { writeUserSettings } from '../desktop/support/hermetic';
import { shellPage } from '../desktop/support/shell';
import { activeTerminal, openTerminal, runInTerminal, terminalText, waitForOutputLine } from '../desktop/support/terminal';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, holdFor, test } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG } from './support/remote';

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
