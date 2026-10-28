import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeTab, editorShows, editorTab, openInEditor } from '../desktop/support/editor';
import { menuItem, overlayMenu, readyOverlay } from '../desktop/support/overlay';
import { commitMessage, quickInput, quickInputField, scmSection, setSection } from '../desktop/support/scm';
import { overlayPage, shellPage } from '../desktop/support/shell';
import { clickMenu } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import type { SshdFixture } from './support/sshd';

const APP = '/srv/app';
// two changes apart enough that git's merge keeps them two conflicts
const BASE = ['line 1', 'shared 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'shared 8', 'line 9'];

const lines = (values: readonly string[]): string => `printf '%s\\n' ${values.map((line) => `'${line}'`).join(' ')}`;
const targetGit = async (fixture: SshdFixture, ...args: string[]): Promise<string> => (await fixture.sh(`git -C ${APP} ${args.join(' ')}`, 'dev')).trim();
const row = (shell: Page, group: string, file: string): Locator => scmSection(shell).locator(`[data-testid="scm-change"][data-group="${group}"][data-path="${file}"]`);
const merge = (shell: Page): Locator => shell.getByTestId('merge-editor');

async function repository(fixture: SshdFixture, extra: readonly string[] = []): Promise<void> {
  await fixture.sh([
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    `${lines(BASE)} > a.txt`,
    "printf 'keep\\n' > keep.txt && printf 'gone\\n' > gone.txt",
    'git add -A',
    'git commit -q -m init',
    ...extra,
  ].join(' && '), 'dev');
}

async function connect(app: ElectronApplication): Promise<{ readonly hostId: string; readonly key: string; readonly shell: Page }> {
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });
  return { hostId, key, shell };
}

/** Runs a menu command once main enabled it for the active editor, as a user finds it enabled in the menu. */
async function runEnabled(app: ElectronApplication, id: string): Promise<void> {
  await expect.poll(() => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled, id)).toBe(true);
  await clickMenu(app, id);
}

test('a conflicted file of an SSH repository opens in the three-pane merge editor with the target\'s sides, and Complete Merge saves and stages it on the target', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await repository(fixture, [
    'git checkout -q -b feature',
    `${lines(BASE.map((line) => (line === 'shared 2' ? 'feature 2' : line === 'shared 8' ? 'feature 8' : line)))} > a.txt`,
    "git commit -q -am 'Feature edits'",
    'git checkout -q main',
    `${lines(BASE.map((line) => (line === 'shared 2' ? 'main 2' : line === 'shared 8' ? 'main 8' : line)))} > a.txt`,
    "git commit -q -am 'Main edits'",
    'git merge feature || true',
  ]);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const { hostId, key, shell } = await connect(app);
  await expect(row(shell, 'merge', 'a.txt')).toBeVisible({ timeout: 60_000 });

  const overlay = await readyOverlay(app);
  await row(shell, 'merge', 'a.txt').click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, 'resolveInMergeEditor').click();
  await expect(merge(shell)).toBeVisible();
  await expect(editorTab(shell, 'Merging: a.txt')).toHaveAttribute('aria-selected', 'true');
  expect(await activeTab(app)).toMatchObject({ kind: 'merge', projectKey: key, relativePath: 'a.txt' });
  await expect(merge(shell).getByTestId('merge-incoming-label')).toContainText('feature');
  await expect(merge(shell).getByTestId('merge-current-label')).toContainText('main');
  await expect(merge(shell).getByTestId('merge-current')).toContainText('main 2');
  await expect(merge(shell).getByTestId('merge-incoming')).toContainText('feature 8');
  await expect(merge(shell)).toHaveAttribute('data-conflicts-left', '2');

  // Compute Conflicts reads the target's buffer through git merge-file on the target
  await merge(shell).getByTestId('merge-more').click();
  await menuItem(await overlayPage(app), 'computeDiff3').click();
  await expect(merge(shell).getByTestId('merge-result')).toContainText('|||||||');
  await merge(shell).getByTestId('merge-incoming').getByTestId('merge-accept-incoming').first().click();
  await merge(shell).getByTestId('merge-current').getByTestId('merge-accept-current').first().click();
  await expect(merge(shell)).toHaveAttribute('data-conflicts-left', '0');
  await merge(shell).getByTestId('merge-complete').click();
  await expect(merge(shell)).toHaveCount(0);
  await expect.poll(() => targetGit(fixture, 'diff', '--name-only', '--diff-filter=U')).toBe('');
  expect(await targetGit(fixture, 'show', ':a.txt')).toBe(['line 1', 'feature 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7', 'main 8', 'line 9'].join('\n'));
  await expect(row(shell, 'index', 'a.txt')).toBeVisible();
  await shutdownHostDaemon(app, hostId, fixture);
});

test('Git: Rename and Git: Delete on an SSH repository move and remove the target\'s file, the renamed tab following it and the deleted one closing', { tag: SSH_TAG }, async ({ foreground: _foreground, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  await repository(fixture);
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const { hostId, key, shell } = await connect(app);
  const overlay = await overlayPage(app);

  expect(await openInEditor(app, { projectKey: key, relativePath: 'keep.txt' })).toMatchObject({ ok: true });
  await editorShows(shell, 'keep');
  await runEnabled(app, 'damocles.git.rename');
  await expect(quickInput(overlay)).toBeVisible();
  await expect(quickInputField(overlay)).toHaveValue('keep.txt');
  await quickInputField(overlay).fill('kept.txt');
  await overlay.keyboard.press('Enter');
  await expect(row(shell, 'index', 'kept.txt')).toHaveAttribute('data-letter', 'R', { timeout: 60_000 });
  expect(await fixture.sh(`ls ${APP}`, 'dev')).toMatch(/\bkept\.txt\b/);
  // the tab is the target's moved file, the same project file under its new path
  await expect(editorTab(shell, 'kept.txt')).toBeVisible();
  expect(await activeTab(app)).toMatchObject({ projectKey: key, relativePath: 'kept.txt' });
  await expect(editorTab(shell, 'keep.txt')).toHaveCount(0);

  expect(await openInEditor(app, { projectKey: key, relativePath: 'gone.txt' })).toMatchObject({ ok: true });
  await editorShows(shell, 'gone');
  await runEnabled(app, 'damocles.git.delete');
  await expect(row(shell, 'index', 'gone.txt')).toHaveAttribute('data-letter', 'D', { timeout: 60_000 });
  expect(await fixture.sh(`test -e ${APP}/gone.txt && echo present || echo absent`, 'dev')).toBe('absent\n');
  await expect(editorTab(shell, 'gone.txt')).toHaveCount(0);
  await shutdownHostDaemon(app, hostId, fixture);
});
