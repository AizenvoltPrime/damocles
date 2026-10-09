import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import { SHELL_CHANNELS } from '../../src/desktop/preload/shell-channels';
import { logBeforeQuit, mainLog } from './support/app';
import { activeChat, expect, IPC_HANDLER_ERROR_ANNOTATION, test } from './support/fixtures';
import { openProjectChat } from './support/screenshots';
import { closeSettingsModal, settingsModal } from './support/settings';
import { overlayPage, popupPage, popupToasts, selectedProjectKey, shellPage, shellState } from './support/shell';
import { listChats, readyShell } from './support/shell-ui';
import { openTerminal, useTestProfile } from './support/terminal';
import { chatInput, clickMenu } from './support/ui';

// A quit takes about a second; its teardown is bounded at 10 s.
const QUIT_BUDGET_MS = 15_000;

interface DisposeHold {
  readonly reached: boolean;
  release(): void;
}
interface RestoreHold extends DisposeHold {
  fail(): void;
}
interface PageRestorer {
  restoreChatPages(...args: unknown[]): Promise<void>;
}
type HoldGlobals = typeof globalThis & {
  __damoclesE2e?: {
    holdCoreDispose(): DisposeHold;
    holdStoreFlush(): DisposeHold;
    reloadCore(): Promise<void>;
    holdChatRestore(): RestoreHold;
    browser(): PageRestorer;
    launchRestore?: RestoreHold;
  };
  __e2eCoreHold?: DisposeHold;
  __e2eFlushHold?: DisposeHold;
  __e2eRestoreHold?: RestoreHold;
  __e2eReload?: string;
  __e2ePageRestores?: number;
};
type Settled = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string };
type RequestGlobals = typeof window & { __e2eRequests?: Record<string, Settled | 'pending'> };

// Reloads the core with the old core's dispose held open, so the window stays up while no core runs.
async function reloadHeld(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const globals = globalThis as HoldGlobals;
    globals.__e2eCoreHold = globals.__damoclesE2e!.holdCoreDispose();
    void globals.__damoclesE2e!.reloadCore();
  });
  await expect.poll(() => app.evaluate(() => (globalThis as HoldGlobals).__e2eCoreHold!.reached)).toBe(true);
}

const releaseDispose = (app: ElectronApplication): Promise<void> => app.evaluate(() => (globalThis as HoldGlobals).__e2eCoreHold!.release());
const disposeReached = (app: ElectronApplication): Promise<boolean> => app.evaluate(() => (globalThis as HoldGlobals).__e2eCoreHold!.reached);
// Whether the dispose began once main's event loop has turned a while, long enough for a reload with nothing to wait for.
const disposeReachedAfterTurns = (app: ElectronApplication): Promise<boolean> => app.evaluate(async () => {
  for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  return (globalThis as HoldGlobals).__e2eCoreHold!.reached;
});
const reloadOutcome = (app: ElectronApplication): Promise<string | undefined> => app.evaluate(() => (globalThis as HoldGlobals).__e2eReload);

// Starts a reload with the old core's dispose held, and answers whether the dispose had begun by the time reload() returned.
const reloadWithDisposeHeld = (app: ElectronApplication): Promise<boolean> => app.evaluate(() => {
  const globals = globalThis as HoldGlobals;
  globals.__e2eCoreHold = globals.__damoclesE2e!.holdCoreDispose();
  globals.__e2eReload = 'pending';
  globals.__damoclesE2e!.reloadCore().then(() => (globals.__e2eReload = 'done'), (error: unknown) => (globals.__e2eReload = String(error)));
  return globals.__e2eCoreHold.reached;
});

// Holds every chat restore from now on; with reload, reloads the core, whose reopening of the chats then waits on the hold.
async function holdRestores(app: ElectronApplication, reload: boolean): Promise<void> {
  await app.evaluate((_electron, andReload) => {
    const globals = globalThis as HoldGlobals;
    globals.__e2eRestoreHold = globals.__damoclesE2e!.holdChatRestore();
    if (andReload) void globals.__damoclesE2e!.reloadCore();
  }, reload);
}
const restoreReached = (app: ElectronApplication): Promise<boolean> => app.evaluate(() => (globalThis as HoldGlobals).__e2eRestoreHold!.reached);
const releaseRestores = (app: ElectronApplication): Promise<void> => app.evaluate(() => (globalThis as HoldGlobals).__e2eRestoreHold!.release());
const failRestores = (app: ElectronApplication): Promise<void> => app.evaluate(() => (globalThis as HoldGlobals).__e2eRestoreHold!.fail());

