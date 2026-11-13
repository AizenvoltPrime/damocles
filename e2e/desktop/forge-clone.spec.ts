import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn, trustForGit } from './support/forge';
import type { ForgeStub } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import type { DesktopApp, LaunchOptions } from './support/app';
import type { HermeticHome } from './support/hermetic';
import { overlayViewState, readyOverlay } from './support/overlay';
import { bareRepo } from './support/scm';
import { applyUserSettings, setContentSize, settingsModal } from './support/settings';
import { popupPage, shellState } from './support/shell';
import { answerDialogs, answerOpenDialog, askedDialogs, clickMenu, TRUST_PROMPT } from './support/ui';

// The clone picker against the forge stub, whose listings carry the sample repositories. The stub's self-managed GitLab
// stands in for gitlab.indigital.gr and is named 127.0.0.1:<port> in the app, which the journey uses in its place;
// gitlab.com and github.com keep their names. Each of the journey's untested items
// (per-account loading, the error row with Try again, no results with Clear, paste, empty) has a test of its own.

const TOKENS = {
  indigital: 'glpat-stubIndigitalAstefApi00006',
  gitlab: 'glpat-stubAlexiosSApi000000008',
  github: 'ghp_stubAstefanopoulosRepo0000000001',
} as const;
type Account = keyof typeof TOKENS;

interface CloneRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  // the self-managed server's name in the app: its host, 127.0.0.1:<port>
  readonly indigital: string;
  readonly gitRoot: string;
}

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

/** The app with the stub's servers and the accounts named signed in by token, at width × 900. */
async function launchClone(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome, accounts: readonly Account[], width = 1280): Promise<CloneRun> {
  const gitRoot = path.join(home.root, 'served');
  const started = await startStubOnTestCa(home, { gitRoot });
  const { stub } = started;
  stubs.push(stub);
  trustForGit(home, started.caFile);
  const { app } = await launchReady(launch, forgeEnv(started));
  await setContentSize(app, width, 900);
  const indigital = new URL(stub.indigital.webUrl).host;
  if (accounts.length > 0) {
    await inAccounts(app, async (overlay) => {
      if (accounts.includes('indigital')) {
        await addGitlabServer(overlay, stub.indigital);
        await tokenSignIn(overlay, indigital, TOKENS.indigital, 'astefanopoulos');
      }
      if (accounts.includes('gitlab')) await tokenSignIn(overlay, 'gitlab.com', TOKENS.gitlab, 'alexios-s');
      if (accounts.includes('github')) await tokenSignIn(overlay, 'github.com', TOKENS.github, 'astefanopoulos');
    });
  }
  return { app, stub, indigital, gitRoot };
}

/** Git: Clone from Your Repositories... from the File menu; returns the overlay that draws the picker. */
async function openPicker(app: ElectronApplication): Promise<Page> {
  const overlay = await readyOverlay(app);
  await clickMenu(app, 'damocles.git.cloneFromAccount');
  await expect(picker(overlay)).toBeVisible();
  return overlay;
}

const picker = (overlay: Page): Locator => overlay.getByRole('dialog', { name: 'Clone a repository', exact: true });
const combobox = (overlay: Page): Locator => overlay.getByRole('combobox', { name: 'Repository', exact: true });
const option = (overlay: Page, name: string): Locator => overlay.getByRole('option', { name, exact: true });

