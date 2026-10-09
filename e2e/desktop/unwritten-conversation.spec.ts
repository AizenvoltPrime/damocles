import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { PANEL_CHANNELS } from '../../src/desktop/preload/panel-channels';
import type { DesktopApp, LaunchOptions } from './support/app';
import { activeChat, expect, firstChatPage, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { chatInput, sendAndAwaitEcho } from './support/ui';

// pi writes a conversation's file when it commits the first prompt, so a new chat's conversation has an id and no file until then.

const MISSING_FILE = /could not be found|δεν βρέθηκε/;
const GREEK_PLACEHOLDER = 'Ρωτήστε τον Damocles οτιδήποτε…';

type SessionStarts = typeof globalThis & {
  __damoclesE2e?: { launchRestore?: { readonly reached: boolean; release(): void } };
  __e2eSessionStarts?: Array<{ url: string; sessionId: string }>;
};

async function savedSessionId(tab: Page): Promise<string | undefined> {
  return tab.evaluate(() => (window.damoclesBridge!.getState() as { sessionId?: string } | undefined)?.sessionId);
}

/**
 * Launches with the first chat's core setup held until main records every sessionStarted it sends: main names an unwritten
 * conversation only in that message, and a listener added in the page can come too late, since a busy main thread delays
 * Playwright's calls into a page.
 */
async function launchRecordingSessionStarts(launch: (options?: LaunchOptions) => Promise<DesktopApp>): Promise<DesktopApp> {
  const desktop = await launch({ env: { DAMOCLES_E2E_HOOKS: '1', DAMOCLES_E2E_HOLD_CHAT_RESTORE: '1' } });
  const { app } = desktop;
  await expect.poll(() => app.evaluate(() => (globalThis as SessionStarts).__damoclesE2e?.launchRestore?.reached ?? false)).toBe(true);
  await app.evaluate(({ app: electronApp, webContents }, channel) => {
    const g = globalThis as SessionStarts;
    const starts: Array<{ url: string; sessionId: string }> = [];
    g.__e2eSessionStarts = starts;
    const wrap = (contents: Electron.WebContents): void => {
      const send = contents.send.bind(contents);
      contents.send = (sent: string, ...args: unknown[]): void => {
        const message = args[0] as { type?: unknown; sessionId?: unknown } | undefined;
        if (sent === channel && message?.type === 'sessionStarted' && typeof message.sessionId === 'string' && message.sessionId !== '') {
          starts.push({ url: contents.getURL(), sessionId: message.sessionId });
        }
        send(sent, ...args);
      };
    };
    for (const contents of webContents.getAllWebContents()) wrap(contents);
    electronApp.on('web-contents-created', (_event, contents) => wrap(contents));
    g.__damoclesE2e!.launchRestore!.release();
  }, PANEL_CHANNELS.message);
  return desktop;
}

/** The conversation main last named to the chat page, once the chat's session has started. */
async function startedSessionId(app: ElectronApplication, tab: Page): Promise<string> {
  const named = (): Promise<string | undefined> => app.evaluate((_electron, url) => (globalThis as SessionStarts).__e2eSessionStarts?.filter((start) => start.url === url).at(-1)?.sessionId, tab.url());
  await expect.poll(named, { timeout: 60_000 }).toBeTruthy();
  return (await named())!;
}

function sessionFiles(root: string, sessionId: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(`_${sessionId}.jsonl`))
    .map((entry) => path.join(root, entry));
}

test('reloading a chat that holds a new, empty conversation reopens that conversation with no error', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launchRecordingSessionStarts(launch);
    const tab = await firstChatPage(app);
    const unwritten = await startedSessionId(app, tab);
    expect(sessionFiles(home.agentDir, unwritten)).toEqual([]);

    await tab.reload();
    await expect(chatInput(tab)).toBeVisible();
    await sendAndAwaitEcho(tab, 'after the reload');

    await expect(tab.getByText(MISSING_FILE)).toHaveCount(0);
    // The prompt wrote the same conversation the chat held before the reload, and made it the chat's restore target.
    await expect.poll(() => savedSessionId(tab)).toBe(unwritten);
    expect(sessionFiles(home.agentDir, unwritten)).toHaveLength(1);
  } finally {
    await stub.close();
  }
});

test('the first prompt writes the conversation and makes it the restore target before any reply arrives', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    seedStubModel(home, stub.baseUrl);
    stub.replies.push({ chunks: ['Held reply', ' finished.'], holdAfterFirst: held });
    const { app } = await launchRecordingSessionStarts(launch);
    const tab = await firstChatPage(app);
    const sessionId = await startedSessionId(app, tab);
    await chatInput(tab).fill('written before the reply');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Held reply', { exact: false })).toBeVisible();

    const files = sessionFiles(home.agentDir, sessionId);
    expect(files).toHaveLength(1);
    expect(fs.readFileSync(files[0]!, 'utf8')).toContain('written before the reply');
    await expect.poll(() => savedSessionId(tab)).toBe(sessionId);
    release();
    await expect(tab.getByText('Held reply finished.')).toBeVisible();
  } finally {
    release();
    await stub.close();
  }
});

test('restarting with a chat whose conversation was never written opens a fresh conversation with no error', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let desktop = await launchRecordingSessionStarts(launch);
    let tab = await firstChatPage(desktop.app);
    const unwritten = await startedSessionId(desktop.app, tab);
    await desktop.close();

    desktop = await launch();
    tab = await activeChat(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    await sendAndAwaitEcho(tab, 'after the restart');

    await expect(tab.getByText(MISSING_FILE)).toHaveCount(0);
    await expect.poll(() => savedSessionId(tab)).toBeTruthy();
    expect(await savedSessionId(tab)).not.toBe(unwritten);
  } finally {
    await stub.close();
  }
});

test('restoring a chat whose written conversation was deleted meanwhile says so in the UI language', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let desktop = await launch({ args: ['--lang=el-GR'] });
    let tab = await activeChat(desktop.app);
    const input = tab.getByPlaceholder(GREEK_PLACEHOLDER);
    await input.fill('soon deleted');
    await input.press('Enter');
    await tab.getByText('Echo: soon deleted', { exact: true }).waitFor();
    await expect.poll(() => savedSessionId(tab)).toBeTruthy();
    const written = (await savedSessionId(tab))!;
    await desktop.close();

    const files = sessionFiles(home.agentDir, written);
    expect(files).toHaveLength(1);
    fs.rmSync(files[0]!);

    desktop = await launch({ args: ['--lang=el-GR'] });
    tab = await activeChat(desktop.app);
    await expect(tab.getByText('Το αρχείο αυτής της συνομιλίας δεν βρέθηκε. Μπορεί να έχει διαγραφεί.')).toBeVisible();
  } finally {
    await stub.close();
  }
});
