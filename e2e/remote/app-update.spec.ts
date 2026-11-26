import type { ElectronApplication, Page } from '@playwright/test';
import { RECONNECT_BACKOFF_S } from '../../src/desktop/main/remote/reconnect';
import type { OverlayToast } from '../../src/desktop/preload/overlay-channels';
import type { ShellHost } from '../../src/desktop/preload/shell-channels';
import type { HostUpdate } from '../../src/shared/host-update';
import { mainLog, type DesktopApp } from '../desktop/support/app';
import { writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import type { OpenAIStub } from '../desktop/support/openai-stub';
import { confirmDialog } from '../desktop/support/overlay';
import { dismissedToasts, overlayPage, popupPage, popupToasts, recordedPopupToasts, recordedToasts, recordToasts, shellPage, shellState } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { activeTerminal, openTerminal, readFromTerminal, runInTerminal, terminalText, waitForOutputLine } from '../desktop/support/terminal';
import { awaitTurnEnd, chatInput, clickMenu } from '../desktop/support/ui';
import { openConnect } from './support/connect-ui';
import { expectNoAccountProcesses, shutdownHostDaemon } from './support/daemon-teardown';
import { CURRENT_PACKAGE, daemonVersions, installOlderServer, OLD, securityFloor, terminalHostVersions, versionFolder } from './support/older-server';
import { APP_VERSION, LINUX_TARGET, serverVersionOf } from './support/release-mirror';
import { addHost, control, expect, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { allowSleep, chatShowing, closeRemoteDialog, exited, requestQuit, sleeping, SLEEP } from './support/remote-runs';
import { TARGET_HOME, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// The app before the update: this tree's server package installed as OLD (and for the protocol cases its daemon's
// PROTOCOL_VERSION set to OTHER_PROTOCOL), driven by a launch that runs as that version through the e2e hooks. NEWER stands for
// a server of a later app than this one, installed the same way.
const NEWER = '99.0.0';
const OTHER_PROTOCOL = 2;
const APP = '/srv/app';
// a reconnect attempt's ssh, probe and bridge
const ATTEMPT_SLACK_MS = 10_000;
const DISCONNECT_HOST = 'damocles.remote.disconnectHost';

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

async function hostIdOf(app: ElectronApplication): Promise<string> {
  const hosts = await app.evaluate(() => (globalThis as unknown as { __damoclesE2e: { remote: { hosts(): Array<{ hostId: string }> } } }).__damoclesE2e.remote.hosts());
  expect(hosts).toHaveLength(1);
  return hosts[0]!.hostId;
}

/** A new chat whose turn streams its first chunk and holds there until the returned release. */
async function heldChat(app: ElectronApplication, key: string, stub: OpenAIStub, prompt: string, chunks: [string, string]): Promise<() => void> {
  let release!: () => void;
  stub.replies.push({ chunks, holdAfterFirst: new Promise<void>((resolve) => (release = resolve)) });
  const tab = await newRemoteChat(app, key);
  await sendPrompt(tab, prompt);
  await expect(tab.getByText(chunks[0], { exact: false })).toBeVisible({ timeout: 60_000 });
  return release;
}

/** Opens the chat titled `title` from the APP project's Chats list, as a user does; resolves with its page showing `showing`. */
async function openListedChat(app: ElectronApplication, title: string, showing: string): Promise<Page> {
  let projectKey = '';
  await expect.poll(async () => (projectKey = (await shellState(app)).projects.find((project) => project.fsPath === APP)?.key ?? '')).not.toBe('');
  let chatId = '';
  await expect.poll(async () => (chatId = (await listChats(app, projectKey)).chats.find((chat) => chat.title === title)?.id ?? ''), { timeout: 60_000 }).not.toBe('');
  expect(await (await shellPage(app)).evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
  return chatShowing(app, showing);
}

// the terminal's process, which the spec ends from the target to close the terminal (a chat's tool call is SLEEP)
const TERMINAL_SLEEP = 'sleep 3600';

// every daemon log on the target but core's
const targetDaemonLog = (fixture: Pick<SshdFixture, 'sh'>): Promise<string> =>
  fixture.sh(`for f in ${TARGET_HOME}/.damocles/server/run-*/logs/*.log; do case "$f" in *Damocles_Core*) ;; *) cat "$f" ;; esac; done; true`, 'dev');

async function terminalSleeping(fixture: Pick<SshdFixture, 'sh'>): Promise<boolean> {
  return (await fixture.sh(`pgrep -u dev -f '^${TERMINAL_SLEEP}$' || true`)).trim() !== '';
}

interface TargetTerminal {
  readonly id: string;
  // of the process the terminal runs
  readonly pid: string;
}

/** A terminal on the target whose process is TERMINAL_SLEEP. */
async function sleepingTerminal(app: ElectronApplication, fixture: Pick<SshdFixture, 'sh'>): Promise<TargetTerminal> {
  const shell = await openTerminal(app);
  const id = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;
  await runInTerminal(shell, `exec ${TERMINAL_SLEEP}`);
  let pid = '';
  await expect.poll(async () => (pid = (await fixture.sh(`pgrep -u dev -f '^${TERMINAL_SLEEP}$' || true`)).trim()), { timeout: 30_000 }).toMatch(/^\d+$/);
  return { id, pid };
}

/** The terminal's process runs on under its pid in the old version's terminal host, and its tab shows it running. */
async function terminalStillRuns(app: ElectronApplication, fixture: Pick<SshdFixture, 'sh'>, terminal: TargetTerminal): Promise<void> {
  expect((await fixture.sh(`pgrep -u dev -f '^${TERMINAL_SLEEP}$' || true`)).trim()).toBe(terminal.pid);
  expect(await terminalHostVersions(fixture)).toEqual([OLD]);
  await expect((await shellPage(app)).locator(`[data-testid="terminal-view"][data-terminal-id="${terminal.id}"]`)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
}

/** A terminal on the target at its bash prompt, with more output than its screen holds; resolves with its id and its shell's pid. */
async function idleShell(app: ElectronApplication): Promise<TargetTerminal> {
  const shell = await openTerminal(app);
  const id = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;
  // the scroll to the first command needs the shell's command marks
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.find((terminal) => terminal.id === id)?.integrated, { timeout: 30_000 }).toBe(true);
  await runInTerminal(shell, "echo scroll''-top");
  await waitForOutputLine(shell, 'scroll-top');
  await runInTerminal(shell, 'seq 1 200');
  await waitForOutputLine(shell, '200');
  await runInTerminal(shell, "echo shell''-pid-$$");
  return { id, pid: await readFromTerminal(shell, /^shell-pid-(\d+)$/m) };
}

/** The active terminal is `terminal`, running: its screen as it was, the same shell answering typed input, and its scrollback. */
async function shellCameBack(app: ElectronApplication, terminal: TargetTerminal): Promise<void> {
  const shell = await shellPage(app);
  await expect(activeTerminal(shell)).toHaveAttribute('data-terminal-id', terminal.id, { timeout: 60_000 });
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  await expect.poll(async () => (await terminalText(shell)).split('\n').filter((row) => row === `shell-pid-${terminal.pid}`), { timeout: 30_000 }).toHaveLength(1);
  expect((await terminalText(shell)).split('\n')).not.toContain('scroll-top');
  await runInTerminal(shell, "echo again''-$$");
  await waitForOutputLine(shell, `again-${terminal.pid}`);
  await expect.poll(async () => {
    await clickMenu(app, 'damocles.terminal.scrollToPreviousCommand');
    return (await terminalText(shell)).split('\n').includes('scroll-top');
  }, { timeout: 30_000, intervals: [500] }).toBe(true);
}

/** How often main attached to the host's core: one more once a reconnect reached a daemon. */
const coreAttaches = (home: HermeticHome, hostId: string): number => mainLog(home).split(`[remote] attached to the core on ssh+${hostId} (`).length - 1;

/** Quits with Keep running; the quit's dialog lists the runs. */
async function quitKeepRunning(desktop: DesktopApp): Promise<void> {
  await requestQuit(desktop.app);
  const { dialog } = await closeRemoteDialog(desktop.app);
  await dialog.getByRole('button', { name: 'Keep running' }).click();
  await exited(desktop);
}

test.beforeEach(({ home }) => {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
});

test('after an update the app attaches to the busy older daemon of its protocol and streams its chat; its idle shell does not delay the switch, and comes back on the new version in its tab with its screen, scrollback and pid, and takes input', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
    const { key } = await connect(old.app);
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    const terminal = await idleShell(old.app);
    expect(await terminalHostVersions(fixture)).toEqual([OLD]);
    const release = await heldChat(old.app, key, stub, 'Across the update', ['Update part one.', ' Update part two.']);
    await quitKeepRunning(old);

    const { app } = await launch({ env });
    const hostId = await hostIdOf(app);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const live = await chatShowing(app, 'Update part one.');
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    // the switch the app asked for waits for the agent alone, in the chat page and in the shell, and the daemon's log says so
    const strip = live.getByTestId('host-update-banner').getByRole('status');
    await expect(strip).toHaveText(`prod-1 switches to Damocles ${APP_VERSION} when 1 agent finishes.`, { timeout: 60_000 });
    // with the chat shown, the shell continues the page's strip across the gutter in the strip's tone
    await expect((await shellPage(app)).locator('[data-testid="connection-banner-edge"][data-state="update"]')).toHaveCount(1);
    await expect.poll(() => targetDaemonLog(fixture), { timeout: 30_000 }).toMatch(/\[lifetime\] connection-\d+ asks to switch once idle; it waits for 1 agent runs, 0 damocles --wait requests, connected clients that did not ask: none/);
    const attaches = coreAttaches(home, hostId);

    // the chat's end is the switch: the shell, still running, holds nothing back
    release();
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
    await expect.poll(() => coreAttaches(home, hostId), { timeout: 120_000 }).toBeGreaterThan(attaches);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const switched = await chatShowing(app, 'Update part one. Update part two.');
    // this version connected, so nothing is pending
    await expect(switched.getByTestId('host-update-banner')).toHaveCount(0, { timeout: 60_000 });
    await expect((await shellPage(app)).getByTestId('host-update-banner')).toHaveCount(0);
    // the new daemon adopted the old version's terminal host, whose version folder stays, and lists its shell
    expect(await terminalHostVersions(fixture)).toEqual([OLD]);
    expect(await fixture.sh(`test -x '${versionFolder(OLD)}/bin/damocles-server' && echo kept`, 'dev')).toContain('kept');
    expect(((await control(app, hostId, 'listRuns')) as { runs: Array<{ kind: string; id: string }> }).runs.filter((run) => run.kind === 'terminal').map((run) => run.id)).toEqual([terminal.id]);
    await shellCameBack(app, terminal);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('a busy legacy daemon, which has no control.handOver, says its terminal closes; the terminal delays the switch until it ends, then the next connection runs the new version', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD, withoutFeature: 'control.handOver' });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
    const { key } = await connect(old.app);
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    await sleepingTerminal(old.app, fixture);
    const release = await heldChat(old.app, key, stub, 'Across the update', ['Update part one.', ' Update part two.']);
    await quitKeepRunning(old);

    const { app } = await launch({ env });
    const hostId = await hostIdOf(app);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    // Disconnect Host ends the pending switch, so the offline host never shows it switching, and the next connect finds it again
    const host = async (): Promise<ShellHost | undefined> => (await shellState(app)).hosts.find((entry) => entry.hostId === hostId);
    await expect.poll(async () => (await host())?.update?.phase, { timeout: 60_000 }).toBe('waiting');
    await clickMenu(app, DISCONNECT_HOST);
    await expect.poll(async () => (await host())?.connection).toBe('offline');
    expect((await host())?.update).toBeUndefined();
    await (await shellPage(app)).evaluate((id) => window.damoclesShell!.reconnectHost(id), hostId);
    await expect.poll(async () => (await host())?.update?.phase, { timeout: 120_000 }).toBe('waiting');
    const live = await chatShowing(app, 'Update part one.');
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    // installing the new version pruned nothing the running daemon uses
    expect(await fixture.sh(`test -x '${versionFolder(serverVersionOf(LINUX_TARGET))}/bin/damocles-server' && test -x '${versionFolder(OLD)}/bin/damocles-server' && echo both`, 'dev')).toContain('both');
    // the switch the app asked for waits, in the chat page and in the shell, and the daemon's log names what it waits for
    const strip = live.getByTestId('host-update-banner').getByRole('status');
    await expect(strip).toHaveText(`prod-1 switches to Damocles ${APP_VERSION} when 1 agent finishes. Its terminal closes when it switches.`, { timeout: 60_000 });
    // with the chat shown, the shell continues the page's strip across the gutter in the strip's tone
    await expect((await shellPage(app)).locator('[data-testid="connection-banner-edge"][data-state="update"]')).toHaveCount(1);
    await expect.poll(() => targetDaemonLog(fixture), { timeout: 30_000 }).toMatch(/\[lifetime\] connection-\d+ asks to switch once idle; it waits for 1 agent runs, 1 terminals/);

    release();
    await expect(live.getByText('Update part one. Update part two.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(live);
    // the terminal keeps the old daemon: its registry holds the terminal alone
    await expect.poll(async () => ((await control(app, hostId, 'listRuns')) as { runs: Array<{ kind: string }> }).runs.map((run) => run.kind), { timeout: 60_000 }).toEqual(['terminal']);
    await expect(strip).toHaveText(`prod-1 switches to Damocles ${APP_VERSION} when 1 terminal closes.`, { timeout: 10_000 });
    expect(await targetDaemonLog(fixture)).toMatch(/\[lifetime\] the switch now waits for 0 agent runs, 1 terminals/);
    expect(await daemonVersions(fixture)).toEqual([OLD]);

    await fixture.sh(`pkill -u dev -f '^${TERMINAL_SLEEP}$'`);
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const switched = await chatShowing(app, 'Update part one. Update part two.');
    // this version connected, so nothing is pending
    await expect(switched.getByTestId('host-update-banner')).toHaveCount(0, { timeout: 60_000 });
    await expect((await shellPage(app)).getByTestId('host-update-banner')).toHaveCount(0);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('an idle older daemon with no other client is shut down at once and the app starts its own version', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const env = remoteEnv(ssh, mirror);
  const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
  await connect(old.app);
  expect(await daemonVersions(fixture)).toEqual([OLD]);
  await old.close();
  // the idle daemon outlives its client for its idle period
  expect(await daemonVersions(fixture)).toEqual([OLD]);

  const { app } = await launch({ env });
  const hostId = await hostIdOf(app);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('an earlier build of this version, idle on the host, gives way to this build, which installs beside it once', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  // a host an earlier development build of this version installed: its plain-version folder, its server running
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: APP_VERSION });
  const env = remoteEnv(ssh, mirror);
  const earlier = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: APP_VERSION } });
  await connect(earlier.app);
  expect(await daemonVersions(fixture)).toEqual([APP_VERSION]);
  await earlier.close();

  const current = await launch({ env });
  const hostId = await hostIdOf(current.app);
  await remoteProjectKey(current.app, { authorityKey: `ssh+${hostId}` }, APP);
  const build = serverVersionOf(LINUX_TARGET);
  await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([build]);
  expect(await fixture.sh(`test -x '${versionFolder(build)}/bin/damocles-server' && test -x '${versionFolder(APP_VERSION)}/bin/damocles-server' && echo both`, 'dev')).toContain('both');
  // one connect installs this build, stops the earlier build's daemon and attaches again (Authorities adopt)
  await expect.poll(async () => (await lastConnectStep(current.app, hostId))?.step, { timeout: 60_000 }).toBe('connected');
  expect((await lastConnectStep(current.app, hostId))?.visited).toContain('installing');
  const downloads = mirror.downloads.length;
  await current.close();

  // connecting again with the same build installs nothing and downloads nothing
  const again = await launch({ env });
  await remoteProjectKey(again.app, { authorityKey: `ssh+${hostId}` }, APP);
  expect((await lastConnectStep(again.app, hostId))?.visited).not.toContain('installing');
  expect(mirror.downloads).toHaveLength(downloads);
  expect(await daemonVersions(fixture)).toEqual([build]);
  await shutdownHostDaemon(again.app, hostId, fixture);
});

test('a busy daemon of another protocol shows its running chats read-only from the session mirror, kept up to date; Switch when they finish waits for them, then the app runs its own version', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD, protocolVersion: OTHER_PROTOCOL });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD, DAMOCLES_E2E_PROTOCOL_VERSION: String(OTHER_PROTOCOL) } });
    const { key } = await connect(old.app);
    const releaseFirst = await heldChat(old.app, key, stub, 'First old prompt', ['First old one.', ' First old two.']);
    const releaseSecond = await heldChat(old.app, key, stub, 'Second old prompt', ['Second old one.', ' Second old two.']);
    await quitKeepRunning(old);

    const { app } = await launch({ env });
    const hostId = await hostIdOf(app);
    // the old daemon's chat, opened from the Chats list as a mirrored transcript: its text so far, no composer, and the banner
    const page = await openListedChat(app, 'Second old prompt', 'Second old prompt');
    await expect(chatInput(page)).toHaveCount(0);
    const banner = page.getByTestId('host-update-banner');
    await expect(banner.getByRole('status')).toHaveText(`prod-1 is running 2 agents on Damocles ${OLD}. Damocles ${APP_VERSION} is ready.`, { timeout: 60_000 });
    expect(await daemonVersions(fixture)).toEqual([OLD]);

    // mirror.sync keeps the read-only transcript live
    releaseSecond();
    await expect(page.getByText('Second old one. Second old two.', { exact: false })).toBeVisible({ timeout: 120_000 });
    await expect(banner.getByRole('status')).toHaveText(`prod-1 is running 1 agent on Damocles ${OLD}. Damocles ${APP_VERSION} is ready.`, { timeout: 60_000 });

    await banner.getByRole('button', { name: 'Switch when they finish' }).click();
    await expect(banner.getByRole('status')).toHaveText(`prod-1 switches to Damocles ${APP_VERSION} when 1 agent finishes.`);
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    releaseFirst();
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    // on its own version the chat is live again, its whole transcript included
    const resumed = await chatShowing(app, 'Second old one. Second old two.');
    await expect(chatInput(resumed)).toBeVisible({ timeout: 60_000 });
    await expect(resumed.getByTestId('host-update-banner')).toHaveCount(0);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

