import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, pressKeys, PRIMARY, recordedToasts, recordToasts, selectedProjectKey, shellPage, shellState } from './support/shell';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { commitMessage, gitLog, ledgerPath, moreActions, openScmProject, scmSection } from './support/scm';
import { openProjectChat, settled } from './support/screenshots';
import { addProject, answerDialogs, answerOpenDialog, askedDialogs, TRUST_PROMPT } from './support/ui';
import { codeEditor, diffEditor, editorShows, editorTab, filesRow, openInEditor, quickPick } from './support/editor';
import { openSettingsModal, settingsRow, chooseSegment, closeSettingsModal } from './support/settings';
import { git, initRepo } from './support/git';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { startOpenAIStub, STUB_MODEL_ID } from './support/openai-stub';
import { COMMIT_MESSAGE_OUTPUT_TOOL } from '../../src/core/scm/commit-message';

// Source control (plan slice 10): every acceptance criterion of the slice, against real git in the hermetic home.
const HOOKS = { DAMOCLES_E2E_HOOKS: '1' };

const state = (shell: Page): Locator => scmSection(shell).getByTestId('scm-state');
const changeRow = (shell: Page, group: string, file: string): Locator =>
  scmSection(shell).locator(`[data-testid="scm-change"][data-group="${group}"][data-path="${file}"]`);
const groupRow = (shell: Page, group: string): Locator => scmSection(shell).locator(`[data-testid="scm-group"][data-group="${group}"]`);

/** Runs a source control row or group action through its inline button, which a change row shows while hovered or focused. */
async function inline(row: Locator, action: string): Promise<void> {
  // focus, not hover: the list can still scroll under a resting pointer, which ends a hover and hides the actions
  await row.focus();
  await row.getByTestId(action).click();
}

/** Opens the repository picker's menu once any earlier menu has played its exit. */
async function openPicker(app: ElectronApplication, shell: Page): Promise<Page> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await scmSection(shell).getByTestId('scm-repo-picker').click();
  await expect(overlayMenu(overlay)).toBeVisible();
  return overlay;
}

/** Chooses the quick pick item whose text holds `text`, such as a closed repository's root; main's ids are indices. */
async function pickQuickItem(app: ElectronApplication, text: string): Promise<void> {
  const overlay = await readyOverlay(app);
  await expect(quickPick(overlay)).toBeVisible();
  await quickPick(overlay).getByTestId('quick-pick-item').filter({ hasText: text }).click();
  await expect(quickPick(overlay)).toHaveCount(0);
}

/** Runs a palette command by id, as Ctrl+Shift+P and Enter do. */
async function runCommand(app: ElectronApplication, query: string, id: string): Promise<void> {
  const overlay = await overlayPage(app);
  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(`>${query}`);
  const item = overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(quickPick(overlay)).toHaveCount(0);
}

