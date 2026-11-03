import type { Locator, Page } from '@playwright/test';
import { activeChat } from '../desktop/support/fixtures';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { closeSettingsModal } from '../desktop/support/settings';
import { shellPage, shellState } from '../desktop/support/shell';
import { projectRow, titleBar } from '../desktop/support/shell-ui';
import { awaitTurnEnd, hostMessages, postFromWebview, recordHostMessages } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { exited, requestQuit } from './support/remote-runs';
import { openRemoteHostSettings, setHostSwitch, storedHost } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
// the shown permission card: one that answered leaves through a transition while the next one enters
const permissionCard = (tab: Page): Locator => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');

test('prod-1 in red: its badge, the title-bar stripe and the host chip take the tone, a rename in Settings renames the chip at once; without Allow YOLO the control is locked and a forged switch refused, with it YOLO runs a command unasked', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
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
    const chip = titleBar(shell).getByTestId('title-bar-host');
    const label = chip.getByTestId('title-bar-host-name');

    // Red: the badge, the stripe and the chip take the danger tone, and the chip names the host.
    const { overlay, block } = await openRemoteHostSettings(app, hostId);
    const red = block.getByRole('radiogroup', { name: 'Color' }).getByRole('radio', { name: 'Red', exact: true });
    await red.click();
    await expect(red).toBeChecked();
    await expect(badge).toHaveClass(/\bd-tone-danger\b/);
    await expect(stripe).toHaveAttribute('data-tone', 'danger');
    await expect(chip).toHaveAttribute('data-tone', 'danger');
    await expect(label).toHaveClass(/\bd-tone-danger\b/);
    await expect(label).toHaveText('prod-1');

    // A rename in Settings renames the chip while the modal is still open.
    const name = block.getByRole('textbox', { name: 'Name', exact: true });
    await name.fill('PROD');
    await name.press('Enter');
    await expect(label).toHaveText('PROD');
    expect(storedHost(home, hostId)).toMatchObject({ name: 'PROD', color: 'danger' });
    await closeSettingsModal(overlay);

    // The chip opens the host's card as a popover, and Escape closes it.
    await chip.click();
    const popover = overlay.locator('[data-testid="connect-dialog"][data-popover]');
    await expect(popover.getByTestId('host-card-name')).toHaveText('PROD');
    await expect(popover.getByTestId('host-card-safety')).toContainText('YOLO not allowed');
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByTestId('connect-dialog')).toHaveCount(0);
    await expect(chip).toHaveAttribute('aria-expanded', 'false');

    // Allow YOLO off (the default): the YOLO control is locked, a forged switch is refused, and a command still asks.
    let tab = await newRemoteChat(app, key);
    await recordHostMessages(tab);
    await expect(tab.getByTestId('composer-yolo')).toHaveAttribute('data-locked', '');
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
    await expect(yolo).not.toHaveAttribute('data-locked');
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

test('prod-1 in a 60% teal custom color: the hex field writes it once, and the badge, stripe and chip show it again after a relaunch', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const env = { env: remoteEnv(ssh, mirror) };
  const first = await launch(env);
  const hostId = await addHost(first.app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(first.app, hostId, APP);
  const key = await remoteProjectKey(first.app, { authorityKey: `ssh+${hostId}` }, APP);
  // the remote chat's selection re-attaches an open settings modal, whose page then remounts and drops the open picker
  await expect.poll(async () => {
    const { selected } = await shellState(first.app);
    return selected.projectKey === key && selected.chatId !== undefined;
  }, { timeout: 60_000 }).toBe(true);
  await activeChat(first.app);

  const { overlay, block } = await openRemoteHostSettings(first.app, hostId);
  const custom = block.getByRole('radiogroup', { name: 'Color' }).getByRole('radio', { name: 'Custom color', exact: true });
  // a plain radio that opens the picker from the keyboard, with no popup state of its own
  await expect(custom).not.toHaveAttribute('aria-expanded');
  await custom.focus();
  await overlay.keyboard.press('Space');
  const picker = overlay.getByTestId('host-color-picker');
  await expect(picker.getByRole('group', { name: 'Color area' }).getByRole('slider', { name: 'Saturation and brightness' })).toBeVisible();
  const hex = picker.getByRole('textbox', { name: 'Hex color' });
  await hex.fill('#00808099');
  await hex.press('Enter');
  await expect.poll(() => storedHost(home, hostId)?.color).toBe('#00808099');
  // the value is already written, so Escape only closes the picker
  await overlay.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(custom).toBeChecked();
  await expect(custom).toBeFocused();
  expect(storedHost(home, hostId)?.color).toBe('#00808099');
  await closeSettingsModal(overlay);

  // the color is this computer's, so the relaunch shows it with the host offline, and no launch starts a daemon again
  await shutdownHostDaemon(first.app, hostId, fixture);
  await fixture.stopSshd();
  await requestQuit(first.app);
  await exited(first);
  const second = await launch(env);
  await expect.poll(async () => (await shellState(second.app)).projects.some((project) => project.key === key), { timeout: 60_000 }).toBe(true);
  const shell = await shellPage(second.app);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  await expect(projectRow(shell, key).getByTestId('host-badge')).toHaveClass(/\bd-tone-custom\b/);
  await expect(titleBar(shell).getByTestId('title-bar-stripe')).toHaveAttribute('data-tone', 'custom');
  const chip = titleBar(shell).getByTestId('title-bar-host');
  await expect(chip).toHaveAttribute('data-tone', 'custom');
  await expect(chip.getByTestId('title-bar-host-name')).toHaveClass(/\bd-tone-custom\b/);
  expect(await fixture.userProcesses()).toEqual([]);
});
