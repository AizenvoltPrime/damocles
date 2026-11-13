import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { deviceSignIn, forgeEnv, inAccounts, launchReady, setAgentShells, startStubOnTestCa } from './support/forge';
import type { ForgeStub } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import type { DesktopApp } from './support/app';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { git, initRepo } from './support/git';
import { call, lastToolResultRequest, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { overlayMenu, readyOverlay } from './support/overlay';
import { recordingCredentialHelper } from './support/recording-credential-helper';
import { clickAccountChip, scmSection, setSection } from './support/scm';
import { openProjectChat } from './support/screenshots';
import { closeSettingsModal } from './support/settings';
import { shellPage } from './support/shell';
import { sendAndAwaitEcho } from './support/ui';

// The refused-git notice: an agent shell's git is refused while the project's account does not allow agent shells, and
// the notice under the shell card replays the first half of the design's agent journey (Choose account, the "Account for
// <server>" menu, an account that allows agent shells, "<project> now uses <login>"). The stub's gitlab.com stands in for
// the design's gitlab.indigital.gr: alexios-s for astefanopoulos, work-alexios for astef-admin.

const GITLAB = 'gitlab.com';
const REPO = 'alexios-s/damocles';
const CHECKED = { timeout: 30_000 };

interface RefusedRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly openai: OpenAIStub;
  readonly gitRoot: string;
}

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function launchRefused(launch: (options?: { env?: Record<string, string> }) => Promise<DesktopApp>, home: HermeticHome): Promise<RefusedRun> {
  const gitRoot = path.join(home.root, 'forge-git');
  fs.mkdirSync(path.join(gitRoot, 'alexios-s'), { recursive: true });
  await git(home, gitRoot, 'init', '--quiet', '--bare', '-b', 'main', path.join(gitRoot, `${REPO}.git`));
  const started = await startStubOnTestCa(home, { gitRoot });
  const { stub, caFile } = started;
  closers.push(() => stub.close());
  const openai = await startOpenAIStub();
  closers.push(() => openai.close());
  seedStubModel(home, openai.baseUrl);
  // the agent's git runs without a permission prompt, so the turn reaches the refusal
  writeUserSettings(home, { permissions: { allow: ['Bash(git:*)', 'Bash(echo:*)'] } });
  // the user's own helper answers nothing for the stub, so a delegation could not pass for the account
  const helper = recordingCredentialHelper(home, { answers: {}, caFile });
  const desktop = await launchReady(launch, { ...forgeEnv(started), GIT_CONFIG_GLOBAL: helper.globalConfig });
  return { app: desktop.app, stub, openai, gitRoot };
}

/** Signs both accounts in by device code and sets each one's "Agent shells may use this account" switch. */
async function signIn(run: RefusedRun, switches: Readonly<Record<string, boolean>>): Promise<void> {
  await inAccounts(run.app, async (overlay) => {
    for (const login of Object.keys(switches)) await deviceSignIn(overlay, GITLAB, run.stub.gitlab, login);
    for (const [login, on] of Object.entries(switches)) await setAgentShells(overlay, GITLAB, login, on);
  });
}

/** A project named damocles on the stub's alexios-s/damocles, opened with its chat; returns the chat page. */
async function damoclesProject(run: RefusedRun, home: HermeticHome): Promise<Page> {
  const dir = path.join(home.root, 'projects', 'damocles');
  await initRepo(home, dir);
  await git(home, dir, 'push', '--quiet', path.join(run.gitRoot, `${REPO}.git`), 'main');
  await git(home, dir, 'remote', 'add', 'origin', `${run.stub.gitlab.webUrl}/${REPO}.git`);
  return openProjectChat(run.app, dir);
}

/** Binds the project to `login` in Source Control's account chip. */
async function bindInChip(app: ElectronApplication, login: string): Promise<void> {
  const shell = await shellPage(app);
  await setSection(shell, 'scm-section', true);
  const chip = scmSection(shell).getByTestId('forge-account-chip');
  await expect(chip).toBeVisible(CHECKED);
  const overlay = await readyOverlay(app);
  await clickAccountChip(chip);
  await overlay.getByRole('menu', { name: /^Accounts for / }).getByRole('menuitemradio', { name: new RegExp(`^${login}`) }).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await expect(chip).toHaveAccessibleName(`Accounts: ${login} on ${GITLAB}, chosen by you`, CHECKED);
}

