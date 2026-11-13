import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn, trustForGit } from './support/forge';
import type { ForgeStub } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import { coreLog, type DesktopApp, type LaunchOptions } from './support/app';
import { git } from './support/git';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { readyOverlay } from './support/overlay';
import { bareRepo, commitMessage, gitLog, openScmProject, quickInput, scmSection } from './support/scm';
import { setContentSize } from './support/settings';
import { recordedToasts, recordToasts } from './support/shell';
import { clickMenu } from './support/ui';
import { openedExternally, recordOpenExternal } from './support/updates';

// GitHub and GitLab accounts: publish and fork on a denied push and the server's branch protection, against
// the forge stub, whose namespaces carry the design's sample data. The stub's self-managed GitLab stands in for gitlab.indigital.gr and is named
// 127.0.0.1:<port> in the app; gitlab.com and github.com keep their names. Each of the journey's untested items (the fork state
// end to end, upstream-exists, a refused name) has a test of its own.

const TOKENS = {
  indigital: 'glpat-stubIndigitalAstefApi00006',
  gitlab: 'glpat-stubAlexiosSApi000000008',
  github: 'ghp_stubAstefanopoulosRepo0000000001',
} as const;
type Account = keyof typeof TOKENS;

interface PublishRun {
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
async function launchForge(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome, accounts: readonly Account[], width = 1280): Promise<PublishRun> {
  const gitRoot = path.join(home.root, 'served');
  fs.mkdirSync(gitRoot, { recursive: true });
  const started = await startStubOnTestCa(home, { gitRoot });
  const { stub } = started;
  stubs.push(stub);
  trustForGit(home, started.caFile);
  const { app } = await launchReady(launch, forgeEnv(started));
  await setContentSize(app, width, 900);
  const indigital = new URL(stub.indigital.webUrl).host;
  await inAccounts(app, async (overlay) => {
    if (accounts.includes('indigital')) await tokenSignIn(overlay, await addGitlabServer(overlay, stub.indigital), TOKENS.indigital, 'astefanopoulos');
    if (accounts.includes('gitlab')) await tokenSignIn(overlay, 'gitlab.com', TOKENS.gitlab, 'alexios-s');
    if (accounts.includes('github')) await tokenSignIn(overlay, 'github.com', TOKENS.github, 'astefanopoulos');
  });
  return { app, stub, indigital, gitRoot };
}

/** A local repository `<root>/projects/damocles` with one commit on main and no remote, opened in Source control. */
async function unpublishedProject(run: PublishRun, home: HermeticHome): Promise<string> {
  const dir = path.join(home.root, 'projects', 'damocles');
  fs.mkdirSync(dir, { recursive: true });
  await git(home, dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'README.md'), '# damocles\n');
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '-m', 'Initial commit');
  await openScmProject(run.app, dir);
  return dir;
}

/** Publish Branch... on the selected project; with an account and no remote it opens the Publish dialog. */
async function openPublish(app: ElectronApplication): Promise<Page> {
  const overlay = await readyOverlay(app);
  await clickMenu(app, 'damocles.git.publish');
  await expect(publishDialog(overlay)).toBeVisible({ timeout: 30_000 });
  return overlay;
}

const publishDialog = (overlay: Page): Locator => overlay.getByRole('dialog', { name: 'Publish damocles', exact: true });
const forkAsk = (overlay: Page, repoPath: string): Locator => overlay.getByRole('alertdialog', { name: `You can't push to ${repoPath}` });
const servedHead = (home: HermeticHome, gitRoot: string, repoPath: string, branch: string): Promise<string> => git(home, path.join(gitRoot, ...`${repoPath}.git`.split('/')), 'rev-parse', `refs/heads/${branch}`);

/** The accounts bindings.json binds the damocles project to. */
function boundAccounts(home: HermeticHome): Array<string | null> {
  const file = path.join(home.userData, 'forge', 'bindings.json');
  if (!fs.existsSync(file)) return [];
  const bindings = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects: Record<string, Record<string, { account: string | null }>> };
  return Object.entries(bindings.projects).filter(([key]) => key.toLowerCase().endsWith('damocles')).flatMap(([, servers]) => Object.values(servers).map((binding) => binding.account));
}