test('the sidebar\'s chat requests and the settings modal asked for during a host reload are answered by the new core', async ({ home, launch }) => {
  const desktop = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  const { app } = desktop;
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const shell = await readyShell(app);
  const projectKey = await selectedProjectKey(app);
  const { selected, revision } = await shellState(app);
  const chatId = selected.chatId!;

  const requests = (): Promise<Record<string, Settled | 'pending'> | undefined> => shell.evaluate(() => (window as RequestGlobals).__e2eRequests);
  // Each call the shell makes while the old core disposes; settings is the overlay's request.
  const ask = (calls: ReadonlyArray<'list' | 'search' | 'select' | 'project' | 'new' | 'settings'>): Promise<void> => shell.evaluate(({ key, chat, names, stateRevision }) => {
    const shellApi = window.damoclesShell!;
    const started: Record<string, () => Promise<unknown>> = {
      list: () => shellApi.listChats(key, stateRevision),
      search: () => shellApi.searchChats(key, 'anything', stateRevision),
      select: () => shellApi.selectChat(chat),
      project: () => shellApi.selectProject(key),
      new: () => shellApi.newChat(key),
    };
    const tracked: Record<string, Settled | 'pending'> = {};
    (window as RequestGlobals).__e2eRequests = tracked;
    for (const name of names) {
      if (name === 'settings') {
        void shellApi.openSettings();
        continue;
      }
      tracked[name] = 'pending';
      started[name]!().then((value) => (tracked[name] = { ok: true, value }), (error: unknown) => (tracked[name] = { ok: false, error: String(error) }));
    }
  }, { key: projectKey, chat: chatId, names: calls, stateRevision: revision });

  await reloadHeld(app);
  await ask(['list', 'search', 'select', 'project', 'settings']);
  // Still waiting while the old core disposes, rather than refused or answered for want of a core.
  await expect.poll(requests).toEqual({ list: 'pending', search: 'pending', select: 'pending', project: 'pending' });
  await expect(settingsModal(await overlayPage(app))).toHaveCount(0);
  await releaseDispose(app);
  await expect.poll(requests).toEqual({
    list: { ok: true, value: expect.objectContaining({ projectKey }) },
    search: { ok: true, value: expect.objectContaining({ projectKey }) },
    select: { ok: true, value: { ok: true } },
    project: { ok: true, value: undefined },
  });
  const overlay = await overlayPage(app);
  await expect(settingsModal(overlay)).toBeVisible();
  // The modal waits for the selected chat the reload restores, and opens no chat of its own.
  expect((await shellState(app)).selected.chatId).toBe(chatId);
  expect((await listChats(app, projectKey)).chats.map((chat) => chat.id)).toEqual([chatId]);
  await closeSettingsModal(overlay);

  // A new chat moves the selection off the empty one, which retention then drops, so it gets a reload of its own.
  await reloadHeld(app);
  await ask(['new']);
  await expect.poll(requests).toEqual({ new: 'pending' });
  await releaseDispose(app);
  await expect.poll(requests).toEqual({ new: { ok: true, value: undefined } });
  await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(chatId);
  await expect(chatInput(await activeChat(app))).toBeVisible();
  // A shell action that fails in main is logged and shown as a toast, never thrown, so only the log tells.
  await desktop.close();
  expect(logBeforeQuit(home)).not.toMatch(/\[shell\] .* failed/);
});

test('a quit during a host reload refuses the window\'s requests waiting on it before the window closes, and finishes', async ({ home, launch }, testInfo) => {
  testInfo.annotations.push({ type: IPC_HANDLER_ERROR_ANNOTATION, description: SHELL_CHANNELS.chatsList });
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const shell = await readyShell(app);
  const projectKey = await selectedProjectKey(app);
  const proc = app.process();

  const { revision } = await shellState(app);
  await reloadHeld(app);
  await shell.evaluate(({ key, stateRevision }) => {
    void window.damoclesShell!.listChats(key, stateRevision).catch(() => undefined);
  }, { key: projectKey, stateRevision: revision });
  await app.evaluate(({ app: electronApp }) => {
    setImmediate(() => electronApp.quit());
  });
  await expect.poll(() => mainLog(home), { timeout: QUIT_BUDGET_MS }).toContain('[window] closed');
  await releaseDispose(app);
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_BUDGET_MS, message: 'the app is still running' }).toBe(true);

  const shutdown = mainLog(home).slice(mainLog(home).indexOf('[shutdown] quitting'));
  const refused = shutdown.indexOf(`[shell] ${SHELL_CHANNELS.chatsList} failed: Core services are stopped for the quit`);
  expect(refused).toBeGreaterThan(0);
  expect(refused).toBeLessThan(shutdown.indexOf('[window] closed'));
  expect(shutdown).not.toContain('did not settle');
  expect(shutdown).toContain('[shutdown] will-quit');
});