test('a project with a nested repository and a submodule lists three repositories; an edit shows M, Stage moves it and Ctrl+Enter commits it', async ({ foreground: _foreground, home, launch }) => {
  const outside = path.join(home.root, 'sub-origin');
  await initRepo(home, outside, { 'lib.ts': 'export {};\n' });
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n', '.gitignore': 'ignored.log\n' });
  await git(home, home.project, '-c', 'protocol.file.allow=always', 'submodule', 'add', outside, 'libs/sub');
  await git(home, home.project, 'commit', '-m', 'Add the submodule');
  await initRepo(home, path.join(home.project, 'nested'), { 'n.ts': 'export {};\n' });
  fs.writeFileSync(path.join(home.project, 'ignored.log'), 'noise\n');
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 2;\n');

  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);

  // The picker lists the project's repository, the nested one and the submodule.
  const picker = scmSection(shell).getByTestId('scm-repo-picker');
  await expect(picker).toContainText('1 of 3');
  await picker.click();
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay).locator('[data-item-id^="repo:"]')).toHaveCount(3);
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);

  // B3 in the Files tree: the submodule's folder shows S, the edit M, and the ignored file is faded.
  await filesRow(shell, 'libs').click();
  await expect(filesRow(shell, 'libs/sub').getByTestId('files-decoration')).toHaveText('S');
  await expect(filesRow(shell, 'libs')).toHaveAttribute('aria-expanded', 'true');
  await expect(filesRow(shell, 'a.ts').getByTestId('files-decoration')).toHaveText('M');
  await expect(filesRow(shell, 'ignored.log').getByTestId('files-name')).toHaveAttribute('data-ignored', 'true');
  await expect(filesRow(shell, 'b.ts').getByTestId('files-decoration')).toHaveCount(0);

  // Changes lists the edit with its M; Stage moves it to Staged Changes; Ctrl+Enter commits it.
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toHaveAttribute('data-letter', 'M');
  await inline(changeRow(shell, 'workingTree', 'a.ts'), 'scm-row-stage');
  await expect(changeRow(shell, 'index', 'a.ts')).toBeVisible();
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toHaveCount(0);
  await commitMessage(shell).fill('Bump a');
  await commitMessage(shell).press('ControlOrMeta+Enter');
  await expect.poll(() => git(home, home.project, 'log', '-1', '--format=%s')).toBe('Bump a');
  await expect(groupRow(shell, 'index')).toHaveCount(0);
  await expect(commitMessage(shell)).toHaveValue('');
  await expect(filesRow(shell, 'a.ts').getByTestId('files-decoration')).toHaveCount(0);

  // Open Changes on the Changes group opens one multi-file diff tab listing every changed file.
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 3;\n');
  fs.writeFileSync(path.join(home.project, 'b.ts'), 'export const b = 3;\n');
  await expect(changeRow(shell, 'workingTree', 'b.ts')).toBeVisible();
  await inline(groupRow(shell, 'workingTree'), 'scm-group-openGroupChanges');
  const tab = shell.getByTestId('changes-tab');
  await expect(tab).toBeVisible();
  await expect(tab.getByTestId('changes-entry')).toHaveCount(2);
  await expect(tab.getByTestId('changes-line').filter({ hasText: 'export const a = 3;' })).toBeVisible();
  await tab.locator('[data-testid="changes-entry"][data-path="b.ts"]').click();
  await expect(tab.getByTestId('changes-path')).toHaveText('b.ts');
  await expect(tab.getByTestId('changes-line').filter({ hasText: 'export const b = 3;' })).toBeVisible();
  await expect(editorTab(shell, 'b.ts')).toHaveCount(0);
});

