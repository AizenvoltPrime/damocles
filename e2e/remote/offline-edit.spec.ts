import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { codeEditor, DOCUMENT_END, editorShows, editorTab, openInEditor, saveWithKeyboard } from '../desktop/support/editor';
import { menuItem } from '../desktop/support/overlay';
import { overlayPage, popupPage, popupToasts, recordToasts, shellPage } from '../desktop/support/shell';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { expect, holdFor, pageNow, sightings, test, watchConnectionUi, type ProxiedHost } from './support/flaky';
import { addHost, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG } from './support/remote';

const APP = '/srv/app';
// D13's drop: long enough for the banner, short of any timeout the user would meet
const DROP_MS = 30_000;
// OFFLINE_GRACE_MS: a host shows nothing of a drop before this
const GRACE_MS = 2000;
const PENDING = 'Saved on this computer. Uploads when prod-1 reconnects.';

const banner = (shell: Page): Locator => shell.locator('[data-testid="connection-banner"], [data-testid="connection-banner-edge"]').first();
const onTarget = async (host: ProxiedHost, file: string): Promise<string> => host.fixture.sh(`cat ${APP}/${file}`, 'dev');

async function openNotes(app: ElectronApplication, host: ProxiedHost, text: string): Promise<{ readonly hostId: string; readonly key: string; readonly shell: Page }> {
  await host.fixture.sh(`printf '%s' '${text}' > ${APP}/notes.md`, 'dev');
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  expect(await openInEditor(app, { projectKey: key, relativePath: 'notes.md' })).toMatchObject({ ok: true });
  await editorShows(shell, text.split('\n')[0]!);
  return { hostId, key, shell };
}

/** Drops the connection with a reset and keeps it refused; resolves with the drop's time on the shell page's clock. */
async function drop(shell: Page, host: ProxiedHost): Promise<number> {
  await watchConnectionUi(shell);
  const at = await pageNow(shell);
  host.proxy.refuse();
  return at;
}

/** Types at the end of the buffer and saves with Ctrl+S while the host is away: the save is kept here, pending. */
async function saveOffline(app: ElectronApplication, shell: Page, typed: string): Promise<void> {
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type(typed);
  await saveWithKeyboard(app);
  const glyph = editorTab(shell, 'notes.md').getByTestId('editor-tab-pending-upload');
  await expect(glyph).toBeVisible();
  await expect(glyph).toHaveAttribute('title', PENDING);
  await expect(glyph).toContainText(PENDING);
  await expect(editorTab(shell, 'notes.md')).not.toHaveAttribute('data-dirty', 'true');
}

test('a 30 s drop shows the banner after the grace, editing and Ctrl+S continue, the save is pending, and on reconnect it uploads', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const host = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const { hostId, shell } = await openNotes(app, host, 'line one\n');

  const droppedAt = await drop(shell, host);
  await expect(banner(shell)).toBeVisible({ timeout: 8000 });
  const shown = (await sightings(shell)).find((sighting) => sighting.what.startsWith('banner:'));
  expect(shown!.at - droppedAt).toBeGreaterThanOrEqual(GRACE_MS);
  await expect(shell.getByTestId('host-status-dot').first()).toHaveAttribute('data-shape', 'connecting');

  await saveOffline(app, shell, 'offline line');
  expect(await onTarget(host, 'notes.md')).toBe('line one\n');
  // editing goes on after the save; the tab is dirty again until the next one
  await shell.keyboard.type('!');
  await expect(editorTab(shell, 'notes.md')).toHaveAttribute('data-dirty', 'true');
  await saveWithKeyboard(app);
  await expect(editorTab(shell, 'notes.md')).not.toHaveAttribute('data-dirty', 'true');

  await holdFor(DROP_MS - ((await pageNow(shell)) - droppedAt));
  host.proxy.restore();
  await expect(editorTab(shell, 'notes.md').getByTestId('editor-tab-uploaded')).toBeVisible({ timeout: 90_000 });
  await expect(editorTab(shell, 'notes.md').getByTestId('editor-tab-pending-upload')).toHaveCount(0);
  expect(await onTarget(host, 'notes.md')).toBe('line one\noffline line!');
  await expect(banner(shell)).toHaveCount(0, { timeout: 30_000 });
  await expect(shell.getByTestId('host-status-dot').first()).toHaveAttribute('data-shape', 'connected');
  await shutdownHostDaemon(app, hostId, host.fixture);
});

test('an offline save whose file changed on the target meanwhile opens the three-way merge on reconnect, which resolves and uploads over SSH', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, proxied }) => {
  test.setTimeout(600_000);
  const host = await proxied('prod-1');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  await recordToasts(app);
  const { hostId, shell } = await openNotes(app, host, 'alpha\nbeta\ngamma\n');

  await drop(shell, host);
  await expect(banner(shell)).toBeVisible({ timeout: 8000 });
  // the buffer ends after "gamma\n": the offline edit changes the last line, the target changes the first
  await codeEditor(shell).locator('.view-line').first().click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.press('Backspace');
  await shell.keyboard.type(' mine\n');
  await saveWithKeyboard(app);
  await expect(editorTab(shell, 'notes.md').getByTestId('editor-tab-pending-upload')).toBeVisible();
  await host.fixture.sh(`printf 'alpha theirs\\nbeta\\ngamma theirs\\n' > ${APP}/notes.md`, 'dev');
  host.proxy.restore();

  // one summary names the conflict; its Review shows the merge editor of the offline save
  // the summary is the first toast, which opens the popup window
  const popup = await popupPage(app, 90_000);
  const toast = popupToasts(popup).filter({ hasText: 'changed on prod-1 while you were offline' });
  await expect(toast).toBeVisible({ timeout: 90_000 });
  await toast.getByRole('button', { name: 'Review', exact: true }).click();
  const merge = shell.getByTestId('merge-editor');
  await expect(merge).toBeVisible();
  await expect(merge.getByTestId('merge-current')).toContainText('alpha theirs');
  await expect(merge.getByTestId('merge-incoming')).toContainText('gamma mine');
  await expect(merge).toHaveAttribute('data-conflicts-left', '1');
  expect(await onTarget(host, 'notes.md')).toBe('alpha theirs\nbeta\ngamma theirs\n');

  // both changes kept: the target's first line, and for the conflicted last line the text saved offline
  await merge.getByTestId('merge-more').click();
  await menuItem(await overlayPage(app), 'acceptAllIncoming').click();
  await expect(merge).toHaveAttribute('data-conflicts-left', '0');
  await merge.getByTestId('merge-complete').click();
  await expect(merge).toHaveCount(0);
  await expect.poll(() => onTarget(host, 'notes.md'), { timeout: 30_000 }).toBe('alpha theirs\nbeta\ngamma mine\n');
  await expect(shell.locator('[data-testid="editor-tab"][data-kind="code"]', { hasText: 'notes.md' })).not.toHaveAttribute('data-dirty', 'true');
  await shutdownHostDaemon(app, hostId, host.fixture);
});
