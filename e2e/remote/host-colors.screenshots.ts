import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat } from '../desktop/support/fixtures';
import { settled, showShellTheme, THEMES } from '../desktop/support/screenshots';
import { closeSettingsModal } from '../desktop/support/settings';
import { shellPage, shellState } from '../desktop/support/shell';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { openRemoteHostSettings } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, test } from './support/remote';

// Review captures of a custom host color, not tests: the picker, the settings swatch and the title bar in both themes, for a
// translucent teal, a pale yellow (a black label) and a nearly transparent red. Only the screenshots project matches them.
const SHOTS = process.env['DAMOCLES_REMOTE_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-remote-shots', 'host-colors');
const APP = '/srv/app';

async function capture(app: ElectronApplication, page: Page, name: string, target: () => Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(page);
    await target().screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
  }
}

test('custom host colors in the picker, the settings swatch and the title bar', async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(400_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  const key = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  await expect.poll(async () => {
    const { selected } = await shellState(app);
    return selected.projectKey === key && selected.chatId !== undefined;
  }, { timeout: 60_000 }).toBe(true);
  await activeChat(app);
  const shell = await shellPage(app);

  for (const [name, hex] of [['teal-60', '#00808099'], ['yellow', '#ffff80ff'], ['red-10', '#ff00001a']] as const) {
    const { overlay, block } = await openRemoteHostSettings(app, hostId);
    const colors = block.getByRole('radiogroup', { name: 'Color' });
    await colors.getByRole('radio', { name: 'Custom color', exact: true }).click();
    const picker = overlay.getByTestId('host-color-picker');
    const hexField = picker.getByRole('textbox', { name: 'Hex color' });
    await hexField.fill(hex);
    await hexField.press('Enter');
    await capture(app, overlay, `picker-${name}`, () => picker);
    await overlay.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await capture(app, overlay, `swatches-${name}`, () => colors);
    await closeSettingsModal(overlay);
    await expect(shell.getByTestId('title-bar-stripe')).toHaveAttribute('data-tone', 'custom');
    await capture(app, shell, `title-bar-${name}`, () => shell.getByTestId('title-bar'));
  }
  await shutdownHostDaemon(app, hostId, fixture);
});
