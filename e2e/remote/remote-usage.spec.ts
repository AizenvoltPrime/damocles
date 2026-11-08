import type { Page } from '@playwright/test';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { shellPage } from '../desktop/support/shell';
import { hostMessages, recordHostMessages } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// the refusal a daemon's core answers with (src/core/pi-session/subscription-usage.ts); a remote chat's page never sees it
const REMOTE_REFUSAL = 'Subscription usage is read on your computer, not on a remote host';

interface UsageAnswer {
  readonly claude: { readonly status: string; readonly error?: { readonly message: string } };
  readonly gpt: { readonly status: string; readonly error?: { readonly message: string } };
}

/** The subscriptionUsage answers the page got, in order. */
async function usageAnswers(tab: Page): Promise<UsageAnswer[]> {
  return (await hostMessages(tab, 'subscriptionUsage')).map((message) => message['data'] as UsageAnswer);
}

// the trailing space closes the command popup, whose Enter would otherwise complete the command instead of sending it
const typeUsage = (tab: Page): Promise<void> => sendPrompt(tab, '/usage ');

async function headerUsage(tab: Page): Promise<void> {
  await tab.getByTestId('chat-header-more').click();
  await tab.getByRole('menuitem', { name: /Subscription usage/ }).click();
}

/** Opens the overlay with `open` and waits for one more answer than `seen`, which shows this computer's sign-in states. */
async function expectLocalUsage(tab: Page, seen: number, open: (tab: Page) => Promise<void>): Promise<number> {
  await open(tab);
  const overlay = tab.getByTestId('subscription-usage-overlay');
  await expect(overlay).toBeVisible();
  let answers: UsageAnswer[] = [];
  await expect.poll(async () => (answers = await usageAnswers(tab)).length, { timeout: 60_000 }).toBeGreaterThan(seen);
  // the hermetic home holds no subscription sign-in, so this computer's core answers both as not connected
  expect(answers.at(-1)).toMatchObject({ claude: { status: 'not-connected' }, gpt: { status: 'not-connected' } });
  await expect(overlay.getByTestId('usage-claude')).toContainText('Sign in with your Claude subscription in Settings to see usage');
  await expect(overlay.getByTestId('usage-gpt')).toContainText('Sign in with ChatGPT in Settings to see usage');
  await expect(overlay).not.toContainText(REMOTE_REFUSAL);
  await tab.keyboard.press('Escape');
  await expect(overlay).toBeHidden();
  return answers.length;
}

test('a remote chat\'s /usage shows this computer\'s subscription usage, also while the host is away, and never asks the remote core', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const { fixture } = target;
  const stub = await startTargetStub(home, fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(app, hostId, APP);
    const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const tab = await newRemoteChat(app, key);
    await recordHostMessages(tab);

    let seen = await expectLocalUsage(tab, 0, typeUsage);

    // the host away: the read never needed it
    target.proxy.refuse();
    await expect(tab.getByTestId('chat-connection-banner')).toBeVisible({ timeout: 30_000 });
    seen = await expectLocalUsage(tab, seen, headerUsage);
    target.proxy.restore();
    const shell = await shellPage(app);
    await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.getState())).projects.find((project) => project.key === key)?.connection, { timeout: 120_000 }).toBe('connected');

    // a daemon's core answers every request with its refusal, so none of the page's answers came from it
    for (const answer of await usageAnswers(tab)) expect(JSON.stringify(answer)).not.toContain(REMOTE_REFUSAL);
    expect(seen).toBe(2);
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