/** Publishes from the open dialog: owner, name typed as the user types it, visibility; resolves once the done status shows. */
async function publish(overlay: Page, owner: string, name: string, visibility: 'Private' | 'Internal' | 'Public', done: string): Promise<void> {
  await overlay.getByLabel('Owner', { exact: true }).selectOption(owner);
  await overlay.getByLabel('Name', { exact: true }).fill(name);
  await overlay.getByRole('radio', { name: visibility, exact: true }).click();
  await overlay.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(overlay.getByText(done, { exact: true })).toBeVisible({ timeout: 60_000 });
}

// the design's publish and fork journey, at the window's 900 px minimum in place of the design's 768, and at 1280
for (const width of [900, 1280]) {
  test(`publish and fork journey at ${width} px`, async ({ home, launch }) => {
    test.setTimeout(300_000);
    const run = await launchForge(launch, home, ['indigital', 'gitlab', 'github'], width);
    const dir = await unpublishedProject(run, home);
    const overlay = await openPublish(run.app);

    await expect(overlay.getByRole('dialog', { name: 'Publish damocles', exact: true })).toBeVisible();
    await overlay.getByLabel('Owner', { exact: true }).selectOption('gitlab.com|alexios-s|personal');
    await expect(overlay.getByText('Your own namespace on gitlab.com.', { exact: true })).toBeVisible();
    await overlay.getByLabel('Name', { exact: true }).fill('damocles fork');
    await expect(overlay.getByLabel('Name', { exact: true })).toHaveValue('damocles-fork');
    await overlay.getByRole('radio', { name: 'Public', exact: true }).click();
    await expect(overlay.getByRole('radio', { name: 'Public', exact: true })).toBeVisible();
    await overlay.getByRole('button', { name: 'Publish', exact: true }).click();
    await expect(overlay.getByText('Published gitlab.com/alexios-s/damocles-fork. This project now uses alexios-s on gitlab.com.', { exact: true })).toBeVisible({ timeout: 60_000 });

    // the repository exists on the server as asked, origin points at it, main is there, and the project uses alexios-s
    expect(run.stub.gitlab.created).toEqual([expect.objectContaining({ path: 'alexios-s/damocles-fork', login: 'alexios-s', visibility: 'public' })]);
    expect(await servedHead(home, run.gitRoot, 'alexios-s/damocles-fork', 'main')).toBe(await git(home, dir, 'rev-parse', 'HEAD'));
    expect(await git(home, dir, 'remote', 'get-url', 'origin')).toBe(`${run.stub.gitlab.webUrl}/alexios-s/damocles-fork.git`);
    expect(await git(home, dir, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe('origin/main');
    await expect.poll(() => boundAccounts(home)).toEqual(['gitlab.com|2001']);
    await overlay.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(publishDialog(overlay)).toHaveCount(0);
  });
}

test('publish to a GitHub organization: the org owner, Internal not offered, created in damocles-app and pushed', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['github']);
  const dir = await unpublishedProject(run, home);
  const overlay = await openPublish(run.app);
  await overlay.getByLabel('Owner', { exact: true }).selectOption('github.com|astefanopoulos|damocles-app');
  await expect(overlay.getByText('Organizations astefanopoulos belongs to on github.com.', { exact: true })).toBeVisible();
  await expect(overlay.getByRole('radio')).toHaveText(['Private', 'Public']);
  await publish(overlay, 'github.com|astefanopoulos|damocles-app', 'site', 'Private', 'Published github.com/damocles-app/site. This project now uses astefanopoulos on github.com.');
  expect(run.stub.github.created).toEqual([expect.objectContaining({ path: 'damocles-app/site', login: 'astefanopoulos', visibility: 'private' })]);
  expect(await servedHead(home, run.gitRoot, 'damocles-app/site', 'main')).toBe(await git(home, dir, 'rev-parse', 'HEAD'));
});

test('publish to a nested GitLab group: grp/platform on the self-managed server, Internal offered and sent', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['indigital']);
  const dir = await unpublishedProject(run, home);
  const overlay = await openPublish(run.app);
  const owner = `${run.indigital}|astefanopoulos|grp/platform`;
  await overlay.getByLabel('Owner', { exact: true }).selectOption(owner);
  await expect(overlay.getByText('Groups where astefanopoulos can create projects.', { exact: true })).toBeVisible();
  await expect(overlay.getByTestId('forge-publish-prefix')).toHaveText(`${run.indigital}/grp/platform/`);
  await publish(overlay, owner, 'tools', 'Internal', `Published ${run.indigital}/grp/platform/tools. This project now uses astefanopoulos on ${run.indigital}.`);
  expect(run.stub.indigital.created).toEqual([expect.objectContaining({ path: 'grp/platform/tools', login: 'astefanopoulos', visibility: 'internal' })]);
  expect(await servedHead(home, run.gitRoot, 'grp/platform/tools', 'main')).toBe(await git(home, dir, 'rev-parse', 'HEAD'));
});

