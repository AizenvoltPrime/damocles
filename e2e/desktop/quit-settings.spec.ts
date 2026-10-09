import * as fs from 'node:fs';
import * as path from 'node:path';
import { mainLog, type DesktopApp } from './support/app';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { openSettingsModal } from './support/settings';
import { selectedProjectKey, shellState } from './support/shell';
import { listChats } from './support/shell-ui';
import { chatInput, sendAndAwaitEcho } from './support/ui';

// A quit takes about a second; the core's own dispose is bounded at 10 s.
const QUIT_BUDGET_MS = 15_000;

// A quit, and closing the window, which on Windows and Linux then quits, each with the Settings modal open.
const TEARDOWNS = [
  ['a quit', async (desktop: DesktopApp) => desktop.close()],
  ['closing the window', async (desktop: DesktopApp) => {
    const proc = desktop.app.process();
    await desktop.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((window) => window.isVisible())?.close());
    if (process.platform === 'darwin') await desktop.close();
    else await expect.poll(() => proc.exitCode !== null || proc.signalCode !== null, { timeout: QUIT_BUDGET_MS }).toBe(true);
  }],
] as const;

for (const [label, tearDown] of TEARDOWNS) {
  test(`${label} with the Settings modal open brings back the chat it was in, and no new one`, async ({ home, launch }) => {
    test.setTimeout(120_000);
    const stub = await startOpenAIStub();
    try {
      seedStubModel(home, stub.baseUrl);
      const first = await launch();
      await sendAndAwaitEcho(await activeChat(first.app), 'stay with me');
      const projectKey = await selectedProjectKey(first.app);
      await expect.poll(async () => (await shellState(first.app)).selected.chatId).not.toMatch(/^new:/);
      const chatId = (await shellState(first.app)).selected.chatId!;
      const panelsFile = path.join(home.userData, 'panels.json');
      const saved = (): { selected?: { sessionId?: string; panelId?: string }; chats: Array<{ panelId: string }> } => JSON.parse(fs.readFileSync(panelsFile, 'utf8'));
      await expect.poll(() => saved().selected?.sessionId).toBe(chatId);
      const before = saved();
      await openSettingsModal(first.app);

      await tearDown(first);
      expect(saved().selected).toEqual(before.selected);
      expect(saved().chats.map((chat) => chat.panelId)).toEqual(before.chats.map((chat) => chat.panelId));
      const log = mainLog(home);
      const shutdown = log.slice(log.lastIndexOf('[shutdown] quitting'));
      for (const failure of ['Settings failed', 'failed to load', 'Reading the page history failed']) expect(shutdown).not.toContain(failure);

      const second = await launch();
      await expect(chatInput(await activeChat(second.app))).toBeVisible();
      await expect.poll(async () => (await shellState(second.app)).selected.chatId).toBe(chatId);
      expect((await listChats(second.app, projectKey)).chats.map((chat) => chat.id)).toEqual([chatId]);
    } finally {
      await stub.close();
    }
  });
}

test('a placement the window reports as it closes leaves the saved layout as it was before the quit', async ({ home, launch }) => {
  const desktop = await launch();
  await expect(chatInput(await activeChat(desktop.app))).toBeVisible();
  const layoutFile = path.join(home.userData, 'window-layout.json');
  const savedWindow = (): unknown => (fs.existsSync(layoutFile) ? (JSON.parse(fs.readFileSync(layoutFile, 'utf8')) as { window?: unknown }).window : undefined);
  const placed = await desktop.app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible())!;
    window.setBounds({ x: 40, y: 40, width: 1100, height: 760 });
    window.emit('resized');
    // After the app's own close handler, on the close it lets through: as a window leaving full screen as it closes does.
    window.on('close', (event) => {
      if (event.defaultPrevented || window.isDestroyed()) return;
      window.setBounds({ x: 80, y: 80, width: 1000, height: 700 });
      window.emit('resized');
    });
    // What the window took: macOS keeps it inside the work area, and the app's minimum size applies everywhere.
    const { x, y, width, height } = window.getBounds();
    return { x, y, width, height };
  });
  await expect.poll(savedWindow).toMatchObject(placed);

  await desktop.close();
  expect(savedWindow()).toMatchObject(placed);
});
