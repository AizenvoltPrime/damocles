import * as fs from 'node:fs';
import { shellState } from '../desktop/support/shell';
import { answerDialogs } from '../desktop/support/ui';
import { expectNoAxeViolations } from '../desktop/support/axe';
import { changedKey, connectDialog, firstConnection, folderBrowser, hostCard, openConnect, openInBrowser } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, hostNamed, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { knownHostsName } from './support/sshd';

test('an unknown host key prompts with its fingerprint; Cancel connects nowhere, Connect lets ssh record it, and nothing else under ~/.ssh changes', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1', { trusted: false });
  const before = ssh.mtimes();
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });

  const overlay = await openConnect(app);
  await hostCard(overlay, 'prod-1').click();
  const prompt = firstConnection(overlay, 'prod-1');
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await expect(prompt.getByTestId('host-key-fingerprint')).toHaveText(`ED25519 ${await fixture.fingerprint()}`);
  await expectNoAxeViolations(overlay, '[role="alertdialog"]');
  await prompt.getByRole('button', { name: 'Cancel' }).click();
  await expect(prompt).toHaveCount(0);
  // ssh's own prompt was answered no: it recorded nothing and the attempt ended without a session
  expect(fs.readFileSync(ssh.knownHosts, 'utf8')).toBe('');
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
  expect((await shellState(app)).projects.filter((project) => project.authority.kind === 'ssh')).toEqual([]);

  if (!(await connectDialog(overlay).isVisible())) await openConnect(app);
  await hostCard(overlay, 'prod-1').click();
  await expect(prompt).toBeVisible({ timeout: 60_000 });
  await prompt.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(folderBrowser(overlay, 'prod-1')).toBeVisible({ timeout: 120_000 });
  await openInBrowser(overlay, 'prod-1', '/srv/app');
  const host = await hostNamed(app, 'prod-1');
  await remoteProjectKey(app, host, '/srv/app');
  // ssh wrote the key it was shown, under the name it connects by
  expect(fs.readFileSync(ssh.knownHosts, 'utf8')).toContain(`${knownHostsName(fixture.port)} ${await fixture.hostKey()}`);
  const after = ssh.mtimes();
  expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  expect(Object.keys(after).filter((name) => after[name] !== before[name])).toEqual(['known_hosts']);
  await shutdownHostDaemon(app, host.hostId, fixture);
});

test('a changed host key shows the security alert with the ssh-keygen -R command, connects nowhere and changes nothing under ~/.ssh', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  await fixture.rotateHostKey();
  const before = ssh.mtimes();
  const knownBefore = fs.readFileSync(ssh.knownHosts, 'utf8');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const overlay = await openConnect(app);
  await hostCard(overlay, 'prod-1').click();
  const alert = changedKey(overlay, 'prod-1');
  await expect(alert).toBeVisible({ timeout: 60_000 });
  // quoted, so no shell reads the brackets of the known_hosts name as a glob
  await expect(alert.getByTestId('host-key-command')).toHaveText(`ssh-keygen -R "${knownHostsName(fixture.port)}"`);
  await expect(alert.getByRole('button', { name: 'Copy command' })).toBeVisible();
  await expect(alert.getByRole('button', { name: /^(Retry|Connect)$/ })).toHaveCount(0);
  await expectNoAxeViolations(overlay, '[role="alertdialog"]');
  await alert.getByRole('button', { name: 'Close' }).click();
  await expect(alert).toHaveCount(0);
  // no session, no retry, no project, and ssh's files exactly as they were
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
  expect((await shellState(app)).projects.filter((project) => project.authority.kind === 'ssh')).toEqual([]);
  expect(fs.readFileSync(ssh.knownHosts, 'utf8')).toBe(knownBefore);
  expect(ssh.mtimes()).toEqual(before);
});
