import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Locator, Page } from '@playwright/test';
import { writeAsar } from '../../scripts/asar-archive.mjs';
import { appHolders } from './support/app';
import { ARCHIVE } from './support/asar';
import { describeLeftovers } from './support/file-holders';
import { activeChat, expect, nextChat, panelIdOf, selectChatPage, test } from './support/fixtures';
import { git } from './support/git';
import { chatRequests } from './support/openai-stub';
import { menuItem, readyOverlay } from './support/overlay';
import { answerToast, overlayPage, popupPage, popupToasts, pressKeys, PRIMARY, recordedToasts, recordToasts, shellPage, shellState } from './support/shell';
import { openProjectChat } from './support/screenshots';
import { editorTab, filesRow, openInEditor, quickPick, untilCoreWatchLive, untilWatchLive } from './support/editor';
import { setContentSize } from './support/settings';
import { scmSection, setSection } from './support/scm';
import { activeTerminal, openTerminal, runInTerminal } from './support/terminal';
import { addProject, chatInput, clickMenu, hostMessages, postFromWebview, recordHostMessages } from './support/ui';
import { holdFile, registryRecords, worktreeRepo, worktreesRoot } from './support/worktree-repo';
import { clickSectionAction } from './support/shell-ui';
import { chatRow, edit, filesChip, HELD_SETUP, liveRecords, openRowWorktreeMenu, optIn, send, setupReview, shownFolder, withStub } from './support/worktree-chat';
import { submenuItem } from './support/scm';

// Worktree chats past the first send (plan slice 12a): MCP in a worktree chat, the held prompt, Delete
// with a running terminal, Compare with Workspace, a restart, removing and re-adding the project, removing it while a first
// message waits, the palette's hand-off commands, the leftover report, a worktree removed in a terminal, Delete of a leftover
// or a watched worktree holding .asar archives, and the .asar files a new worktree gets.

const MCP_SERVER = path.join(__dirname, 'support', 'mcp-stdio-server.cjs');
const windows = process.platform === 'win32';
// A shell with integration, so a terminal running a program asks before it is killed.
const INTEGRATED = windows ? 'windows-powershell' : 'bash';
const SKIP_PERMISSIONS = { 'damocles.dangerouslySkipPermissions': true };
const messageDialog = (overlay: Page): Locator => overlay.getByTestId('overlay-message');

async function turn(tab: Page, text: string, done: string): Promise<void> {
  await send(tab, text);
  await expect(tab.getByText(done)).toBeVisible({ timeout: 60_000 });
}

/** Runs a palette command by id, as Ctrl+Shift+P, typing and a click do. */
async function runCommand(app: Parameters<typeof shellPage>[0], query: string, id: string): Promise<void> {
  const overlay = await overlayPage(app);
  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.getByTestId('quick-pick-input').fill(`>${query}`);
  const item = overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${id}"]`);
  await expect(item).toBeVisible();
  await item.click();
  await expect(quickPick(overlay)).toHaveCount(0);
}

