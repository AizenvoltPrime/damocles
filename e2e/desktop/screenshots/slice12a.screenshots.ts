import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { WorktreeDialog } from '../../../src/desktop/preload/overlay-channels';
import { activeChat, expect, nextChat, selectChatPage, test } from '../support/fixtures';
import { git } from '../support/git';
import { menuItem, overlayMenu, readyOverlay } from '../support/overlay';
import { hostMessage, openProjectChat, rest, setFont, setReducedMotion, settled, shot, showShellTheme, THEMES, windowShot, type Theme } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { setSection, submenuItem } from '../support/scm';
import { CHIP_START, chatRow, edit, filesChip, HELD_SETUP, newMenu, openRowWorktreeMenu, optIn, setupReview, withStub } from '../support/worktree-chat';
import { shellPage, shellState } from '../support/shell';
import { openInEditor } from '../support/editor';
import { addProject, chatInput } from '../support/ui';
import { registryRecords, worktreeRepo } from '../support/worktree-repo';

// Review captures of slice 12a (worktree chats): the New split menu, rows, the Files chip, tab chips, Projects and Repositories
// rows, every worktree dialog, the composer states, Hand off, the header chips, the rewind note, the Blocked card, New chat in
// this worktree (the row +, the New menu's Continue group), the shared-worktree composer line and review note, and Remove
// Project's question about first messages waiting for their worktree (English and Greek). Dark and
// Light at the 13px default and a 16px host font, plus a reduced-motion pass right after a change. Names:
// <surface>-<theme>-<px>, and <surface>-reduced for the reduced-motion pass.
const WIDTH = 1440;
const HEIGHT = 900;
const FONTS = [13, 16] as const;
const HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } };

test.describe.configure({ mode: 'serial' });
test.setTimeout(1_200_000);

const passes = (): Array<{ theme: Theme; font: number }> => THEMES.flatMap((theme) => FONTS.map((font) => ({ theme, font })));
const YOLO = { 'damocles.dangerouslySkipPermissions': true };

/** The theme and host font on the shell, the overlay and, when given, a chat page. */
async function look(app: ElectronApplication, theme: Theme, font: number, tab?: Page): Promise<void> {
  await showShellTheme(app, theme);
  await setFont(app, font);
  if (tab) {
    await tab.evaluate((size) => document.documentElement.style.setProperty('--d-font-size', `${size}px`), font);
    await expect(tab.locator('body')).toHaveAttribute('data-vscode-theme-kind', `vscode-${theme}`);
    await settled(tab);
  }
}

// The section title actions take no space at rest (D65), as the captures show them; a pointer over the Chats header reveals them.
async function openNewMenu(app: ElectronApplication): Promise<Page> {
  const shell = await shellPage(app);
  await shell.getByTestId('sidebar-chats').getByTestId('sidebar-section-header').hover();
  await shell.getByTestId('new-chat-options').click();
  const overlay = await readyOverlay(app);
  await expect(newMenu(overlay)).toBeVisible();
  return overlay;
}

async function closeOverlayPopup(overlay: Page, popup: Locator): Promise<void> {
  await overlay.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
}

/** Opens the Repositories section's repository row and its Worktrees group, whichever repository the shown folder has. */
async function expandWorktrees(shell: Page): Promise<void> {
  const section = shell.getByTestId('repositories-section');
  await expect(section.getByTestId('repositories-row').first()).toBeVisible();
  const repoRow = section.locator('[data-testid="repositories-row"][data-kind="repo"]');
  if (await repoRow.count() > 0 && (await repoRow.first().getAttribute('aria-expanded')) !== 'true') await repoRow.first().getByTestId('repositories-twistie').click();
  const group = shell.locator('[data-testid="repositories-row"][data-kind="group"][data-name="worktrees"]');
  await expect(group).toBeVisible();
  if ((await group.getAttribute('aria-expanded')) !== 'true') await group.getByTestId('repositories-twistie').click();
  await expect(group).toHaveAttribute('aria-expanded', 'true');
}

/** Opens the chat's review tab (D60) from its header; the counter folds into More on a narrower header. */
async function openReview(tab: Page): Promise<void> {
  if (await tab.getByTestId('chat-header-changes').isVisible()) {
    await tab.getByTestId('chat-header-changes').click();
    return;
  }
  await tab.getByTestId('chat-header-more').click();
  await tab.locator('[data-testid="chat-header-more-menu"] [data-action="reviewChanges"]').click();
}

