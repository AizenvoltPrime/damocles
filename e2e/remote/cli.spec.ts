import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopApp } from '../desktop/support/app';
import { runLocalCli } from '../desktop/support/cli';
import { activeTab, codeEditor, editorShows, editorTab, replaceText, saveWithKeyboard } from '../desktop/support/editor';
import { writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { lastToolResultRequest } from '../desktop/support/openai-stub';
import { readyOverlay } from '../desktop/support/overlay';
import { popupPage, shellPage, shellState } from '../desktop/support/shell';
import { hoverTerminalText, openTerminal, readFromTerminal, runInTerminal, terminalText } from '../desktop/support/terminal';
import { awaitTurnEnd, clickMenu } from '../desktop/support/ui';
import { openedExternally, recordOpenExternal } from '../desktop/support/updates';
import { messageDialog } from '../desktop/support/file-drops';
import { connectDialog, hostSearch, openConnect, trustQuestion } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { openRemoteHostSettings, setHostSwitch } from './support/host-settings-ui';
import { CURRENT_PACKAGE, daemonVersions, installOlderServer, OLD, switchToThisVersion, versionFolder } from './support/older-server';
import { portRow } from './support/ports-ui';
import { LINUX_TARGET, serverVersionOf } from './support/release-mirror';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test, type RemoteFixtures } from './support/remote';
import { TARGET_HOME, type SshdFixture } from './support/sshd';
import { newRemoteChat, startTargetStub } from './support/target-agent';

const APP = '/srv/app';
const MODIFIER = process.platform === 'darwin' ? 'Meta' : 'Control';
const DISCONNECT_HOST = 'damocles.remote.disconnectHost';
const CLOSE_EDITOR = 'damocles.editor.close';
const LINKS_SWITCH = 'Open links from billing-prod\'s terminals without asking';
const permissionCard = (tab: Page) => tab.locator('section[role="region"][aria-label="Permission request"]:not([class*="-leave-"])');
// the command a terminal finds on PATH: the run folder's active link, which each server points at its own package
const ACTIVE_DAMOCLES = /^\/home\/dev\/\.damocles\/server\/run-[0-9a-f]{16}\/active\/bin\/remote-cli\/damocles$/;

// the files each test opens on prod-1, owned by its user
const SEED = [
  'mkdir -p /srv/app/src /srv/other /srv/more',
  'seq 1 60 | sed "s/.*/const line& = &;/" > /srv/app/src/app.ts',
  'printf "one\\ntwo\\n" > /srv/app/a.txt',
  'printf "one\\nthree\\n" > /srv/app/b.txt',
  'chown -R dev:dev /srv/app /srv/other /srv/more',
].join(' && ');

interface Opened {
  readonly app: ElectronApplication;
  readonly shell: Page;
  readonly hostId: string;
  readonly projectKey: string;
  readonly fixture: SshdFixture;
}

