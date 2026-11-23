import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { readyOverlay } from './support/overlay';
import { recordedToasts, recordToasts, SHELL_URL, shellState } from './support/shell';
import { chatRow, clickChat, projectRow, readyShell } from './support/shell-ui';
import { addProject, chatInput, sendAndAwaitEcho } from './support/ui';
import { scmSection } from './support/scm';

function savedSessionIds(home: HermeticHome): string[] {
  const file = path.join(home.userData, 'panels.json');
  if (!fs.existsSync(file)) return [];
  const { chats } = JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: { state: { sessionId?: string } | null }[] };
  return chats.flatMap((chat) => (chat.state?.sessionId !== undefined ? [chat.state.sessionId] : []));
}

function savedPanelIds(home: HermeticHome): string[] {
  const file = path.join(home.userData, 'panels.json');
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: { panelId: string }[] }).chats.map((chat) => chat.panelId) : [];
}

// The session ids the loaded chat pages show; a page that closes between listing and reading it shows none.
async function loadedSessionIds(app: ElectronApplication): Promise<string[]> {
  const ids: string[] = [];
  for (const page of app.windows().filter((p) => !p.isClosed() && p.url().includes('/panel/'))) {
    const saved = await page.evaluate(() => (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId).catch(() => undefined);
    if (saved !== undefined) ids.push(saved);
  }
  return ids;
}

// What main does when the window gains focus, without depending on the OS giving it focus.
async function focusWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ app: electronApp, BrowserWindow }, shellUrl) => {
    electronApp.emit('browser-window-focus', {}, BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().startsWith(shellUrl)));
  }, SHELL_URL);
}

test('a project whose folder moved while the app was closed shows Folder not found, opens none of its chats, and opens its last chat once the folder is back', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let desktop = await launch();
    let app = desktop.app;
    await expect(chatInput(await activeChat(app))).toBeVisible();
    await addProject(app, home.project, true);
    const projectKey = (await shellState(app)).projects.find((p) => p.fsPath === home.project)!.key;
    await sendAndAwaitEcho(await activeChat(app), 'a chat in the folder that moves');
    let sessionId: string | undefined;
    await expect.poll(async () => (sessionId = (await shellState(app)).selected.chatId)?.startsWith('new:')).toBe(false);
    await expect.poll(() => savedSessionIds(home)).toContain(sessionId);
    await desktop.close();

    const moved = `${home.project}-moved`;
    fs.renameSync(home.project, moved);
    desktop = await launch();
    app = desktop.app;
    await recordToasts(app);
    const shell = await readyShell(app);

    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === projectKey)?.presence).toBe('missing');
    const row = projectRow(shell, projectKey);
    await expect(row.getByTestId('presence-badge')).toHaveText('Folder not found');
    await expect(row).toHaveAttribute('title', `${home.project} (folder not found)`);
    // the saved selection was the project, which shows its placeholder in place of a chat
    await expect.poll(async () => (await shellState(app)).selected).toEqual({ projectKey });
    await expect(shell.getByTestId('absent-project')).toContainText("Damocles can't find");
    await expect(shell.getByTestId('absent-project-path')).toHaveText(home.project);
    expect(await loadedSessionIds(app)).not.toContain(sessionId);
    expect(savedSessionIds(home)).toContain(sessionId);
    // Source control says the folder is not there, and offers neither Initialize Repository nor Clone
    const scmState = scmSection(shell).getByTestId('scm-state');
    await expect(scmState).toHaveAttribute('data-state', 'absent');
    await expect(scmState).toContainText('Folder not found.');
    await expect(scmState.getByTestId('scm-state-action')).toHaveCount(0);
    await expect(scmState.getByTestId('scm-state-secondary')).toHaveCount(0);

    // its listed chat shows the placeholder too, and opens nothing
    await expect(chatRow(shell, sessionId!)).toBeVisible();
    await clickChat(shell, sessionId!);
    await expect(shell.getByTestId('absent-project')).toBeVisible();
    expect((await shellState(app)).chatViewShown).toBe(false);
    expect(await loadedSessionIds(app)).not.toContain(sessionId);
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);

    fs.renameSync(moved, home.project);
    await focusWindow(app);
    await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === projectKey)?.presence).toBeUndefined();
    await expect(row.getByTestId('presence-badge')).toHaveCount(0);
    await expect(scmState).toHaveAttribute('data-state', 'noRepository');
    await expect.poll(async () => (await shellState(app)).selected).toEqual({ projectKey, chatId: sessionId });
    await expect.poll(() => loadedSessionIds(app)).toContain(sessionId);
    await expect((await activeChat(app)).getByText('Echo: a chat in the folder that moves', { exact: true })).toBeVisible();
    expect((await recordedToasts(app)).filter((toast) => toast.severity === 'error')).toEqual([]);
  } finally {
    await stub.close();
  }
});

