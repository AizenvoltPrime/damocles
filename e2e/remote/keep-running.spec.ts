import type { ElectronApplication } from '@playwright/test';
import { readUserSettings, writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import type { OpenAIStub, StubReply } from '../desktop/support/openai-stub';
import { recordedPopupToasts, recordToasts } from '../desktop/support/shell';
import { awaitTurnEnd } from '../desktop/support/ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { allowSleep, chatShowing, closeRemoteDialog, exited, occurrences, requestQuit, sleeping, SLEEP, targetSessions } from './support/remote-runs';
import type { SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const CLOSE_SETTING = 'damocles.desktop.remote.closeWithRunningAgents';
// session-store/constants.ts DAMOCLES_TURN_STOPPED_ENTRY
const TURN_STOPPED = '"customType":"damocles-turn-stopped"';

/** A reply whose chunks after the first wait for `release(i)`, the hold before chunk i. */
function heldReply(chunks: string[]): { reply: StubReply; release: (before: number) => void } {
  const releases = new Map<number, () => void>();
  const holds = chunks.slice(1).map((_chunk, index) => ({ before: index + 1, until: new Promise<void>((resolve) => releases.set(index + 1, resolve)) }));
  return { reply: { chunks, holds }, release: (before) => releases.get(before)!() };
}

interface Connected {
  readonly hostId: string;
  readonly key: string;
}

async function connect(app: ElectronApplication): Promise<Connected> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

/** A new chat of the project whose turn streams `reply`'s first chunk and holds there. */
async function heldChat(app: ElectronApplication, key: string, stub: OpenAIStub, prompt: string, chunks: string[]): Promise<(before: number) => void> {
  const held = heldReply(chunks);
  stub.replies.push(held.reply);
  const tab = await newRemoteChat(app, key);
  await sendPrompt(tab, prompt);
  await expect(tab.getByText(chunks[0]!, { exact: false })).toBeVisible({ timeout: 60_000 });
  return held.release;
}

/** A new chat whose turn is running SLEEP on the target, the tool call in flight. */
async function sleepingChat(app: ElectronApplication, key: string, stub: OpenAIStub, fixture: SshdFixture, prompt: string): Promise<void> {
  await allowSleep(fixture);
  stub.replies.push({ chunks: ['Running the long command.'], toolCalls: [{ name: 'bash', arguments: { command: SLEEP } }] });
  const tab = await newRemoteChat(app, key);
  await sendPrompt(tab, prompt);
  await expect.poll(() => sleeping(fixture), { timeout: 60_000 }).toBe(true);
}

async function hostIdOf(app: ElectronApplication): Promise<string> {
  const hosts = await app.evaluate(() => (globalThis as unknown as { __damoclesE2e: { remote: { hosts(): Array<{ hostId: string }> } } }).__damoclesE2e.remote.hosts());
  expect(hosts).toHaveLength(1);
  return hosts[0]!.hostId;
}

async function reconnectNow(app: ElectronApplication, hostId: string): Promise<void> {
  await app.evaluate((_electron, authorityKey) => (globalThis as unknown as { __damoclesE2e: { remote: { reconnectNow(key: string): void } } }).__damoclesE2e.remote.reconnectNow(authorityKey), `ssh+${hostId}`);
}

async function withStub(home: HermeticHome, fixture: SshdFixture, body: (stub: OpenAIStub) => Promise<void>): Promise<void> {
  const stub = await startTargetStub(home, fixture);
  try {
    await body(stub);
  } finally {
    await stub.close();
  }
}

test('quitting during remote turns asks with their live status; Keep running exits while the target finishes them, and a relaunch catches up, keeps streaming and names the chats that finished meanwhile', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await withStub(home, fixture, async (stub) => {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { hostId, key } = await connect(first.app);
    // Alpha still streams after the relaunch, Bravo finishes while the app is closed, Charlie while the dialog is open.
    const alpha = await heldChat(first.app, key, stub, 'Alpha prompt', ['Alpha one.', ' Alpha two.', ' Alpha three.']);
    const bravo = await heldChat(first.app, key, stub, 'Bravo prompt', ['Bravo one.', ' Bravo two.']);
    const charlie = await heldChat(first.app, key, stub, 'Charlie prompt', ['Charlie one.', ' Charlie two.']);

    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    const rows = dialog.getByTestId('close-remote-row');
    await expect(rows).toHaveCount(3);
    // a row names its conversation as Chats does, never the core's panel by its id or its page title
    await expect(rows.getByText(/^(host-\d+|Damocles)$/)).toHaveCount(0);
    await expect(rows.and(dialog.locator('[data-status="running"]'))).toHaveCount(3);
    await expect(dialog.getByRole('button', { name: 'Keep running' })).toBeFocused();
    // the pills follow activity while the dialog is open
    charlie(1);
    await expect(rows.and(dialog.locator('[data-status="idle"]'))).toHaveCount(1, { timeout: 60_000 });
    await expect(rows.and(dialog.locator('[data-status="idle"]')).getByTestId('close-remote-status')).toHaveText('Finished');
    await expect(rows.and(dialog.locator('[data-status="running"]'))).toHaveCount(2);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);

    // Closed: the daemon keeps both turns; Bravo finishes and its session file says so, Alpha streams on.
    expect(await daemonPids(fixture)).toHaveLength(1);
    bravo(1);
    alpha(1);
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Bravo one. Bravo two.');
    expect(await targetSessions(fixture)).not.toContain('Alpha one. Alpha two. Alpha three.');

    // Relaunched with the host unreachable until the toasts are recorded, so the reattach's notification is seen.
    await fixture.stopSshd();
    const second = await launch(env);
    const app = second.app;
    await recordToasts(app);
    await fixture.startSshd();
    await reconnectNow(app, hostId);
    await expect.poll(async () => (await recordedPopupToasts(app)).filter((toast) => JSON.stringify(toast.body).includes('1 chat on prod-1 finished while you were away')).length, { timeout: 120_000 }).toBe(1);
    const away = (await recordedPopupToasts(app)).find((toast) => JSON.stringify(toast.body).includes('finished while you were away'))!;
    // one action per finished chat: Bravo only, since Alpha still runs and Charlie finished before the app closed
    expect(JSON.stringify(away.body)).not.toContain('Charlie');
    expect((away.body as { actions?: readonly unknown[] }).actions).toHaveLength(1);

    // Alpha catches up to the daemon's text and keeps streaming: every part once, none missing.
    const alphaPage = await chatShowing(app, 'Alpha one. Alpha two.');
    alpha(2);
    await expect(alphaPage.getByText('Alpha one. Alpha two. Alpha three.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(alphaPage);
    for (const part of ['Alpha one.', 'Alpha two.', 'Alpha three.']) expect(await occurrences(alphaPage, part)).toBe(1);
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Alpha one. Alpha two. Alpha three.');
    await shutdownHostDaemon(app, hostId, fixture);
  });
});

test('Don\'t ask again with Keep running keeps silently at the next quit, and the stop setting stops silently', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await withStub(home, fixture, async (stub) => {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { key } = await connect(first.app);
    const one = await heldChat(first.app, key, stub, 'First prompt', ['First part.', ' First end.']);
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('checkbox', { name: 'Don\'t ask again' }).check();
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);
    expect(readUserSettings(home)[CLOSE_SETTING]).toBe('keep');
    one(1);
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('First part. First end.');

    // keep: the next quit during a turn asks nothing and the turn finishes on the target
    const second = await launch(env);
    const hostId = await hostIdOf(second.app);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    const two = await heldChat(second.app, key, stub, 'Second prompt', ['Second part.', ' Second end.']);
    await requestQuit(second.app);
    await exited(second);
    two(1);
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Second part. Second end.');

    // stop: the next quit stops the turn without asking, and the stop is recorded on the target
    writeUserSettings(home, { ...readUserSettings(home), [CLOSE_SETTING]: 'stop' });
    const third = await launch(env);
    await remoteProjectKey(third.app, { authorityKey: `ssh+${hostId}` }, APP);
    await sleepingChat(third.app, key, stub, fixture, 'Third prompt');
    expect(await targetSessions(fixture)).not.toContain(TURN_STOPPED);
    await requestQuit(third.app);
    await exited(third);
    expect(await targetSessions(fixture)).toContain(TURN_STOPPED);
    expect(await sleeping(fixture)).toBe(false);

    const last = await launch(env);
    await remoteProjectKey(last.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(last.app, hostId, fixture);
  });
});

test('Stop agents stops the remote turn and records the stop before the app quits', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await withStub(home, fixture, async (stub) => {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { hostId, key } = await connect(first.app);
    await sleepingChat(first.app, key, stub, fixture, 'Stop me');
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('button', { name: 'Stop agents' }).click();
    await exited(first);
    // the Stop path ended the tool call and recorded the stop before the app quit
    expect(await targetSessions(fixture)).toContain(TURN_STOPPED);
    expect(await sleeping(fixture)).toBe(false);

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  });
});

test('an OS shutdown during a remote turn keeps the run without a dialog', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await withStub(home, fixture, async (stub) => {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { hostId, key } = await connect(first.app);
    const held = await heldChat(first.app, key, stub, 'Through the shutdown', ['Before shutdown.', ' After shutdown.']);
    await first.app.evaluate(() => {
      const hooks = (globalThis as unknown as { __damoclesE2e: { remote: { simulateShutdown(kind: 'os' | 'quitAndInstall'): void } } }).__damoclesE2e.remote;
      setImmediate(() => hooks.simulateShutdown('os'));
    });
    await exited(first);
    held(1);
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Before shutdown. After shutdown.');
    expect(await targetSessions(fixture)).not.toContain(TURN_STOPPED);

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  });
});
