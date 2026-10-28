import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { filesUnder } from '../desktop/support/loopback';
import { sendPrompt } from '../desktop/support/loopback-agent';
import type { StubReply } from '../desktop/support/openai-stub';
import { recordedPopupToasts, recordToasts, shellPage } from '../desktop/support/shell';
import { chatRow, listChats } from '../desktop/support/shell-ui';
import { awaitTurnEnd, chatInput } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, hostState, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// session-title.ts TITLE_OUTPUT_TOOL
const TITLE_TOOL = 'set_session_title';
const FIRST = 'Mirrored Offline Chat';
const SECOND = 'Second Mirrored Chat';
const REFUSED = 'prod-1 is not connected, so its chats are read-only until it connects.';

const titled = (title: string): StubReply => ({ chunks: [], toolCalls: [{ name: TITLE_TOOL, arguments: { title } }] });

/** Every mirrored file of the host with a hash of its bytes and its mtime, keyed by its path under the mirror. */
function mirrorState(root: string): Record<string, string> {
  return Object.fromEntries(filesUnder(root).map((file) => {
    const full = path.join(root, ...file.split('/'));
    return [file, `${createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${fs.statSync(full).mtimeMs}`];
  }));
}

/** Whether some mirrored session file holds every one of `needles`, together across the mirror. */
function mirrorHolds(root: string, needles: readonly string[]): boolean {
  const text = filesUnder(root).filter((file) => file.endsWith('.jsonl')).map((file) => fs.readFileSync(path.join(root, ...file.split('/')), 'utf8')).join('\n');
  return needles.every((needle) => text.includes(needle));
}

/** The visible chat page that shows `text`. */
async function chatShowing(app: ElectronApplication, text: string): Promise<Page> {
  let found: Page | undefined;
  await expect.poll(async () => {
    found = undefined;
    for (const page of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/'))) {
      if (await page.getByText(text, { exact: true }).isVisible()) found = page;
    }
    return found !== undefined;
  }, { timeout: 60_000 }).toBe(true);
  return found!;
}

test('with the host offline its project lists the chats of the session mirror with their titles, opening one shows its read-only transcript, and nothing writes the mirror', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(first.app, hostId, APP);
    await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
    const mirrorRoot = path.join(home.userData, 'remote', hostId, 'mirror');
    const shell = await shellPage(first.app);
    const titleOf = async (title: string): Promise<string | undefined> => (await listChats(first.app, key)).chats.find((chat) => chat.title === title)?.id;

    // Two titled chats on the target; the first gets one more turn last, whose settle syncs the mirror with both titles.
    stub.subCallReplies.set(TITLE_TOOL, [titled(FIRST), titled(SECOND)]);
    const chatA = await newRemoteChat(first.app, key);
    await sendPrompt(chatA, 'First turn');
    await expect(chatA.getByText('Echo: First turn', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(chatA);
    await expect.poll(() => titleOf(FIRST), { timeout: 60_000 }).toBeDefined();
    const chatB = await newRemoteChat(first.app, key);
    await sendPrompt(chatB, 'Other chat');
    await expect(chatB.getByText('Echo: Other chat', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(chatB);
    await expect.poll(() => titleOf(SECOND), { timeout: 60_000 }).toBeDefined();
    const idA = (await titleOf(FIRST))!;
    const idB = (await titleOf(SECOND))!;
    expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), idA)).toEqual({ ok: true });
    const again = await chatShowing(first.app, 'Echo: First turn');
    await sendPrompt(again, 'Second turn');
    await expect(again.getByText('Echo: Second turn', { exact: true })).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(again);
    await expect.poll(() => mirrorHolds(mirrorRoot, [FIRST, SECOND, 'Echo: Second turn', 'Echo: Other chat']), { timeout: 60_000 }).toBe(true);
    // the other chat is the one the next launch restores, so the first opens from the list only
    expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), idB)).toEqual({ ok: true });
    await chatShowing(first.app, 'Echo: Other chat');
    await shutdownHostDaemon(first.app, hostId, fixture);
    await first.close();
    const mirrored = mirrorState(mirrorRoot);

    // The host is unreachable: its project lists the mirrored chats with their titles, the one with the latest turn first.
    await fixture.stopSshd();
    const second = await launch(env);
    const app = second.app;
    const relaunched = await shellPage(app);
    await expect.poll(async () => (await lastConnectStep(app, hostId))?.step, { timeout: 60_000 }).toBe('failed');
    await relaunched.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
    await expect.poll(async () => (await listChats(app, key)).chats.map((chat) => chat.title), { timeout: 60_000 }).toEqual([FIRST, SECOND]);
    const offlineA = (await listChats(app, key)).chats.find((chat) => chat.title === FIRST)!;
    await expect(chatRow(relaunched, offlineA.id).getByTestId('chat-title')).toHaveText(FIRST);
    expect(await hostState(app, hostId)).not.toBe('connected');

    // A mirrored row offers only Open: no rename, tag or delete on its row, and main refuses them and any worktree work.
    expect(offlineA.actions).toEqual([]);
    await chatRow(relaunched, offlineA.id).hover();
    for (const action of ['rename', 'tag', 'delete']) await expect(chatRow(relaunched, offlineA.id).getByTestId(`chat-action-${action}`)).toHaveCount(0);
    await recordToasts(app);
    expect(await relaunched.evaluate((id) => window.damoclesShell!.renameChat(id, 'Renamed offline'), offlineA.id)).toEqual({ ok: false, reason: 'failed' });
    expect(await relaunched.evaluate((id) => window.damoclesShell!.deleteChat(id), offlineA.id)).toEqual({ ok: false, reason: 'failed' });
    await relaunched.evaluate((projectKey) => window.damoclesShell!.worktreeFinish({ projectKey, worktreeId: 'a1b2c3d4', action: 'apply' }), key);
    await relaunched.evaluate((projectKey) => window.damoclesShell!.newChatInWorktree({ projectKey, worktreeId: 'a1b2c3d4' }), key);
    await expect.poll(async () => (await recordedPopupToasts(app)).filter((toast) => JSON.stringify(toast.body).includes(REFUSED)).length).toBe(4);

    // Opening one shows its whole transcript, read-only, with the outage named in place of the composer.
    await chatRow(relaunched, offlineA.id).click();
    const transcript = await chatShowing(app, 'Echo: Second turn');
    await expect(transcript.getByText('Echo: First turn', { exact: true })).toBeVisible();
    await expect(transcript.getByTestId('chat-header-title')).toHaveText(FIRST);
    // the outage banner sits under the header, which keeps the pane's top
    // the reconnect loop retries the host behind the banner's countdown
    await expect(transcript.getByTestId('chat-connection-banner')).toContainText(/Reconnecting to prod-1 in \d+ s/);
    expect((await transcript.getByTestId('chat-header').boundingBox())?.y).toBe(0);
    await expect(transcript.getByTestId('composer-offline')).toContainText('prod-1 is offline');
    await expect(chatInput(transcript)).toHaveCount(0);

    // Listing and reading the mirror changed none of its files.
    await second.close();
    expect(mirrorState(mirrorRoot)).toEqual(mirrored);
  } finally {
    await stub.close();
  }
});