test('a worktree chat connects the project\'s .mcp.json server and the user\'s, and the agent is offered their tools', async ({ foreground: _foreground, home, launch }) => {
  const server = { command: process.execPath, args: [MCP_SERVER] };
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { files: { 'a.ts': 'export const a = 1;\n', '.mcp.json': `${JSON.stringify({ mcpServers: { 'e2e-project': server } }, null, 2)}\n` } });
  fs.mkdirSync(home.damoclesDir, { recursive: true });
  fs.writeFileSync(path.join(home.damoclesDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'e2e-user': server } }, null, 2));
  await withStub(home, {}, async (stub) => {
    stub.replies.push({ chunks: ['Worktree started'] }, { chunks: ['Tools listed'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Start in the worktree', 'Worktree started');
    await expect(tab.getByTestId('chat-header-worktree')).toBeVisible();
    await recordHostMessages(tab);
    await expect.poll(async () => {
      await postFromWebview(tab, { type: 'requestMcpStatus' });
      const servers = ((await hostMessages(tab, 'mcpServerStatus')).at(-1)?.['servers'] as Array<{ name: string; status: string }> | undefined) ?? [];
      return ['e2e-project', 'e2e-user'].map((name) => servers.find((each) => each.name === name)?.status);
    }, { timeout: 60_000 }).toEqual(['connected', 'connected']);
    const before = chatRequests(stub).length;
    await turn(tab, 'List your tools', 'Tools listed');
    const body = JSON.stringify(chatRequests(stub).slice(before).map((request) => request.body));
    // tool names take the server's name with - as _
    expect(body).toContain('mcp__e2e_project__e2e_ping');
    expect(body).toContain('mcp__e2e_user__e2e_ping');
  });
});

test('the held first prompt: a second send comes back to the composer, a failed creation keeps it across leaving the chat, and a quit keeps it as the draft (rule 6)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { setup: { setup: [HELD_SETUP] } });
  // the quit below ends the Setup task without asking
  await withStub(home, { 'damocles.desktop.terminal.confirmOnKill': 'never' }, async (stub) => {
    stub.replies.push({ chunks: ['First prompt answered'] });
    let desktop = await launch();
    await openProjectChat(desktop.app, repo.project);

    await test.step('a second send while the first waits for setup is returned, never dropped', async () => {
      const tab = await optIn(desktop.app);
      await send(tab, 'Held first prompt');
      const overlay = await readyOverlay(desktop.app);
      await setupReview(overlay).getByTestId('worktree-dialog-run').click();
      await expect(tab.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'settingUp');
      await expect(tab.getByTestId('worktree-held-prompt').last()).toContainText('Held first prompt');
      await send(tab, 'Second prompt meanwhile');
      await expect(chatInput(tab)).toHaveValue('Second prompt meanwhile');
      expect(chatRequests(stub)).toHaveLength(0);
      fs.writeFileSync(path.join(repo.project, 'release'), '');
      await expect(tab.getByText('First prompt answered')).toBeVisible({ timeout: 60_000 });
      await expect(chatInput(tab)).toHaveValue('Second prompt meanwhile');
      fs.rmSync(path.join(repo.project, 'release'));
    });

    await test.step('a quit while setup holds the prompt keeps it as the chat\'s draft for the next start', async () => {
      const tab = await optIn(desktop.app);
      await send(tab, 'Kept across the quit');
      await expect(tab.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'settingUp', { timeout: 60_000 });
      await expect(tab.getByTestId('worktree-held-prompt').last()).toContainText('Kept across the quit');
      await desktop.close();
      desktop = await launch();
      const again = await activeChat(desktop.app);
      await expect(chatInput(again)).toHaveValue('Kept across the quit', { timeout: 30_000 });
    });
  });
});

test('a failed creation keeps its held prompt after the chat is left and selected again (D30)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  // A branch named like the prefix makes git refuse ax/<slug>.
  await git(home, repo.root, 'branch', 'ax');
  await withStub(home, { 'damocles.desktop.git.branchPrefix': 'ax/' }, async () => {
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const refused = await optIn(app);
    await send(refused, 'Prompt git refuses');
    await expect(refused.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'createFailed', { timeout: 60_000 });
    const shell = await shellPage(app);
    const known = [refused];
    await clickSectionAction(shell, 'new-chat');
    await nextChat(app, known);
    await selectChatPage(app, refused);
    await expect(refused.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'createFailed');
    await expect(refused.getByTestId('worktree-held-prompt').last()).toContainText('Prompt git refuses');
  });
});

