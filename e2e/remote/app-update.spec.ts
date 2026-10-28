import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopApp } from '../desktop/support/app';
import { writeUserSettings } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import type { OpenAIStub } from '../desktop/support/openai-stub';
import { confirmDialog } from '../desktop/support/overlay';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { openTerminal, runInTerminal } from '../desktop/support/terminal';
import { awaitTurnEnd, chatInput } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { daemonVersions, installOlderServer, versionFolder } from './support/older-server';
import { APP_VERSION, LINUX_TARGET, SERVER_PACKAGES_DIR, serverPackage } from './support/release-mirror';
import { addHost, control, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { allowSleep, chatShowing, closeRemoteDialog, exited, requestQuit, sleeping, SLEEP, targetSessions } from './support/remote-runs';
import type { SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// The app before the update: this tree's server package installed as OLD (and for the protocol cases its daemon's
// PROTOCOL_VERSION set to OTHER_PROTOCOL), driven by a launch that runs as that version through the e2e hooks.
const OLD = '3.6.9';
const OTHER_PROTOCOL = 2;
const APP = '/srv/app';
const CURRENT_PACKAGE = path.join(SERVER_PACKAGES_DIR, serverPackage(LINUX_TARGET));
const TURN_STOPPED = '"customType":"damocles-turn-stopped"';

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

async function terminalSleeping(fixture: Pick<SshdFixture, 'sh'>): Promise<boolean> {
  return (await fixture.sh(`pgrep -u dev -f '^${TERMINAL_SLEEP}$' || true`)).trim() !== '';
}

/** A terminal on the target whose process is TERMINAL_SLEEP. */
async function sleepingTerminal(app: ElectronApplication, fixture: Pick<SshdFixture, 'sh'>): Promise<void> {
  const shell = await openTerminal(app);
  await runInTerminal(shell, `exec ${TERMINAL_SLEEP}`);
  await expect.poll(() => terminalSleeping(fixture), { timeout: 30_000 }).toBe(true);
}

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

test('after an update the app attaches to the busy older daemon of its protocol and streams its chat; a terminal delays the switch until it ends, then the next connection runs the new version', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
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
    const live = await chatShowing(app, 'Update part one.');
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    // installing the new version pruned nothing the running daemon uses
    expect(await fixture.sh(`test -x '${versionFolder(APP_VERSION)}/bin/damocles-server' && test -x '${versionFolder(OLD)}/bin/damocles-server' && echo both`, 'dev')).toContain('both');

    release();
    await expect(live.getByText('Update part one. Update part two.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(live);
    // the terminal keeps the old daemon: its registry holds the terminal alone
    await expect.poll(async () => ((await control(app, hostId, 'listRuns')) as { runs: Array<{ kind: string }> }).runs.map((run) => run.kind), { timeout: 60_000 }).toEqual(['terminal']);
    expect(await daemonVersions(fixture)).toEqual([OLD]);

    await fixture.sh(`pkill -u dev -f '^${TERMINAL_SLEEP}$'`);
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([APP_VERSION]);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await chatShowing(app, 'Update part one. Update part two.');
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
  await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([APP_VERSION]);
  await shutdownHostDaemon(app, hostId, fixture);
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
    await expect(banner.getByRole('status')).toHaveText(`prod-1 is running 2 agents on Damocles ${OLD}`, { timeout: 60_000 });
    expect(await daemonVersions(fixture)).toEqual([OLD]);

    // mirror.sync keeps the read-only transcript live
    releaseSecond();
    await expect(page.getByText('Second old one. Second old two.', { exact: false })).toBeVisible({ timeout: 120_000 });
    await expect(banner.getByRole('status')).toHaveText(`prod-1 is running 1 agent on Damocles ${OLD}`, { timeout: 60_000 });

    await banner.getByRole('button', { name: 'Switch when they finish' }).click();
    await expect(banner.getByRole('status')).toHaveText('Waiting for the agents on prod-1 to finish');
    expect(await daemonVersions(fixture)).toEqual([OLD]);
    releaseFirst();
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([APP_VERSION]);
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

test('Switch now confirms with the old daemon\'s running agents and terminals, stops them through the Stop path and runs the new version', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD, protocolVersion: OTHER_PROTOCOL });
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD, DAMOCLES_E2E_PROTOCOL_VERSION: String(OTHER_PROTOCOL) } });
    const { key } = await connect(old.app);
    await sleepingTerminal(old.app, fixture);
    await allowSleep(fixture);
    stub.replies.push({ chunks: ['Running the long command.'], toolCalls: [{ name: 'bash', arguments: { command: SLEEP } }] });
    await sendPrompt(await newRemoteChat(old.app, key), 'Stopped by the switch');
    await expect.poll(() => sleeping(fixture), { timeout: 60_000 }).toBe(true);
    await quitKeepRunning(old);

    const { app } = await launch({ env });
    const hostId = await hostIdOf(app);
    const page = await openListedChat(app, 'Stopped by the switch', 'Stopped by the switch');
    const banner = page.getByTestId('host-update-banner');
    await expect(banner.getByRole('status')).toHaveText(`prod-1 is running 1 agent on Damocles ${OLD}`, { timeout: 60_000 });
    await banner.getByRole('button', { name: 'Switch now' }).click();
    const confirm = confirmDialog(await overlayPage(app));
    await expect(confirm).toContainText(`Switch prod-1 to Damocles ${APP_VERSION} now?`);
    await expect(confirm).toContainText('These agents stop and these terminals close.');
    await expect(confirm.getByText(/^Agent: /)).toHaveCount(1);
    await expect(confirm.getByText(/^Terminal: /)).toHaveCount(1);
    await confirm.getByRole('button', { name: 'Switch now' }).click();

    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([APP_VERSION]);
    expect(await targetSessions(fixture)).toContain(TURN_STOPPED);
    expect(await sleeping(fixture)).toBe(false);
    expect(await terminalSleeping(fixture)).toBe(false);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await expect(chatInput(await chatShowing(app, 'Stopped by the switch'))).toBeVisible({ timeout: 60_000 });
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
