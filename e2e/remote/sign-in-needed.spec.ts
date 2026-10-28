import type { ElectronApplication } from '@playwright/test';
import { mainLog } from '../desktop/support/app';
import { writeUserSettings } from '../desktop/support/hermetic';
import { cleanUp } from '../desktop/support/loopback';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { STUB_MODEL_ID, type OpenAIStub, type StubReply } from '../desktop/support/openai-stub';
import { shellPage, shellState } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { awaitTurnEnd } from '../desktop/support/ui';
import { MIN_VALIDITY_MS } from '../../src/core/pi-session/credential-broker';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { holdFor } from './support/flaky';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { chatShowing, closeRemoteDialog, exited, requestQuit, stubOAuth, targetCoreLog, targetSessions } from './support/remote-runs';
import { secondDevice } from './support/second-device';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// pi's ls, read-only, so the turn's second model request follows without a prompt
const LIST = { name: 'ls', arguments: { path: '.' } };
const CARD_BODY = /Sign in to .+ on a computer connected to prod-1\./;
// above pi's minimum validity, so the turn starts on it, and that much longer than it, so it expires within the test
const TOKEN_MS = MIN_VALIDITY_MS + 90_000;

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

/** A first reply that holds after its text, then asks for `ls`, whose result makes the turn's second model request. */
function toolTurn(first: string, second: string): { replies: StubReply[]; release: () => void } {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { replies: [{ chunks: [first], toolCalls: [LIST], holdAfterFirst: held }, { chunks: [second] }], release };
}

// the turn's model request that carries the ls result, as opposed to its first one and any title sub-call
const afterTool = (stub: OpenAIStub): string | undefined => stub.requests.filter((request) => JSON.stringify(request.body).includes('"role":"tool"')).at(-1)?.authorization;

const bearers = (stub: OpenAIStub, account: string): number => stub.requests.filter((request) => request.authorization?.startsWith(`Bearer e2e-oauth-${account}-`)).length;

