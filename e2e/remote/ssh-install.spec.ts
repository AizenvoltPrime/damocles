import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import type { ElectronApplication } from '@playwright/test';
import type { CoreState } from '../../src/desktop/daemon/control-messages';
import { launchDesktop } from '../desktop/support/app';
import { createHermeticHome } from '../desktop/support/hermetic';
import { answerDialogs } from '../desktop/support/ui';
import { expectNoAxeViolations } from '../desktop/support/axe';
import { failureAlert, folderBrowser, hostCard, openConnect, stepRow, timeline } from './support/connect-ui';
import { daemonPids, shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, control, expect, hostLogs, hostNamed, lastConnectStep, openRemoteFolder, remoteEnv, remoteProjectKey, setInstallFolder, SSH_TAG, test } from './support/remote';
import { ALPINE_TARGET, installedVersion, LINUX_TARGET, serverPackage } from './support/release-mirror';
import { startSshAgentStub } from './support/ssh-agent-stub';
import { sshClientHome, TARGET_HOME, type SshdFixture } from './support/sshd';

const DEFAULT_INSTALL = `${TARGET_HOME}/.damocles/server`;

// as ssh-keygen -l and sshd's log print a public key line's key
const sshFingerprint = (publicKey: string): string => `SHA256:${createHash('sha256').update(Buffer.from(publicKey.split(' ')[1]!, 'base64')).digest('base64').replace(/=+$/, '')}`;

/** The names in a folder on the target, sorted; [] when it does not exist. */
async function entries(fixture: SshdFixture, folder: string): Promise<string[]> {
  const quoted = `'${folder.replace(/'/g, "'\\''")}'`;
  const listed = await fixture.sh(`if [ -d ${quoted} ]; then ls -A ${quoted}; fi`, 'dev');
  return listed.split('\n').filter(Boolean).sort();
}

/** Whether the installed version's server binary is in `<install>`. */
async function installedIn(fixture: SshdFixture, install: string, target = LINUX_TARGET): Promise<boolean> {
  return (await entries(fixture, `${install}/${installedVersion(target)}/bin`)).includes('damocles-server');
}

/** Saves the fixture's alias as a host and opens /srv/app on it; resolves with the host id once the project is connected. */
async function connect(app: ElectronApplication, alias = 'prod-1'): Promise<string> {
  const hostId = await addHost(app, { alias, name: alias });
  const key = await openRemoteFolder(app, hostId, '/srv/app');
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, '/srv/app');
  expect(key.startsWith(`ssh+${hostId}|`)).toBe(true);
  return hostId;
}

test('with only ~/.ssh/config and an ssh-agent, connecting installs by the target\'s download, signed in by the agent alone', { tag: SSH_TAG }, async ({ home, launch, mirror, ssh, sshd }) => {
  const agent = await startSshAgentStub(home.root);
  try {
    const fixture = await sshd('prod-1', { agentOnly: true });
    await fixture.authorize(agent.publicKey);
    // the host's own block names no key file, and the fixtures' key file block leaves it out
    const config = fs.readFileSync(ssh.config, 'utf8');
    expect(/^Host prod-1\n([\s\S]*?)\n\n/m.exec(config)?.[1]?.match(/IdentityFile .*/g)).toEqual(['IdentityFile none']);
    expect(config).toMatch(/^Host \* !prod-1$/m);
    const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), SSH_AUTH_SOCK: agent.socket } });
    const hostId = await connect(app);
    expect(mirror.downloads).toEqual([serverPackage(LINUX_TARGET)]);
    expect(await installedIn(fixture, DEFAULT_INSTALL)).toBe(true);
    expect(agent.signatures).toBeGreaterThan(0);
    const signIns = await fixture.authentications();
    expect(signIns.length).toBeGreaterThan(0);
    expect(new Set(signIns)).toEqual(new Set([`Accepted publickey dev ${sshFingerprint(agent.publicKey)}`]));
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await agent.close();
  }
});