/** prod-1 saved as billing-prod, /srv/app open as its project and a bash terminal open there. */
async function openOnProd(home: HermeticHome, launch: (options: { env: Record<string, string> }) => Promise<{ app: ElectronApplication }>, fixtures: Pick<RemoteFixtures, 'mirror' | 'ssh'>, sshd: RemoteFixtures['sshd']): Promise<Opened> {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await fixture.sh(SEED);
  const { app } = await launch({ env: remoteEnv(fixtures.ssh, fixtures.mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'billing-prod' });
  await openRemoteFolder(app, hostId, APP);
  const projectKey = await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(app);
  return { app, shell, hostId, projectKey, fixture };
}

let commands = 0;
/** Runs a command line in the terminal and resolves its exit status, read from a marker its own text does not show. */
async function exitOf(shell: Page, command: string): Promise<number> {
  const marker = `rc${++commands}x`;
  await runInTerminal(shell, `${command}; echo "${marker.slice(0, 2)}""${marker.slice(2)}=$?"`);
  return Number(await readFromTerminal(shell, new RegExp(`${marker}=(\\d+)`)));
}

test('in a remote terminal, damocles opens a file at its line, opens a file outside the projects editable, opens a missing file empty and creates it on save, asks before adding a folder, and opens --diff as a read-only Changes tab', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const { app, shell, hostId, projectKey, fixture } = await openOnProd(home, launch, { mirror, ssh }, sshd);
  await runInTerminal(shell, 'cd /srv/app');

  expect(await exitOf(shell, 'damocles src/app.ts:42')).toBe(0);
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('src/app.ts');
  await editorShows(shell, 'const line42 = 42;');
  const lineTop = await codeEditor(shell).locator('.view-line', { hasText: 'const line42 = 42;' }).evaluate((line) => (line as HTMLElement).style.top);
  await expect.poll(() => codeEditor(shell).locator('.view-overlays .current-line').first().evaluate((highlight) => (highlight.parentElement as HTMLElement).style.top)).toBe(lineTop);

  expect(await exitOf(shell, 'damocles /etc/hosts')).toBe(0);
  await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', title: 'hosts', host: `ssh+${hostId}`, readOnly: false, displayPath: '/etc/hosts' });
  await expect(editorTab(shell, 'hosts')).toHaveAttribute('title', 'billing-prod: /etc/hosts');
  await editorShows(shell, 'localhost');

  expect(await exitOf(shell, 'damocles new.txt')).toBe(0);
  await expect.poll(async () => activeTab(app)).toMatchObject({ kind: 'code', relativePath: 'new.txt', readOnly: false });
  expect(await fixture.sh('test -e /srv/app/new.txt && echo exists || echo missing', 'dev')).toBe('missing\n');
  await replaceText(codeEditor(shell), 'created by the save\n');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
  await saveWithKeyboard(app);
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(false);
  expect(await fixture.sh('cat /srv/app/new.txt', 'dev')).toBe('created by the save\n');

  const added = exitOf(shell, 'damocles /srv/other');
  const overlay = await readyOverlay(app);
  const ask = messageDialog(overlay, 'Add /srv/other on billing-prod as a project?');
  await expect(ask).toBeVisible({ timeout: 30_000 });
  await ask.getByRole('button', { name: 'Add Project', exact: true }).click();
  await trustQuestion(overlay, '/srv/other', 'billing-prod').getByRole('button', { name: 'Trust Folder' }).click();
  expect(await added).toBe(0);
  await expect.poll(async () => (await shellState(app)).projects.filter((project) => project.authority.kind === 'ssh').map((project) => project.fsPath).sort()).toEqual(['/srv/app', '/srv/other']);

  // the terminal still belongs to /srv/app's project
  await shell.evaluate((key) => window.damoclesShell!.selectProject(key), projectKey);
  expect(await exitOf(shell, 'damocles --diff a.txt b.txt')).toBe(0);
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('changes');
  const diff = (await activeTab(app))!;
  expect(diff.title).toBe('a.txt ↔ b.txt');
  expect(diff.patch).toMatchObject({ left: { name: 'a.txt', path: '/srv/app/a.txt' }, right: { name: 'b.txt', path: '/srv/app/b.txt' } });

  // the agent's Bash tool on the same host sees none of the terminal's variables
  const stub = await startTargetStub(home, fixture);
  try {
    const tab = await newRemoteChat(app, projectKey);
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'printf "hook=[%s] browser=[%s] " "${DAMOCLES_CLI_HOOK-unset}" "${BROWSER-unset}"; case ":$PATH:" in *remote-cli*) echo path=has-remote-cli ;; *) echo path=clean ;; esac' } }] },
      { chunks: ['Checked.'] },
    );
    await sendPrompt(tab, 'Show the environment');
    await permissionCard(tab).getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(tab.getByText('Checked.')).toBeVisible({ timeout: 60_000 });
    await awaitTurnEnd(tab);
    expect(lastToolResultRequest(stub)).toContain('hook=[unset] browser=[unset] path=clean');
    // while the terminal of the same host has all three
    expect(await exitOf(shell, 'test -S "$DAMOCLES_CLI_HOOK" && case ":$PATH:" in *:/home/dev/.damocles/server/*/bin/remote-cli:*) true ;; *) false ;; esac && test -x "$BROWSER"')).toBe(0);
  } finally {
    await stub.close();
  }
  await shutdownHostDaemon(app, hostId, fixture);
});