test('a name the server refuses shakes the field and shows its reason; another name then publishes', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['indigital']);
  await unpublishedProject(run, home);
  const overlay = await openPublish(run.app);
  await overlay.getByLabel('Owner', { exact: true }).selectOption(`${run.indigital}|astefanopoulos|grp`);
  await expect(overlay.getByLabel('Name', { exact: true })).toHaveValue('damocles');
  await overlay.getByRole('button', { name: 'Publish', exact: true }).click();
  const refusal = overlay.getByRole('alert').filter({ hasText: 'has already been taken' });
  await expect(refusal).toHaveText(`${run.indigital} refused: name has already been taken; path has already been taken`, { timeout: 60_000 });
  const name = overlay.getByLabel('Name', { exact: true });
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(name).toHaveAccessibleDescription(`${run.indigital} refused: name has already been taken; path has already been taken`);
  await expect(name).toBeFocused();
  await expect(overlay.getByTestId('forge-publish-name-box')).toHaveAttribute('data-invalid', '');
  expect(run.stub.indigital.created).toEqual([]);

  await name.fill('damocles-desktop');
  await expect(refusal).toHaveCount(0);
  await overlay.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(overlay.getByText(`Published ${run.indigital}/grp/damocles-desktop. This project now uses astefanopoulos on ${run.indigital}.`, { exact: true })).toBeVisible({ timeout: 60_000 });
});

/**
 * grp/damocles on the self-managed server, which astefanopoulos reads but cannot push to, served from a bare repository; the
 * project is a clone of it on a new branch with GitLab's merge request template, opened in Source control.
 */
