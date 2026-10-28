import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Locator } from '@playwright/test';
import { codeEditor, DOCUMENT_END, editorShows, editorTab, openInEditor, saveWithKeyboard } from '../desktop/support/editor';
import { settled, showShellTheme, THEMES } from '../desktop/support/screenshots';
import { popupPage, popupToasts, recordToasts, shellPage } from '../desktop/support/shell';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, test } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv, remoteProjectKey } from './support/remote';

// Review captures of the offline save's tab glyph and the upload merge editor in both themes, not tests: only the screenshots
// project matches them. Compare with the mockup's slice 7 tour item "offline save and upload".
const SHOTS = process.env['DAMOCLES_REMOTE_SHOTS'] ?? path.join(os.tmpdir(), 'damocles-offline-save-shots');
const APP = '/srv/app';

async function capture(app: ElectronApplication, name: string, target: () => Locator): Promise<void> {
  fs.mkdirSync(SHOTS, { recursive: true });
  const shell = await shellPage(app);
  for (const theme of THEMES) {
    await showShellTheme(app, theme);
    await settled(shell);
    await target().screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`), animations: 'disabled' });
  }
}

test('offline save tab glyph and the merge editor of a save that met a changed target', async ({ foreground: _foreground, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const target = await proxied('prod-1');
  await target.fixture.sh(`printf 'alpha\\nbeta\\ngamma\\n' > ${APP}/notes.md`, 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await recordToasts(app);
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  expect(await openInEditor(app, { projectKey: key, relativePath: 'notes.md' })).toMatchObject({ ok: true });
  await editorShows(shell, 'alpha');

  target.proxy.refuse();
  await expect(shell.getByTestId('host-status-dot').first()).toHaveAttribute('data-shape', 'connecting', { timeout: 30_000 });
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.press('Backspace');
  await shell.keyboard.type(' mine\n');
  await saveWithKeyboard(app);
  const glyph = editorTab(shell, 'notes.md').getByTestId('editor-tab-pending-upload');
  await expect(glyph).toBeVisible();
  await capture(app, 'offline-save-tab', () => shell.getByTestId('editor-pane'));
  await glyph.hover();
  await capture(app, 'offline-save-tab-strip', () => editorTab(shell, 'notes.md'));

  await target.fixture.sh(`printf 'alpha theirs\\nbeta\\ngamma theirs\\n' > ${APP}/notes.md`, 'dev');
  target.proxy.restore();
  const toast = popupToasts(await popupPage(app)).filter({ hasText: 'changed on prod-1 while you were offline' });
  await expect(toast).toBeVisible({ timeout: 120_000 });
  await toast.getByRole('button', { name: 'Review', exact: true }).click();
  const merge = shell.getByTestId('merge-editor');
  await expect(merge).toHaveAttribute('data-conflicts-left', '1');
  await capture(app, 'offline-save-merge-editor', () => shell.getByTestId('editor-pane'));
  await shutdownHostDaemon(app, hostId, target.fixture);
});