test('a binary side opens as a placeholder beside the other side: Open Anyway opens the file on disk, and a text side opposite it shows its text', async ({ home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n', 'blob.bin': 'one\u0000two\n', 'data.bin': 'old\u0000data\n', 'gone.bin': 'x\u0000y\n' });
  fs.writeFileSync(path.join(home.project, 'blob.bin'), 'three\u0000four\n');
  fs.rmSync(path.join(home.project, 'gone.bin'));
  fs.writeFileSync(path.join(home.project, 'data.bin'), 'now plain text\n');
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await recordToasts(app);

  // Binary on both sides: two placeholders, and only the working tree's, a file on disk, offers Open Anyway.
  await changeRow(shell, 'workingTree', 'blob.bin').click();
  const diff = diffEditor(shell);
  const original = diff.locator('[data-side="original"]');
  const modified = diff.locator('[data-side="modified"]');
  await expect(original.getByTestId('diff-not-displayed')).toContainText('This file is not displayed');
  await expect(original.getByTestId('diff-not-displayed')).toContainText('It is a binary file.');
  await expect(original.getByTestId('diff-open-anyway')).toHaveCount(0);
  await expect(shell.getByTestId('editor-diff-stats')).toHaveCount(0);
  await expect(modified.getByTestId('diff-not-displayed')).toContainText('It is a binary file.');
  await modified.getByTestId('diff-open-anyway').click();
  await expect(shell.getByTestId('editor-not-displayed')).toBeVisible();
  await expect(shell.getByTestId('editor-reveal')).toBeVisible();

  // A binary index side opposite a text working tree file: the placeholder beside an editor of the file.
  await changeRow(shell, 'workingTree', 'data.bin').click();
  await expect(original.getByTestId('diff-not-displayed')).toContainText('It is a binary file.');
  await expect(diff).toHaveAttribute('data-monaco-ready', 'true');
  await expect(modified.getByTestId('diff-text-side').locator('.view-line', { hasText: 'now plain text' })).toBeVisible();

  // A deleted binary file has only its HEAD side: a placeholder tab, with no Reveal since it is no file.
  await changeRow(shell, 'workingTree', 'gone.bin').click();
  await expect(shell.getByTestId('editor-not-displayed')).toContainText('It is a binary file. 4 bytes');
  await expect(shell.getByTestId('editor-reveal')).toHaveCount(0);
  expect((await recordedToasts(app)).filter((toast) => /binary|not available/.test(toast.message))).toEqual([]);
});

test('the commit box: the length warning follows inputValidation, Generate fills it from the Background model and records commit-message spend, a reply without a message leaves it, and a missing user.name is named', async ({ home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n' }, { identity: false });
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 2;\n');
  await git(home, home.project, 'add', 'a.ts');
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch({ env: HOOKS });
    await recordToasts(app);
    const shell = await openScmProject(app, home.project);
    const subject = 'Make the subject line of this commit run past fifty characters';

    // Off by default: no warning.
    await commitMessage(shell).fill(subject);
    await expect(scmSection(shell).getByTestId('scm-length-warning')).toHaveCount(0);
    // On, from Settings › Source control: the subject over 50 is named.
    const overlay = await openSettingsModal(app, 'sourceControl');
    await settingsRow(overlay, 'damocles.desktop.git.inputValidation').getByRole('switch').click();
    await closeSettingsModal(overlay);
    await commitMessage(shell).click();
    await commitMessage(shell).press('End');
    await expect(scmSection(shell).getByTestId('scm-length-warning')).toHaveText(`${subject.length - 50} characters over 50 in current line`);

    // Generate: the box takes the model's message, and the ledger gets one commit-message line from the stub model for the project folder.
    stub.subCallReplies.set(COMMIT_MESSAGE_OUTPUT_TOOL, [{ chunks: [], toolCalls: [{ name: COMMIT_MESSAGE_OUTPUT_TOOL, arguments: { message: 'Bump a to 2\n\nThe tests expect it.' } }] }]);
    await scmSection(shell).getByTestId('scm-generate').click();
    await expect(commitMessage(shell)).toHaveValue('Bump a to 2\n\nThe tests expect it.');
    const ledger = await ledgerPath(app);
    type LedgerLine = { purpose?: string; provider?: string; model?: string; cwd?: string };
    const lines = (): LedgerLine[] => (fs.existsSync(ledger) ? fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as LedgerLine) : []);
    await expect.poll(() => lines().filter((line) => line.purpose === 'commit-message')).toEqual([expect.objectContaining({ provider: 'openai', model: STUB_MODEL_ID, cwd: home.project })]);

    // A reply without a message leaves the box as it was and says so.
    stub.subCallReplies.set(COMMIT_MESSAGE_OUTPUT_TOOL, [{ chunks: ['No message today.'] }]);
    await scmSection(shell).getByTestId('scm-generate').click();
    await expect.poll(async () => (await recordedToasts(app)).map((notice) => notice.message)).toContain("Couldn't generate a commit message. The model gave no usable message.");
    await expect(commitMessage(shell)).toHaveValue('Bump a to 2\n\nThe tests expect it.');

    // No user.name or user.email in git: Commit names them and commits nothing.
    await scmSection(shell).getByTestId('scm-commit').click();
    await expect(scmSection(shell).getByTestId('scm-commit-feedback')).toHaveText('Make sure you configure your "user.name" and "user.email" in git.');
    expect(await git(home, home.project, 'rev-list', '--count', 'HEAD')).toBe('1');
  } finally {
    await stub.close();
  }
});