const AGENT_STOPS = 'This agent stops now. Its chat keeps the transcript, and you can continue it after the switch.';

// legacy: the daemon's refusal lists no control.handOver, as one built before terminal hosts, so the app ends it with shutdownNow
for (const legacy of [false, true]) {
  const title = legacy
    ? 'Switch now on a busy legacy daemon of another protocol says its terminal closes, confirms with its agents and terminals, and closes the terminal'
    : 'Switch now on a busy daemon of another protocol confirms with its running agents, stops them and runs the new version, which replays the cut call stopped and shows the terminal still running';
  test(title, { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
    test.setTimeout(600_000);
    const fixture = await sshd('prod-1');
    await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD, protocolVersion: OTHER_PROTOCOL, ...(legacy ? { withoutFeature: 'control.handOver' } : {}) });
    const stub = await startTargetStub(home, fixture);
    try {
      const env = remoteEnv(ssh, mirror);
      const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD, DAMOCLES_E2E_PROTOCOL_VERSION: String(OTHER_PROTOCOL) } });
      const { key } = await connect(old.app);
      const terminal = await sleepingTerminal(old.app, fixture);
      expect(await terminalHostVersions(fixture)).toEqual([OLD]);
      await allowSleep(fixture);
      stub.replies.push({ chunks: ['Running the long command.'], toolCalls: [{ name: 'bash', arguments: { command: SLEEP } }] });
      await sendPrompt(await newRemoteChat(old.app, key), 'Stopped by the switch');
      await expect.poll(() => sleeping(fixture), { timeout: 60_000 }).toBe(true);
      await quitKeepRunning(old);

      const { app } = await launch({ env });
      const hostId = await hostIdOf(app);
      const page = await openListedChat(app, 'Stopped by the switch', 'Stopped by the switch');
      const banner = page.getByTestId('host-update-banner');
      await expect(banner.getByRole('status')).toHaveText(`prod-1 is running 1 agent on Damocles ${OLD}. Damocles ${APP_VERSION} is ready.${legacy ? ' Its terminal closes when it switches.' : ''}`, { timeout: 60_000 });
      await banner.getByRole('button', { name: 'Switch now' }).click();
      const confirm = confirmDialog(await overlayPage(app));
      await expect(confirm).toContainText(`Switch prod-1 to Damocles ${APP_VERSION} now?`);
      await expect(confirm).toContainText(`${AGENT_STOPS} ${legacy ? 'This terminal closes, and what runs in it stops.' : 'Terminals keep running.'}`);
      await expect(confirm.getByText(/^Agent: /)).toHaveCount(1);
      await expect(confirm.getByText(/^Terminal: /)).toHaveCount(legacy ? 1 : 0);
      await confirm.getByRole('button', { name: 'Switch now' }).click();

      await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
      expect(await sleeping(fixture)).toBe(false);
      await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
      const resumed = await chatShowing(app, 'Stopped by the switch');
      await expect(chatInput(resumed)).toBeVisible({ timeout: 60_000 });
      // the new version's core replays the chat from its session file, where the stopped-result marker names the call stopped
      await expect(resumed.getByTestId('tool-card').filter({ hasText: SLEEP })).toContainText('Stopped');
      if (legacy) {
        expect(await terminalSleeping(fixture)).toBe(false);
        await expect.poll(() => terminalHostVersions(fixture), { timeout: 30_000 }).toEqual([]);
      } else {
        await terminalStillRuns(app, fixture, terminal);
      }
      await shutdownHostDaemon(app, hostId, fixture);
    } finally {
      await stub.close();
    }
  });
}

