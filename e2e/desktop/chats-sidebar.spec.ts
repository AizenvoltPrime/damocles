import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { selectedProjectKey, shellState } from './support/shell';
import { addProject, chatInput, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho } from './support/ui';
import { chatEntry, chatList, chatRow, clickChat, clickRowAction, listChats, projectKeyOf, projectRow, readyShell, renameInline } from './support/shell-ui';
import { answerConfirm, answerTagPicker, confirmDialog, focusedMenuItem, overlayMenu, overlayViewState, readyOverlay } from './support/overlay';

type RewindItem = { messageId: string; content: string };

// A catalog model whose thinking can be turned off, so the per-chat override shows in panelThinkingUpdate.
const OTHER_MODEL = 'claude-haiku-4-5-20251001';
// AD8: idle chats kept loaded besides the selected and the active ones.
const IDLE_KEPT = 3;

function sessionFiles(root: string, sessionId: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(`_${sessionId}.jsonl`))
    .map((entry) => path.join(root, entry));
}

function sessionText(root: string, sessionId: string): string {
  const [file] = sessionFiles(root, sessionId);
  return file ? fs.readFileSync(file, 'utf8') : '';
}

const selectedChatId = async (app: ElectronApplication): Promise<string | undefined> => (await shellState(app)).selected.chatId;

/**
 * Starts a chat from the sidebar's New button, sends one prompt and returns the chat's id once its session file exists.
 * An empty new chat that is already selected (adding a project opens one) takes the prompt instead of being left behind.
 */
async function newStoredChat(app: ElectronApplication, shell: Page, prompt: string): Promise<string> {
  const before = await selectedChatId(app);
  if (!before?.startsWith('new:')) {
    await shell.getByTestId('new-chat').click();
    await expect.poll(async () => {
      const id = await selectedChatId(app);
      return id !== before && id?.startsWith('new:');
    }).toBe(true);
  }
  const page = await activeChat(app);
  await expect(chatInput(page)).toBeVisible();
  await sendAndAwaitEcho(page, prompt);
  // The selection follows the chat to its session id once the first prompt writes the file.
  await expect.poll(async () => (await selectedChatId(app))?.startsWith('new:')).toBe(false);
  return (await selectedChatId(app))!;
}

async function openProject(app: ElectronApplication, dir: string): Promise<Page> {
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await addProject(app, dir, true);
  await expect.poll(async () => (await shellState(app)).projects.some((p) => p.fsPath === dir)).toBe(true);
  const shell = await readyShell(app);
  await expect(chatList(shell).or(shell.getByTestId('chats-empty'))).toBeVisible();
  return shell;
}

async function loadedIds(app: ElectronApplication): Promise<string[]> {
  return (await listChats(app)).chats.filter((chat) => chat.loaded).map((chat) => chat.id);
}

test('chat retention: six stored chats keep at most the selected, the active and three idle chats loaded; a running chat stays loaded; an unloaded chat resumes with its history', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const shell = await openProject(app, home.project);

    const ids: string[] = [];
    for (let i = 1; i <= 6; i++) ids.push(await newStoredChat(app, shell, `chat ${i}`));
    await expect.poll(async () => (await listChats(app)).chats.filter((chat) => ids.includes(chat.id)).length).toBe(6);

    // Selecting each in turn: every chat is idle, so at most the selected one and three more stay loaded.
    for (const id of ids) {
      await clickChat(shell, id);
      await expect.poll(() => selectedChatId(app)).toBe(id);
      await expect(chatRow(shell, id)).toHaveAttribute('aria-selected', 'true');
      await expect.poll(async () => (await loadedIds(app)).length).toBeLessThanOrEqual(1 + IDLE_KEPT);
      expect(await loadedIds(app)).toContain(id);
    }
    // The two least recently viewed chats were unloaded.
    await expect.poll(async () => (await chatEntry(app, ids[0]!))?.loaded).toBe(false);
    expect((await chatEntry(app, ids[1]!))?.loaded).toBe(false);

    // Reselecting an unloaded chat resumes it from its session file; a restored view lays out only once shown.
    await clickChat(shell, ids[0]!);
    await expect.poll(() => selectedChatId(app)).toBe(ids[0]);
    const first = await activeChat(app);
    await expect(first.getByText('Echo: chat 1', { exact: true })).toBeVisible();
    await expect.poll(async () => (await chatEntry(app, ids[0]!))?.loaded).toBe(true);

    // A running chat stays loaded through four other selections. The title request may take one held reply first.
    stub.replies.push({ chunks: ['Echo: ', 'long turn'], holdAfterFirst: held }, { chunks: ['Echo: ', 'long turn'], holdAfterFirst: held });
    await chatInput(first).fill('long turn');
    await chatInput(first).press('Enter');
    await expect.poll(async () => (await chatEntry(app, ids[0]!))?.status).toBe('running');
    await expect(chatRow(shell, ids[0]!)).toHaveAttribute('data-status', 'running');
    for (const id of ids.slice(1, 5)) {
      await clickChat(shell, id);
      await expect.poll(() => selectedChatId(app)).toBe(id);
      await expect.poll(async () => (await loadedIds(app)).length).toBeLessThanOrEqual(2 + IDLE_KEPT);
      expect((await chatEntry(app, ids[0]!))?.loaded).toBe(true);
    }
    release();
    await expect.poll(async () => (await chatEntry(app, ids[0]!))?.status).toBe('idle');
  } finally {
    release();
    await stub.close();
  }
});