test('a merge in progress shows Commit Merge and Abort Merge; a rebase shows Continue Rebase and Abort Rebase and continues without an editor', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'base\n' });
  await git(home, home.project, 'checkout', '-b', 'feat');
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'feat\n');
  await git(home, home.project, 'commit', '-am', 'Feat edit');
  await git(home, home.project, 'checkout', 'main');
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'main\n');
  await git(home, home.project, 'commit', '-am', 'Main edit');
  await git(home, home.project, 'merge', 'feat').catch(() => undefined);
  fs.writeFileSync(path.join(home.project, '.git', 'tmpl.txt'), 'tmpl: subject\n');
  await git(home, home.project, 'config', 'commit.template', '.git/tmpl.txt');

  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await expect(scmSection(shell).getByTestId('scm-operation')).toHaveAttribute('data-operation', 'merge');
  await expect(changeRow(shell, 'merge', 'a.ts')).toHaveAttribute('data-letter', '!');
  await expect(scmSection(shell).getByTestId('scm-commit')).toContainText('Commit Merge');
  // MERGE_MSG comes before the commit template, and the template comes back once the merge ends
  await expect(commitMessage(shell)).toHaveValue(/^Merge branch 'feat'/);
  await scmSection(shell).getByTestId('scm-commit').click();
  await expect(scmSection(shell).getByTestId('scm-commit-feedback')).toHaveText('Resolve the merge conflicts before committing');
  await scmSection(shell).getByTestId('scm-abort').click();
  await expect(scmSection(shell).getByTestId('scm-operation')).toHaveCount(0);
  expect(fs.existsSync(path.join(home.project, '.git', 'MERGE_HEAD'))).toBe(false);
  await expect(commitMessage(shell)).toHaveValue('tmpl: subject');

  // A rebase of feat onto main stops on the conflict; resolving, staging and Continue Rebase finish it.
  await git(home, home.project, 'checkout', 'feat');
  await git(home, home.project, 'rebase', 'main').catch(() => undefined);
  await expect(scmSection(shell).getByTestId('scm-operation')).toHaveAttribute('data-operation', 'rebase');
  await expect(scmSection(shell).getByTestId('scm-commit')).toContainText('Continue Rebase');
  await expect(scmSection(shell).getByTestId('scm-abort')).toHaveText('Abort Rebase');
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'resolved\n');
  await inline(changeRow(shell, 'merge', 'a.ts'), 'scm-row-stage');
  await expect(changeRow(shell, 'index', 'a.ts')).toBeVisible();
  await scmSection(shell).getByTestId('scm-commit').click();
  await expect(scmSection(shell).getByTestId('scm-operation')).toHaveCount(0, { timeout: 20_000 });
  expect(fs.existsSync(path.join(home.project, '.git', 'rebase-merge'))).toBe(false);
  expect(await git(home, home.project, 'log', '-1', '--format=%s')).toBe('Feat edit');
});

test('the Source control title reads whole beside its actions at the default width, its count badge giving way whole first', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n' });
  for (let index = 0; index < 12; index++) fs.writeFileSync(path.join(home.project, `new-${index}.ts`), '\n');
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  const badge = scmSection(shell).getByTestId('scm-count');
  await expect(badge).toHaveText('12');
  const header = scmSection(shell).getByTestId('sidebar-section-header');
  // Boxes include transforms, so the actions' slide-in and the badge's pop finish first; the claim is about the layout.
  const measure = (): Promise<{ whole: boolean; badge: string; clear: boolean }> => header.evaluate(async (element) => {
    const finite = element.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity);
    await Promise.all(finite.map((animation) => animation.finished.catch(() => undefined)));
    const box = (testId: string): DOMRect | undefined => element.querySelector(`[data-testid="${testId}"]`)?.getBoundingClientRect();
    const title = element.querySelector<HTMLElement>('[data-testid="sidebar-section-title"]')!;
    const line = box('sidebar-section-title-line')!;
    const count = box('scm-count')!;
    const actions = box('sidebar-section-actions');
    return {
      whole: title.scrollWidth <= title.clientWidth,
      // the badge shows whole on the title's line, or not at all
      badge: count.right <= line.right + 0.5 && count.bottom <= line.bottom + 0.5 ? 'shown' : count.top >= line.bottom - 0.5 ? 'gone' : 'cut',
      clear: actions === undefined || actions.width === 0 || actions.left >= title.getBoundingClientRect().right,
    };
  });
  await header.hover();
  await expect(scmSection(shell).getByTestId('sidebar-section-actions')).toBeVisible();
  expect(await measure()).toEqual({ whole: true, badge: expect.stringMatching(/^(shown|gone)$/), clear: true });
  // at rest the badge has the room again
  await shell.mouse.move(1200, 600);
  await shell.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(scmSection(shell).getByTestId('sidebar-section-actions')).toBeHidden();
  expect(await measure()).toEqual({ whole: true, badge: 'shown', clear: true });
});

