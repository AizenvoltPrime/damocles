import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeTab, codeEditor, diffEditor, editorShows, openInEditor, quickPick } from '../desktop/support/editor';
import { answerInput, commitMessage, moreActions, pickItem, quickInput, quickInputField, scmSection, setSection } from '../desktop/support/scm';
import { overlayPage, pressKeys, PRIMARY, shellPage } from '../desktop/support/shell';
import { answerDialogs, clickMenu } from '../desktop/support/ui';
import { shutdownHostDaemon } from './support/daemon-teardown';
import { addHost, expect, openRemoteFolder, remoteEnv, remoteProjectKey, SSH_TAG, test } from './support/remote';
import type { SshdFixture } from './support/sshd';

const APP = '/srv/app';
const BASE = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;', 'const g = 7;', 'const h = 8;', 'const i = 9;', 'const j = 10;'];
const DELETE_WORKTREE = 'Are you sure you want to delete the worktree';

const change = (shell: Page, group: 'workingTree' | 'index', file: string): Locator =>
  scmSection(shell).locator(`[data-testid="scm-change"][data-group="${group}"][data-path="${file}"]`);
const marks = (shell: Page): Promise<string | null> => codeEditor(shell).getAttribute('data-quick-diff');
const peek = (shell: Page): Locator => codeEditor(shell).getByTestId('quick-diff-peek');
const modifiedLine = (shell: Page, text: string): Locator => diffEditor(shell).locator('.editor.modified .view-line', { hasText: text });
const originalLine = (shell: Page, text: string): Locator => diffEditor(shell).locator('.editor.original .view-line', { hasText: text });
const targetGit = async (fixture: SshdFixture, ...args: string[]): Promise<string> => (await fixture.sh(`git -C ${APP} ${args.join(' ')}`, 'dev')).trim();
const lines = (values: readonly string[]): string => `printf '%s\\n' ${values.map((line) => `'${line}'`).join(' ')}`;

async function openFile(app: ElectronApplication, shell: Page, projectKey: string, relativePath: string, text: string): Promise<void> {
  expect(await openInEditor(app, { projectKey, relativePath })).toMatchObject({ ok: true });
  await editorShows(shell, text);
}

async function pick(app: ElectronApplication, label: string): Promise<void> {
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(label);
  await pickItem(overlay, label).first().click();
  await expect(pickItem(overlay, label)).toHaveCount(0);
}

