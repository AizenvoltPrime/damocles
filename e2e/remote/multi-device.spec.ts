import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { writeUserSettings } from '../desktop/support/hermetic';
import { cleanUp } from '../desktop/support/loopback';
import { mergeJson, sendPrompt } from '../desktop/support/loopback-agent';
import { STUB_MODEL_ID, type OpenAIStub, type RecordedRequest } from '../desktop/support/openai-stub';
import { shellPage, shellState } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { activeTerminal, openTerminal, runInTerminal, waitForOutputLine } from '../desktop/support/terminal';
import { awaitTurnEnd } from '../desktop/support/ui';
import { openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, control, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { chatShowing, occurrences, stubOAuth, targetSessions } from './support/remote-runs';
import { secondDevice } from './support/second-device';
import { TARGET_HOME, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// each device's stub ChatGPT sign-in: its first token, valid well past the test
const FIRST_TOKEN = 'Bearer e2e-oauth-alice-1';
const SECOND_TOKEN = 'Bearer e2e-oauth-bob-1';
const TOKEN_MS = 60 * 60_000;
const DENIED = 'printf device-deny-%s ok';
const ADVICE = 'People who share a server account share its chats, files and tokens. Give each person their own account on prod-1.';

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  // openFolder fails on any prompt, so attaching beside another device asks no approval
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

/** Opens the other device's chat on this device, as picking it in the chat list does. */
async function openOtherDevicesChat(app: ElectronApplication, key: string, title: string, showing: string): Promise<Page> {
  let chatId = '';
  // the other device's chat, by the title its first prompt gave it
  await expect.poll(async () => (chatId = (await listChats(app, key)).chats.find((chat) => !chat.loaded && chat.title === title)?.id ?? ''), { timeout: 60_000 }).not.toBe('');
  // a chat id names a chat of the selected project's host: pick the project, then its chat, as a user does
  const shell = await shellPage(app);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(key);
  expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
  return chatShowing(app, showing);
}

/** The text of a request's last user message: which prompt the model request belongs to. */
function lastUserText(request: RecordedRequest): string {
  const messages = (request.body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [];
  const content = messages.filter((message) => message.role === 'user').at(-1)?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : '';
}

/** The Authorization values every model request of the turn prompted with `prompt` carried. */
const keysOfTurn = (stub: OpenAIStub, prompt: string): string[] => [...new Set(stub.requests.filter((request) => lastUserText(request).includes(prompt)).map((request) => request.authorization ?? ''))];

const toolResults = (stub: OpenAIStub): string[] => stub.requests.flatMap((request) => ((request.body as { messages?: Array<{ role: string; content: unknown }> }).messages ?? [])
  .filter((message) => message.role === 'tool')
  .map((message) => JSON.stringify(message.content)));

/** The target's lease owner records, one per held session. */
async function leaseOwners(fixture: Pick<SshdFixture, 'sh'>): Promise<Array<{ nonce: string; pid: number; panelToken: string | null }>> {
  const text = await fixture.sh(`d=${TARGET_HOME}/.damocles/locks/sessions; [ -d "$d" ] || exit 0; for f in "$d"/*.owner; do [ -e "$f" ] && cat "$f" && echo; done; true`, 'dev');
  return text.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { nonce: string; pid: number; panelToken: string | null });
}

async function hostCardOf(app: ElectronApplication): Promise<Locator> {
  const overlay = await openConnect(app);
  await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
  return overlay.getByTestId('host-card');
}

test('two devices on one target follow the same streaming chat, each send shows on both and bills its own device\'s sign-in, the lease keeps one writer, a device\'s deny rule governs only its own turns, and each host card names the other device', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    writeUserSettings(other.home, { 'damocles.model': STUB_MODEL_ID });
    // the second device alone denies the command; the target allows it for everyone
    mergeJson(path.join(other.home.damoclesDir, 'settings.json'), { permissions: { deny: [`Bash(${DENIED})`] } });
    await fixture.sh(`mkdir -p ${TARGET_HOME}/.claude && cat > ${TARGET_HOME}/.claude/settings.json`, 'dev', JSON.stringify({ permissions: { allow: [`Bash(${DENIED})`] } }));

    const first = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    await stubOAuth(first, 'alice', TOKEN_MS);
    const { hostId, key } = await connect(first);
    let release!: () => void;
    stub.replies.push({ chunks: ['Shared one.', ' Shared two.', ' Shared three.'], holds: [{ before: 1, until: new Promise<void>((resolve) => (release = resolve)) }] });
    const tabA = await newRemoteChat(first, key);
    await sendPrompt(tabA, 'Started on the first device');
    await expect(tabA.getByText('Shared one.', { exact: false })).toBeVisible({ timeout: 60_000 });
    const [owner] = await leaseOwners(fixture);
    expect(owner?.panelToken).toEqual(expect.any(String));
    const corePid = ((await control(first, hostId, 'coreState')) as { pid: number }).pid;
    expect(owner?.pid).toBe(corePid);

    // The second device joins mid-turn and both stream the rest of it.
    const secondDesktop = await other.launch();
    const second = secondDesktop.app;
    await stubOAuth(second, 'bob', TOKEN_MS);
    const { key: secondKey } = await connect(second);
    const tabB = await openOtherDevicesChat(second, secondKey, 'Started on the first device', 'Shared one.');
    release();
    for (const [device, tab] of [['first', tabA], ['second', tabB]] as const) {
      await expect(tab.getByText('Shared one. Shared two. Shared three.', { exact: false }), `on the ${device} device`).toBeVisible({ timeout: 60_000 });
      await awaitTurnEnd(tab);
      expect(await occurrences(tab, 'Shared two.')).toBe(1);
    }

    // A send from either device shows on both, and every model request of a turn carries its sender's token.
    await sendPrompt(tabB, 'Sent from the second device');
    for (const [device, tab] of [['second', tabB], ['first', tabA]] as const) await expect(tab.getByText('Echo: Sent from the second device', { exact: true }), `on the ${device} device`).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tabB);
    await sendPrompt(tabA, 'Sent from the first device');
    for (const [device, tab] of [['first', tabA], ['second', tabB]] as const) await expect(tab.getByText('Echo: Sent from the first device', { exact: true }), `on the ${device} device`).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tabA);
    expect(keysOfTurn(stub, 'Started on the first device')).toEqual([FIRST_TOKEN]);
    expect(keysOfTurn(stub, 'Sent from the second device')).toEqual([SECOND_TOKEN]);
    expect(keysOfTurn(stub, 'Sent from the first device')).toEqual([FIRST_TOKEN]);

    // The first device's turn runs the command its own policy allows; the second device's deny holds for its own turn.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: DENIED } }] }, { chunks: ['First device ran it.'] });
    await sendPrompt(tabA, 'Run it from the first device');
    await expect(tabA.getByText('First device ran it.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tabA);
    expect(toolResults(stub).at(-1)).toContain('device-deny-ok');
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: DENIED } }] }, { chunks: ['Second device was refused.'] });
    await sendPrompt(tabB, 'Run it from the second device');
    await expect(tabB.getByText('Second device was refused.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tabB);
    expect(toolResults(stub).at(-1)).not.toContain('device-deny-ok');
    expect(toolResults(stub).at(-1)).toMatch(/denied|deny|blocked/i);

    // One writer: the session's lease never changed hands, and each prompt is in the session file once.
    expect(await leaseOwners(fixture)).toEqual([owner]);
    const sessions = await targetSessions(fixture);
    for (const prompt of ['Sent from the second device', 'Sent from the first device']) expect(sessions.split(`"text":"${prompt}"`).length - 1).toBe(1);

    // Each host card counts the other device; both run as this computer's host name, so no account advice.
    for (const app of [first, second]) {
      const card = await hostCardOf(app);
      await expect(card.getByTestId('host-other-devices')).toHaveText('1 other device is connected to prod-1');
      await expect(card.getByTestId('host-device')).toHaveCount(2);
      await expect(card.getByTestId('host-account-advice')).toHaveCount(0);
      await card.page().keyboard.press('Escape');
    }
    // the other device leaves first, so its reconnect loop starts no daemon after the shutdown
    await secondDesktop.close();
    await shutdownHostDaemon(first, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
    await stub.close();
  }
});

