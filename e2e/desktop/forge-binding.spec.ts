import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { addGitlabServer, forgeEnv, inAccounts, launchReady, openAccounts, startStubOnTestCa, tokenSignIn } from './support/forge';
import type { ForgeStub } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import type { DesktopApp, LaunchOptions } from './support/app';
import type { HermeticHome } from './support/hermetic';
import { git, initRepo } from './support/git';
import { overlayMenu, readyOverlay } from './support/overlay';
import { clickAccountChip, gitLog, openScmProject, scmSection } from './support/scm';
import { closeSettingsModal, openSettingsModal, setContentSize, settingsModal, settingsNav } from './support/settings';
import { selectedProjectKey, shellPage } from './support/shell';
import { clickMenu } from './support/ui';

// The account chip, the Choose account dialog and the default accounts of a remote host, against the forge stub and its
// sample accounts. The app names a server by its host: the built-in gitlab.com keeps its name, and the stub's self-managed
// GitLab (standing in for gitlab.indigital.gr) is 127.0.0.1:<port>, which the journeys use in its place.

const GITLAB = 'gitlab.com';
const TOKENS = {
  'alexios-s': 'glpat-stubAlexiosSApi000000008',
  'work-alexios': 'glpat-stubWorkAlexiosApi000001',
  astefanopoulos: 'glpat-stubIndigitalAstefApi00006',
  'astef-admin': 'glpat-stubIndigitalAdminApi00007',
} as const;
type GitlabLogin = 'alexios-s' | 'work-alexios';
type IndigitalLogin = 'astefanopoulos' | 'astef-admin';

interface ForgeRun {
  readonly desktop: DesktopApp;
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  readonly env: Readonly<Record<string, string>>;
}

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

async function launchForge(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome): Promise<ForgeRun> {
  const started = await startStubOnTestCa(home);
  stubs.push(started.stub);
  const env = forgeEnv(started);
  const desktop = await launchReady(launch, env);
  return { desktop, app: desktop.app, stub: started.stub, env };
}

/** The same home and stub after a quit, as the user starting Damocles again. */
async function relaunch(run: ForgeRun, launch: (options?: LaunchOptions) => Promise<DesktopApp>): Promise<ForgeRun> {
  await run.desktop.close();
  const desktop = await launchReady(launch, run.env);
  return { ...run, desktop, app: desktop.app };
}

/** Token sign-ins of the accounts named, the self-managed GitLab added with its git host git.indigital.gr typed in; returns its name ('' when none was added). */
async function signIn(run: ForgeRun, gitlab: readonly GitlabLogin[], indigital: readonly IndigitalLogin[] = []): Promise<string> {
  let name = '';
  await inAccounts(run.app, async (overlay) => {
    for (const login of gitlab) await tokenSignIn(overlay, GITLAB, TOKENS[login], login);
    if (indigital.length > 0) {
      name = await addGitlabServer(overlay, run.stub.indigital, 'git.indigital.gr');
      for (const login of indigital) await tokenSignIn(overlay, name, TOKENS[login], login);
    }
  });
  return name;
}

/** A project folder `name` with one commit on main and these remotes; main tracks `upstream`'s main. */
async function project(home: HermeticHome, name: string, remotes: Readonly<Record<string, string>>, upstream?: string): Promise<string> {
  const dir = path.join(home.root, 'projects', name);
  fs.mkdirSync(dir, { recursive: true });
  await initRepo(home, dir);
  for (const [remote, url] of Object.entries(remotes)) await git(home, dir, 'remote', 'add', remote, url);
  if (upstream !== undefined) {
    await git(home, dir, 'update-ref', `refs/remotes/${upstream}/main`, 'HEAD');
    await git(home, dir, 'branch', '--set-upstream-to', `${upstream}/main`, 'main');
  }
  return dir;
}

const accountChip = (shell: Page): Locator => scmSection(shell).getByTestId('forge-account-chip');
const chipLoading = (shell: Page): Locator => scmSection(shell).getByTestId('forge-account-chip-loading');
const accountStatus = (shell: Page): Locator => scmSection(shell).getByTestId('forge-account-status');
// first reads wait on the access check, which may take up to its 10 s cap
const CHECKED = { timeout: 30_000 };

