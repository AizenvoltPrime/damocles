import * as os from 'node:os';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { corePid, mainLog, readyCorePid } from './support/app';
import { SHELL_CHANNELS } from '../../src/desktop/preload/shell-channels';
import { activeChat, expect, IPC_HANDLER_ERROR_ANNOTATION, nextChat, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { dismissedToasts, recordedToasts, recordToasts, selectedProjectKey, shellPage, shellState } from './support/shell';
import { awaitTurnEnd, chatInput, clickMenu, sendAndAwaitEcho } from './support/ui';

// The notices main shows for a core crash (src/desktop/main/index.ts coreCrashed).
const RESTARTED = 'The Damocles engine stopped unexpectedly and was restarted.';
const NOT_RESTARTED = 'The Damocles engine stopped unexpectedly 4 times in 5 minutes, so it was not restarted.';
// The next core takes over the killed core's session leases at once, so a chat reopens well inside the 20 s lease staleness.
const REOPEN_TIMEOUT_MS = 15_000;
// CORE_SERVICE_NAME in src/desktop/main/core-process.ts, which imports electron
const CORE_SERVICE_NAME = 'Damocles Core';

type Marked = typeof window & { __e2eBeforeKill?: boolean };

const chatPages = (app: ElectronApplication): Page[] => app.windows().filter((page) => !page.isClosed() && page.url().includes('/panel/'));

// Marks every chat document, so a reopened chat is told from one left on screen by the dead core.
async function markChats(app: ElectronApplication): Promise<void> {
  for (const page of chatPages(app)) await page.evaluate(() => void ((window as Marked).__e2eBeforeKill = true));
}

// The crash main logged for pid past `since`, an offset into its log: the OS may give a later core the same pid.
const crashLine = (home: HermeticHome, pid: number, since: number): string | undefined =>
  mainLog(home).slice(since).split('\n').find((line) => line.includes(`[core] stopped unexpectedly (pid ${pid}, `));

// SIGKILL, a real crash on POSIX too, where SIGTERM lets signal-exit release core's lease locks. Returns main's log offset
// from before the kill, which readyCorePid reads the next core's ready line past.
async function killCore(home: HermeticHome, pid: number, outcome: string): Promise<number> {
  const since = mainLog(home).length;
  process.kill(pid, 'SIGKILL');
  await expect.poll(() => crashLine(home, pid, since)).toContain(`; ${outcome}`);
  return since;
}

const restartNotices = async (app: ElectronApplication): Promise<number> => (await recordedToasts(app)).filter((notice) => notice.message === RESTARTED && notice.severity === 'info').length;

interface SavedChat {
  readonly sessionId: string;
  // the chat's latest reply: the message list renders only the rows near the bottom it scrolls to after a replay
  text: string;
}

async function echoIn(page: Page, chat: SavedChat, text: string): Promise<void> {
  await sendAndAwaitEcho(page, text);
  chat.text = `Echo: ${text}`;
}

// The page of each chat once it is a document loaded since markChats, saved under its session and showing its latest reply.
async function reopened(app: ElectronApplication, chats: readonly SavedChat[]): Promise<Page[]> {
  const found = new Map<string, Page>();
  const missing = async (): Promise<string[]> => {
    found.clear();
    for (const page of chatPages(app)) {
      const state = await page.evaluate(() => ({
        marked: (window as Marked).__e2eBeforeKill === true,
        sessionId: (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId,
      })).catch(() => undefined);
      const chat = chats.find((candidate) => candidate.sessionId === state?.sessionId);
      if (state === undefined || state.marked || chat === undefined) continue;
      if ((await page.getByText(chat.text, { exact: true }).count().catch(() => 0)) > 0) found.set(chat.sessionId, page);
    }
    return chats.filter((chat) => !found.has(chat.sessionId)).map((chat) => `${chat.sessionId} ("${chat.text}")`);
  };
  await expect.poll(missing, { timeout: REOPEN_TIMEOUT_MS, message: 'chats that did not reopen with their conversation' }).toEqual([]);
  return chats.map((chat) => found.get(chat.sessionId)!);
}

async function storedChatId(app: ElectronApplication): Promise<string> {
  await expect.poll(async () => (await shellState(app)).selected.chatId?.startsWith('new:')).toBe(false);
  return (await shellState(app)).selected.chatId!;
}

// The composer's mode button and YOLO toggle show what core's PermissionHandler holds (sendCurrentSettings).
async function expectPermissions(tab: Page, mode: RegExp, yolo: boolean): Promise<void> {
  await expect(tab.getByTestId('composer-mode')).toHaveAccessibleName(mode);
  await expect(tab.getByTestId('composer-yolo')).toHaveAttribute('aria-pressed', String(yolo));
}

test('a chat keeps its permission mode and YOLO through an engine crash, with an approval open, and through Restart Engine, never taking the user\'s more permissive defaults', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.permissionMode': 'acceptEdits', 'damocles.dangerouslySkipPermissions': true });
    const { app } = await launch();
    const planning = await activeChat(app);
    await expect(chatInput(planning)).toBeVisible();
    await expectPermissions(planning, /^Accept edits/, true);
    // Sent before plan mode, whose nudge would hold an echo's turn open.
    await sendAndAwaitEcho(planning, 'plan chat');
    const planningId = await storedChatId(app);
    await planning.getByTestId('composer-mode').click();
    await expectPermissions(planning, /^Plan mode/, true);

    const opened = nextChat(app, [planning]);
    await clickMenu(app, 'damocles.newChat');
    const asking = await opened;
    await expect(chatInput(asking)).toBeVisible();
    await asking.getByTestId('composer-mode').click();
    await asking.getByTestId('composer-mode').click();
    await asking.getByTestId('composer-yolo').click();
    await expectPermissions(asking, /^Ask before edits/, false);
    await sendAndAwaitEcho(asking, 'ask chat');
    const chats = [{ sessionId: planningId, text: 'Echo: plan chat' }, { sessionId: await storedChatId(app), text: 'Echo: ask chat' }];

    // The crash comes while the asking chat waits on a shell approval its mode asked for.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo before-the-crash' } }] });
    await chatInput(asking).fill('run it');
    await chatInput(asking).press('Enter');
    await expect(asking.getByRole('region', { name: 'Permission request' })).toContainText('echo before-the-crash');
    let pid = await readyCorePid(app, home);
    await markChats(app);
    const since = await killCore(home, pid, 'restarting (1 of 3 in 5 minutes)');
    pid = await readyCorePid(app, home, since);
    const [planningAfterCrash, askingAfterCrash] = await reopened(app, chats);
    await expectPermissions(planningAfterCrash!, /^Plan mode/, true);
    await expectPermissions(askingAfterCrash!, /^Ask before edits/, false);

    // The new engine asks before a shell command, as the chat's mode says, rather than running it under the default YOLO.
    stub.replies.push({ chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo after-the-crash' } }] }, { chunks: ['Command done'] });
    await chatInput(askingAfterCrash!).fill('run it again');
    await chatInput(askingAfterCrash!).press('Enter');
    const prompt = askingAfterCrash!.getByRole('region', { name: 'Permission request' });
    await expect(prompt).toContainText('echo after-the-crash');
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(askingAfterCrash!.getByText('Command done')).toBeVisible();
    await awaitTurnEnd(askingAfterCrash!);
    chats[1]!.text = 'Command done';

    // Restart Engine replaces the running engine; the chats come back as the user left them again.
    await markChats(app);
    const reloaded = mainLog(home).length;
    await clickMenu(app, 'damocles.restartEngine');
    expect(await readyCorePid(app, home, reloaded)).not.toBe(pid);
    const [planningAfterRestart, askingAfterRestart] = await reopened(app, chats);
    await expectPermissions(planningAfterRestart!, /^Plan mode/, true);
    await expectPermissions(askingAfterRestart!, /^Ask before edits/, false);
  } finally {
    await stub.close();
  }
});

test('Damocles Core is its own process; a killed core restarts with a notice and reopens the chats, the fourth kill in 5 minutes leaves a Restart notice and an engine pill in the title bar, and Restart Engine brings it back, halted or running', async ({ home, launch }, testInfo) => {
  // With the engine down after the fourth kill, main refuses the sidebar's chat list, which shows it as not loaded.
  testInfo.annotations.push({ type: IPC_HANDLER_ERROR_ANNOTATION, description: SHELL_CHANNELS.chatsList });
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const first = await activeChat(app);
    await expect(chatInput(first)).toBeVisible();
    await sendAndAwaitEcho(first, 'first chat');
    const firstId = await storedChatId(app);
    const opened = nextChat(app, [first]);
    await clickMenu(app, 'damocles.newChat');
    const second = await opened;
    await expect(chatInput(second)).toBeVisible();
    await sendAndAwaitEcho(second, 'second chat');
    const chats: SavedChat[] = [{ sessionId: firstId, text: 'Echo: first chat' }, { sessionId: await storedChatId(app), text: 'Echo: second chat' }];
    const echoInSecond = async (text: string): Promise<void> => echoIn((await reopened(app, chats))[1]!, chats[1]!, text);

    // Each core is told from the one before it by its ready line after the crash, never by its pid, which the OS may reuse.
    let pid = await readyCorePid(app, home);
    expect(pid).not.toBe(app.process().pid);
    const utilities = await app.evaluate(({ app: electronApp }) =>
      electronApp.getAppMetrics().filter((metric) => metric.type === 'Utility').map((metric) => ({ pid: metric.pid, name: metric.name })),
    );
    expect(utilities).toContainEqual({ pid, name: CORE_SERVICE_NAME });
    await recordToasts(app);

    // Crashes 1 to 3: the engine restarts and both chats reopen with their conversations, on the new engine.
    for (const crash of [1, 2, 3]) {
      await markChats(app);
      const since = await killCore(home, pid, `restarting (${crash} of 3 in 5 minutes)`);
      await expect.poll(() => restartNotices(app)).toBe(crash);
      pid = await readyCorePid(app, home, since);
      await echoInSecond(`after crash ${crash}`);
    }

    // Crash 4 inside the window: no restart, an error notice with Restart, and a request that needs the engine is refused.
    const gaveUp = await killCore(home, pid, 'not restarting after 3 restarts in 5 minutes');
    let restartId: string | undefined;
    await expect.poll(async () => {
      const notice = (await recordedToasts(app)).find((candidate) => candidate.message === NOT_RESTARTED);
      restartId = notice?.id;
      return notice && { severity: notice.severity, actions: notice.actions };
    }).toEqual({ severity: 'error', actions: ['Restart'] });
    expect(await corePid(app)).toBeUndefined();
    // The title bar says the engine stopped, and its pill restarts it.
    const shell = await shellPage(app);
    await expect.poll(async () => (await shellState(app)).engineHalted).toBe(true);
    const pill = shell.getByTestId('engine-pill');
    await expect(pill).toBeVisible();
    await expect(pill).toHaveText('Engine stopped');
    const titleBar = await shell.getByTestId('title-bar').boundingBox();
    await shell.screenshot({ path: path.join(os.tmpdir(), 'damocles-engine-pill.png'), ...(titleBar ? { clip: titleBar } : {}) });
    expect(mainLog(home).slice(gaveUp)).not.toContain('[core] started');
    const projectKey = await selectedProjectKey(app);
    await shell.evaluate((key) => void window.damoclesShell!.newChat(key), projectKey);
    await expect.poll(() => mainLog(home).slice(gaveUp)).toContain('The Damocles engine is not running');
    expect(await corePid(app)).toBeUndefined();

    // The pill's Restart Engine starts the engine and reopens the chats; the notice no longer offers Restart.
    await markChats(app);
    const restarted = mainLog(home).length;
    await pill.click();
    pid = await readyCorePid(app, home, restarted);
    await echoInSecond('after Restart');
    expect(await dismissedToasts(app)).toContain(restartId);
    expect((await shellState(app)).engineHalted).toBe(false);
    await expect(pill).toBeHidden();

    // Restart Engine cleared the crash history: the next kill restarts again as the first of three.
    await markChats(app);
    const since = await killCore(home, pid, 'restarting (1 of 3 in 5 minutes)');
    pid = await readyCorePid(app, home, since);
    await echoInSecond('after the next crash');

    // Restart Engine from the menu replaces a running engine too.
    await markChats(app);
    const reloaded = mainLog(home).length;
    await clickMenu(app, 'damocles.restartEngine');
    const next = await readyCorePid(app, home, reloaded);
    expect(next).not.toBe(pid);
    await echoInSecond('after Restart Engine');
  } finally {
    await stub.close();
  }
});