test('Source control shorter than its branch row and commit box scrolls them with its changes, so a change stays in reach of the pointer and the keys', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n' });
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 2;\n');
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeVisible();

  // End on the sash above Source control leaves it its minimum, as a short display does
  await shell.locator('[data-testid="section-sash"][data-between="files scm"]').press('End');
  await settled(shell);
  const body = scmSection(shell).getByTestId('scm-body');
  expect(await body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const inBody = (row: Locator): Promise<boolean> => row.evaluate((node) => {
    const view = node.closest('[data-testid="scm-body"]')!.getBoundingClientRect();
    const box = node.getBoundingClientRect();
    return box.top >= view.top && box.bottom <= view.bottom;
  });

  // ArrowDown from the group's row, scrolled out of view, brings the change into the body
  await groupRow(shell, 'workingTree').focus();
  await body.evaluate((node) => { node.scrollTop = 0; });
  expect(await inBody(changeRow(shell, 'workingTree', 'a.ts'))).toBe(false);
  await shell.keyboard.press('ArrowDown');
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeFocused();
  expect(await inBody(changeRow(shell, 'workingTree', 'a.ts'))).toBe(true);

  await body.evaluate((node) => { node.scrollTop = 0; });
  await inline(changeRow(shell, 'workingTree', 'a.ts'), 'scm-row-stage');
  await expect(changeRow(shell, 'index', 'a.ts')).toBeVisible();
});

test('an untrusted project runs no git, and granting trust activates Source control with its nested repository and submodule, without a reload', async ({ home, launch }) => {
  const outside = path.join(home.root, 'sub-origin');
  await initRepo(home, outside, { 'lib.ts': 'export {};\n' });
  await initRepo(home, home.project);
  await git(home, home.project, '-c', 'protocol.file.allow=always', 'submodule', 'add', outside, 'libs/sub');
  await git(home, home.project, 'commit', '-m', 'Add the submodule');
  await initRepo(home, path.join(home.project, 'nested'));

  const { app } = await launch({ env: HOOKS });
  await addProject(app, home.project, false);
  const shell = await shellPage(app);
  // The minimum window, where the card is taller than its section: its action must still scroll into reach.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(900, 600));
  await expect(state(shell)).toHaveAttribute('data-state', 'untrusted');
  await expect(state(shell)).toContainText('Trust this folder to use source control');
  expect(await gitLog(app)).toBe('');

  await answerDialogs(app, { [TRUST_PROMPT]: 'Trust Folder' });
  await state(shell).getByTestId('scm-state-action').click();
  await expect(commitMessage(shell)).toBeVisible({ timeout: 30_000 });
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toContainText('1 of 3');
  // The same log read shows git once trust allows it, so the empty read above is no blind spot.
  await expect.poll(() => gitLog(app)).toContain('> git ');
  expect((await askedDialogs(app)).filter((dialog) => dialog.message.startsWith(TRUST_PROMPT))).toHaveLength(2);
});

