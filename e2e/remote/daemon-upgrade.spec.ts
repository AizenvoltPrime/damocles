import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { writeUserSettings } from '../desktop/support/hermetic';
import { filesUnder } from '../desktop/support/loopback';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { shellPage } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { activeTerminal, openTerminal, readFromTerminal, runInTerminal, terminalText, waitForOutputLine } from '../desktop/support/terminal';
import { awaitTurnEnd, chatInput } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { daemonVersions, installOlderServer, terminalHostVersions, versionFolder } from './support/older-server';
import { LINUX_TARGET, serverVersionOf } from './support/release-mirror';
import { addHost, control, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { allowSleep, chatShowing, closeRemoteDialog, exited, requestQuit, sleeping, SLEEP } from './support/remote-runs';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// The reference server package: the oldest protocol peer, built from the tag remote-protocol-ref by
// e2e/remote/support/reference-package.mjs (pr.yml and release.yml build it; locally run that script and set this variable).
const REFERENCE = process.env['DAMOCLES_E2E_REFERENCE_PACKAGE'];
const APP = '/srv/app';

function referencePackage(): string {
  if (REFERENCE === undefined || !fs.existsSync(REFERENCE)) {
    throw new Error('DAMOCLES_E2E_REFERENCE_PACKAGE names no reference server package; build one with `node e2e/remote/support/reference-package.mjs --ref remote-protocol-ref --target linux-x64 --out <empty folder>`');
  }
  return REFERENCE;
}

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

async function openListedChat(app: ElectronApplication, projectKey: string, title: string, showing: string): Promise<Page> {
  let chatId = '';
  await expect.poll(async () => (chatId = (await listChats(app, projectKey)).chats.find((chat) => chat.title === title)?.id ?? ''), { timeout: 60_000 }).not.toBe('');
  expect(await (await shellPage(app)).evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
  return chatShowing(app, showing);
}

/** Whether the host's session mirror on this computer holds every one of `needles`. */
function mirrorHolds(root: string, needles: readonly string[]): boolean {
  if (!fs.existsSync(root)) return false;
  const text = filesUnder(root).filter((file) => file.endsWith('.jsonl')).map((file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8')).join('\n');
  return needles.every((needle) => text.includes(needle));
}

test('this tree\'s app attaches to the reference server package\'s busy daemon, lists and stops its runs through the frozen subset, mirrors its transcripts and then runs its own version', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const reference = await installOlderServer(fixture, referencePackage());
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    // The reference's own app version starts its daemon: one finished chat and one still running when it quits.
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: reference } });
    const { key } = await connect(old.app);
    expect(await daemonVersions(fixture)).toEqual([reference]);
    stub.replies.push({ chunks: ['Reference finished reply.'] });
    const done = await newRemoteChat(old.app, key);
    await sendPrompt(done, 'Finish on the reference');
    await expect(done.getByText('Reference finished reply.', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(done);
    // a tool call in flight, which the shutdown cuts short
    await allowSleep(fixture);
    stub.replies.push({ chunks: ['Reference running.'], toolCalls: [{ name: 'bash', arguments: { command: SLEEP } }] });
    const running = await newRemoteChat(old.app, key);
    await sendPrompt(running, 'Keep running on the reference');
    await expect.poll(() => sleeping(fixture), { timeout: 60_000 }).toBe(true);
    await requestQuit(old.app);
    const { dialog } = await closeRemoteDialog(old.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(old);

    // This tree's app: its own version installs beside the reference, whose running daemon it attaches to.
    const current = await launch({ env });
    const app = current.app;
    const hostId = await hostIdOf(app);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    expect(await daemonVersions(fixture)).toEqual([reference]);
    expect(await fixture.sh(`test -x '${versionFolder(serverVersionOf(LINUX_TARGET))}/bin/damocles-server' && test -d '${versionFolder(reference)}' && echo both`, 'dev')).toContain('both');
    await chatShowing(app, 'Reference running.');

    // the frozen listRuns: the running chat, with the provider its broker used
    const { runs } = (await control(app, hostId, 'listRuns')) as { runs: Array<{ kind: string; state: string; providers: string[] }> };
    expect(runs.filter((run) => run.kind === 'chat').map((run) => ({ state: run.state, providers: run.providers }))).toEqual([{ state: 'running', providers: ['openai'] }]);
    // mirror.sync brought the reference's transcripts to this computer
    const mirrorRoot = path.join(home.userData, 'remote', hostId, 'mirror');
    await expect.poll(() => mirrorHolds(mirrorRoot, ['Reference finished reply.', 'Finish on the reference']), { timeout: 60_000 }).toBe(true);

    // the frozen shutdownNow ends the reference daemon, whose core aborts the run as it disposes the chat
    await shutdownHostDaemon(app, hostId, fixture);
    expect(await sleeping(fixture)).toBe(false);

    // the next connection starts this build's server, and the reference's chats open on it from the Chats list
    await openRemoteFolder(app, hostId, APP);
    expect(await daemonVersions(fixture)).toEqual([serverVersionOf(LINUX_TARGET)]);
    await openListedChat(app, key, 'Finish on the reference', 'Reference finished reply.');
    // this build's core replays the cut-off call from the reference's session file, whose stopped-result marker names it stopped
    const stopped = await openListedChat(app, key, 'Keep running on the reference', 'Reference running.');
    await expect(chatInput(stopped)).toBeVisible({ timeout: 60_000 });
    await expect(stopped.getByTestId('tool-card').filter({ hasText: SLEEP })).toContainText('Stopped');
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('this tree\'s daemon adopts the reference package\'s terminal host: the reference\'s shell comes back in its tab with its screen and the same pid, and takes input', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const reference = await installOlderServer(fixture, referencePackage());
  const env = remoteEnv(ssh, mirror);
  // The reference's own app version starts its daemon, whose terminal host holds one shell when the app quits.
  const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: reference } });
  await connect(old.app);
  const shell = await openTerminal(old.app);
  const id = (await activeTerminal(shell).getAttribute('data-terminal-id'))!;
  await runInTerminal(shell, "echo shell''-pid-$$");
  const pid = await readFromTerminal(shell, /^shell-pid-(\d+)$/m);
  expect(await terminalHostVersions(fixture)).toEqual([reference]);
  await old.close();
  expect(await daemonVersions(fixture)).toEqual([reference]);

  // This tree's app hands the reference daemon over, since no agent runs on it, and its own daemon adopts the host through
  // the frozen terminal host contract.
  const { app } = await launch({ env });
  const hostId = await hostIdOf(app);
  await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  expect(await terminalHostVersions(fixture)).toEqual([reference]);
  expect(((await control(app, hostId, 'listRuns')) as { runs: Array<{ kind: string; id: string }> }).runs.filter((run) => run.kind === 'terminal').map((run) => run.id)).toEqual([id]);
  const adopted = await shellPage(app);
  await expect(activeTerminal(adopted)).toHaveAttribute('data-terminal-id', id, { timeout: 60_000 });
  await expect(activeTerminal(adopted)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
  await expect.poll(async () => (await terminalText(adopted)).split('\n').filter((row) => row === `shell-pid-${pid}`), { timeout: 30_000 }).toHaveLength(1);
  await runInTerminal(adopted, "echo again''-$$");
  await waitForOutputLine(adopted, `again-${pid}`);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('with a run on the reference daemon, this tree\'s app streams it, and once it finishes the reference exits and the next connection runs this app\'s version', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const reference = await installOlderServer(fixture, referencePackage());
  const stub = await startTargetStub(home, fixture);
  try {
    const env = remoteEnv(ssh, mirror);
    const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: reference } });
    const { key } = await connect(old.app);
    let release!: () => void;
    stub.replies.push({ chunks: ['Reference part one.', ' Reference part two.'], holdAfterFirst: new Promise<void>((resolve) => (release = resolve)) });
    const tab = await newRemoteChat(old.app, key);
    await sendPrompt(tab, 'Stream across the update');
    await expect(tab.getByText('Reference part one.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await requestQuit(old.app);
    const { dialog } = await closeRemoteDialog(old.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(old);

    const { app } = await launch({ env });
    const hostId = await hostIdOf(app);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    await chatShowing(app, 'Reference part one.');
    expect(await daemonVersions(fixture)).toEqual([reference]);
    release();
    // the reference's last run ending can switch the host at once, which replaces the page; any chat page may show it
    await chatShowing(app, 'Reference part one. Reference part two.');
    // shutdownWhenIdle: the reference exits after its last run, and the reconnect starts this build
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([serverVersionOf(LINUX_TARGET)]);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const after = await chatShowing(app, 'Reference part one. Reference part two.');
    await awaitTurnEnd(after);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