test('with downloads blocked, the app uploads the package from its own copy and the host installs and connects', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  mirror.mode = 'block';
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await connect(app);
  // the target tried the download first, with its retries, and got the package by upload
  expect(mirror.downloads.length).toBeGreaterThan(0);
  expect([...new Set(mirror.downloads)]).toEqual([serverPackage(LINUX_TARGET)]);
  expect(await installedIn(fixture, DEFAULT_INSTALL)).toBe(true);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('a tampered package fails at Installing, where the hash check runs, and nothing is installed', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  mirror.mode = 'tamper';
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const overlay = await openConnect(app);
  await hostCard(overlay, 'prod-1').click();
  await expect(stepRow(overlay, 'installing')).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
  await expect(failureAlert(overlay)).toBeVisible();
  for (const step of ['connecting', 'checking'] as const) await expect(stepRow(overlay, step)).toHaveAttribute('data-state', 'done');
  // a failed attempt drops the steps it never reached
  await expect(stepRow(overlay, 'starting')).toHaveCount(0);
  const host = await hostNamed(app, 'prod-1');
  expect((await lastConnectStep(app, host.hostId))?.failure?.code).toBe('hashMismatch');
  // no version folder and no staging folder: the download was refused before anything was unpacked
  expect((await entries(fixture, DEFAULT_INSTALL)).filter((name) => name === installedVersion(LINUX_TARGET) || name.startsWith('.staging-'))).toEqual([]);
  // nothing of Damocles runs: the failed attempt left no daemon, bridge or shell
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
});

test('two clients connecting at the same time install once and share one daemon', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  const otherHome = createHermeticHome();
  try {
    const otherSsh = await sshClientHome(otherHome);
    await fixture.authorize(otherSsh.publicKey);
    otherSsh.addHost('prod-1', fixture);
    await otherSsh.trust(fixture);
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const other = await launchDesktop(otherHome, { env: remoteEnv(otherSsh, mirror) });
    try {
      const [hostId, otherHostId] = await Promise.all([connect(app), connect(other.app)]);
      expect(mirror.downloads).toEqual([serverPackage(LINUX_TARGET)]);
      // both clients reach one daemon, and the start that lost the race for its lock exited once that daemon answered
      const served = await Promise.all([control(app, hostId, 'coreState'), control(other.app, otherHostId, 'coreState')]) as CoreState[];
      expect(served[0]!.ppid).not.toBeNull();
      expect(served[1]!.ppid).toBe(served[0]!.ppid);
      await expect.poll(() => daemonPids(fixture), { timeout: 30_000 }).toEqual([served[0]!.ppid]);
      // the daemon logs one attach per client, and the two clients' ids differ
      const { daemon } = await hostLogs(app, hostId);
      const clients = new Set([...daemon.matchAll(/: client (\S+) \(.*\) attached/g)].map((match) => match[1]));
      expect(clients.size).toBe(2);
      // the other client leaves first: a daemon a client did not stop is an outage to it, which it reconnects through
      await other.close();
      await shutdownHostDaemon(app, hostId, fixture);
    } finally {
      await other.close();
    }
  } finally {
    await otherHome.dispose();
  }
});

test('a stale install.lock from a dead pid is taken over, and a .staging folder older than a day is removed', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  await fixture.sh([
    `mkdir -p ${DEFAULT_INSTALL}/install.lock ${DEFAULT_INSTALL}/.staging-old0e2e00 ${DEFAULT_INSTALL}/.staging-new0e2e00`,
    // a pid that is not running on this host, as after a crash mid-install
    `echo "$(uname -n) 4000000" > ${DEFAULT_INSTALL}/install.lock/owner`,
    `touch -d '2 days ago' ${DEFAULT_INSTALL}/.staging-old0e2e00`,
  ].join(' && '), 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await connect(app);
  const left = await entries(fixture, DEFAULT_INSTALL);
  expect(left).toContain(installedVersion(LINUX_TARGET));
  expect(left).not.toContain('install.lock');
  expect(left).not.toContain('.staging-old0e2e00');
  // a younger staging folder may belong to an install in progress elsewhere
  expect(left).toContain('.staging-new0e2e00');
  await shutdownHostDaemon(app, hostId, fixture);
});

