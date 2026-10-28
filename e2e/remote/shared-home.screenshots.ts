import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { settled, showShellTheme, THEMES } from '../desktop/support/screenshots';
import { overlayPage, popupPage, popupToasts } from '../desktop/support/shell';
import { openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, test } from './support/remote';
import { TARGET_HOME, TARGET_USER } from './support/sshd';

// Review captures of the shared home notification and the host card's notice in both themes, not tests: only the
// screenshots project matches them.
const SHOTS = process.env['DAMOCLES_REMOTE_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-remote-shots', 'shared-home');

async function capture(app: ElectronApplication, page: Page, name: string, target: () => Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(page);
    await target().screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
  }
}

test('the shared home notification and the host card notice', async ({ launch, mirror, ssh, sshd }) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  const record = JSON.stringify({ version: '3.7.0', pid: 4242, hostname: 'lab-03', endpoint: '/tmp/damocles-lab03/daemon.sock', socketFolder: '/tmp/damocles-lab03', updatedAt: Date.now() });
  await fixture.sh(`mkdir -p ${TARGET_HOME}/.damocles/server/run-0123456789abcdef && cat > ${TARGET_HOME}/.damocles/server/run-0123456789abcdef/daemon.pid`, TARGET_USER, `${record}\n`);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, '/srv/app');

  const popup = await popupPage(app, 60_000);
  const toast = popupToasts(popup).filter({ hasText: 'lab-03 also runs Damocles in this home' });
  await expect(toast).toHaveCount(1, { timeout: 60_000 });
  await toast.hover();
  await capture(app, popup, 'toast', () => toast);
  await popup.mouse.move(0, 0);

  const overlay = await overlayPage(app);
  await openConnect(app);
  await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
  const card = overlay.getByTestId('host-card');
  await expect(card.locator('[data-testid="host-notice"][data-code="sharedHome"]')).toBeVisible();
  await capture(app, overlay, 'host-card', () => overlay.getByRole('dialog'));
  await overlay.keyboard.press('Escape');
  await shutdownHostDaemon(app, hostId, fixture);
});
