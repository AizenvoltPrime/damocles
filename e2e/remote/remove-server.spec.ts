import { generateKeyPairSync } from 'node:crypto';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { closeSettingsModal } from '../desktop/support/settings';
import { answerDialogs } from '../desktop/support/ui';
import { shellPage, shellState } from '../desktop/support/shell';
import { openTerminal, runInTerminal } from '../desktop/support/terminal';
import { writeUserSettings } from '../desktop/support/hermetic';
import { connectDialog, hostCard, openConnect, openInBrowser } from './support/connect-ui';
import { fakeLoginctl, lingering, loginctlCalls, newPassword, userAuthorizedKeys, usePasswords } from './support/credentials';
import { serverProcesses } from './support/daemon-teardown';
import { connectAnswering, openRemoteHostSettings, removeServerDialog, storedHost } from './support/host-settings-ui';
import { addHost, expect, hostNamed, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { TARGET_HOME, type SshdFixture } from './support/sshd';

const APP = '/srv/app';
const REMOVE_KEY = 'Remove the key Damocles installed';
const DISABLE_LINGER = 'Disable linger';

/** An authorized_keys line of a key that is not Damocles', which the user installed. */
function otherKeyLine(): string {
  const raw = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32);
  const field = (bytes: Buffer): Buffer => Buffer.concat([Buffer.from([0, 0, 0, bytes.length]), bytes]);
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from('ssh-ed25519')), field(raw)]).toString('base64')} someone-else`;
}

const serverFolder = async (fixture: SshdFixture): Promise<boolean> => (await fixture.sh(`if [ -e ${TARGET_HOME}/.damocles/server ]; then echo yes; fi`)).trim() === 'yes';

/** Opens Remove Damocles server from Settings > Remote hosts; resolves with the overlay page and the dialog. */
async function openRemoval(app: ElectronApplication, hostId: string): Promise<{ overlay: Page; dialog: Locator }> {
  const { overlay, block } = await openRemoteHostSettings(app, hostId);
  await block.getByRole('button', { name: /^Remove Damocles server/ }).click();
  const dialog = removeServerDialog(overlay);
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAccessibleName('Remove the Damocles server from prod-1?');
  return { overlay, dialog };
}

/** Opens the Connect dialog on prod-1's card; resolves with the overlay page and the card. */
async function openCard(app: ElectronApplication): Promise<{ overlay: Page; card: Locator }> {
  const overlay = await openConnect(app);
  await connectDialog(overlay).getByRole('button', { name: 'Details for prod-1' }).click();
  const card = overlay.getByTestId('host-card');
  await expect(card).toBeVisible();
  return { overlay, card };
}

/**
 * Opens one of the card's questions, which must take the pointer and the keyboard over the Connect dialog: Tab reaches its
 * second button, and Cancel by mouse leaves the Connect dialog on the card.
 */
async function cancelFromCard(overlay: Page, card: Locator, action: string, question: Locator): Promise<void> {
  await card.getByRole('button', { name: action, exact: true }).click();
  await expect(question).toBeVisible();
  await expect(question.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await overlay.keyboard.press('Tab');
  await expect(question.getByRole('button', { name: 'Cancel', exact: true })).not.toBeFocused();
  await expect(question.locator(':focus')).toHaveCount(1);
  await question.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(question).toBeHidden();
  await expect(card).toBeVisible();
}

/** Confirms the removal and waits for its outcome, then for the account to have no process left. */
async function remove(overlay: Page, dialog: Locator, fixture: SshdFixture): Promise<void> {
  await dialog.getByRole('button', { name: 'Remove server', exact: true }).click();
  await expect(overlay.getByTestId('remove-server-result')).toHaveRole('status', { timeout: 120_000 });
  // the removal ends Damocles' master connection too
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
  await closeSettingsModal(overlay);
}

test('Remove Damocles server lists the running terminal, leaves no ~/.damocles/server and no daemon, and removes the key line and linger only when their boxes are checked', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1', { config: ['PreferredAuthentications publickey,password'] });
  const password = newPassword();
  await usePasswords(fixture, { dev: password });
  await fakeLoginctl(fixture);
  const other = otherKeyLine();
  await fixture.sh('mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat > ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys', 'dev', `${other}\n`);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });

  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const host = await hostNamed(app, 'prod-1');
  const connect = await openConnect(app);
  await connectAnswering(app, connect, hostId, () => hostCard(connect, 'prod-1').click(), { "dev@127.0.0.1's password:": { answer: password } });
  await openInBrowser(connect, 'prod-1', APP);
  await remoteProjectKey(app, host, APP);

  // Nothing Damocles changed yet: the dialog offers neither box.
  let removal = await openRemoval(app, host.hostId);
  await expect(removal.dialog.getByRole('checkbox')).toHaveCount(0);
  await removal.dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(removal.dialog).toHaveCount(0);
  await closeSettingsModal(removal.overlay);

  // Both questions open over the Connect dialog's card as well, and Cancel leaves the dialog on the card.
  const fromCard = await openCard(app);
  await cancelFromCard(fromCard.overlay, fromCard.card, 'Forget host', fromCard.overlay.getByRole('alertdialog', { name: 'Forget prod-1?' }));
  await cancelFromCard(fromCard.overlay, fromCard.card, 'Remove Damocles server...', removeServerDialog(fromCard.overlay));
  expect(storedHost(home, host.hostId)).toBeDefined();
  expect(await serverFolder(fixture)).toBe(true);
  await fromCard.overlay.keyboard.press('Escape');
  await expect(fromCard.overlay.getByTestId('connect-dialog')).toHaveCount(0);

  // Damocles installs its key and turns linger on through Allow background work; the host store records both.
  const settings = await openRemoteHostSettings(app, host.hostId);
  await settings.block.getByRole('button', { name: 'Set up passwordless login', exact: true }).click();
  await expect(settings.block.locator('[data-testid="passwordless-step"][data-step="verify"]')).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await closeSettingsModal(settings.overlay);
  const card = await openConnect(app);
  await connectDialog(card).getByRole('button', { name: 'Details for prod-1' }).click();
  await card.getByTestId('host-card').getByTestId('allow-background-work-button').click();
  await expect.poll(() => lingering(fixture)).toBe(true);
  await card.keyboard.press('Escape');
  const damoclesKey = (await userAuthorizedKeys(fixture)).find((line) => line !== other)!;
  expect(damoclesKey).toMatch(/ damocles@\S+$/);
  expect(storedHost(home, host.hostId)).toMatchObject({ lingerEnabledByDamocles: true, installedKeyFingerprint: expect.stringMatching(/^SHA256:/) });

  // A terminal running on prod-1 is listed as running work.
  await openTerminal(app);
  await runInTerminal(await shellPage(app), 'sleep 600');
  await expect.poll(async () => (await fixture.userProcesses()).some((line) => / sleep 600$/.test(line))).toBe(true);

  // Both boxes offered, the key's checked by default; with neither checked the server goes and the key and linger stay. This
  // removal runs from the Connect dialog's card, which stays open on the card while it runs and after.
  const removing = await openCard(app);
  await removing.card.getByRole('button', { name: 'Remove Damocles server...', exact: true }).click();
  const fromCardDialog = removeServerDialog(removing.overlay);
  await expect(fromCardDialog).toHaveAccessibleName('Remove the Damocles server from prod-1?');
  await expect(fromCardDialog.locator('[data-testid="removal-run"][data-kind="terminal"]')).toHaveCount(1);
  await expect(fromCardDialog.getByRole('checkbox', { name: REMOVE_KEY, exact: true })).toBeChecked();
  await expect(fromCardDialog.getByRole('checkbox', { name: DISABLE_LINGER, exact: true })).not.toBeChecked();
  await fromCardDialog.getByRole('checkbox', { name: REMOVE_KEY, exact: true }).uncheck();
  await fromCardDialog.getByRole('button', { name: 'Remove server', exact: true }).click();
  await expect(removing.card.getByTestId('remove-server-result')).toHaveRole('status', { timeout: 120_000 });
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
  await expect(removing.card).toBeVisible();
  await removing.overlay.keyboard.press('Escape');
  await expect(removing.overlay.getByTestId('connect-dialog')).toHaveCount(0);
  expect(await serverFolder(fixture)).toBe(false);
  expect(await serverProcesses(fixture)).toEqual([]);
  expect(await userAuthorizedKeys(fixture)).toEqual([other, damoclesKey]);
  expect(await lingering(fixture)).toBe(true);
  expect((await loginctlCalls(fixture)).filter((line) => line.includes('disable-linger'))).toEqual([]);

  // The key still signs in with nothing asked; a second removal with both boxes checked takes the key line and linger too.
  await openRemoteFolder(app, host.hostId, APP);
  expect(await serverFolder(fixture)).toBe(true);
  removal = await openRemoval(app, host.hostId);
  await removal.dialog.getByRole('checkbox', { name: DISABLE_LINGER, exact: true }).check();
  await expect(removal.dialog.getByRole('checkbox', { name: REMOVE_KEY, exact: true })).toBeChecked();
  await remove(removal.overlay, removal.dialog, fixture);
  expect(await serverFolder(fixture)).toBe(false);
  expect(await serverProcesses(fixture)).toEqual([]);
  expect(await userAuthorizedKeys(fixture)).toEqual([other]);
  expect(await lingering(fixture)).toBe(false);
  expect((await loginctlCalls(fixture)).filter((line) => line.includes('disable-linger'))).toEqual(['--no-ask-password disable-linger dev']);
  const stored = storedHost(home, host.hostId);
  expect(stored?.installedKeyFingerprint).toBeUndefined();
  expect(stored?.lingerEnabledByDamocles).toBeUndefined();

  // Forget host from the card forgets it, and the dialog goes back to its host list.
  const forgetting = await openCard(app);
  await forgetting.card.getByRole('button', { name: 'Forget host', exact: true }).click();
  const forget = forgetting.overlay.getByRole('alertdialog', { name: 'Forget prod-1?' });
  await forget.getByRole('button', { name: 'Forget host', exact: true }).click();
  await expect.poll(() => storedHost(home, host.hostId)).toBeUndefined();
  // the shell's state still builds, with no host and no engine of the forgotten one
  await expect.poll(async () => {
    const state = await shellState(app);
    return [state.hosts.length, state.engines.filter((engine) => engine.authority === `ssh+${host.hostId}`).length];
  }).toEqual([0, 0]);
  await expect(forgetting.card).toHaveCount(0);
  await expect(connectDialog(forgetting.overlay)).toBeVisible();
  await forgetting.overlay.keyboard.press('Escape');
  await expect(forgetting.overlay.getByTestId('connect-dialog')).toHaveCount(0);
});