/** Drags the sidebar's sash `dx` px to the right. */
async function widenSidebar(shell: Page, dx: number): Promise<void> {
  const box = (await shell.getByTestId('sidebar-sash').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await shell.mouse.move(x, y);
  await shell.mouse.down();
  await shell.mouse.move(x + dx, y, { steps: 6 });
  await shell.mouse.up();
}

/** The chip shows its fixed label cut short, which it never should: the label is whole or folded away. */
const labelCut = (chip: Locator): Promise<boolean> => chip.evaluate((element) => {
  const label = element.querySelector<HTMLElement>('[data-testid="forge-account-chip-label"] > span.truncate');
  return label !== null && label.clientWidth + 1 < label.scrollWidth;
});

const hitsChip = (shell: Page, x: number, y: number): Promise<boolean> =>
  shell.evaluate(([px, py]) => document.elementFromPoint(px!, py!)?.closest('[data-testid="forge-account-chip"]') != null, [x, y]);

/** Opens the chip's menu and returns the overlay that draws it. */
async function openChipMenu(app: ElectronApplication, shell: Page): Promise<Page> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await clickAccountChip(accountChip(shell));
  await expect(overlayMenu(overlay)).toBeVisible();
  return overlay;
}

/** Picks `label` in the chip's menu, inside the `server` submenu when the project has several servers. */
async function pickInChip(app: ElectronApplication, shell: Page, label: string, server?: string): Promise<void> {
  const overlay = await openChipMenu(app, shell);
  if (server !== undefined) {
    await overlay.getByRole('menuitem', { name: new RegExp(`^${server.replace(/[.]/g, '\\.')}`) }).click();
    await overlay.getByRole('menu', { name: server, exact: true }).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
  } else {
    await overlay.getByRole('menu', { name: /^Accounts for / }).getByRole('menuitemradio', { name: new RegExp(`^${label}`) }).click();
  }
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

/** The design's sample project: origin on the self-managed server (the push remote), upstream on gitlab.com. */
async function twoServerProject(run: ForgeRun, home: HermeticHome): Promise<{ readonly shell: Page; readonly indigital: string }> {
  const indigital = await signIn(run, ['alexios-s', 'work-alexios'], ['astefanopoulos', 'astef-admin']);
  // only astefanopoulos can push to platform/api, so the access check chooses it automatically
  run.stub.indigital.projectAccess.get('platform/api')!.set('astef-admin', 20);
  const dir = await project(home, 'damocles', { origin: 'https://git.indigital.gr/platform/api.git', upstream: `https://${GITLAB}/alexios-s/damocles.git` }, 'origin');
  const shell = await openScmProject(run.app, dir);
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: astefanopoulos on ${indigital}, chosen automatically; ${GITLAB}, no account chosen`, CHECKED);
  return { shell, indigital };
}

for (const width of [768, 1280]) {
  test(`account chip journey at ${width} px: the chip, the ${'gitlab.indigital.gr'} submenu, astef-admin; the chip's name becomes the contract text`, async ({ home, launch }) => {
    test.setTimeout(300_000);
    const run = await launchForge(launch, home);
    const { shell, indigital } = await twoServerProject(run, home);
    // the journey's state: alexios-s chosen on gitlab.com
    await pickInChip(run.app, shell, 'alexios-s', GITLAB);
    await setContentSize(run.app, width, 900);
    const overlay = await readyOverlay(run.app);

    await shell.getByRole('button', { name: `Accounts: astefanopoulos on ${indigital}, chosen automatically; alexios-s on ${GITLAB}, chosen by you`, exact: true }).click();
    await expect(overlay.getByRole('menu', { name: 'Accounts for damocles', exact: true })).toBeVisible();
    await overlay.getByText(indigital, { exact: true }).click();
    await expect(overlay.getByRole('menu', { name: indigital, exact: true })).toBeVisible();
    await overlay.getByText('astef-admin', { exact: true }).click();
    await expect(shell.getByRole('button', { name: `Accounts: astef-admin on ${indigital}, chosen by you; alexios-s on ${GITLAB}, chosen by you`, exact: true })).toBeVisible();
    await expect(accountStatus(shell)).toHaveText('damocles now uses astef-admin on ' + indigital + '.');

    // each token reached only its own server
    const gitlabTokens = [TOKENS['alexios-s'], TOKENS['work-alexios']];
    const indigitalTokens = [TOKENS.astefanopoulos, TOKENS['astef-admin']];
    expect(JSON.stringify(run.stub.indigital.requests)).not.toMatch(new RegExp(gitlabTokens.join('|')));
    expect(JSON.stringify(run.stub.gitlab.requests)).not.toMatch(new RegExp(indigitalTokens.join('|')));
    expect(run.stub.github.requests.filter((request) => request.authorized)).toEqual([]);
  });
}

