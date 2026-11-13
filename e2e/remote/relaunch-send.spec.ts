import type { ElectronApplication, Page } from '@playwright/test';
import type { StubReply } from '../desktop/support/openai-stub';
import { awaitTurnEnd, chatInput } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { chatShowing, closeRemoteDialog, exited, requestQuit } from './support/remote-runs';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// A relaunch reattaches the daemon's core at once, with this computer's sign-ins pending until its core has read them
// (UserRelays.attach); a send right after it waits for them and must reach the model, not come back to the composer.

const APP = '/srv/app';
const CHECKED = { timeout: 60_000 };

async function echoTurn(tab: Page, prompt: string): Promise<void> {
  await chatInput(tab).fill(prompt);
  await chatInput(tab).press('Enter');
  await expect(chatInput(tab)).toHaveValue('', CHECKED);
  await expect(tab.getByText(`Echo: ${prompt}`, { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);
}

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

test('a remote chat idle at quit, and a new chat on its host, send right after a relaunch', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { hostId, key } = await connect(first.app);
    await echoTurn(await newRemoteChat(first.app, key), 'One.');
    await requestQuit(first.app);
    await exited(first);

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    await echoTurn(await chatShowing(second.app, 'Echo: One.'), 'Two.');
    await echoTurn(await newRemoteChat(second.app, key), 'Three.');
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});

test('a remote chat whose turn runs across a relaunch sends once that turn ends', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    const env = { env: remoteEnv(ssh, mirror) };
    const first = await launch(env);
    const { hostId, key } = await connect(first.app);
    const tab = await newRemoteChat(first.app, key);
    let release: () => void = () => undefined;
    const held: StubReply = { chunks: ['Held one.', ' Held two.'], holds: [{ before: 1, until: new Promise<void>((resolve) => { release = resolve; }) }] };
    stub.replies.push(held);
    await chatInput(tab).fill('Hold.');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Held one.', { exact: false })).toBeVisible(CHECKED);
    await requestQuit(first.app);
    const { dialog } = await closeRemoteDialog(first.app);
    await dialog.getByRole('button', { name: 'Keep running' }).click();
    await exited(first);

    const second = await launch(env);
    await remoteProjectKey(second.app, { authorityKey: `ssh+${hostId}` }, APP);
    const again = await chatShowing(second.app, 'Held one.');
    release();
    await expect(again.getByText('Held one. Held two.', { exact: false })).toBeVisible(CHECKED);
    await awaitTurnEnd(again);
    await echoTurn(again, 'Two.');
    await echoTurn(await newRemoteChat(second.app, key), 'Three.');
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