test('on CentOS 7 the probe stops with the glibc message and installs nothing', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1', { image: 'centos7' });
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const overlay = await openConnect(app);
  await hostCard(overlay, 'prod-1').click();
  await expect(stepRow(overlay, 'checking')).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
  await expect(failureAlert(overlay)).toHaveText('prod-1 runs glibc 2.17. Damocles needs 2.28 or newer.');
  await expect(stepRow(overlay, 'installing')).toHaveCount(0);
  // the failed timeline, with its message, passes the axe scan too
  await expect(timeline(overlay, 'prod-1')).toBeVisible();
  await expectNoAxeViolations(overlay, '[role="dialog"]');
  expect(mirror.downloads).toEqual([]);
  expect((await entries(fixture, DEFAULT_INSTALL)).filter((name) => !name.startsWith('run-'))).toEqual([]);
  await expect.poll(() => fixture.userProcesses(), { timeout: 30_000 }).toEqual([]);
});

test('with the home mounted noexec the probe stops and offers Choose install folder; /opt/damocles then installs and connects', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1', { noexecHome: true });
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await answerDialogs(app, { 'on prod-1?': 'Trust Folder' });
  const overlay = await openConnect(app);
  await hostCard(overlay, 'prod-1').click();
  await expect(stepRow(overlay, 'checking')).toHaveAttribute('data-state', 'failed', { timeout: 120_000 });
  await expect(failureAlert(overlay)).toContainText(DEFAULT_INSTALL);
  const host = await hostNamed(app, 'prod-1');
  expect((await lastConnectStep(app, host.hostId))?.failure?.code).toBe('noexec');
  await overlay.getByRole('button', { name: 'Choose install folder' }).click();
  await overlay.getByRole('textbox', { name: 'Install folder' }).fill('/opt/damocles');
  // a saved folder retries the attempt
  await overlay.getByRole('button', { name: 'Save' }).click();
  await expect(folderBrowser(overlay, 'prod-1')).toBeVisible({ timeout: 120_000 });
  // <folder>/<user>, so accounts sharing the folder never prune each other's versions
  expect(await installedIn(fixture, '/opt/damocles/dev')).toBe(true);
  await shutdownHostDaemon(app, host.hostId, fixture);
});

test('a host moved to /opt/damocles installs there, and that install removes the versions left in the old folder', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await connect(app);
  expect(await installedIn(fixture, DEFAULT_INSTALL)).toBe(true);
  await shutdownHostDaemon(app, hostId, fixture);
  expect(await setInstallFolder(app, hostId, '/opt/damocles')).toEqual({ ok: true });
  await openRemoteFolder(app, hostId, '/srv/app');
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, '/srv/app');
  expect(await installedIn(fixture, '/opt/damocles/dev')).toBe(true);
  // the old <install> keeps only the run folder, which holds no program; the configured folder itself stays
  expect((await entries(fixture, DEFAULT_INSTALL)).filter((name) => !name.startsWith('run-'))).toEqual([]);
  expect(await entries(fixture, '/opt/damocles')).toEqual(['dev']);
  await shutdownHostDaemon(app, hostId, fixture);
});

test("an install folder holding a space, ' and $ installs correctly, and one holding a newline is refused before anything runs", { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  expect(await setInstallFolder(app, hostId, '/opt/damocles/a\nb')).toEqual({ ok: false, reason: 'invalid' });
  expect(await entries(fixture, '/opt/damocles')).toEqual([]);
  // no session was opened for the refused folder
  expect(await fixture.userProcesses()).toEqual([]);
  const folder = "/opt/damocles/it's a $HOME dir";
  expect(await setInstallFolder(app, hostId, folder)).toEqual({ ok: true });
  await openRemoteFolder(app, hostId, '/srv/app');
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, '/srv/app');
  expect(await installedIn(fixture, `${folder}/dev`)).toBe(true);
  expect(await entries(fixture, '/opt/damocles')).toEqual([folder.slice('/opt/damocles/'.length)]);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('an Alpine target gets the musl package', { tag: SSH_TAG }, async ({ launch, mirror, ssh, sshd }) => {
  const fixture = await sshd('prod-1', { image: 'alpine' });
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await connect(app);
  expect(mirror.downloads).toEqual([serverPackage(ALPINE_TARGET)]);
  expect(await installedIn(fixture, DEFAULT_INSTALL, ALPINE_TARGET)).toBe(true);
  await shutdownHostDaemon(app, hostId, fixture);
});