/** The folder picker answers canceled: the clone stops there, after the status. */
async function cancelFolderPicker(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = (() => Promise.resolve({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
  });
}

// the clone picker's journey, at the window's 900 px minimum in place of the design's 768, and at 1280
for (const width of [900, 1280]) {
  test(`clone picker journey at ${width} px`, async ({ home, launch }) => {
    test.setTimeout(240_000);
    const run = await launchClone(launch, home, ['indigital', 'gitlab', 'github'], width);
    await cancelFolderPicker(run.app);
    const overlay = await openPicker(run.app);
    await expect(overlay.getByText('Repositories from your 3 accounts. The clone uses the account it was listed under.', { exact: true })).toBeVisible();
    await expect(combobox(overlay)).toHaveAttribute('placeholder', 'Search your repositories, or paste a URL');

    await expect(option(overlay, `grp/damocles, private, astefanopoulos on ${run.indigital}`)).toBeVisible({ timeout: 30_000 });
    await combobox(overlay).fill('intra');
    await expect(option(overlay, `grp/platform/intranet, internal, astefanopoulos on ${run.indigital}`)).toBeVisible({ timeout: 30_000 });
    await combobox(overlay).press('Enter');
    const popup = await popupPage(run.app, 30_000);
    await expect(popup.getByText(`Cloning grp/platform/intranet as astefanopoulos on ${run.indigital}. Choose a folder next; the new project uses this account.`, { exact: true })).toBeVisible();
    await expect(picker(overlay)).toHaveCount(0);
  });
}

test('a private clone needs no prompt: the picker\'s row clones with its account, and the new project is bound to it', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchClone(launch, home, ['indigital']);
  await bareRepo(home, path.join(run.gitRoot, 'grp'), 'damocles', { 'README.md': '# damocles\n' });
  const clones = path.join(home.root, 'clones');
  fs.mkdirSync(clones);
  await applyUserSettings(run.app, home, { 'damocles.desktop.git.openAfterClone': 'always' });
  await answerOpenDialog(run.app, clones);
  // adding the clone asks for trust, as any added project does; the binding follows the add
  await answerDialogs(run.app, { [TRUST_PROMPT]: 'Trust Folder' });

  const overlay = await openPicker(run.app);
  await option(overlay, `grp/damocles, private, astefanopoulos on ${run.indigital}`).click();
  const cloned = path.join(clones, 'damocles');
  await expect.poll(async () => (await shellState(run.app)).projects.some((project) => project.fsPath === cloned), { timeout: 60_000 }).toBe(true);
  expect(fs.readFileSync(path.join(cloned, 'README.md'), 'utf8')).toBe('# damocles\n');
  // the account answered git: no password prompt, no ask-once dialog
  const asked = await askedDialogs(run.app);
  expect(asked.filter((dialog) => /account should|password|username/i.test(dialog.message))).toEqual([]);
  // the clone joined untrusted, so adding it asked for trust
  expect(asked.filter((dialog) => dialog.message.startsWith(TRUST_PROMPT)).map((dialog) => dialog.answered)).toEqual(['Trust Folder']);
  await expect(overlay.getByTestId('secret-prompt')).toHaveCount(0);
  expect(run.stub.indigital.counts.gitServed).toBeGreaterThan(0);

  // core writes the binding once the project is added; astefanopoulos is user 32 on the self-managed server
  const boundAccounts = (): Array<string | null> => {
    const file = path.join(home.userData, 'forge', 'bindings.json');
    if (!fs.existsSync(file)) return [];
    const bindings = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects: Record<string, Record<string, { account: string | null }>> };
    return Object.entries(bindings.projects).filter(([key]) => key.toLowerCase().endsWith('damocles')).flatMap(([, servers]) => Object.values(servers).map((binding) => binding.account));
  };
  await expect.poll(boundAccounts, { timeout: 30_000 }).toEqual([expect.stringMatching(/\|32$/)]);
});

test('each account\'s section loads on its own: gitlab.com searches while the other section lists', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchClone(launch, home, ['indigital', 'gitlab']);
  run.stub.gitlab.listingDelayMs = 6000;
  const overlay = await openPicker(run.app);
  await expect(option(overlay, `grp/damocles, private, astefanopoulos on ${run.indigital}`)).toBeVisible({ timeout: 30_000 });
  const searching = overlay.getByTestId('clone-picker-loading');
  await expect(searching).toHaveText('Searching gitlab.com…');
  await expect(overlay.getByTestId('clone-picker-busy')).toBeVisible();
  await expect(option(overlay, 'alexios-s/personal-site, public, alexios-s on gitlab.com')).toBeVisible({ timeout: 30_000 });
  await expect(searching).toHaveCount(0);
  await expect(overlay.getByTestId('clone-picker-busy')).toHaveCount(0);
});

