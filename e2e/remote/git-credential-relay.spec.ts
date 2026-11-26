import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import type { DesktopApp } from '../desktop/support/app';
import { writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { answerToast, overlayPage, recordedToasts, recordToasts, shellPage } from '../desktop/support/shell';
import { openTerminal, runInTerminal } from '../desktop/support/terminal';
import { gitCalls, recordGitCalls, trustCa } from './support/credentials';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { clientCredentialHelper, newGitPassword, scmPush, startHttpsGitServer, type HttpsGitServer } from './support/git-credentials';
import { gitConsent, storedHost } from './support/host-settings-ui';
import { CURRENT_PACKAGE, daemonVersions, installOlderServer, OLD, switchToThisVersion } from './support/older-server';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test, type RemoteFixtures } from './support/remote';
import { runProgram, type SshdFixture } from './support/sshd';

const APP = '/srv/app';
const USER = 'relay-user';
const NOT_CONNECTED = 'Damocles is not connected. Git credentials from your computer are unavailable.';
const REMOVE_LOCAL = 'Remove the saved credential on this computer';

/** /srv/app on the target: one commit on main, whose upstream is main on the HTTPS server. */
async function targetRepo(fixture: SshdFixture, server: HttpsGitServer): Promise<string> {
  await fixture.sh([
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    "printf 'relay\\n' > README.md",
    'git add -A',
    'git commit -q -m init',
    `git remote add origin '${server.url('app.git')}'`,
    'git config branch.main.remote origin',
    'git config branch.main.merge refs/heads/main',
  ].join(' && '), 'dev');
  return (await fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();
}

/** The commit `ref` names in the server's bare repository, or undefined while it does not exist. */
async function serverRef(home: Pick<HermeticHome, 'root'>, ref: string): Promise<string | undefined> {
  const result = await runProgram('git', ['--git-dir', path.join(home.root, 'git-server', 'app.git'), 'rev-parse', '--verify', '--quiet', ref]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/**
 * Runs `script` in the active terminal's shell, so with that terminal's environment: the script lands in /tmp/<marker>.sh
 * through docker exec and the terminal is typed only `sh` and its path. It writes its exit code to /tmp/<marker>.code,
 * which this waits for and returns.
 */
async function inTerminal(app: ElectronApplication, fixture: SshdFixture, script: string, marker: string): Promise<string> {
  await fixture.sh(`cat > /tmp/${marker}.sh`, 'dev', `${script}\necho $? > /tmp/${marker}.code\n`);
  await runInTerminal(await shellPage(app), `sh /tmp/${marker}.sh`);
  let code = '';
  await expect.poll(async () => (code = (await fixture.sh(`cat /tmp/${marker}.code 2>/dev/null || true`)).trim()), { timeout: 60_000 }).not.toBe('');
  return code;
}

async function connect(app: ElectronApplication): Promise<{ hostId: string; key: string }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  return { hostId, key };
}

test('an HTTPS push from prod-1 uses this computer\'s credential after consent; status carries no relay and push does; approve and reject on the target never reach this computer; a terminal\'s nonce is refused for a prompt', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const password = newGitPassword();
  const server = await startHttpsGitServer(home, 'app', USER, password);
  try {
    await trustCa(fixture, server.caPem);
    await recordGitCalls(fixture);
    const head = await targetRepo(fixture, server);
    const helper = clientCredentialHelper(home, server.host, USER, password);
    const stored = helper.stored();
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    await recordToasts(app);
    const { hostId } = await connect(app);

    // Push: consent first, naming both hosts, with no target-helper warning on a target without its own helper.
    await scmPush(app, true);
    const overlay = await overlayPage(app);
    const consent = gitConsent(overlay);
    await expect(consent).toBeVisible({ timeout: 60_000 });
    await expect(consent).toHaveAccessibleName(`prod-1 wants to use your saved credentials for ${server.host}`);
    await expect(consent.getByTestId('git-consent-helper-warning')).toHaveCount(0);
    await consent.getByRole('button', { name: 'Always for prod-1', exact: true }).click();
    await expect.poll(() => serverRef(home, 'refs/heads/main'), { timeout: 60_000 }).toBe(head);
    // the client's helper answered one get; the Always consent is the pair's
    expect(helper.calls()).toEqual(['get']);
    expect(storedHost(home, hostId)?.alwaysCredentialHosts).toEqual([server.host]);

    // The git runner's status calls carry no relay pairs; its push did.
    const calls = await gitCalls(fixture);
    const status = calls.filter((line) => /(^| )status( |$)/.test(line));
    expect(status.length).toBeGreaterThan(0);
    expect(status.filter((line) => line.endsWith(' relay'))).toEqual([]);
    expect(calls.filter((line) => /(^| )push( |$)/.test(line))).toEqual([expect.stringMatching(/ relay$/)]);

    // A terminal has the credential nonce alone, and that nonce is refused for a prompt.
    await openTerminal(app);
    const probe = [
      'env | grep -cE \'^(DAMOCLES_ASKPASS_NONCE|GIT_ASKPASS|SSH_ASKPASS)=\' > /tmp/prompt-vars',
      'printf %s "$DAMOCLES_CREDENTIAL_NONCE" | grep -cE \'^[0-9a-f]{64}$\' > /tmp/credential-nonce',
      `DAMOCLES_ASKPASS_NONCE="$DAMOCLES_CREDENTIAL_NONCE" ELECTRON_RUN_AS_NODE=1 "$DAMOCLES_ASKPASS_NODE" "$DAMOCLES_ASKPASS_MAIN" askpass "Password for 'https://${USER}@${server.host}': " > /tmp/askpass.out 2>&1`,
    ].join('; ');
    expect(await inTerminal(app, fixture, probe, 'askpass')).toBe('1');
    expect((await fixture.sh('cat /tmp/prompt-vars /tmp/credential-nonce /tmp/askpass.out')).trim().split('\n')).toEqual(['0', '1', 'Damocles could not provide credentials.']);

    // approve and reject on the target: store and erase stay there, and this computer's helper is never called for them. A
    // reject of a credential the relay did not give reaches nothing on this computer; the reject answers after it would have.
    const fields = `protocol=https\\nhost=${server.host}\\nusername=${USER}`;
    expect(await inTerminal(app, fixture, `printf '${fields}\\npassword=target-side\\n\\n' | git credential approve && printf '${fields}\\npassword=target-side\\n\\n' | git credential reject`, 'credential')).toBe('0');
    expect(storedHost(home, hostId)?.alwaysCredentialHosts).toEqual([server.host]);
    expect((await recordedToasts(app)).filter((toast) => toast.actions.includes(REMOVE_LOCAL))).toEqual([]);
    // a reject of the relayed one, under any username, drops the pair's Always and offers the local removal, which only a click runs
    expect(await inTerminal(app, fixture, `printf 'protocol=https\\nhost=${server.host}\\nusername=someone-else\\npassword=${password}\\n\\n' | git credential reject`, 'relayed')).toBe('0');
    await expect.poll(() => storedHost(home, hostId)?.alwaysCredentialHosts).toEqual([]);
    let notice: { id: string } | undefined;
    await expect.poll(async () => (notice = (await recordedToasts(app)).find((toast) => toast.actions.includes(REMOVE_LOCAL)))).toBeDefined();
    expect(helper.calls()).toEqual(['get']);
    expect(helper.stored()).toBe(stored);
    await answerToast(app, notice!.id, REMOVE_LOCAL);
    await expect.poll(() => helper.stored()).toBe('');
    expect(helper.calls()).toEqual(['get', 'erase']);

    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await server.close();
  }
});

test('on a target whose git has its own credential.helper=store, the consent dialog warns, and Deny sends nothing', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const password = newGitPassword();
  const server = await startHttpsGitServer(home, 'app', USER, password);
  try {
    await trustCa(fixture, server.caPem);
    await targetRepo(fixture, server);
    await fixture.sh('git config --global credential.helper store', 'dev');
    const helper = clientCredentialHelper(home, server.host, USER, password);
    const { app } = await launch({ env: remoteEnv(ssh, mirror) });
    const { hostId } = await connect(app);
    await scmPush(app, true);
    const consent = gitConsent(await overlayPage(app));
    await expect(consent).toBeVisible({ timeout: 60_000 });
    await expect(consent.getByTestId('git-consent-helper-warning')).toBeVisible();
    await expect(consent.getByTestId('git-consent-host')).toHaveText('prod-1');
    await consent.getByRole('button', { name: 'Deny', exact: true }).click();
    await expect(consent).toHaveCount(0);
    // the push failed for want of credentials: nothing landed, no credential left this computer, and none was saved on prod-1
    expect(await serverRef(home, 'refs/heads/main')).toBeUndefined();
    expect(helper.calls()).toEqual([]);
    expect((await fixture.sh('cat ~/.git-credentials 2>/dev/null || true', 'dev')).trim()).toBe('');
    // the host store keeps the Always list only while it names a host
    expect(storedHost(home, hostId)?.alwaysCredentialHosts).toBeUndefined();
    await shutdownHostDaemon(app, hostId, fixture);
  } finally {
    await server.close();
  }
});