test('keyboard-only menus: ArrowDown opens, ArrowRight enters a submenu, Escape steps back to its row and then to the chip; a check that cannot reach the server says so and Try again checks again', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home);
  const { shell, indigital } = await twoServerProject(run, home);
  const overlay = await readyOverlay(run.app);

  await accountChip(shell).focus();
  await shell.keyboard.press('ArrowDown');
  await expect(overlay.getByRole('menu', { name: 'Accounts for damocles', exact: true })).toBeVisible();
  const indigitalRow = overlay.getByRole('menuitem', { name: new RegExp(`^${indigital.replace(/[.]/g, '\\.')}`) });
  await expect(indigitalRow).toBeFocused();
  await overlay.keyboard.press('ArrowDown');
  await expect(overlay.getByRole('menuitem', { name: new RegExp(`^${GITLAB.replace(/[.]/g, '\\.')}`) })).toBeFocused();
  await overlay.keyboard.press('ArrowUp');
  await overlay.keyboard.press('ArrowRight');
  const submenu = overlay.getByRole('menu', { name: indigital, exact: true });
  await expect(submenu).toBeVisible();
  await expect(submenu.getByRole('menuitemradio', { name: /^astefanopoulos/ })).toBeFocused();
  await expect(submenu.getByRole('menuitemradio', { name: /^astefanopoulos/ })).toHaveAttribute('aria-checked', 'true');
  await expect(submenu.getByRole('menuitemradio', { name: /^astefanopoulos/ })).toContainText('Chosen automatically · can push');
  await overlay.keyboard.press('ArrowDown');
  await expect(submenu.getByRole('menuitemradio', { name: /^astef-admin/ })).toBeFocused();
  await overlay.keyboard.press('Escape');
  await expect(submenu).toHaveCount(0);
  await expect(indigitalRow).toBeFocused();
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await expect(accountChip(shell)).toBeFocused();

  // account chip error: the server does not answer the access check; Try again checks it again
  run.stub.gitlab.failAccess = true;
  // a repository the access check has not answered for yet, since an answer is kept for an hour
  const repo = await project(home, 'personal-site', { origin: `https://${GITLAB}/grp/sub/proj.git` }, 'origin');
  const site = await openScmProject(run.app, repo);
  const notice = scmSection(site).getByTestId('forge-check-failed');
  await expect(notice).toContainText(`Damocles could not reach ${GITLAB} to check which of your accounts can push here.`, CHECKED);
  await expect(notice).toHaveAttribute('role', 'status');
  run.stub.gitlab.failAccess = false;
  await notice.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(notice).toHaveCount(0, CHECKED);
  // only alexios-s can push to grp/sub/proj
  await expect(accountChip(site)).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen automatically`);
});

test('choose and remember: two gitlab.com accounts show Choose account; the choice binds the project and survives a relaunch; Git\'s own credentials binds too; the check shows a loading chip first', async ({ home, launch }) => {
  test.setTimeout(300_000);
  let run = await launchForge(launch, home);
  await signIn(run, ['alexios-s', 'work-alexios']);
  // account chip loading: the access check takes a while, so the chip waits as a skeleton
  run.stub.gitlab.accessDelayMs = 4000;
  const dir = await project(home, 'personal-site', { origin: `https://${GITLAB}/alexios-s/damocles.git` }, 'origin');
  let shell = await openScmProject(run.app, dir);
  await expect(chipLoading(shell)).toBeVisible();
  await expect(chipLoading(shell)).toHaveAttribute('aria-busy', 'true');
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`, CHECKED);
  run.stub.gitlab.accessDelayMs = 0;
  await expect(accountChip(shell)).toHaveAttribute('data-state', 'choose');
  // room for the chip's words, which fold to its icon where they would be cut
  await widenSidebar(shell, 200);
  await expect(accountChip(shell).getByTestId('forge-account-chip-label')).toHaveText('Choose account');

  await pickInChip(run.app, shell, 'work-alexios');
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen by you`);
  await expect(accountStatus(shell)).toHaveText(`personal-site now uses work-alexios on ${GITLAB}.`);

  run = await relaunch(run, launch);
  shell = await shellPage(run.app);
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen by you`, CHECKED);

  await pickInChip(run.app, shell, "Use Git's own credentials");
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: ${GITLAB}, Git's own credentials`);
  await expect(accountChip(shell).getByTestId('forge-account-chip-label')).toHaveText("Git's own credentials");
});