test('with this computer offline when the quit dialog opens, the row shows how long its token stays valid; online, Keep running pushes a fresh token before the app exits', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { app } = first;
    await stubOAuth(app, 'alice', 23.5 * 60_000);
    const { hostId, key } = await connect(app);
    let release!: () => void;
    stub.replies.push({ chunks: ['Token part.', ' Token end.'], holdAfterFirst: new Promise<void>((resolve) => (release = resolve)) });
    const tab = await newRemoteChat(app, key);
    await sendPrompt(tab, 'Use the token');
    await expect(tab.getByText('Token part.', { exact: false })).toBeVisible({ timeout: 60_000 });
    expect(bearers(stub, 'alice')).toBeGreaterThan(0);

    await stubOAuth(app, 'alice', 23.5 * 60_000, true);
    await requestQuit(app);
    const { dialog } = await closeRemoteDialog(app);
    await expect(dialog.getByTestId('close-remote-token-note')).toHaveText(/token valid for 23 min$/, { timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    // a quit asked before the cancelled one has unwound joins it, so the next quit waits for the cancel to land
    await expect.poll(() => mainLog(home)).toContain('[shutdown] cancelled');

    // back online: Keep running refreshes the token the run used and pushes it to the target before the app exits
    await stubOAuth(app, 'alice', 23.5 * 60_000, false);
    await requestQuit(app);
    await (await closeRemoteDialog(app)).dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);
    expect(await targetCoreLog(fixture)).toMatch(/\[credential-broker\] openai: \S+ pushed an access token/);
    release();
    await expect.poll(() => targetSessions(fixture), { timeout: 60_000 }).toContain('Token part. Token end.');

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('offline when the quit dialog opens, Keep running leaves the run on the token the row showed, and it waits with Sign-in needed once that token expires', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    await stubOAuth(first.app, 'alice', TOKEN_MS);
    const issuedBy = Date.now();
    const { hostId, key } = await connect(first.app);
    const turn = toolTurn('Before the expiry.', 'After a sign-in.');
    stub.replies.push(...turn.replies);
    const tab = await newRemoteChat(first.app, key);
    await sendPrompt(tab, 'Run on the token you have');
    await expect(tab.getByText('Before the expiry.', { exact: false })).toBeVisible({ timeout: 60_000 });

    // offline: the refresh fails, so the row tells how long the token the run holds stays valid
    await stubOAuth(first.app, 'alice', TOKEN_MS, true);
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    const note = dialog.getByTestId('close-remote-token-note');
    await expect(note).toHaveText(/token valid for \d+ min$/, { timeout: 60_000 });
    const minutes = Number(/(\d+) min$/.exec((await note.textContent()) ?? '')![1]);
    expect(minutes).toBeGreaterThanOrEqual(Math.floor(TOKEN_MS / 60_000) - 1);
    expect(minutes).toBeLessThanOrEqual(Math.floor(TOKEN_MS / 60_000));
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);
    expect(mainLog(home)).toMatch(/\[keep-running\] refreshing openai failed/);

    // the token's lifetime is the scenario: once less than pi's minimum validity is left it counts as expired
    await holdFor(issuedBy + TOKEN_MS - MIN_VALIDITY_MS + 5000 - Date.now());
    turn.release();
    await expect.poll(() => targetCoreLog(fixture), { timeout: 120_000 }).toMatch(/\[credential-broker\] openai: the turn's device \S+ is not attached; waiting for its sign-in/);
    expect(afterTool(stub)).toBeUndefined();
    expect(await targetSessions(fixture)).not.toContain('After a sign-in.');

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('a token that expires while the app is closed makes the turn wait for its device, and that device attaching again resumes it', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    await stubOAuth(first.app, 'alice', 60_000);
    const { hostId, key } = await connect(first.app);
    const turn = toolTurn('Before the expiry.', 'Resumed after sign-in.');
    stub.replies.push(...turn.replies);
    const tab = await newRemoteChat(first.app, key);
    await sendPrompt(tab, 'Outlive the token');
    await expect(tab.getByText('Before the expiry.', { exact: false })).toBeVisible({ timeout: 60_000 });

    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);

    // the turn's next model request needs a fresh token from the device that is gone: it waits, it does not fail
    turn.release();
    await expect.poll(() => targetCoreLog(fixture), { timeout: 120_000 }).toMatch(/\[credential-broker\] openai: the turn's device \S+ is not attached; waiting for its sign-in/);
    expect(await targetSessions(fixture)).not.toContain('Resumed after sign-in.');

    // the same device back, signed in again before it attaches: the wait resolves and the turn finishes with its token
    await fixture.stopSshd();
    const second = await launch(env);
    await stubOAuth(second.app, 'alice', 60_000);
    await fixture.startSshd();
    await second.app.evaluate((_electron, authorityKey) => (globalThis as unknown as { __damoclesE2e: { remote: { reconnectNow(key: string): void } } }).__damoclesE2e.remote.reconnectNow(authorityKey), `ssh+${hostId}`);
    const resumed = await chatShowing(second.app, 'Resumed after sign-in.');
    await awaitTurnEnd(resumed);
    await expect.poll(() => targetCoreLog(fixture)).toMatch(/\[credential-broker\] openai: \S+ answered oauth/);
    expect(afterTool(stub)).toMatch(/^Bearer e2e-oauth-alice-/);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('another attached device shows Sign-in needed with Continue with my sign-in, and only that click moves the turn to its own token', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    writeUserSettings(other.home, { 'damocles.model': STUB_MODEL_ID });
    const first = await launch({ env: remoteEnv(ssh, mirror) });
    await stubOAuth(first.app, 'alice', 60_000);
    const { key } = await connect(first.app);
    const turn = toolTurn('Started on the first device.', 'Continued on the other device.');
    stub.replies.push(...turn.replies);
    const tab = await newRemoteChat(first.app, key);
    await sendPrompt(tab, 'Hand me over');
    await expect(tab.getByText('Started on the first device.', { exact: false })).toBeVisible({ timeout: 60_000 });

    // the other device opens the same chat
    const device = await other.launch();
    await stubOAuth(device.app, 'bob', 60_000);
    const { hostId: otherHostId, key: otherKey } = await connect(device.app);
    let chatId = '';
    // the first device's chat, by the title its first prompt gave it
    await expect.poll(async () => (chatId = (await listChats(device.app, otherKey)).chats.find((chat) => !chat.loaded && chat.title === 'Hand me over')?.id ?? ''), { timeout: 60_000 }).not.toBe('');
    // a chat id names a chat of the selected project's host: pick the project, then its chat, as a user does
    const shell = await shellPage(device.app);
    await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), otherKey);
    await expect.poll(async () => (await shellState(device.app)).selected.projectKey).toBe(otherKey);
    expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
    const joined = await chatShowing(device.app, 'Started on the first device.');

    // the first device leaves; the turn's next request waits for it and the other device is offered the turn
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);
    turn.release();
    const card = joined.getByRole('region', { name: 'Sign-in needed' });
    await expect(card).toBeVisible({ timeout: 120_000 });
    await expect(card).toContainText(CARD_BODY);
    expect(bearers(stub, 'bob')).toBe(0);

    await card.getByRole('button', { name: 'Continue with my sign-in' }).click();
    await expect(joined.getByText('Continued on the other device.', { exact: false })).toBeVisible({ timeout: 60_000 });
    await expect(card).toBeHidden();
    await awaitTurnEnd(joined);
    await expect.poll(() => targetCoreLog(fixture)).toMatch(/\[credential-broker\] openai: the turn moved from \S+ to \S+ at that device's request/);
    expect(afterTool(stub)).toMatch(/^Bearer e2e-oauth-bob-/);
    await shutdownHostDaemon(device.app, otherHostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
    await stub.close();
  }
});
