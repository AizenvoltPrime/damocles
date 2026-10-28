import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { ShellHost } from '../../src/desktop/preload/shell-channels';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { settled, showShellTheme, THEMES } from '../desktop/support/screenshots';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { changedKey, connectDialog, openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv } from './support/remote';
import { newRemoteChat } from './support/target-agent';

// Review captures of the reconnect and offline UI in both themes, not tests: only the screenshots project matches them.
const SHOTS = process.env['DAMOCLES_RECONNECT_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-reconnect-shots');
const MEASUREMENT_MS = 60_000 + 5 * 2000;

async function capture(app: ElectronApplication, name: string, page: Page, target: () => Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(page);
    await target().screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
  }
}

async function host(app: ElectronApplication, hostId: string): Promise<ShellHost> {
  const found = (await shellState(app)).hosts.find((candidate) => candidate.hostId === hostId);
  if (!found) throw new Error(`no host ${hostId}`);
  return found;
}

test('slow ring and sparkline, reconnect countdown with queued messages, dimmed Files and the permanent failure', async ({ foreground: _foreground, launch, mirror, ssh, proxied }) => {
  test.setTimeout(900_000);
  const target = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, '/srv/app');
  const tab = await newRemoteChat(app, key);
  const shell = await shellPage(app);
  await shell.evaluate(() => window.damoclesShell!.setProjectsView('grouped'));

  // the first measurement is fast; a measurement over 1500 ms is slow on its own
  await expect.poll(async () => (await host(app, hostId)).latency?.history.length ?? 0, { timeout: MEASUREMENT_MS }).toBeGreaterThanOrEqual(1);
  target.proxy.delay(1600);
  await expect.poll(async () => (await host(app, hostId)).latency?.slow, { timeout: MEASUREMENT_MS + 30_000 }).toBe(true);
  await capture(app, 'sidebar-slow', shell, () => shell.getByTestId('sidebar'));
  const overlay = await openConnect(app);
  await connectDialog(overlay).getByTestId('host-details').click();
  await expect(overlay.getByTestId('host-latency-sparkline')).toBeVisible();
  await capture(app, 'host-card-slow', overlay, () => overlay.getByRole('dialog'));
  await overlay.keyboard.press('Escape');
  await overlay.keyboard.press('Escape');
  target.proxy.delay(0);

  target.proxy.refuse();
  await expect(tab.getByTestId('chat-connection-banner-countdown')).toBeVisible({ timeout: 60_000 });
  for (const text of ['Run the migrations', 'Then restart the API']) await sendPrompt(tab, text);
  await expect(tab.getByTestId('held-message')).toHaveCount(2);
  await capture(app, 'chat-reconnecting', tab, () => tab.locator('body'));
  await capture(app, 'sidebar-reconnecting', shell, () => shell.getByTestId('sidebar'));

  // the host is reinstalled while away: the next attempt meets a changed key, the one failure that stops the loop
  await target.fixture.rotateHostKey();
  target.proxy.restore();
  await expect(tab.getByTestId('chat-connection-banner')).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
  const keyDialog = changedKey(await overlayPage(app), 'prod-1');
  await expect(keyDialog).toBeVisible();
  await keyDialog.getByRole('button', { name: 'Close' }).click();
  await capture(app, 'chat-failed', tab, () => tab.getByTestId('chat-connection-banner'));

  await ssh.trust(target.fixture);
  await tab.getByTestId('chat-connection-banner-reconnect').click();
  await expect(tab.getByTestId('held-message')).toHaveCount(0, { timeout: 120_000 });
  await shutdownHostDaemon(app, hostId, target.fixture);
});
