import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { run } from '../desktop/support/app';
import type { HermeticHome } from '../desktop/support/hermetic';
import { closeSettingsModal } from '../desktop/support/settings';
import { answerDialogs } from '../desktop/support/ui';
import { hostCard, openConnect, openInBrowser } from './support/connect-ui';
import { modeAndOwner, newPassword, userAuthorizedKeys, usePasswords } from './support/credentials';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { connectAnswering, openRemoteHostSettings, sshFingerprint, storedHost } from './support/host-settings-ui';
import { addHost, control, expect, hostNamed, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test, WINDOWS_SSH_ENV, WINDOWS_TARGET_TAG } from './support/remote';
import { TARGET_HOME } from './support/sshd';

const APP = '/srv/app';
const STEPS = ['generate', 'install', 'verify'] as const;

test('against a password-only sshd, Set up passwordless login generates the key under ~/.damocles/ssh, installs it once with ssh-copy-id modes, verifies it, and reconnecting asks nothing', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1', { config: ['PreferredAuthentications publickey,password'] });
  const password = newPassword();
  await usePasswords(fixture, { dev: password });
  const clientSsh = ssh.mtimes();
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });

  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const host = await hostNamed(app, 'prod-1');

  // The first connection asks the password: the fixture authorizes no key.
  const connect = await openConnect(app);
  const asked = await connectAnswering(app, connect, hostId, () => hostCard(connect, 'prod-1').click(), { "dev@127.0.0.1's password:": { answer: password } });
  expect(new Set(asked)).toEqual(new Set(["dev@127.0.0.1's password:"]));
  await openInBrowser(connect, 'prod-1', APP);
  await remoteProjectKey(app, host, APP);
  expect(await fixture.authentications()).toContain('Accepted password dev');

  const { overlay, block } = await openRemoteHostSettings(app, host.hostId);
  await block.getByRole('button', { name: 'Set up passwordless login', exact: true }).click();
  for (const step of STEPS) await expect(block.locator(`[data-testid="passwordless-step"][data-step="${step}"]`)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  // offered only while the host has no passwordless login
  await expect(block.getByRole('button', { name: 'Set up passwordless login', exact: true })).toHaveCount(0);
  await closeSettingsModal(overlay);

  // The key lives under this computer's ~/.damocles/ssh, never ~/.ssh, and the host store names it and its fingerprint.
  const identityFile = path.join(home.damoclesDir, 'ssh', 'id_ed25519');
  const publicKey = fs.readFileSync(`${identityFile}.pub`, 'utf8').trim();
  expect(publicKey).toMatch(/^ssh-ed25519 \S+ damocles@\S+$/);
  expect(storedHost(home, host.hostId)).toMatchObject({ identityFile, installedKeyFingerprint: sshFingerprint(publicKey) });
  expect(ssh.mtimes()).toEqual(clientSsh);

  // On the target: the key appended once, ~/.ssh 0700 and authorized_keys 0600, both the user's.
  expect((await userAuthorizedKeys(fixture)).filter((line) => line.trim() === publicKey)).toHaveLength(1);
  expect(await modeAndOwner(fixture, `${TARGET_HOME}/.ssh`)).toBe('700 dev');
  expect(await modeAndOwner(fixture, `${TARGET_HOME}/.ssh/authorized_keys`)).toBe('600 dev');
  // the verify step signed in with the key alone
  expect(await fixture.authentications()).toContain(`Accepted publickey dev ${sshFingerprint(publicKey)}`);

  // A new connection after the daemon ended signs in with the key and asks nothing.
  await shutdownHostDaemon(app, host.hostId, fixture);
  const before = (await fixture.authentications()).length;
  await openRemoteFolder(app, host.hostId, APP);
  expect((await fixture.authentications()).slice(before)).toEqual([`Accepted publickey dev ${sshFingerprint(publicKey)}`]);
  await shutdownHostDaemon(app, host.hostId, fixture);
});