test('a reload lets a sidebar request already running on the old core finish before it disposes that core', async ({ home, launch }) => {
  const desktop = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  const { app } = desktop;
  await expect(chatInput(await activeChat(app))).toBeVisible();
  const shell = await readyShell(app);
  const projectKey = await selectedProjectKey(app);
  const chatId = (await shellState(app)).selected.chatId!;
  const requests = (): Promise<Record<string, Settled | 'pending'> | undefined> => shell.evaluate(() => (window as RequestGlobals).__e2eRequests);

  // New Chat runs on the core until core restored the chat it opened.
  await holdRestores(app, false);
  await shell.evaluate((key) => {
    const tracked: Record<string, Settled | 'pending'> = { new: 'pending' };
    (window as RequestGlobals).__e2eRequests = tracked;
    window.damoclesShell!.newChat(key).then((value) => (tracked['new'] = { ok: true, value }), (error: unknown) => (tracked['new'] = { ok: false, error: String(error) }));
  }, projectKey);
  await expect.poll(() => restoreReached(app)).toBe(true);

  expect(await reloadWithDisposeHeld(app)).toBe(false);
  await expect.poll(requests).toEqual({ new: 'pending' });
  expect(await disposeReachedAfterTurns(app)).toBe(false);
  await releaseRestores(app);

  await expect.poll(requests).toEqual({ new: { ok: true, value: undefined } });
  await expect.poll(() => disposeReached(app)).toBe(true);
  await releaseDispose(app);
  await expect.poll(() => reloadOutcome(app)).toBe('done');
  await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(chatId);
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain('still running on the old core');
});

test('a mention and an Add to Chat made while a reload restores the selected chat wait for it and reach it, and a failed restore says so', async ({ home, launch }) => {
  test.setTimeout(120_000);
  useTestProfile(home);
  fs.writeFileSync(path.join(home.project, 'NOTES.md'), '# Notes\n');
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1' } });
  await openProjectChat(app, home.project);
  await openTerminal(app);
  const shell = await shellPage(app);
  const projectKey = await selectedProjectKey(app);
  const terminalId = (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[0]!.id;
  const requests = (): Promise<Record<string, Settled | 'pending'> | undefined> => shell.evaluate(() => (window as RequestGlobals).__e2eRequests);
  // A mention and an Add to Chat, made once the reload reopened the selected chat and while core still restores it.
  const mentionAndAdd = (text: string): Promise<void> => shell.evaluate(({ key, id, output }) => {
    const shellApi = window.damoclesShell!;
    const tracked: Record<string, Settled | 'pending'> = { mention: 'pending' };
    (window as RequestGlobals).__e2eRequests = tracked;
    shellApi.mentionFile({ projectKey: key, relativePath: 'NOTES.md' }).then((value) => (tracked['mention'] = { ok: true, value }), (error: unknown) => (tracked['mention'] = { ok: false, error: String(error) }));
    shellApi.terminal.addToChat({ id, source: 'selection', commandId: null, text: output, omittedLines: 0 });
  }, { key: projectKey, id: terminalId, output: text });

  await holdRestores(app, true);
  await expect.poll(() => restoreReached(app)).toBe(true);
  await mentionAndAdd('held output');
  await expect.poll(requests).toEqual({ mention: 'pending' });
  await releaseRestores(app);
  await expect.poll(requests).toEqual({ mention: { ok: true, value: undefined } });
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toHaveValue('@NOTES.md ');
  await expect(tab.getByTestId('terminal-attachment-chip')).toHaveCount(1);

  // A chat New Chat just opened is waited for the same way.
  await holdRestores(app, false);
  await shell.evaluate((key) => void window.damoclesShell!.newChat(key), projectKey);
  await expect.poll(() => restoreReached(app)).toBe(true);
  await mentionAndAdd('new chat output');
  await expect.poll(requests).toEqual({ mention: 'pending' });
  await releaseRestores(app);
  await expect.poll(requests).toEqual({ mention: { ok: true, value: undefined } });
  const opened = await activeChat(app);
  expect(opened).not.toBe(tab);
  await expect(chatInput(opened)).toHaveValue('@NOTES.md ');
  await expect(opened.getByTestId('terminal-attachment-chip')).toHaveCount(1);

  // A chat core opens itself (File › Open Chat, a fork) is waited for the same way, until core set it up.
  await holdRestores(app, false);
  const beforeOpen = (await shellState(app)).selected.chatId;
  await clickMenu(app, 'damocles.openChat');
  await expect.poll(async () => (await shellState(app)).selected.chatId).not.toBe(beforeOpen);
  const coreOpened = await activeChat(app);
  expect(coreOpened).not.toBe(opened);
  await expect(chatInput(coreOpened)).toBeVisible();
  await mentionAndAdd('core chat output');
  await expect.poll(requests).toEqual({ mention: 'pending' });
  await app.evaluate(async () => {
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
  });
  expect(await requests()).toEqual({ mention: 'pending' });
  await expect(chatInput(coreOpened)).toHaveValue('');
  await releaseRestores(app);
  await expect.poll(requests).toEqual({ mention: { ok: true, value: undefined } });
  await expect(chatInput(coreOpened)).toHaveValue('@NOTES.md ');
  await expect(coreOpened.getByTestId('terminal-attachment-chip')).toHaveCount(1);

  await holdRestores(app, true);
  await expect.poll(() => restoreReached(app)).toBe(true);
  await mentionAndAdd('lost output');
  await failRestores(app);
  await expect.poll(requests).toEqual({ mention: { ok: true, value: undefined } });
  const toasts = popupToasts(await popupPage(app));
  await expect(toasts.filter({ hasText: 'The chat could not be loaded, so the file was not mentioned in it.' })).toHaveCount(1);
  await expect(toasts.filter({ hasText: 'The chat could not be loaded, so the terminal output was not added to it.' })).toHaveCount(1);
  await expect(toasts.filter({ hasText: 'Open a chat to mention a file in it.' })).toHaveCount(0);
});

test('a reload asked for while the launch reopens its chats waits for them, then reopens them into the new core', async ({ home, launch }) => {
  const desktop = await launch({ env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_HOLD_CHAT_RESTORE: '1' } });
  const { app } = desktop;
  await expect.poll(() => app.evaluate(() => (globalThis as HoldGlobals).__damoclesE2e?.launchRestore?.reached ?? false)).toBe(true);

  // The launch is still reopening its chats into the core, so the reload does not dispose it yet.
  expect(await reloadWithDisposeHeld(app)).toBe(false);
  expect(await disposeReachedAfterTurns(app)).toBe(false);
  expect(await reloadOutcome(app)).toBe('pending');
  await app.evaluate(() => (globalThis as HoldGlobals).__damoclesE2e!.launchRestore!.release());

  await expect.poll(() => disposeReached(app)).toBe(true);
  await releaseDispose(app);
  await expect.poll(() => reloadOutcome(app)).toBe('done');
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await desktop.close();
  expect(logBeforeQuit(home)).not.toContain('[startup] failed');
  expect(logBeforeQuit(home)).not.toContain('Reopening chats failed');
});