test('a project folder deleted while the app runs shows as missing on focus, and Remove project removes it', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const doomed = path.join(path.dirname(home.project), 'doomed');
  fs.mkdirSync(doomed, { recursive: true });
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await addProject(app, home.project, true);
  await addProject(app, doomed, true);
  const state = await shellState(app);
  const doomedKey = state.projects.find((p) => p.fsPath === doomed)!.key;
  const keptKey = state.projects.find((p) => p.fsPath === home.project)!.key;
  const shell = await readyShell(app);
  await projectRow(shell, keptKey).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(keptKey);

  fs.rmSync(doomed, { recursive: true, force: true, maxRetries: 10 });
  await focusWindow(app);
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === doomedKey)?.presence).toBe('missing');

  await projectRow(shell, doomedKey).click();
  await expect(shell.getByTestId('absent-project')).toBeVisible();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(doomedKey);
  await shell.getByTestId('absent-project-remove').click();
  await expect.poll(async () => (await shellState(app)).projects.map((p) => p.key)).toEqual([keptKey]);
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(keptKey);
});

// core watches nothing that tells it a folder went, so it hears it from main, checks the folder itself and runs no git there
test('Source control of a selected project whose folder is deleted while the app runs says the folder was not found', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const doomed = path.join(path.dirname(home.project), 'doomed-scm');
  fs.mkdirSync(doomed, { recursive: true });
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await addProject(app, doomed, true);
  const doomedKey = (await shellState(app)).projects.find((p) => p.fsPath === doomed)!.key;
  const shell = await readyShell(app);
  await projectRow(shell, doomedKey).click();
  await expect.poll(async () => (await shellState(app)).selected.projectKey).toBe(doomedKey);
  const scmState = scmSection(shell).getByTestId('scm-state');
  await expect(scmState).toHaveAttribute('data-state', 'noRepository', { timeout: 30_000 });

  fs.rmSync(doomed, { recursive: true, force: true, maxRetries: 10 });
  await focusWindow(app);
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === doomedKey)?.presence).toBe('missing');
  await expect(scmState).toHaveAttribute('data-state', 'absent', { timeout: 30_000 });
  await expect(scmState).toContainText('Folder not found.');
  await expect(scmState.getByTestId('scm-state-action')).toHaveCount(0);
});

test('Remove project of a missing folder asks about a kept chat holding its first prompt: Cancel keeps it saved, Remove Project drops it', async ({ home, launch }) => {
  test.setTimeout(180_000);
  let desktop = await launch();
  let app = desktop.app;
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await addProject(app, home.project, true);
  const projectKey = (await shellState(app)).projects.find((p) => p.fsPath === home.project)!.key;
  await desktop.close();

  const panelId = 'held-while-missing';
  const file = path.join(home.userData, 'panels.json');
  const panels = JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: unknown[] };
  const chat = { panelId, state: { workspaceFolderKey: projectKey }, pages: [], heldPrompt: [{ type: 'text', text: 'Held while the folder is gone' }] };
  fs.writeFileSync(file, JSON.stringify({ ...panels, chats: [...panels.chats, chat] }));
  fs.renameSync(home.project, `${home.project}-moved`);
  desktop = await launch();
  app = desktop.app;
  await expect.poll(async () => (await shellState(app)).projects.find((p) => p.key === projectKey)?.presence).toBe('missing');
  const shell = await readyShell(app);
  const overlay = await readyOverlay(app);
  const question = overlay.getByTestId('overlay-message');
  const removeProject = () => shell.evaluate((key) => window.damoclesShell!.removeProject(key), projectKey);

  const cancelled = removeProject();
  await expect(question).toContainText('has a chat whose first message is waiting for its worktree. Do you want to remove the project?');
  await expect(question.getByTestId('overlay-message-preview')).toHaveText('Held while the folder is gone');
  await question.getByTestId('overlay-message-cancel').click();
  expect(await cancelled).toEqual({ ok: true, removed: false });
  expect((await shellState(app)).projects.some((p) => p.key === projectKey)).toBe(true);
  expect(savedPanelIds(home)).toContain(panelId);

  const confirmed = removeProject();
  await question.getByTestId('overlay-message-action-0').click();
  expect(await confirmed).toEqual({ ok: true, removed: true });
  expect((await shellState(app)).projects.some((p) => p.key === projectKey)).toBe(false);
  await expect.poll(() => savedPanelIds(home)).not.toContain(panelId);
});