test('Switch now on a busy older daemon of the same protocol confirms with its agent, stops it with its chat\'s transcript kept, and runs the new version, where the terminal still runs', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
    const { key } = await connect(old.app);
    const terminal = await sleepingTerminal(old.app, fixture);
    await allowSleep(fixture);
    stub.replies.push({ chunks: ['Running the long command.'], toolCalls: [{ name: 'bash', arguments: { command: SLEEP } }] });
    await sendPrompt(await newRemoteChat(old.app, key), 'Stopped by the switch');
    await expect.poll(() => sleeping(fixture), { timeout: 60_000 }).toBe(true);
    await quitKeepRunning(old);

    const { app } = await launch({ env });
    const hostId = await hostIdOf(app);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const page = await chatShowing(app, 'Stopped by the switch');
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    const banner = page.getByTestId('host-update-banner');
    await expect(banner.getByRole('status')).toHaveText(`prod-1 switches to Damocles ${APP_VERSION} when 1 agent finishes.`, { timeout: 60_000 });
    // the app asked already, so the strip offers only Switch now
    await expect(banner.getByRole('button', { name: 'Switch when they finish' })).toHaveCount(0);
    await banner.getByRole('button', { name: 'Switch now' }).click();
    const confirm = confirmDialog(await overlayPage(app));
    await expect(confirm).toContainText(`Switch prod-1 to Damocles ${APP_VERSION} now?`);
    await expect(confirm).toContainText(`${AGENT_STOPS} Terminals keep running.`);
    await expect(confirm.getByText(/^Agent: /)).toHaveCount(1);
    await expect(confirm.getByText(/^Terminal: /)).toHaveCount(0);
    const attaches = coreAttaches(home, hostId);
    await confirm.getByRole('button', { name: 'Switch now' }).click();

    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
    expect(await sleeping(fixture)).toBe(false);
    await expect.poll(() => coreAttaches(home, hostId), { timeout: 120_000 }).toBeGreaterThan(attaches);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const resumed = await chatShowing(app, 'Stopped by the switch');
    await expect(chatInput(resumed)).toBeVisible({ timeout: 60_000 });
    await expect(resumed.getByTestId('host-update-banner')).toHaveCount(0);
    await expect(resumed.getByTestId('tool-card').filter({ hasText: SLEEP })).toContainText('Stopped');
    await terminalStillRuns(app, fixture, terminal);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('an older app uses a newer idle daemon of its protocol as it is, and shows no switch', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: NEWER });
  const env = remoteEnv(ssh, mirror);
  const newer = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: NEWER } });
  await connect(newer.app);
  expect(await daemonVersions(fixture)).toEqual([NEWER]);
  await newer.close();

  const { app } = await launch({ env });
  const hostId = await hostIdOf(app);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  await expect.poll(async () => (await shellState(app)).hosts.find((host) => host.hostId === hostId)?.connection, { timeout: 60_000 }).toBe('connected');
  // idle and alone, it would have been replaced were it older
  expect(await daemonVersions(fixture)).toEqual([NEWER]);
  expect((await shellState(app)).hosts.find((host) => host.hostId === hostId)?.update).toBeUndefined();
  await expect((await shellPage(app)).getByTestId('host-update-banner')).toHaveCount(0);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('an older app meets a newer daemon of another protocol: it shows the outdated state, keeps the chats readable and leaves the daemon running', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: NEWER, protocolVersion: OTHER_PROTOCOL });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const newer = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: NEWER, DAMOCLES_E2E_PROTOCOL_VERSION: String(OTHER_PROTOCOL) } });
    const { key } = await connect(newer.app);
    stub.replies.push({ chunks: ['Answered by the newer server.'] });
    const tab = await newRemoteChat(newer.app, key);
    await sendPrompt(tab, 'Asked on the newer server');
    await expect(tab.getByText('Answered by the newer server.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await newer.close();
    expect(await daemonVersions(fixture)).toEqual([NEWER]);

    const { app } = await launch({ env });
    const hostId = await hostIdOf(app);
    // the chat reads from the session mirror, with the outdated composer card in the composer's place
    const page = await openListedChat(app, 'Asked on the newer server', 'Answered by the newer server.');
    await expect(chatInput(page)).toHaveCount(0);
    await expect(page.getByText('prod-1 runs a newer Damocles')).toBeVisible();
    await expect(page.getByText('This chat is read-only until this app updates. Its transcript is the copy this computer keeps.')).toBeVisible();
    const strip = page.getByTestId('host-update-banner');
    await expect(strip.getByRole('status')).toHaveText(`prod-1 runs Damocles ${NEWER}. Update this app to use it.`, { timeout: 60_000 });
    await expect(strip.getByRole('button', { name: 'Switch now' })).toHaveCount(0);
    await expect(strip.getByRole('button', { name: 'Switch when they finish' })).toHaveCount(0);
    // the unpackaged app has no updater
    await expect(strip.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);
    await expect((await shellPage(app)).locator('[data-testid="connection-banner-edge"][data-state="update"]')).toHaveCount(1);
    expect((await shellState(app)).hosts.find((host) => host.hostId === hostId)?.update).toMatchObject({ source: 'otherProtocol', phase: 'appOutdated', outdated: 'runs', serverVersion: NEWER, targetVersion: APP_VERSION });

    // the card says why and offers nothing that would meet the same server again
    const overlay = await openConnect(app);
    await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
    const card = overlay.getByTestId('host-card');
    await expect(card.getByTestId('host-card-status')).toContainText('Not connected');
    await expect(card).toContainText(`This host runs Damocles ${NEWER}. Update this app to use it.`);
    await expect(card).toContainText(`This computer runs ${APP_VERSION}. Damocles never moves a server back to an older version.`);
    await expect(card.getByRole('button', { name: 'Switch now' })).toHaveCount(0);
    await overlay.keyboard.press('Escape');

    // three more polls of the daemon stop nothing: the newer daemon keeps running
    const polls = (): number => mainLog(home).split(`[update] the daemon of ${NEWER} runs `).length - 1;
    const polled = polls();
    await expect.poll(polls, { timeout: 60_000 }).toBeGreaterThanOrEqual(polled + 3);
    expect(await daemonVersions(fixture)).toEqual([NEWER]);

    // once the newer daemon is gone, this app connects with its own version
    await fixture.sh(`pkill -u dev -f '/dist/daemon.js serve'`);
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await expect((await shellPage(app)).getByTestId('host-update-banner')).toHaveCount(0, { timeout: 60_000 });
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

const hostUpdateOf = async (app: ElectronApplication, hostId: string): Promise<HostUpdate | undefined> => (await shellState(app)).hosts.find((host) => host.hostId === hostId)?.update;
// a version as a regular expression's source
const versionPattern = (version: string): string => version.replace(/[.+]/g, '\\$&');

test('a required update switches the busy older daemon at its deadline; the strip showed the countdown; the chat\'s transcript stays readable; the terminal keeps running in the new version', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
    const { key } = await connect(old.app);
    const terminal = await sleepingTerminal(old.app, fixture);
    await allowSleep(fixture);
    stub.replies.push({ chunks: ['Running the long command.'], toolCalls: [{ name: 'bash', arguments: { command: SLEEP } }] });
    await sendPrompt(await newRemoteChat(old.app, key), 'Stopped by the deadline');
    await expect.poll(() => sleeping(fixture), { timeout: 60_000 }).toBe(true);
    await quitKeepRunning(old);

    // A grace of 12 minutes, inside the countdown's 15, so the countdown runs from the first detection and every check has time
    // before the deadline; the relaunch's shorter grace then brings it in, since a stored deadline only ever comes closer.
    const launched = Date.now();
    const first = await launch({ env: { ...env, DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify({ minimumServerVersion: APP_VERSION, graceHours: 0.2 }) } });
    await recordToasts(first.app);
    const hostId = await hostIdOf(first.app);
    await expect.poll(() => hostUpdateOf(first.app, hostId), { timeout: 30_000 }).toMatchObject({ source: 'compatible', phase: 'waiting', serverVersion: OLD, targetVersion: APP_VERSION, runningAgents: 1, terminalsSurvive: true, required: { countdown: true } });
    const stored = (await hostUpdateOf(first.app, hostId))!.required!.deadline;
    expect(stored).toBeGreaterThan(launched);
    expect(stored).toBeLessThanOrEqual(Date.now() + 0.2 * 3_600_000);
    expect(await daemonVersions(fixture)).toEqual([OLD]);

    // the sticky countdown names the deadline, which the toast counts down to
    let firstCountdown: OverlayToast | undefined;
    await expect.poll(async () => (firstCountdown = (await recordedPopupToasts(first.app)).find((toast) => toast.body.kind === 'notice' && toast.body.countdownTo !== undefined)), { timeout: 30_000 }).toBeDefined();
    expect(firstCountdown).toMatchObject({ sticky: true, body: { severity: 'error', title: 'prod-1 switches in', message: `Damocles ${APP_VERSION} is required. 1 agent stops then; its chat is kept.`, actions: ['Switch now'], host: 'prod-1', countdownTo: stored } });
    // its title ticks: the clock for the eye, the minutes for a screen reader
    const toastTitle = popupToasts(await popupPage(first.app, 10_000)).filter({ hasText: 'prod-1 switches in' }).getByTestId('overlay-toast-title');
    await expect(toastTitle).toHaveText(/prod-1 switches in \d\d:\d\d(?:less than a minute|\d+ minutes?)/, { timeout: 10_000 });
    await expect(toastTitle.getByTestId('countdown-clock')).toHaveAttribute('aria-hidden', 'true');
    const toastClock = await toastTitle.getByTestId('countdown-clock').textContent({ timeout: 5_000 });
    await expect(toastTitle.getByTestId('countdown-clock')).not.toHaveText(toastClock ?? '', { timeout: 5_000 });

    // the chat page's strip counts down in the danger tone, and names the agent the switch stops
    await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
    const counting = (await chatShowing(first.app, 'Running the long command.')).getByTestId('host-update-banner');
    await expect(counting).toHaveAttribute('data-tone', 'danger', { timeout: 10_000 });
    await expect(counting).toHaveAttribute('data-state', 'countdown');
    await expect(counting.getByRole('status')).toHaveText(new RegExp(`prod-1 switches to Damocles ${versionPattern(APP_VERSION)} in \\d\\d:\\d\\d(?:less than a minute|\\d+ minutes?)\\. 1 agent will stop\\.`));
    await expect(counting.getByRole('button', { name: 'Switch now' })).toBeVisible();
    await expect(counting.getByRole('button', { name: 'Switch when they finish' })).toHaveCount(0);
    expect(Date.now()).toBeLessThan(stored);
    await quitKeepRunning(first);

    // a grace of 36 seconds from the relaunch
    const relaunched = Date.now();
    const { app } = await launch({ env: { ...env, DAMOCLES_E2E_SERVER_REQUIREMENT: JSON.stringify({ minimumServerVersion: APP_VERSION, graceHours: 0.01 }) } });
    await recordToasts(app);
    await expect.poll(async () => (await hostUpdateOf(app, hostId))?.required?.deadline ?? Number.POSITIVE_INFINITY, { timeout: 30_000 }).toBeLessThan(stored);
    const deadline = (await hostUpdateOf(app, hostId))!.required!.deadline;
    expect(deadline).toBeGreaterThan(relaunched);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 36_000);
    const attaches = coreAttaches(home, hostId);
    let countdown: OverlayToast | undefined;
    await expect.poll(async () => (countdown = (await recordedPopupToasts(app)).find((toast) => toast.body.kind === 'notice' && toast.body.countdownTo === deadline)), { timeout: 30_000 }).toBeDefined();

    // the deadline switches with no confirmation: the agent stops, the terminal runs on
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect(await sleeping(fixture)).toBe(false);
    expect(mainLog(home)).toContain(`[update] switching from the daemon of ${OLD} at its deadline: 1 runs and 0 damocles --wait requests stop`);
    expect(mainLog(home)).not.toContain('[update] Switch now on ');
    await expect.poll(() => coreAttaches(home, hostId), { timeout: 120_000 }).toBeGreaterThan(attaches);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const resumed = await chatShowing(app, 'Stopped by the deadline');
    await expect(chatInput(resumed)).toBeVisible({ timeout: 60_000 });
    await expect(resumed.getByTestId('host-update-banner')).toHaveCount(0);
    await expect(resumed.getByTestId('tool-card').filter({ hasText: SLEEP })).toContainText('Stopped');
    await terminalStillRuns(app, fixture, terminal);
    expect(await hostUpdateOf(app, hostId)).toBeUndefined();

    // the countdown is withdrawn, and the forced switch says what it stopped
    expect(await dismissedToasts(app)).toContain(countdown!.id);
    await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message), { timeout: 30_000 })
      .toContainEqual(expect.stringMatching(/^The required update ran at \S.*\. 1 agent stopped; its chat is kept\.$/));
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('an app below the host\'s security floor shows the outdated state and starts no server', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  // a later release that requires itself: its daemon raises the host's floor to its own version
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: NEWER, minimumServerVersion: NEWER });
  const env = remoteEnv(ssh, mirror);
  const stub = await startTargetStub(home, fixture);
  try {
    const newer = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: NEWER } });
    const first = await connect(newer.app);
    expect(await daemonVersions(fixture)).toEqual([NEWER]);
    expect(await securityFloor(fixture)).toBe(NEWER);
    // a chat this computer keeps a copy of, which the older app shows read-only
    stub.replies.push({ chunks: ['Answered above the floor.'] });
    const tab = await newRemoteChat(newer.app, first.key);
    await sendPrompt(tab, 'Asked above the floor');
    await expect(tab.getByText('Answered above the floor.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await shutdownHostDaemon(newer.app, first.hostId, fixture);
    await newer.close();
  } finally {
    await stub.close();
  }

  const { app } = await launch({ env });
  const hostId = await hostIdOf(app);
  await expect.poll(() => hostUpdateOf(app, hostId), { timeout: 120_000 }).toMatchObject({ phase: 'appOutdated', outdated: 'floor', serverVersion: NEWER, targetVersion: APP_VERSION, runningAgents: 0, runningTerminals: 0 });
  const host = (await shellState(app)).hosts.find((candidate) => candidate.hostId === hostId)!;
  expect(host.connection).not.toBe('connected');
  expect(mainLog(home)).toContain(`connecting to host ${hostId} failed: belowFloor {"floor":"${NEWER}"}`);
  // this app's server is installed, and its bridge started none
  expect(await fixture.sh(`ls -d ${versionFolder(serverVersionOf(LINUX_TARGET))}`, 'dev')).toContain(versionFolder(serverVersionOf(LINUX_TARGET)));
  expect(await daemonVersions(fixture)).toEqual([]);

  // the chat reads from the session mirror, with the outdated composer card and the strip saying what this app needs
  const page = await openListedChat(app, 'Asked above the floor', 'Answered above the floor.');
  await expect(chatInput(page)).toHaveCount(0);
  const composer = page.getByTestId('composer-outdated');
  await expect(composer).toContainText('prod-1 needs a newer Damocles');
  await expect(composer).toContainText('This chat is read-only until this app updates. Its transcript is the copy this computer keeps.');
  const strip = page.getByTestId('host-update-banner');
  await expect(strip.getByRole('status')).toHaveText(`prod-1 needs Damocles ${NEWER} or later. Update this app to use it.`, { timeout: 60_000 });
  await expect(strip).toHaveAttribute('data-tone', 'warning');
  await expect(strip.getByRole('button', { name: 'Switch now' })).toHaveCount(0);
  // the unpackaged app has no updater
  await expect(strip.getByRole('button', { name: 'Check for updates' })).toHaveCount(0);

  // the badge: the warning diamond on the host's dot, whose tooltip says why
  const chip = (await shellPage(app)).getByTestId('title-bar-host');
  await expect(chip.getByTestId('host-status-dot')).toHaveAttribute('data-update', 'appOutdated');
  await expect(chip.getByTestId('host-status-dot')).toHaveAttribute('aria-label', /, update this app$/);
  await expect(chip.getByTestId('host-update-pip')).toHaveAttribute('data-pip', 'diamond');
  await expect(chip).toHaveAttribute('title', new RegExp(`\\nNeeds Damocles ${versionPattern(NEWER)} or later\\. Update this app to use it\\.$`));
  await expect(chip.getByTestId('host-update-tag')).toHaveCount(0);

  // the card reads not connected, says why, and offers nothing that would meet the floor again
  const overlay = await openConnect(app);
  await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
  const card = overlay.getByTestId('host-card');
  await expect(card.getByTestId('host-card-status')).toContainText('Not connected');
  await expect(card.getByTestId('host-update-lead')).toHaveText(`This host needs Damocles ${NEWER} or later. Update this app to use it.`);
  await expect(card.getByTestId('host-update-sub')).toHaveText(`This app is ${APP_VERSION}. A required update set ${NEWER} as the minimum on prod-1.`);
  await expect(card.getByTestId('host-status-dot').first()).toHaveAttribute('data-update', 'appOutdated');
  await expect(card.getByRole('button', { name: 'Switch now' })).toHaveCount(0);
  await expect(card.getByTestId('host-devices')).toHaveCount(0);
  await overlay.keyboard.press('Escape');

  // the reconnect loop stopped: no attempt within its first two retries' delays, and no server
  const attempts = (): number => mainLog(home).split('failed: belowFloor').length - 1;
  const before = attempts();
  expect((await shellState(app)).hosts.find((candidate) => candidate.hostId === hostId)?.reconnect).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, (RECONNECT_BACKOFF_S[1]! + RECONNECT_BACKOFF_S[2]!) * 1000 + ATTEMPT_SLACK_MS));
  expect(attempts()).toBe(before);
  expect((await shellState(app)).hosts.find((candidate) => candidate.hostId === hostId)?.reconnect).toBeUndefined();
  expect(await daemonVersions(fixture)).toEqual([]);
  expect(await securityFloor(fixture)).toBe(NEWER);
  expect(await hostUpdateOf(app, hostId)).toMatchObject({ phase: 'appOutdated', outdated: 'floor' });
  await expectNoAccountProcesses(app, hostId, fixture);
});

