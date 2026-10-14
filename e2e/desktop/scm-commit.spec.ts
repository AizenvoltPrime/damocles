import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, pressKeys, PRIMARY, selectedProjectKey } from './support/shell';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { commitMessage, gitLog, openScmProject, quickInput, scmSection, submenuItem } from './support/scm';
import { answerDialogs, askedDialogs } from './support/ui';
import { codeEditor, editorShows, editorTab, openInEditor, quickPick, DOCUMENT_END } from './support/editor';
import { closeSettingsModal, openSettingsModal, settingsRow } from './support/settings';
import { git, initRepo } from './support/git';
import { readUserSettings, writeUserSettings, type HermeticHome } from './support/hermetic';
import { clickSectionAction } from './support/shell-ui';

// Commit variants and commit behaviour the shell can reach, against real git in the hermetic home. Core's tests cover each
// variant's argv; scm-host.test.ts covers the push or sync after a commit, and scm-remote.spec.ts runs one against a bare remote.
const HOOKS = { DAMOCLES_E2E_HOOKS: '1' };

const SMART_COMMIT = 'There are no staged changes to commit';
const NO_VERIFY = 'without verification';
const EMPTY_COMMIT = 'create an empty commit';
const PROTECTED = 'You are trying to commit to a protected branch';
const UNSAVED = 'unsaved changes';

const commitButton = (shell: Page): Locator => scmSection(shell).getByTestId('scm-commit');
const changeRow = (shell: Page, group: string, file: string): Locator =>
  scmSection(shell).locator(`[data-testid="scm-change"][data-group="${group}"][data-path="${file}"]`);
const subject = (home: HermeticHome): Promise<string> => git(home, home.project, 'log', '-1', '--format=%s');
const commitCount = async (home: HermeticHome): Promise<number> => Number(await git(home, home.project, 'rev-list', '--count', 'HEAD'));

/** Writes `text` to `file` in the project and stages it with the git CLI, then waits for Source control to list it as staged. */
async function stageEdit(shell: Page, home: HermeticHome, file: string, text: string): Promise<void> {
  fs.writeFileSync(path.join(home.project, file), text);
  await git(home, home.project, 'add', file);
  await expect(changeRow(shell, 'index', file)).toBeVisible();
}

/** Opens the split button's menu and chooses `itemId`. */
async function commitMenu(app: ElectronApplication, shell: Page, itemId: string): Promise<void> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await scmSection(shell).getByTestId('scm-commit-menu').click();
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, itemId).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

/** Opens More Actions › Commit and returns the overlay with the submenu shown. */
async function openCommitSubmenu(app: ElectronApplication, shell: Page): Promise<Page> {
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await clickSectionAction(shell, 'scm-more-actions');
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, 'submenu:commit').click();
  await expect(submenuItem(overlay, 'commit')).toBeVisible();
  return overlay;
}

