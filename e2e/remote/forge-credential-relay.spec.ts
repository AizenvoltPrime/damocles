import * as dns from 'node:dns/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { createTestPki } from '../desktop/support/certs';
import { startForgeStub, type ForgeStub } from '../desktop/support/forge-stub';
import { writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { agentBash } from '../desktop/support/agent-bash';
import { recordingCredentialHelper, type RecordingCredentialHelper } from '../desktop/support/recording-credential-helper';
import { commitMessage, scmSection, setSection } from '../desktop/support/scm';
import { closeSettingsModal, openSettingsModal } from '../desktop/support/settings';
import { overlayPage, shellPage } from '../desktop/support/shell';
import { openTerminal, runInTerminal } from '../desktop/support/terminal';
import { clickMenu } from '../desktop/support/ui';
import { trustCa } from './support/credentials';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { gitConsent } from './support/host-settings-ui';
import { installOlderServer } from './support/older-server';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import { HOST_FROM_CONTAINER, runProgram, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

// GitHub and GitLab accounts on an SSH target: the daemon core takes git's credentials over from the target's
// own helpers for the servers this computer has accounts on and asks this computer's core through the relay. The forge stub
// is gitlab.com, reached as host.docker.internal from the target and from this computer, whose recording helper stands in
// for the user's credential manager.

const APP = '/srv/app';
const GITLAB = 'gitlab.com';
const REPO = 'alexios-s/damocles';
const TOKENS = { 'alexios-s': 'glpat-stubAlexiosSApi000000008', 'work-alexios': 'glpat-stubWorkAlexiosApi000001' } as const;
// this computer's own helper answers with project_42_bot's token, so a relayed answer from it is told apart from an account's
const RECORDER_TOKEN = 'glpat-stubProjectBotApiOnly003';
const CHECKED = { timeout: 60_000 };
// The reference server package: the oldest protocol peer (e2e/remote/support/reference-package.mjs).
const REFERENCE = process.env['DAMOCLES_E2E_REFERENCE_PACKAGE'];

interface RelayRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly helper: RecordingCredentialHelper;
  readonly fixture: SshdFixture;
  readonly gitRoot: string;
  /** host.docker.internal:<port> */
  readonly host: string;
  readonly env: Record<string, string>;
}

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/**
 * The stub where the target reaches it as host.docker.internal and this computer's core does too: on Linux the bridge's
 * gateway, which both resolve the name to; elsewhere Docker Desktop's hosts entry names this computer's LAN address while
 * containers reach its loopback, so the stub listens on every address.
 */
async function stubAddress(): Promise<string> {
  if (process.platform !== 'linux') return '0.0.0.0';
  return (await dns.lookup(HOST_FROM_CONTAINER)).address;
}

async function startRun(home: HermeticHome, fixture: SshdFixture, launch: (options: { env: Record<string, string> }) => Promise<{ app: ElectronApplication }>, env: Record<string, string>): Promise<RelayRun> {
  const pki = createTestPki([HOST_FROM_CONTAINER, 'localhost']);
  const caFile = path.join(home.root, 'forge-test-ca.pem');
  fs.writeFileSync(caFile, pki.caCertPem);
  const gitRoot = path.join(home.root, 'forge-git');
  fs.mkdirSync(path.join(gitRoot, 'alexios-s'), { recursive: true });
  const init = await runProgram('git', ['init', '--quiet', '--bare', '-b', 'main', path.join(gitRoot, `${REPO}.git`)]);
  if (init.code !== 0) throw new Error(`git init --bare exited with ${init.code}: ${init.stderr}`);
  const stub = await startForgeStub({ cert: pki.leafCertPem, key: pki.leafKeyPem, ca: pki.caCertPem, gitRoot, listenAddress: await stubAddress(), publicHost: HOST_FROM_CONTAINER });
  closers.push(() => stub.close());
  const host = new URL(stub.gitlab.webUrl).host;
  await trustCa(fixture, pki.caCertPem);
  const helper = recordingCredentialHelper(home, { answers: { [host]: { username: 'project_42_bot', password: RECORDER_TOKEN } }, caFile });
  // no background fetch lands among the requests a test counts
  writeUserSettings(home, { 'damocles.desktop.git.autofetch': false });
  const runEnv = {
    ...env,
    DAMOCLES_E2E_HOOKS: '1',
    DAMOCLES_E2E_FORGE_SERVERS: stub.e2eServersEnv(),
    NODE_EXTRA_CA_CERTS: caFile,
    GIT_CONFIG_GLOBAL: helper.globalConfig,
  };
  const { app } = await launch({ env: runEnv });
  return { app, stub, helper, fixture, gitRoot, host, env: runEnv };
}

/** /srv/app on the target: one commit pushed to the stub's alexios-s/damocles, then one ahead; resolves with the head. */
async function targetRepo(run: RelayRun): Promise<string> {
  const bare = path.join(run.gitRoot, `${REPO}.git`);
  await run.fixture.sh([
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    'echo one > a.txt && git add -A && git commit -q -m init',
    `git remote add origin '${run.stub.gitlab.webUrl}/${REPO}.git'`,
    'git bundle create /tmp/init.bundle main',
  ].join(' && '), 'dev');
  // the first commit reaches the stub's bare repository from the bundle, as if it had been pushed before
  const copied = await runProgram('docker', ['cp', `${run.fixture.container}:/tmp/init.bundle`, path.join(run.gitRoot, 'init.bundle')]);
  if (copied.code !== 0) throw new Error(`docker cp failed: ${copied.stderr}`);
  const fetched = await runProgram('git', ['--git-dir', bare, 'fetch', '--quiet', path.join(run.gitRoot, 'init.bundle'), 'main:main']);
  if (fetched.code !== 0) throw new Error(`git fetch of the bundle exited with ${fetched.code}: ${fetched.stderr}`);
  return commitOnTarget(run, 'ahead.txt', [
    'git update-ref refs/remotes/origin/main HEAD',
    'git branch --set-upstream-to origin/main main',
  ]);
}

async function commitOnTarget(run: RelayRun, file: string, before: readonly string[] = []): Promise<string> {
  await run.fixture.sh([`cd ${APP}`, ...before, `echo ${file} > ${file} && git add -A && git commit -q -m ${file}`].join(' && '), 'dev');
  return (await run.fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();
}

async function stubHead(run: RelayRun): Promise<string | undefined> {
  const result = await runProgram('git', ['--git-dir', path.join(run.gitRoot, `${REPO}.git`), 'rev-parse', '--verify', '--quiet', 'main']);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

const pushes = (run: RelayRun) => run.stub.gitlab.requests.filter((request) => request.path.endsWith('/git-receive-pack'));

async function tokenSignIn(app: ElectronApplication, logins: readonly (keyof typeof TOKENS)[]): Promise<void> {
  const overlay = await openSettingsModal(app, 'accounts');
  await expect(overlay.getByTestId('forge-loading')).toHaveCount(0);
  for (const login of logins) {
    await overlay.getByRole('button', { name: `Add account: ${GITLAB}`, exact: true }).click();
    await overlay.getByRole('radio', { name: 'Token', exact: true }).click();
    await overlay.getByLabel('Personal access token', { exact: true }).fill(TOKENS[login]);
    await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(overlay.getByText(`Signed in as ${login}`, { exact: true })).toBeVisible();
  }
  await closeSettingsModal(overlay);
}

async function connect(run: RelayRun): Promise<{ hostId: string; key: string; shell: Page; chip: Locator }> {
  const hostId = await addHost(run.app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(run.app, hostId, APP);
  await remoteProjectKey(run.app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(run.app);
  return { hostId, key, shell, chip: scmSection(shell).getByTestId('forge-account-chip') };
}

/** Push from the menu once Source Control shows the commit the target made as outgoing, which enables the command. */
async function push(run: RelayRun): Promise<void> {
  const shell = await shellPage(run.app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible(CHECKED);
  await expect(scmSection(shell).getByRole('button', { name: /^Push \d+ commits? to origin\/main$/ }).first()).toBeVisible(CHECKED);
  await clickMenu(run.app, 'damocles.git.push');
}

async function pickInChip(run: RelayRun, chip: Locator, label: string): Promise<void> {
  const overlay = await overlayPage(run.app);
  // from the keyboard: a hover left on the section header after More Actions lays its actions over the chip
  await chip.focus();
  await chip.press('ArrowDown');
  await overlay.getByRole('menu', { name: /^Accounts for / }).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
}

/** Runs `script` in the active terminal's shell on the target and resolves with its exit code (support/git-credential-relay's pattern). */
async function inTerminal(run: RelayRun, script: string, marker: string): Promise<string> {
  await run.fixture.sh(`cat > /tmp/${marker}.sh`, 'dev', `${script}\necho $? > /tmp/${marker}.code\n`);
  await runInTerminal(await shellPage(run.app), `sh /tmp/${marker}.sh`);
  let code = '';
  await expect.poll(async () => (code = (await run.fixture.sh(`cat /tmp/${marker}.code 2>/dev/null || true`)).trim()), CHECKED).not.toBe('');
  return code;
}

test('an explicitly bound account answers Source Control and terminal pushes on prod-1 with no consent dialog, and an agent shell with the account\'s switch off is refused', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  const openai = await startTargetStub(home, fixture);
  closers.push(() => openai.close());
  const run = await startRun(home, fixture, launch, remoteEnv(ssh, mirror));
  await targetRepo(run);
  await tokenSignIn(run.app, ['alexios-s', 'work-alexios']);
  const { hostId, key, chip } = await connect(run);
  await expect(chip).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`, CHECKED);
  await pickInChip(run, chip, 'alexios-s');
  await expect(chip).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen by you`, CHECKED);

  const head = (await run.fixture.sh(`git -C ${APP} rev-parse HEAD`, 'dev')).trim();
  await push(run);
  await expect.poll(() => stubHead(run), CHECKED).toBe(head);
  expect(pushes(run).at(-1)!.credential).toBe(TOKENS['alexios-s']);
  await expect(gitConsent(await overlayPage(run.app))).toHaveCount(0);

  await openTerminal(run.app);
  const next = await commitOnTarget(run, 'terminal.txt');
  const pushed = await inTerminal(run, `env > /tmp/push.env; git -C ${APP} push origin main 2> /tmp/push.err`, 'push');
  expect(pushed, await run.fixture.sh('cat /tmp/push.err; grep -oE "^(GIT_CONFIG[A-Z_0-9]*|DAMOCLES_[A-Z_]*)=" /tmp/push.env', 'dev')).toBe('0');
  expect(await stubHead(run)).toBe(next);
  expect(pushes(run).at(-1)!.credential).toBe(TOKENS['alexios-s']);
  await expect(gitConsent(await overlayPage(run.app))).toHaveCount(0);
  expect(run.helper.calls()).toEqual([]);

  // a personal access token's "Agent shells may use this account" switch starts off: the agent's git is refused, naming the switch, and nothing asks
  const tab = await newRemoteChat(run.app, key);
  const served = run.stub.gitlab.counts.gitServed;
  const refused = await agentBash(tab, openai, `git -C ${APP} fetch origin`, 'fetch on prod-1');
  expect(refused).toContain('Agent shells may use this account');
  expect(run.stub.gitlab.counts.gitServed).toBe(served);
  await expect(gitConsent(await overlayPage(run.app))).toHaveCount(0);
  expect(run.helper.calls()).toEqual([]);

  await shutdownHostDaemon(run.app, hostId, fixture);
});

test('an account chosen automatically asks consent naming it, once; a project on "Use Git\'s own credentials" keeps today\'s relay to this computer\'s helper', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  const run = await startRun(home, fixture, launch, remoteEnv(ssh, mirror));
  const head = await targetRepo(run);
  await tokenSignIn(run.app, ['alexios-s']);
  const { hostId, chip } = await connect(run);
  await expect(chip).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen automatically`, CHECKED);

  await push(run);
  const overlay = await overlayPage(run.app);
  const consent = gitConsent(overlay);
  await expect(consent).toBeVisible(CHECKED);
  await expect(consent).toHaveAccessibleName(`Let prod-1 sign in to ${GITLAB} as alexios-s?`);
  await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(() => stubHead(run), CHECKED).toBe(head);
  expect(pushes(run).at(-1)!.credential).toBe(TOKENS['alexios-s']);
  await expect(consent).toHaveCount(0);
  expect(run.helper.calls()).toEqual([]);

  // "Use Git's own credentials": the target's git asks this computer through today's relay, whose consent names no account
  await pickInChip(run, chip, "Use Git's own credentials");
  await expect(chip).toHaveAccessibleName(`Accounts: ${GITLAB}, Git's own credentials`, CHECKED);
  const next = await commitOnTarget(run, 'delegated.txt');
  await push(run);
  await expect(consent).toBeVisible(CHECKED);
  await expect(consent).toHaveAccessibleName(`prod-1 wants to use your saved credentials for ${run.host}`);
  await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(() => stubHead(run), CHECKED).toBe(next);
  expect(pushes(run).at(-1)!.credential).toBe(RECORDER_TOKEN);
  expect(run.helper.calls().filter((recorded) => recorded.op === 'get' && recorded.host === run.host)).toHaveLength(1);

  await shutdownHostDaemon(run.app, hostId, fixture);
});

test('the reference daemon keeps today\'s relay: an account on this computer does not answer its git, its consent names no account and this computer\'s helper answers', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  if (REFERENCE === undefined || !fs.existsSync(REFERENCE)) {
    throw new Error('DAMOCLES_E2E_REFERENCE_PACKAGE names no reference server package; build one with `node e2e/remote/support/reference-package.mjs --ref remote-protocol-ref --target linux-x64 --out <empty folder>`');
  }
  const fixture = await sshd('prod-1');
  const reference = await installOlderServer(fixture, REFERENCE);
  const run = await startRun(home, fixture, launch, { ...remoteEnv(ssh, mirror), DAMOCLES_E2E_APP_VERSION: reference });
  const head = await targetRepo(run);
  await tokenSignIn(run.app, ['alexios-s']);
  const { hostId } = await connect(run);

  await push(run);
  const consent = gitConsent(await overlayPage(run.app));
  await expect(consent).toBeVisible(CHECKED);
  await expect(consent).toHaveAccessibleName(`prod-1 wants to use your saved credentials for ${run.host}`);
  await consent.getByRole('button', { name: 'Allow once', exact: true }).click();
  await expect.poll(() => stubHead(run), CHECKED).toBe(head);
  expect(pushes(run).at(-1)!.credential).toBe(RECORDER_TOKEN);
  expect(run.helper.calls().filter((recorded) => recorded.op === 'get' && recorded.host === run.host)).toHaveLength(1);

  await shutdownHostDaemon(run.app, hostId, fixture);
});