test('sidebar edits: rename, tag and delete change the session files for loaded and unloaded chats; the chat menu opens in the overlay above the chat view', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const shell = await openProject(app, home.project);
    const ids: string[] = [];
    for (let i = 1; i <= 5; i++) ids.push(await newStoredChat(app, shell, `edit ${i}`));
    const [unloaded, , , loaded, selected] = ids as [string, string, string, string, string];
    await expect.poll(async () => (await chatEntry(app, unloaded))?.loaded).toBe(false);
    expect((await chatEntry(app, loaded))?.loaded).toBe(true);

    // Right-click opens the overlay menu over the whole window, above the chat view, with keyboard focus in it.
    await chatRow(shell, loaded).click({ button: 'right' });
    const overlay = await readyOverlay(app);
    await expect(overlayMenu(overlay)).toBeVisible();
    const view = await overlayViewState(app);
    expect(view.topmost).toBe(true);
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual(view.content);
    expect(view.focused).toBe(true);
    await expect.poll(() => focusedMenuItem(overlay)).toBe('open');
    await overlay.keyboard.press('ArrowDown');
    await expect.poll(() => focusedMenuItem(overlay)).toBe('rename');
    await overlay.keyboard.press('End');
    await expect.poll(() => focusedMenuItem(overlay)).toBe('delete');
    await overlay.keyboard.press('ArrowUp');
    await expect.poll(() => focusedMenuItem(overlay)).toBe('tag');
    // Escape closes it, hides the overlay and gives focus back to the sidebar.
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
    await expect.poll(async () => (await overlayViewState(app)).visible).toBe(false);
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.isFocused())).toBe(true);
    await expect(chatList(shell)).toBeFocused();

    // Rename a loaded chat inline and an unloaded one from the menu.
    await renameInline(shell, loaded, 'Renamed while loaded');
    await expect(chatRow(shell, loaded).getByTestId('chat-title')).toHaveText('Renamed while loaded');
    await expect.poll(() => sessionText(home.agentDir, loaded)).toContain('Renamed while loaded');
    await chatRow(shell, unloaded).click({ button: 'right' });
    await overlay.locator('[data-item-id="rename"]').click();
    const input = shell.getByTestId('chat-rename').getByRole('textbox');
    await input.fill('Renamed while unloaded');
    await input.press('Enter');
    await expect(chatRow(shell, unloaded).getByTestId('chat-title')).toHaveText('Renamed while unloaded');
    await expect.poll(() => sessionText(home.agentDir, unloaded)).toContain('Renamed while unloaded');
    expect((await chatEntry(app, unloaded))?.loaded).toBe(false);

    // Tag the selected chat through the tag picker, then filter by its chip.
    await clickRowAction(shell, selected, 'tag');
    await answerTagPicker(app, 'release');
    await expect(chatRow(shell, selected).getByTestId('chat-tag')).toHaveText('release');
    await expect.poll(() => sessionText(home.agentDir, selected)).toContain('release');
    await shell.locator('[data-testid="tag-chip"][data-tag="release"]').click();
    await expect(chatList(shell).getByRole('option')).toHaveCount(1);
    await shell.locator('[data-testid="tag-chip"][data-tag="release"]').click();

    // Delete the loaded chat: the dialog names it, Cancel keeps it, Delete removes the row and the file.
    await clickRowAction(shell, loaded, 'delete');
    await expect(confirmDialog(overlay)).toContainText('Delete this session? This action cannot be undone.');
    await expect(confirmDialog(overlay)).toContainText('Renamed while loaded');
    await answerConfirm(app, false);
    expect(sessionFiles(home.agentDir, loaded)).toHaveLength(1);
    await clickRowAction(shell, loaded, 'delete');
    await answerConfirm(app, true);
    await expect(chatRow(shell, loaded)).toHaveCount(0);
    await expect.poll(() => sessionFiles(home.agentDir, loaded)).toEqual([]);
    expect((await listChats(app)).chats.map((chat) => chat.id)).not.toContain(loaded);
  } finally {
    await stub.close();
  }
});