async function moreCommit(app: ElectronApplication, shell: Page, itemId: string): Promise<void> {
  const overlay = await openCommitSubmenu(app, shell);
  await submenuItem(overlay, itemId).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

/** Opens the palette and types `>query`; the list may still show an earlier query's answer. */
async function openPalette(app: ElectronApplication, query: string): Promise<Page> {
  const overlay = await overlayPage(app);
  await expect(quickPick(overlay)).toHaveCount(0);
  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(`>${query}`);
  return overlay;
}

/** Opens the palette with `>query`; resolves the overlay with the list loaded. */
async function palette(app: ElectronApplication, query: string): Promise<Page> {
  const overlay = await openPalette(app, query);
  await expect(overlay.getByTestId('quick-pick-item').first()).toBeVisible();
  return overlay;
}

async function runCommand(app: ElectronApplication, query: string, id: string): Promise<void> {
  const overlay = await palette(app, query);
  await overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`).click();
  await expect(quickPick(overlay)).toHaveCount(0);
}


test('amend rewrites HEAD, Signed Off adds the trailer, Up and Down recall earlier messages, and Undo Last Commit puts the message back', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);

  await stageEdit(shell, home, 'a.ts', 'export const a = 2;\n');
  await commitMessage(shell).fill('First change');
  await commitMessage(shell).press('ControlOrMeta+Enter');
  await expect.poll(() => subject(home)).toBe('First change');
  await expect(commitMessage(shell)).toHaveValue('');

  // Commit (Amend) from the split button: the banner names HEAD's subject, the empty box takes HEAD's message, and the
  // commit rewrites HEAD instead of adding one.
  await commitMenu(app, shell, 'toggleAmend');
  await expect(scmSection(shell).getByTestId('scm-amend-banner')).toContainText('Amending “First change”');
  await expect(commitButton(shell)).toContainText('Commit (Amend)');
  await expect(commitMessage(shell)).toHaveValue('First change');
  // Cancel restores the draft held before, and entering again with a draft keeps it.
  await scmSection(shell).getByTestId('scm-amend-cancel').click();
  await expect(commitMessage(shell)).toHaveValue('');
  await expect(scmSection(shell).getByTestId('scm-amend-banner')).toHaveCount(0);
  await commitMessage(shell).fill('First change, reworded');
  await commitMenu(app, shell, 'toggleAmend');
  await expect(commitMessage(shell)).toHaveValue('First change, reworded');
  await commitButton(shell).click();
  await expect.poll(() => subject(home)).toBe('First change, reworded');
  expect(await commitCount(home)).toBe(2);
  await expect(scmSection(shell).getByTestId('scm-amend-banner')).toHaveCount(0);
  await expect(commitButton(shell)).not.toContainText('Amend');

  // In amend mode every commit action amends: the split button's Signed Off item rewrites HEAD with git's trailer.
  await commitMenu(app, shell, 'toggleAmend');
  await expect(commitMessage(shell)).toHaveValue('First change, reworded');
  await commitMenu(app, shell, 'commitSigned');
  await expect.poll(() => git(home, home.project, 'log', '-1', '--format=%B')).toContain('Signed-off-by: Scm Tester <scm@example.com>');
  expect(await commitCount(home)).toBe(2);
  await expect(scmSection(shell).getByTestId('scm-amend-banner')).toHaveCount(0);

  // Commit (Signed Off) from the split button adds git's trailer.
  await stageEdit(shell, home, 'a.ts', 'export const a = 3;\n');
  await commitMessage(shell).fill('Signed change');
  await commitMenu(app, shell, 'commitSigned');
  await expect.poll(() => subject(home)).toBe('Signed change');
  expect(await git(home, home.project, 'log', '-1', '--format=%B')).toContain('Signed-off-by: Scm Tester <scm@example.com>');

  // Up and Down in the empty box walk the message history, newest first, and Down ends back at the empty draft.
  await expect(commitMessage(shell)).toHaveValue('');
  await commitMessage(shell).click();
  await commitMessage(shell).press('ArrowUp');
  await expect(commitMessage(shell)).toHaveValue(/^Signed change/);
  await commitMessage(shell).press('ArrowUp');
  await expect(commitMessage(shell)).toHaveValue('First change, reworded');
  await commitMessage(shell).press('ArrowDown');
  await expect(commitMessage(shell)).toHaveValue(/^Signed change/);
  await commitMessage(shell).press('ArrowDown');
  await expect(commitMessage(shell)).toHaveValue('');

  // Undo Last Commit: HEAD moves to the parent only while it still names the undone commit, as reset --soft does it; the
  // files are staged again and the message is back in the box.
  const [undone, parent] = (await git(home, home.project, 'rev-parse', 'HEAD', 'HEAD~')).split(/\r?\n/);
  await moreCommit(app, shell, 'undoLastCommit');
  await expect.poll(() => subject(home)).toBe('First change, reworded');
  await expect(commitMessage(shell)).toHaveValue(/^Signed change/);
  await expect(changeRow(shell, 'index', 'a.ts')).toBeVisible();
  await expect.poll(() => gitLog(app)).toContain(`update-ref -m "reset: moving to ${parent}" HEAD ${parent} ${undone}`);
});

test('in amend mode the palette and View › Source Control title the commit commands as the amends they run and drop Commit (Amend); Escape and a commit put them back', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  const menuLabel = (id: string): Promise<string | undefined> => app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.label, id);
  const paletteRow = (overlay: Page, id: string): Locator => overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);
  await stageEdit(shell, home, 'a.ts', 'export const a = 2;\n');
  await commitMessage(shell).fill('First change');
  await commitMessage(shell).press('ControlOrMeta+Enter');
  await expect.poll(() => subject(home)).toBe('First change');
  expect(await menuLabel('damocles.git.commit')).toBe('Commit');

  await commitMenu(app, shell, 'toggleAmend');
  await expect(scmSection(shell).getByTestId('scm-amend-banner')).toBeVisible();
  await expect.poll(() => menuLabel('damocles.git.commit')).toBe('Commit (Amend)');
  expect(await menuLabel('damocles.git.commitStagedSigned')).toBe('Commit Staged (Amend, Signed Off)');
  expect(await menuLabel('damocles.git.commitAmend')).toBeUndefined();
  let overlay = await palette(app, 'Git: Commit Staged');
  await expect(paletteRow(overlay, 'damocles.git.commitStaged')).toContainText('Git: Commit Staged (Amend)');
  await expect(paletteRow(overlay, 'damocles.git.commitStagedAmend')).toHaveCount(0);
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);

  // Escape in the box leaves amend mode, and the titles follow.
  await commitMessage(shell).click();
  await commitMessage(shell).press('Escape');
  await expect(scmSection(shell).getByTestId('scm-amend-banner')).toHaveCount(0);
  await expect.poll(() => menuLabel('damocles.git.commit')).toBe('Commit');
  expect(await menuLabel('damocles.git.commitAmend')).toBe('Commit (Amend)');
  overlay = await palette(app, 'Git: Commit Staged');
  await expect(paletteRow(overlay, 'damocles.git.commitStaged')).toContainText('Git: Commit Staged');
  await expect(paletteRow(overlay, 'damocles.git.commitStaged')).not.toContainText('Amend');
  await expect(paletteRow(overlay, 'damocles.git.commitStagedAmend')).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);

  // The palette's Commit, titled as the amend, rewrites HEAD, and the mode ends with the commit.
  await commitMenu(app, shell, 'toggleAmend');
  await expect.poll(() => menuLabel('damocles.git.commit')).toBe('Commit (Amend)');
  // The empty box takes HEAD's message when main answers; a fill before that lands its text after the message.
  await expect(commitMessage(shell)).toHaveValue('First change');
  await commitMessage(shell).fill('First change, amended');
  await runCommand(app, 'Git: Commit (Amend)', 'damocles.git.commit');
  await expect.poll(() => subject(home)).toBe('First change, amended');
  expect(await commitCount(home)).toBe(2);
  await expect.poll(() => menuLabel('damocles.git.commit')).toBe('Commit');
});

test('smart commit: with nothing staged Commit asks, Yes commits everything, Always sets enableSmartCommit and Never sets suggestSmartCommit off', async ({ home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);

  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 2;\n');
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeVisible();
  await answerDialogs(app, { [SMART_COMMIT]: 'Yes' });
  await commitMessage(shell).fill('Smart yes');
  await commitButton(shell).click();
  await expect.poll(() => subject(home)).toBe('Smart yes');
  const asked = (await askedDialogs(app)).find((dialog) => dialog.message.includes(SMART_COMMIT) || (dialog.detail ?? '').includes(SMART_COMMIT));
  expect(asked?.buttons).toEqual(expect.arrayContaining(['Yes', 'Always', 'Never']));

  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 3;\n');
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeVisible();
  await answerDialogs(app, { [SMART_COMMIT]: 'Always' });
  await commitMessage(shell).fill('Smart always');
  await commitButton(shell).click();
  await expect.poll(() => subject(home)).toBe('Smart always');
  await expect.poll(() => readUserSettings(home)['damocles.desktop.git.enableSmartCommit']).toBe(true);

  // Always commits without asking from now on.
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 4;\n');
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeVisible();
  const before = (await askedDialogs(app)).length;
  await commitMessage(shell).fill('Smart again');
  await commitButton(shell).click();
  await expect.poll(() => subject(home)).toBe('Smart again');
  expect((await askedDialogs(app)).length).toBe(before);

  // Smart commit off from its Settings row: Commit asks again, and Never turns the suggestion off and commits nothing.
  const overlay = await openSettingsModal(app, 'sourceControl');
  await settingsRow(overlay, 'damocles.desktop.git.enableSmartCommit').getByRole('switch').click();
  await expect.poll(() => readUserSettings(home)['damocles.desktop.git.enableSmartCommit']).toBe(false);
  await closeSettingsModal(overlay);
  fs.writeFileSync(path.join(home.project, 'a.ts'), 'export const a = 5;\n');
  await expect(changeRow(shell, 'workingTree', 'a.ts')).toBeVisible();
  await answerDialogs(app, { [SMART_COMMIT]: 'Never' });
  await commitMessage(shell).fill('Smart never');
  await commitButton(shell).click();
  await expect.poll(() => readUserSettings(home)['damocles.desktop.git.suggestSmartCommit']).toBe(false);
  expect(await subject(home)).toBe('Smart again');
  await expect(commitMessage(shell)).toHaveValue('Smart never');
});

test('No Verify shows nowhere while allowNoVerifyCommit is off; turned on, it asks and commits past a failing pre-commit hook; Commit Empty asks and commits no change', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const hook = path.join(home.project, '.git', 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, '#!/bin/sh\necho "the hook refuses" >&2\nexit 1\n', { mode: 0o755 });
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);

  // Off (the default): not in Commit ›, and no palette row for its title. The split button's menu never lists it.
  let overlay = await openCommitSubmenu(app, shell);
  await expect(overlay.locator('[data-submenu-item][data-item-id*="NoVerify"]')).toHaveCount(0);
  await overlay.keyboard.press('Escape');
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);
  overlay = await openPalette(app, 'No Verify');
  // The list is virtualized, so only an empty answer to this query proves no No Verify row exists.
  await expect(overlay.getByTestId('quick-pick-empty')).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);

  // The hook refuses a plain commit.
  await stageEdit(shell, home, 'a.ts', 'export const a = 2;\n');
  await commitMessage(shell).fill('Past the hook');
  await commitButton(shell).click();
  await expect.poll(() => gitLog(app)).toContain('the hook refuses');
  expect(await commitCount(home)).toBe(1);
  await expect(commitMessage(shell)).toHaveValue('Past the hook');

  // On, from its Settings row: Commit (No Verify) asks first, then commits past that hook.
  overlay = await openSettingsModal(app, 'sourceControl');
  await settingsRow(overlay, 'damocles.desktop.git.allowNoVerifyCommit').getByRole('switch').click();
  await expect.poll(() => readUserSettings(home)['damocles.desktop.git.allowNoVerifyCommit']).toBe(true);
  await closeSettingsModal(overlay);
  await answerDialogs(app, { [NO_VERIFY]: 'OK' });
  await moreCommit(app, shell, 'commitNoVerify');
  await expect.poll(() => subject(home)).toBe('Past the hook');
  expect((await askedDialogs(app)).some((dialog) => (dialog.message + (dialog.detail ?? '')).includes(NO_VERIFY))).toBe(true);
  await expect.poll(() => gitLog(app)).toMatch(/commit .*--no-verify/);
  overlay = await palette(app, 'No Verify');
  await expect(overlay.locator('[data-testid="quick-pick-item"][data-item-id="damocles.git.commitNoVerify"]')).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(quickPick(overlay)).toHaveCount(0);

  // Commit Empty (palette only) asks first and creates a commit that changes nothing.
  fs.rmSync(hook);
  const count = await commitCount(home);
  await answerDialogs(app, { [EMPTY_COMMIT]: 'Yes' });
  await commitMessage(shell).fill('Nothing changed');
  await runCommand(app, 'Commit Empty', 'damocles.git.commitEmpty');
  await expect.poll(() => subject(home)).toBe('Nothing changed');
  expect(await commitCount(home)).toBe(count + 1);
  expect(await git(home, home.project, 'diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD')).toBe('');
  expect((await askedDialogs(app)).some((dialog) => (dialog.message + (dialog.detail ?? '')).includes(EMPTY_COMMIT))).toBe(true);
});

test('commit.template fills the box and comes back after a commit and with Restore Commit Template; a protected branch asks and commits to a new branch named in the QuickInput; Rename stages a rename', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project, { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  const template = path.join(home.root, 'commit-template.txt');
  fs.writeFileSync(template, 'feat: \n\nWhy:\n');
  await git(home, home.project, 'config', 'commit.template', template);
  writeUserSettings(home, { 'damocles.desktop.git.branchProtection': ['main'], 'damocles.desktop.git.branchPrefix': 'me/' });
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);
  await expect(commitMessage(shell)).toHaveValue(/^feat: \n\nWhy:/);

  // Restore Commit Template brings it back over whatever the box holds.
  await commitMessage(shell).fill('Something else');
  await moreCommit(app, shell, 'restoreCommitTemplate');
  await expect(commitMessage(shell)).toHaveValue(/^feat: \n\nWhy:/);

  // Commit on main, a protected branch: the question, then a name box prefilled with the branch prefix, caret after it.
  await stageEdit(shell, home, 'a.ts', 'export const a = 2;\n');
  await commitMessage(shell).fill('Protected change');
  await answerDialogs(app, { [PROTECTED]: 'Commit to a New Branch' });
  await commitButton(shell).click();
  const overlay = await readyOverlay(app);
  await expect(quickInput(overlay)).toBeVisible();
  const field = overlay.getByTestId('quick-input-field');
  await expect(field).toHaveValue('me/');
  expect(await field.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([3, 3]);
  // A name git refuses is flagged as it is typed, and Enter does nothing.
  await overlay.keyboard.type('bad..name');
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  // Each change of message swaps it in, so the one before may still be leaving.
  await expect(overlay.getByTestId('quick-input-problem').filter({ hasText: "A name can't contain “..”" })).toHaveAttribute('data-code', 'doubleDot');
  await overlay.keyboard.press('Enter');
  await expect(quickInput(overlay)).toBeVisible();
  await field.fill('me/fix');
  await expect(field).toHaveAttribute('aria-invalid', 'false');
  await overlay.keyboard.press('Enter');
  await expect(quickInput(overlay)).toHaveCount(0);
  await expect.poll(() => git(home, home.project, 'branch', '--show-current')).toBe('me/fix');
  await expect.poll(() => subject(home)).toBe('Protected change');
  expect(await git(home, home.project, 'log', '-1', '--format=%s', 'main')).toBe('Initial commit');
  expect((await askedDialogs(app)).find((dialog) => dialog.message.includes(PROTECTED))?.buttons).toEqual(expect.arrayContaining(['Commit to a New Branch', 'Commit Anyway']));
  await expect.poll(() => gitLog(app)).toMatch(/check-ref-format --branch/);
  // After a commit the box holds the template again.
  await expect(commitMessage(shell)).toHaveValue(/^feat: \n\nWhy:/);

  // Git: Rename on the active editor's file asks for the new path, runs git mv, and the file shows as renamed under Staged.
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'b.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'export const b');
  await runCommand(app, 'Rename', 'damocles.git.rename');
  await expect(quickInput(overlay)).toBeVisible();
  await expect(field).toHaveValue('b.ts');
  await field.fill('renamed.ts');
  await overlay.keyboard.press('Enter');
  await expect(changeRow(shell, 'index', 'renamed.ts')).toHaveAttribute('data-letter', 'R');
  expect(fs.existsSync(path.join(home.project, 'renamed.ts'))).toBe(true);
  await expect.poll(() => gitLog(app)).toMatch(/ mv /);
});

test('a dirty editor of a changed file asks to save before committing; alwaysSignOff and enableCommitSigning put --signoff and -S on the commit; the Post-commit row offers None, Push and Sync, None selected', async ({ home, launch }) => {
  await initRepo(home, home.project);
  // -S fails the same way on every machine, and no gpg agent or keyboxd starts in the home.
  await git(home, home.project, 'config', 'gpg.program', path.join(home.root, 'no-such-gpg'));
  writeUserSettings(home, { 'damocles.desktop.git.alwaysSignOff': true, 'damocles.desktop.git.enableCommitSigning': true });
  const { app } = await launch({ env: HOOKS });
  const shell = await openScmProject(app, home.project);

  const overlay = await openSettingsModal(app, 'sourceControl');
  const postCommit = settingsRow(overlay, 'damocles.desktop.git.postCommitCommand');
  await expect(postCommit.locator('[aria-pressed]')).toHaveText(['None', 'Push', 'Sync']);
  await expect(postCommit.locator('[aria-pressed="true"]')).toHaveText('None');
  await closeSettingsModal(overlay);

  await stageEdit(shell, home, 'a.ts', 'export const a = 2;\n');
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'a.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'export const a = 2;');
  await codeEditor(shell).locator('.view-lines').click();
  await shell.keyboard.press(DOCUMENT_END);
  await shell.keyboard.type('// unsaved');
  await expect(editorTab(shell, 'a.ts')).toHaveAttribute('data-dirty', 'true');

  await answerDialogs(app, { [UNSAVED]: 'Save All & Commit Changes' });
  await commitMessage(shell).fill('Signed and saved');
  await commitButton(shell).click();
  await expect.poll(() => fs.readFileSync(path.join(home.project, 'a.ts'), 'utf8')).toContain('// unsaved');
  const asked = (await askedDialogs(app)).find((dialog) => (dialog.message + (dialog.detail ?? '')).includes(UNSAVED));
  expect(asked?.buttons).toEqual(expect.arrayContaining(['Save All & Commit Changes', 'Commit Changes']));
  // git refuses the commit, since gpg.program names no program; the command line is what the settings decide.
  await expect.poll(async () => (await gitLog(app)).split('\n').some((line) => / commit /.test(line) && line.includes('--signoff') && / -S( |$)/.test(line))).toBe(true);
  // Saving re-stages the staged file before the commit runs.
  expect(await git(home, home.project, 'diff', '--cached', 'a.ts')).toContain('// unsaved');
});
