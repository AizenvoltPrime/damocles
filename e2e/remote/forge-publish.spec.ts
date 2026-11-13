import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator } from '@playwright/test';
import { createTestPki } from '../desktop/support/certs';
import { startForgeStub, type ForgeStub } from '../desktop/support/forge-stub';
import { writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { commitMessage, scmSection, setSection } from '../desktop/support/scm';
import { closeSettingsModal, openSettingsModal } from '../desktop/support/settings';
import { overlayPage, shellPage } from '../desktop/support/shell';
import { clickMenu } from '../desktop/support/ui';
import { openedExternally, recordOpenExternal } from '../desktop/support/updates';
import { trustCa } from './support/credentials';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { gitConsent } from './support/host-settings-ui';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { HOST_FROM_CONTAINER, runProgram, type SshdFixture } from './support/sshd';

// GitHub and GitLab accounts on an SSH target: Publish and Fork and Push for a remote project. Every git step
// (remote add, remote rename, push) runs on the target's own core, every server call (namespaces, create, the push access
// check, the fork and its polls, the create page) on this computer's core; the forge stub is gitlab.com, reached as
// host.docker.internal from the target and from this computer.

const APP = '/srv/app';
const GITLAB = 'gitlab.com';
const TOKEN = 'glpat-stubAlexiosSApi000000008';
const UPSTREAM = 'grp/tools';
const CHECKED = { timeout: 60_000 };

interface PublishRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly fixture: SshdFixture;
  readonly gitRoot: string;
}

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** As forge-credential-relay.spec.ts: where the target and this computer both reach the stub as host.docker.internal. */
async function stubAddress(): Promise<string> {
  if (process.platform !== 'linux') return '0.0.0.0';
  return (await dns.lookup(HOST_FROM_CONTAINER)).address;
}

async function startRun(home: HermeticHome, fixture: SshdFixture, launch: (options: { env: Record<string, string> }) => Promise<{ app: ElectronApplication }>, env: Record<string, string>): Promise<PublishRun> {
  const pki = createTestPki([HOST_FROM_CONTAINER, 'localhost']);
  const caFile = path.join(home.root, 'forge-test-ca.pem');
  fs.writeFileSync(caFile, pki.caCertPem);
  const gitRoot = path.join(home.root, 'forge-git');
  fs.mkdirSync(gitRoot, { recursive: true });
  const stub = await startForgeStub({ cert: pki.leafCertPem, key: pki.leafKeyPem, ca: pki.caCertPem, gitRoot, listenAddress: await stubAddress(), publicHost: HOST_FROM_CONTAINER });
  closers.push(() => stub.close());
  await trustCa(fixture, pki.caCertPem);
  writeUserSettings(home, { 'damocles.desktop.git.autofetch': false });
  await fixture.sh(["git config --global user.name 'E2E Dev'", 'git config --global user.email dev@prod-1.invalid'].join(' && '), 'dev');
  const { app } = await launch({ env: { ...env, DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_FORGE_SERVERS: stub.e2eServersEnv(), NODE_EXTRA_CA_CERTS: caFile } });
  await recordOpenExternal(app);
  return { app, stub, fixture, gitRoot };
}

async function signIn(app: ElectronApplication): Promise<void> {
  const overlay = await openSettingsModal(app, 'accounts');
  await expect(overlay.getByTestId('forge-loading')).toHaveCount(0);
  await overlay.getByRole('button', { name: `Add account: ${GITLAB}`, exact: true }).click();
  await overlay.getByRole('radio', { name: 'Token', exact: true }).click();
  await overlay.getByLabel('Personal access token', { exact: true }).fill(TOKEN);
  await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(overlay.getByText('Signed in as alexios-s', { exact: true })).toBeVisible();
  await closeSettingsModal(overlay);
}

