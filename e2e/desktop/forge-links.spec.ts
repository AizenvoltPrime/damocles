import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn, trustForGit } from './support/forge';
import type { ForgeStub } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import type { DesktopApp, LaunchOptions } from './support/app';
import type { HermeticHome } from './support/hermetic';
import { codeEditor, editorShows, openInEditor } from './support/editor';
import { git, initRepo } from './support/git';
import { chooseMenuItem, readyOverlay } from './support/overlay';
import { bareClone, openScmProject, setSection } from './support/scm';
import { answerToast, recordedToasts, recordToasts, selectedProjectKey } from './support/shell';
import { clickMenu } from './support/ui';
import { openedExternally, recordOpenExternal } from './support/updates';

// Copy Permalink, Open File on Server and Open Commit on Server against the forge stub. The stub's self-managed GitLab stands in for gitlab.indigital.gr at 127.0.0.1:<port>,
// so https://gitlab.indigital.gr/grp/proj/-/blob/<sha>/src/a.ts#L3-7 is asserted on the stub's origin (core/forge's
// links.test.ts holds the gitlab.indigital.gr form itself).

const TOKEN = 'glpat-stubIndigitalAstefApi00006';
const LINES = Array.from({ length: 9 }, (_, index) => `export const line${index + 1} = ${index + 1};`);

interface LinkRun {
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly shell: Page;
  readonly dir: string;
  // the self-managed server's name in the app: its host, 127.0.0.1:<port>
  readonly server: string;
}

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

/**
 * astefanopoulos signed in on the stub's self-managed GitLab, and a project grp/proj whose origin is on it: src/a.ts committed
 * and pushed to the stub's own git (so Push works), origin/main at HEAD.
 */