test('chats across projects: per-chat model and thinking, fork with replayed history, and a restart that restores projects, selection and conversation', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });

    let desktop = await launch();
    let app = desktop.app;
    let shell = await openProject(app, home.project);
    const alphaId = await newStoredChat(app, shell, 'alpha one');
    const alpha = await activeChat(app);
    await sendAndAwaitEcho(alpha, 'alpha two');
    await openProject(app, beta);
    const betaId = await newStoredChat(app, shell, 'beta one');
    const betaChat = await activeChat(app);
    const state = await shellState(app);
    expect(state.projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    const betaKey = await selectedProjectKey(app);
    const alphaKey = state.projects.find((p) => p.name === 'alpha')!.key;

    // Per-chat model and thinking: changing them in beta's chat leaves alpha's chat untouched.
    await recordHostMessages(alpha);
    await recordHostMessages(betaChat);
    await postFromWebview(betaChat, { type: 'setActiveModel', model: OTHER_MODEL });
    await expect.poll(async () => (await hostMessages(betaChat, 'modelUpdate')).at(-1)?.['activeModel']).toBe(OTHER_MODEL);
    await postFromWebview(betaChat, { type: 'setPanelThinkingDisabled', disabled: true });
    await expect.poll(async () => (await hostMessages(betaChat, 'panelThinkingUpdate')).at(-1)?.['panel']).toMatchObject({ thinkingDisabled: true });
    expect(await hostMessages(alpha, 'modelUpdate')).toEqual([]);
    expect(await hostMessages(alpha, 'panelThinkingUpdate')).toEqual([]);

    // Selecting alpha shows its chats; fork at the second prompt opens a new selected chat with the first exchange replayed.
    await projectRow(shell, alphaKey).click();
    await expect.poll(async () => (await shellState(app)).selected).toEqual({ projectKey: alphaKey, chatId: alphaId });
    await expect.poll(async () => {
      await postFromWebview(alpha, { type: 'requestRewindHistory' });
      const latest = (await hostMessages(alpha, 'rewindHistory')).at(-1)?.['prompts'] as RewindItem[] | undefined;
      return (latest ?? []).map((p) => p.content);
    }).toContain('alpha two');
    const prompts = (await hostMessages(alpha, 'rewindHistory')).at(-1)!['prompts'] as RewindItem[];
    const second = prompts.find((p) => p.content === 'alpha two')!;
    await postFromWebview(alpha, { type: 'rewindToMessage', userMessageId: second.messageId, option: 'fork-conversation', promptContent: 'alpha two' });
    await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(alphaId);
    const fork = await activeChat(app);
    await expect(fork.getByText('Echo: alpha one', { exact: true })).toBeVisible();
    await expect(chatInput(fork)).toHaveValue('alpha two');
    await expect(fork.getByText('Echo: alpha two', { exact: true })).toHaveCount(0);
    expect((await shellState(app)).selected.projectKey).toBe(alphaKey);

    // Select beta's chat, then restart: projects, the selection and the conversation come back.
    await projectRow(shell, betaKey).click();
    await expect.poll(async () => (await shellState(app)).selected).toEqual({ projectKey: betaKey, chatId: betaId });
    await desktop.close();
    desktop = await launch();
    app = desktop.app;
    shell = await readyShell(app);
    await expect.poll(async () => (await shellState(app)).selected).toEqual({ projectKey: betaKey, chatId: betaId });
    expect((await shellState(app)).projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    await expect(chatRow(shell, betaId)).toHaveAttribute('aria-selected', 'true');
    await expect((await activeChat(app)).getByText('Echo: beta one', { exact: true })).toBeVisible();
    await projectRow(shell, alphaKey).click();
    await clickChat(shell, alphaId);
    await expect((await activeChat(app)).getByText('Echo: alpha two', { exact: true })).toBeVisible();
  } finally {
    await stub.close();
  }
});

