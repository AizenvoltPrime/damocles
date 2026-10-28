import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { chatRequests, type OpenAIStub } from '../desktop/support/openai-stub';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { awaitTurnEnd } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv, remoteHosts, remoteProjectKey, SSH_TAG } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const QUEUED = 'Queued · sends when prod-1 reconnects';
const NOT_SENT = 'Not sent: this chat moved to another conversation';
// a conversation id no chat shows: what a page names after its chat moved on elsewhere
const ELSEWHERE = '0198c0de-0000-7000-8000-00000000e15e';

const chips = (tab: Page): Locator => tab.getByTestId('held-message');
const chip = (tab: Page, text: string): Locator => chips(tab).filter({ hasText: text });

const textOf = (content: unknown): string =>
  typeof content === 'string' ? content : Array.isArray(content) ? (content as Array<{ text?: string }>).map((part) => part.text ?? '').join('') : '';

/**
 * The user messages of the conversation as the agent's latest turn sent it, in order: everything that reached the model,
 * whether a queued message started its own turn or joined the running one. A sub-call (the title) offers one tool and is left out.
 */
function sentTexts(stub: OpenAIStub): string[] {
  const turns = chatRequests(stub).map((request) => request.body as { messages?: Array<{ role: string; content: unknown }>; tools?: unknown[] }).filter((body) => body.tools?.length !== 1);
  return (turns.at(-1)?.messages ?? []).filter((message) => message.role === 'user').map((message) => textOf(message.content));
}

async function chatWithOneTurn(app: ElectronApplication, stub: OpenAIStub): Promise<{ readonly hostId: string; readonly tab: Page }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const tab = await newRemoteChat(app, key);
  await sendPrompt(tab, 'Online first');
  await expect(tab.getByText('Echo: Online first', { exact: true })).toBeVisible({ timeout: 60_000 });
  await awaitTurnEnd(tab);
  expect(sentTexts(stub)).toEqual(['Online first']);
  return { hostId, tab };
}

test('messages typed while the host is away queue as chips, Cancel removes one, and on reconnect the rest send in order', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const stub = await startTargetStub(home, target.fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const { hostId, tab } = await chatWithOneTurn(app, stub);

    target.proxy.refuse();
    await expect(tab.getByTestId('chat-connection-banner')).toBeVisible({ timeout: 30_000 });
    for (const text of ['Queued one', 'Queued two', 'Queued three']) await sendPrompt(tab, text);
    await expect(chips(tab)).toHaveCount(3);
    for (const text of ['Queued one', 'Queued two', 'Queued three']) {
      await expect(chip(tab, text)).toContainText(QUEUED);
      await expect(chip(tab, text)).toHaveAttribute('data-status', 'queued');
    }
    await expect(tab.getByTestId('held-messages-announcement')).toContainText('Message queued until prod-1 reconnects');
    await chip(tab, 'Queued two').getByTestId('held-message-cancel').click();
    await expect(chips(tab)).toHaveCount(2);
    // nothing left this computer while the host was away
    expect(sentTexts(stub)).toEqual(['Online first']);

    target.proxy.restore();
    await expect(tab.getByText('Echo: Queued three', { exact: true })).toBeVisible({ timeout: 120_000 });
    await awaitTurnEnd(tab);
    await expect(chips(tab)).toHaveCount(0);
    expect(sentTexts(stub)).toEqual(['Online first', 'Queued one', 'Queued three']);
    await expect(tab.getByText('Echo: Queued two', { exact: true })).toHaveCount(0);
    await shutdownHostDaemon(app, hostId, target.fixture);
  } finally {
    await stub.close();
  }
});

test('a queued message whose chat moved to another conversation shows the not-sent chip on reconnect and appends nothing', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const stub = await startTargetStub(home, target.fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { tab } = await chatWithOneTurn(first.app, stub);
    target.proxy.refuse();
    await expect(tab.getByTestId('chat-connection-banner')).toBeVisible({ timeout: 30_000 });
    await sendPrompt(tab, 'Meant for the old conversation');
    await expect(chip(tab, 'Meant for the old conversation')).toContainText(QUEUED);
    await first.close();

    // The entry kept across the relaunch names the conversation the page showed; here that chat moved on, so it names
    // another one, as when the chat went to a new conversation from another device while this one was away.
    const stateFile = path.join(home.userData, 'remote-state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { offlineQueue: Record<string, { entries: Array<{ conversationId: string | null }> }> };
    const panels = Object.values(state.offlineQueue);
    expect(panels).toHaveLength(1);
    panels[0]!.entries[0]!.conversationId = ELSEWHERE;
    fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);

    target.proxy.restore();
    const { app } = await launch(env);
    let moved: Page | undefined;
    await expect.poll(async () => {
      for (const page of app.windows().filter((candidate) => !candidate.isClosed() && candidate.url().includes('/panel/'))) {
        if (await chip(page, 'Meant for the old conversation').count() > 0) moved = page;
      }
      return moved !== undefined;
    }, { timeout: 120_000 }).toBe(true);
    const notSent = chip(moved!, 'Meant for the old conversation');
    await expect(notSent).toHaveAttribute('data-status', 'notSent', { timeout: 120_000 });
    await expect(notSent).toContainText(NOT_SENT);
    await expect(notSent.getByTestId('held-message-copy')).toBeVisible();
    // never sent to the conversation the chat shows, nor to any other
    expect(sentTexts(stub)).toEqual(['Online first']);
    await expect(moved!.getByText('Echo: Meant for the old conversation', { exact: true })).toHaveCount(0);
    await notSent.getByTestId('held-message-discard').click();
    await expect(chips(moved!)).toHaveCount(0);
    const [saved] = await remoteHosts(app);
    await shutdownHostDaemon(app, saved!.hostId, target.fixture);
  } finally {
    await stub.close();
  }
});
