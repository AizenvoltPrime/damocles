import * as path from 'node:path';
import type { ElectronApplication, Locator, Page, TestInfo } from '@playwright/test';
import { forgeEnv, launchReady, openAccounts as openAccountsSettings, startStubOnTestCa, tokenSignIn } from './support/forge';
import { scanLogFolder, type ForgeStub, type StubServer } from './support/forge-stub';
import { expect, test } from './support/fixtures';
import type { DesktopApp, LaunchOptions } from './support/app';
import type { HermeticHome } from './support/hermetic';
import { initRepo } from './support/git';
import { cleanUp, endLeftoverDaemon, LOCAL_DAEMON, LOOPBACK_ENV, LOOPBACK_TAG } from './support/loopback';
import { newLoopbackChat } from './support/loopback-agent';
import { closeSettingsModal, setContentSize, settingsModal, settingsNav } from './support/settings';
import { overlayPage, shellPage } from './support/shell';

// Settings › Models & accounts › Git hosting against the forge stub, whose servers carry the sample accounts.

const REFUSAL = 'This token is missing the api scope. Create one with the scopes above and try again.';

interface ForgeRun {
  readonly desktop: DesktopApp;
  readonly app: ElectronApplication;
  readonly stub: ForgeStub;
  /** Every URL core opened through shell.openExternal, which records instead of starting the OS browser. */
  opened(): Promise<string[]>;
}

const stubs: ForgeStub[] = [];
test.afterEach(async () => {
  while (stubs.length > 0) await stubs.pop()!.close();
});

/** Starts the stub on a test CA, launches the app with the built-in servers pointed at it, and records the pages core opens. */
async function launchForge(launch: (options?: LaunchOptions) => Promise<DesktopApp>, home: HermeticHome): Promise<ForgeRun> {
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  stubs.push(stub);
  const desktop = await launchReady(launch, forgeEnv(started));
  const { app } = desktop;
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { openedUrls?: string[] }).openedUrls = opened;
    shell.openExternal = ((url: string) => {
      opened.push(url);
      return Promise.resolve();
    }) as typeof shell.openExternal;
  });
  return { desktop, app, stub, opened: () => app.evaluate(() => (globalThis as { openedUrls?: string[] }).openedUrls ?? []) };
}

/**
 * Opens Settings on Accounts and waits for core's first forgeAccountsChanged, which replaces the skeleton with the rows. The
 * built-ins offer the browser route only with the stub's OAuth apps, so an enabled Browser proves no request reaches the real servers.
 */
async function openAccounts(app: ElectronApplication): Promise<Page> {
  const overlay = await openAccountsSettings(app);
  const add = overlay.getByRole('button', { name: 'Add account: gitlab.com', exact: true });
  await add.click();
  await expect(overlay.getByRole('radio', { name: 'Browser', exact: true })).toBeEnabled();
  await overlay.getByTestId('forge-sign-in-cancel').click();
  await expect(overlay.getByText('Sign in to gitlab.com', { exact: true })).toHaveCount(0);
  return overlay;
}

/** The newest URL core opened once it opened `count` of them. */
async function openedAt(run: ForgeRun, count: number): Promise<string> {
  await expect.poll(async () => (await run.opened()).length).toBeGreaterThanOrEqual(count);
  return (await run.opened())[count - 1]!;
}

/** The browser route: starts it, plays the browser through the stub's authorize page and the loopback callback, waits for the new line. */
async function browserSignIn(run: ForgeRun, overlay: Page, server: string, stubServer: StubServer, login: string): Promise<URL> {
  const before = (await run.opened()).length;
  await overlay.getByRole('button', { name: `Add account: ${server}`, exact: true }).click();
  await expect(overlay.getByText(`Sign in to ${server}`, { exact: true })).toBeVisible();
  await overlay.getByRole('radio', { name: 'Browser', exact: true }).click();
  await overlay.getByRole('button', { name: 'Sign in with the browser', exact: true }).click();
  const authorize = await openedAt(run, before + 1);
  expect(await stubServer.completeBrowser(authorize)).toBe(200);
  await expect(overlay.getByText(`Signed in as ${login}`, { exact: true })).toBeVisible();
  await expect(overlay.getByRole('button', { name: `Add account: ${server}`, exact: true })).toBeFocused();
  return new URL(authorize);
}

const accountLine = (overlay: Page, login: string): Locator => overlay.getByTestId(`forge-account-${login}`);