/** Hovers the kept chat's row until its + shows; a closing overlay can take the pointer's first hover. */
async function hoverPlus(shell: Page): Promise<Locator> {
  const row = chatRow(shell, 'Fix the login redirect');
  const plus = row.getByTestId('chat-action-new-in-worktree');
  await expect(async () => {
    await shell.mouse.move(0, 0);
    await row.hover();
    await expect(plus).toHaveCSS('opacity', '1', { timeout: 1000 });
  }).toPass({ timeout: 20_000 });
  return plus;
}

async function send(tab: Page, text: string, done: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
  await expect(tab.getByText(done)).toBeVisible({ timeout: 60_000 });
}

test('slice 12a shell captures: New menu, rows, Files chip, tab chip, Projects and Repositories rows', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), {
    files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' },
    branches: ['feat/a', 'fix/flaky-test'],
    remoteNewer: 2,
    modified: { 'b.ts': 'export const b = 2;\n' },
    untracked: { 'notes.md': '# notes\n' },
  });
  const hotfix = path.join(home.root, 'acme-hotfix');
  await git(home, repo.root, 'worktree', 'add', '--quiet', '-b', 'hotfix/login-500', hotfix);
  const untrusted = await worktreeRepo(home, path.join(home.root, 'untrusted'));
  await withStub(home, YOLO, async (stub) => {
    stub.replies.push({ chunks: ['Working in the worktree.'] }, { chunks: ['Short lived.'] });
    const { app } = await launch();
    await setContentSize(app, WIDTH, HEIGHT);
    await addProject(app, untrusted.project, false);
    await addProject(app, hotfix, true);
    await openProjectChat(app, repo.project);
    const shell = await shellPage(app);

    const kept = await optIn(app);
    await send(kept, 'Fix the login redirect', 'Working in the worktree.');
    const gone = await optIn(app);
    await send(gone, 'Try a throwaway idea', 'Short lived.');
    let overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Try a throwaway idea'));
    await submenuItem(overlay, 'worktree:delete').click();
    await overlay.locator('[data-dialog="delete"]').getByTestId('worktree-dialog-delete').click();
    await expect(chatRow(shell, 'Try a throwaway idea').getByTestId('chat-worktree-line')).toHaveText('Worktree deleted', { timeout: 60_000 });
    const record = registryRecords(home).find((each) => each.kind === 'chat' && each.deletedAt === undefined)!;
    stub.replies.push(edit(path.join(record.workingFolder, 'a.ts'), 'a = 1', 'a = 2'), { chunks: ['Raised a in the worktree.'] });
    await selectChatPage(app, kept);
    await send(kept, 'Raise a', 'Raised a in the worktree.');
    // A second chat in the kept chat's worktree, from its row's +; it is listed first and shares the worktree
    const beforeSibling = [await activeChat(app)];
    const plus = await hoverPlus(shell);
    await expect(plus).toHaveAttribute('title', 'New chat in this worktree');
    await plus.click();
    const sibling = await nextChat(app, beforeSibling);
    await expect(sibling.getByTestId('composer-worktree-shares')).toBeVisible({ timeout: 30_000 });
    // its first message gives it a session file, which the kept chat's count reads
    stub.replies.push({ chunks: ['Picking up from the same branch.'] });
    await send(sibling, 'Continue here', 'Picking up from the same branch.');
    await selectChatPage(app, kept);
    await expect(kept.getByTestId('composer-worktree-shares')).toBeVisible({ timeout: 30_000 });
    // a Delete shows the project folder (D33); the captures start from the kept chat's worktree
    if (await filesChip(shell).getAttribute('data-shown') !== 'worktree') await filesChip(shell).click({ position: CHIP_START });
    await expect(filesChip(shell)).toHaveAttribute('data-shown', 'worktree');
    const projectKey = (await shellState(app)).selected.projectKey!;
    const worktreeKey = (await shellState(app)).shownFolders[projectKey]!.rootKey;
    expect((await openInEditor(app, { projectKey: worktreeKey, relativePath: 'a.ts' })).ok).toBe(true);
    expect((await openInEditor(app, { projectKey, relativePath: 'a.ts' })).ok).toBe(true);
    await setSection(shell, 'repositories-section', true);

    for (const { theme, font } of passes()) {
      const t = (name: string): string => `${name}-${theme}-${font}`;
      await look(app, theme, font);
      await rest(shell);
      await windowShot(app, testInfo, t('worktree-chat-selected'));

      overlay = await openNewMenu(app);
      await windowShot(app, testInfo, t('new-menu-off'));
      await overlay.getByTestId('new-chat-menu-worktree').click();
      await windowShot(app, testInfo, t('new-menu-worktree'));
      await overlay.getByTestId('new-chat-menu-start').click();
      await windowShot(app, testInfo, t('new-menu-start-from'));
      await overlay.locator('[data-ref="refs/heads/feat/a"]').click();
      await windowShot(app, testInfo, t('new-menu-other-branch'));
      await closeOverlayPopup(overlay, newMenu(overlay));

      await filesChip(shell).click({ position: CHIP_START });
      overlay = await readyOverlay(app);
      await expect(overlayMenu(overlay)).toBeVisible();
      await windowShot(app, testInfo, t('files-chip-menu'));
      await menuItem(overlay, 'showProject').click();
      await expect(filesChip(shell)).toHaveAttribute('data-shown', 'project');
      await rest(shell);
      await windowShot(app, testInfo, t('files-chip-project-folder'));
      await filesChip(shell).click({ position: CHIP_START });
      await expect(filesChip(shell)).toHaveAttribute('data-shown', 'worktree');

      // the row menu with its Worktree submenu open
      overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Fix the login redirect'));
      await windowShot(app, testInfo, t('chat-row-worktree-menu'));
      // the first Escape closes the submenu, the second the menu
      await overlay.keyboard.press('Escape');
      await closeOverlayPopup(overlay, overlayMenu(overlay));

      await hoverPlus(shell);
      await shot(shell, testInfo, t('row-plus-hover'), shell.getByTestId('sidebar-chats'));
      await rest(shell);

      overlay = await openNewMenu(app);
      const continueRow = overlay.getByTestId('new-chat-menu-continue-row').first();
      await expect(continueRow).toBeVisible();
      await continueRow.hover();
      await windowShot(app, testInfo, t('new-menu-continue'));
      await closeOverlayPopup(overlay, newMenu(overlay));

      await look(app, theme, font, kept);
      await shot(kept, testInfo, t('composer-shares'));
      await openReview(kept);
      await expect(shell.getByTestId('chat-review-shared-note')).toBeVisible({ timeout: 30_000 });
      await shot(shell, testInfo, t('review-shared-note'), shell.getByTestId('review-tab'));
      // closed again, so the tab strip shot shows both roots' tabs
      await shell.locator('[data-testid="editor-tab"][aria-selected="true"] [data-testid="editor-tab-close"]').click();
      await expect(shell.getByTestId('review-tab')).toHaveCount(0);

      await shot(shell, testInfo, t('editor-tabs-two-roots'), shell.getByTestId('editor-tabs'));
      await expandWorktrees(shell);
      await shot(shell, testInfo, t('repositories-chat-worktree'), shell.getByTestId('repositories-section'));
      await shot(shell, testInfo, t('projects-adopted-worktree'), shell.getByTestId('sidebar-projects'));
    }

    // A pending opt-in, captured while it is selected (leaving it drops it), and the toggle disabled in an untrusted project.
    const pending = await optIn(app);
    for (const { theme, font } of passes()) {
      await look(app, theme, font, pending);
      await rest(shell);
      await windowShot(app, testInfo, `worktree-pending-${theme}-${font}`);
    }
    const untrustedKey = (await shellState(app)).projects.find((project) => project.fsPath === untrusted.project)!.key;
    await shell.evaluate((key) => window.damoclesShell!.selectProject(key), untrustedKey);
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(untrustedKey);
    for (const { theme, font } of passes()) {
      await look(app, theme, font);
      overlay = await openNewMenu(app);
      await windowShot(app, testInfo, `new-menu-untrusted-${theme}-${font}`);
      await closeOverlayPopup(overlay, newMenu(overlay));
    }

    await look(app, 'dark', 13);
    await setReducedMotion(app, true);
    await shell.evaluate((key) => window.damoclesShell!.selectProject(key), projectKey);
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(projectKey);
    overlay = await openNewMenu(app);
    await overlay.getByTestId('new-chat-menu-worktree').click();
    await windowShot(app, testInfo, 'new-menu-worktree-reduced');
    await closeOverlayPopup(overlay, newMenu(overlay));
    await setReducedMotion(app, false);
  });
});

