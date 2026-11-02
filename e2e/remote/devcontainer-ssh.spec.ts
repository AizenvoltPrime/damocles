import { randomBytes } from 'node:crypto';
import type { ElectronApplication, Page } from '@playwright/test';
import { mainLog } from '../desktop/support/app';
import { filesRow } from '../desktop/support/editor';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { projectRow } from '../desktop/support/shell-ui';
import { connectDialog } from './support/connect-ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { closeSettingsModal } from '../desktop/support/settings';
import { activeTerminal, openTerminal, terminalRows } from '../desktop/support/terminal';
import { openRemoteHostSettings, setHostSwitch, storedHost } from './support/host-settings-ui';
import { startSshAgentStub } from './support/ssh-agent-stub';
import { agentInTerminal, agentSockets, containerHosts, containerServerProcesses, DEVCONTAINER_TAG, E2E_LABEL, engine, FIXTURE_DIR, NODE_IMAGE, removeLeftovers, shutdownContainerDaemon } from './support/devcontainer';
import { addHost, expect, lastConnectStep, openRemoteFolder, remoteEnv, test } from './support/remote';
import { TARGET_USER } from './support/sshd';

/** Right-clicks the project and picks Reopen in Container from its menu. */
async function reopenInContainer(app: ElectronApplication, projectKey: string): Promise<Page> {
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);
  await projectRow(shell, projectKey).click({ button: 'right' });
  await overlay.getByRole('menuitem', { name: 'Reopen in Container' }).click();
  return overlay;
}

test.describe('Dev Containers on an SSH host', () => {
  test('a folder on the host reopens in a container its Docker builds, through the daemon, with the package from the host\'s cache, and this computer\'s SSH agent reaches it behind the container\'s own switch alone', { tag: DEVCONTAINER_TAG }, async ({ foreground: _foreground, home, launch, mirror, ssh, sshd }) => {
    test.setTimeout(900_000);
    // the launch names the stub as this computer's agent, so nothing here can reach the developer's own
    const agent = await startSshAgentStub(home.root);
    // a folder of the engine's own host, mounted into the sshd fixture at the same path, so the workspace bind mount resolves
    const shared = `/tmp/damocles-e2e-dc-${randomBytes(6).toString('hex')}`;
    const fixture = await sshd('prod-1', { engineFolder: shared });
    const folder = `${shared}/app`;
    const keys: string[] = [];
    try {
      await engine(['cp', FIXTURE_DIR, `${fixture.container}:${folder}`]);
      await fixture.sh(`chown -R ${TARGET_USER}:${TARGET_USER} ${folder} && docker --version`, 'root');
      expect(await fixture.sh('docker ps -q --filter label=nothing-has-this-label', TARGET_USER)).toBe('');
      const { app } = await launch({ env: { ...remoteEnv(ssh, mirror), SSH_AUTH_SOCK: agent.socket } });
      const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
      const projectKey = await openRemoteFolder(app, hostId, folder, true);
      try {
        // the folder is trusted on the host, so the confirmation comes first; it names the host
        const overlay = await reopenInContainer(app, projectKey);
        const trust = overlay.getByTestId('devcontainer-trust');
        await expect(trust).toBeVisible({ timeout: 300_000 });
        await expect(trust).toContainText('prod-1');
        await expect(trust.locator('[data-testid="devcontainer-trust-item"][data-field="initializeCommand"]')).toContainText('echo ran > init-ran.txt');
        await trust.getByTestId('devcontainer-trust-accept').click();
        let record: Awaited<ReturnType<typeof containerHosts>>[number] | undefined;
        await expect.poll(async () => (record = (await containerHosts(app))[0])).toBeDefined();
        keys.push(record!.container);
        await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key.startsWith(`${record!.authorityKey}|`))?.connection, { timeout: 600_000 }).toBe('connected');
        await expect(connectDialog(overlay)).toBeHidden();
        const step = await lastConnectStep(app, record!.hostId);
        expect(step?.visited).toEqual(['building', 'connecting', 'checking', 'installing', 'starting']);
        // the initializeCommand ran on the SSH host, in the folder there
        expect(await fixture.sh(`cat ${folder}/init-ran.txt`, TARGET_USER)).toBe('ran\n');
        await expect(filesRow(await shellPage(app), 'README.md')).toBeVisible({ timeout: 60_000 });
        // the package came from the host's package cache into the container, never over this computer's upload
        const containerId = (await containerHosts(app))[0]!.containerId!;
        expect(await fixture.sh('ls ~/.damocles/server/run-*/package-cache', TARGET_USER)).toMatch(/damocles-server-.*-alpine-/);
        // main logs each cache answer and each upload of the container's attempt, whatever the stage printed
        const attemptLog = mainLog(home).split('\n').filter((line) => line.includes(`[container ${record!.hostId}] `));
        expect(attemptLog.filter((line) => line.includes('copied the alpine-x64 package into the container'))).toHaveLength(1);
        expect(attemptLog.filter((line) => /asks for the upload|uploading the/.test(line))).toEqual([]);

        // the agent relay through the nested connection: off by default, on with the container's switch while prod-1's stays
        // off, and gone at once when it turns off
        const shell = await openTerminal(app);
        expect(await agentInTerminal(app, containerId, 'agent-off')).toMatchObject({ sock: 'unset', code: 2 });
        const { overlay: settings, block } = await openRemoteHostSettings(app, record!.hostId);
        await setHostSwitch(block, 'Forward my SSH agent', true);
        await closeSettingsModal(settings);
        await expect.poll(() => agentSockets(containerId), { timeout: 60_000 }).toEqual([expect.stringMatching(/^600 node \/tmp\/damocles-[^/]+\/agent-[0-9a-f]{24}\.sock$/)]);
        // Shift: a terminal in the current project, with no picker
        await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
        await expect(terminalRows(shell)).toHaveCount(2);
        await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
        const on = await agentInTerminal(app, containerId, 'agent-on');
        expect(on.code).toBe(0);
        expect(on.output).toContain('damocles-e2e-agent');
        expect(storedHost(home, hostId)?.settings['forwardAgent']).toBeUndefined();
        const again = await openRemoteHostSettings(app, record!.hostId);
        await setHostSwitch(again.block, 'Forward my SSH agent', false);
        await closeSettingsModal(again.overlay);
        await expect.poll(() => agentSockets(containerId), { timeout: 60_000 }).toEqual([]);
        expect(await agentInTerminal(app, containerId, 'agent-cut')).toMatchObject({ sock: on.sock, code: 2 });
        await shutdownContainerDaemon(app, record!.hostId, containerId);
        expect(await containerServerProcesses(containerId)).toEqual([]);
      } finally {
        await shutdownHostDaemon(app, hostId, fixture);
      }
    } finally {
      await removeLeftovers(keys);
      await fixture.sh(`rm -rf ${shared}/*`, 'root');
      // the engine's host keeps the emptied folder until this removes it
      await engine(['run', '--rm', '--label', E2E_LABEL, '-v', '/tmp:/host-tmp', NODE_IMAGE, 'rmdir', `/host-tmp/${shared.slice('/tmp/'.length)}`]);
      await agent.close();
    }
  });
});