test('with the app closed, a push from a prod-1 terminal fails with the explicit message on stderr', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const password = newGitPassword();
  const server = await startHttpsGitServer(home, 'app', USER, password);
  try {
    await trustCa(fixture, server.caPem);
    await targetRepo(fixture, server);
    const helper = clientCredentialHelper(home, server.host, USER, password);
    const first = await launch({ env: remoteEnv(ssh, mirror) });
    const { hostId } = await connect(first.app);
    // the terminal's push waits on a FIFO until the app is gone; after the relay gives nothing git would ask on the tty,
    // so GIT_TERMINAL_PROMPT=0 ends the push there, as git in an agent's shell ends
    await openTerminal(first.app);
    const away = [
      'git config --get-all credential.helper > /tmp/helpers',
      `mkfifo /tmp/go && read line < /tmp/go && GIT_TERMINAL_PROMPT=0 git -C ${APP} push origin HEAD:refs/heads/away 2> /tmp/away.err`,
      'echo $? > /tmp/away.code',
    ];
    await fixture.sh('cat > /tmp/away.sh', 'dev', `${away.join('\n')}\n`);
    await runInTerminal(await shellPage(first.app), 'sh /tmp/away.sh');
    // a writer blocks until the shell opens the FIFO to read, so the push starts only once the app is gone
    await expect.poll(async () => (await fixture.sh('if [ -p /tmp/go ]; then echo made; fi')).trim()).toBe('made');
    // the terminal's git has the relay as its credential helper
    expect(await fixture.sh('cat /tmp/helpers')).toMatch(/git-credential-relay.sh/);
    await first.close();
    await fixture.sh('echo go > /tmp/go', 'dev');
    await expect.poll(async () => (await fixture.sh('cat /tmp/away.code 2>/dev/null || true')).trim(), { timeout: 60_000 }).not.toBe('');
    expect((await fixture.sh('cat /tmp/away.code')).trim()).not.toBe('0');
    expect(await fixture.sh('cat /tmp/away.err')).toContain(NOT_CONNECTED);
    expect(await serverRef(home, 'refs/heads/away')).toBeUndefined();
    expect(helper.calls()).toEqual([]);

    const second = await launch({ env: remoteEnv(ssh, mirror) });
    await openRemoteFolder(second.app, hostId, APP);
    await shutdownHostDaemon(second.app, hostId, fixture);
  } finally {
    await server.close();
  }
});