test('a quit while the launch restores a chat with saved pages ends that restore cleanly, restores no page into the disposed core, and exits', async ({ home, launch }) => {
  fs.mkdirSync(home.userData, { recursive: true });
  fs.writeFileSync(path.join(home.userData, 'panels.json'), JSON.stringify({
    version: 2,
    chats: [{ panelId: 'paged-chat', state: null, pages: ['about:blank'], activePage: 0 }],
  }));
  const { app } = await launch({ env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_HOLD_CHAT_RESTORE: '1' } });
  await expect.poll(() => app.evaluate(() => (globalThis as HoldGlobals).__damoclesE2e?.launchRestore?.reached ?? false)).toBe(true);
  const proc = app.process();

  // Counts the pages main asks the core to restore, and holds the quit after the core disposed so the restore can resume then.
  await app.evaluate(({ app: electronApp }) => {
    const globals = globalThis as HoldGlobals;
    const browser = globals.__damoclesE2e!.browser();
    const restoreChatPages = browser.restoreChatPages.bind(browser);
    globals.__e2ePageRestores = 0;
    browser.restoreChatPages = (...args: unknown[]) => {
      globals.__e2ePageRestores = (globals.__e2ePageRestores ?? 0) + 1;
      return restoreChatPages(...args);
    };
    globals.__e2eFlushHold = globals.__damoclesE2e!.holdStoreFlush();
    setImmediate(() => electronApp.quit());
  });
  await expect.poll(() => app.evaluate(() => (globalThis as HoldGlobals).__e2eFlushHold!.reached), { timeout: QUIT_BUDGET_MS }).toBe(true);
  await expect.poll(() => mainLog(home)).toContain('Damocles core disposed');

  const pageRestores = await app.evaluate(async () => {
    const globals = globalThis as HoldGlobals;
    globals.__damoclesE2e!.launchRestore!.release();
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setImmediate(resolve));
    return globals.__e2ePageRestores;
  });
  await app.evaluate(() => (globalThis as HoldGlobals).__e2eFlushHold!.release());
  await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_BUDGET_MS, message: 'the app is still running' }).toBe(true);

  expect(pageRestores).toBe(0);
  const log = mainLog(home);
  expect(log).not.toContain('[startup] failed');
  expect(log).not.toContain('Restoring a chat failed');
  expect(log).not.toContain('Restoring browser pages failed');
  expect(log).not.toContain('[main] unhandled rejection');
  expect(log).not.toContain('[main] uncaught exception');
  expect(log).toContain('[shutdown] will-quit');
});