async function connect(run: PublishRun): Promise<{ hostId: string; chip: Locator }> {
  const hostId = await addHost(run.app, { alias: 'prod-1', name: 'prod-1' });
  await openRemoteFolder(run.app, hostId, APP);
  await remoteProjectKey(run.app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(run.app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible(CHECKED);
  return { hostId, chip: scmSection(shell).getByTestId('forge-account-chip') };
}

async function bareHead(run: PublishRun, repoPath: string): Promise<string | undefined> {
  const result = await runProgram('git', ['--git-dir', path.join(run.gitRoot, ...`${repoPath}.git`.split('/')), 'rev-parse', '--verify', '--quiet', 'main']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

const targetRemotes = async (run: PublishRun): Promise<string> => (await run.fixture.sh(`git -C ${APP} remote -v`, 'dev')).trim();

test('Publish on a remote project creates the repository from this computer and adds it and pushes on the target', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const run = await startRun(home, fixture, launch, remoteEnv(ssh, mirror));
  await fixture.sh([`git init -q -b main ${APP}`, `cd ${APP}`, 'echo one > a.txt && git add -A && git commit -q -m init'].join(' && '), 'dev');
  const head = (await fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();
  await signIn(run.app);
  const { hostId } = await connect(run);

  await clickMenu(run.app, 'damocles.git.publish');
  const overlay = await overlayPage(run.app);
  const dialog = overlay.getByRole('dialog', { name: 'Publish app' });
  await expect(dialog).toBeVisible(CHECKED);
  await dialog.getByLabel('Owner').selectOption(`${GITLAB}|alexios-s|personal`);
  await dialog.getByLabel('Name').fill('app published');
  await expect(dialog.getByLabel('Name')).toHaveValue('app-published');
  await dialog.getByRole('radio', { name: 'Private' }).click();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(overlay.getByText(`Published ${GITLAB}/alexios-s/app-published. This project now uses alexios-s on ${GITLAB}.`, { exact: true })).toBeVisible(CHECKED);

  expect(run.stub.gitlab.created).toEqual([{ path: 'alexios-s/app-published', login: 'alexios-s', visibility: 'private' }]);
  expect(await bareHead(run, 'alexios-s/app-published')).toBe(head);
  // the remote was added on the target, and the target's push reached the stub with the account's token
  expect(await targetRemotes(run)).toContain(`origin\t${run.stub.gitlab.webUrl}/alexios-s/app-published.git (push)`);
  const receivePacks = run.stub.gitlab.requests.filter((request) => request.path === '/alexios-s/app-published.git/git-receive-pack');
  expect(receivePacks.at(-1)?.credential).toBe(TOKEN);

  await shutdownHostDaemon(run.app, hostId, fixture);
});

test('a denied push on a remote project forks from this computer and re-points the remotes and pushes on the target', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const run = await startRun(home, fixture, launch, remoteEnv(ssh, mirror));
  run.stub.gitlab.projectAccess.set(UPSTREAM, new Map([['alexios-s', 20]]));
  run.stub.gitlab.enforcePushAccess = true;
  await fixture.sh([
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    'echo one > a.txt && git add -A && git commit -q -m init',
    `git remote add origin '${run.stub.gitlab.webUrl}/${UPSTREAM}.git'`,
    'git bundle create /tmp/init.bundle main',
  ].join(' && '), 'dev');
  // the upstream holds the first commit, as if it had been pushed before
  const bare = path.join(run.gitRoot, 'grp', 'tools.git');
  expect((await runProgram('git', ['init', '--quiet', '--bare', '-b', 'main', bare])).code).toBe(0);
  expect((await runProgram('docker', ['cp', `${fixture.container}:/tmp/init.bundle`, path.join(run.gitRoot, 'init.bundle')])).code).toBe(0);
  expect((await runProgram('git', ['--git-dir', bare, 'fetch', '--quiet', path.join(run.gitRoot, 'init.bundle'), 'main:main'])).code).toBe(0);
  await fixture.sh([`cd ${APP}`, 'git update-ref refs/remotes/origin/main HEAD', 'git branch --set-upstream-to origin/main main', 'echo two > b.txt && git add -A && git commit -q -m ahead'].join(' && '), 'dev');
  const head = (await fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();
  await signIn(run.app);
  const { hostId } = await connect(run);
  const shell = await shellPage(run.app);
  await expect(scmSection(shell).getByRole('button', { name: /^Push \d+ commits? to origin\/main$/ }).first()).toBeVisible(CHECKED);

  await clickMenu(run.app, 'damocles.git.push');
  const overlay = await overlayPage(run.app);
  // the account was settled automatically, so the target's first credential asks consent once
  const consent = gitConsent(overlay);
  await expect(consent).toBeVisible(CHECKED);
  await expect(consent).toHaveAccessibleName(`Let prod-1 sign in to ${GITLAB} as alexios-s?`);
  await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
  const ask = overlay.getByRole('alertdialog', { name: `You can't push to ${UPSTREAM}` });
  await expect(ask).toBeVisible(CHECKED);
  await ask.getByRole('button', { name: 'Fork and Push' }).click();
  const merge = overlay.getByRole('button', { name: 'Open Merge Request' });
  await expect(merge).toBeVisible(CHECKED);

  expect(run.stub.gitlab.created).toEqual([{ path: 'alexios-s/tools', login: 'alexios-s', visibility: 'private', forkOf: UPSTREAM }]);
  expect(await bareHead(run, 'alexios-s/tools')).toBe(head);
  expect(await bareHead(run, UPSTREAM)).not.toBe(head);
  const remotes = await targetRemotes(run);
  expect(remotes).toContain(`origin\t${run.stub.gitlab.webUrl}/alexios-s/tools.git (push)`);
  expect(remotes).toContain(`upstream\t${run.stub.gitlab.webUrl}/${UPSTREAM}.git (push)`);

  await merge.click();
  await expect.poll(() => openedExternally(run.app), CHECKED).toHaveLength(1);
  const [opened] = await openedExternally(run.app);
  expect(opened).toBe(`${run.stub.gitlab.webUrl}/alexios-s/tools/-/merge_requests/new?merge_request%5Bsource_branch%5D=main&merge_request%5Btarget_project_id%5D=42`);

  await shutdownHostDaemon(run.app, hostId, fixture);
});

test('a push to a protected branch of a remote project asks from this computer and creates and pushes the new branch on the target', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const run = await startRun(home, fixture, launch, remoteEnv(ssh, mirror));
  // alexios-s may push to grp/tools, but no one may push to its main: changes reach it only through merge requests
  run.stub.gitlab.projectAccess.set(UPSTREAM, new Map([['alexios-s', 40]]));
  run.stub.gitlab.protection.set(UPSTREAM, { protectedBranches: [{ name: 'main', push: [{ access_level: 0 }] }] });
  run.stub.gitlab.enforcePushAccess = true;
  await fixture.sh([
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    'echo one > a.txt && git add -A && git commit -q -m init',
    `git remote add origin '${run.stub.gitlab.webUrl}/${UPSTREAM}.git'`,
    'git bundle create /tmp/init.bundle main',
  ].join(' && '), 'dev');
  const bare = path.join(run.gitRoot, 'grp', 'tools.git');
  expect((await runProgram('git', ['init', '--quiet', '--bare', '-b', 'main', bare])).code).toBe(0);
  expect((await runProgram('docker', ['cp', `${fixture.container}:/tmp/init.bundle`, path.join(run.gitRoot, 'init.bundle')])).code).toBe(0);
  expect((await runProgram('git', ['--git-dir', bare, 'fetch', '--quiet', path.join(run.gitRoot, 'init.bundle'), 'main:main'])).code).toBe(0);
  await fixture.sh([`cd ${APP}`, 'git update-ref refs/remotes/origin/main HEAD', 'git branch --set-upstream-to origin/main main', 'echo two > b.txt && git add -A && git commit -q -m ahead'].join(' && '), 'dev');
  const head = (await fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();
  const servedMain = await bareHead(run, UPSTREAM);
  await signIn(run.app);
  const { hostId } = await connect(run);
  const shell = await shellPage(run.app);
  await expect(scmSection(shell).getByRole('button', { name: /^Push \d+ commits? to origin\/main$/ }).first()).toBeVisible(CHECKED);

  await clickMenu(run.app, 'damocles.git.push');
  const overlay = await overlayPage(run.app);
  const consent = gitConsent(overlay);
  await expect(consent).toBeVisible(CHECKED);
  await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
  const ask = overlay.getByRole('alertdialog', { name: `Warning main is protected on ${GITLAB}`, exact: true });
  await expect(ask).toBeVisible(CHECKED);
  await expect(overlay.getByRole('alertdialog', { name: /You can't push to/ })).toHaveCount(0);
  await expect(ask).toHaveAccessibleDescription(/so alexios-s cannot push to it\..*main has 1 commit that origin does not have\./s);
  await ask.getByRole('button', { name: 'Push to a New Branch', exact: true }).click();
  const field = overlay.getByRole('dialog', { name: 'Push to a new branch', exact: true }).getByLabel('Branch name', { exact: true });
  await expect(field).toHaveValue('alexios-s/main');
  // the name is checked with git's rules on the target's core
  await field.fill('main');
  await expect(field).toHaveAccessibleDescription('A local branch named main exists already.');
  await field.fill('alexios-s/main');
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  await overlay.getByRole('button', { name: 'Create and Push', exact: true }).click();
  // Allow once covered the refused push only, so the new branch's push asks again
  await expect(consent).toBeVisible(CHECKED);
  await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
  const done = overlay.getByRole('dialog', { name: 'Pushed alexios-s/main', exact: true });
  await expect(done).toBeVisible(CHECKED);

  // the target holds the new branch with its upstream; its main is where it was, and the server's main too
  const served = await runProgram('git', ['--git-dir', bare, 'rev-parse', '--verify', '--quiet', 'refs/heads/alexios-s/main']);
  expect(served.stdout.trim()).toBe(head);
  expect(await bareHead(run, UPSTREAM)).toBe(servedMain);
  expect((await fixture.sh(`git -C ${APP} branch --show-current`, 'dev')).trim()).toBe('alexios-s/main');
  expect((await fixture.sh(`git -C ${APP} rev-parse main`, 'dev')).trim()).toBe(head);
  expect((await fixture.sh(`git -C ${APP} rev-parse --abbrev-ref 'alexios-s/main@{upstream}'`, 'dev')).trim()).toBe('origin/alexios-s/main');

  await done.getByRole('button', { name: 'Open Merge Request', exact: true }).click();
  await expect.poll(() => openedExternally(run.app), CHECKED).toHaveLength(1);
  const url = new URL((await openedExternally(run.app))[0]!);
  expect(`${url.origin}${url.pathname}`).toBe(`${run.stub.gitlab.webUrl}/${UPSTREAM}/-/merge_requests/new`);
  expect(url.searchParams.get('merge_request[source_branch]')).toBe('alexios-s/main');
  expect(url.searchParams.get('merge_request[target_branch]')).toBe('main');

  await shutdownHostDaemon(run.app, hostId, fixture);
});
