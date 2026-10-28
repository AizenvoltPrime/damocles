import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator } from '@playwright/test';
import { settled, showShellTheme, THEMES } from '../desktop/support/screenshots';
import { activeChat } from '../desktop/support/fixtures';
import { overlayPage, shellPage } from '../desktop/support/shell';
import { browseTo, changedKey, connectDialog, connectDialogClosed, firstConnection, folderBrowser, hostCard, openConnect, timeline, trustQuestion } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { dropConnection, expect, hostNamed, remoteEnv, remoteProjectKey, test } from './support/remote';

// Review captures of the Connect UI in both themes, not tests: only the screenshots project matches them.
const SHOTS = process.env['DAMOCLES_REMOTE_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-remote-shots');

async function capture(app: ElectronApplication, name: string, target: () => Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    const element = target();
    await settled(await overlayPage(app));
    await element.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
  }
}

test('Connect dialog, timeline, host-key dialogs, folder browser and offline banner', async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1', { trusted: false });
  await sshd('staging');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const overlay = await openConnect(app);
  await expect(hostCard(overlay, 'prod-1')).toBeVisible();
  await capture(app, 'connect-dialog', () => connectDialog(overlay));

  await hostCard(overlay, 'prod-1').click();
  await expect(firstConnection(overlay, 'prod-1')).toBeVisible({ timeout: 60_000 });
  await capture(app, 'host-key-first-connection', () => firstConnection(overlay, 'prod-1'));
  const held = mirror.holdDownloads();
  await firstConnection(overlay, 'prod-1').getByRole('button', { name: 'Connect', exact: true }).click();
  await held.reached;
  await expect(timeline(overlay, 'prod-1')).toHaveAttribute('aria-valuetext', /^Installing, \d+%$/, { timeout: 60_000 });
  await capture(app, 'timeline-installing', () => overlay.getByRole('dialog'));
  held.release();
  await expect(folderBrowser(overlay, 'prod-1')).toBeVisible({ timeout: 120_000 });
  await capture(app, 'folder-browser', () => folderBrowser(overlay, 'prod-1'));
  const browser = await browseTo(overlay, 'prod-1', '/srv/app');
  await browser.getByRole('button', { name: 'Open', exact: true }).click();
  const question = trustQuestion(overlay, '/srv/app', 'prod-1');
  await expect(question).toBeVisible();
  await capture(app, 'trust-over-connect', () => overlay.locator('body'));
  await question.getByRole('button', { name: 'Trust Folder' }).click();
  await connectDialogClosed(overlay);
  const host = await hostNamed(app, 'prod-1');
  const key = await remoteProjectKey(app, host, '/srv/app');

  // a dropped connection puts the offline banner under the selected chat's header
  const shell = await shellPage(app);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);
  const chat = await activeChat(app);
  await shutdownHostDaemon(app, host.hostId, fixture);
  await dropConnection(app, host.hostId);
  await expect(chat.getByTestId('chat-connection-banner')).toBeVisible({ timeout: 60_000 });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await chat.getByTestId('chat-connection-banner').screenshot({ path: path.join(SHOTS, `offline-banner-${theme}.png`), animations: 'disabled' });
  }

  // a changed key: the security alert
  await fixture.rotateHostKey();
  await openConnect(app);
  await hostCard(overlay, 'prod-1').click();
  await expect(changedKey(overlay, 'prod-1')).toBeVisible({ timeout: 60_000 });
  await capture(app, 'host-key-changed', () => changedKey(overlay, 'prod-1'));
});
