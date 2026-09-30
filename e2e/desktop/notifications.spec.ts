import * as fs from 'node:fs';
import * as path from 'node:path';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { answerToast, dismissedToasts, osNotifications, recordedToasts, recordOsNotifications, recordToasts, shellState } from './support/shell';
import { addProject, answerMessageBoxes, chatInput, messageBoxes, postFromWebview, sendAndAwaitEcho } from './support/ui';

// Strings from src/core/chat-panel/message-router/handlers/workspace-handlers.ts and panel-manager.ts.
const NO_SESSION = 'No active session to view';
const SWITCH_PROMPT = 'Switch this panel to beta?';
// TOAST_TIMEOUT_MS.info in src/desktop/main/platform/notification-service.ts.
const INFO_TIMEOUT_MS = 8_000;

test('notices are shell toasts that resolve, time out in main and raise an OS notification when unfocused; modal prompts stay native and modal', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const homeTab = await chatTab(app);
    await expect(chatInput(homeTab)).toBeVisible();
    await recordToasts(app);
    await recordOsNotifications(app);

    // A plain notice from a real core path: the webview asks for the session log before any conversation exists.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.focus());
    const focused = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.isFocused());
    await postFromWebview(homeTab, { type: 'openSessionLog' });
    await expect.poll(async () => (await recordedToasts(app)).map((t) => t.message)).toEqual([NO_SESSION]);
    const [first] = await recordedToasts(app);
    expect(first).toMatchObject({ severity: 'info', actions: [] });
    if (focused) expect(await osNotifications(app)).toEqual([]);
    await answerToast(app, first!.id);

    // Unfocused: the same notice also raises an OS notification, and main times the toast out.
    // The OS decides focus, and a test runner's window may never hold it, so the window reports itself unfocused.
    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0]!;
      win.isFocused = () => false;
    });
    await postFromWebview(homeTab, { type: 'openSessionLog' });
    await expect.poll(async () => (await recordedToasts(app)).length).toBe(2);
    await expect.poll(() => osNotifications(app)).toContain(NO_SESSION);
    const second = (await recordedToasts(app))[1]!;
    await expect.poll(() => dismissedToasts(app), { timeout: INFO_TIMEOUT_MS + 10_000 }).toContain(second.id);
    expect(await dismissedToasts(app)).not.toContain(first!.id);
    await app.evaluate(({ BrowserWindow }) => {
      delete (BrowserWindow.getAllWindows()[0] as { isFocused?: unknown }).isFocused;
    });

    // A modal prompt stays a native box parented to the window: switching a tab with a conversation to another project.
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });
    const alphaOpened = nextTab(app, app.windows());
    await addProject(app, home.project, true);
    const alpha = await alphaOpened;
    await expect(chatInput(alpha)).toBeVisible();
    const betaOpened = nextTab(app, app.windows());
    await addProject(app, beta, true);
    await expect(chatInput(await betaOpened)).toBeVisible();
    await sendAndAwaitEcho(alpha, 'keep this conversation');
    const betaKey = (await shellState(app)).projects.find((p) => p.name === 'beta')!.key;
    await answerMessageBoxes(app);
    await postFromWebview(alpha, { type: 'setPanelWorkspaceFolder', folderKey: betaKey });
    await expect.poll(async () => (await messageBoxes(app)).filter((b) => b.message.startsWith(SWITCH_PROMPT))).toEqual([
      expect.objectContaining({ parented: true, buttons: ['Start new conversation', 'Cancel'] }),
    ]);
    expect((await recordedToasts(app)).some((t) => t.message.startsWith(SWITCH_PROMPT))).toBe(false);
    // Cancel keeps the conversation where it was.
    await expect(alpha.getByText('Echo: keep this conversation', { exact: true })).toBeVisible();
  } finally {
    await stub.close();
  }
});