test('more than 10,000 changes shows the status limit warning', async ({ home, launch }) => {
  await initRepo(home, home.project);
  const many = path.join(home.project, 'many');
  fs.mkdirSync(many);
  for (let index = 0; index <= 10_000; index++) fs.writeFileSync(path.join(many, `f${index}.txt`), '');

  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await expect(scmSection(shell).getByTestId('scm-too-many')).toHaveText('Too many changes were detected. Only the first 10000 changes will be shown below.', { timeout: 60_000 });
  await expect(scmSection(shell).getByTestId('scm-count')).toHaveText('10000');
});

test('a folder without a repository offers Initialize Repository, which runs git init there and activates the view', async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'readme.md'), '# alpha\n');
  const { app } = await launch({ env: HOOKS });
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect(state(shell)).toHaveAttribute('data-state', 'noRepository');
  await expect(state(shell)).toContainText("The folder currently open doesn't have a Git repository. You can initialize a repository which will enable source control features powered by Git.");
  await state(shell).getByTestId('scm-state-action').click();
  await expect(commitMessage(shell)).toBeVisible({ timeout: 30_000 });
  expect(fs.existsSync(path.join(home.project, '.git'))).toBe(true);
  await expect(changeRow(shell, 'workingTree', 'readme.md')).toHaveAttribute('data-letter', 'U');
});

test('Close Repository hides a nested repository, Reopen brings it back, the closed state survives a restart, and Open Repository reaches below the scan depth but not outside', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  await initRepo(home, path.join(home.project, 'nested'));
  const deep = path.join(home.project, 'one', 'two', 'deep');
  await initRepo(home, deep);
  const outside = path.join(home.root, 'elsewhere');
  await initRepo(home, outside);

  let desktop = await launch({ env: HOOKS });
  let shell = await openScmProject(desktop.app, home.project);
  const picker = scmSection(shell).getByTestId('scm-repo-picker');
  await expect(picker).toContainText('1 of 2');

  // The picker's menu: select the nested repository, close it, and reopen it from More Actions › Repositories.
  let overlay = await openPicker(desktop.app, shell);
  await overlayMenu(overlay).locator('[data-item-id^="repo:"]').nth(1).click();
  await expect(scmSection(shell).getByTestId('scm-repo-name')).toHaveText('nested');
  overlay = await openPicker(desktop.app, shell);
  await menuItem(overlay, 'closeRepository').click();
  await expect(picker).toHaveCount(0);
  await moreActions(desktop.app, shell, 'reopenClosed', 'repositories');
  await pickQuickItem(desktop.app, path.join(home.project, 'nested'));
  await expect(picker).toContainText('of 2');

  // Closed again, it stays closed after a restart.
  overlay = await openPicker(desktop.app, shell);
  await overlayMenu(overlay).locator('[data-item-id^="repo:"]').nth(1).click();
  await expect(scmSection(shell).getByTestId('scm-repo-name')).toHaveText('nested');
  await moreActions(desktop.app, shell, 'closeRepository', 'repositories');
  await expect(picker).toHaveCount(0);
  await desktop.close();
  desktop = await launch({ env: HOOKS });
  await recordToasts(desktop.app);
  shell = await shellPage(desktop.app);
  await expect(commitMessage(shell)).toBeVisible({ timeout: 30_000 });
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toHaveCount(0);

  // Open Repository: a folder below the scan depth opens; one outside the project folder is refused.
  await answerOpenDialog(desktop.app, deep);
  await runCommand(desktop.app, 'open repository', 'damocles.git.openRepository');
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toContainText('of 2');
  await answerOpenDialog(desktop.app, outside);
  await runCommand(desktop.app, 'open repository', 'damocles.git.openRepository');
  await expect.poll(async () => (await recordedToasts(desktop.app)).map((notice) => notice.message)).toContain('Open Repository opens a repository inside the project folder only.');
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toContainText('of 2');
});