// The nightly workflow's sshd on the runner, whose account is an administrator; the runner and its ProgramData are discarded.
const TARGET = { identity: process.env['DAMOCLES_E2E_TARGET_IDENTITY'], knownHosts: process.env['DAMOCLES_E2E_TARGET_KNOWN_HOSTS'], user: process.env['DAMOCLES_E2E_TARGET_USER'] };
const POWERSHELL = path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// SIDs, as the grants name them: the group names are localized
const ACL_SCRIPT = "$a = Get-Acl -LiteralPath (Join-Path $env:ProgramData 'ssh\\administrators_authorized_keys'); 'protected=' + $a.AreAccessRulesProtected; $a.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value + ' ' + $_.FileSystemRights + ' ' + $_.AccessControlType }";

/** A temp ~/.ssh naming the runner's sshd as prod-1 with the workflow's key, and the launch environment that reads it. */
function targetEnv(home: HermeticHome): Record<string, string> {
  const { identity, knownHosts, user } = TARGET;
  if (!identity || !knownHosts || !user) throw new Error('DAMOCLES_E2E_TARGET_IDENTITY, _KNOWN_HOSTS and _USER are unset; the target suites run in remote-e2e-nightly.yml');
  const dir = path.join(home.home, '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'id_ed25519');
  fs.copyFileSync(identity, key);
  fs.copyFileSync(knownHosts, path.join(dir, 'known_hosts'));
  const posix = (file: string): string => file.split(path.sep).join('/');
  const config = path.join(dir, 'config');
  const lines = ['Host prod-1', '  HostName 127.0.0.1', '  Port 22', `  User ${user}`, `  IdentityFile "${posix(key)}"`, '  IdentitiesOnly yes', '  IdentityAgent none', `  UserKnownHostsFile "${posix(path.join(dir, 'known_hosts'))}"`, ''];
  fs.writeFileSync(config, lines.join('\n'));
  // a release URL nothing serves: the app uploads the package it built
  return { ...WINDOWS_SSH_ENV, DAMOCLES_E2E_HOOKS: '1', DAMOCLES_REMOTE: '1', DAMOCLES_E2E_SSH_CONFIG: config, DAMOCLES_E2E_RELEASE_URL: 'http://127.0.0.1:1' };
}

test('on a Windows admin target, Set up passwordless login appends the key to administrators_authorized_keys, readable by Administrators and SYSTEM alone', { tag: WINDOWS_TARGET_TAG }, async ({ home, launch }) => {
  test.setTimeout(600_000);
  const folder = path.join(home.root, 'target-project');
  fs.mkdirSync(folder, { recursive: true });
  const { app } = await launch({ env: targetEnv(home) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(app, hostId, folder);
  const { overlay, block } = await openRemoteHostSettings(app, hostId);
  await block.getByRole('button', { name: 'Set up passwordless login', exact: true }).click();
  for (const step of STEPS) await expect(block.locator(`[data-testid="passwordless-step"][data-step="${step}"]`)).toHaveAttribute('data-state', 'done', { timeout: 60_000 });
  await closeSettingsModal(overlay);
  const publicKey = fs.readFileSync(path.join(home.damoclesDir, 'ssh', 'id_ed25519.pub'), 'utf8').trim();
  const authorized = fs.readFileSync(path.join(process.env['ProgramData']!, 'ssh', 'administrators_authorized_keys'), 'utf8').split(/\r?\n/);
  expect(authorized.filter((line) => line.trim() === publicKey)).toHaveLength(1);
  // sshd ignores an administrator's own authorized_keys, so nothing was written there
  const own = path.join(os.homedir(), '.ssh', 'authorized_keys');
  expect(fs.existsSync(own) ? fs.readFileSync(own, 'utf8') : '').not.toContain(publicKey);
  const acl = await run(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', ACL_SCRIPT], 60_000);
  expect(acl.code).toBe(0);
  expect(acl.stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual(['S-1-5-18 FullControl Allow', 'S-1-5-32-544 FullControl Allow', 'protected=True']);
  expect(storedHost(home, hostId)).toMatchObject({ installedKeyFingerprint: sshFingerprint(publicKey) });
  await control(app, hostId, 'shutdownNow');
});
