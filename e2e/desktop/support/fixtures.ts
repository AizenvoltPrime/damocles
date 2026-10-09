import * as path from 'node:path';
import { test as base, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { attachDiagnostics, launchDesktop, type DesktopApp, type LaunchOptions } from './app';
import { CLIPBOARD_LOCK_WAIT_MS, withClipboardLock, type E2eClipboard } from './clipboard';
import { PACKAGED_SPECS } from './packaged-app';
import { FOREGROUND_WAIT_MS, openingApp, withForeground } from './foreground';
import { createHermeticHome, type HermeticHome } from './hermetic';
import { selectedProjectKey, shellPage, shellState } from './shell';

// Electron prints this when an ipcMain.handle handler throws; the renderer gets a rejection and the test may never see it.
const IPC_HANDLER_ERROR = 'Error occurred in handler for ';
export const IPC_HANDLER_ERROR_ANNOTATION = 'ipc-handler-error';

/** Runs `wait` within its own `budget` instead of the test's time: afterwards the test has exactly the time it had left. */
async function outsideTestTime<T>(testInfo: TestInfo, budget: number, wait: () => Promise<T>): Promise<T> {
  const timeout = testInfo.timeout;
  if (timeout === 0) return wait();
  const started = performance.now();
  testInfo.setTimeout(timeout + budget);
  try {
    return await wait();
  } finally {
    testInfo.setTimeout(timeout + Math.ceil(performance.now() - started));
  }
}

export interface DesktopFixtures {
  home: HermeticHome;
  /** Launches the app on `home`; every launch is closed and its logs attached after the test. */
  launch: (options?: LaunchOptions) => Promise<DesktopApp>;
  /**
   * The OS clipboard, held exclusively across workers for the whole test with the foreground, since a paste needs keyboard
   * focus; scripts/__tests__/e2e-clipboard.test.ts requires it.
   */
  clipboard: E2eClipboard;
  /** The OS foreground, held across workers for the whole test: no other worker has an app open meanwhile. */
  foreground: void;
}

export const test = base.extend<DesktopFixtures>({
  // eslint-disable-next-line no-empty-pattern
  home: async ({}, use) => {
    const home = createHermeticHome();
    await use(home);
    await home.dispose();
  },
  launch: async ({ home }, use, testInfo) => {
    const launched: DesktopApp[] = [];
    const closedApps: Array<() => void> = [];
    const mainProcess = !PACKAGED_SPECS.includes(path.basename(testInfo.file));
    await use(async (options) => {
      // How long another worker holds the foreground is not this test's time, as for the clipboard and foreground fixtures.
      const closedApp = await outsideTestTime(testInfo, FOREGROUND_WAIT_MS + 30_000, openingApp);
      const desktop = await launchDesktop(home, options, mainProcess).catch((error: unknown) => {
        closedApp();
        throw error;
      });
      closedApps.push(closedApp);
      launched.push(desktop);
      await desktop.startTracing();
      return desktop;
    });
    const failed = testInfo.status !== testInfo.expectedStatus;
    // A test that makes main refuse a channel on purpose names it in an IPC_HANDLER_ERROR_ANNOTATION.
    const refusedOnPurpose = testInfo.annotations.filter((annotation) => annotation.type === IPC_HANDLER_ERROR_ANNOTATION).map((annotation) => `'${annotation.description}'`);
    // Every launch is closed even when an earlier step throws; home.dispose() cannot remove files a live app holds open.
    let firstError: { error: unknown } | undefined;
    const record = (error: unknown): void => {
      firstError ??= { error };
    };
    for (const [i, desktop] of launched.entries()) {
      await desktop.stopTracing(failed ? testInfo.outputPath(`trace-${i}.zip`) : undefined).catch(record);
      await desktop.close().catch((error: unknown) => record(new Error(`launch ${i}: ${error instanceof Error ? error.message : String(error)}`)));
      closedApps[i]!();
      // After close, so the attached log also covers the shutdown.
      await attachDiagnostics(testInfo, `launch-${i}`, desktop, home).catch(record);
      const handlerErrors = desktop.output().split('\n').filter((line) => line.includes(IPC_HANDLER_ERROR) && !refusedOnPurpose.some((channel) => line.includes(channel)));
      if (handlerErrors.length > 0) record(new Error(`launch ${i}: main threw in an IPC handler:\n${handlerErrors.join('\n')}`));
    }
    if (firstError) throw firstError.error;
  },
  // A test lists it first, so it locks before any app launches and unlocks after every app closed; the waits have their own
  // timeout. The clipboard is taken before the foreground, and no test takes both fixtures, so no two workers wait on each other.
  // eslint-disable-next-line no-empty-pattern
  clipboard: [async ({}, use) => withClipboardLock((clipboard) => withForeground(() => use(clipboard))), { timeout: CLIPBOARD_LOCK_WAIT_MS + FOREGROUND_WAIT_MS + 30_000 }],
  // A test that needs its window to keep keyboard focus or the pointer's hover lists it first; a test that takes the clipboard
  // holds the foreground through it and never takes this too.
  // eslint-disable-next-line no-empty-pattern
  foreground: [async ({}, use) => withForeground(() => use()), { timeout: FOREGROUND_WAIT_MS + 30_000 }],
});

export { expect };

const NEW_CHAT_PREFIX = 'new:';

/** The panelId in a chat page URL (app://damocles/panel/<panelId>/index.html). */
export function panelIdOf(page: Page): string {
  const match = /\/panel\/([^/]+)\//.exec(page.url());
  if (!match) throw new Error(`not a panel page: ${page.url()}`);
  return match[1]!;
}

async function savedSessionId(page: Page): Promise<string | undefined> {
  return page.evaluate(() => (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId);
}

async function findChat(app: ElectronApplication, chatId: string): Promise<Page | undefined> {
  const pages = app.windows().filter((p) => !p.isClosed() && p.url().includes('/panel/'));
  if (chatId.startsWith(NEW_CHAT_PREFIX)) return pages.find((p) => p.url().includes(`/panel/${chatId.slice(NEW_CHAT_PREFIX.length)}/`));
  for (const page of pages) if ((await savedSessionId(page)) === chatId) return page;
  return undefined;
}

/**
 * The loaded chat main names `chatId`: `new:<panelId>` is the chat page of that panel, a session id the chat page whose
 * webview state holds it. Waits for the page to load when main has only just created its view.
 */
export async function chatById(app: ElectronApplication, chatId: string): Promise<Page> {
  let page: Page | undefined;
  await expect.poll(async () => (page = await findChat(app, chatId)), { timeout: 30_000 }).toBeDefined();
  return page!;
}

/** The selected chat's page; the selected chat's id is read again on every try, since a first file write changes it. */
export async function activeChat(app: ElectronApplication): Promise<Page> {
  let page: Page | undefined;
  await expect.poll(async () => {
    const chatId = (await shellState(app)).selected.chatId;
    page = chatId === undefined ? undefined : await findChat(app, chatId);
    return page;
  }, { timeout: 30_000 }).toBeDefined();
  return page!;
}

/** Resolves with the selected chat once it is a chat page other than `known`, as after New Chat. */
export async function nextChat(app: ElectronApplication, known: Page[]): Promise<Page> {
  const knownIds = new Set(known.filter((p) => p.url().includes('/panel/')).map(panelIdOf));
  let page: Page | undefined;
  await expect.poll(async () => {
    const chatId = (await shellState(app)).selected.chatId;
    const candidate = chatId === undefined ? undefined : await findChat(app, chatId);
    page = candidate && !knownIds.has(panelIdOf(candidate)) ? candidate : undefined;
    return page;
  }, { timeout: 30_000 }).toBeDefined();
  return page!;
}

/** The id main gives the loaded chat shown in `page`, found among the loaded chats of every project's list. */
export async function chatIdOf(app: ElectronApplication, page: Page): Promise<string> {
  const candidates = [`${NEW_CHAT_PREFIX}${panelIdOf(page)}`, await savedSessionId(page)];
  const state = await shellState(app);
  const shell = await shellPage(app);
  const keys = [...new Set([await selectedProjectKey(app), ...state.projects.map((project) => project.key)])];
  for (const key of keys) {
    const list = await shell.evaluate(async (projectKey) => window.damoclesShell!.listChats(projectKey, (await window.damoclesShell!.getState()).revision), key);
    const found = list?.chats.find((chat) => chat.loaded && candidates.includes(chat.id));
    if (found) return found.id;
  }
  throw new Error(`no loaded chat shows ${page.url()}`);
}

/** Selects the loaded chat shown in `page` as a click on its sidebar row does, and waits until it is selected. */
export async function selectChatPage(app: ElectronApplication, page: Page): Promise<void> {
  const chatId = await chatIdOf(app, page);
  const shell = await shellPage(app);
  expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), chatId)).toEqual({ ok: true });
  await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(chatId);
}

/**
 * The first chat page of a fresh launch, as soon as its window exists, before its webview boots: a test that must record
 * from the first host message takes it here, because activeChat waits for the shell's state.
 */
export async function firstChatPage(app: ElectronApplication): Promise<Page> {
  const isChat = (p: Page): boolean => p.url().includes('/panel/');
  return app.windows().find(isChat) ?? app.waitForEvent('window', { predicate: isChat });
}
