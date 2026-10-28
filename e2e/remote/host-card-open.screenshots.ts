import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { cleanUp } from '../desktop/support/loopback';
import { settled, showShellTheme, THEMES } from '../desktop/support/screenshots';
import { closeSettingsModal, openSettingsModal, settingsNav } from '../desktop/support/settings';
import { activeChat } from '../desktop/support/fixtures';
import { overlayPage, shellPage } from '../desktop/support/shell';
import { activeTerminal, openTerminal, runInTerminal } from '../desktop/support/terminal';
import { openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, test } from './support/remote';
import { secondDevice } from './support/second-device';

// Review captures of the host card's Open action on another device's terminal and the title bar stripe in both themes, not
// tests: only the screenshots project matches them.
const SHOTS = process.env['DAMOCLES_REMOTE_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-remote-shots', 'host-card-open');
const APP = '/srv/app';

async function capture(app: ElectronApplication, page: Page, name: string, target: () => Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(page);
    await target().screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
  }
}

test('host card Open on another device\'s terminal, and the title bar stripe', async ({ foreground: _foreground, launch, mirror, ssh, sshd }, testInfo) => {
  test.setTimeout(400_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const other = await secondDevice(fixture, 'prod-1', mirror);
  let failure: unknown;
  try {
    const first = (await launch({ env: remoteEnv(ssh, mirror) })).app;
    const hostId = await addHost(first, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(first, hostId, APP);
    await runInTerminal(await openTerminal(first), 'top');

    // prod-1 recolored red, so the title bar shows its stripe
    await activeChat(first);
    const firstOverlay = await overlayPage(first);
    await openSettingsModal(first);
    await firstOverlay.getByTestId('settings-scope-user').click();
    await settingsNav(firstOverlay, 'remoteHosts').click();
    await firstOverlay.locator(`[data-testid="remote-host-pick"][data-host-id="${hostId}"]`).click();
    const block = firstOverlay.locator(`[data-testid="remote-host"][data-host-id="${hostId}"]`);
    await block.getByRole('radiogroup', { name: 'Color' }).getByRole('radio', { name: 'Red', exact: true }).click();
    await closeSettingsModal(firstOverlay);
    const firstShell = await shellPage(first);
    await expect(firstShell.getByTestId('title-bar-stripe')).toHaveAttribute('data-tone', 'danger');
    await capture(first, firstShell, 'title-bar-stripe', () => firstShell.getByTestId('title-bar'));

    const secondDesktop = await other.launch();
    const second = secondDesktop.app;
    const secondHostId = await addHost(second, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(second, secondHostId, APP);
    const overlay = await openConnect(second);
    await overlay.getByRole('button', { name: 'Details for prod-1' }).click();
    const open = overlay.getByTestId('host-card').getByTestId('host-run-open');
    await expect(open).toHaveCount(1);
    await expect(open).toHaveAccessibleName(/^Open /);
    await capture(second, overlay, 'host-card-open', () => overlay.getByRole('dialog'));

    // Open gives the terminal a tab here and the dialog makes way
    await open.click();
    await expect(overlay.getByTestId('connect-dialog')).toHaveCount(0);
    await expect(activeTerminal(await shellPage(second))).toHaveAttribute('data-status', 'running');

    await secondDesktop.close();
    await shutdownHostDaemon(first, hostId, fixture);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => other.dispose(testInfo, failure !== undefined));
  }
});