test('refused-git notice: a refused agent shell shows the notice under its card, and its menu replays the journey\'s first half', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchRefused(launch, home);
  await signIn(run, { 'alexios-s': false, 'work-alexios': true });
  const tab = await damoclesProject(run, home);
  await bindInChip(run.app, 'alexios-s');

  run.openai.replies.push(call('bash', { command: 'git fetch origin' }));
  await sendAndAwaitEcho(tab, 'fetch while the switch is off');
  expect(lastToolResultRequest(run.openai)).toContain('Agent shells may use this account');

  const notice = tab.getByTestId('forge-refused-notice');
  await expect(notice).toBeVisible(CHECKED);
  await expect(notice.getByRole('region', { name: "The agent's git was refused", exact: true })).toBeVisible();
  const message = notice.getByTestId('forge-refused-message');
  await expect(message).toContainText('The account this project uses on gitlab.com,');
  await expect(message).toContainText('alexios-s, does not allow agent shells. Damocles kept its token out of the shell.');
  await expect(notice.getByRole('button', { name: 'Open Git hosting settings', exact: true })).toBeVisible();

  // the journey's first half (S9-agent.journey.json steps 1 to 4)
  await tab.getByRole('button', { name: 'Choose account', exact: true }).click();
  const menu = tab.getByRole('menu', { name: `Account for ${GITLAB}`, exact: true });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio', { name: 'alexios-s, Agent shells not allowed', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: 'alexios-s, Agent shells not allowed', exact: true })).toBeFocused();
  await menu.getByRole('menuitemradio', { name: 'work-alexios, Agent shells allowed', exact: true }).click();
  await expect(tab.getByText('damocles now uses work-alexios', { exact: true })).toBeVisible(CHECKED);
  await expect(menu).toHaveCount(0);
  await expect(tab.getByRole('button', { name: 'Choose account', exact: true })).toBeFocused();

  // the binding is the project's: Source Control's chip follows it, and the agent's next fetch signs in as work-alexios
  await expect(scmSection(await shellPage(run.app)).getByTestId('forge-account-chip')).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen by you`, CHECKED);
  const gitBefore = run.stub.gitlab.requests.length;
  run.openai.replies.push(call('bash', { command: 'git fetch origin && echo fetched-ok' }));
  await sendAndAwaitEcho(tab, 'fetch again');
  expect(lastToolResultRequest(run.openai)).toContain('fetched-ok');
  // git's own requests only; the access check reads the API with every account's token
  const served = run.stub.gitlab.requests.slice(gitBefore).filter((request) => request.path.includes('.git/'));
  const used = served.flatMap((request) => (request.credential !== undefined ? [run.stub.gitlab.tokenLogin(request.credential)] : []));
  expect(used).toContain('work-alexios');
  expect(used).not.toContain('alexios-s');
});

test('refused-git notice: Open Git hosting settings opens the refused account with Manage open', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchRefused(launch, home);
  await signIn(run, { 'alexios-s': false, 'work-alexios': true });
  const tab = await damoclesProject(run, home);
  await bindInChip(run.app, 'alexios-s');
  run.openai.replies.push(call('bash', { command: 'git fetch origin' }));
  await sendAndAwaitEcho(tab, 'fetch while the switch is off');

  const notice = tab.getByTestId('forge-refused-notice');
  await expect(notice).toBeVisible(CHECKED);
  await notice.getByRole('button', { name: 'Open Git hosting settings', exact: true }).click();
  const overlay = await readyOverlay(run.app);
  const line = overlay.getByTestId('forge-account-alexios-s');
  await expect(line.getByTestId('forge-manage')).toBeVisible(CHECKED);
  await expect(line.getByRole('switch', { name: 'Agent shells may use this account' })).toHaveAttribute('aria-checked', 'false');
  await expect(overlay.getByTestId('forge-account-work-alexios').getByTestId('forge-manage')).toHaveCount(0);
  await closeSettingsModal(overlay);
});