interface RelayOnOlder {
  readonly old: DesktopApp;
  readonly env: Record<string, string>;
  readonly hostId: string;
  readonly fixture: SshdFixture;
  readonly server: HttpsGitServer;
  readonly head: string;
  readonly helper: ReturnType<typeof clientCredentialHelper>;
  // the shell's relay handle and nonce, one per line
  readonly relay: string;
}

/** prod-1 with /srv/app pushing to the HTTPS server, under the app before an update (this package installed as OLD), with a bash terminal open. */
async function relayOnOlderServer(home: HermeticHome, launch: (options: { env: Record<string, string> }) => Promise<DesktopApp>, fixtures: Pick<RemoteFixtures, 'mirror' | 'ssh'>, sshd: RemoteFixtures['sshd'], server: HttpsGitServer, password: string): Promise<RelayOnOlder> {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await trustCa(fixture, server.caPem);
  const head = await targetRepo(fixture, server);
  const helper = clientCredentialHelper(home, server.host, USER, password);
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const env = remoteEnv(fixtures.ssh, fixtures.mirror);
  const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
  const { hostId } = await connect(old.app);
  await openTerminal(old.app);
  expect(await inTerminal(old.app, fixture, 'printf "%s\\n%s\\n" "$DAMOCLES_ASKPASS_HANDLE" "$DAMOCLES_CREDENTIAL_NONCE" > /tmp/relay-before', 'before')).toBe('0');
  const relay = await fixture.sh('cat /tmp/relay-before', 'dev');
  // the terminal host's own relay socket and nonce
  expect(relay).toMatch(/^\/tmp\/damocles-[^/]+\/askpass-[0-9a-f]{24}\.sock\n[0-9a-f]{64}\n$/);
  expect(await daemonVersions(fixture)).toEqual([OLD]);
  return { old, env, hostId, fixture, server, head, helper, relay };
}