async function deniedProject(run: PublishRun, home: HermeticHome, extraRemotes: Record<string, string> = {}): Promise<string> {
  run.stub.indigital.enforcePushAccess = true;
  const upstream = await bareRepo(home, path.join(run.gitRoot, 'grp'), 'damocles', { 'README.md': '# damocles\n' });
  const dir = path.join(home.root, 'projects', 'damocles');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(home, path.dirname(dir), 'clone', '--quiet', upstream, dir);
  await git(home, dir, 'remote', 'set-url', 'origin', `${run.stub.indigital.webUrl}/grp/damocles.git`);
  for (const [name, url] of Object.entries(extraRemotes)) await git(home, dir, 'remote', 'add', name, url);
  await git(home, dir, 'checkout', '-b', 'fix/token-refresh');
  fs.mkdirSync(path.join(dir, '.gitlab', 'merge_request_templates'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitlab', 'merge_request_templates', 'Default.md'), '## What does this change?\n');
  fs.writeFileSync(path.join(dir, 'token.ts'), 'export const refresh = true;\n');
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '-m', 'Refresh the token');
  await openScmProject(run.app, dir);
  return dir;
}

/** Publish Branch... pushes the new branch to origin, which the server refuses; resolves the fork question. */
async function pushDenied(run: PublishRun, { pickOrigin = false } = {}): Promise<Locator> {
  const overlay = await readyOverlay(run.app);
  await clickMenu(run.app, 'damocles.git.publish');
  // with a second remote, Publish Branch... asks which one first
  if (pickOrigin) await overlay.getByRole('option', { name: /^origin, / }).click();
  const ask = forkAsk(overlay, 'grp/damocles');
  await expect(ask).toBeVisible({ timeout: 60_000 });
  return ask;
}

const remotesOf = async (home: HermeticHome, dir: string): Promise<string[]> => (await git(home, dir, 'remote', '-v')).split('\n').filter((line) => line.endsWith('(push)')).map((line) => line.replace(/\s+\(push\)$/, '').replace(/\s+/, ' '));

test('fork state end to end: a denied push forks, re-points the remotes, pushes, and Open Merge Request opens the create page with the branch', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['indigital']);
  run.stub.indigital.forkPolls = 3;
  const dir = await deniedProject(run, home);
  await recordOpenExternal(run.app);
  const ask = await pushDenied(run);
  const overlay = await readyOverlay(run.app);
  // the project query says the account cannot push, so no protection rules are listed and the fork is offered, not the new-branch question
  expect(run.stub.indigital.accessChecks).toContain('grp/damocles');
  expect(run.stub.indigital.requests.some((request) => request.path === '/api/v4/projects/grp%2Fdamocles/protected_branches')).toBe(false);
  await expect(overlay.getByRole('alertdialog', { name: /is protected on/ })).toHaveCount(0);
  await expect(ask).toContainText(`astefanopoulos can read grp/damocles on ${run.indigital} but not push to it. Fork it to astefanopoulos, push fix/token-refresh there, then open a merge request.`);
  await expect(ask.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
  await ask.getByRole('button', { name: 'Fork and Push', exact: true }).click();

  const progress = overlay.getByRole('dialog', { name: 'Forking grp/damocles', exact: true });
  await expect(progress.getByText(`Waiting for ${run.indigital} to copy the repository`, { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(progress.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();

  const done = overlay.getByRole('dialog', { name: 'Pushed to your fork', exact: true });
  await expect(done).toBeVisible({ timeout: 90_000 });
  const remotes = done.getByRole('definition');
  await expect(done.getByRole('term')).toHaveText(['origin', 'upstream']);
  await expect(remotes).toHaveText([`${run.indigital}/astefanopoulos/damocles`, `${run.indigital}/grp/damocles`]);
  expect(await remotesOf(home, dir)).toEqual([`origin ${run.stub.indigital.webUrl}/astefanopoulos/damocles.git`, `upstream ${run.stub.indigital.webUrl}/grp/damocles.git`]);
  expect(run.stub.indigital.created).toEqual([expect.objectContaining({ path: 'astefanopoulos/damocles', login: 'astefanopoulos', forkOf: 'grp/damocles' })]);
  expect(await servedHead(home, run.gitRoot, 'astefanopoulos/damocles', 'fix/token-refresh')).toBe(await git(home, dir, 'rev-parse', 'HEAD'));
  await expect.poll(() => git(home, dir, 'rev-parse', '--abbrev-ref', 'fix/token-refresh@{upstream}')).toBe('origin/fix/token-refresh');

  const open = done.getByRole('button', { name: 'Open Merge Request', exact: true });
  await expect(open).toBeFocused();
  await open.click();
  await expect(done).toHaveCount(0);
  await expect.poll(() => openedExternally(run.app)).toHaveLength(1);
  const [opened] = await openedExternally(run.app);
  const url = new URL(opened!);
  expect(`${url.origin}${url.pathname}`).toBe(`${run.stub.indigital.webUrl}/astefanopoulos/damocles/-/merge_requests/new`);
  expect(url.searchParams.get('merge_request[source_branch]')).toBe('fix/token-refresh');
  expect(url.searchParams.get('merge_request[description]')).toBe('## What does this change?\n');
});

test('upstream-exists: the note names upstream-2, which the original becomes while the existing upstream stays', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['indigital']);
  const theirs = `${run.stub.indigital.webUrl}/grp/platform/intranet.git`;
  const dir = await deniedProject(run, home, { upstream: theirs });
  const ask = await pushDenied(run, { pickOrigin: true });
  const overlay = await readyOverlay(run.app);
  await expect(ask.getByText('This repository already has a remote named upstream. Damocles names the original upstream-2 and leaves yours as it is.', { exact: true })).toBeVisible();
  await ask.getByRole('button', { name: 'Fork and Push', exact: true }).click();
  const progress = overlay.getByRole('dialog', { name: 'Forking grp/damocles', exact: true });
  await expect(progress.locator('[data-testid="flow-step"][data-step="rename"]')).toContainText('Rename origin to upstream-2', { timeout: 30_000 });
  const done = overlay.getByRole('dialog', { name: 'Pushed to your fork', exact: true });
  await expect(done).toBeVisible({ timeout: 90_000 });
  await expect(done.getByRole('term')).toHaveText(['origin', 'upstream-2']);
  expect(await remotesOf(home, dir)).toEqual([
    `origin ${run.stub.indigital.webUrl}/astefanopoulos/damocles.git`,
    `upstream ${theirs}`,
    `upstream-2 ${run.stub.indigital.webUrl}/grp/damocles.git`,
  ]);
});

test('Cancel while the server copies the repository leaves the remotes as they were', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['indigital']);
  run.stub.indigital.forkPolls = 20;
  const dir = await deniedProject(run, home);
  await recordToasts(run.app);
  const before = await remotesOf(home, dir);
  const ask = await pushDenied(run);
  const overlay = await readyOverlay(run.app);
  await ask.getByRole('button', { name: 'Fork and Push', exact: true }).click();
  const progress = overlay.getByRole('dialog', { name: 'Forking grp/damocles', exact: true });
  await expect(progress.getByText(`Waiting for ${run.indigital} to copy the repository`, { exact: true })).toBeVisible({ timeout: 30_000 });
  const cancel = progress.getByRole('button', { name: 'Cancel', exact: true });
  await expect(cancel).toBeFocused();
  await cancel.click();
  await expect(progress).toHaveCount(0);
  await expect.poll(async () => (await recordedToasts(run.app)).map((toast) => toast.message)).toContain('Fork canceled. Nothing changed on your remotes.');
  expect(await remotesOf(home, dir)).toEqual(before);
});

