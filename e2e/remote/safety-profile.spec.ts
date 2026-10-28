import type { Locator, Page } from '@playwright/test';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { closeSettingsModal } from '../desktop/support/settings';
import { shellPage } from '../desktop/support/shell';
import { projectRow, titleBar } from '../desktop/support/shell-ui';
import { awaitTurnEnd, hostMessages, postFromWebview, recordHostMessages } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { openRemoteHostSettings, setHostSwitch, storedHost } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// the shown permission card: one that answered leaves through a transition while the next one enters
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');

test('prod-1 in red: its badge and the title-bar stripe take the tone, a rename in Settings relabels the stripe at once; without Allow YOLO the control is hidden and a forged switch refused, with it YOLO runs a command unasked', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const stub = await startTargetStub(home, fixture);
  try {
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    const key = await openRemoteFolder(app, hostId, APP);
    await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
    const shell = await shellPage(app);
    await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
    const badge = projectRow(shell, key).getByTestId('host-badge');
    const stripe = titleBar(shell).getByTestId('title-bar-stripe');
    const label = titleBar(shell).getByTestId('title-bar-stripe-label');

    // Red: the badge and the stripe take the danger tone, and the stripe's label names the host.
    const { overlay, block } = await openRemoteHostSettings(app, hostId);
    const red = block.getByRole('radiogroup', { name: 'Color' }).getByRole('radio', { name: 'Red', exact: true });
    await red.click();
    await expect(red).toBeChecked();
    await expect(badge).toHaveClass(/\bd-tone-danger\b/);
    await expect(stripe).toHaveAttribute('data-tone', 'danger');
    await expect(label).toHaveAttribute('data-tone', 'danger');
    await expect(label).toHaveText(/^\s*On prod-1\s*prod-1\s*$/);

    // A rename in Settings relabels the stripe while the modal is still open.
    const name = block.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill('PROD');
    await name.press('Enter');
    await expect(label).toHaveText(/^\s*On PROD\s*PROD\s*$/);
    expect(storedHost(home, hostId)).toMatchObject({ name: 'PROD', color: 'danger' });
    await closeSettingsModal(overlay);

    // Allow YOLO off (the default): no YOLO control, a forged switch is refused, and a command still asks.
    let tab = await newRemoteChat(app, key);
    await recordHostMessages(tab);
    await expect(tab.getByTestId('composer-yolo')).toHaveCount(0);
    await postFromWebview(tab, { type: 'setDangerouslySkipPermissions', enabled: true });
    await postFromWebview(tab, { type: 'setPermissionMode', mode: 'bypassPermissions' });
    await expect.poll(async () => (await hostMessages(tab, 'permissionModeRefused')).map((message) => String(message['mode']))).toEqual(['dangerouslySkipPermissions', 'bypassPermissions']);
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo asked-on-prod' } }] }, { chunks: ['Asked first.'] });
    await sendPrompt(tab, 'Run it on prod');
    await expect(permissionCard(tab)).toContainText('echo asked-on-prod', { timeout: 60_000 });
    await permissionCard(tab).getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(tab.getByText('Asked first.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);

    // Allow YOLO on: a new chat shows the control, and with YOLO on the command runs without a card.
    const settings = await openRemoteHostSettings(app, hostId);
    await setHostSwitch(settings.block, 'Allow YOLO', true);
    await closeSettingsModal(settings.overlay);
    tab = await newRemoteChat(app, key);
    const yolo = tab.getByTestId('composer-yolo');
    await expect(yolo).toBeVisible();
    await yolo.click();
    await expect(yolo).toHaveAttribute('aria-pressed', 'true');
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo yolo-on-prod' } }] }, { chunks: ['Ran unasked.'] });
    await sendPrompt(tab, 'Run it with YOLO');
    await expect(tab.getByText('Ran unasked.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    await expect(permissionCard(tab)).toHaveCount(0);

    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await stub.close();
  }
});