test('an app exactly at the host\'s security floor starts its server there, and one below it does not', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  // an earlier build of this version that requires its own version raises the floor to it; OLD is below it
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: APP_VERSION, minimumServerVersion: APP_VERSION });
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const env = remoteEnv(ssh, mirror);
  const earlier = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: APP_VERSION } });
  const raised = await connect(earlier.app);
  expect(await securityFloor(fixture)).toBe(APP_VERSION);
  await shutdownHostDaemon(earlier.app, raised.hostId, fixture);
  await earlier.close();

  // below the floor: the bridge starts no server
  const below = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
  const hostId = await hostIdOf(below.app);
  await expect.poll(() => hostUpdateOf(below.app, hostId), { timeout: 120_000 }).toMatchObject({ phase: 'appOutdated', outdated: 'floor', serverVersion: APP_VERSION, targetVersion: OLD });
  expect(mainLog(home)).toContain(`connecting to host ${hostId} failed: belowFloor {"floor":"${APP_VERSION}"}`);
  expect(await daemonVersions(fixture)).toEqual([]);
  await expectNoAccountProcesses(below.app, hostId, fixture);
  await below.close();

  // exactly at the floor: this app starts its own build's server, and the floor stays
  const { app } = await launch({ env });
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  expect(await daemonVersions(fixture)).toEqual([serverVersionOf(LINUX_TARGET)]);
  await expect.poll(() => hostUpdateOf(app, hostId), { timeout: 30_000 }).toBeUndefined();
  expect(await securityFloor(fixture)).toBe(APP_VERSION);
  await shutdownHostDaemon(app, hostId, fixture);
});
