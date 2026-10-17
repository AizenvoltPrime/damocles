import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { activeChat, expect, nextChat, panelIdOf, test } from './support/fixtures';
import { git } from './support/git';
import { writeUserSettings } from './support/hermetic';
import { chatRequests } from './support/openai-stub';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { pressKeys, shellPage, shellState } from './support/shell';
import { dismiss, openProjectChat } from './support/screenshots';
import { editorState, openInEditor } from './support/editor';
import { setSection, submenuItem } from './support/scm';
import { setContentSize } from './support/settings';
import { addProject, chatInput } from './support/ui';
import { clickSectionAction } from './support/shell-ui';
import { worktreeRepo, worktreesRoot } from './support/worktree-repo';
import { chatRowFrames, largestLogo, recordChatRow, type ChatRowFrame } from './support/chat-row-frames';
import { CHIP_START, chatRow, chatRows, closeNewMenu, edit, filesChip, HELD_SETUP, liveRecords, NEW_IN_WORKTREE_KEYS, newMenu, openNewMenu, openRowWorktreeMenu, optIn, QUICK_SETUP, send, setupReview, shownFolder, withStub } from './support/worktree-chat';
import { composerFrames, recordComposerFrames } from './support/composer-frames';

// Worktree chats (plan slice 12a, D30 to D33, D63): the New split button's menu, the first send with setup, the views
// following the selected chat, the finish actions and the read-only chat after a delete.


// The statuses a row showed, each run of equal frames once.
const statusRuns = (frames: readonly ChatRowFrame[]): Array<string | null> => frames.map((frame) => frame.worktree).filter((status, i, all) => i === 0 || status !== all[i - 1]);

test('a default New Chat creates no worktree and keeps Files on the project folder; the toggle says why it is off outside git, without a commit and untrusted', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'repo'));
  const plain = path.join(home.root, 'plain');
  fs.mkdirSync(plain, { recursive: true });
  fs.writeFileSync(path.join(plain, 'notes.md'), '# notes\n');
  const empty = path.join(home.root, 'empty');
  fs.mkdirSync(empty, { recursive: true });
  await git(home, empty, 'init', '-b', 'main');
  const untrusted = await worktreeRepo(home, path.join(home.root, 'untrusted'));

  const { app } = await launch();
  await openProjectChat(app, repo.project);
  const shell = await shellPage(app);
  const known = [await activeChat(app)];
  await clickSectionAction(shell, 'new-chat');
  await nextChat(app, known);
  expect(liveRecords(home)).toEqual([]);
  expect((await shownFolder(app))?.root.worktreeId).toBeUndefined();
  await expect(filesChip(shell)).toHaveCount(0);

  const cases: Array<[string, boolean, string]> = [
    [plain, true, "This folder isn't in a git repository"],
    [empty, true, 'This repository has no commits yet'],
    [untrusted.project, false, 'Trust this folder to use worktrees'],
  ];
  for (const [dir, trust, reason] of cases) {
    await addProject(app, dir, trust);
    const overlay = await openNewMenu(app);
    const toggle = overlay.getByTestId('new-chat-menu-worktree');
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).toHaveAttribute('title', reason);
    await expect(toggle).toContainText(reason);
    await toggle.dispatchEvent('click');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await closeNewMenu(overlay);
  }
  expect(liveRecords(home)).toEqual([]);
});