test('a linked worktree found while scanning stays closed, and a project that is itself a linked worktree opens its own repository', async ({ home, launch }) => {
  await initRepo(home, home.project);
  await git(home, home.project, 'worktree', 'add', '-b', 'inside', path.join(home.project, 'wt'));
  const outsideTree = path.join(home.root, 'p', 'beta');
  await git(home, home.project, 'worktree', 'add', '-b', 'beta-branch', outsideTree);

  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await expect(scmSection(shell).getByTestId('scm-repo-picker')).toHaveCount(0);

  await openScmProject(app, outsideTree);
  await expect(commitMessage(shell)).toHaveAttribute('placeholder', /beta-branch/);
  await expect.poll(async () => (await shellState(app)).projects.find((project) => project.fsPath === outsideTree)?.branch).toBe('beta-branch');
});

test('untracked changes apart: Stage All Untracked stages only them, Discard All Tracked leaves them, discarding one trashes it, and hidden shows none', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n' });
  writeUserSettings(home, { 'damocles.desktop.git.untrackedChanges': 'separate' });
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 2;\n');
  fs.writeFileSync(path.join(home.project, 'new.ts'), 'export {};\n');
  fs.writeFileSync(path.join(home.project, 'scratch.txt'), 'scratch\n');

  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await expect(changeRow(shell, 'untracked', 'new.ts')).toBeVisible();
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeVisible();
  await expect(changeRow(shell, 'workingTree', 'new.ts')).toHaveCount(0);

  // Discarding one untracked file moves it to the trash after VS Code's confirmation.
  await answerDialogs(app, { 'Are you sure you want to DELETE': process.platform === 'win32' ? 'Move to Recycle Bin' : 'Move to Trash' });
  await inline(changeRow(shell, 'untracked', 'scratch.txt'), 'scm-row-discard');
  await expect.poll(() => fs.existsSync(path.join(home.project, 'scratch.txt'))).toBe(false);
  // Stage All Untracked stages the group as the view shows it, so it waits until the trashed file has left the group.
  await expect(changeRow(shell, 'untracked', 'scratch.txt')).toHaveCount(0);

  await moreActions(app, shell, 'stageAllUntracked', 'changes');
  await expect(changeRow(shell, 'index', 'new.ts')).toBeVisible();
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeVisible();

  await git(home, home.project, 'reset', '-q', 'new.ts');
  await expect(changeRow(shell, 'untracked', 'new.ts')).toBeVisible();
  await answerDialogs(app, { 'Are you sure you want to discard changes in': 'Discard File' });
  await inline(groupRow(shell, 'workingTree'), 'scm-group-discardAllTracked');
  // the working copy is briefly absent between its trash step and git writing the index version
  await expect.poll(() => fs.promises.readFile(path.join(home.project, 'a.ts'), 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  })).toBe('export const a = 1;\n');
  expect(fs.existsSync(path.join(home.project, 'new.ts'))).toBe(true);
  // The tracked discard trashes the working copy first, so its question says where it went instead of VS Code's warning.
  const discarded = (await askedDialogs(app)).find((dialog) => dialog.message.includes('Are you sure you want to discard changes in'));
  expect(discarded).toMatchObject({
    severity: 'danger',
    detail: process.platform === 'win32' ? 'You can restore the changed file from the Recycle Bin.' : 'You can restore the changed file from the Trash.',
    buttons: expect.arrayContaining(['Discard File', 'Cancel']),
  });
  expect(`${discarded!.message}${discarded!.detail ?? ''}`).not.toContain('IRREVERSIBLE');

  // Hidden: status leaves untracked files out (-uno), so they show nowhere.
  const overlay = await openSettingsModal(app, 'sourceControl');
  await chooseSegment(settingsRow(overlay, 'damocles.desktop.git.untrackedChanges'), 'Hidden');
  await closeSettingsModal(overlay);
  await expect(groupRow(shell, 'untracked')).toHaveCount(0);
  await expect(scmSection(shell).locator('[data-testid="scm-change"][data-path="new.ts"]')).toHaveCount(0);
  await expect.poll(async () => (await gitLog(app)).includes('-uno')).toBe(true);
});

