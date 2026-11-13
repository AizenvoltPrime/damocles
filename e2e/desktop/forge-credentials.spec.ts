import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { deviceSignIn, forgeEnv, inAccounts, launchReady, setAgentShells as setAgentShellsSwitch, startStubOnTestCa } from './support/forge';
import type { ForgeStub } from './support/forge-stub';
import { startGitHttpServer, type GitHttpServer } from './support/git-http-server';
import { expect, test } from './support/fixtures';
import type { DesktopApp } from './support/app';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { git, initRepo } from './support/git';
import { startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { agentBash } from './support/agent-bash';
import { overlayMenu, readyOverlay } from './support/overlay';
import { recordingCredentialHelper, type RecordingCredentialHelper } from './support/recording-credential-helper';
import { autofetchNow, clickAccountChip, gitLog, openScmProject, scmSection } from './support/scm';
import { openProjectChat } from './support/screenshots';
import { openTerminal, runInTerminal, useTestProfile } from './support/terminal';
import { clickMenu } from './support/ui';

// GitHub and GitLab accounts: git takes its credentials from the bound account in Source Control, integrated
// terminals and agent shells, "Use Git's own credentials" delegates to the user's helpers, and tools never show a token.
// The app's gitlab.com is the forge stub, whose smart-HTTP git and Git LFS take a live token; the user's own credential
// helper is a recorder in a temp global config.

const GITLAB = 'gitlab.com';
const REPO = 'alexios-s/damocles';
// the recorder's answer for the stub: work-alexios's token, so a delegated push is told apart from the bound account's
const RECORDER_TOKEN = 'glpat-stubWorkAlexiosApi000001';
const UNMANAGED = { user: 'recorder', password: 'recorder-pass' };
const CHECKED = { timeout: 30_000 };

interface CredentialRun {
  readonly desktop: DesktopApp;
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly helper: RecordingCredentialHelper;
  readonly unmanaged: GitHttpServer;
  readonly openai: OpenAIStub;
  readonly gitRoot: string;
  /** host:port of the stub's gitlab.com */
  readonly host: string;
}

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

/** autofetch: off unless a test drives it, so no background fetch lands among the requests a test counts. */
async function launchCredentials(launch: (options?: { env?: Record<string, string> }) => Promise<DesktopApp>, home: HermeticHome, autofetch = false): Promise<CredentialRun> {
  const gitRoot = path.join(home.root, 'forge-git');
  fs.mkdirSync(path.join(gitRoot, 'alexios-s'), { recursive: true });
  await git(home, gitRoot, 'init', '--quiet', '--bare', '-b', 'main', path.join(gitRoot, `${REPO}.git`));
  const started = await startStubOnTestCa(home, { gitRoot });
  const { stub, caFile } = started;
  closers.push(() => stub.close());
  const unmanagedRoot = path.join(home.root, 'unmanaged-git');
  fs.mkdirSync(unmanagedRoot, { recursive: true });
  await git(home, unmanagedRoot, 'init', '--quiet', '--bare', '-b', 'main', path.join(unmanagedRoot, 'other.git'));
  const unmanaged = await startGitHttpServer({ root: unmanagedRoot, user: UNMANAGED.user, password: UNMANAGED.password });
  closers.push(() => unmanaged.close());
  const openai = await startOpenAIStub();
  closers.push(() => openai.close());
  seedStubModel(home, openai.baseUrl);
  useTestProfile(home);
  writeUserSettings(home, { 'damocles.desktop.git.autofetch': autofetch });
  const host = new URL(stub.gitlab.webUrl).host;
  const helper = recordingCredentialHelper(home, {
    answers: { [host]: { username: 'work-alexios', password: RECORDER_TOKEN }, [new URL(unmanaged.url('')).host]: { username: UNMANAGED.user, password: UNMANAGED.password } },
    caFile,
  });
  const desktop = await launchReady(launch, { ...forgeEnv(started), GIT_CONFIG_GLOBAL: helper.globalConfig });
  return { desktop, app: desktop.app, stub, helper, unmanaged, openai, gitRoot, host };
}

/** Device code sign-ins of gitlab.com accounts: OAuth tokens with a refresh token, as the browser route gives. */
async function signIn(run: CredentialRun, logins: readonly string[]): Promise<void> {
  await inAccounts(run.app, async (overlay) => {
    for (const login of logins) await deviceSignIn(overlay, GITLAB, run.stub.gitlab, login);
  });
}

/** Sets an account's "Agent shells may use this account" switch in Settings › Models & accounts › Git hosting. */
async function setAgentShells(app: ElectronApplication, login: string, on: boolean): Promise<void> {
  await inAccounts(app, (overlay) => setAgentShellsSwitch(overlay, GITLAB, login, on));
}

/** A project on the stub's alexios-s/damocles, in step with it, then one commit ahead; returns its folder. */
async function stubProject(run: CredentialRun, home: HermeticHome, name: string): Promise<string> {
  const dir = path.join(home.root, 'projects', name);
  await initRepo(home, dir);
  const bare = path.join(run.gitRoot, `${REPO}.git`);
  await git(home, dir, 'push', '--quiet', bare, 'main');
  await git(home, dir, 'remote', 'add', 'origin', `${run.stub.gitlab.webUrl}/${REPO}.git`);
  await git(home, dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(home, dir, 'branch', '--set-upstream-to', 'origin/main', 'main');
  await commit(home, dir, 'ahead.txt');
  return dir;
}

async function commit(home: HermeticHome, dir: string, file: string): Promise<void> {
  fs.writeFileSync(path.join(dir, file), `${file} ${Date.now()}\n`);
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '--quiet', '-m', `Add ${file}`);
}

const remoteHead = (run: CredentialRun, home: HermeticHome): Promise<string> => git(home, path.join(run.gitRoot, `${REPO}.git`), 'rev-parse', 'main');

/** The receive-pack requests the stub's gitlab.com served, with the basic auth each carried. */
const pushes = (run: CredentialRun) => run.stub.gitlab.requests.filter((request) => request.path.endsWith('/git-receive-pack'));
const stubCalls = (run: CredentialRun) => run.helper.calls().filter((call) => call.host === run.host);

/** Push from Source Control, then wait until the stub holds the project's HEAD. */
async function scmPush(run: CredentialRun, home: HermeticHome, dir: string): Promise<void> {
  await clickMenu(run.app, 'damocles.git.push');
  const head = await git(home, dir, 'rev-parse', 'HEAD');
  await expect.poll(() => remoteHead(run, home), CHECKED).toBe(head);
}

/** Runs `command` in the active terminal with its output in `file` under the project, and returns that output once it is complete. */
async function terminalOutput(shell: Page, dir: string, command: string, file: string): Promise<string> {
  const out = path.join(dir, file);
  const done = `${out}.done`;
  // the marker file is written after the command ends, so a half-written output is never read
  await runInTerminal(shell, `${command} > ${file} 2>&1 && echo ok> ${file}.done || echo failed> ${file}.done`);
  await expect.poll(() => fs.existsSync(done), CHECKED).toBe(true);
  const text = fs.readFileSync(out, 'utf8');
  fs.rmSync(done);
  return text;
}

test('Source Control push uses the bound account; the user\'s helper is never asked for gitlab.com and still answers an unmanaged server', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchCredentials(launch, home);
  await signIn(run, ['alexios-s']);
  const dir = await stubProject(run, home, 'damocles');
  const shell = await openScmProject(run.app, dir);
  await expect(scmSection(shell).getByTestId('forge-account-chip')).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen automatically`, CHECKED);

  await scmPush(run, home, dir);
  const push = pushes(run).at(-1)!;
  expect(push.username).toBe('oauth2');
  expect(run.stub.gitlab.tokenLogin(push.credential!)).toBe('alexios-s');
  expect(stubCalls(run)).toEqual([]);

  // an unmanaged server keeps the user's own helper
  const other = path.join(home.root, 'projects', 'other');
  await initRepo(home, other);
  await git(home, other, 'remote', 'add', 'origin', run.unmanaged.url('other.git'));
  await openScmProject(run.app, other);
  await clickMenu(run.app, 'damocles.git.push');
  const question = (await readyOverlay(run.app)).getByRole('alertdialog').filter({ hasText: 'has no remote branch' });
  await question.getByTestId('overlay-message-action-0').click();
  await expect.poll(() => run.helper.calls().filter((call) => call.op === 'get' && call.host === new URL(run.unmanaged.url('')).host).length, CHECKED).toBeGreaterThan(0);
  await expect.poll(() => run.unmanaged.requests.served, CHECKED).toBeGreaterThan(0);
  expect(stubCalls(run)).toEqual([]);
});

test('Git LFS objects push with the bound account, through the batch API git\'s credential answer reaches', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchCredentials(launch, home);
  await signIn(run, ['alexios-s']);
  const dir = await stubProject(run, home, 'damocles');
  // the pre-push hook git lfs installs uploads the object, asking git for the server's credentials
  await git(home, dir, 'lfs', 'install', '--local');
  await git(home, dir, 'lfs', 'track', '*.bin');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.alloc(2048, 7));
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '--quiet', '-m', 'Add an LFS object');
  const shell = await openScmProject(run.app, dir);
  await expect(scmSection(shell).getByTestId('forge-account-chip')).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen automatically`, CHECKED);

  await scmPush(run, home, dir);
  const objects = [...(run.stub.gitlab.lfsObjects.get(REPO)?.values() ?? [])];
  expect(objects).toHaveLength(1);
  expect(objects[0]!.username).toBe('oauth2');
  expect(run.stub.gitlab.tokenLogin(objects[0]!.credential)).toBe('alexios-s');
  expect(run.stub.gitlab.tokenLogin(pushes(run).at(-1)!.credential!)).toBe('alexios-s');
  expect(stubCalls(run)).toEqual([]);
});

