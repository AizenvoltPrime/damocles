import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { createTestPki } from '../desktop/support/certs';
import { codeEditor, editorShows, openInEditor } from '../desktop/support/editor';
import { startForgeStub, type ForgeStub } from '../desktop/support/forge-stub';
import { commitMessage, setSection } from '../desktop/support/scm';
import { closeSettingsModal, openSettingsModal } from '../desktop/support/settings';
import { recordedToasts, recordToasts, shellPage } from '../desktop/support/shell';
import { clickMenu } from '../desktop/support/ui';
import { openedExternally, recordOpenExternal } from '../desktop/support/updates';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { shutdownHostDaemon } from './support/daemon-teardown';

// GitHub and GitLab accounts on an SSH target: Open File on Server and Open Commit on Server for a remote project.
// The target resolves its ssh alias and checks whether the commit is published (scm.commitOnRemote) on its own core; this
// computer's core builds the link on the forge stub's gitlab.com. No request leaves the machine.

const APP = '/srv/app';
const GITLAB = 'gitlab.com';

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

/** The newest toast once it says `message`. */
async function toastSaying(app: ElectronApplication, message: string): Promise<{ readonly severity: string; readonly actions: readonly string[] }> {
  let found: Awaited<ReturnType<typeof recordedToasts>>[number] | undefined;
  await expect.poll(async () => (found = (await recordedToasts(app)).reverse().find((toast) => toast.message === message))?.message, { timeout: 60_000 }).toBe(message);
  return found!;
}

test('a remote project\'s file and commit open on the server at the target\'s HEAD, and a commit only the target has warns and offers Push', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
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
    'printf "one\\ntwo\\nthree\\n" > a.txt && git add -A && git commit -q -m init',
    'git remote add origin git@gl-work:alexios-s/damocles.git',
    'git update-ref refs/remotes/origin/main HEAD',
    'git branch --set-upstream-to origin/main main',
  ].join(' && '), 'dev');
  const published = (await fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();

  const pki = createTestPki(['localhost']);
  const caFile = path.join(home.root, 'forge-test-ca.pem');
  fs.writeFileSync(caFile, pki.caCertPem);
  const stub = await startForgeStub({ cert: pki.leafCertPem, key: pki.leafKeyPem, ca: pki.caCertPem });
  stubs.push(stub);
  const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_FORGE_SERVERS: stub.e2eServersEnv(), NODE_EXTRA_CA_CERTS: caFile } });
  await recordOpenExternal(app);
  await recordToasts(app);

  const overlay = await openSettingsModal(app, 'accounts');
  await expect(overlay.getByTestId('forge-loading')).toHaveCount(0);
  await overlay.getByRole('button', { name: `Add account: ${GITLAB}`, exact: true }).click();
  await overlay.getByRole('radio', { name: 'Token', exact: true }).click();
  await overlay.getByLabel('Personal access token', { exact: true }).fill('glpat-stubAlexiosSApi000000008');
  await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(overlay.getByText('Signed in as alexios-s', { exact: true })).toBeVisible();
  await closeSettingsModal(overlay);

  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, APP);
  const projectKey = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });

  // Open File on Server at the caret's line 2 of the published HEAD
  expect((await openInEditor(app, { projectKey, relativePath: 'a.txt' })).ok).toBe(true);
  await editorShows(shell, 'two');
  await codeEditor(shell).locator('.view-line', { hasText: 'two' }).click();
  await clickMenu(app, 'damocles.git.openFileOnServer');
  await expect.poll(() => openedExternally(app), { timeout: 60_000 }).toEqual([`${stub.gitlab.webUrl}/alexios-s/damocles/-/blob/${published}/a.txt#L2`]);
  await toastSaying(app, `Opened a.txt on ${GITLAB} in your browser.`);

  // a commit only the target has: the target's own check finds it on no remote-tracking branch
  await fixture.sh(`cd ${APP} && echo four >> a.txt && git commit -q -am ahead`, 'dev');
  const ahead = (await fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();
  await clickMenu(app, 'damocles.git.openCommitOnServer');
  const warning = await toastSaying(app, `Commit ${ahead.slice(0, 7)} is not on ${GITLAB} yet, so its page would not open. Push it first.`);
  expect(warning.severity).toBe('warning');
  expect(warning.actions).toEqual(['Push']);
  expect(await openedExternally(app)).toHaveLength(1);
  await shutdownHostDaemon(app, hostId, fixture);
});