test('a long change list scrolls with the commit box to its last row and stays there, in one scroll container', async ({ foreground: _foreground, home, launch }) => {
  const files = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`f${String(i).padStart(3, '0')}.ts`, 'a\n']));
  await initRepo(home, home.project, files);
  for (const name of Object.keys(files)) fs.writeFileSync(path.join(home.project, name), 'b\n');
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  const body = scmSection(shell).getByTestId('scm-body');
  await expect(changeRow(shell, 'workingTree', 'f000.ts')).toBeVisible();
  // A tree that scrolls by itself shows a second scrollbar inside the body's.
  expect(await scmSection(shell).getByTestId('scm-tree').evaluate((el) => getComputedStyle(el).overflowY)).toBe('visible');
  await body.hover();
  const gap = (): Promise<number> => body.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

  // Scrolling unmounts rows as it goes; a row that lingers for its leave transition lets scroll anchoring pull the list back.
  await expect.poll(async () => {
    await shell.mouse.wheel(0, 400);
    return gap();
  }, { timeout: 20_000 }).toBeLessThan(1);
  await expect(changeRow(shell, 'workingTree', 'f149.ts')).toBeVisible();
  // A pull-back lands frames after the last wheel, so the bottom must hold in every frame of a window, not in one read.
  const worstGap = (frames: number): Promise<number> => body.evaluate(async (el, count) => {
    let worst = 0;
    for (let frame = 0; frame < count; frame++) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      worst = Math.max(worst, el.scrollHeight - el.clientHeight - el.scrollTop);
    }
    return worst;
  }, frames);
  expect(await worstGap(30)).toBeLessThan(1);
});

test('after Unstage Selected Ranges in the Staged Changes diff, Stage Selected Ranges on the code tab stages the hunk again, and a selection without changes is told so', async ({ foreground: _foreground, home, launch }) => {
  const base = ['const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'const f = 6;', 'const g = 7;', 'const h = 8;', ''].join('\n');
  await initRepo(home, home.project, { 'app.ts': base });
  fs.writeFileSync(path.join(home.project, 'app.ts'), base.replace('const b = 2;', 'const b = 20;').replace('const g = 7;', 'const g = 70;'));
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  const cached = (): Promise<string> => git(home, home.project, 'diff', '--cached', '--unified=0');
  const marks = (): Promise<string | null> => codeEditor(shell).getAttribute('data-quick-diff');
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'app.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'const b = 20;');
  await expect.poll(marks).toBe('2-2,7-7');

  await inline(changeRow(shell, 'workingTree', 'app.ts'), 'scm-row-stage');
  await expect(changeRow(shell, 'workingTree', 'app.ts')).toHaveCount(0);
  await expect.poll(marks).toBe('2-2s,7-7s');

  // Unstage Selected Ranges in the Staged Changes diff takes the first hunk out of the index.
  await changeRow(shell, 'index', 'app.ts').click();
  await expect(diffEditor(shell)).toHaveAttribute('data-monaco-ready', 'true');
  await diffEditor(shell).locator('.editor.modified .view-line', { hasText: 'const b = 20;' }).click();
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'N', [PRIMARY]);
  await expect.poll(cached).not.toContain('const b = 20;');

  // Stage Selected Ranges on the code tab, pressed as soon as it shows the file, stages the hunk. Nothing here holds the index
  // read, so the marks may already be drawn; quick-diff-model.test.ts covers an action that waits for the read.
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'app.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'const b = 20;');
  await codeEditor(shell).locator('.view-line', { hasText: 'const b = 20;' }).first().click();
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'S', [PRIMARY, 'alt']);
  await expect.poll(cached).toContain('+const b = 20;');
  await expect.poll(marks).toBe('2-2s,7-7s');

  // A selection with no unstaged change in it stages nothing and says so.
  await recordToasts(app);
  await codeEditor(shell).locator('.view-line', { hasText: 'const a = 1;' }).first().click();
  await pressKeys(app, '/shell/', 'K', [PRIMARY]);
  await pressKeys(app, '/shell/', 'S', [PRIMARY, 'alt']);
  await expect.poll(async () => (await recordedToasts(app)).map((toast) => toast.message)).toContain('The selection holds no unstaged changes, so nothing was staged.');
});