test('account chip at the default sidebar width: Choose account is whole or folded to its icon, at rest, under the title actions and as the sidebar grows and shrinks; the actions never cover its head', async ({ foreground: _foreground, home, launch }) => {
  const run = await launchForge(launch, home);
  await signIn(run, ['alexios-s', 'work-alexios']);
  const dir = await project(home, 'personal-site', { origin: `https://${GITLAB}/alexios-s/damocles.git` }, 'origin');
  const shell = await openScmProject(run.app, dir);
  const chip = accountChip(shell);
  await expect(chip).toHaveAttribute('data-state', 'choose', CHECKED);
  const header = scmSection(shell).getByTestId('sidebar-section-header');
  const away = async (): Promise<void> => {
    await shell.mouse.move(900, 700);
    await shell.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  await away();
  await expect.poll(() => labelCut(chip)).toBe(false);
  await header.hover({ position: { x: 20, y: 10 } });
  await expect(scmSection(shell).getByTestId('sidebar-section-actions')).toBeVisible();
  await expect.poll(() => labelCut(chip)).toBe(false);
  const box = (await chip.boundingBox())!;
  // the chip's head and the faded start of the actions' ground both reach the chip
  for (const dx of [8, 28]) expect(await hitsChip(shell, box.x + dx, box.y + box.height / 2)).toBe(true);
  await shell.mouse.move(box.x + 8, box.y + box.height / 2, { steps: 4 });
  await expect(scmSection(shell).getByTestId('sidebar-section-chip')).toHaveAttribute('data-raised', 'true');
  const overlay = await readyOverlay(run.app);
  await shell.mouse.click(box.x + 8, box.y + box.height / 2);
  await expect(overlayMenu(overlay)).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);

  await away();
  await widenSidebar(shell, 200);
  await expect(chip.getByTestId('forge-account-chip-label')).toHaveText('Choose account');
  await widenSidebar(shell, -200);
  await away();
  await expect.poll(() => labelCut(chip)).toBe(false);
  await expect(chip).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`);
});

test('one account on the server shows it chosen automatically; a project with no remote, or only unknown servers, shows no chip', async ({ home, launch }) => {
  const run = await launchForge(launch, home);
  await signIn(run, ['alexios-s']);
  const notes = await project(home, 'notes', { origin: `https://${GITLAB}/alexios-s/notes.git` }, 'origin');
  let shell = await openScmProject(run.app, notes);
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen automatically`, CHECKED);
  await expect(accountChip(shell).getByTestId('forge-account-chip-label')).toHaveText(/alexios-s\s*auto/);
  for (const [name, remotes] of [['bare', {}], ['elsewhere', { origin: 'https://git.example.test/team/elsewhere.git' }]] as const) {
    shell = await openScmProject(run.app, await project(home, name, remotes));
    await expect(chipLoading(shell)).toHaveCount(0, CHECKED);
    await expect(accountChip(shell)).toHaveCount(0);
  }
});

test('account chip empty: a server with no account shows a muted Sign in chip whose Sign in to opens its sign-in panel in Settings; sign in again shows on the bound account', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home);
  const indigital = await signIn(run, [], ['astefanopoulos', 'astef-admin']);
  const site = await project(home, 'website', { origin: 'https://github.com/astefanopoulos/damocles.git' }, 'origin');
  const shell = await openScmProject(run.app, site);
  await expect(accountChip(shell)).toHaveAccessibleName('Sign in to github.com', CHECKED);
  await expect(accountChip(shell)).toHaveAttribute('data-state', 'signIn');
  const overlay = await openChipMenu(run.app, shell);
  await expect(overlay.getByRole('menu', { name: 'Accounts for website', exact: true })).toBeVisible();
  await overlay.getByRole('menuitem', { name: 'Sign in to github.com…', exact: true }).click();
  await expect(settingsModal(overlay)).toBeVisible();
  await expect(settingsNav(overlay, 'accounts')).toHaveAttribute('aria-selected', 'true');
  await expect(overlay.getByText('Sign in to github.com', { exact: true })).toBeVisible();
  await closeSettingsModal(overlay);

  // sign in again: the bound account's token is refused
  const intranet = await project(home, 'intranet', { origin: 'https://git.indigital.gr/platform/web.git' }, 'origin');
  const intranetShell = await openScmProject(run.app, intranet);
  await expect(accountChip(intranetShell)).toBeVisible(CHECKED);
  await pickInChip(run.app, intranetShell, 'astef-admin');
  await expect(accountChip(intranetShell)).toHaveAccessibleName(`Accounts: astef-admin on ${indigital}, chosen by you`);
  run.stub.indigital.refusedLogins.add('astef-admin');
  run.stub.indigital.projectAccess.get('platform/web')!.set('astef-admin', 30);
  const api = await project(home, 'api', { origin: 'https://git.indigital.gr/platform/api.git' }, 'origin');
  await openScmProject(run.app, api);
  const back = await openScmProject(run.app, intranet);
  await expect(accountChip(back)).toHaveAccessibleName(`Accounts: astef-admin on ${indigital}, sign in again`, CHECKED);
  await expect(accountChip(back).getByTestId('forge-account-chip-label')).toContainText('· sign in again');
});

/** A project whose push needs the ask-once dialog: both gitlab.com accounts can push to the stub's alexios-s/damocles. */
async function askOnceProject(run: ForgeRun, home: HermeticHome, uncheckedPush = false): Promise<{ readonly shell: Page; readonly dir: string }> {
  await signIn(run, ['alexios-s', 'work-alexios']);
  // an unreachable answer is not kept, so the push checks access again
  if (uncheckedPush) run.stub.gitlab.failAccess = true;
  const dir = await project(home, 'damocles', { origin: `${run.stub.gitlab.webUrl}/alexios-s/damocles.git` }, 'origin');
  fs.writeFileSync(path.join(dir, 'b.ts'), 'export const b = 1;\n');
  await git(home, dir, 'add', '-A');
  await git(home, dir, 'commit', '-m', 'Ahead of origin');
  const shell = await openScmProject(run.app, dir);
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`, CHECKED);
  if (uncheckedPush) {
    await expect(scmSection(shell).getByTestId('forge-check-failed')).toBeVisible();
    run.stub.gitlab.failAccess = false;
  }
  return { shell, dir };
}