test('slice 12a dialog captures: every worktree question', async ({ foreground: _foreground, home, launch }, testInfo) => {
  fs.mkdirSync(home.project, { recursive: true });
  const { app } = await launch(HOOKS);
  await setContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, home.project);
  const dialogs: Array<[string, WorktreeDialog]> = [
    ['dialog-setup-review', { dialog: 'setupReview', projectName: 'acme-api', commands: ['npm ci', 'npm run build:types', 'node scripts/seed-db.mjs --port $((3000 + DAMOCLES_WORKTREE_INDEX))'] }],
    ['dialog-delete', {
      dialog: 'delete',
      path: 'C:\\Users\\you\\.damocles\\worktrees\\acme-api\\k3f9a2c1',
      branch: 'damocles/fix-login-redirect',
      uncommitted: [{ path: 'src/auth/redirect.ts', letter: 'M' }, { path: 'test/auth.spec.ts', letter: 'A' }],
      submoduleChanges: [{ path: 'vendor/oauth-lib', letter: 'S' }],
      unmergedCommits: [{ hash: '9f3c2a17b0c4e5d6', subject: 'Never redirect back to /login after sign-in' }],
      deleteBranchDefault: false,
      deleteBranchLocked: false,
    }],
    ['dialog-delete-clean', { dialog: 'delete', path: 'C:\\Users\\you\\.damocles\\worktrees\\acme-api\\k3f9a2c1', branch: 'damocles/fix-login-redirect', uncommitted: [], submoduleChanges: [], unmergedCommits: [], deleteBranchDefault: true, deleteBranchLocked: false }],
    ['dialog-merge-message', { dialog: 'mergeMessage', branch: 'damocles/fix-login-redirect', target: 'main', files: [{ path: 'src/auth/redirect.ts', letter: 'M' }, { path: 'test/auth.spec.ts', letter: 'A' }] }],
    ['dialog-rewritten', { dialog: 'rewritten', branch: 'main' }],
    ['dialog-apply-refused', { dialog: 'refusal', action: 'apply', files: [{ path: 'src/auth/redirect.ts', letter: 'M' }] }],
    ['dialog-hand-off-refused', { dialog: 'refusal', action: 'handOff', files: [{ path: 'src/auth/redirect.ts', letter: 'M' }, { path: 'README.md', letter: 'D' }] }],
    ['dialog-hand-off-confirm', { dialog: 'handOffConfirm', direction: 'toWorktree', files: [{ path: 'src/auth/redirect.ts', letter: 'M', alsoUserEdits: false }, { path: 'src/auth/session.ts', letter: 'M', alsoUserEdits: true }, { path: 'test/auth.spec.ts', letter: 'A', alsoUserEdits: false }] }],
    ['dialog-hand-off-back', { dialog: 'handOffConfirm', direction: 'toProject', branch: 'damocles/fix-login-redirect', files: [{ path: 'src/auth/redirect.ts', letter: 'M', alsoUserEdits: false }] }],
    ['dialog-leftovers', { dialog: 'leftovers', items: [{ path: 'C:\\Users\\you\\.damocles\\worktrees\\acme-api\\stray01', reason: 'unregistered' }, { path: 'C:\\dev\\acme-api-old', reason: 'gitRecordOnly', repository: 'C:\\dev\\acme-api' }, { path: 'C:\\Users\\you\\.damocles\\worktrees\\acme-api\\gone0001', reason: 'missingFolder' }, { path: 'C:\\Users\\you\\.damocles\\worktrees\\acme-api\\idle0002', reason: 'noChat' }] }],
  ];
  const overlay = await readyOverlay(app);
  const open = overlay.getByTestId('worktree-dialog');
  const ask = async (dialog: WorktreeDialog): Promise<void> => {
    await app.evaluate((_electron, request) => {
      const hooks = (globalThis as unknown as { __damoclesE2e: { worktrees: { ask(d: unknown): Promise<unknown> } } }).__damoclesE2e;
      void hooks.worktrees.ask(request);
    }, dialog);
    await expect(open).toBeVisible();
  };
  for (const { theme, font } of passes()) {
    await look(app, theme, font);
    for (const [name, dialog] of dialogs) {
      await ask(dialog);
      await windowShot(app, testInfo, `${name}-${theme}-${font}`);
      await overlay.keyboard.press('Escape');
      await expect(open).toHaveCount(0);
    }
  }
  await look(app, 'dark', 13);
  await setReducedMotion(app, true);
  await ask(dialogs[7]![1]);
  await windowShot(app, testInfo, 'dialog-hand-off-confirm-reduced');
  await overlay.keyboard.press('Escape');
  await setReducedMotion(app, false);
});