test('Delete with a program running in the worktree\'s terminal asks about the terminal; Cancel keeps everything, then it removes (rule 14)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, { 'damocles.desktop.terminal.defaultProfile': INTEGRATED }, async (stub) => {
    stub.replies.push({ chunks: ['Worktree ready'] });
    const programFiles = process.env['ProgramFiles'];
    const { app } = await launch(windows && programFiles !== undefined ? { env: { ProgramFiles: programFiles } } : {});
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Terminal in the worktree', 'Worktree ready');
    const [record] = liveRecords(home);
    const shell = await openTerminal(app);
    await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
    await runInTerminal(shell, 'node -e "setInterval(()=>{},1000)"');
    await expect.poll(async () => {
      const state = await shell.evaluate(() => window.damoclesShell!.terminal.getState());
      return state.terminals.some((terminal) => terminal.running === 'node -e "setInterval(()=>{},1000)"');
    }, { timeout: 30_000 }).toBe(true);

    const deleteFromRow = async (): Promise<Page> => {
      const overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Terminal in the worktree'));
      await submenuItem(overlay, 'worktree:delete').click();
      const dialog = overlay.locator('[data-dialog="delete"] [data-testid="worktree-dialog"]');
      await dialog.getByTestId('worktree-dialog-delete').click();
      await expect(messageDialog(overlay)).toContainText('Do you want to terminate the active terminal session?');
      return overlay;
    };
    const cancelled = await deleteFromRow();
    await cancelled.getByTestId('overlay-message-cancel').click();
    await expect(messageDialog(cancelled)).toHaveCount(0);
    expect(fs.existsSync(record!.worktreeRoot)).toBe(true);
    expect(liveRecords(home).map((each) => each.id)).toEqual([record!.id]);

    const confirmed = await deleteFromRow();
    await confirmed.getByTestId('overlay-message-action-0').click();
    await expect.poll(() => fs.existsSync(record!.worktreeRoot), { timeout: 60_000 }).toBe(false);
    await expect.poll(() => liveRecords(home)).toEqual([]);
  });
});

test('Delete of a worktree a process outside Damocles holds open keeps it registered and names its path; Retry after the process ends removes it (D33)', async ({ foreground: _foreground, home, launch }) => {
  test.skip(!windows, 'only Windows refuses to remove a folder another process has open');
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    stub.replies.push({ chunks: ['Worktree ready'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Held by another process', 'Worktree ready');
    const [record] = liveRecords(home);
    const holder = await holdFile(path.join(record!.workingFolder, 'a.ts'));
    try {
      await recordToasts(app);
      const shell = await shellPage(app);
      const overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Held by another process'));
      await submenuItem(overlay, 'worktree:delete').click();
      await overlay.locator('[data-dialog="delete"] [data-testid="worktree-dialog"]').getByTestId('worktree-dialog-delete').click();
      await expect.poll(async () => (await recordedToasts(app)).find((toast) => toast.message.includes(record!.worktreeRoot)), { timeout: 60_000 }).toBeDefined();
      const failure = (await recordedToasts(app)).find((toast) => toast.message.includes(record!.worktreeRoot))!;
      expect(failure).toMatchObject({ severity: 'error', actions: ['Retry'] });
      expect(liveRecords(home).map((each) => each.id)).toEqual([record!.id]);
      await holder.release();
      // git had deleted the folder's contents and its .git link; Retry finishes the remove with no second question
      await answerToast(app, failure.id, 'Retry');
      await expect.poll(() => fs.existsSync(record!.worktreeRoot), { timeout: 60_000 }).toBe(false);
      await expect.poll(() => liveRecords(home)).toEqual([]);
      await expect(chatRow(shell, 'Held by another process').getByTestId('chat-worktree-line')).toHaveText('Worktree deleted', { timeout: 30_000 });
    } finally {
      await holder.release();
    }
  });
});

test('Delete of a leftover worktree holding .asar archives removes it (D33)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    stub.replies.push({ chunks: ['Worktree ready'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Leftover with archives', 'Worktree ready');
    // The turn's checkpoint runs git in the worktree after the reply shows.
    await expect(tab.getByTestId('user-message-rewind').first()).toBeVisible();
    const [record] = liveRecords(home);
    const wt = record!.worktreeRoot;
    fs.mkdirSync(path.join(wt, 'node_modules', 'electron', 'dist', 'resources'), { recursive: true });
    writeAsar(path.join(wt, 'app.asar'), ARCHIVE);
    writeAsar(path.join(wt, 'node_modules', 'electron', 'dist', 'resources', 'default_app.asar'), ARCHIVE);
    fs.rmSync(path.join(wt, '.git'));

    const shell = await shellPage(app);
    const overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Leftover with archives'));
    await submenuItem(overlay, 'worktree:delete').click();
    await expect(messageDialog(overlay)).toContainText(`The folder of the worktree "${wt}" is no longer a git worktree. Delete it and everything in it?`);
    await messageDialog(overlay).getByTestId('overlay-message-action-0').click();
    await expect.poll(() => fs.existsSync(wt), { timeout: 60_000 }).toBe(false);
    await expect.poll(() => liveRecords(home)).toEqual([]);
    await expect(chatRow(shell, 'Leftover with archives').getByTestId('chat-worktree-line')).toHaveText('Worktree deleted', { timeout: 30_000 });
  });
});

