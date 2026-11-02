import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { filesRow } from '../desktop/support/editor';
import { seedStubModel, writeUserSettings, type HermeticHome } from '../desktop/support/hermetic';
import { clientCredentialHelper, newGitPassword, scmPush, startHttpsGitServer } from './support/git-credentials';
import { gitConsent, openRemoteHostSettings, setHostSwitch, storedHost } from './support/host-settings-ui';
import { closeSettingsModal, settingsModal } from '../desktop/support/settings';
import { answerToast, recordedToasts, recordToasts } from '../desktop/support/shell';
import { activeTerminal, openTerminal, terminalRows } from '../desktop/support/terminal';
import { startSshAgentStub } from './support/ssh-agent-stub';
import { git as gitIn, initRepo } from '../desktop/support/git';
import { sendPrompt } from '../desktop/support/loopback-agent';
import { startOpenAIStub, STUB_MODEL_ID, type OpenAIStub } from '../desktop/support/openai-stub';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { listChats, projectRow } from '../desktop/support/shell-ui';
import { connectDialog, openConnect } from './support/connect-ui';
import { shootThemes } from './support/review-shots';
import { agentInTerminal, agentSockets, CONTAINER_ENV, containerHosts, engine, containerServerProcesses, copyFixture, DEVCONTAINER_TAG, editConfig, inContainer, leftovers, removeLeftovers, shutdownContainerDaemon, upOutsideDamocles, type ContainerHost } from './support/devcontainer';
import { exited, requestQuit, closeRemoteDialog } from './support/remote-runs';
import { expect, lastConnectStep, test } from './support/remote';
import { containerReachableAddress, HOST_FROM_CONTAINER, runProgram, type SshdFixture } from './support/sshd';
import { newRemoteChat } from './support/target-agent';

// a tool call that outlives the app's quit, then the file it leaves in the workspace folder
const WORK = 'sleep 15 && echo finished > done.txt';
// a dev server the agent starts inside the container, which the Ports section forwards
const SERVE_PORT = 5179;
const SERVE = `node serve.js ${SERVE_PORT}`;
const GIT_USER = 'relay-user';

/** The local port the Ports section forwards a container port to, once it shows forwarded. */
async function forwardedPort(shell: Page, hostId: string, remotePort: number): Promise<number | undefined> {
  const view = await shell.evaluate((id) => window.damoclesShell!.ports.get(id), hostId);
  const row = view?.rows.find((candidate) => candidate.remotePort === remotePort && candidate.state === 'forwarded');
  return row?.localPort;
}