test('slice 12a chat captures: composer states, Hand off, header chips, the rewind note and the Blocked card', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' } });
  await withStub(home, YOLO, async (stub) => {
    const { app } = await launch();
    await setContentSize(app, WIDTH, HEIGHT);
    const tab = await openProjectChat(app, repo.project);
    // the placeholder a resuming chat shows takes the empty composer's height, which the page state keeps for a restore
    const composerRem = await tab.getByTestId('composer').evaluate((card) => card.getBoundingClientRect().height / parseFloat(getComputedStyle(document.documentElement).fontSize));
    await expect.poll(() => tab.evaluate(() => (window as unknown as { damoclesBridge: { getState: () => { composerHeight?: number } | undefined } }).damoclesBridge.getState()?.composerHeight)).toBeCloseTo(composerRem, 1);
    stub.replies.push(edit(path.join(repo.project, 'a.ts'), 'a = 1', 'a = 2'), { chunks: ['Edited a in the project folder.'] });
    await send(tab, 'Raise a', 'Edited a in the project folder.');
    const header = tab.getByTestId('chat-header');

    for (const { theme, font } of passes()) {
      await look(app, theme, font, tab);
      await shot(tab, testInfo, `hand-off-button-${theme}-${font}`, header);
      await tab.getByTestId('chat-header-hand-off').click();
      await expect(tab.getByTestId('hand-off-menu')).toBeVisible();
      await shot(tab, testInfo, `hand-off-menu-project-${theme}-${font}`);
      await tab.keyboard.press('Escape');
      await expect(tab.getByTestId('hand-off-menu')).toHaveCount(0);
    }

    await tab.getByTestId('chat-header-hand-off').click();
    await tab.getByTestId('hand-off-move').click();
    const overlay = await readyOverlay(app);
    await overlay.locator('[data-dialog="handOffConfirm"]').getByTestId('worktree-dialog-move').click();
    await expect(tab.getByTestId('chat-header-worktree')).toBeVisible({ timeout: 60_000 });
    // the folder switch's toast leaves on its own; the captures show the chat under it
    await expect(tab.locator('[data-sonner-toast]')).toHaveCount(0, { timeout: 30_000 });
    stub.replies.push(edit(path.join(repo.project, 'b.ts'), 'b = 1', 'b = 2'), { chunks: ['That path is the project folder, so I edit the worktree copy instead.'] });
    await send(tab, 'Edit b in the project folder', 'That path is the project folder, so I edit the worktree copy instead.');
    await expect(tab.getByTestId('tool-card-blocked')).toBeVisible();
    const record = registryRecords(home).find((each) => each.kind === 'chat')!;

    for (const { theme, font } of passes()) {
      await look(app, theme, font, tab);
      await shot(tab, testInfo, `blocked-card-${theme}-${font}`);
      await tab.getByTestId('chat-header-hand-off').click();
      await expect(tab.getByTestId('hand-off-menu')).toBeVisible();
      await shot(tab, testInfo, `hand-off-menu-worktree-${theme}-${font}`);
      await tab.keyboard.press('Escape');
      await tab.getByTestId('chat-header-more').click();
      await tab.locator('[data-testid="chat-header-more-menu"] [data-action="rewind"]').click();
      const browser = tab.getByTestId('rewind-browser');
      await expect(browser).toBeVisible();
      await browser.getByTestId('rewind-search').fill('Raise a');
      await expect(browser.getByTestId('rewind-hand-off-note')).toBeVisible();
      await shot(tab, testInfo, `rewind-hand-off-note-${theme}-${font}`);
      await tab.keyboard.press('Escape');
      await expect(browser).toHaveCount(0);
    }

    await tab.getByTestId('chat-header-worktree').click();
    await expect(tab.getByTestId('chat-header-worktree-menu')).toBeVisible();
    for (const { theme, font } of passes()) {
      await look(app, theme, font, tab);
      await shot(tab, testInfo, `header-worktree-menu-${theme}-${font}`);
    }
    await tab.keyboard.press('Escape');
    await expect(tab.getByTestId('chat-header-worktree-menu')).toHaveCount(0);

    // Composer and header states core reaches through setup, failures, a moved branch and a deleted worktree.
    const HELD = { text: 'Fix the login redirect so a signed-in user never lands back on /login', imageCount: 1 };
    const states: Array<[string, Record<string, unknown>]> = [
      ['composer-worktree-chip', { phase: 'pending', place: 'project', canHandOff: false, branch: 'main', uncommittedCount: 3 }],
      ['composer-creating', { phase: 'creating', place: 'worktree', projectName: 'acme', canHandOff: false, branch: record.branch }],
      ['composer-setting-up', { phase: 'settingUp', place: 'worktree', projectName: 'acme', canHandOff: false, branch: record.branch, setupStep: { command: 'npm run build:types', index: 2, total: 3 }, heldPrompt: HELD }],
      ['composer-setup-failed', { phase: 'setupFailed', place: 'worktree', projectName: 'acme', canHandOff: false, branch: record.branch, exitCode: 1, heldPrompt: HELD }],
      ['composer-create-failed', { phase: 'createFailed', place: 'project', canHandOff: false, heldPrompt: HELD, error: "fatal: cannot lock ref 'refs/heads/ax/fix-login': 'refs/heads/ax' exists; cannot create 'refs/heads/ax/fix-login'" }],
      ['composer-finishing', { phase: 'ready', place: 'worktree', projectName: 'acme', canHandOff: false, branch: record.branch, baseBranch: 'main', finishing: 'merge' }],
      ['header-behind', { phase: 'ready', place: 'worktree', projectName: 'acme', canHandOff: true, branch: record.branch, baseBranch: 'main', behind: 2 }],
      ['header-rewritten', { phase: 'ready', place: 'worktree', projectName: 'acme', canHandOff: false, branch: record.branch, baseBranch: 'main', targetRewritten: true }],
      ['composer-read-only', { phase: 'deleted', place: 'project', canHandOff: false }],
    ];
    for (const { theme, font } of passes()) {
      await look(app, theme, font, tab);
      for (const [name, state] of states) {
        await hostMessage(app, tab, { type: 'worktreeState', ...state });
        await settled(tab);
        await shot(tab, testInfo, `${name}-${theme}-${font}`);
      }
    }
    await look(app, 'dark', 13, tab);
    await tab.emulateMedia({ reducedMotion: 'reduce' });
    await hostMessage(app, tab, { type: 'worktreeState', phase: 'settingUp', place: 'worktree', projectName: 'acme', canHandOff: false, branch: record.branch });
    await shot(tab, testInfo, 'composer-setting-up-reduced');
    await hostMessage(app, tab, { type: 'worktreeState', phase: 'setupFailed', place: 'worktree', projectName: 'acme', canHandOff: false, branch: record.branch, exitCode: 1 });
    await shot(tab, testInfo, 'composer-setup-failed-reduced');
    await tab.emulateMedia({ reducedMotion: null });
  });
});