test('in a terminal that survived a server switch, an HTTPS push gets this computer\'s credential through the new server, from the relay the shell started with', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const password = newGitPassword();
  const server = await startHttpsGitServer(home, 'app', USER, password);
  try {
    const older = await relayOnOlderServer(home, launch, { mirror, ssh }, sshd, server, password);
    await older.old.close();
    const { fixture } = older;
    const app = await switchToThisVersion(launch, older.env, older.hostId, fixture);
    expect(await inTerminal(app, fixture, 'printf "%s\\n%s\\n" "$DAMOCLES_ASKPASS_HANDLE" "$DAMOCLES_CREDENTIAL_NONCE" > /tmp/relay-after', 'after')).toBe('0');
    expect(await fixture.sh('cat /tmp/relay-after', 'dev')).toBe(older.relay);
    const pushed = inTerminal(app, fixture, `GIT_TERMINAL_PROMPT=0 git -C ${APP} push -q origin HEAD:refs/heads/survived`, 'push');
    const consent = gitConsent(await overlayPage(app));
    await expect(consent).toBeVisible({ timeout: 60_000 });
    await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
    expect(await pushed).toBe('0');
    expect(await serverRef(home, 'refs/heads/survived')).toBe(older.head);
    expect(older.helper.calls()).toEqual(['get']);
    await shutdownHostDaemon(app, older.hostId, fixture);
  } finally {
    await server.close();
  }
});

test('a push whose credential request comes during a server switch waits while no server runs and gets the credential once the new server is up', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const password = newGitPassword();
  const server = await startHttpsGitServer(home, 'app', USER, password);
  try {
    const older = await relayOnOlderServer(home, launch, { mirror, ssh }, sshd, server, password);
    const { fixture } = older;
    // the terminal's push waits on a FIFO, so it starts with the terminal's environment once no server runs
    const during = [
      `mkfifo /tmp/go && read line < /tmp/go && GIT_TERMINAL_PROMPT=0 git -C ${APP} push -q origin HEAD:refs/heads/during 2> /tmp/during.err`,
      'echo $? > /tmp/during.code',
    ];
    await fixture.sh('cat > /tmp/during.sh', 'dev', `${during.join('\n')}\n`);
    await runInTerminal(await shellPage(older.old.app), 'sh /tmp/during.sh');
    await expect.poll(async () => (await fixture.sh('if [ -p /tmp/go ]; then echo made; fi')).trim()).toBe('made');
    await older.old.close();
    // installed already, so the switch only starts a daemon, well inside the host's hold of the waiting connection
    await installOlderServer(fixture, CURRENT_PACKAGE);
    await fixture.sh("pkill -TERM -u dev -f 'dist/daemon.js serve'");
    await expect.poll(() => daemonVersions(fixture), { timeout: 30_000 }).toEqual([]);
    await fixture.sh('echo go > /tmp/go', 'dev');
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect((await fixture.sh('cat /tmp/during.code 2>/dev/null || true')).trim()).toBe('');

    const app = await switchToThisVersion(launch, older.env, older.hostId, fixture);
    const consent = gitConsent(await overlayPage(app));
    await expect(consent).toBeVisible({ timeout: 60_000 });
    await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
    await expect.poll(async () => (await fixture.sh('cat /tmp/during.code 2>/dev/null || true')).trim(), { timeout: 60_000 }).toBe('0');
    expect(await serverRef(home, 'refs/heads/during')).toBe(older.head);
    expect(older.helper.calls()).toEqual(['get']);
    await shutdownHostDaemon(app, older.hostId, fixture);
  } finally {
    await server.close();
  }
});
