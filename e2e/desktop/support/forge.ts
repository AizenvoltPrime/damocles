import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { createTestPki } from './certs';
import { startForgeStub, type ForgeStub, type ForgeStubOptions, type StubServer } from './forge-stub';
import { activeChat, expect } from './fixtures';
import type { DesktopApp, LaunchOptions } from './app';
import type { HermeticHome } from './hermetic';
import { closeSettingsModal, openSettingsModal } from './settings';
import { chatInput } from './ui';

// The forge specs' shared setup: the forge stub on a test CA, the app pointed at it, and the Git hosting sign-ins.

const SIGNED_IN = { timeout: 30_000 };

export interface StubOnTestCa {
  readonly stub: ForgeStub;
  /** The test CA's certificate, which the app trusts through NODE_EXTRA_CA_CERTS. */
  readonly caFile: string;
}

/** The forge stub on a fresh test CA; the caller closes the stub. */
export async function startStubOnTestCa(home: HermeticHome, options: Omit<ForgeStubOptions, 'cert' | 'key' | 'ca'> = {}): Promise<StubOnTestCa> {
  const pki = createTestPki(['localhost']);
  const caFile = path.join(home.root, 'forge-test-ca.pem');
  fs.writeFileSync(caFile, pki.caCertPem);
  const stub = await startForgeStub({ ...options, cert: pki.leafCertPem, key: pki.leafKeyPem, ca: pki.caCertPem });
  return { stub, caFile };
}

/** The environment that points the app's built-in servers at the stub; main reads DAMOCLES_E2E_FORGE_SERVERS only under the e2e hooks. */
export function forgeEnv({ stub, caFile }: StubOnTestCa): Record<string, string> {
  return { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_FORGE_SERVERS: stub.e2eServersEnv(), NODE_EXTRA_CA_CERTS: caFile };
}

/** git, which reads the hermetic home's global config as the app's git does, trusts the stub's CA. */
export function trustForGit(home: HermeticHome, caFile: string): void {
  const lines = ['[http]', `\tsslCAInfo = ${caFile.replaceAll('\\', '/')}`, ...(process.platform === 'win32' ? ['\tsslBackend = openssl'] : [])];
  fs.appendFileSync(path.join(home.home, '.gitconfig'), `${lines.join('\n')}\n`);
}

/** Launches the app with env and waits for its chat. */
export async function launchReady(launch: (options?: LaunchOptions) => Promise<DesktopApp>, env: Record<string, string>): Promise<DesktopApp> {
  const desktop = await launch({ env });
  await expect(chatInput(await activeChat(desktop.app))).toBeVisible();
  return desktop;
}

/** Settings on Accounts once core's first forgeAccountsChanged replaced the skeleton with the rows. */
export async function openAccounts(app: ElectronApplication): Promise<Page> {
  const overlay = await openSettingsModal(app, 'accounts');
  await expect(overlay.getByTestId('forge-loading')).toHaveCount(0);
  return overlay;
}

/** Opens Settings on Accounts, runs steps there, and closes Settings. */
export async function inAccounts(app: ElectronApplication, steps: (overlay: Page) => Promise<void>): Promise<void> {
  const overlay = await openAccounts(app);
  await steps(overlay);
  await closeSettingsModal(overlay);
}

/** A token sign-in on server; with login, waits until the server's row says it signed in. */
export async function tokenSignIn(overlay: Page, server: string, token: string, login?: string): Promise<void> {
  await overlay.getByRole('button', { name: `Add account: ${server}`, exact: true }).click();
  await overlay.getByRole('radio', { name: 'Token', exact: true }).click();
  await overlay.getByLabel('Personal access token', { exact: true }).fill(token);
  await overlay.getByRole('button', { name: 'Sign in', exact: true }).click();
  if (login !== undefined) await expect(overlay.getByTestId(`settings-row-forge-server-${server}`).getByText(`Signed in as ${login}`, { exact: true })).toBeVisible(SIGNED_IN);
}

/** A device code sign-in on server, the stub's stubServer, which approves the code as login: an OAuth token with a refresh token. */
export async function deviceSignIn(overlay: Page, server: string, stubServer: StubServer, login: string): Promise<void> {
  await overlay.getByRole('button', { name: `Add account: ${server}`, exact: true }).click();
  await overlay.getByRole('radio', { name: 'Device code', exact: true }).click();
  await overlay.getByRole('button', { name: 'Get a code', exact: true }).click();
  await expect(overlay.getByTestId('provider-sign-in-code')).toBeVisible();
  stubServer.approveDevice(login);
  await expect(overlay.getByText(`Signed in as ${login}`, { exact: true })).toBeVisible(SIGNED_IN);
}

/** Adds a self-managed GitLab server of the stub with its OAuth app, and gitHosts when given; returns its name in the app, its host. */
export async function addGitlabServer(overlay: Page, server: StubServer, gitHosts?: string): Promise<string> {
  await overlay.getByTestId('settings-row-forge-add-server').getByRole('button', { name: 'Add server', exact: true }).click();
  const form = overlay.getByTestId('forge-server-form');
  await form.getByLabel('Server URL', { exact: true }).fill(server.webUrl);
  await form.getByRole('radio', { name: 'GitLab', exact: true }).click();
  await form.getByLabel('OAuth app client id (optional)', { exact: true }).fill(server.spec.clientId!);
  if (gitHosts !== undefined) await form.getByLabel('Other git hosts (optional)', { exact: true }).fill(gitHosts);
  await form.getByTestId('forge-server-submit').click();
  await expect(form).toHaveCount(0);
  return new URL(server.webUrl).host;
}

/** Sets an account's "Agent shells may use this account" switch under its Manage. */
export async function setAgentShells(overlay: Page, server: string, login: string, on: boolean): Promise<void> {
  const line = overlay.getByTestId(`forge-account-${login}`);
  await line.getByRole('button', { name: `Manage: ${login} on ${server}` }).click();
  const toggle = line.getByRole('switch', { name: 'Agent shells may use this account' });
  if ((await toggle.getAttribute('aria-checked')) !== String(on)) await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', String(on));
}