/** Quits the app, then scans every log file it wrote for a token, code, verifier, device code or client secret the stub issued. */
async function expectNoSecretsInLogs(run: ForgeRun, home: HermeticHome, testInfo: TestInfo): Promise<void> {
  await run.desktop.close();
  const secrets = [run.stub.github, run.stub.gitlab, run.stub.indigital, run.stub.ghes].flatMap((server) => server.issuedSecrets());
  expect(secrets.length).toBeGreaterThan(0);
  const hits = scanLogFolder(path.join(home.userData, 'logs'), secrets);
  await testInfo.attach('log-scan.json', { body: JSON.stringify({ secretsChecked: secrets.length, hits }, null, 2), contentType: 'application/json' });
  expect(hits).toEqual([]);
}

for (const width of [768, 1280]) {
  test(`sign-in journey at ${width} px: Add account on gitlab.com, Token, the missing-api refusal, then Signed in as work-alexios`, async ({ home, launch }, testInfo) => {
    const run = await launchForge(launch, home);
    await setContentSize(run.app, width, 900);
    const page = await openAccounts(run.app);

    await page.getByRole('button', { name: 'Add account: gitlab.com', exact: true }).click();
    await expect(page.getByText('Sign in to gitlab.com', { exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'Token', exact: true }).click();
    await expect(page.getByLabel('Personal access token', { exact: true })).toBeVisible();
    await page.getByLabel('Personal access token', { exact: true }).fill('glpat-stubWorkAlexiosRead00002');
    await expect(page.getByLabel('Personal access token', { exact: true })).toHaveValue('glpat-stubWorkAlexiosRead00002');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText(REFUSAL, { exact: true })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: REFUSAL })).toBeVisible();
    // The field never shows a sent token again.
    await expect(page.getByLabel('Personal access token', { exact: true })).toHaveValue('');
    await page.getByLabel('Personal access token', { exact: true }).fill('glpat-stubWorkAlexiosApi000001');
    await expect(page.getByLabel('Personal access token', { exact: true })).toHaveValue('glpat-stubWorkAlexiosApi000001');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Signed in as work-alexios', { exact: true })).toBeVisible();
    await expect(accountLine(page, 'work-alexios')).toContainText('work-alexios · personal access token');
    // A long-lived token is chosen at sign-in, its "Agent shells may use this account" off by default.
    await accountLine(page, 'work-alexios').getByRole('button', { name: 'Manage: work-alexios on gitlab.com' }).click();
    await expect(accountLine(page, 'work-alexios').getByRole('switch', { name: 'Agent shells may use this account' })).toHaveAttribute('aria-checked', 'false');

    await closeSettingsModal(page);
    await expectNoSecretsInLogs(run, home, testInfo);
  });
}

test('GitHub browser sign-in through the loopback adds astefanopoulos with an avatar; a second account asks with prompt=select_account; Sign in again names the login; org access messages open their pages', async ({ home, launch }, testInfo) => {
  const run = await launchForge(launch, home);
  const overlay = await openAccounts(run.app);

  run.stub.github.nextLogin = 'astefanopoulos';
  const first = await browserSignIn(run, overlay, 'github.com', run.stub.github, 'astefanopoulos');
  expect(first.origin).toBe(run.stub.github.webUrl);
  const firstParams = run.stub.github.authorizeParams.at(-1)!;
  expect(firstParams['prompt']).toBe('select_account');
  expect(firstParams['code_challenge_method']).toBe('S256');
  const redirect = new URL(firstParams['redirect_uri']!);
  expect([redirect.protocol, redirect.hostname, redirect.pathname]).toEqual(['http:', '127.0.0.1', '/callback']);

  // The avatar comes from main's route under the existing CSP and fades in over the initial.
  const image = accountLine(overlay, 'astefanopoulos').getByTestId('forge-avatar-image');
  await expect(image).toHaveAttribute('src', /^app:\/\/damocles\/forge\/avatar\//);
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0))).toBeGreaterThan(0);
  await expect(image).toHaveClass(/d-fade-in/);

  run.stub.github.nextLogin = 'astef-admin';
  await browserSignIn(run, overlay, 'github.com', run.stub.github, 'astef-admin');
  expect(run.stub.github.authorizeParams.at(-1)!['prompt']).toBe('select_account');
  expect(run.stub.github.authorizeParams.at(-1)!['login']).toBeUndefined();
  await expect(overlay.getByTestId('settings-row-forge-server-github.com')).toContainText('2 accounts');

  // GitHub organization access, found by core's access check after sign-in.
  const authorize = accountLine(overlay, 'astefanopoulos').getByRole('button', { name: 'Authorize Damocles for indigital', exact: true });
  await expect(authorize).toBeVisible({ timeout: 30_000 });
  await expect(accountLine(overlay, 'astef-admin').getByText('legacy-corp has not approved Damocles', { exact: true })).toBeVisible({ timeout: 30_000 });
  const openedBefore = (await run.opened()).length;
  await authorize.click();
  expect(await openedAt(run, openedBefore + 1)).toMatch(/^https:\/\//);
  await accountLine(overlay, 'astef-admin').getByRole('button', { name: 'Request approval', exact: true }).click();
  expect(await openedAt(run, openedBefore + 2)).toContain(`/settings/connections/applications/${run.stub.github.spec.clientId}`);

  // Sign in again on GitHub's browser route names the account with login=.
  await accountLine(overlay, 'astefanopoulos').getByRole('button', { name: 'Manage: astefanopoulos on github.com' }).click();
  const again = (await run.opened()).length;
  await accountLine(overlay, 'astefanopoulos').getByRole('button', { name: 'Sign in again', exact: true }).click();
  await overlay.getByRole('button', { name: 'Sign in with the browser', exact: true }).click();
  expect(await run.stub.github.completeBrowser(await openedAt(run, again + 1))).toBe(200);
  await expect(overlay.getByText('Signed in as astefanopoulos', { exact: true })).toBeVisible();
  expect(run.stub.github.authorizeParams.at(-1)!['login']).toBe('astefanopoulos');

  await closeSettingsModal(overlay);
  await expectNoSecretsInLogs(run, home, testInfo);
});