test('GIT_EDITOR="damocles --wait" git commit waits for the tab and commits the saved message; with no client attached the command says so', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const { app, shell, hostId, fixture } = await openOnProd(home, launch, { mirror, ssh }, sshd);
  await fixture.sh('cd /srv/app && git init -q && git config user.email dev@example.test && git config user.name Dev && git add a.txt && true', 'dev');
  await runInTerminal(shell, 'cd /srv/app');
  const committed = exitOf(shell, 'GIT_EDITOR="damocles --wait" git commit -q');
  await expect.poll(async () => (await activeTab(app))?.relativePath, { timeout: 30_000 }).toBe('.git/COMMIT_EDITMSG');
  await editorShows(shell, '# Please enter the commit message');
  // the commit waits while the tab is open
  expect(await fixture.sh('cd /srv/app && git rev-list --count --all 2>/dev/null || echo 0', 'dev')).toBe('0\n');
  await replaceText(codeEditor(shell), 'Saved from Damocles\n');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
  await saveWithKeyboard(app);
  // a close while the save is on its way would ask Save or Don't Save
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(false);
  expect(await fixture.sh('cat /srv/app/.git/COMMIT_EDITMSG', 'dev')).toBe('Saved from Damocles\n');
  await clickMenu(app, CLOSE_EDITOR);
  expect(await committed).toBe(0);
  expect(await fixture.sh('cd /srv/app && git log -1 --format=%s', 'dev')).toBe('Saved from Damocles\n');

  // the terminal's socket with no client attached: Disconnect Host leaves the daemon and the terminal running
  expect(await exitOf(shell, 'printf "%s\\n%s\\n" "$DAMOCLES_CLI_HOOK" "$(command -v damocles)" > /tmp/damocles-cli')).toBe(0);
  const [hook, damocles] = (await fixture.sh('cat /tmp/damocles-cli', 'dev')).trim().split('\n');
  expect(hook).toMatch(/^\/tmp\/damocles-[^/]+\/cli-[0-9a-f]{24}\.sock$/);
  expect(damocles).toMatch(ACTIVE_DAMOCLES);
  await clickMenu(app, DISCONNECT_HOST);
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.fsPath === APP)?.connection).not.toBe('connected');
  const answer = await fixture.sh(`cd /srv/app && DAMOCLES_CLI_HOOK='${hook}' '${damocles}' README.md 2>&1; echo "status=$?"`, 'dev');
  expect(answer).toBe('damocles: Damocles is not connected to this host.\nstatus=1\n');
  await openRemoteFolder(app, hostId, APP);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('BROWSER links from a remote terminal: xdg-open asks, the host\'s switch skips the notice, a loopback port is forwarded first, and a clicked localhost link opens with no notice', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const { app, shell, hostId, fixture } = await openOnProd(home, launch, { mirror, ssh }, sshd);
  await recordOpenExternal(app);

  expect(await exitOf(shell, 'xdg-open https://example.test/login')).toBe(0);
  // the popup window exists once the first notice asks for it
  const popup = await popupPage(app);
  const notices = popup.locator('[data-testid="overlay-toast"][data-kind="link"]');
  const notice = notices.filter({ has: popup.getByTestId('link-url').getByText('https://example.test/login', { exact: true }) });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(notice.getByTestId('link-title')).toContainText('billing-prod');
  expect(await openedExternally(app)).toEqual([]);
  await notice.getByRole('button', { name: 'Open' }).click();
  await expect.poll(() => openedExternally(app)).toEqual(['https://example.test/login']);

  // a link the user clicks in the terminal opens at once, its loopback port forwarded
  await runInTerminal(shell, 'echo "dev server at http://localhost:5173/"');
  await expect.poll(async () => (await terminalText(shell)).split('\n').includes('dev server at http://localhost:5173/')).toBe(true);
  await hoverTerminalText(shell, 'dev server at http://localhost:5173/', 'localhost:5173');
  await shell.keyboard.down(MODIFIER);
  await shell.mouse.down();
  await shell.mouse.up();
  await shell.keyboard.up(MODIFIER);
  await expect.poll(async () => (await openedExternally(app)).length).toBe(2);
  expect((await openedExternally(app))[1]).toMatch(/^http:\/\/localhost:\d+\/$/);
  await expect(portRow(shell, 5173)).toBeVisible({ timeout: 30_000 });
  await expect(notices).toHaveCount(0);

  // with the host's switch on, its terminals' links open with no notice
  const { overlay, block } = await openRemoteHostSettings(app, hostId);
  await setHostSwitch(block, LINKS_SWITCH, true);
  await overlay.keyboard.press('Escape');
  expect(await exitOf(shell, '"$BROWSER" https://example.test/second')).toBe(0);
  await expect.poll(async () => (await openedExternally(app)).at(-1)).toBe('https://example.test/second');
  expect(await exitOf(shell, '"$BROWSER" http://localhost:8123/cb')).toBe(0);
  await expect.poll(async () => (await openedExternally(app)).at(-1)).toMatch(/^http:\/\/localhost:\d+\/cb$/);
  await expect(portRow(shell, 8123)).toBeVisible({ timeout: 30_000 });
  await expect(notices).toHaveCount(0);
  await shutdownHostDaemon(app, hostId, fixture);
});