test('the New button stays in place on hover, and enabled controls in the shell, the chat view and the overlay show the pointer cursor', async ({ home, launch }) => {
  const { app } = await launch();
  const shell = await openProject(app, home.project);

  const newButton = shell.getByTestId('new-chat');
  const before = await newButton.boundingBox();
  await newButton.hover();
  await expect(newButton).toHaveCSS('cursor', 'pointer');
  await expect(newButton).toHaveCSS('transform', 'none');
  expect(await newButton.boundingBox()).toEqual(before);
  await expect(shell.getByTestId('toggle-theme')).toHaveCSS('cursor', 'pointer');
  await expect(shell.getByTestId('chat-search-toggle')).toHaveCSS('cursor', 'pointer');

  const chat = await activeChat(app);
  await expect(chat.locator('button:not(:disabled)').first()).toHaveCSS('cursor', 'pointer');

  await projectRow(shell, await projectKeyOf(app, path.basename(home.project))).click({ button: 'right' });
  const overlay = await readyOverlay(app);
  await expect(overlayMenu(overlay).getByRole('menuitem').first()).toHaveCSS('cursor', 'pointer');
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);
});

test("D42: the Projects list and the chat header show each project's branch from git's HEAD, trusted or not, and follow a checkout made outside the app", async ({ home, launch }) => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' }).trim();
  git(home.project, 'init', '-q', '-b', 'main');
  git(home.project, 'commit', '-q', '--allow-empty', '-m', 'init');
  // An untrusted project opened at a subfolder of its repository.
  const monorepo = path.join(home.root, 'p', 'mono');
  const subfolder = path.join(monorepo, 'packages', 'app');
  fs.mkdirSync(subfolder, { recursive: true });
  git(monorepo, 'init', '-q', '-b', 'main');
  const plain = path.join(home.root, 'p', 'plain');
  fs.mkdirSync(plain, { recursive: true });

  const { app } = await launch();
  const shell = await openProject(app, home.project);
  // Each add waits for its project, so the next add's trust answer never reaches this one's prompt.
  for (const [dir, trust] of [[subfolder, false], [plain, true]] as const) {
    await addProject(app, dir, trust);
    await expect.poll(async () => (await shellState(app)).projects.some((p) => p.fsPath === dir)).toBe(true);
  }

  const project = async (dir: string) => (await shellState(app)).projects.find((p) => p.fsPath === dir);
  const branchLabel = async (dir: string) => projectRow(shell, (await project(dir))!.key).getByTestId('project-branch');
  await expect.poll(async () => (await project(home.project))?.branch).toBe('main');
  await expect(await branchLabel(home.project)).toHaveText('main');
  await expect.poll(async () => (await project(subfolder))?.branch).toBe('main');
  expect((await project(subfolder))?.trusted).toBe(false);
  await expect(await branchLabel(subfolder)).toHaveText('main');
  expect((await project(plain))?.branch).toBeUndefined();
  await expect(await branchLabel(plain)).toHaveCount(0);

  // The selected chat's header reads the same branch for its own folder.
  const homeKey = (await project(home.project))!.key;
  await projectRow(shell, homeKey).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(homeKey);
  const headerBranch = (await activeChat(app)).getByTestId('chat-header-branch');
  await expect(headerBranch).toHaveText('main');
  await expect(headerBranch).toHaveAttribute('dir', 'ltr');

  git(home.project, 'checkout', '-q', '-b', 'feature/x');
  await expect(await branchLabel(home.project)).toHaveText('feature/x');
  await expect(headerBranch).toHaveText('feature/x');

  git(home.project, 'checkout', '-q', '--detach');
  const shortId = git(home.project, 'rev-parse', 'HEAD').slice(0, 7);
  await expect(await branchLabel(home.project)).toHaveText(shortId);
  await expect(headerBranch).toHaveText(shortId);
});