test('GitLab browser sign-in redirects to a free loopback port; device code shows the code, copies and opens it, counts down, cancels to Add account, then signs in', async ({ clipboard, home, launch }, testInfo) => {
  const run = await launchForge(launch, home);
  const { stub } = run;
  const overlay = await openAccounts(run.app);

  stub.gitlab.nextLogin = 'alexios-s';
  await browserSignIn(run, overlay, 'gitlab.com', stub.gitlab, 'alexios-s');
  expect(stub.gitlab.authorizeParams.at(-1)!['redirect_uri']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  expect(stub.gitlab.authorizeParams.at(-1)!['scope']).toBe('api write_repository');

  const add = overlay.getByRole('button', { name: 'Add account: gitlab.com', exact: true });
  await add.click();
  await overlay.getByRole('radio', { name: 'Device code', exact: true }).click();
  await overlay.getByRole('button', { name: 'Get a code', exact: true }).click();
  await expect(overlay.getByTestId('provider-sign-in-code')).toHaveText('DMCL1234');
  const copy = overlay.getByRole('button', { name: 'Copy code and open page', exact: true });
  await expect(copy).toBeFocused();
  const countdown = overlay.getByTestId('provider-sign-in-countdown');
  await expect(countdown).toHaveText(/Code expires in 1[45]:\d\d/);
  const shown = await countdown.textContent();
  await expect(countdown).not.toHaveText(shown!);

  await clipboard.writeText(run.app, 'before the copy');
  const before = (await run.opened()).length;
  await copy.click();
  await expect(overlay.getByText('Code copied', { exact: true })).toBeVisible();
  expect(await clipboard.readText(run.app)).toBe('DMCL1234');
  expect(await openedAt(run, before + 1)).toBe(`${stub.gitlab.webUrl}/oauth/device`);

  await overlay.getByTestId('forge-sign-in-cancel').click();
  await expect(overlay.getByText('Sign in to gitlab.com', { exact: true })).toHaveCount(0);
  await expect(add).toBeFocused();

  await add.click();
  await overlay.getByRole('radio', { name: 'Device code', exact: true }).click();
  await overlay.getByRole('button', { name: 'Get a code', exact: true }).click();
  await expect(overlay.getByTestId('provider-sign-in-code')).toHaveText('DMCL1234');
  stub.gitlab.approveDevice('work-alexios');
  await expect(overlay.getByText('Signed in as work-alexios', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(accountLine(overlay, 'work-alexios')).toContainText('work-alexios · device code');

  await closeSettingsModal(overlay);
  await expectNoSecretsInLogs(run, home, testInfo);
});

test('added servers: a self-managed GitLab on a test CA signs in by token and by its own client id, shows its version and learns its git host; GHES signs in with id and secret; a ghe.com tenant without an app offers only Token', async ({ home, launch }, testInfo) => {
  test.setTimeout(240_000);
  const run = await launchForge(launch, home);
  const overlay = await openAccounts(run.app);
  const addServerRow = overlay.getByTestId('settings-row-forge-add-server');
  const addServer = async (url: string, kind: 'GitLab' | 'GitHub Enterprise', clientId?: string, clientSecret?: string): Promise<void> => {
    await addServerRow.getByRole('button', { name: 'Add server', exact: true }).click();
    const form = overlay.getByTestId('forge-server-form');
    await form.getByLabel('Server URL', { exact: true }).fill(url);
    await form.getByRole('radio', { name: kind, exact: true }).click();
    if (clientId !== undefined) await form.getByLabel('OAuth app client id (optional)', { exact: true }).fill(clientId);
    if (clientSecret !== undefined) await form.getByLabel('Client secret', { exact: true }).fill(clientSecret);
    await form.getByTestId('forge-server-submit').click();
    await expect(form).toHaveCount(0);
  };

  // URL validation names the fix, from core.
  await addServerRow.getByRole('button', { name: 'Add server', exact: true }).click();
  const form = overlay.getByTestId('forge-server-form');
  await expect(form.getByTestId('forge-redirect-uri')).toHaveText('http://127.0.0.1/callback');
  await form.getByLabel('Server URL', { exact: true }).fill('http://gitlab.example.com');
  await form.getByTestId('forge-server-submit').click();
  await expect(form.getByRole('alert')).toBeVisible();
  await expect(form.getByLabel('Server URL', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(form.getByLabel('Server URL', { exact: true })).toBeFocused();
  await form.getByTestId('forge-server-cancel').click();

  const indigital = new URL(run.stub.indigital.webUrl).host;
  await addServer(run.stub.indigital.webUrl, 'GitLab', run.stub.indigital.spec.clientId);
  await expect(overlay.getByTestId('forge-server-outcome')).toHaveText(`Added ${indigital}.`);
  const indigitalRow = overlay.getByTestId(`settings-row-forge-server-${indigital}`);
  await expect(indigitalRow).toContainText('Self-managed. Signs in through your own OAuth app.');
  await tokenSignIn(overlay, indigital, 'glpat-stubIndigitalWorkApi00004');
  await expect(overlay.getByText('Signed in as work-alexios', { exact: true })).toBeVisible();
  await expect(indigitalRow.getByTestId('forge-version-badge')).toHaveText(/^GitLab 17\.9/);
  await indigitalRow.getByRole('button', { name: `Edit server: ${indigital}`, exact: true }).click();
  // a host learned from clone URLs waits for the user's confirmation
  await expect(indigitalRow.getByLabel('Other git hosts (optional)', { exact: true })).not.toHaveValue(/git\.indigital\.gr/);
  await indigitalRow.getByTestId('forge-server-cancel').click();
  await browserSignIn(run, overlay, indigital, run.stub.indigital, 'work-alexios');

  const ghes = new URL(run.stub.ghes.webUrl).host;
  await addServer(run.stub.ghes.webUrl, 'GitHub Enterprise', run.stub.ghes.spec.clientId, run.stub.ghes.spec.clientSecret);
  run.stub.ghes.nextLogin = 'astefanopoulos';
  await browserSignIn(run, overlay, ghes, run.stub.ghes, 'astefanopoulos');
  await expect(overlay.getByTestId(`settings-row-forge-server-${ghes}`).getByTestId('forge-version-badge')).toHaveText('GitHub Enterprise 3.17.2');

  await addServer('https://acme.ghe.com', 'GitHub Enterprise');
  await overlay.getByRole('button', { name: 'Add account: acme.ghe.com', exact: true }).click();
  await expect(overlay.getByRole('radio', { name: 'Browser', exact: true })).toBeDisabled();
  await expect(overlay.getByRole('radio', { name: 'Device code', exact: true })).toBeDisabled();
  await expect(overlay.getByRole('radio', { name: 'Token', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(overlay.getByTestId('forge-route-unavailable')).toContainText('Browser, Device code:');
  await overlay.getByTestId('forge-sign-in-cancel').click();

  // Remove server asks first, naming the accounts it signs out.
  const acmeRow = overlay.getByTestId('settings-row-forge-server-acme.ghe.com');
  await acmeRow.getByRole('button', { name: 'Edit server: acme.ghe.com', exact: true }).click();
  await acmeRow.getByTestId('forge-server-remove').click();
  const confirm = overlay.getByTestId('forge-remove-server-confirm');
  await expect(confirm).toContainText('Remove acme.ghe.com?');
  await confirm.getByTestId('confirm-action').click();
  await expect(acmeRow).toHaveCount(0);
  await expect(overlay.getByTestId('forge-server-outcome')).toHaveText('Removed acme.ghe.com.');

  await closeSettingsModal(overlay);
  await expectNoSecretsInLogs(run, home, testInfo);
});

test('sign-out confirms the revoke, revokes and removes the line; a refused revoke still signs out with a notice whose page core opens', async ({ home, launch }, testInfo) => {
  const run = await launchForge(launch, home);
  const overlay = await openAccounts(run.app);
  await tokenSignIn(overlay, 'gitlab.com', 'glpat-stubWorkAlexiosApi000001');
  await expect(overlay.getByText('Signed in as work-alexios', { exact: true })).toBeVisible();
  run.stub.github.nextLogin = 'astefanopoulos';
  await browserSignIn(run, overlay, 'github.com', run.stub.github, 'astefanopoulos');

  const signOut = async (login: string, server: string): Promise<Locator> => {
    const manage = accountLine(overlay, login).getByRole('button', { name: `Manage: ${login} on ${server}` });
    if ((await manage.getAttribute('aria-expanded')) !== 'true') await manage.click();
    await accountLine(overlay, login).getByRole('button', { name: 'Sign out', exact: true }).click();
    const dialog = overlay.getByRole('alertdialog');
    await expect(dialog).toContainText(`Sign out of ${login} on ${server}?`);
    await expect(dialog).toContainText('forgets which projects and hosts used this account.');
    return dialog;
  };

  // Cancel keeps the account.
  const cancelled = await signOut('astefanopoulos', 'github.com');
  await cancelled.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(accountLine(overlay, 'astefanopoulos')).toBeVisible();

  const revokesBefore = run.stub.github.counts.revokes;
  const dialog = await signOut('astefanopoulos', 'github.com');
  await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(accountLine(overlay, 'astefanopoulos')).toHaveCount(0);
  expect(run.stub.github.counts.revokes).toBe(revokesBefore + 1);
  await expect(overlay.getByRole('button', { name: 'Add account: github.com', exact: true })).toBeFocused();

  run.stub.gitlab.failRevoke = true;
  await (await signOut('work-alexios', 'gitlab.com')).getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(accountLine(overlay, 'work-alexios')).toHaveCount(0);
  const notice = overlay.getByTestId('forge-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'alert');
  const before = (await run.opened()).length;
  await notice.getByRole('button', { name: 'Open the revoke page', exact: true }).click();
  expect(await openedAt(run, before + 1)).toContain(new URL(run.stub.gitlab.webUrl).host);
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notice).toHaveCount(0);

  await closeSettingsModal(overlay);
  await expectNoSecretsInLogs(run, home, testInfo);
});

test('a loopback chat\'s settings show Git hosting on the User tab only, never on the host or Project tab', { tag: LOOPBACK_TAG }, async ({ foreground: _foreground, home, launch }, testInfo) => {
  test.setTimeout(300_000);
  const folder = path.join(home.root, 'p', 'remote');
  await initRepo(home, folder, { 'a.ts': 'export const a = 1;\n' });
  let app: ElectronApplication | undefined;
  let failure: unknown;
  try {
    ({ app } = await launch(LOOPBACK_ENV));
    await newLoopbackChat(app, folder);
    await (await shellPage(app)).getByTestId('open-settings').click();
    const overlay = await overlayPage(app);
    await expect(settingsModal(overlay)).toBeVisible();
    await expect(overlay.getByTestId('settings-scope-tabs').getByRole('tab')).toHaveText(['User', LOCAL_DAEMON, 'Project']);
    await settingsNav(overlay, 'accounts').click();
    await expect(overlay.getByTestId('forge-hosting')).toHaveCount(0);
    await overlay.getByTestId('settings-scope-project').click();
    await expect(overlay.getByTestId('settings-scope-project')).toHaveAttribute('aria-selected', 'true');
    await expect(overlay.getByTestId('forge-hosting')).toHaveCount(0);
    await overlay.getByTestId('settings-scope-user').click();
    await expect(overlay.getByTestId('settings-scope-user')).toHaveAttribute('aria-selected', 'true');
    await settingsNav(overlay, 'accounts').click();
    await expect(overlay.getByRole('button', { name: 'Add account: gitlab.com', exact: true })).toBeVisible();
    await expect(overlay.getByTestId('forge-hosting-head')).toHaveText('Git hosting');
    await closeSettingsModal(overlay);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await cleanUp(testInfo, failure, () => endLeftoverDaemon(app, home));
  }
});