async function launchLinks(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome): Promise<LinkRun> {
  const gitRoot = path.join(home.root, 'served');
  const started = await startStubOnTestCa(home, { gitRoot });
  const { stub } = started;
  stubs.push(stub);
  trustForGit(home, started.caFile);
  const { app } = await launchReady(launch, forgeEnv(started));
  await recordOpenExternal(app);
  await recordToasts(app);

  let server = '';
  await inAccounts(app, async (overlay) => {
    server = await addGitlabServer(overlay, stub.indigital);
    await tokenSignIn(overlay, server, TOKEN, 'astefanopoulos');
  });

  const dir = path.join(home.root, 'projects', 'proj');
  await initRepo(home, dir, { 'src/a.ts': `${LINES.join('\n')}\n` });
  await bareClone(home, dir, path.join(gitRoot, 'grp'), 'proj');
  await git(home, dir, 'remote', 'add', 'origin', `${stub.indigital.webUrl}/grp/proj.git`);
  await git(home, dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  await git(home, dir, 'branch', '--set-upstream-to', 'origin/main', 'main');
  const shell = await openScmProject(app, dir);
  return { app, stub, shell, dir, server };
}

const line = (shell: Page, n: number): Locator => codeEditor(shell).locator('.view-line', { hasText: `line${n} =` });

/** src/a.ts in the editor with lines 3 to 7 selected, from line 3's start to line 7's. */
async function selectLines3To7(run: LinkRun): Promise<void> {
  expect((await openInEditor(run.app, { projectKey: await selectedProjectKey(run.app), relativePath: 'src/a.ts' })).ok).toBe(true);
  await editorShows(run.shell, LINES[0]!);
  await line(run.shell, 3).click({ position: { x: 1, y: 2 } });
  for (let step = 0; step < 4; step++) await run.shell.keyboard.press('Shift+ArrowDown');
}

/** The newest toast once it says `message`. */
async function toastSaying(app: ElectronApplication, message: string): Promise<{ readonly id: string; readonly severity: string; readonly actions: readonly string[] }> {
  let found: Awaited<ReturnType<typeof recordedToasts>>[number] | undefined;
  await expect.poll(async () => (found = (await recordedToasts(app)).reverse().find((toast) => toast.message === message))?.message, { timeout: 30_000 }).toBe(message);
  return found!;
}

test('Copy Permalink on lines 3-7 copies the file\'s link at HEAD on the server and says so; the editor menu offers it too', async ({ clipboard, home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchLinks(launch, home);
  const sha = await git(home, run.dir, 'rev-parse', 'HEAD');
  const permalink = `${run.stub.indigital.webUrl}/grp/proj/-/blob/${sha}/src/a.ts#L3-7`;
  await clipboard.writeText(run.app, '');
  await selectLines3To7(run);

  await clickMenu(run.app, 'damocles.git.copyPermalink');
  await expect.poll(() => clipboard.readText(run.app), { timeout: 30_000 }).toBe(permalink);
  const copied = await toastSaying(run.app, `Copied the permalink to src/a.ts on ${run.server}.`);
  expect(copied.severity).toBe('info');
  expect(await openedExternally(run.app)).toEqual([]);

  // the editor's context menu, at the same selection
  await clipboard.writeText(run.app, '');
  await line(run.shell, 5).click({ button: 'right' });
  await chooseMenuItem(run.app, 'copyPermalink');
  await expect.poll(() => clipboard.readText(run.app), { timeout: 30_000 }).toBe(permalink);
});

test('Open File on Server opens the selected lines and Open Commit on Server the commit, from the palette, the Graph and the blame card', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchLinks(launch, home);
  const sha = await git(home, run.dir, 'rev-parse', 'HEAD');
  const web = run.stub.indigital.webUrl;
  await selectLines3To7(run);

  await clickMenu(run.app, 'damocles.git.openFileOnServer');
  await expect.poll(() => openedExternally(run.app), { timeout: 30_000 }).toEqual([`${web}/grp/proj/-/blob/${sha}/src/a.ts#L3-7`]);
  await toastSaying(run.app, `Opened src/a.ts on ${run.server} in your browser.`);

  // the palette's Open Commit on Server opens the selected repository's HEAD
  await clickMenu(run.app, 'damocles.git.openCommitOnServer');
  await expect.poll(async () => (await openedExternally(run.app)).at(-1), { timeout: 30_000 }).toBe(`${web}/grp/proj/-/commit/${sha}`);
  await toastSaying(run.app, `Opened Commit ${sha.slice(0, 7)} on ${run.server} in your browser.`);

  // the blame card's fourth action: Show Line Blame opens the card on the caret's line with focus
  await line(run.shell, 2).click({ position: { x: 1, y: 2 } });
  await expect(codeEditor(run.shell).locator('.qd-blame')).toBeVisible({ timeout: 30_000 });
  await clickMenu(run.app, 'damocles.git.showLineBlame');
  const card = run.shell.getByTestId('blame-card');
  await expect(card).toBeVisible();
  const before = (await openedExternally(run.app)).length;
  await card.getByRole('button', { name: 'Open Commit on Server', exact: true }).click();
  await expect.poll(async () => (await openedExternally(run.app)).slice(before), { timeout: 30_000 }).toEqual([`${web}/grp/proj/-/commit/${sha}`]);
  const status = `Opened Commit ${sha.slice(0, 7)} on ${run.server} in your browser.`;
  await expect.poll(async () => (await recordedToasts(run.app)).filter((toast) => toast.message === status).length, { timeout: 30_000 }).toBe(2);

  // the Graph's commit menu
  await setSection(run.shell, 'graph-section', true);
  const row = run.shell.getByTestId('graph-section').getByTestId('graph-row').first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByTestId('graph-subject').click({ button: 'right' });
  await chooseMenuItem(run.app, 'openCommitOnServer');
  await expect.poll(async () => (await openedExternally(run.app)).slice(before), { timeout: 30_000 }).toEqual([`${web}/grp/proj/-/commit/${sha}`, `${web}/grp/proj/-/commit/${sha}`]);
  await expect.poll(async () => (await recordedToasts(run.app)).filter((toast) => toast.message === status).length, { timeout: 30_000 }).toBe(3);
});

test('an unpushed commit is not opened: the warning offers Push, which publishes it, and then the commit opens', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const run = await launchLinks(launch, home);
  fs.appendFileSync(path.join(run.dir, 'src', 'a.ts'), 'export const line10 = 10;\n');
  await git(home, run.dir, 'commit', '-q', '-am', 'Add line 10');
  const sha = await git(home, run.dir, 'rev-parse', 'HEAD');
  const short = sha.slice(0, 7);

  await clickMenu(run.app, 'damocles.git.openCommitOnServer');
  const warning = await toastSaying(run.app, `Commit ${short} is not on ${run.server} yet, so its page would not open. Push it first.`);
  expect(warning.severity).toBe('warning');
  expect(warning.actions).toEqual(['Push']);
  expect(await openedExternally(run.app)).toEqual([]);

  await answerToast(run.app, warning.id, 'Push');
  await expect.poll(async () => git(home, path.join(home.root, 'served', 'grp', 'proj.git'), 'rev-parse', 'main'), { timeout: 60_000 }).toBe(sha);
  await expect.poll(() => openedExternally(run.app), { timeout: 30_000 }).toEqual([`${run.stub.indigital.webUrl}/grp/proj/-/commit/${sha}`]);
  await toastSaying(run.app, `Opened Commit ${short} on ${run.server} in your browser.`);
  // the push answered git with the account, so nothing asked for a password
  const overlay = await readyOverlay(run.app);
  await expect(overlay.getByTestId('secret-prompt')).toHaveCount(0);
});