test('Delete of a worktree whose folder holds an .asar the app watched removes it on the first try (D33)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { files: { 'a.ts': 'export const a = 1;\n', '.gitignore': '*.asar\n' } });
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    stub.replies.push({ chunks: ['Worktree ready'] });
    const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Watched archive', 'Worktree ready');
    await expect(tab.getByTestId('user-message-rewind').first()).toBeVisible();
    const [record] = liveRecords(home);
    const wt = record!.worktreeRoot;
    const shell = await shellPage(app);
    await expect(filesChip(shell)).toHaveAttribute('data-shown', 'worktree');
    await expect(filesRow(shell, 'a.ts')).toBeVisible();
    await untilWatchLive(shell, home, record!.workingFolder);
    const archive = path.join(record!.workingFolder, 'app.asar');
    writeAsar(archive, ARCHIVE);
    await expect(filesRow(shell, 'app.asar')).toBeVisible();
    // A later file reported proves the watch handled the archive's creation: core's watch of this root, then main's Files watcher.
    // Neither proves work a listener defers past the event, such as source control's debounced refresh.
    await untilCoreWatchLive(app, record!.workingFolder);
    await untilWatchLive(shell, home, record!.workingFolder);
    expect(await appHolders(app, [archive])).toEqual([]);

    await recordToasts(app);
    const overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Watched archive'));
    await submenuItem(overlay, 'worktree:delete').click();
    await overlay.locator('[data-dialog="delete"] [data-testid="worktree-dialog"]').getByTestId('worktree-dialog-delete').click();
    let failure: string | undefined;
    await expect.poll(async () => {
      failure = (await recordedToasts(app)).find((toast) => toast.message.includes(wt))?.message;
      return failure !== undefined || !fs.existsSync(wt);
    }, { timeout: 60_000 }).toBe(true);
    if (failure !== undefined) throw new Error(`${failure}\n${describeLeftovers(wt)}`);
    await expect.poll(() => liveRecords(home)).toEqual([]);
    expect(registryRecords(home).find((each) => each.id === record!.id)?.deletedAt).toBeDefined();
  });
});

