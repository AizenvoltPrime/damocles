import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { writeUserSettings } from '../desktop/support/hermetic';
import { setReducedMotion, settled, showShellTheme, THEMES } from '../desktop/support/screenshots';
import { commitMessage, moreActions, setSection } from '../desktop/support/scm';
import { closeSettingsModal, openSettingsModal, settingsNav } from '../desktop/support/settings';
import { activeChat } from '../desktop/support/fixtures';
import { overlayPage, shellPage } from '../desktop/support/shell';
import { connectDialog, openConnect } from './support/connect-ui';
import { trustCa } from './support/credentials';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { clientCredentialHelper, newGitPassword, startHttpsGitServer } from './support/git-credentials';
import { gitConsent, removeServerDialog } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, test } from './support/remote';

// Review captures of Settings > Remote hosts, the safety stripe, the host card's actions and the git consent dialog in both
// themes, not tests: only the screenshots project matches them.
const SHOTS = process.env['DAMOCLES_REMOTE_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-remote-shots', 'slice9');
const APP = '/srv/app';
const USER = 'relay-user';

async function capture(app: ElectronApplication, page: Page, name: string, target: () => Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(page);
    await target().screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
  }
}

test('Remote hosts settings, safety stripe, host card actions and git consent', async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(900_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const server = await startHttpsGitServer(home, 'app', USER, newGitPassword());
  try {
    await trustCa(fixture, server.caPem);
    await fixture.sh([
      "git config --global user.name 'E2E Dev'",
      'git config --global user.email dev@prod-1.invalid',
      'git config --global credential.helper store',
      `git init -q -b main ${APP}`,
      `cd ${APP}`,
      "printf 'shots\\n' > README.md",
      'git add -A',
      'git commit -q -m init',
      `git remote add origin '${server.url('app.git')}'`,
      'git config branch.main.remote origin',
      'git config branch.main.merge refs/heads/main',
    ].join(' && '), 'dev');
    clientCredentialHelper(home, server.host, USER, 'unused');
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
    await openRemoteFolder(app, hostId, APP);
    const overlay = await overlayPage(app);
    // the remote chat is attached, so the modal opens on prod-1's tab; Remote hosts is this computer's, on the User tab
    await activeChat(app);
    await openSettingsModal(app);
    await overlay.getByTestId('settings-scope-user').click();
    await expect(overlay.getByTestId('settings-scope-user')).toHaveAttribute('data-state', 'active');
    await settingsNav(overlay, 'remoteHosts').click();
    await overlay.locator(`[data-testid="remote-host-pick"][data-host-id="${hostId}"]`).click();
    const block = overlay.locator(`[data-testid="remote-host"][data-host-id="${hostId}"]`);

    // Settings > Remote hosts, prod-1 recolored red
    await block.getByRole('radiogroup', { name: 'Color' }).getByRole('radio', { name: 'Red', exact: true }).click();
    await expect(block.locator('[data-tone="danger"]')).toHaveAttribute('aria-checked', 'true');
    const modal = (): Locator => overlay.getByTestId('settings-modal');
    await capture(app, overlay, 'remote-hosts', modal);
    // keyboard focus, so the ring shows as it does for a keyboard user
    await block.getByRole('textbox', { name: 'Name', exact: true }).focus();
    await overlay.keyboard.press('Tab');
    await expect(block.getByRole('radio', { name: 'Red', exact: true })).toBeFocused();
    await capture(app, overlay, 'remote-hosts-swatch-focus', () => block.getByTestId('settings-row-remote-host-color'));
    await setReducedMotion(app, true);
    await capture(app, overlay, 'remote-hosts-reduced-motion', modal);
    await setReducedMotion(app, false);

    // Remove Damocles server: what runs and the boxes Damocles may undo; cancelled
    await block.getByRole('button', { name: 'Remove Damocles server...', exact: true }).click();
    await expect(removeServerDialog(overlay)).toBeVisible();
    await capture(app, overlay, 'remove-server-dialog', () => removeServerDialog(overlay));
    await removeServerDialog(overlay).getByRole('button', { name: 'Cancel', exact: true }).click();

    // Set up passwordless login: three steps, each ending with a check
    await block.getByRole('button', { name: 'Set up passwordless login', exact: true }).click();
    await expect(overlay.getByTestId('passwordless-done')).toBeVisible({ timeout: 120_000 });
    await capture(app, overlay, 'passwordless-done', () => block.getByTestId('settings-row-remote-host-actions'));
    await closeSettingsModal(overlay);

    // the title bar stripe and the tinted badge on the project row
    const shell = await shellPage(app);
    await capture(app, shell, 'title-bar-stripe', () => shell.getByTestId('title-bar'));
    await capture(app, shell, 'projects-badge', () => shell.getByTestId('projects-list'));

    // the host card: Safety, the actions and Host settings
    await openConnect(app);
    await connectDialog(overlay).getByTestId('host-details').first().click();
    await expect(overlay.getByTestId('host-card')).toBeVisible();
    await capture(app, overlay, 'host-card', () => overlay.getByRole('dialog'));
    await overlay.keyboard.press('Escape');

    // git consent on a push, with the warning for the target's own credential helper; denied
    await setSection(shell, 'scm-section', true);
    await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });
    await moreActions(app, shell, 'push');
    // the server has no main yet, so push offers to publish the branch first
    await overlay.getByRole('alertdialog', { name: /has no remote branch/ }).getByTestId('overlay-message-action-0').click();
    await expect(gitConsent(overlay)).toBeVisible({ timeout: 60_000 });
    await expect(gitConsent(overlay).getByTestId('git-consent-helper-warning')).toBeVisible();
    await capture(app, overlay, 'git-consent', () => gitConsent(overlay));
    await gitConsent(overlay).getByRole('button', { name: 'Deny', exact: true }).click();

    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await server.close();
  }
});