test('damocles --remote on this computer opens a folder on a saved host by its name or alias, ignoring case, follows a rename, and an unknown host fills the Connect dialog', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const { app, hostId, fixture } = await openOnProd(home, launch, { mirror, ssh }, sshd);
  const overlay = await readyOverlay(app);
  const addAnswering = async (folder: string, host: string, run: Promise<{ code: number | null }>): Promise<void> => {
    const ask = messageDialog(overlay, `Add ${folder} on ${host} as a project?`);
    await expect(ask).toBeVisible({ timeout: 60_000 });
    await ask.getByRole('button', { name: 'Add Project', exact: true }).click();
    await trustQuestion(overlay, folder, host).getByRole('button', { name: 'Trust Folder' }).click();
    expect((await run).code).toBe(0);
    await expect.poll(async () => (await shellState(app)).projects.some((project) => project.fsPath === folder)).toBe(true);
  };

  await addAnswering('/srv/other', 'billing-prod', runLocalCli(home, ['--remote', 'ssh+billing-prod', '/srv/other']));
  // already a project: selected, nothing asked
  expect((await runLocalCli(home, ['--remote', 'ssh+PROD-1', '/srv/app'])).code).toBe(0);
  await expect.poll(async () => { const state = await shellState(app); return state.projects.find((project) => project.key === state.selected.projectKey)?.fsPath; }).toBe(APP);

  // Rename on the host card: the new name resolves, in any case, and the old one names no saved host
  const dialog = connectDialog(overlay);
  await openConnect(app);
  await dialog.getByRole('button', { name: 'Details for billing-prod' }).click();
  const card = overlay.getByTestId('host-card');
  await card.getByRole('button', { name: 'Rename billing-prod' }).click();
  const field = card.getByRole('textbox', { name: 'Host name' });
  await field.fill('billing');
  await field.press('Enter');
  await expect(card.getByRole('heading', { name: 'billing', exact: true })).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  await addAnswering('/srv/more', 'billing', runLocalCli(home, ['--remote', 'ssh+BILLING', '/srv/more']));
  expect((await runLocalCli(home, ['--remote', 'ssh+billing-prod', '/srv/app'])).code).toBe(0);
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(hostSearch(overlay)).toHaveValue('billing-prod');
  await overlay.keyboard.press('Escape');
  expect((await shellState(app)).projects.filter((project) => project.authority.kind === 'ssh')).toHaveLength(3);
  await shutdownHostDaemon(app, hostId, fixture);
});

interface OnOlderServer {
  readonly old: DesktopApp;
  readonly env: Record<string, string>;
  readonly hostId: string;
  readonly fixture: SshdFixture;
  // the shell's DAMOCLES_CLI_HOOK, BROWSER and damocles command, one per line
  readonly before: string;
  readonly hook: string;
  readonly damocles: string;
}