test('on an SSH repository Open Changes, a timeline commit diff, a stash diff, the quick diff\'s stage, unstage and revert, Stage Selected Ranges of the target buffer, and Create and Delete Worktree all act on the target', { tag: SSH_TAG }, async ({ foreground: _foreground, home: _home, launch, mirror, ssh, sshd }) => {
  test.setTimeout(600_000);
  const fixture = await sshd('prod-1');
  // the folder Create Worktree suggests beside the repository, which the target user may write
  await fixture.sh(`mkdir -p ${APP}.worktrees && chown dev:dev ${APP}.worktrees`);
  const grown = BASE.map((line) => (line === 'const a = 1;' ? 'const a = 10;' : line));
  await fixture.sh([
    "git config --global user.name 'E2E Dev'",
    'git config --global user.email dev@prod-1.invalid',
    `git init -q -b main ${APP}`,
    `cd ${APP}`,
    `${lines(BASE)} > app.ts`,
    'git add -A',
    'git commit -q -m init',
    `${lines(grown)} > app.ts`,
    'git commit -q -am "Grow a"',
    'git branch wt-branch',
    `${lines(grown.map((line) => (line === 'const b = 2;' ? 'const b = 20;' : line === 'const h = 8;' ? 'const h = 80;' : line)))} > app.ts`,
  ].join(' && '), 'dev');
  const { app } = await launch({ env: remoteEnv(ssh, mirror) });
  const hostId = await addHost(app, { alias: 'prod-1', name: 'prod-1' });
  const key = await openRemoteFolder(app, hostId, APP);
  await remoteProjectKey(app, { authorityKey: `ssh+${hostId}` }, APP);
  const shell = await shellPage(app);
  await setSection(shell, 'scm-section', true);
  await expect(commitMessage(shell)).toBeVisible({ timeout: 60_000 });

  // Open Changes: the target's index against its working file, in the SSH project.
  await expect(change(shell, 'workingTree', 'app.ts')).toHaveAttribute('data-letter', 'M', { timeout: 60_000 });
  await change(shell, 'workingTree', 'app.ts').click();
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await expect(modifiedLine(shell, 'const b = 20;')).toBeVisible();
  await expect(originalLine(shell, 'const b = 2;')).toBeVisible();
  expect(await activeTab(app)).toMatchObject({ kind: 'diff', projectKey: key, relativePath: 'app.ts' });

  // The timeline lists the target's commits, and an entry opens that commit's diff.
  await openFile(app, shell, key, 'app.ts', 'const b = 20;');
  const grow = await targetGit(fixture, 'rev-parse', 'HEAD');
  await clickMenu(app, 'damocles.git.openTimeline');
  const timeline = shell.getByTestId('timeline-tab');
  await expect(timeline.getByTestId('timeline-entry')).toHaveCount(2);
  await timeline.locator(`[data-testid="timeline-entry"][data-hash="${grow}"]`).click();
  await expect.poll(async () => (await activeTab(app))?.kind).toBe('diff');
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await expect(modifiedLine(shell, 'const a = 10;')).toBeVisible();
  await expect(originalLine(shell, 'const a = 1;')).toBeVisible();

  // The quick diff of the target file: the peek stages the first hunk in the target's index alone.
  await openFile(app, shell, key, 'app.ts', 'const b = 20;');
  await expect.poll(() => marks(shell), { timeout: 60_000 }).toBe('2-2,8-8');
  await codeEditor(shell).locator('.qd-mark').first().click();
  await expect(peek(shell)).toContainText('1 of 2 changes');
  await peek(shell).getByTestId('peek-stage').click();
  await expect.poll(() => targetGit(fixture, 'diff', '--cached', '--unified=0')).toContain('+const b = 20;');
  expect(await targetGit(fixture, 'diff', '--cached', '--unified=0')).not.toContain('const h = 80;');
  await expect.poll(() => marks(shell)).toBe('2-2s,8-8');

  // Revert on the second hunk edits the buffer only; the target's file keeps the change.
  await peek(shell).getByTestId('peek-next').click();
  await peek(shell).getByTestId('peek-revert').click();
  await editorShows(shell, 'const h = 8;');
  await expect.poll(async () => (await activeTab(app))?.dirty).toBe(true);
  expect(await fixture.sh(`cat ${APP}/app.ts`, 'dev')).toContain('const h = 80;');
  await expect(peek(shell)).toHaveCount(0);

  // Stage Selected Ranges on an unsaved line stages the target buffer's text, which the target's file does not hold.
  await codeEditor(shell).locator('.view-line', { hasText: 'const c = 3;' }).first().click();
  await shell.keyboard.press('End');
  await shell.keyboard.type(' // buffer-only');
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'S', [PRIMARY, 'alt']);
  await expect.poll(() => targetGit(fixture, 'diff', '--cached', '--unified=0')).toContain('+const c = 3; // buffer-only');
  expect(await fixture.sh(`cat ${APP}/app.ts`, 'dev')).not.toContain('buffer-only');

  // Unstage Selected Ranges in the Staged Changes diff takes the first hunk back out of the target's index.
  await change(shell, 'index', 'app.ts').click();
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await modifiedLine(shell, 'const b = 20;').click();
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'N', [PRIMARY]);
  await expect.poll(() => targetGit(fixture, 'diff', '--cached', '--unified=0')).not.toContain('const b = 20;');
  expect(await targetGit(fixture, 'diff', '--cached', '--unified=0')).toContain('+const c = 3; // buffer-only');

  // Stage Selected Ranges right as the code tab opens, before its marks are drawn, stages the hunk again in the target's index.
  await openFile(app, shell, key, 'app.ts', 'const b = 20;');
  await codeEditor(shell).locator('.view-line', { hasText: 'const b = 20;' }).first().click();
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'S', [PRIMARY, 'alt']);
  await expect.poll(() => targetGit(fixture, 'diff', '--cached', '--unified=0')).toContain('+const b = 20;');
  await expect.poll(() => marks(shell)).toBe('2-3s');

  // A stash on the target opens in a stash tab, and its file's diff shows the stashed text.
  await moreActions(app, shell, 'stash', 'stash');
  await answerInput(app, 'on prod-1');
  await expect.poll(() => targetGit(fixture, 'stash', 'list', '--format=%gs')).toBe('On main: on prod-1');
  await scmSection(shell).getByTestId('scm-stash').first().click();
  const stashTab = shell.locator('[data-testid="changes-tab"][data-source="stash"]');
  const stashed = stashTab.locator('[data-testid="changes-entry"][data-path="app.ts"]');
  await expect(stashed).toBeVisible();
  await stashed.click();
  await expect(stashTab.getByTestId('changes-diff')).toContainText('const b = 20;');

  // Create Worktree at the target folder main suggests, then Delete Worktree after its question.
  const worktrees = async (): Promise<string[]> => (await targetGit(fixture, 'worktree', 'list', '--porcelain')).split('\n').filter((line) => line.startsWith('worktree '));
  await moreActions(app, shell, 'createWorktree', 'worktrees');
  await pick(app, 'wt-branch');
  const overlay = await overlayPage(app);
  await expect(quickInput(overlay)).toBeVisible();
  expect(await quickInputField(overlay).inputValue()).toMatch(/^\//);
  await quickInputField(overlay).press('Enter');
  await expect.poll(async () => (await worktrees()).length).toBe(2);
  const linked = (await worktrees())[1]!.slice('worktree '.length);
  expect((await fixture.sh(`git -C '${linked}' branch --show-current`, 'dev')).trim()).toBe('wt-branch');
  await answerDialogs(app, { [DELETE_WORKTREE]: 'Delete Worktree' });
  await moreActions(app, shell, 'deleteWorktree', 'worktrees');
  await pick(app, linked.split('/').at(-1)!);
  await expect.poll(async () => (await worktrees()).length).toBe(1);
  expect((await fixture.sh(`if [ -e '${linked}' ]; then echo yes; fi`, 'dev')).trim()).toBe('');

  await shutdownHostDaemon(app, hostId, fixture);
  // the quit's question about the unsaved buffer, whose text the test leaves unsaved
  await answerDialogs(app, { 'Do you want to save': "Don't Save" });
});