const pushed = async (app: ElectronApplication): Promise<boolean> => /> git push/.test(await gitLog(app));

for (const width of [768, 1280]) {
  test(`Choose account journey at ${width} px: Push asks which gitlab.com account damocles uses; ArrowDown, Use work-alexios, and the status names it`, async ({ home, launch }) => {
    test.setTimeout(300_000);
    const run = await launchForge(launch, home);
    const { shell } = await askOnceProject(run, home);
    await setContentSize(run.app, width, 900);
    const overlay = await readyOverlay(run.app);
    await clickMenu(run.app, 'damocles.git.push');

    await expect(overlay.getByRole('alertdialog', { name: `Which ${GITLAB} account should damocles use?`, exact: true })).toBeVisible(CHECKED);
    await overlay.getByRole('listbox', { name: `Account for ${GITLAB}`, exact: true }).press('ArrowDown');
    await expect(overlay.getByRole('button', { name: 'Use work-alexios', exact: true })).toBeVisible();
    await overlay.getByRole('button', { name: 'Use work-alexios', exact: true }).click();
    await expect(shell.getByText(`damocles now uses work-alexios on ${GITLAB}. Pushing…`, { exact: true })).toBeVisible();
    await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen by you`, CHECKED);
  });
}

test('Choose account: the dialog opens checking and its rows follow the check; Escape and the scrim cancel and the push does not run; digits pick; Sign in with another account opens the sign-in', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home);
  const { shell } = await askOnceProject(run, home, true);
  const overlay = await readyOverlay(run.app);
  const dialog = overlay.getByRole('alertdialog', { name: `Which ${GITLAB} account should damocles use?`, exact: true });
  const list = overlay.getByRole('listbox', { name: `Account for ${GITLAB}`, exact: true });

  // checking: the access check answers after the 1 s fast path, so the dialog opens with spinners that turn into access
  run.stub.gitlab.accessDelayMs = 3000;
  await clickMenu(run.app, 'damocles.git.push');
  await expect(dialog).toBeVisible(CHECKED);
  await expect(list).toBeFocused();
  const checking = overlay.getByTestId('forge-ask-checking').filter({ visible: true });
  await expect(checking).toHaveCount(2);
  await expect(checking).toHaveCount(0, CHECKED);
  await expect(list.getByRole('option', { name: /^alexios-s/ })).toHaveAccessibleName(/can push/);
  await expect(list).toBeFocused();
  await overlay.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  run.stub.gitlab.accessDelayMs = 0;

  // the scrim cancels too
  await clickMenu(run.app, 'damocles.git.push');
  await expect(dialog).toBeVisible(CHECKED);
  // the scrim of the open dialog; one still leaving is inert
  await overlay.locator('.overlay-dialog:not([inert])').click({ position: { x: 4, y: 4 } });
  await expect(dialog).toHaveCount(0);
  expect(await pushed(run.app)).toBe(false);
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`);

  // digits pick a row: 3 is Git's own credentials, 4 signs in with another account
  await clickMenu(run.app, 'damocles.git.push');
  await expect(dialog).toBeVisible(CHECKED);
  await list.press('3');
  await expect(overlay.getByRole('button', { name: "Use Git's own credentials", exact: true })).toBeVisible();
  await list.press('2');
  await expect(overlay.getByRole('button', { name: 'Use work-alexios', exact: true })).toBeVisible();
  await list.press('4');
  await expect(overlay.getByRole('button', { name: 'Sign in…', exact: true })).toBeVisible();
  await list.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(settingsModal(overlay)).toBeVisible();
  await expect(overlay.getByText(`Sign in to ${GITLAB}`, { exact: true })).toBeVisible();
  await closeSettingsModal(overlay);
  expect(await pushed(run.app)).toBe(false);
});