// bash on the target: the marker on screen is the output, never the command line that prints it
const targetEcho = (marker: string): string => `echo ${marker.slice(0, 3)}''${marker.slice(3)}`;

/** Opens the host's one running terminal on this device from its host card, as a user does, and resolves with the shell page. */
async function openHostTerminal(app: ElectronApplication): Promise<Page> {
  const card = await hostCardOf(app);
  const open = card.getByTestId('host-run-open');
  await expect(open).toHaveCount(1, { timeout: 30_000 });
  await open.click();
  const shell = await shellPage(app);
  await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
  return shell;
}

test('a terminal on the host streams to both devices and takes input from either; one device closing its view leaves it running, and Kill from either ends it for both', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    const settings = { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' };
    writeUserSettings(home, settings);
    writeUserSettings(other.home, settings);
    const first = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    const { hostId } = await connect(first);
    const firstShell = await openTerminal(first);
    await runInTerminal(firstShell, targetEcho('before-second-device'));
    await waitForOutputLine(firstShell, 'before-second-device');

    // The second device opens it from its host card: the screen so far, then live output.
    const secondDesktop = await other.launch();
    const { hostId: secondHostId } = await connect(secondDesktop.app);
    const secondShell = await openHostTerminal(secondDesktop.app);
    await waitForOutputLine(secondShell, 'before-second-device');
    await runInTerminal(firstShell, targetEcho('typed-on-first'));
    for (const shell of [firstShell, secondShell]) await waitForOutputLine(shell, 'typed-on-first');
    await runInTerminal(secondShell, targetEcho('typed-on-second'));
    for (const shell of [secondShell, firstShell]) await waitForOutputLine(shell, 'typed-on-second');

    // Quitting the second device detaches its view; the terminal goes on for the first.
    await secondDesktop.close();
    await runInTerminal(firstShell, targetEcho('after-second-left'));
    await waitForOutputLine(firstShell, 'after-second-left');
    await expect(activeTerminal(firstShell)).toHaveAttribute('data-status', 'running');

    // The second device's next launch reattaches its terminal with what ran meanwhile; its Kill ends it on both.
    const again = await other.launch();
    await remoteProjectKey(again.app, { authorityKey: `ssh+${secondHostId}` }, APP);
    const againShell = await shellPage(again.app);
    await expect(activeTerminal(againShell)).toHaveAttribute('data-status', 'running', { timeout: 60_000 });
    await waitForOutputLine(againShell, 'after-second-left');
    const card = await hostCardOf(again.app);
    await card.getByRole('button', { name: /^Kill / }).click();
    for (const shell of [againShell, firstShell]) await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'exited', { timeout: 30_000 });
    await expect(card.getByTestId('host-run')).toHaveCount(0, { timeout: 30_000 });
    await again.close();
    await shutdownHostDaemon(first, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
  }
});

test('two attached devices with different names get the one-account-per-person advice on their host cards', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    const first = (await launch({ env: { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_DEVICE_NAME: 'alice-laptop' } })).app;
    const { hostId } = await connect(first);
    const secondDesktop = await other.launch({ DAMOCLES_E2E_DEVICE_NAME: 'bob-desktop' });
    const second = secondDesktop.app;
    await connect(second);
    for (const [app, peer] of [[first, 'bob-desktop'], [second, 'alice-laptop']] as const) {
      const card = await hostCardOf(app);
      await expect(card.getByTestId('host-other-devices')).toHaveText('1 other device is connected to prod-1');
      await expect(card.getByTestId('host-device').filter({ hasText: peer })).toHaveCount(1);
      await expect(card.getByTestId('host-device').filter({ hasText: '(this device)' })).toHaveCount(1);
      await expect(card.getByTestId('host-account-advice')).toHaveText(ADVICE);
      await card.page().keyboard.press('Escape');
    }
    await secondDesktop.close();
    await shutdownHostDaemon(first, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
  }
});