test('an integrated terminal\'s git uses the account through one GIT_CONFIG_PARAMETERS: only Damocles\' helper for the server, no empty variable, fill gives the access token; Use Git\'s own credentials makes its next push use the user\'s helper', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchCredentials(launch, home);
  await signIn(run, ['alexios-s']);
  const dir = await stubProject(run, home, 'damocles');
  const shell = await openScmProject(run.app, dir);
  const chip = scmSection(shell).getByTestId('forge-account-chip');
  await expect(chip).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen automatically`, CHECKED);
  await openTerminal(run.app);

  // git config shows the reset list: Damocles' helper alone, for the stub's URL and for gitlab.com's own git host
  for (const url of [`${run.stub.gitlab.webUrl}/x`, 'https://gitlab.com/x']) {
    const helpers = (await terminalOutput(shell, dir, `git config --get-urlmatch credential.helper ${url}`, 'helpers.txt')).trim().split(/\r?\n/);
    expect(helpers).toHaveLength(1);
    expect(helpers[0]).toMatch(/^!'.*git-credential-relay\.(sh|cmd)' --takeover$/);
  }

  const env = await terminalOutput(shell, dir, process.platform === 'win32' ? 'set' : 'env', 'env.txt');
  const variables = env.split(/\r?\n/).filter((line) => /^[A-Za-z_][A-Za-z0-9_()]*=/.test(line));
  expect(variables.filter((line) => /^[^=]+=$/.test(line))).toEqual([]);
  expect(variables.filter((line) => line.startsWith('GIT_CONFIG_PARAMETERS='))).toHaveLength(1);
  expect(variables.some((line) => /^GIT_CONFIG_(COUNT|KEY_|VALUE_)/.test(line) && !line.startsWith('GIT_CONFIG_COUNT=1') && !/^GIT_CONFIG_(KEY|VALUE)_0=/.test(line))).toBe(false);

  fs.writeFileSync(path.join(dir, 'fill.txt'), `protocol=https\nhost=${run.host}\npath=${REPO}.git\n\n`);
  const filled = await terminalOutput(shell, dir, 'git credential fill < fill.txt', 'filled.txt');
  const password = /^password=(.*)$/m.exec(filled)?.[1];
  expect(/^username=(.*)$/m.exec(filled)?.[1]).toBe('oauth2');
  expect(run.stub.gitlab.tokenLogin(password ?? '')).toBe('alexios-s');

  await commit(home, dir, 'terminal.txt');
  const before = pushes(run).length;
  await terminalOutput(shell, dir, 'git push', 'push.txt');
  await expect.poll(() => remoteHead(run, home), CHECKED).toBe(await git(home, dir, 'rev-parse', 'HEAD'));
  expect(run.stub.gitlab.tokenLogin(pushes(run).slice(before).at(-1)!.credential!)).toBe('alexios-s');
  expect(stubCalls(run)).toEqual([]);

  // delegation: the open terminal's next push asks the user's own helper
  const overlay = await readyOverlay(run.app);
  await clickAccountChip(chip);
  await overlay.getByRole('menu', { name: /^Accounts for / }).getByRole('menuitemradio', { name: /^Use Git's own credentials/ }).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await expect(chip).toHaveAccessibleName(`Accounts: ${GITLAB}, Git's own credentials`, CHECKED);
  await commit(home, dir, 'delegated.txt');
  await terminalOutput(shell, dir, 'git push', 'push2.txt');
  await expect.poll(() => remoteHead(run, home), CHECKED).toBe(await git(home, dir, 'rev-parse', 'HEAD'));
  expect(pushes(run).at(-1)!.credential).toBe(RECORDER_TOKEN);
  expect(stubCalls(run).filter((call) => call.op === 'get').length).toBeGreaterThan(0);
});

