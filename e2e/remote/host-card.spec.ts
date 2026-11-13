import { overlayPage, shellPage } from '../desktop/support/shell';
import { titleBar } from '../desktop/support/shell-ui';
import { settledBox } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, SSH_TAG, test } from './support/remote';

const APP = '/srv/app';
// long enough to truncate in the card's heading
const NAME = 'WORKSTATION42_BUILDAGENT_LONGNAME_EXAMPLE';
// placement.ts PANEL_GAP_REM at 16 px per rem
const PANEL_GAP_PX = 6;

test('the title-bar chip hangs a long-named host\'s card under it, with Rename and Close both clickable', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(300_000);
  const fixture = await sshd('prod-1');
  await fixture.sh(`mkdir -p ${APP}`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: NAME });
  const key = await openRemoteFolder(app, hostId, APP);
  const shell = await shellPage(app);
  await shell.evaluate((projectKey) => window.damoclesShell!.selectProject(projectKey), key);

  // the shell and the overlay share one CSS-pixel space, so the card's top-left sits under the chip's bottom-left
  const chip = titleBar(shell).getByTestId('title-bar-host');
  await chip.click();
  const overlay = await overlayPage(app);
  const popover = overlay.locator('[data-testid="connect-dialog"][data-popover]');
  const card = popover.getByTestId('host-card');
  await expect(card.getByTestId('host-card-name')).toHaveText(NAME);
  const chipBox = await settledBox(chip);
  const popoverBox = await settledBox(popover);
  expect(Math.abs(popoverBox.x - chipBox.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(popoverBox.y - (chipBox.y + chipBox.height + PANEL_GAP_PX))).toBeLessThanOrEqual(1);

  // the name truncates before Rename and Close, so neither lies under anything
  const rename = card.getByRole('button', { name: `Rename ${NAME}`, exact: true });
  await rename.click();
  await expect(card.getByRole('textbox')).toBeFocused();
  await overlay.keyboard.press('Escape');
  await expect(rename).toBeVisible();
  await card.getByTestId('host-card-close').click();
  await expect(overlay.getByTestId('connect-dialog')).toHaveCount(0);
  await expect(chip).toHaveAttribute('aria-expanded', 'false');

  await shutdownHostDaemon(app, hostId, fixture);
});