test('a fork the server fails shows the failure box under the fork step and leaves the remotes as they were', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['indigital']);
  run.stub.indigital.failFork = true;
  const dir = await deniedProject(run, home);
  const before = await remotesOf(home, dir);
  const ask = await pushDenied(run);
  const overlay = await readyOverlay(run.app);
  await ask.getByRole('button', { name: 'Fork and Push', exact: true }).click();
  const progress = overlay.getByRole('dialog', { name: 'Forking grp/damocles', exact: true });
  await expect(progress.locator('[data-testid="flow-step"][data-step="fork"]').getByRole('alert')).toHaveText(`${run.indigital} could not complete the request (HTTP 500).`, { timeout: 30_000 });
  await expect(progress.getByText('Nothing changed on your remotes.', { exact: true })).toBeVisible();
  await expect(progress.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  expect(await remotesOf(home, dir)).toEqual(before);
});

test('a push rejected as non-fast-forward does not offer a fork', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['gitlab']);
  run.stub.gitlab.enforcePushAccess = true;
  const upstream = await bareRepo(home, path.join(run.gitRoot, 'alexios-s'), 'damocles', { 'README.md': '# damocles\n' });
  const dir = path.join(home.root, 'projects', 'damocles');
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(home, path.dirname(dir), 'clone', '--quiet', upstream, dir);
  await git(home, dir, 'remote', 'set-url', 'origin', `${run.stub.gitlab.webUrl}/alexios-s/damocles.git`);
  // someone else pushed first: the served main has a commit this clone lacks
  const other = path.join(home.root, 'other');
  await git(home, home.root, 'clone', '--quiet', upstream, other);
  fs.writeFileSync(path.join(other, 'theirs.ts'), 'export const theirs = 1;\n');
  await git(home, other, 'add', '-A');
  await git(home, other, 'commit', '-m', 'Theirs');
  await git(home, other, 'push', '--quiet', 'origin', 'main');
  fs.writeFileSync(path.join(dir, 'mine.ts'), 'export const mine = 1;\n');
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '-m', 'Mine');
  await openScmProject(run.app, dir);
  await recordToasts(run.app);
  const overlay = await readyOverlay(run.app);
  // the server's access check: the account chip's answer is kept for an hour, so a later one would be the push's
  const accessChecks = (): number => run.stub.gitlab.accessChecks.filter((project) => project === 'alexios-s/damocles').length;
  await expect.poll(accessChecks, { timeout: 30_000 }).toBeGreaterThan(0);
  const checksBefore = accessChecks();

  await clickMenu(run.app, 'damocles.git.push');
  await expect.poll(async () => (await gitLog(run.app)).split('\n').some((line) => line.startsWith('> git push')), { timeout: 60_000 }).toBe(true);
  // today's push error notice, git's own words
  await expect.poll(async () => (await recordedToasts(run.app)).some((toast) => /failed to push some refs/.test(toast.message)), { timeout: 60_000 }).toBe(true);
  await expect(overlay.getByRole('alertdialog', { name: /You can't push to/ })).toHaveCount(0);
  expect(accessChecks()).toBe(checksBefore);
  expect(run.stub.gitlab.created).toEqual([]);
  // the served main still holds their commit, not ours
  expect(await servedHead(home, run.gitRoot, 'alexios-s/damocles', 'main')).toBe(await git(home, other, 'rev-parse', 'HEAD'));
});

// Branch protection from the server: the rules core reads through the account feed the existing protected-branch question.
const protectedAsk = (overlay: Page): Locator => overlay.getByRole('alertdialog', { name: /You are trying to commit to a protected branch/ });
const protectedPushAsk = (overlay: Page, server: string): Locator => overlay.getByRole('alertdialog', { name: `Warning main is protected on ${server}`, exact: true });

/** A clone of `alexios-s/<name>` on the stub's gitlab.com, on main tracking origin/main, opened in Source control. */
async function protectedClone(run: PublishRun, home: HermeticHome, name: string): Promise<{ dir: string; shell: Page }> {
  run.stub.gitlab.projectAccess.set(`alexios-s/${name}`, new Map([['alexios-s', 50]]));
  // "No one" may push to main: changes reach it only through merge requests
  run.stub.gitlab.protection.set(`alexios-s/${name}`, { protectedBranches: [{ name: 'main', push: [{ access_level: 0 }] }] });
  const upstream = await bareRepo(home, path.join(run.gitRoot, 'alexios-s'), name, { 'README.md': `# ${name}\n` });
  const dir = path.join(home.root, 'projects', name);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  await git(home, path.dirname(dir), 'clone', '--quiet', upstream, dir);
  await git(home, dir, 'remote', 'set-url', 'origin', `${run.stub.gitlab.webUrl}/alexios-s/${name}.git`);
  await git(home, dir, 'config', 'user.name', 'Alexios S.');
  await git(home, dir, 'config', 'user.email', 'alexios-s@damocles.invalid');
  const shell = await openScmProject(run.app, dir);
  return { dir, shell };
}

const protectionReads = (run: PublishRun, name: string): number => run.stub.gitlab.requests.filter((request) => request.path === `/api/v4/projects/alexios-s%2F${name}/protected_branches`).length;

/** Stages an edit of README.md with the git CLI and commits it from the commit box. */
async function commitReadme(shell: Page, home: HermeticHome, dir: string, message: string): Promise<void> {
  fs.appendFileSync(path.join(dir, 'README.md'), `${message}\n`);
  await git(home, dir, 'add', 'README.md');
  await expect(scmSection(shell).locator('[data-testid="scm-change"][data-group="index"][data-path="README.md"]')).toBeVisible({ timeout: 30_000 });
  await commitMessage(shell).fill(message);
  await scmSection(shell).getByTestId('scm-commit').click();
}

test('server branch protection: a commit to the protected main asks, Commit to a New Branch creates the branch, and a server that does not answer never holds a commit', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['gitlab']);
  const { dir, shell } = await protectedClone(run, home, 'damocles');
  // core reads the rules in the background once the repository opens, before any commit
  await expect.poll(() => protectionReads(run, 'damocles'), { timeout: 30_000 }).toBe(1);
  // the commit asks from core's memory, so the rules are stored before it
  await expect.poll(() => coreLog(home).includes('[forge] read the branch protection of a repository on gitlab.com'), { timeout: 30_000 }).toBe(true);

  const mainBefore = await git(home, dir, 'rev-parse', 'main');
  await commitReadme(shell, home, dir, 'Protected change');
  const overlay = await readyOverlay(run.app);
  const ask = protectedAsk(overlay);
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await expect(ask.getByRole('button', { name: 'Commit Anyway', exact: true })).toBeVisible();
  await ask.getByRole('button', { name: 'Commit to a New Branch', exact: true }).click();
  await expect(quickInput(overlay)).toBeVisible();
  await overlay.getByTestId('quick-input-field').fill('docs/readme');
  await overlay.keyboard.press('Enter');
  await expect(quickInput(overlay)).toHaveCount(0);
  await expect.poll(() => git(home, dir, 'branch', '--show-current')).toBe('docs/readme');
  await expect.poll(() => git(home, dir, 'log', '-1', '--format=%s')).toBe('Protected change');
  expect(await git(home, dir, 'rev-parse', 'main')).toBe(mainBefore);
  // the commit read the rules from memory: still the one read of the opening
  expect(protectionReads(run, 'damocles')).toBe(1);

  // Commit Anyway commits on main; the server refuses its push, and the protected-branch question asks, never the fork's
  run.stub.gitlab.enforcePushAccess = true;
  await recordToasts(run.app);
  await git(home, dir, 'checkout', '--quiet', 'main');
  await commitReadme(shell, home, dir, 'Straight to main');
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await ask.getByRole('button', { name: 'Commit Anyway', exact: true }).click();
  await expect.poll(() => git(home, dir, 'log', '-1', '--format=%s', 'main')).toBe('Straight to main');
  const committed = await git(home, dir, 'rev-parse', 'main');
  await clickMenu(run.app, 'damocles.git.push');
  const pushAsk = protectedPushAsk(overlay, 'gitlab.com');
  await expect(pushAsk).toBeVisible({ timeout: 60_000 });
  await expect(overlay.getByRole('alertdialog', { name: /You can't push to/ })).toHaveCount(0);
  await pushAsk.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(pushAsk).toHaveCount(0);
  await expect.poll(async () => (await recordedToasts(run.app)).map((toast) => toast.message)).toContain('Push not sent. Your commits are still on main.');
  expect(await servedHead(home, run.gitRoot, 'alexios-s/damocles', 'main')).toBe(mainBefore);
  expect(await git(home, dir, 'rev-parse', 'main')).toBe(committed);

  // a server that takes two minutes to answer: core's read of a newly opened repository hangs, and its commit goes on unasked
  run.stub.gitlab.accessDelayMs = 120_000;
  const notes = await protectedClone(run, home, 'notes');
  await expect.poll(() => run.stub.gitlab.accessChecks.includes('alexios-s/notes'), { timeout: 30_000 }).toBe(true);
  const started = Date.now();
  await commitReadme(notes.shell, home, notes.dir, 'While the server hangs');
  // a question would hold the commit, so a commit on main is one nothing asked about
  await expect.poll(() => git(home, notes.dir, 'log', '-1', '--format=%s', 'main'), { timeout: 20_000 }).toBe('While the server hangs');
  expect(Date.now() - started).toBeLessThan(20_000);
  await expect(protectedAsk(overlay)).toHaveCount(0);
  expect(await git(home, notes.dir, 'branch', '--show-current')).toBe('main');
  expect(protectionReads(run, 'notes')).toBe(0);
});

test('server branch protection off: the rules are never read and a commit to the protected main asks nothing', async ({ home, launch }) => {
  test.setTimeout(300_000);
  writeUserSettings(home, { 'damocles.desktop.forge.branchProtection': false });
  const run = await launchForge(launch, home, ['gitlab']);
  const { dir, shell } = await protectedClone(run, home, 'damocles');
  // the account chip's access check shows the forge host has read the repository
  await expect.poll(() => run.stub.gitlab.accessChecks.includes('alexios-s/damocles'), { timeout: 30_000 }).toBe(true);
  await commitReadme(shell, home, dir, 'Setting off');
  await expect.poll(() => git(home, dir, 'log', '-1', '--format=%s', 'main'), { timeout: 30_000 }).toBe('Setting off');
  await expect(protectedAsk(await readyOverlay(run.app))).toHaveCount(0);
  expect(await git(home, dir, 'branch', '--show-current')).toBe('main');
  expect(protectionReads(run, 'damocles')).toBe(0);
});

test('protected branch on push: the question names the account, Push to a New Branch checks the name, creates and pushes the branch, and opens the merge request page', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['gitlab']);
  const { dir } = await protectedClone(run, home, 'damocles');
  run.stub.gitlab.enforcePushAccess = true;
  await recordOpenExternal(run.app);
  fs.writeFileSync(path.join(dir, 'fix.ts'), 'export const fix = 1;\n');
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '-m', 'Fix');
  const mainBefore = await servedHead(home, run.gitRoot, 'alexios-s/damocles', 'main');
  const committed = await git(home, dir, 'rev-parse', 'main');

  await clickMenu(run.app, 'damocles.git.push');
  const overlay = await readyOverlay(run.app);
  const ask = protectedPushAsk(overlay, 'gitlab.com');
  await expect(ask).toBeVisible({ timeout: 60_000 });
  await expect(ask).toHaveAccessibleDescription(/^gitlab\.com accepts changes to main only through a merge request, so alexios-s cannot push to it\. Push your commits to a new branch, then open a merge request\.\s*main has 1 commit that origin does not have\. It goes on the new branch too, and main stays as it is\.$/);
  const go = ask.getByRole('button', { name: 'Push to a New Branch', exact: true });
  await expect(go).toBeFocused();
  await go.click();

  const naming = overlay.getByRole('dialog', { name: 'Push to a new branch', exact: true });
  const field = naming.getByLabel('Branch name', { exact: true });
  await expect(field).toHaveValue('alexios-s/main');
  await expect(field).toBeFocused();
  // git's rules and the existing branches, checked by main as the user types
  await field.fill('main');
  await expect(field).toHaveAccessibleDescription('A local branch named main exists already.');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await field.fill('bad..name');
  await expect(field).toHaveAccessibleDescription('Git does not accept this as a branch name. Leave out spaces and ~ ^ : ? * [, and do not start with - or end with . or /.');
  await field.fill('alexios-s/fix');
  await expect(field).not.toHaveAttribute('aria-invalid', 'true');
  await naming.getByRole('button', { name: 'Create and Push', exact: true }).click();

  const done = overlay.getByRole('dialog', { name: 'Pushed alexios-s/fix', exact: true });
  await expect(done).toBeVisible({ timeout: 60_000 });
  await expect(done.getByText('Pushed alexios-s/fix to origin. main is unchanged.', { exact: true })).toBeVisible();
  // the new branch holds the commit on the server and tracks it; main is where it was, here and there
  expect(await servedHead(home, run.gitRoot, 'alexios-s/damocles', 'alexios-s/fix')).toBe(committed);
  expect(await git(home, dir, 'branch', '--show-current')).toBe('alexios-s/fix');
  expect(await git(home, dir, 'rev-parse', '--abbrev-ref', 'alexios-s/fix@{upstream}')).toBe('origin/alexios-s/fix');
  expect(await git(home, dir, 'rev-parse', 'main')).toBe(committed);
  expect(await servedHead(home, run.gitRoot, 'alexios-s/damocles', 'main')).toBe(mainBefore);

  const open = done.getByRole('button', { name: 'Open Merge Request', exact: true });
  await expect(open).toBeFocused();
  await open.click();
  await expect(done).toHaveCount(0);
  await expect.poll(() => openedExternally(run.app)).toHaveLength(1);
  const url = new URL((await openedExternally(run.app))[0]!);
  expect(`${url.origin}${url.pathname}`).toBe(`${run.stub.gitlab.webUrl}/alexios-s/damocles/-/merge_requests/new`);
  expect(url.searchParams.get('merge_request[source_branch]')).toBe('alexios-s/fix');
  expect(url.searchParams.get('merge_request[target_branch]')).toBe('main');
});