/** The commit `ref` names in the HTTPS server's bare repository, or undefined while it does not exist. */
async function serverRef(home: Pick<HermeticHome, 'root'>, ref: string): Promise<string | undefined> {
  const result = await runProgram('git', ['--git-dir', path.join(home.root, 'git-server', 'app.git'), 'rev-parse', '--verify', '--quiet', ref]);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

// an account on the git fixture that accepts only the agent stub's key, and its bare repository
const SSH_GIT_USER = 'gitremote';
const SSH_BARE = '/srv/git/app.git';

/** The git fixture's bare repository's main, or '' while it has none. */
const bareHead = async (fixture: SshdFixture): Promise<string> => (await fixture.sh(`git --git-dir ${SSH_BARE} rev-parse --verify --quiet refs/heads/main || true`)).trim();

/** The newest notice since `after` offering the agent forwarding action for the host, once one shows. */
async function forwardingOffer(app: ElectronApplication, after: number, hostName: string): Promise<{ id: string }> {
  let found: { id: string } | undefined;
  await expect.poll(async () => (found = (await recordedToasts(app)).slice(after).find((toast) => toast.actions.includes(`Forward your SSH agent to ${hostName}`))), { timeout: 60_000 }).toBeDefined();
  return found!;
}

/** The trust question main asks for a local folder (TrustStore.requestTrust). */
const folderTrust = (overlay: Page, folder: string) => overlay.getByRole('alertdialog', { name: `Do you trust the authors of the files in ${folder}?` });

/** Right-clicks the project and picks Reopen in Container from its menu. */
async function reopenInContainer(app: ElectronApplication, projectKey: string): Promise<Page> {
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  await projectRow(shell, projectKey).click({ button: 'right' });
  await overlay.getByRole('menuitem', { name: 'Reopen in Container' }).click();
  return overlay;
}

/** The container record of the folder once main made it. */
async function recordOf(app: ElectronApplication): Promise<ContainerHost> {
  let found: ContainerHost | undefined;
  await expect.poll(async () => (found = (await containerHosts(app))[0])).toBeDefined();
  return found!;
}

/** The container's projects as the shell lists them. */
async function containerProject(app: ElectronApplication, authorityKey: string): Promise<{ key: string; trusted: boolean; connection: string } | undefined> {
  return (await shellState(app)).projects.find((project) => project.key.startsWith(`${authorityKey}|`));
}

/** The model stub as the container's agent reaches it: this computer's key and model, the container user's provider list. */
async function containerStub(home: Parameters<typeof seedStubModel>[0], containerId: string): Promise<OpenAIStub> {
  const stub = await startOpenAIStub({ listenAddress: await containerReachableAddress(), hostName: HOST_FROM_CONTAINER });
  seedStubModel(home, stub.baseUrl);
  const models = { providers: { openai: { baseUrl: stub.baseUrl, api: 'openai-completions', models: [{ id: STUB_MODEL_ID, name: 'Stub model', reasoning: false, input: ['text'], contextWindow: 272000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } };
  await inContainer(containerId, `mkdir -p "$HOME/.damocles/pi/agent" && printf '%s' '${JSON.stringify(models)}' > "$HOME/.damocles/pi/agent/models.json"`, 'node');
  return stub;
}

test.describe('Dev Containers on this computer', () => {
  test.describe.configure({ mode: 'default' });

  test('an untrusted folder never runs up; a trusted one shows its initializeCommand and mounts, builds with its log, opens inside the container, and a changed runArgs asks again on Rebuild, which keeps trust, layout and mirrored chats', { tag: DEVCONTAINER_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(900_000);
    const folder = copyFixture(home.root);
    fs.writeFileSync(path.join(home.userData, 'projects.json'), JSON.stringify({ version: 1, projects: [folder] }));
    const keys: string[] = [];
    let stub: OpenAIStub | undefined;
    const { app } = await launch({ env: CONTAINER_ENV });
    let record: ContainerHost | undefined;
    try {
      const local = (await shellState(app)).projects.find((project) => project.fsPath === folder)!;
      expect(local.trusted).toBe(false);

      // untrusted: Don't Trust runs nothing, not even read-configuration or the initializeCommand
      let overlay = await reopenInContainer(app, local.key);
      await folderTrust(overlay, folder).getByRole('button', { name: 'Don\'t Trust' }).click();
      record = await recordOf(app);
      keys.push(record.container);
      await expect.poll(async () => (await lastConnectStep(app, record!.hostId))?.failure?.code, { timeout: 60_000 }).toBe('folderUntrusted');
      expect(fs.existsSync(path.join(folder, 'init-ran.txt'))).toBe(false);
      expect((await leftovers(keys)).containers).toEqual([]);
      await overlay.keyboard.press('Escape');
      await expect(connectDialog(overlay)).toBeHidden();

      // trusted: the confirmation lists what runs on this computer and what mounts, then the build log streams
      overlay = await reopenInContainer(app, local.key);
      await folderTrust(overlay, folder).getByRole('button', { name: 'Trust Folder' }).click();
      const trust = overlay.getByTestId('devcontainer-trust');
      await expect(trust).toBeVisible({ timeout: 300_000 });
      await expect(trust.locator('[data-testid="devcontainer-trust-item"][data-field="initializeCommand"]')).toContainText('echo ran > init-ran.txt');
      await expect(trust.locator('[data-testid="devcontainer-trust-item"][data-field="mounts"]')).toContainText('/devcontainer-config');
      expect(fs.existsSync(path.join(folder, 'init-ran.txt'))).toBe(false);
      await trust.getByTestId('devcontainer-trust-accept').click();
      await expect(overlay.getByTestId('build-log')).toBeVisible({ timeout: 300_000 });
      await expect.poll(async () => (await containerProject(app, record!.authorityKey))?.connection, { timeout: 600_000 }).toBe('connected');
      const step = await lastConnectStep(app, record.hostId);
      expect(step?.visited).toEqual(['building', 'connecting', 'checking', 'installing', 'starting']);
      expect(fs.existsSync(path.join(folder, 'init-ran.txt'))).toBe(true);
      const project = (await containerProject(app, record.authorityKey))!;
      expect(project.trusted).toBe(true);
      expect((await shellState(app)).selected.projectKey).toBe(project.key);
      await expect(connectDialog(overlay)).toBeHidden();
      const shell = await shellPage(app);
      await expect(filesRow(shell, 'README.md')).toBeVisible({ timeout: 60_000 });
      const first = (await recordOf(app)).containerId!;
      expect(first).toMatch(/^[0-9a-f]{64}$/);
      // the agent runs inside the container: its chat answers through the stub, and its session lives there
      stub = await containerStub(home, first);
      stub.replies.push({ chunks: ['Hello from the container.'] });
      const tab = await newRemoteChat(app, project.key);
      await sendPrompt(tab, 'say hello');
      await expect(tab.getByText('Hello from the container.', { exact: false })).toBeVisible({ timeout: 120_000 });
      let chats: string[] = [];
      await expect.poll(async () => (chats = (await listChats(app, project.key)).chats.filter((chat) => !chat.id.startsWith('new:')).map((chat) => chat.id)).length, { timeout: 60_000 }).toBeGreaterThan(0);
      expect(await inContainer(first, 'ls "$HOME/.damocles/pi/agent/sessions" | wc -l', 'node')).not.toBe('0\n');

      // a changed runArgs: Rebuild asks again, naming the change, before anything stops
      editConfig(folder, (config) => ({ ...config, runArgs: [...(config['runArgs'] as string[]), '--env', 'DAMOCLES_E2E_CHANGED=1'] }));
      await projectRow(shell, project.key).click({ button: 'right' });
      await overlay.getByRole('menuitem', { name: 'Rebuild Container...' }).click();
      const rebuild = overlay.getByTestId('rebuild-container-dialog');
      await expect(rebuild).toBeVisible();
      await rebuild.getByTestId('rebuild-container-confirm').click();
      await expect(trust).toBeVisible({ timeout: 300_000 });
      await expect(trust.locator('[data-testid="devcontainer-trust-item"][data-field="runArgs"]')).toContainText('DAMOCLES_E2E_CHANGED=1');
      expect(await containerServerProcesses(first)).not.toEqual([]);
      await trust.getByTestId('devcontainer-trust-accept').click();
      await expect(overlay.getByTestId('rebuild-container-done')).toBeVisible({ timeout: 600_000 });
      const rebuilt = await recordOf(app);
      expect(rebuilt.containerId).not.toBe(first);
      expect(rebuilt.authorityKey).toBe(record.authorityKey);
      // trust and layout by the same project key, and the chats from the data volume and the mirror
      await expect.poll(async () => (await containerProject(app, record!.authorityKey))?.connection, { timeout: 120_000 }).toBe('connected');
      expect((await containerProject(app, record.authorityKey))?.key).toBe(project.key);
      expect((await containerProject(app, record.authorityKey))?.trusted).toBe(true);
      await expect.poll(async () => (await listChats(app, project.key)).chats.map((chat) => chat.id), { timeout: 60_000 }).toEqual(expect.arrayContaining(chats));
      expect(await inContainer(rebuilt.containerId!, 'printenv DAMOCLES_E2E_CHANGED')).toBe('1\n');
      await overlay.keyboard.press('Escape');
    } finally {
      const last = (await containerHosts(app).catch(() => []))[0];
      if (last?.containerId !== undefined && (await containerServerProcesses(last.containerId).catch(() => [])).length > 0) await shutdownContainerDaemon(app, last.hostId, last.containerId);
      await stub?.close();
      await removeLeftovers(keys);
    }
  });

  test('a container the devcontainer CLI made without Damocles\' data volume connects with ~/.damocles inside it, and says once that its chats go with a rebuild, offering Rebuild Container', { tag: DEVCONTAINER_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(900_000);
    const folder = copyFixture(home.root);
    fs.writeFileSync(path.join(home.userData, 'projects.json'), JSON.stringify({ version: 1, projects: [folder] }));
    fs.writeFileSync(path.join(home.userData, 'trusted-folders.json'), JSON.stringify({ version: 1, folders: [folder] }));
    const keys: string[] = [];
    const { app } = await launch({ env: CONTAINER_ENV });
    try {
      // the fixture's runArgs label the container, so teardown finds it by the e2e label like every other
      const made = await upOutsideDamocles(folder);
      await recordToasts(app);
      const local = (await shellState(app)).projects.find((project) => project.fsPath === folder)!;
      const overlay = await reopenInContainer(app, local.key);
      await overlay.getByTestId('devcontainer-trust').getByTestId('devcontainer-trust-accept').click({ timeout: 300_000 });
      const record = await recordOf(app);
      keys.push(record.container);
      await expect.poll(async () => (await containerProject(app, record.authorityKey))?.connection, { timeout: 600_000 }).toBe('connected');
      // up reused the CLI's container, which has no data volume: no volume was made, and ~/.damocles is a folder in it
      expect((await recordOf(app)).containerId).toBe(made);
      expect((await leftovers(keys)).volumes).toEqual([]);
      expect(await inContainer(made, 'if [ -L ~/.damocles ]; then echo link; elif [ -d ~/.damocles ]; then echo folder; fi', 'node')).toBe('folder\n');
      const notices = async () => (await recordedToasts(app)).filter((toast) => toast.message.startsWith('Damocles did not create this container'));
      await expect.poll(async () => (await notices()).length, { timeout: 60_000 }).toBe(1);
      const [notice] = await notices();
      expect(notice).toMatchObject({ severity: 'warning', actions: ['Rebuild Container...'] });
      // its action opens the container's Rebuild confirmation, which stops nothing until confirmed
      await answerToast(app, notice!.id, 'Rebuild Container...');
      await expect(overlay.getByTestId('rebuild-container-dialog')).toBeVisible({ timeout: 60_000 });
      await overlay.keyboard.press('Escape');
      await expect(overlay.getByTestId('rebuild-container-volume')).toBeVisible();
      expect(await containerServerProcesses(made)).not.toEqual([]);
      await overlay.keyboard.press('Escape');
      await expect(connectDialog(overlay)).toBeHidden();
      expect(await notices()).toHaveLength(1);
    } finally {
      const last = (await containerHosts(app).catch(() => []))[0];
      if (last?.containerId !== undefined && (await containerServerProcesses(last.containerId).catch(() => [])).length > 0) await shutdownContainerDaemon(app, last.hostId, last.containerId);
      await removeLeftovers(keys);
    }
  });

  test('a push from the container uses this computer\'s git credential after consent, keyed by the container\'s host; the agent runs inside it, its dev server port forwards, and a run continues after quit', { tag: DEVCONTAINER_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(900_000);
    const folder = copyFixture(home.root);
    const password = newGitPassword();
    const server = await startHttpsGitServer(home, 'app', GIT_USER, password);
    const helper = clientCredentialHelper(home, server.host, GIT_USER, password);
    // the repository and its remote exist before the app starts: this computer's source control of the local project would
    // otherwise read the bind-mounted .git while git in the container rewrites it
    await initRepo(home, folder, {});
    await gitIn(home, folder, 'remote', 'add', 'origin', server.url('app.git'));
    await gitIn(home, folder, 'config', 'branch.main.remote', 'origin');
    await gitIn(home, folder, 'config', 'branch.main.merge', 'refs/heads/main');
    const head = await gitIn(home, folder, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(home.userData, 'projects.json'), JSON.stringify({ version: 1, projects: [folder] }));
    fs.writeFileSync(path.join(home.userData, 'trusted-folders.json'), JSON.stringify({ version: 1, folders: [folder] }));
    const keys: string[] = [];
    let stub: OpenAIStub | undefined;
    let containerId: string | undefined;
    writeUserSettings(home, { 'damocles.desktop.remote.closeWithRunningAgents': 'ask' });
    let desktop = await launch({ env: CONTAINER_ENV });
    let { app } = desktop;
    try {
      const local = (await shellState(app)).projects.find((project) => project.fsPath === folder)!;
      const overlay = await reopenInContainer(app, local.key);
      await overlay.getByTestId('devcontainer-trust').getByTestId('devcontainer-trust-accept').click({ timeout: 300_000 });
      const record = await recordOf(app);
      keys.push(record.container);
      await expect.poll(async () => (await containerProject(app, record.authorityKey))?.connection, { timeout: 600_000 }).toBe('connected');
      const project = (await containerProject(app, record.authorityKey))!;
      containerId = (await recordOf(app)).containerId!;

      // the git credential relay: the container's git asks this computer's helper once, after consent for the container's host
      await inContainer(containerId, [
        `printf '%s' '${Buffer.from(server.caPem).toString('base64')}' | base64 -d > "$HOME/e2e-ca.pem"`,
        `git config --global http.sslCAInfo "$HOME/e2e-ca.pem"`,
      ].join(' && '), 'node');
      await scmPush(app, true);
      const consent = gitConsent(await overlayPage(app));
      await expect(consent).toBeVisible({ timeout: 60_000 });
      await expect(consent).toHaveAccessibleName(`${record.name} wants to use your saved credentials for ${server.host}`);
      await consent.getByRole('button', { name: `Always for ${record.name}`, exact: true }).click();
      await expect.poll(() => serverRef(home, 'refs/heads/main'), { timeout: 60_000 }).toBe(head);
      expect(helper.calls()).toEqual(['get']);
      expect(storedHost(home, record.hostId)?.alwaysCredentialHosts).toEqual([server.host]);

      stub = await containerStub(home, containerId);
      const command = `${SERVE} & ${WORK}`;
      // the turn's command runs unasked (the container user's Claude settings), so it goes on with no device attached
      await inContainer(containerId, `mkdir -p "$HOME/.claude" && printf '%s' '${JSON.stringify({ permissions: { allow: [`Bash(${command})`] } })}' > "$HOME/.claude/settings.json"`, 'node');
      stub.replies.push({ chunks: ['Working.'], toolCalls: [{ name: 'bash', arguments: { command } }] }, { chunks: ['All done.'] });
      const tab = await newRemoteChat(app, project.key);
      await sendPrompt(tab, 'start the server and work');
      await expect(tab.getByText('Working.', { exact: false })).toBeVisible({ timeout: 120_000 });
      // the port the agent's server listens on inside the container forwards to this computer, on the local port the Ports
      // section names (5179 unless something here holds it)
      const shell = await shellPage(app);
      let localPort: number | undefined;
      await expect.poll(async () => (localPort = (await forwardedPort(shell, record.hostId, SERVE_PORT))), { timeout: 120_000 }).toBeDefined();
      await expect.poll(async () => {
        const response = await fetch(`http://127.0.0.1:${localPort!}/`).catch(() => undefined);
        return response?.ok ? response.text() : undefined;
      }, { timeout: 60_000 }).toBe('dc-port');
      // quitting with Keep running leaves the turn running in the container
      await requestQuit(app);
      const { dialog } = await closeRemoteDialog(app);
      await dialog.getByRole('button', { name: 'Keep running' }).click();
      await exited(desktop);
      // the app is gone; the container and its daemon stay, and the turn goes on to its end
      await expect.poll(() => inContainer(containerId!, `cat /workspaces/${path.basename(folder)}/done.txt 2>/dev/null || true`), { timeout: 120_000 }).toBe('finished\n');
      expect(await containerServerProcesses(containerId)).not.toEqual([]);
      desktop = await launch({ env: CONTAINER_ENV });
      ({ app } = desktop);
      await expect.poll(async () => (await containerProject(app, record.authorityKey))?.connection, { timeout: 300_000 }).toBe('connected');
    } finally {
      const last = (await containerHosts(app).catch(() => []))[0];
      if (last?.containerId !== undefined && (await containerServerProcesses(last.containerId).catch(() => [])).length > 0) await shutdownContainerDaemon(app, last.hostId, last.containerId);
      await stub?.close();
      await removeLeftovers(keys);
      await server.close();
    }
  });
  test('this computer\'s SSH agent reaches the container only behind the container\'s own switch: a publickey push failure offers it, a terminal and a push over ssh then use it, and turning it off closes the socket at once with no reconnect', { tag: DEVCONTAINER_TAG }, async ({ foreground: _foreground, home, launch, sshd }) => {
    test.setTimeout(900_000);
    // the launch names the stub as this computer's agent, so nothing here can reach the developer's own
    const agent = await startSshAgentStub(home.root);
    // the git server: an account that accepts only the stub's key, on the engine's default bridge as the container is
    const git = await sshd('git-1');
    await git.sh([
      `useradd -m -s /bin/sh ${SSH_GIT_USER}`,
      `usermod -p '*' ${SSH_GIT_USER}`,
      `cat > /etc/ssh/authorized_keys/${SSH_GIT_USER}`,
      `chmod 644 /etc/ssh/authorized_keys/${SSH_GIT_USER}`,
      'mkdir -p /srv/git',
      `git init -q --bare -b main ${SSH_BARE}`,
      `chown -R ${SSH_GIT_USER}:${SSH_GIT_USER} /srv/git`,
    ].join(' && '), 'root', `${agent.publicKey}\n`);
    const gitAddress = (await engine(['inspect', '--format', '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}', git.container])).trim();
    // the repository and its ssh remote exist before the container does, so its source control knows them from its start
    const folder = copyFixture(home.root);
    await initRepo(home, folder, {});
    await gitIn(home, folder, 'remote', 'add', 'origin', `${SSH_GIT_USER}@${gitAddress}:${SSH_BARE}`);
    await gitIn(home, folder, 'config', 'core.sshCommand', 'ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null');
    const head = await gitIn(home, folder, 'rev-parse', 'HEAD');
    fs.writeFileSync(path.join(home.userData, 'projects.json'), JSON.stringify({ version: 1, projects: [folder] }));
    fs.writeFileSync(path.join(home.userData, 'trusted-folders.json'), JSON.stringify({ version: 1, folders: [folder] }));
    writeUserSettings(home, { 'damocles.desktop.terminal.confirmOnKill': 'never' });
    const keys: string[] = [];
    const { app } = await launch({ env: { ...CONTAINER_ENV, SSH_AUTH_SOCK: agent.socket } });
    try {
      const local = (await shellState(app)).projects.find((project) => project.fsPath === folder)!;
      const overlay = await reopenInContainer(app, local.key);
      await overlay.getByTestId('devcontainer-trust').getByTestId('devcontainer-trust-accept').click({ timeout: 300_000 });
      const record = await recordOf(app);
      keys.push(record.container);
      await expect.poll(async () => (await containerProject(app, record.authorityKey))?.connection, { timeout: 600_000 }).toBe('connected');
      const containerId = (await recordOf(app)).containerId!;
      const attempt = (await lastConnectStep(app, record.hostId))?.attemptId;

      // off, the default: a terminal has no agent and no SSH_AUTH_SOCK, no proxy socket listens, and a push over ssh fails
      // with publickey, which offers the switch
      const shell = await openTerminal(app);
      expect(await agentInTerminal(app, containerId, 'agent-off')).toMatchObject({ sock: 'unset', code: 2 });
      expect(await agentSockets(containerId)).toEqual([]);
      await recordToasts(app);
      await scmPush(app, true);
      const offer = await forwardingOffer(app, 0, record.name);
      expect(await bareHead(git)).toBe('');
      expect(agent.signatures).toBe(0);

      // the offer turns the container's own switch on, with no reconnect: the daemon listens, and the push signs with the stub
      await answerToast(app, offer.id, `Forward your SSH agent to ${record.name}`);
      await expect.poll(() => storedHost(home, record.hostId)?.settings['forwardAgent']).toBe(true);
      await expect.poll(() => agentSockets(containerId), { timeout: 60_000 }).toEqual([expect.stringMatching(/^600 node \/tmp\/damocles-[^/]+\/agent-[0-9a-f]{24}\.sock$/)]);
      await scmPush(app, true);
      await expect.poll(() => bareHead(git), { timeout: 60_000 }).toBe(head);
      expect(agent.signatures).toBeGreaterThan(0);
      // a terminal started now (Shift: in the current project, with no picker) lists the stub's key through the proxy socket
      await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
      await expect(terminalRows(shell)).toHaveCount(2);
      await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
      const on = await agentInTerminal(app, containerId, 'agent-on');
      expect(on).toMatchObject({ code: 0, sock: expect.stringMatching(/^\/tmp\/damocles-[^/]+\/agent-[0-9a-f]{24}\.sock$/), output: expect.stringContaining('damocles-e2e-agent') });

      // the container's card says it forwards, and Settings holds the switch, as for an SSH host
      const connect = await openConnect(app);
      await connect.getByRole('button', { name: `Details for ${record.name}` }).click();
      const card = connect.getByTestId('host-card');
      await expect(card.getByTestId('host-card-agent')).toHaveText('Forwards your SSH agent');
      await card.getByTestId('host-card-agent').scrollIntoViewIfNeeded();
      await shootThemes(app, connect, 'container-agent-card', card);
      await connect.keyboard.press('Escape');
      await expect(connectDialog(connect)).toBeHidden();

      // off mid-session: the socket and every connection close at once, with no reconnect
      const { overlay: settings, block } = await openRemoteHostSettings(app, record.hostId);
      await expect(block.getByRole('switch', { name: 'Forward my SSH agent', exact: true })).toHaveAttribute('aria-checked', 'true');
      await shootThemes(app, settings, 'container-agent-settings', settingsModal(settings));
      await setHostSwitch(block, 'Forward my SSH agent', false);
      await closeSettingsModal(settings);
      await expect.poll(() => agentSockets(containerId), { timeout: 60_000 }).toEqual([]);
      expect(await agentInTerminal(app, containerId, 'agent-cut')).toMatchObject({ sock: on.sock, code: 2 });
      expect((await lastConnectStep(app, record.hostId))?.attemptId).toBe(attempt);
      expect((await containerProject(app, record.authorityKey))?.connection).toBe('connected');
    } finally {
      const last = (await containerHosts(app).catch(() => []))[0];
      if (last?.containerId !== undefined && (await containerServerProcesses(last.containerId).catch(() => [])).length > 0) await shutdownContainerDaemon(app, last.hostId, last.containerId);
      await removeLeftovers(keys);
      await agent.close();
    }
  });
});