/** A bash terminal in /srv/app on prod-1, started under the app before an update, whose server is this package installed as OLD. */
async function terminalOnOlderServer(home: HermeticHome, launch: (options: { env: Record<string, string> }) => Promise<DesktopApp>, fixtures: Pick<RemoteFixtures, 'mirror' | 'ssh'>, sshd: RemoteFixtures['sshd']): Promise<OnOlderServer> {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never' });
  const fixture = await sshd('prod-1');
  await fixture.sh(SEED);
  await installOlderServer(fixture, CURRENT_PACKAGE, { version: OLD });
  const env = remoteEnv(fixtures.ssh, fixtures.mirror);
  const old = await launch({ env: { ...env, DAMOCLES_E2E_APP_VERSION: OLD } });
  const hostId = await addHost(old.app, { alias: 'prod-1', name: 'billing-prod' });
  await openRemoteFolder(old.app, hostId, APP);
  await remoteProjectKey(old.app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await openTerminal(old.app);
  await runInTerminal(shell, 'cd /srv/app');
  expect(await exitOf(shell, 'printf "%s\\n%s\\n%s\\n" "$DAMOCLES_CLI_HOOK" "$BROWSER" "$(command -v damocles)" > /tmp/before-env')).toBe(0);
  const before = await fixture.sh('cat /tmp/before-env', 'dev');
  const [hook, , damocles] = before.trim().split('\n');
  expect(hook).toMatch(/^\/tmp\/damocles-[^/]+\/cli-[0-9a-f]{24}\.sock$/);
  expect(damocles).toMatch(ACTIVE_DAMOCLES);
  expect(await daemonVersions(fixture)).toEqual([OLD]);
  return { old, env, hostId, fixture, before, hook: hook!, damocles: damocles! };
}

test('in a terminal that survived a server switch, damocles opens a file and BROWSER asks through the new server, from the endpoints the shell started with', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const older = await terminalOnOlderServer(home, launch, { mirror, ssh }, sshd);
  await older.old.close();
  const { fixture } = older;
  const app = await switchToThisVersion(launch, older.env, older.hostId, fixture);
  const shell = await shellPage(app);
  expect(await exitOf(shell, 'printf "%s\\n%s\\n%s\\n" "$DAMOCLES_CLI_HOOK" "$BROWSER" "$(command -v damocles)" > /tmp/after-env')).toBe(0);
  expect(await fixture.sh('cat /tmp/after-env', 'dev')).toBe(older.before);
  // the same path now runs this version's command
  expect((await fixture.sh(`readlink ${TARGET_HOME}/.damocles/server/run-*/active`, 'dev')).trim()).toBe(versionFolder(serverVersionOf(LINUX_TARGET)));

  expect(await exitOf(shell, 'damocles src/app.ts:42')).toBe(0);
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('src/app.ts');
  await editorShows(shell, 'const line42 = 42;');

  await recordOpenExternal(app);
  expect(await exitOf(shell, '"$BROWSER" https://example.test/survived')).toBe(0);
  const popup = await popupPage(app);
  const notice = popup.locator('[data-testid="overlay-toast"][data-kind="link"]').filter({ has: popup.getByTestId('link-url').getByText('https://example.test/survived', { exact: true }) });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await notice.getByRole('button', { name: 'Open' }).click();
  await expect.poll(() => openedExternally(app)).toEqual(['https://example.test/survived']);
  await shutdownHostDaemon(app, older.hostId, fixture);
});

test('a damocles open typed during a server switch waits while no server runs and completes once the new server is up', { tag: SSH_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const older = await terminalOnOlderServer(home, launch, { mirror, ssh }, sshd);
  const { fixture } = older;
  await older.old.close();
  // installed already, so the switch only starts a daemon, well inside the host's hold of the waiting connection
  await installOlderServer(fixture, CURRENT_PACKAGE);
  // the older server stops; the terminal's host runs on and holds what reaches the terminal's socket meanwhile
  await fixture.sh("pkill -TERM -u dev -f 'dist/daemon.js serve'");
  await expect.poll(() => daemonVersions(fixture), { timeout: 30_000 }).toEqual([]);
  await fixture.sh(`cd /srv/app && nohup sh -c "DAMOCLES_CLI_HOOK='${older.hook}' '${older.damocles}' src/app.ts:7 > /tmp/during.out 2>&1; echo status=\\$? >> /tmp/during.out" > /dev/null 2>&1 &`, 'dev');
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(await fixture.sh('cat /tmp/during.out 2>/dev/null || true', 'dev')).toBe('');

  const app = await switchToThisVersion(launch, older.env, older.hostId, fixture);
  await expect.poll(() => fixture.sh('cat /tmp/during.out 2>/dev/null || true', 'dev'), { timeout: 60_000 }).toBe('status=0\n');
  await expect.poll(async () => (await activeTab(app))?.relativePath).toBe('src/app.ts');
  await shutdownHostDaemon(app, older.hostId, fixture);
});
