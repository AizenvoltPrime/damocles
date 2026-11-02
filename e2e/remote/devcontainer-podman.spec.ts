import * as fs from 'node:fs';
import * as path from 'node:path';
import { filesRow } from '../desktop/support/editor';
import { writeUserSettings } from '../desktop/support/hermetic';
import { overlayPage, shellPage, shellState } from '../desktop/support/shell';
import { projectRow } from '../desktop/support/shell-ui';
import { connectDialog } from './support/connect-ui';
import { CONTAINER_ENV, containerHosts, containerServerProcesses, copyFixture, dataVolume, DEVCONTAINER_TAG, editConfig, inContainer, leftovers, removeLeftovers, shutdownContainerDaemon } from './support/devcontainer';
import { expect, lastConnectStep, test } from './support/remote';
import { runProgram } from './support/sshd';

// Rootless Podman runs in the pull request workflow's devcontainer job; a machine without podman on PATH skips with the reason.
async function podmanMissing(): Promise<string | undefined> {
  const found = await runProgram('podman', ['--version']).catch((error: unknown) => ({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }));
  return found.code === 0 ? undefined : `podman is not on this machine's PATH (${found.stderr.trim().slice(0, 200) || `exit ${String(found.code)}`}); the devcontainer job of .github/workflows/pr.yml runs this spec with rootless Podman`;
}

test.describe('Dev Containers with Podman', () => {
  test('a trusted folder builds and opens in a rootless Podman container through --docker-path, with its own data volume', { tag: DEVCONTAINER_TAG }, async ({ foreground: _foreground, home, launch }) => {
    test.setTimeout(900_000);
    const missing = await podmanMissing();
    test.skip(missing !== undefined, missing);
    const folder = copyFixture(home.root);
    // Podman's own name for the host, which needs no --add-host
    editConfig(folder, (config) => ({ ...config, runArgs: ['--label', 'damocles.e2e=devcontainer'] }));
    fs.writeFileSync(path.join(home.userData, 'projects.json'), JSON.stringify({ version: 1, projects: [folder] }));
    fs.writeFileSync(path.join(home.userData, 'trusted-folders.json'), JSON.stringify({ version: 1, folders: [folder] }));
    writeUserSettings(home, { 'damocles.desktop.remote.containerEngine': 'podman' });
    const keys: string[] = [];
    const { app } = await launch({ env: CONTAINER_ENV });
    try {
      const local = (await shellState(app)).projects.find((project) => project.fsPath === folder)!;
      const shell = await shellPage(app);
      const overlay = await overlayPage(app);
      await projectRow(shell, local.key).click({ button: 'right' });
      await overlay.getByRole('menuitem', { name: 'Reopen in Container' }).click();
      const trust = overlay.getByTestId('devcontainer-trust');
      await expect(trust).toBeVisible({ timeout: 300_000 });
      await trust.getByTestId('devcontainer-trust-accept').click();
      let record: Awaited<ReturnType<typeof containerHosts>>[number] | undefined;
      await expect.poll(async () => (record = (await containerHosts(app))[0])).toBeDefined();
      keys.push(record!.container);
      await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key.startsWith(`${record!.authorityKey}|`))?.connection, { timeout: 600_000 }).toBe('connected');
      await expect(connectDialog(overlay)).toBeHidden();
      expect((await lastConnectStep(app, record!.hostId))?.visited).toEqual(['building', 'connecting', 'checking', 'installing', 'starting']);
      await expect(filesRow(shell, 'README.md')).toBeVisible({ timeout: 60_000 });
      const containerId = (await containerHosts(app))[0]!.containerId!;
      expect(await containerServerProcesses(containerId, 'podman')).not.toEqual([]);
      // the container's own data volume, which ~/.damocles links to
      expect((await leftovers(keys, 'podman')).volumes).toEqual([dataVolume(record!.container)]);
      expect(await inContainer(containerId, 'readlink ~/.damocles', 'node', 'podman')).toBe('/var/lib/damocles-data\n');
      await shutdownContainerDaemon(app, record!.hostId, containerId, 'podman');
    } finally {
      await removeLeftovers(keys, 'podman');
    }
  });
});