test('forgetting: removing the project and signing out drop its binding', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const run = await launchForge(launch, home);
  await signIn(run, ['alexios-s', 'work-alexios']);
  const dir = await project(home, 'personal-site', { origin: `https://${GITLAB}/alexios-s/damocles.git` }, 'origin');
  let shell = await openScmProject(run.app, dir);
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`, CHECKED);
  await pickInChip(run.app, shell, 'work-alexios');
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen by you`);

  const key = await selectedProjectKey(run.app);
  expect(await shell.evaluate((projectKey) => window.damoclesShell!.removeProject(projectKey), key)).toEqual({ ok: true });
  shell = await openScmProject(run.app, dir);
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: ${GITLAB}, no account chosen`, CHECKED);

  await pickInChip(run.app, shell, 'alexios-s');
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: alexios-s on ${GITLAB}, chosen by you`);
  const overlay = await openAccounts(run.app);
  const line = overlay.getByTestId('forge-account-alexios-s');
  await line.getByRole('button', { name: `Manage: alexios-s on ${GITLAB}` }).click();
  await line.getByRole('button', { name: 'Sign out', exact: true }).click();
  const confirm = overlay.getByRole('alertdialog');
  await expect(confirm).toContainText('1');
  await confirm.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(line).toHaveCount(0);
  await closeSettingsModal(overlay);
  // work-alexios is the only account left, so the project resolves to it again rather than to a forgotten choice
  await expect(accountChip(shell)).toHaveAccessibleName(`Accounts: work-alexios on ${GITLAB}, chosen automatically`, CHECKED);
});

const PROD = 'host-prod-1';
const DEVBOX = 'host-devbox';

/** Saved hosts prod-1 and devbox; git on prod-1 may use git.indigital.gr and gitlab.com without asking. */
function seedHosts(home: HermeticHome): void {
  const host = (id: string, name: string, always: readonly string[]) => ({ id, kind: 'ssh', destination: { kind: 'alias', alias: name }, name, recentFolders: [], settings: {}, alwaysCredentialHosts: always });
  fs.writeFileSync(path.join(home.userData, 'remote-hosts.json'), JSON.stringify({
    version: 1,
    authorities: {},
    order: [],
    hosts: { [PROD]: host(PROD, 'prod-1', ['git.indigital.gr', GITLAB]), [DEVBOX]: host(DEVBOX, 'devbox', []) },
    groupOrder: [],
  }));
}

async function openRemoteHosts(app: ElectronApplication): Promise<Page> {
  const overlay = await openSettingsModal(app, 'remoteHosts');
  await expect(overlay.getByTestId('remote-host')).toBeVisible();
  return overlay;
}