test('autofetch with an account it cannot resolve asks the user\'s own helper without a dialog, as before', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchCredentials(launch, home, true);
  // both accounts can push to alexios-s/damocles, so resolution would ask
  await signIn(run, ['alexios-s', 'work-alexios']);
  const dir = await stubProject(run, home, 'damocles');
  const shell = await openScmProject(run.app, dir);
  await expect(scmSection(shell).getByTestId('forge-account-chip')).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`, CHECKED);
  await autofetchNow(run.app);
  await expect.poll(() => stubCalls(run).filter((call) => call.op === 'get').length, CHECKED).toBeGreaterThan(0);
  await expect.poll(async () => /> git fetch/.test(await gitLog(run.app)), CHECKED).toBe(true);
  await expect((await readyOverlay(run.app)).getByRole('alertdialog')).toHaveCount(0);
});

test('an agent shell\'s git: refused while the account\'s switch is off, with no prompt; with it on the fetch works, env shows no token and git credential fill reaches the model as ***', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchCredentials(launch, home);
  await signIn(run, ['alexios-s']);
  await setAgentShells(run.app, 'alexios-s', false);
  const dir = await stubProject(run, home, 'damocles');
  const tab = await openProjectChat(run.app, dir);
  const overlay = await readyOverlay(run.app);

  const served = run.stub.gitlab.counts.gitServed;
  const refused = await agentBash(tab, run.openai, 'git fetch origin', 'fetch while the switch is off');
  expect(refused).toContain('Agent shells may use this account');
  expect(run.stub.gitlab.counts.gitServed).toBe(served);
  await expect(overlay.getByRole('alertdialog')).toHaveCount(0);
  expect(stubCalls(run)).toEqual([]);

  await setAgentShells(run.app, 'alexios-s', true);
  expect(await agentBash(tab, run.openai, 'git fetch origin && echo fetched-ok', 'fetch with the switch on')).toContain('fetched-ok');

  const tokens = run.stub.gitlab.requests.flatMap((request) => (request.credential !== undefined && run.stub.gitlab.isLive(request.credential) ? [request.credential] : []));
  expect(tokens.length).toBeGreaterThan(0);
  const env = await agentBash(tab, run.openai, 'env', 'show the environment');
  expect(env).toContain('GIT_CONFIG_PARAMETERS');
  for (const token of new Set(tokens)) expect(env).not.toContain(token);

  const filled = await agentBash(tab, run.openai, `printf 'protocol=https\\nhost=${run.host}\\npath=${REPO}.git\\n\\n' | git credential fill`, 'fill a credential');
  expect(filled).toContain('password=***');
  for (const token of new Set(run.stub.gitlab.requests.flatMap((request) => (request.credential !== undefined ? [request.credential] : [])))) expect(filled).not.toContain(token);
});

test('erase: a token the server revoked is refreshed; when the refresh is refused too the account shows Sign in again', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchCredentials(launch, home);
  await signIn(run, ['alexios-s']);
  const dir = await stubProject(run, home, 'damocles');
  const shell = await openScmProject(run.app, dir);
  const chip = scmSection(shell).getByTestId('forge-account-chip');
  await expect(chip).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen automatically`, CHECKED);
  await scmPush(run, home, dir);
  const first = pushes(run).at(-1)!.credential!;

  // revoked: git's erase makes core check GET /user, which refuses, so core refreshes; the next push uses the new token
  run.stub.gitlab.revokeTokens('alexios-s');
  const refreshes = run.stub.gitlab.counts.refreshes;
  await commit(home, dir, 'after-revoke.txt');
  await clickMenu(run.app, 'damocles.git.push');
  await expect.poll(() => run.stub.gitlab.counts.refreshes, CHECKED).toBeGreaterThan(refreshes);
  await scmPush(run, home, dir);
  const second = pushes(run).at(-1)!.credential!;
  expect(second).not.toBe(first);
  expect(run.stub.gitlab.tokenLogin(second)).toBe('alexios-s');

  // refused: the refresh token is revoked too
  run.stub.gitlab.revokeTokens('alexios-s', { refresh: true });
  await commit(home, dir, 'after-refresh-refused.txt');
  await clickMenu(run.app, 'damocles.git.push');
  await expect(chip).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, sign in again`, { timeout: 60_000 });
  expect(stubCalls(run)).toEqual([]);
});