test("publish opens at once while the servers list their groups, and each account's groups arrive in the dialog", async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['indigital', 'gitlab']);
  await unpublishedProject(run, home);
  run.stub.indigital.namespaceDelayMs = 8_000;
  run.stub.gitlab.namespaceDelayMs = 8_000;
  const overlay = await openPublish(run.app);
  const dialog = publishDialog(overlay);
  // the dialog is up while both servers still list, so it waited for neither
  await expect(dialog.getByTestId('forge-publish-owners-loading')).toHaveCount(2);
  const status = dialog.getByTestId('forge-publish-owners-status');
  await expect(status).toHaveAttribute('role', 'status');
  await expect(status.getByText('Listing the groups of alexios-s on gitlab.com…', { exact: true })).toBeVisible();
  await expect(status.getByText(`Listing the groups of astefanopoulos on ${run.indigital}…`, { exact: true })).toBeVisible();
  // each account's own namespace is there at once, and Name, Visibility and Publish work meanwhile
  const owner = dialog.getByLabel('Owner', { exact: true });
  await owner.selectOption('gitlab.com|alexios-s|personal');
  await dialog.getByLabel('Name', { exact: true }).fill('early bird');
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('early-bird');
  await dialog.getByRole('radio', { name: 'Public', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Publish', exact: true })).toBeEnabled();

  await expect(owner.locator('option[value="gitlab.com|alexios-s|indigital-oss"]')).toHaveCount(1, { timeout: 30_000 });
  await expect(owner.locator(`option[value="${run.indigital}|astefanopoulos|grp/platform"]`)).toHaveCount(1, { timeout: 30_000 });
  await expect(status.getByTestId('forge-publish-owners-loading')).toHaveCount(0);
  await expect(owner).toHaveValue('gitlab.com|alexios-s|personal');
  await publish(overlay, `${run.indigital}|astefanopoulos|grp/platform`, 'tools', 'Private', `Published ${run.indigital}/grp/platform/tools. This project now uses astefanopoulos on ${run.indigital}.`);
});

test('closing Publish while a server lists its groups lets a new Publish open at once', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home, ['gitlab']);
  await unpublishedProject(run, home);
  run.stub.gitlab.namespaceDelayMs = 30_000;
  const overlay = await openPublish(run.app);
  await expect(publishDialog(overlay).getByTestId('forge-publish-owners-loading')).toHaveCount(1);
  await publishDialog(overlay).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(publishDialog(overlay)).toHaveCount(0);
  const again = await openPublish(run.app);
  await expect(publishDialog(again).getByTestId('forge-publish-owners-loading')).toHaveCount(1);
});
