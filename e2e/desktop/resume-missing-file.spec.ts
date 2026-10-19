import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { recordedToasts, recordToasts } from './support/shell';
import { addProject, chatInput, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho } from './support/ui';

// The resume handler's notice and the reason core gives for a conversation whose file is gone (src/core).
const NOT_OPENED = 'This conversation could not be opened: its file was not found';

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

function sessionFiles(root: string, sessionId: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(`_${sessionId}.jsonl`))
    .map((entry) => path.join(root, entry));
}

/** The conversation the chat's webview shows, as it persists it for a restore. */
async function shownSessionId(tab: Page): Promise<string | undefined> {
  return tab.evaluate(() => (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId);
}

test('resuming a conversation whose file was removed keeps the conversation on screen, says why, and sends still reach it', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    await recordToasts(app);
    const tab = await openProject(app, home);

    await sendAndAwaitEcho(tab, 'the conversation that goes away');
    await expect.poll(() => shownSessionId(tab)).toBeDefined();
    const removed = (await shownSessionId(tab))!;
    // New chat in the same panel lets go of the first conversation, so nothing holds it when the resume asks for it.
    await postFromWebview(tab, { type: 'clearSession' });
    await expect(tab.getByText('Echo: the conversation that goes away', { exact: true })).toHaveCount(0);
    await sendAndAwaitEcho(tab, 'the conversation that stays');
    await expect.poll(async () => {
      const shown = await shownSessionId(tab);
      return shown !== undefined && shown !== removed;
    }).toBe(true);
    const kept = (await shownSessionId(tab))!;
    const [removedFile] = sessionFiles(home.agentDir, removed);
    expect(removedFile).toBeDefined();
    fs.rmSync(removedFile!);

    await recordHostMessages(tab);
    await postFromWebview(tab, { type: 'resumeSession', sessionId: removed });

    await expect.poll(async () => (await recordedToasts(app)).filter((toast) => toast.message === NOT_OPENED).map((toast) => toast.severity)).toEqual(['error']);
    await expect(tab.getByText('Echo: the conversation that stays', { exact: true })).toBeVisible();
    expect(await hostMessages(tab, 'resumeAccepted')).toEqual([]);
    expect((await hostMessages(tab, 'sessionStarted')).filter((m) => m['sessionId'] === removed)).toEqual([]);
    expect(await shownSessionId(tab)).toBe(kept);

    await sendAndAwaitEcho(tab, 'still in the conversation that stays');
    const [keptFile] = sessionFiles(home.agentDir, kept);
    expect(fs.readFileSync(keptFile!, 'utf8')).toContain('still in the conversation that stays');
    expect(sessionFiles(home.agentDir, removed)).toEqual([]);
  } finally {
    await stub.close();
  }
});