test('A new worktree gets the .asar files .worktreeinclude names and the untracked ones it brings, byte for byte (D32, D63)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { worktreeInclude: 'vendor/**\n', ignored: { 'vendor/app.asar': 'replaced below' } });
  const included = path.join(repo.root, 'vendor', 'app.asar');
  const untracked = path.join(repo.root, 'inbox', 'new.asar');
  writeAsar(included, { ...ARCHIVE, 'included.txt': 'included' });
  fs.mkdirSync(path.dirname(untracked), { recursive: true });
  writeAsar(untracked, { ...ARCHIVE, 'untracked.txt': 'untracked' });
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    stub.replies.push({ chunks: ['Worktree ready'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app, { bring: true });
    await turn(tab, 'Bring the archives', 'Worktree ready');
    const [record] = liveRecords(home);
    const copies = [path.join(record!.worktreeRoot, 'vendor', 'app.asar'), path.join(record!.worktreeRoot, 'inbox', 'new.asar')];
    for (const [copy, source] of [[copies[0]!, included], [copies[1]!, untracked]] as const) {
      expect(fs.statSync(copy, { throwIfNoEntry: false })?.isFile(), copy).toBe(true);
      expect(fs.readFileSync(copy).equals(fs.readFileSync(source)), copy).toBe(true);
    }
    expect(await appHolders(app, [included, untracked, ...copies])).toEqual([]);
  });
});

test('Compare with Workspace on a worktree change opens the project folder\'s copy against the worktree\'s (B40)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    stub.replies.push({ chunks: ['Worktree ready'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Edit in the worktree', 'Worktree ready');
    const [record] = liveRecords(home);
    stub.replies.push(edit(path.join(record!.workingFolder, 'a.ts'), 'a = 1', 'a = 2'), { chunks: ['Raised a'] });
    await turn(tab, 'Raise a', 'Raised a');
    const shell = await shellPage(app);
    await setSection(shell, 'scm-section', true);
    const change = scmSection(shell).locator('[data-testid="scm-change"][data-path="a.ts"]');
    await expect(change).toBeVisible();
    await change.click({ button: 'right' });
    const overlay = await readyOverlay(app);
    await menuItem(overlay, 'compareWithWorkspace').click();
    await expect(editorTab(shell, 'a.ts (project folder) ↔ a.ts (worktree)')).toBeVisible();
  });
});

test('after a restart a worktree chat resumes in its worktree: the views follow it and its next Edit lands there', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    stub.replies.push({ chunks: ['Before the restart'] });
    let desktop = await launch();
    await openProjectChat(desktop.app, repo.project);
    const tab = await optIn(desktop.app);
    await turn(tab, 'Survive a restart', 'Before the restart');
    const [record] = liveRecords(home);
    await desktop.close();

    desktop = await launch();
    const shell = await shellPage(desktop.app);
    await chatRow(shell, 'Survive a restart').click();
    const resumed = await activeChat(desktop.app);
    await expect(resumed.getByText('Before the restart')).toBeVisible();
    await expect(resumed.getByTestId('chat-header-worktree')).toContainText(record!.branch!);
    await expect(filesChip(shell)).toHaveAttribute('data-shown', 'worktree');
    expect((await shownFolder(desktop.app))?.root.worktreeId).toBe(record!.id);
    stub.replies.push(edit(path.join(record!.workingFolder, 'a.ts'), 'a = 1', 'a = 3'), { chunks: ['Raised a third time'] });
    await turn(resumed, 'Raise a after the restart', 'Raised a third time');
    expect(fs.readFileSync(path.join(record!.workingFolder, 'a.ts'), 'utf8')).toBe('export const a = 3;\n');
    expect(fs.readFileSync(path.join(repo.project, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });
});

test('removing the project unloads its worktree chats and keeps their worktrees; adding it again lists them live (AD12)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, {}, async (stub) => {
    stub.replies.push({ chunks: ['Kept through the removal'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Outlive the project', 'Kept through the removal');
    const [record] = liveRecords(home);
    const shell = await shellPage(app);
    const projectKey = (await shellState(app)).selected.projectKey!;
    expect(await shell.evaluate((key) => window.damoclesShell!.removeProject(key), projectKey)).toEqual({ ok: true });
    await expect.poll(async () => (await shellState(app)).projects.some((project) => project.key === projectKey)).toBe(false);
    expect(liveRecords(home).map((each) => each.id)).toEqual([record!.id]);
    expect(fs.existsSync(record!.worktreeRoot)).toBe(true);

    await addProject(app, repo.project, true);
    await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(projectKey);
    await expect(chatRow(shell, 'Outlive the project')).toHaveAttribute('data-worktree', 'live');
    await chatRow(shell, 'Outlive the project').click();
    const again = await activeChat(app);
    await expect(again.getByTestId('chat-header-worktree')).toContainText(record!.branch!);
  });
});

test('Remove Project while a chat\'s first message waits for its worktree asks first: Cancel keeps everything, Remove Project discards the worktree and removes the project (rule 6)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { setup: { setup: [HELD_SETUP] } });
  await withStub(home, {}, async (stub) => {
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await send(tab, 'Waiting for the worktree');
    const overlay = await readyOverlay(app);
    await setupReview(overlay).getByTestId('worktree-dialog-run').click();
    await expect(tab.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'settingUp', { timeout: 60_000 });
    const [record] = liveRecords(home);
    const projectKey = (await shellState(app)).selected.projectKey!;
    const panelId = panelIdOf(tab);
    const shell = await shellPage(app);
    const removeProject = () => shell.evaluate((key) => window.damoclesShell!.removeProject(key), projectKey);
    const question = messageDialog(overlay);

    const cancelled = removeProject();
    await expect(question).toContainText('acme has a chat whose first message is waiting for its worktree. Do you want to remove the project?');
    await expect(question.getByTestId('overlay-message-preview')).toHaveText('Waiting for the worktree');
    // its own Setup terminal is part of the discard, so the question counts no terminal
    await expect(question).not.toContainText('terminal');
    await expect(question.getByTestId('overlay-message-cancel')).toBeFocused();
    await question.getByTestId('overlay-message-cancel').click();
    expect(await cancelled).toEqual({ ok: true });
    await expect(question).toHaveCount(0);
    expect((await shellState(app)).projects.some((project) => project.key === projectKey)).toBe(true);
    await expect(tab.getByTestId('worktree-status')).toHaveAttribute('data-phase', 'settingUp');
    await expect(tab.getByTestId('worktree-held-prompt').last()).toContainText('Waiting for the worktree');
    expect(liveRecords(home).map((each) => each.id)).toEqual([record!.id]);
    expect(fs.existsSync(record!.worktreeRoot)).toBe(true);

    const confirmed = removeProject();
    await expect(question).toBeVisible();
    await question.getByTestId('overlay-message-action-0').click();
    expect(await confirmed).toEqual({ ok: true });
    expect((await shellState(app)).projects.some((project) => project.key === projectKey)).toBe(false);
    expect(fs.existsSync(record!.worktreeRoot)).toBe(false);
    expect(registryRecords(home)).toEqual([]);
    expect(await git(home, repo.root, 'branch', '--list', record!.branch!)).toBe('');
    expect(chatRequests(stub)).toHaveLength(0);
    const savedChats = (): string[] => {
      const file = path.join(home.userData, 'panels.json');
      return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: Array<{ panelId: string }> }).chats.map((chat) => chat.panelId) : [];
    };
    await expect.poll(savedChats).not.toContain(panelId);
  });
});

test('the palette\'s Hand Off to Worktree and Hand Off to Project Folder move the selected chat (D61)', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    const { app } = await launch();
    const tab = await openProjectChat(app, repo.project);
    stub.replies.push(edit(path.join(repo.project, 'a.ts'), 'a = 1', 'a = 2'), { chunks: ['Edited a'] });
    await turn(tab, 'Raise a', 'Edited a');
    const overlay = await readyOverlay(app);

    await runCommand(app, 'Hand Off to Worktree', 'damocles.chat.handOffToWorktree');
    const toWorktree = overlay.locator('[data-dialog="handOffConfirm"] [data-testid="worktree-dialog"]');
    await expect(toWorktree).toContainText('Move this chat to a worktree?');
    await toWorktree.getByTestId('worktree-dialog-move').click();
    await expect(tab.getByTestId('chat-header-worktree')).toBeVisible({ timeout: 60_000 });
    const [record] = liveRecords(home);
    expect(fs.readFileSync(path.join(record!.workingFolder, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');

    await runCommand(app, 'Hand Off to Project Folder', 'damocles.chat.handOffToProjectFolder');
    const toProject = overlay.locator('[data-dialog="handOffConfirm"] [data-testid="worktree-dialog"]');
    await expect(toProject).toContainText('Move this chat to the project folder?');
    await toProject.getByTestId('worktree-dialog-move').click();
    await expect(tab.getByTestId('chat-header-worktree')).toHaveCount(0, { timeout: 60_000 });
    expect(fs.readFileSync(path.join(repo.project, 'a.ts'), 'utf8')).toBe('export const a = 2;\n');
  });
});

test('a folder under the worktrees root that no record owns is reported once at startup, and Review lists it with Reveal', async ({ home, launch }) => {
  const stray = path.join(worktreesRoot(home), 'acme', 'stray-chat');
  fs.mkdirSync(stray, { recursive: true });
  const { app } = await launch();
  const popup = await popupPage(app);
  const notice = popupToasts(popup).filter({ hasText: '1 leftover worktree' });
  await expect(notice).toHaveCount(1, { timeout: 60_000 });
  await notice.getByRole('button', { name: 'Review', exact: true }).click();
  const overlay = await overlayPage(app);
  const dialog = overlay.locator('[data-dialog="leftovers"] [data-testid="worktree-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('stray-chat');
  await expect(dialog.getByTestId('worktree-dialog-reveal')).toHaveCount(1);
  expect(fs.existsSync(stray)).toBe(true);
});

test('`git worktree remove` in a terminal on a chat worktree: Delete then succeeds, and the chat opens read-only', async ({ foreground: _foreground, home, launch }) => {
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'));
  await withStub(home, { 'damocles.desktop.terminal.defaultProfile': windows ? 'cmd' : 'bash' }, async (stub) => {
    stub.replies.push({ chunks: ['Soon removed outside'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Removed in a terminal', 'Soon removed outside');
    // The turn's checkpoint runs git in the worktree after the reply shows, and Windows refuses to remove a folder a process works in.
    await expect(tab.getByTestId('user-message-rewind').first()).toBeVisible();
    const [record] = liveRecords(home);
    const shell = await shellPage(app);
    // a terminal of the project folder: Windows refuses to remove a folder a shell has as its working directory
    const projectKey = (await shellState(app)).selected.projectKey!;
    await shell.evaluate((key) => window.damoclesShell!.terminal.create({ profileId: null, target: { project: key } }), projectKey);
    await clickMenu(app, 'damocles.toggleTerminal');
    await expect(activeTerminal(shell)).toHaveAttribute('data-status', 'running');
    await runInTerminal(shell, `git worktree remove --force "${record!.worktreeRoot}"`);
    await expect.poll(() => fs.existsSync(record!.worktreeRoot), { timeout: 60_000 }).toBe(false);

    const overlay = await openRowWorktreeMenu(app, chatRow(shell, 'Removed in a terminal'));
    await submenuItem(overlay, 'worktree:delete').click();
    await expect(chatRow(shell, 'Removed in a terminal').getByTestId('chat-worktree-line')).toHaveText('Worktree deleted', { timeout: 60_000 });
    expect(liveRecords(home)).toEqual([]);
    expect(await git(home, repo.root, 'worktree', 'list', '--porcelain')).not.toContain(path.basename(record!.worktreeRoot));
    await chatRow(shell, 'Removed in a terminal').click();
    const readOnly = await activeChat(app);
    await expect(readOnly.getByTestId('worktree-deleted')).toBeVisible();
    await expect(readOnly.getByTestId('composer')).toHaveCount(0);
  });
});

test('at a larger font in a 1000px window a worktree file\'s breadcrumbs end inside their bar: the folders and the place give way before the file name truncates', async ({ foreground: _foreground, home, launch }) => {
  const file = 'src/a folder with a long name/another long folder name/a-file-whose-name-is-long-enough-to-need-truncating.ts';
  const repo = await worktreeRepo(home, path.join(home.root, 'acme'), { files: { 'a.ts': 'export const a = 1;\n', [file]: 'export const x = 1;\n' } });
  await withStub(home, SKIP_PERMISSIONS, async (stub) => {
    stub.replies.push({ chunks: ['Ready'] });
    const { app } = await launch();
    await openProjectChat(app, repo.project);
    const tab = await optIn(app);
    await turn(tab, 'Get ready', 'Ready');
    const shell = await shellPage(app);
    await expect.poll(async () => (await shownFolder(app))?.root.worktreeId).toBeDefined();
    const worktreeKey = (await shownFolder(app))!.rootKey;
    expect((await openInEditor(app, { projectKey: worktreeKey, relativePath: file })).ok).toBe(true);
    await expect(shell.getByTestId('editor-breadcrumb-place')).toBeVisible();
    await setContentSize(app, 1000, 660);
    await shell.evaluate(() => document.documentElement.style.setProperty('--d-font-size', '16px'));
    await expect.poll(() => shell.evaluate(() => {
      const bar = document.querySelector('[data-testid="editor-breadcrumbs"]')!.getBoundingClientRect();
      const crumbs = [...document.querySelectorAll('[data-testid="editor-breadcrumbs"] [data-crumb]')];
      const file = crumbs.at(-1)!;
      const place = document.querySelector('[data-testid="editor-breadcrumb-place"]')!;
      return {
        fileInside: file.getBoundingClientRect().right <= bar.right,
        fileTruncated: file.scrollWidth > file.clientWidth,
        foldersGone: crumbs.slice(0, -1).every((crumb) => crumb.getBoundingClientRect().width < 1),
        placeIconOnly: place.getBoundingClientRect().width <= place.querySelector('svg')!.getBoundingClientRect().width + 1,
      };
    })).toEqual({ fileInside: true, fileTruncated: true, foldersGone: true, placeIconOnly: true });
  });
});