test('a server that does not answer shows its error row in its own section, and Try again asks only that server again', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchClone(launch, home, ['indigital', 'gitlab']);
  run.stub.gitlab.unreachable = true;
  const overlay = await openPicker(run.app);
  const retry = option(overlay, 'gitlab.com did not answer. Try again');
  await expect(retry).toBeVisible({ timeout: 30_000 });
  await expect(overlay.getByRole('group', { name: 'alexios-s on gitlab.com', exact: true }).getByRole('option')).toHaveCount(1);
  await expect(option(overlay, `grp/damocles, private, astefanopoulos on ${run.indigital}`)).toBeVisible();

  run.stub.gitlab.unreachable = false;
  const indigitalListings = run.stub.indigital.projectListings.length;
  await retry.click();
  await expect(option(overlay, 'alexios-s/personal-site, public, alexios-s on gitlab.com')).toBeVisible({ timeout: 30_000 });
  await expect(retry).toHaveCount(0);
  expect(run.stub.indigital.projectListings.length).toBe(indigitalListings);
  await expect(combobox(overlay)).toBeFocused();
});

test('no repository matching says so in every account, and Clear the search lists them again', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchClone(launch, home, ['indigital', 'gitlab']);
  const overlay = await openPicker(run.app);
  await expect(option(overlay, `grp/damocles, private, astefanopoulos on ${run.indigital}`)).toBeVisible({ timeout: 30_000 });
  await combobox(overlay).fill('zzzz');
  // the polite status says it too, so the visible message is found in its block
  await expect(overlay.getByTestId('clone-picker-no-results').getByText('No repository matched "zzzz" in your 2 accounts.', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(overlay.getByRole('option')).toHaveCount(0);
  await overlay.getByRole('button', { name: 'Clear the search', exact: true }).click();
  await expect(combobox(overlay)).toHaveValue('');
  await expect(combobox(overlay)).toBeFocused();
  await expect(option(overlay, `grp/damocles, private, astefanopoulos on ${run.indigital}`)).toBeVisible({ timeout: 30_000 });
});

test('a pasted URL becomes one Clone from URL row, which Enter clones with the server\'s account', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchClone(launch, home, ['indigital']);
  await cancelFolderPicker(run.app);
  const overlay = await openPicker(run.app);
  await combobox(overlay).fill(`${run.stub.indigital.webUrl}/grp/platform/intranet.git`);
  await expect(overlay.getByRole('option')).toHaveCount(1, { timeout: 30_000 });
  await expect(overlay.getByRole('option')).toHaveAccessibleName(`Clone from URL, ${run.indigital}/grp/platform/intranet.git, as astefanopoulos on ${run.indigital}`);
  await combobox(overlay).press('Enter');
  const popup = await popupPage(run.app, 30_000);
  await expect(popup.getByText(`Cloning grp/platform/intranet as astefanopoulos on ${run.indigital}. Choose a folder next; the new project uses this account.`, { exact: true })).toBeVisible();
  await expect(picker(overlay)).toHaveCount(0);
});

test('with no account the picker says why, still takes a pasted URL, and Open Git hosting settings opens them', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchClone(launch, home, []);
  const overlay = await openPicker(run.app);
  await expect(overlay.getByText('No GitHub or GitLab account yet.', { exact: true })).toBeVisible();
  await expect(overlay.getByRole('option')).toHaveCount(0);
  await combobox(overlay).fill('https://example.org/me/tool.git');
  await expect(overlay.getByRole('option')).toHaveCount(1, { timeout: 30_000 });
  await expect(overlay.getByText('No GitHub or GitLab account yet.', { exact: true })).toHaveCount(0);
  await combobox(overlay).fill('');
  await overlay.getByRole('button', { name: 'Open Git hosting settings', exact: true }).click();
  await expect(picker(overlay)).toHaveCount(0);
  await expect(settingsModal(overlay)).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => (await overlayViewState(run.app)).visible).toBe(true);
});
