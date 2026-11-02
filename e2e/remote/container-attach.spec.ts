import { filesRow } from '../desktop/support/editor';
import { shellPage, shellState } from '../desktop/support/shell';
import { browseTo, connectDialogClosed, openConnect } from './support/connect-ui';
import { CONTAINER_ENV, containerHosts, containerServerProcesses, DEVCONTAINER_TAG, E2E_LABEL, engine, inContainer, NODE_IMAGE, removeLeftovers, shutdownContainerDaemon } from './support/devcontainer';
import { expect, lastConnectStep, test } from './support/remote';

test.describe('Attach to a running container', () => {
  test('lists the running containers, attaches as root, then opens a folder from the folder browser', { tag: DEVCONTAINER_TAG }, async ({ foreground: _foreground, launch }) => {
    test.setTimeout(600_000);
    const name = `damocles-e2e-attach-${process.pid}`;
    const id = (await engine(['run', '-d', '--label', E2E_LABEL, '--name', name, NODE_IMAGE, 'sleep', 'infinity'])).trim();
    await inContainer(id, 'mkdir -p /srv/attached && echo hi > /srv/attached/hello.txt');
    const { app } = await launch({ env: CONTAINER_ENV });
    try {
      const overlay = await openConnect(app);
      await overlay.getByTestId('attach-container-card').click();
      await overlay.getByTestId('container-where-local').click();
      const row = overlay.locator(`[data-testid="running-container"][data-container-id="${id}"]`);
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText(name);
      await overlay.getByTestId('attach-user').getByText('root', { exact: true }).click();
      await row.click();
      // the name step is prefilled from the container's name
      const dialog = overlay.getByTestId('connect-dialog');
      await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue(name);
      await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
      const browser = await browseTo(overlay, name, '/srv/attached');
      await browser.getByRole('button', { name: 'Open', exact: true }).click();
      await overlay.getByRole('alertdialog', { name: `Do you trust the authors of the files in /srv/attached on ${name}?` }).getByRole('button', { name: 'Trust Folder' }).click();
      await connectDialogClosed(overlay);
      const [record] = await containerHosts(app);
      expect(record?.containerId).toBe(id);
      const step = await lastConnectStep(app, record!.hostId);
      expect(step?.visited).toEqual(['connecting', 'checking', 'installing', 'starting']);
      await expect.poll(async () => (await shellState(app)).projects.find((project) => project.key === `${record!.authorityKey}|/srv/attached`)?.connection, { timeout: 120_000 }).toBe('connected');
      await expect(filesRow(await shellPage(app), 'hello.txt')).toBeVisible({ timeout: 60_000 });
      // the stage ran as the chosen user
      expect((await containerServerProcesses(id)).length).toBeGreaterThan(0);
      expect(await inContainer(id, 'stat -c %U "$(readlink -f /root/.damocles/server)"')).toBe('root\n');
      await shutdownContainerDaemon(app, record!.hostId, id);
    } finally {
      await removeLeftovers([]);
    }
  });
});
