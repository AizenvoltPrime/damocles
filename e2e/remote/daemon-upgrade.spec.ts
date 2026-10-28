import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { filesUnder } from '../desktop/support/loopback';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { shellPage } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { awaitTurnEnd } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { daemonVersions, installOlderServer, versionFolder } from './support/older-server';
import { APP_VERSION } from './support/release-mirror';
import { addHost, control, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { allowSleep, chatShowing, closeRemoteDialog, exited, requestQuit, sleeping, SLEEP, targetSessions } from './support/remote-runs';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// The reference server package: the oldest protocol peer, built from the tag remote-protocol-ref by
// e2e/remote/support/reference-package.mjs (pr.yml and release.yml build it; locally run that script and set this variable).
const REFERENCE = process.env['DAMOCLES_E2E_REFERENCE_PACKAGE'];
const APP = '/srv/app';
const TURN_STOPPED = '"customType":"damocles-turn-stopped"';

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
    // a tool call in flight, which the Stop path cuts short and records
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
    expect(await fixture.sh(`test -x '${versionFolder(APP_VERSION)}/bin/damocles-server' && test -d '${versionFolder(reference)}' && echo both`, 'dev')).toContain('both');
    await chatShowing(app, 'Reference running.');

    // the frozen listRuns: the running chat, with the provider its broker used
    const { runs } = (await control(app, hostId, 'listRuns')) as { runs: Array<{ kind: string; state: string; providers: string[] }> };
    expect(runs.filter((run) => run.kind === 'chat').map((run) => ({ state: run.state, providers: run.providers }))).toEqual([{ state: 'running', providers: ['openai'] }]);
    // mirror.sync brought the reference's transcripts to this computer
    const mirrorRoot = path.join(home.userData, 'remote', hostId, 'mirror');
    await expect.poll(() => mirrorHolds(mirrorRoot, ['Reference finished reply.', 'Finish on the reference']), { timeout: 60_000 }).toBe(true);

    // the frozen shutdownNow stops the run through the Stop path and ends the reference daemon
    await shutdownHostDaemon(app, hostId, fixture);
    expect(await targetSessions(fixture)).toContain(TURN_STOPPED);
    expect(await sleeping(fixture)).toBe(false);

    // the next connection starts this app's own version, and the reference's chats open on it from the Chats list
    await openRemoteFolder(app, hostId, APP);
    expect(await daemonVersions(fixture)).toEqual([APP_VERSION]);
    let chatId = '';
    await expect.poll(async () => (chatId = (await listChats(app, key)).chats.find((chat) => chat.title === 'Finish on the reference')?.id ?? ''), { timeout: 60_000 }).not.toBe('');
    expect(await (await shellPage(app)).evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
    await chatShowing(app, 'Reference finished reply.');
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
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
    // shutdownWhenIdle: the reference exits after its last run, and the reconnect starts this app's version
    await expect.poll(() => daemonVersions(fixture), { timeout: 120_000 }).toEqual([APP_VERSION]);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const after = await chatShowing(app, 'Reference part one. Reference part two.');
    await awaitTurnEnd(after);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