test('slice 12a Remove Project captures: the question about first messages waiting for their worktree, in English and Greek', async ({ foreground: _foreground, home, launch }, testInfo) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { setup: { setup: [HELD_SETUP] } });
  for (const language of ['en', 'el'] as const) {
    // the quit below ends the Setup tasks without asking
    await withStub(home, { 'damocles.desktop.language': language, 'damocles.desktop.terminal.confirmOnKill': 'never' }, async () => {
      const desktop = await launch();
      const { app } = desktop;
      await setContentSize(app, WIDTH, HEIGHT);
      // the Greek run starts with the project the English run added, restored and selected
      if (language === 'en') await openProjectChat(app, repo.project);
      else await activeChat(app);
      for (const text of ['Fix the login redirect so a signed-in user never lands back on /login', 'Add a regression test for the \u202Eredirect\u202C loop']) {
        const tab = await optIn(app);
        // the composer's placeholder is in the run's language
        const composer = tab.getByPlaceholder(/^(Ask Damocles anything|Ρωτήστε τον Damocles οτιδήποτε)/);
        await composer.fill(text);
        await composer.press('Enter');
        const overlay = await readyOverlay(app);
        // the setup review asks once per project and command list
        await expect(async () => {
          if (await setupReview(overlay).isVisible()) await setupReview(overlay).getByTestId('worktree-dialog-run').click();
          await expect(tab.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'settingUp', { timeout: 1000 });
        }).toPass({ timeout: 60_000 });
      }
      const shell = await shellPage(app);
      const projectKey = (await shellState(app)).selected.projectKey!;
      const removal = shell.evaluate((key) => window.damoclesShell!.removeProject(key), projectKey);
      const overlay = await readyOverlay(app);
      const question = overlay.getByTestId('overlay-message');
      await expect(question).toBeVisible();
      for (const theme of THEMES) {
        await look(app, theme, 13);
        await windowShot(app, testInfo, `remove-project-waiting-${language}-${theme}`);
      }
      await question.getByTestId('overlay-message-cancel').click();
      expect(await removal).toEqual({ ok: true });
      await desktop.close();
    });
  }
});