/** Picks `option` in the select labelled `label`, a reka select whose options render in the overlay. */
const defaultSelect = (overlay: Page, server: string): Locator => overlay.getByLabel(`Default account on ${server}`, { exact: true });

async function choose(overlay: Page, server: string, option: string): Promise<void> {
  await defaultSelect(overlay, server).click();
  await overlay.getByRole('option', { name: option, exact: true }).click();
  await expect(defaultSelect(overlay, server)).toHaveText(option);
}

for (const width of [768, 1280]) {
  test(`remote host default accounts journey at ${width} px: prod-1's default for the self-managed server moves to astef-admin and the consent row names it; gitlab.com takes alexios-s`, async ({ home, launch }) => {
    test.setTimeout(300_000);
    seedHosts(home);
    const run = await launchForge(launch, home);
    const indigital = await signIn(run, ['alexios-s', 'work-alexios'], ['astefanopoulos', 'astef-admin']);
    await setContentSize(run.app, width, 900);
    const overlay = await openRemoteHosts(run.app);
    await expect(overlay.getByTestId('forge-defaults')).toHaveAttribute('data-state', 'ready', CHECKED);
    // the journey's state: astefanopoulos is prod-1's default there
    await choose(overlay, indigital, 'astefanopoulos');

    await expect(defaultSelect(overlay, indigital)).toHaveText('astefanopoulos');
    await choose(overlay, indigital, 'astef-admin');
    await expect(overlay.getByText('as astef-admin, the default', { exact: true })).toBeVisible();
    await choose(overlay, GITLAB, 'alexios-s');
    await expect(defaultSelect(overlay, GITLAB)).toHaveText('alexios-s');
    await expect(overlay.getByText('Default accounts on prod-1', { exact: true })).toBeVisible();
  });
}

test('remote host default accounts: switching hosts reads each host\'s defaults, Revoke drops a consent row, and No default clears it', async ({ home, launch }) => {
  test.setTimeout(300_000);
  seedHosts(home);
  const run = await launchForge(launch, home);
  const indigital = await signIn(run, [], ['astefanopoulos', 'astef-admin']);
  const overlay = await openRemoteHosts(run.app);
  await choose(overlay, indigital, 'astef-admin');
  const consent = overlay.getByTestId('credential-host').filter({ hasText: 'git.indigital.gr' });
  await expect(consent.getByTestId('credential-host-default')).toHaveText('as astef-admin, the default');

  await overlay.getByTestId('remote-host-pick').filter({ hasText: 'devbox' }).click();
  await expect(overlay.getByText('Default accounts on devbox', { exact: true })).toBeVisible();
  await expect(defaultSelect(overlay, indigital)).toHaveText('No default');
  await overlay.getByTestId('remote-host-pick').filter({ hasText: 'prod-1' }).click();
  await expect(defaultSelect(overlay, indigital)).toHaveText('astef-admin');

  await consent.getByRole('button', { name: 'Revoke git.indigital.gr', exact: true }).click();
  await expect(consent).toHaveCount(0);
  await choose(overlay, indigital, 'No default');
  await expect(overlay.getByTestId('credential-host-default')).toHaveCount(0);
});

test('remote host default accounts empty and error: with no account it says so and opens Accounts; with an unreadable accounts file it says it could not read them', async ({ home, launch }) => {
  test.setTimeout(300_000);
  seedHosts(home);
  let run = await launchForge(launch, home);
  let overlay = await openRemoteHosts(run.app);
  const defaults = overlay.getByTestId('forge-defaults');
  await expect(defaults).toHaveAttribute('data-state', 'ready', CHECKED);
  await expect(defaults).toContainText('You have no GitHub or GitLab account on this computer yet.');
  await defaults.getByRole('button', { name: 'Open Accounts', exact: true }).click();
  await expect(settingsNav(overlay, 'accounts')).toHaveAttribute('aria-selected', 'true');
  await closeSettingsModal(overlay);

  // a folder where the file belongs: core cannot read its accounts at all
  fs.mkdirSync(path.join(home.userData, 'forge', 'accounts.json'), { recursive: true });
  run = await relaunch(run, launch);
  overlay = await openRemoteHosts(run.app);
  await expect(overlay.getByTestId('forge-defaults')).toHaveAttribute('data-state', 'error', CHECKED);
  await expect(overlay.getByTestId('forge-defaults').getByRole('alert')).toContainText('Damocles could not read your GitHub and GitLab accounts.');
});
