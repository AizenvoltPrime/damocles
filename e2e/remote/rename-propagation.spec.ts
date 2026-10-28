import type { Locator, Page } from '@playwright/test';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { shellPage } from '../desktop/support/shell';
import { awaitTurnEnd } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv, remoteHosts, remoteProjectKey, SSH_TAG } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// the shown permission card: one that answered leaves through a transition while the next one enters
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');

test('with an open prod-1 chat page, renaming prod-1 updates the page\'s permission card and its connection banner text at once', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  const stub = await startTargetStub(home, target.fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(app, hostId, APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const shell = await shellPage(app);
    const tab = await newRemoteChat(app, key);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'printf named-%s ok' } }] }, { chunks: ['Ran it.'] });
    await sendPrompt(tab, 'Run a command');
    const title = permissionCard(tab).getByTestId('permission-title');
    await expect(title).toHaveText('Run this command on prod-1?', { timeout: 60_000 });

    target.proxy.refuse();
    const banner = tab.getByTestId('chat-connection-banner');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('prod-1');

    await shell.evaluate(([id, name]) => window.damoclesShell!.renameHost(id!, name!), [hostId, 'billing-prod']);
    await expect.poll(async () => (await remoteHosts(app)).find((host) => host.hostId === hostId)?.name).toBe('billing-prod');
    // both texts follow in the same republish: the card's title and the banner's, with no trace of the old name
    await expect(title).toHaveText('Run this command on billing-prod?');
    await expect(banner).toContainText('billing-prod');
    await expect(banner).not.toContainText('prod-1');

    target.proxy.restore();
    await expect(banner).toHaveCount(0, { timeout: 120_000 });
    await permissionCard(tab).getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(tab.getByText('Ran it.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await shutdownHostDaemon(app, hostId, target.fixture);
  } finally {
    await stub.close();
  }
});
