import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';
import { ACTOR_INTENT_EXPIRY_MS } from '../../src/desktop/daemon/actor-outbox';
import { designChatName } from '../../src/shared/types/design';
import { approveDesign, DESIGN_SCHEME, designApproval, designTabs, startDesignChat } from '../desktop/support/design';
import { chatIdOf, selectChatPage } from '../desktop/support/fixtures';
import { writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { cleanUp } from '../desktop/support/loopback';
import { mergeJson, sendPrompt } from '../desktop/support/loopback-agent';
import { call, STUB_MODEL_ID, type OpenAIStub, type RecordedRequest, type StubReply } from '../desktop/support/openai-stub';
import { menuItem, readyOverlay } from '../desktop/support/overlay';
import { recordedToasts, recordToasts, shellPage, shellState } from '../desktop/support/shell';
import { listChats } from '../desktop/support/shell-ui';
import { activeTerminal, openTerminal, runInTerminal, waitForOutputLine } from '../desktop/support/terminal';
import { awaitTurnEnd, postFromWebview } from '../desktop/support/ui';
import { openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { reconnectPhase } from './support/flaky';
import type { ReleaseMirror } from './support/release-mirror';
import { addHost, control, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { chatShowing, occurrences, stubOAuth, targetCoreLog, targetSessions } from './support/remote-runs';
import { proxiedSecondDevice, secondDevice, type ProxiedDevice } from './support/second-device';
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

test('a conversation another device holds, resumed on this device, shows on this device and leaves the other device where it was', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    const first = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    await stubOAuth(first, 'alice', TOKEN_MS);
    const { hostId, key } = await connect(first);
    // the first device holds a conversation, then moves on to a new chat
    const held = await newRemoteChat(first, key);
    await sendPrompt(held, 'Held on the first device');
    await expect(held.getByText('Echo: Held on the first device', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(held);
    await newRemoteChat(first, key);
    const firstSelected = (await shellState(first)).selected.chatId;
    expect(firstSelected).toEqual(expect.any(String));

    const secondDesktop = await other.launch();
    const second = secondDesktop.app;
    const { key: secondKey } = await connect(second);
    const asking = await newRemoteChat(second, secondKey);
    let heldId = '';
    await expect.poll(async () => (heldId = (await listChats(second, secondKey)).chats.find((chat) => chat.title === 'Held on the first device')?.id ?? ''), { timeout: 60_000 }).not.toBe('');

    // Resumed from the second device's chat, the conversation the first device holds opens there, joining its panel, with no
    // notice, since the user sees it open.
    await recordToasts(second);
    await postFromWebview(asking, { type: 'resumeSession', sessionId: heldId });
    await expect.poll(async () => (await shellState(second)).selected.chatId, { timeout: 60_000 }).toBe(heldId);
    await chatShowing(second, 'Echo: Held on the first device');
    expect((await recordedToasts(second)).map((toast) => toast.message)).toEqual([]);
    // the first device stays on the chat it had selected
    expect((await shellState(first)).selected.chatId).toBe(firstSelected);
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

const DESIGNS = `${TARGET_HOME}/.damocles/designs`;
const DESIGN_MD = ['---', 'app: Vue 3', 'viewports:', '  primary: 1280', '  checked: [1280]', '  journey: []', '---', '# Contacts', ''].join('\n');
const SCREEN = [
  '<!doctype html>',
  '<html lang="en" data-ds-screen="S1" data-ds-states="default empty">',
  '<head><meta charset="utf-8"><title>Contacts</title></head>',
  '<body><main><h1>Contacts on the target</h1><p id="empty" data-ds-state-only="empty">No contacts yet</p></main></body></html>',
  '',
].join('\n');
const SCREEN_FILE = 'screens/S1-contacts.html';

/** Every live design view of the app, shown or not: a preview opened on that device. */
const designContents = (app: ElectronApplication): Promise<number> => app.evaluate(({ webContents }, scheme) => webContents.getAllWebContents()
  .filter((contents) => !contents.isDestroyed() && contents.getURL().startsWith(scheme)).length, DESIGN_SCHEME);

/**
 * The second device starts a design from a main chat of its own and the designer writes one screen, whose preview tab opens
 * there; with `finish`, the user approves it as v1 and the main chat gets its result card. The preview tab is closed after,
 * so no device shows a preview and only the second device shows the design chat.
 */
async function designOnSecondDevice(second: ElectronApplication, key: string, stub: OpenAIStub, home: HermeticHome, fixture: Pick<SshdFixture, 'sh'>, finish: boolean): Promise<{ designChatId: string; folder: string }> {
  const parent = await newRemoteChat(second, key);
  const { design, folder } = await startDesignChat(second, parent, stub, home, {
    fidelity: 'Static mockup',
    script: (designFolder) => [
      call('write', { path: `${designFolder}/design.md`, content: DESIGN_MD }),
      call('write', { path: `${designFolder}/${SCREEN_FILE}`, content: SCREEN }),
      ...(finish ? [call('FinishDesign', { summary: 'The contacts list page.' }), { chunks: ['Read design v1.'] }] : [{ chunks: ['Drafted the screen.'] }]),
    ],
    findFolder: async () => {
      let designId = '';
      await expect.poll(async () => (designId = (await fixture.sh(`find ${DESIGNS} -mindepth 1 -maxdepth 1 -type d ! -name '.*' -printf '%f\\n'`, 'dev')).trim()), { timeout: 60_000 }).toMatch(/^[A-Za-z0-9._-]+$/);
      return `${DESIGNS}/${designId}`;
    },
  });
  if (finish) {
    await approveDesign(design);
    await expect(parent.getByText('Read design v1.')).toBeVisible({ timeout: 120_000 });
    await awaitTurnEnd(parent);
  } else {
    await expect(design.getByText('Drafted the screen.')).toBeVisible({ timeout: 120_000 });
  }
  await awaitTurnEnd(design);
  await selectChatPage(second, design);
  const shell = await shellPage(second);
  const previewTab = shell.locator('[data-testid="editor-tab"][data-kind="designPreview"]');
  await expect(previewTab).toHaveCount(1, { timeout: 60_000 });
  await previewTab.click({ button: 'right' });
  await menuItem(await readyOverlay(second), 'close').click();
  await expect(previewTab).toHaveCount(0);
  await expect.poll(() => designContents(second), { timeout: 30_000 }).toBe(0);
  return { designChatId: await chatIdOf(second, design), folder };
}

/** The first device's Open preview showed the design chat there, selected, with the screen's preview tab ready. */
async function previewOpenedHere(app: ElectronApplication, designChatId: string): Promise<void> {
  await expect.poll(async () => (await shellState(app)).selected.chatId, { timeout: 60_000 }).toBe(designChatId);
  await expect.poll(async () => (await designTabs(app)).map((tab) => [tab.designPreview.relPath, tab.designPreview.status]), { timeout: 60_000 }).toEqual([[SCREEN_FILE, 'ready']]);
}

/** The other device opened no preview and kept its selection, checked for a while after the preview showed on the first. */
async function nothingOpenedThere(app: ElectronApplication, selected: string | undefined): Promise<void> {
  const end = Date.now() + 3_000;
  do {
    expect(await designContents(app)).toBe(0);
    expect((await shellState(app)).selected.chatId).toBe(selected);
    await new Promise((resolve) => setTimeout(resolve, 250));
  } while (Date.now() < end);
}

test('the main chat\'s result card on one device opens the preview of a design only another device shows on the first device, never on the other', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    writeUserSettings(other.home, { 'damocles.model': STUB_MODEL_ID });
    const first = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    await stubOAuth(first, 'alice', TOKEN_MS);
    const { hostId, key } = await connect(first);
    const secondDesktop = await other.launch();
    const second = secondDesktop.app;
    await stubOAuth(second, 'bob', TOKEN_MS);
    const { key: secondKey } = await connect(second);
    const { designChatId } = await designOnSecondDevice(second, secondKey, stub, other.home, fixture, true);
    const secondSelected = (await shellState(second)).selected.chatId;

    // The first device opens the main chat, whose card's Open preview shows the design chat here and opens the screen in it.
    const parent = await openOtherDevicesChat(first, key, 'Design the contacts page', 'Read design v1.');
    const card = parent.getByTestId('design-result-card');
    await expect(card).toHaveCount(1);
    await card.getByTestId('design-result-open-preview').click();
    await parent.locator('[data-testid="design-screen"]', { hasText: SCREEN_FILE }).click();
    await previewOpenedHere(first, designChatId);
    await nothingOpenedThere(second, secondSelected);
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

test('a screen\'s code tab on one device opens the preview of a design only another device shows on the first device, never on the other', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID, 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
    writeUserSettings(other.home, { 'damocles.model': STUB_MODEL_ID });
    const first = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    const { hostId } = await connect(first);
    const secondDesktop = await other.launch();
    const second = secondDesktop.app;
    await stubOAuth(second, 'bob', TOKEN_MS);
    const { key: secondKey } = await connect(second);
    const { designChatId, folder } = await designOnSecondDevice(second, secondKey, stub, other.home, fixture, false);
    const secondSelected = (await shellState(second)).selected.chatId;

    // The first device opens the screen from a terminal of its own, then the code tab's Open preview.
    const shell = await openTerminal(first);
    await runInTerminal(shell, `damocles ${folder}/${SCREEN_FILE}`);
    const codeTab = shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'S1-contacts.html' });
    await expect(codeTab).toHaveCount(1, { timeout: 60_000 });
    await codeTab.click({ button: 'right' });
    await menuItem(await readyOverlay(first), 'openPreview').click();
    await previewOpenedHere(first, designChatId);
    await nothingOpenedThere(second, secondSelected);
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

test('two devices on one target, one in English and one in Greek: core\'s notice to each device shows in that device\'s language', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.desktop.language': 'en' });
    writeUserSettings(other.home, { 'damocles.desktop.language': 'el' });
    const first = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    const { hostId, key } = await connect(first);
    const secondDesktop = await other.launch();
    const second = secondDesktop.app;
    const { key: secondKey } = await connect(second);
    const english = await newRemoteChat(first, key);
    const greek = await newRemoteChat(second, secondKey);
    for (const app of [first, second]) await recordToasts(app);
    const notices = async (app: ElectronApplication): Promise<string[]> => (await recordedToasts(app)).map((toast) => toast.message);

    // A file the target lacks: the daemon's core says so to the device that asked, whose main words it in its own language.
    await postFromWebview(greek, { type: 'openFile', filePath: 'missing.png' });
    await expect.poll(() => notices(second), { timeout: 60_000 }).toContainEqual(expect.stringContaining('Δεν ήταν δυνατό το άνοιγμα του αρχείου: missing.png'));
    await postFromWebview(english, { type: 'openFile', filePath: 'missing.png' });
    await expect.poll(() => notices(first), { timeout: 60_000 }).toContainEqual(expect.stringContaining('Could not open file: missing.png'));

    // Each notice reached its own device alone, in that device's language only.
    expect((await notices(first)).filter((text) => text.includes('missing.png'))).toEqual([expect.stringContaining('Could not open file: missing.png')]);
    expect((await notices(second)).filter((text) => text.includes('missing.png'))).toEqual([expect.stringContaining('Δεν ήταν δυνατό το άνοιγμα του αρχείου: missing.png')]);
    await secondDesktop.close();
    await shutdownHostDaemon(first, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
  }
});

// a server package never reads the e2e hooks, so a target's daemon waits the full expiry
const EXPIRY_MS = ACTOR_INTENT_EXPIRY_MS;
const DESIGN_TITLE = 'Contacts list';
const DESIGN_CHAT = designChatName(DESIGN_TITLE);
const FINISHED = `The design "${DESIGN_TITLE}" is finished`;

/** The target daemon's own log lines, the core router's among them, every rotated file included. */
const targetDaemonLog = (fixture: Pick<SshdFixture, 'sh'>): Promise<string> =>
  fixture.sh(`for f in ${TARGET_HOME}/.damocles/server/run-*/logs/*.log; do case "$f" in *Damocles_Core*) ;; *) cat "$f" ;; esac; done; true`, 'dev');
const countIn = (text: string, needle: string | RegExp): number => text.split(needle).length - 1;

/** The target daemon's and core's logs, which the target's container takes with it. */
async function attachTargetLogs(testInfo: TestInfo, fixture: Pick<SshdFixture, 'sh'>): Promise<void> {
  for (const [name, read] of [['target-daemon.log', targetDaemonLog], ['target-core.log', targetCoreLog]] as const) {
    const file = testInfo.outputPath(name);
    fs.writeFileSync(file, await read(fixture).catch(String));
    await testInfo.attach(name, { path: file, contentType: 'text/plain' });
  }
}

/** Resolves once the daemon logged `needle` more than `before` times. */
async function daemonLogged(fixture: Pick<SshdFixture, 'sh'>, needle: string | RegExp, before: number, timeout = 60_000): Promise<void> {
  await expect.poll(async () => countIn(await targetDaemonLog(fixture), needle), { timeout }).toBeGreaterThan(before);
}

// a launch serves stubOAuth before its engine runs, which then refuses it
const signIn = (app: ElectronApplication, account: string): Promise<void> => expect.poll(() => stubOAuth(app, account, TOKEN_MS).then(() => true, (error: unknown) => {
  if (String(error).includes('CoreNotRunningError')) return false;
  throw error;
}), { timeout: 60_000 }).toBe(true);

/** Refuses every connection of the proxied device until restore, and resolves once the daemon holds it as lost. */
async function loseDevice(fixture: Pick<SshdFixture, 'sh'>, device: ProxiedDevice): Promise<void> {
  const before = countIn(await targetDaemonLog(fixture), ' lost (');
  device.proxy.refuse();
  await daemonLogged(fixture, ' lost (', before);
}

/**
 * A third device starts a design from a main chat of its own, the designer drafts one screen, and that device quits, so the
 * main chat and the design chat stay stored on the target and no device shows either.
 */
async function designMadeElsewhere(fixture: SshdFixture, mirror: Pick<ReleaseMirror, 'url'>, stub: OpenAIStub, testInfo: TestInfo): Promise<string> {
  const maker = await secondDevice(fixture, 'prod-1', mirror);
  let failed = true;
  try {
    writeUserSettings(maker.home, { 'damocles.model': STUB_MODEL_ID });
    const desktop = await maker.launch();
    await signIn(desktop.app, 'carol');
    const { key } = await connect(desktop.app);
    const { folder } = await designOnSecondDevice(desktop.app, key, stub, maker.home, fixture, false);
    await desktop.close();
    failed = false;
    return folder;
  } finally {
    await maker.dispose(testInfo, failed);
  }
}

const designChatOf = async (app: ElectronApplication, key: string): Promise<{ readonly loaded: boolean } | undefined> =>
  (await listChats(app, key)).chats.find((chat) => chat.title === DESIGN_CHAT);

/** The stored design chat's session file on the target, which only its own turns write. */
const designSessionFile = (fixture: Pick<SshdFixture, 'sh'>): Promise<string> =>
  fixture.sh(`grep -rl --include='*.jsonl' 'Drafted the screen.' ${TARGET_HOME}/.damocles/pi/agent/sessions | xargs cat`, 'dev');

test('a closed design chat that a device\'s turn reopens opens on that device alone: held while its link is down, opened once it is back, and past the expiry nowhere, the stored chat intact', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  const proxiedA = await proxiedSecondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    writeUserSettings(proxiedA.home, { 'damocles.model': STUB_MODEL_ID });
    // Device B stays connected throughout; device A, behind the proxy, shows the main chat, whose agent reopens the design.
    const deviceB = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    await designMadeElsewhere(fixture, mirror, stub, testInfo);
    const stored = await designSessionFile(fixture);
    expect(stored).not.toBe('');
    await signIn(deviceB, 'alice');
    const { hostId, key: keyB } = await connect(deviceB);
    const selectedOnB = (await shellState(deviceB)).selected.chatId;
    const desktopA = await proxiedA.launch();
    const deviceA = desktopA.app;
    await signIn(deviceA, 'bob');
    const { key: keyA } = await connect(deviceA);
    const parent = await openOtherDevicesChat(deviceA, keyA, 'Design the contacts page', 'Design the contacts page');
    expect((await designChatOf(deviceA, keyA))?.loaded).toBe(false);

    // The reply that calls StartDesign holds mid-stream, A's link goes down, and only then does the tool reopen the design chat.
    const reopenWhileAway = async (brief: string): Promise<void> => {
      let release!: () => void;
      let reached!: () => void;
      const streaming = new Promise<void>((resolve) => (reached = resolve));
      stub.replies.push({ chunks: ['Reopening the design.', ' Now.'], holds: [{ before: 1, until: new Promise<void>((resolve) => (release = resolve)), sent: reached }], toolCalls: [{ name: 'StartDesign', arguments: { title: DESIGN_TITLE, brief } }] });
      await sendPrompt(parent, brief);
      await streaming;
      const held = countIn(await targetDaemonLog(fixture), 'holding the new panel');
      await loseDevice(fixture, proxiedA);
      release();
      await daemonLogged(fixture, 'holding the new panel', held);
    };

    // Past the expiry the new panel is cancelled: nothing opens on either device once A is back, and the stored chat is unchanged.
    const expired = /dropped the new panel \S+ for client \S+, which did not return within/;
    const dropped = countIn(await targetDaemonLog(fixture), expired);
    await reopenWhileAway('Show the empty state too.');
    await daemonLogged(fixture, expired, dropped, EXPIRY_MS + 60_000);
    proxiedA.proxy.restore();
    // StartDesign went on with notShown once the panel was cancelled, so the turn ends
    await expect(parent.getByTestId('composer-send')).toHaveAttribute('aria-label', 'Send (Enter)', { timeout: 120_000 });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect((await designChatOf(deviceA, keyA))?.loaded).toBe(false);
    expect((await designChatOf(deviceB, keyB))?.loaded).not.toBe(true);
    expect((await shellState(deviceB)).selected.chatId).toBe(selectedOnB);
    expect(await designSessionFile(fixture)).toBe(stored);

    // Back within the expiry, A gets the design chat and B never does.
    await reopenWhileAway('Add a search field too.');
    proxiedA.proxy.restore();
    await expect.poll(async () => (await designChatOf(deviceA, keyA))?.loaded, { timeout: 120_000 }).toBe(true);
    await awaitTurnEnd(parent);
    expect((await designChatOf(deviceB, keyB))?.loaded).not.toBe(true);
    expect((await shellState(deviceB)).selected.chatId).toBe(selectedOnB);

    await desktopA.close();
    await shutdownHostDaemon(deviceB, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure !== undefined) await attachTargetLogs(testInfo, fixture);
    await cleanUp(testInfo, failure, () => proxiedA.dispose(testInfo, failure !== undefined));
    await stub.close();
  }
});

test('core\'s notice for a device\'s work shows on that device alone: held while its link is down, shown once it is back, and past the expiry dropped and logged', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(900_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture, 'dev', false);
  const proxiedA = await proxiedSecondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    writeUserSettings(home, { 'damocles.model': STUB_MODEL_ID });
    writeUserSettings(proxiedA.home, { 'damocles.model': STUB_MODEL_ID });
    // the main chat is closed on every device, so a finished version reaches it as a notice to the device whose turn made it
    const deviceB = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    const folder = await designMadeElsewhere(fixture, mirror, stub, testInfo);
    await signIn(deviceB, 'alice');
    const { hostId, key: keyB } = await connect(deviceB);
    const desktopA = await proxiedA.launch();
    const deviceA = desktopA.app;
    await signIn(deviceA, 'bob');
    const { hostId: hostIdA, key: keyA } = await connect(deviceA);
    const designA = await openOtherDevicesChat(deviceA, keyA, DESIGN_CHAT, 'Drafted the screen.');
    const designB = await openOtherDevicesChat(deviceB, keyB, DESIGN_CHAT, 'Drafted the screen.');
    for (const app of [deviceB, deviceA]) await recordToasts(app);
    const finishedNotices = async (app: ElectronApplication): Promise<string[]> => (await recordedToasts(app)).map((toast) => toast.message).filter((message) => message.startsWith(FINISHED));

    // A's message starts the turn whose FinishDesign asks for approval; A's link goes down, and B approves.
    const finishWhileAway = async (prompt: string, script: StubReply[]): Promise<void> => {
      stub.replies.push(...script, call('FinishDesign', { summary: 'The contacts list page.' }));
      await sendPrompt(designA, prompt);
      await expect(designApproval(designB)).toBeVisible({ timeout: 120_000 });
      const held = countIn(await targetDaemonLog(fixture), 'holding core\'s notifications.show');
      await loseDevice(fixture, proxiedA);
      await approveDesign(designB);
      await daemonLogged(fixture, 'holding core\'s notifications.show', held);
    };

    // Back within the expiry, A shows the notice and B never does.
    await finishWhileAway('Finish the design', []);
    proxiedA.proxy.restore();
    await expect.poll(() => finishedNotices(deviceA), { timeout: 120_000 }).toEqual([expect.stringContaining('(v1)')]);
    await awaitTurnEnd(designB);
    expect(await finishedNotices(deviceB)).toEqual([]);

    // Past the expiry the notice is dropped and logged, and neither device shows it.
    const expired = /dropped core's notifications\.show for client \S+, which did not return within/;
    const dropped = countIn(await targetDaemonLog(fixture), expired);
    await finishWhileAway('Finish it again', [call('write', { path: `${folder}/${SCREEN_FILE}`, content: SCREEN.replace('No contacts yet', 'Nobody here yet') })]);
    await daemonLogged(fixture, expired, dropped, EXPIRY_MS + 60_000);
    proxiedA.proxy.restore();
    await awaitTurnEnd(designB);
    await expect.poll(() => reconnectPhase(deviceA, `ssh+${hostIdA}`), { timeout: 120_000 }).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(await finishedNotices(deviceA)).toEqual([expect.stringContaining('(v1)')]);
    expect(await finishedNotices(deviceB)).toEqual([]);

    await desktopA.close();
    await shutdownHostDaemon(deviceB, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (failure !== undefined) await attachTargetLogs(testInfo, fixture);
    await cleanUp(testInfo, failure, () => proxiedA.dispose(testInfo, failure !== undefined));
    await stub.close();
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