test('D63 options, an opt-in left before sending, then the first send: setup review, the held prompt, copies, the prefixed branch and the views on the worktree', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), {
    files: { 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' },
    worktreeInclude: '.env\n',
    ignored: { '.env': 'SECRET=1\n' },
    setup: { setup: [HELD_SETUP] },
    branches: ['feat/a'],
    remoteNewer: 2,
    modified: { 'a.ts': 'export const a = 2;\n', 'b.ts': 'export const b = 2;\n' },
    untracked: { 'new.txt': 'new\n' },
  });
  await withStub(home, { 'damocles.desktop.git.branchPrefix': 'ax/' }, async (stub) => {
    stub.replies.push({ chunks: ['Worktree turn done'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const shell = await shellPage(app);

    await test.step('the menu: Start from with current and 2 newer, Bring my uncommitted changes (3 files), the prefix line', async () => {
      const overlay = await openNewMenu(app);
      const toggle = overlay.getByTestId('new-chat-menu-worktree');
      await expect(toggle).toHaveAttribute('aria-checked', 'false');
      await expect(toggle).toContainText('Its own copy of the project, on its own branch');
      await toggle.click();
      await expect(overlay.getByTestId('new-chat-menu-start')).toContainText(/main\s*current/);
      await expect(overlay.getByTestId('new-chat-menu-bring')).toHaveAttribute('aria-checked', 'true');
      await expect(overlay.getByTestId('new-chat-menu-bring')).toContainText('3 files in acme. They are copied, so your folder keeps them too.');
      await expect(overlay.getByTestId('new-chat-menu-note')).toHaveText('Creates branch ax/... from main. Setup from .damocles/worktree.json runs before the first message.');
      await overlay.getByTestId('new-chat-menu-start').click();
      await expect(overlay.locator('[data-ref="refs/remotes/origin/main"]')).toContainText('2 newer');
      await overlay.locator('[data-ref="refs/heads/feat/a"]').click();
      await expect(overlay.getByTestId('new-chat-menu-bring')).toHaveCount(0);
      await closeNewMenu(overlay);
      // the toggle starts off on every open
      const again = await openNewMenu(app);
      await expect(again.getByTestId('new-chat-menu-worktree')).toHaveAttribute('aria-checked', 'false');
      await closeNewMenu(again);
    });

    await test.step('the opt-in chip; leaving the chat before sending creates nothing', async () => {
      const left = await optIn(app);
      await expect(left.getByTestId('worktree-chip')).toContainText('Worktree from main');
      await expect(left.getByTestId('worktree-chip')).toContainText('· +3 uncommitted');
      const known = [left];
      await clickSectionAction(shell, 'new-chat');
      await nextChat(app, known);
      expect(liveRecords(home)).toEqual([]);
      expect(fs.existsSync(worktreesRoot(home)) ? fs.readdirSync(worktreesRoot(home)).filter((name) => name !== 'registry.json') : []).toEqual([]);
    });

    const tab = await optIn(app);

    await test.step('first send: the review lists the setup command, the prompt waits for setup, then reaches the agent', async () => {
      await send(tab, 'Fix the login redirect');
      const overlay = await readyOverlay(app);
      await expect(setupReview(overlay)).toBeVisible();
      await expect(setupReview(overlay).getByTestId('worktree-dialog-commands')).toContainText('DAMOCLES_PROJECT_FOLDER');
      await setupReview(overlay).getByTestId('worktree-dialog-run').click();
      await expect(tab.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'settingUp');
      await expect(tab.getByTestId('worktree-status')).toContainText('Setting up worktree');
      expect(chatRequests(stub)).toHaveLength(0);
      fs.writeFileSync(path.join(repo.project, 'release'), '');
      await expect(tab.getByText('Worktree turn done')).toBeVisible({ timeout: 60_000 });
      await expect(tab.getByTestId('worktree-status')).toHaveCount(0);
    });

    const [record] = liveRecords(home);
    await test.step('the worktree: under ~/.damocles/worktrees, on ax/<slug> from main, with .env and the three uncommitted files', async () => {
      expect(record).toBeDefined();
      expect(path.relative(worktreesRoot(home), record!.worktreeRoot).startsWith('..')).toBe(false);
      expect(record!.branch).toBe('ax/fix-the-login-redirect');
      expect(await git(home, record!.workingFolder, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('ax/fix-the-login-redirect');
      expect(await git(home, record!.workingFolder, 'rev-parse', 'HEAD')).toBe(await git(home, repo.project, 'rev-parse', 'main'));
      expect(fs.readFileSync(path.join(record!.workingFolder, '.env'), 'utf8')).toBe('SECRET=1\n');
      expect(fs.readFileSync(path.join(record!.workingFolder, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(fs.readFileSync(path.join(record!.workingFolder, 'b.ts'), 'utf8')).toBe('export const b = 2;\n');
      expect(fs.readFileSync(path.join(record!.workingFolder, 'new.txt'), 'utf8')).toBe('new\n');
      expect(fs.readFileSync(path.join(repo.project, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
      expect(fs.existsSync(path.join(repo.project, 'new.txt'))).toBe(true);
      expect(fs.existsSync(path.join(record!.workingFolder, 'setup-ran.txt'))).toBe(true);
    });

    await test.step('the views show the worktree with its branch chip; Show project folder switches back without changing the chat', async () => {
      await expect(tab.getByTestId('chat-header-worktree')).toContainText('ax/fix-the-login-redirect');
      // chips and rows show the slug, which tells worktrees apart; the full branch is in their titles
      await expect(chatRow(shell, 'Fix the login redirect').getByTestId('chat-worktree-line')).toHaveText('fix-the-login-redirect');
      await expect(chatRow(shell, 'Fix the login redirect').getByTestId('chat-worktree-line')).toHaveAttribute('title', 'ax/fix-the-login-redirect');
      const chip = filesChip(shell);
      await expect(chip).toHaveAttribute('data-shown', 'worktree');
      await expect(chip.getByTestId('files-branch-chip-label')).toHaveText('fix-the-login-redirect');
      await expect(chip.getByTestId('files-branch-chip-main')).toHaveAttribute('aria-label', 'Worktree ax/fix-the-login-redirect');
      expect((await shownFolder(app))?.root.worktreeId).toBe(record!.id);
      const chatId = (await shellState(app)).selected.chatId;
      await chip.click({ position: CHIP_START });
      const overlay = await readyOverlay(app);
      await expect(overlayMenu(overlay)).toBeVisible();
      // this repository has a remote, so Push branch is offered
      await expect(menuItem(overlay, 'worktree:push')).not.toHaveAttribute('aria-disabled', 'true');
      await menuItem(overlay, 'showProject').click();
      await expect(chip).toHaveAttribute('data-shown', 'project');
      await expect(chip).toContainText('Project folder');
      expect((await shownFolder(app))?.root.worktreeId).toBeUndefined();
      expect((await shellState(app)).selected.chatId).toBe(chatId);
      // in the project folder the chevron opens the menu, and a click on the chip shows the worktree again (D31)
      await chip.getByTestId('files-branch-chip-menu').click();
      const menu = await readyOverlay(app);
      await expect(menuItem(menu, 'showWorktree')).toHaveAttribute('aria-checked', 'false');
      await dismiss(app, menu, overlayMenu(menu));
      await chip.click({ position: CHIP_START });
      await expect(chip).toHaveAttribute('data-shown', 'worktree');
      expect((await shellState(app)).selected.chatId).toBe(chatId);
    });

    await test.step('in a narrow sidebar at a larger font the branch chips end in an ellipsis inside their headers, with the full branch in their names', async () => {
      const [width, height] = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getContentSize() as [number, number]);
      await setContentSize(app, 900, 660);
      await shell.evaluate(() => document.documentElement.style.setProperty('--d-font-size', '16px'));
      const chips = () => shell.evaluate(() => [...document.querySelectorAll('[data-testid="files-branch-chip"]')].map((chip) => {
        const header = chip.closest('[data-testid="sidebar-section-header"]')!.getBoundingClientRect();
        const main = chip.querySelector('[data-testid="files-branch-chip-main"]')!.getBoundingClientRect();
        const label = chip.querySelector('[data-testid="files-branch-chip-label"]')!;
        return {
          section: chip.closest('[data-section]')!.getAttribute('data-section'),
          inside: chip.getBoundingClientRect().right <= header.right && label.getBoundingClientRect().right <= main.right + 0.5,
          shortened: label.scrollWidth > label.clientWidth ? getComputedStyle(label).textOverflow : 'whole',
        };
      }));
      // Source control's longer title and count leave its chip too little room for the whole branch.
      await expect.poll(chips).toEqual([
        { section: 'files', inside: true, shortened: expect.stringMatching(/^(whole|ellipsis)$/) },
        { section: 'scm', inside: true, shortened: 'ellipsis' },
      ]);
      for (const chip of await shell.getByTestId('files-branch-chip-main').all()) await expect(chip).toHaveAttribute('aria-label', 'Worktree ax/fix-the-login-redirect');
      await shell.evaluate(() => document.documentElement.style.removeProperty('--d-font-size'));
      await setContentSize(app, width, height);
    });

    await test.step('the same relative path opens as two tabs, the worktree one with the branch chip', async () => {
      const projectKey = (await shellState(app)).selected.projectKey!;
      const worktreeKey = (await shownFolder(app))!.rootKey;
      expect((await openInEditor(app, { projectKey: worktreeKey, relativePath: 'a.ts' })).ok).toBe(true);
      expect((await openInEditor(app, { projectKey, relativePath: 'a.ts' })).ok).toBe(true);
      const tabs = (await editorState(app)).tabs.filter((each) => each.relativePath === 'a.ts');
      expect(tabs.map((each) => each.projectKey).sort()).toEqual([projectKey, worktreeKey].sort());
      await expect(shell.locator('[data-testid="editor-tab"]', { hasText: 'a.ts' })).toHaveCount(2);
      await expect(shell.getByTestId('editor-tab-worktree')).toHaveCount(1);
      await expect(shell.getByTestId('editor-tab-worktree')).toContainText('fix-the-login-redirect');
      await expect(shell.getByTestId('editor-tab-worktree')).toHaveAttribute('title', 'Worktree ax/fix-the-login-redirect');
    });

    await test.step('a normal chat beside it keeps the project folder, and switching back shows the worktree again', async () => {
      const known = [tab];
      await clickSectionAction(shell, 'new-chat');
      const plainTab = await nextChat(app, known);
      await expect(chatInput(plainTab)).toBeVisible();
      await expect(filesChip(shell)).toHaveCount(0);
      expect((await shownFolder(app))?.root.worktreeId).toBeUndefined();
      await chatRow(shell, 'Fix the login redirect').click();
      await expect(filesChip(shell)).toHaveAttribute('data-shown', 'worktree');
    });

    await test.step('Repositories names the chat on its worktree row (B45), and Open selects it', async () => {
      const worktreeChat = (await shellState(app)).selected.chatId;
      await clickSectionAction(shell, 'new-chat');
      await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(worktreeChat);
      await setSection(shell, 'repositories-section', true);
      const group = shell.locator('[data-testid="repositories-row"][data-kind="group"][data-name="worktrees"]');
      await expect(group).toBeVisible();
      if ((await group.getAttribute('aria-expanded')) !== 'true') await group.getByTestId('repositories-twistie').click();
      const row = shell.locator('[data-testid="repositories-row"][data-kind="worktree"]').filter({ has: shell.getByTestId('repositories-label').getByText('Fix the login redirect', { exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.getByTestId('repositories-icon')).toBeVisible();
      await expect(row.getByTestId('repositories-action-openWorktree')).toHaveAttribute('title', 'Open chat');
      await row.click({ button: 'right' });
      await menuItem(await readyOverlay(app), 'openWorktree').click();
      await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(worktreeChat);
      await expect(filesChip(shell)).toHaveAttribute('data-shown', 'worktree');
    });
  });
});

test('Send now skips the wait; an unchanged setup asks nothing, a changed one asks again; Start from feat/a; each worktree gets its own index', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { setup: { setup: [HELD_SETUP] }, branches: ['feat/a'] });
  await withStub(home, {}, async (stub) => {
    stub.replies.push({ chunks: ['First chat answered'] }, { chunks: ['Second chat answered'] }, { chunks: ['Third chat answered'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);

    const first = await optIn(app);
    await send(first, 'First worktree chat');
    const overlay = await readyOverlay(app);
    await setupReview(overlay).getByTestId('worktree-dialog-run').click();
    await expect(first.getByTestId('worktree-send-now')).toBeVisible();
    expect(chatRequests(stub)).toHaveLength(0);
    await first.getByTestId('worktree-send-now').click();
    await expect(first.getByText('First chat answered')).toBeVisible({ timeout: 60_000 });
    expect(fs.existsSync(path.join(liveRecords(home)[0]!.workingFolder, 'setup-ran.txt'))).toBe(false);
    fs.writeFileSync(path.join(repo.project, 'release'), '');

    const second = await optIn(app, { start: 'refs/heads/feat/a' });
    await send(second, 'Second worktree chat');
    await expect(second.getByText('Second chat answered')).toBeVisible({ timeout: 60_000 });
    await expect(setupReview(overlay)).toHaveCount(0);
    const records = liveRecords(home);
    expect(records).toHaveLength(2);
    const secondRecord = records.find((record) => record.branch === 'damocles/second-worktree-chat')!;
    expect(await git(home, secondRecord.workingFolder, 'rev-parse', 'HEAD')).toBe(await git(home, repo.project, 'rev-parse', 'feat/a'));
    await expect.poll(() => records.map((record) => fs.existsSync(path.join(record.workingFolder, 'setup-ran.txt'))).every(Boolean), { timeout: 30_000 }).toBe(true);
    const indexes = records.map((record) => fs.readFileSync(path.join(record.workingFolder, 'setup-ran.txt'), 'utf8'));
    expect(new Set(indexes).size).toBe(2);

    // An uncommitted edit to the setup file takes effect at once and needs a new review.
    fs.writeFileSync(path.join(repo.project, '.damocles', 'worktree.json'), `${JSON.stringify({ setup: [QUICK_SETUP] }, null, 2)}\n`);
    const third = await optIn(app);
    await send(third, 'Third worktree chat');
    await expect(setupReview(overlay)).toBeVisible();
    await expect(setupReview(overlay).getByTestId('worktree-dialog-commands')).toContainText('setup-ran.txt');
    await setupReview(overlay).getByTestId('worktree-dialog-run').click();
    await expect(third.getByText('Third chat answered')).toBeVisible({ timeout: 60_000 });
  });
});

test('a failed setup offers Send anyway and Retry; a failed creation keeps the prompt with Retry and Run in project folder', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { setup: { setup: ['node -e "process.exit(3)"'] } });
  // A branch named like the prefix makes git refuse ax/<slug> (a ref cannot be both a branch and a folder of branches).
  await git(home, repo.root, 'branch', 'ax');
  await withStub(home, {}, async (stub) => {
    stub.replies.push({ chunks: ['Sent anyway'] }, { chunks: ['Ran in the project folder'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);

    const failing = await optIn(app);
    await send(failing, 'Setup that fails');
    const overlay = await readyOverlay(app);
    await setupReview(overlay).getByTestId('worktree-dialog-run').click();
    await expect(failing.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'setupFailed', { timeout: 60_000 });
    await expect(failing.getByTestId('worktree-status')).toContainText('Setup failed (exit 3)');
    await expect(failing.getByTestId('worktree-retry')).toBeVisible();
    expect(chatRequests(stub)).toHaveLength(0);
    await failing.getByTestId('worktree-send-anyway').click();
    await expect(failing.getByText('Sent anyway')).toBeVisible({ timeout: 60_000 });

    writeUserSettings(home, { 'damocles.desktop.git.branchPrefix': 'ax/' });
    await expect.poll(async () => {
      const options = await (await shellPage(app)).evaluate(async (key) => window.damoclesShell!.chatsWorktreeOptions(key), (await shellState(app)).selected.projectKey!);
      return options.available ? options.branchPrefix : undefined;
    }).toBe('ax/');
    const refused = await optIn(app);
    await send(refused, 'Branch git refuses');
    await expect(refused.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'createFailed', { timeout: 60_000 });
    await expect(refused.getByTestId('worktree-status')).toContainText("Couldn't create the worktree");
    await expect(refused.getByTestId('worktree-status-error')).not.toBeEmpty();
    await expect(refused.getByTestId('worktree-retry')).toBeVisible();
    // core holds the prompt, and the card shows it is kept (the creating state cross-fades out first)
    await expect(refused.getByTestId('worktree-held-prompt')).toHaveCount(1);
    await expect(refused.getByTestId('worktree-held-prompt')).toContainText('Branch git refuses');
    await expect(refused.getByText('Ran in the project folder')).toHaveCount(0);
    await refused.getByTestId('worktree-run-in-project').click();
    await expect(refused.getByText('Ran in the project folder')).toBeVisible({ timeout: 60_000 });
    await expect(refused.getByTestId('worktree-chip')).toHaveCount(0);
  });
});

test('Delete worktree from the chat row leaves read-only history: "Worktree deleted" on the row and the composer replaced', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, {}, async (stub) => {
    stub.replies.push({ chunks: ['Done in the worktree'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await send(tab, 'Short lived worktree');
    await expect(tab.getByText('Done in the worktree')).toBeVisible({ timeout: 60_000 });
    const [record] = liveRecords(home);
    const shell = await shellPage(app);
    const row = chatRow(shell, 'Short lived worktree');
    // the row goes from live to deleted with no frame between as a plain chat (its time and model line)
    await recordChatRow(shell, 'Short lived worktree');
    // every chat page from here on is recorded from its first frame, the one the delete reloads included
    await recordComposerFrames(app);
    const overlay = await openRowWorktreeMenu(app, row);
    // New chat in this worktree leads the Worktree submenu
    await expect(overlay.locator('[data-submenu-item]').first()).toHaveAttribute('data-item-id', 'newChatInWorktree');
    // no remote: Push branch is disabled and says why
    await expect(submenuItem(overlay, 'worktree:push')).toHaveAttribute('aria-disabled', 'true');
    await expect(submenuItem(overlay, 'worktree:push')).toContainText('No remote');
    await submenuItem(overlay, 'worktree:delete').click();
    const dialog = overlay.locator('[data-dialog="delete"] [data-testid="worktree-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Delete this worktree?');
    await expect(dialog).toContainText(`Also delete branch ${record!.branch}`);
    await dialog.getByTestId('worktree-dialog-delete').click();
    await expect.poll(() => fs.existsSync(record!.worktreeRoot), { timeout: 60_000 }).toBe(false);
    await expect(row.getByTestId('chat-worktree-line')).toHaveText('Worktree deleted');
    await expect(row).toHaveAttribute('data-read-only', 'true');
    const deleting = await chatRowFrames(shell);
    expect(statusRuns(deleting)).toEqual(['live', 'deleted']);
    expect(largestLogo(deleting)).toBe(0);
    // selecting it shows the chat the delete loaded again: the row stays deleted while core reads where the chat works, and
    // the page's first frames already know the place, so the normal composer never shows
    await recordChatRow(shell, 'Short lived worktree');
    await row.click();
    const readOnly = await activeChat(app);
    await expect(readOnly.getByTestId('worktree-deleted')).toContainText("This chat's worktree was deleted");
    const composing = await composerFrames(readOnly);
    // no frame had the normal composer, whether or not the first frame came before the card
    expect(composing.filter((frame) => frame.composer)).toEqual([]);
    expect(composing.at(-1)).toMatchObject({ deleted: true, placeholder: false });
    const selecting = await chatRowFrames(shell);
    expect(statusRuns(selecting)).toEqual(['deleted']);
    expect(largestLogo(selecting)).toBe(0);
    await expect(readOnly.getByTestId('composer')).toHaveCount(0);
    await expect(readOnly.getByText('Done in the worktree')).toBeVisible();
    const known = [readOnly];
    await readOnly.getByTestId('worktree-new-chat-in-project').click();
    const fresh = await nextChat(app, known);
    await expect(chatInput(fresh)).toBeVisible();
    await expect(fresh.getByTestId('worktree-chip')).toHaveCount(0);
  });
});

test('New chat in this worktree from the row +, the New menu and the shortcut: each starts at once in the same worktree, first in the list, and its Edit lands there', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { files: { 'a.ts': 'export const a = 1;\n' } });
  await withStub(home, { 'damocles.dangerouslySkipPermissions': true }, async (stub) => {
    stub.replies.push({ chunks: ['First turn done'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const shell = await shellPage(app);
    const first = await optIn(app);
    await send(first, 'Start the shared worktree');
    await expect(first.getByText('First turn done')).toBeVisible({ timeout: 60_000 });
    const [record] = liveRecords(home);
    const worktreeFile = path.join(record!.workingFolder, 'a.ts');

    // A new chat in the worktree: no creation and no setup, listed first, selected, working in the worktree at once.
    const startsInWorktree = async (known: Page[]): Promise<Page> => {
      const tab = await nextChat(app, known);
      await expect(tab.getByTestId('chat-header-worktree')).toContainText(record!.branch!);
      await expect(tab.getByTestId('worktree-status')).toHaveCount(0);
      await expect(chatInput(tab)).toBeVisible();
      await expect(chatRows(shell).first()).toHaveAttribute('aria-selected', 'true');
      await expect(chatRows(shell).first()).toHaveAttribute('data-worktree', 'live');
      expect(liveRecords(home).map((each) => each.id)).toEqual([record!.id]);
      expect((await shownFolder(app))?.root.worktreeId).toBe(record!.id);
      return tab;
    };

    const fromRow = await test.step('the row + of a live worktree chat', async () => {
      const row = chatRow(shell, 'Start the shared worktree');
      await row.hover();
      const plus = row.getByTestId('chat-action-new-in-worktree');
      await expect(plus).toHaveAttribute('title', 'New chat in this worktree');
      await plus.click();
      return startsInWorktree([first]);
    });

    await test.step('its Edit lands in the worktree, and the chat stays first as the newest', async () => {
      stub.replies.push(edit(worktreeFile, 'a = 1', 'a = 2'), { chunks: ['Raised a in the worktree'] });
      await send(fromRow, 'Raise a in the shared worktree');
      await expect(fromRow.getByText('Raised a in the worktree')).toBeVisible({ timeout: 60_000 });
      expect(fs.readFileSync(worktreeFile, 'utf8')).toBe('export const a = 2;\n');
      expect(fs.readFileSync(path.join(repo.project, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
      await expect(chatRows(shell).first().getByTestId('chat-title')).toHaveText('Raise a in the shared worktree');
      // the composer says the worktree is shared, and with how many other chats
      await expect(fromRow.getByTestId('composer-worktree-shares')).toContainText('with 1 other chat');
    });

    const fromMenu = await test.step('the New menu continues in it: the row names the branch, its chats and its changes', async () => {
      const overlay = await openNewMenu(app);
      const group = overlay.getByTestId('new-chat-menu-continue');
      await expect(group).toBeVisible();
      const item = group.locator(`[data-testid="new-chat-menu-continue-row"][data-worktree-id="${record!.id}"]`);
      await expect(item).toHaveAttribute('data-branch', record!.branch!);
      await expect(item).toContainText('2 chats');
      await expect(item).toContainText('+1');
      await item.click();
      await expect(newMenu(overlay)).toHaveCount(0);
      return startsInWorktree([first, fromRow]);
    });

    await test.step('Shift+Alt+N (Ctrl+Alt+N on Linux, Cmd+Alt+N on macOS) from a chat working in the worktree', async () => {
      await pressKeys(app, `/panel/${panelIdOf(fromMenu)}/`, 'N', NEW_IN_WORKTREE_KEYS);
      await startsInWorktree([first, fromRow, fromMenu]);
    });
  });
});
