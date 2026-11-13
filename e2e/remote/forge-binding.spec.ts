import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { createTestPki } from '../desktop/support/certs';
import { startForgeStub, type ForgeStub } from '../desktop/support/forge-stub';
import { readyOverlay } from '../desktop/support/overlay';
import { clickAccountChip, commitMessage, scmSection, setSection } from '../desktop/support/scm';
import { closeSettingsModal, openSettingsModal } from '../desktop/support/settings';
import { shellPage } from '../desktop/support/shell';
import { clickMenu } from '../desktop/support/ui';
import { connectDialog, openConnect } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { openRemoteHostSettings, storedHost } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';

// GitHub and GitLab accounts on an SSH target: the target resolves its own ssh alias for the remote, the host's
// default account applies to its projects, the ask-once dialog names the host, and Forget host drops what this computer
// kept for it. The forge stub serves gitlab.com; no request leaves the machine.

const APP = '/srv/app';
const GITLAB = 'gitlab.com';

async function tokenSignIn(overlay: Page, token: string, login: string): Promise<void> {
  await overlay.getByRole('button', { name: `Add account: ${GITLAB}`, exact: true }).click();
  await overlay.getByRole('radio', { name: 'Token', exact: true }).click();
  await overlay.getByLabel('Personal access token', { exact: true }).fill(token);
  await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(overlay.getByText(`Signed in as ${login}`, { exact: true })).toBeVisible();
}

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

test('an SSH project resolves its ssh alias on the target and uses prod-1\'s default account; with no default the push asks once naming prod-1; Forget host drops the bindings and the default', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  // gl-work is an alias only the target's ssh config knows: git@gl-work:alexios-s/damocles.git is gitlab.com's alexios-s/damocles
  await fixture.sh([
    'mkdir -p ~/.ssh && chmod 700 ~/.ssh',
    "printf 'Host gl-work\\n  HostName gitlab.com\\n  User git\\n' > ~/.ssh/config && chmod 600 ~/.ssh/config",
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    'echo one > a.txt && git add -A && git commit -q -m init',
    'git remote add origin git@gl-work:alexios-s/damocles.git',
    'git update-ref refs/remotes/origin/main HEAD',
    'git branch --set-upstream-to origin/main main',
    'echo two >> a.txt && git commit -q -am ahead',
  ].join(' && '), 'dev');

  const pki = createTestPki(['localhost']);
  const caFile = path.join(home.root, 'forge-test-ca.pem');
  fs.writeFileSync(caFile, pki.caCertPem);
  const stub = await startForgeStub({ cert: pki.leafCertPem, key: pki.leafKeyPem, ca: pki.caCertPem });
  stubs.push(stub);
  const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_FORGE_SERVERS: stub.e2eServersEnv(), NODE_EXTRA_CA_CERTS: caFile } });

  let overlay = await openSettingsModal(app, 'accounts');
  await expect(overlay.getByTestId('forge-loading')).toHaveCount(0);
  await tokenSignIn(overlay, 'glpat-stubAlexiosSApi000000008', 'alexios-s');
  await tokenSignIn(overlay, 'glpat-stubWorkAlexiosApi000001', 'work-alexios');
  await closeSettingsModal(overlay);

  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  // prod-1's default account on gitlab.com, set before the project opens
  ({ overlay } = await openRemoteHostSettings(app, hostId));
  await expect(overlay.getByTestId('forge-defaults')).toHaveAttribute('data-state', 'ready', { timeout: 30_000 });
  await overlay.getByLabel(`Default account on ${GITLAB}`, { exact: true }).click();
  await overlay.getByRole('option', { name: 'work-alexios', exact: true }).click();
  await expect(overlay.getByLabel(`Default account on ${GITLAB}`, { exact: true })).toHaveText('work-alexios');
  await closeSettingsModal(overlay);

  await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });
  const chip = scmSection(shell).getByTestId('forge-account-chip');
  // the alias resolved on the target: gl-work is gitlab.com, whose host default is work-alexios
  await expect(chip).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen by you`, { timeout: 60_000 });

  // No default: both accounts can push to alexios-s/damocles, so the push asks once, naming prod-1 in its where-line
  ({ overlay } = await openRemoteHostSettings(app, hostId));
  await overlay.getByLabel(`Default account on ${GITLAB}`, { exact: true }).click();
  await overlay.getByRole('option', { name: 'No default', exact: true }).click();
  await closeSettingsModal(overlay);
  await expect(chip).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`, { timeout: 30_000 });
  overlay = await readyOverlay(app);
  await clickMenu(app, 'damocles.git.push');
  const ask = overlay.getByRole('alertdialog', { name: `Which ${GITLAB} account should app use?`, exact: true });
  await expect(ask).toBeVisible({ timeout: 60_000 });
  await expect(ask.getByTestId('forge-ask-host')).toHaveText('prod-1');
  await expect(ask.getByTestId('forge-ask-where')).toContainText(`${GITLAB}/alexios-s/damocles`);
  // cancelled, so no push tries to reach gitlab.com from the target; the chip's menu binds the project instead
  await ask.getByRole('listbox', { name: `Account for ${GITLAB}`, exact: true }).press('Escape');
  await expect(ask).toHaveCount(0);
  await clickAccountChip(chip);
  await overlay.getByRole('menu', { name: 'Accounts for app', exact: true }).getByRole('menuitemradio', { name: /^work-alexios/ }).click();
  await expect(chip).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen by you`, { timeout: 30_000 });

  // a host default again, then Forget host: the bindings and the default of ssh+<hostId> go
  ({ overlay } = await openRemoteHostSettings(app, hostId));
  await overlay.getByLabel(`Default account on ${GITLAB}`, { exact: true }).click();
  await overlay.getByRole('option', { name: 'alexios-s', exact: true }).click();
  await closeSettingsModal(overlay);
  const bindingsFile = path.join(home.userData, 'forge', 'bindings.json');
  await expect.poll(() => fs.readFileSync(bindingsFile, 'utf8')).toContain(`ssh+${hostId}`);
  await shutdownHostDaemon(app, hostId, fixture);
  const connect = await openConnect(app);
  await connectDialog(connect).getByRole('button', { name: 'Details for prod-1' }).click();
  await connect.getByTestId('host-card').getByRole('button', { name: 'Forget host', exact: true }).click();
  await connect.getByRole('alertdialog', { name: 'Forget prod-1?' }).getByRole('button', { name: 'Forget host', exact: true }).click();
  await expect.poll(() => storedHost(home, hostId)).toBeUndefined();
  await expect.poll(() => fs.readFileSync(bindingsFile, 'utf8')).not.toContain(`ssh+${hostId}`);
});
