import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { chatTab, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { chatInput, hostMessages, recordHostMessages, sendAndAwaitEcho } from './support/ui';

// pi writes a conversation's file with its first reply, so a new tab's conversation has an id and no file until then.

const MISSING_FILE = /could not be found|δεν βρέθηκε/;
const GREEK_PLACEHOLDER = 'Ρωτήστε τον Damocles οτιδήποτε...';

async function savedSessionId(tab: Page): Promise<string | undefined> {
  return tab.evaluate(() => (window.damoclesBridge!.getState() as { sessionId?: string } | undefined)?.sessionId);
}

/** The conversation the tab shows, from the host's last announcement or, failing that, the persisted id. */
async function liveSessionId(tab: Page): Promise<string | undefined> {
  const announced = (await hostMessages(tab, 'sessionStarted')).at(-1)?.['sessionId'];
  return typeof announced === 'string' && announced !== '' ? announced : savedSessionId(tab);
}

/** Resolves once the tab's session has started, which is when the host names its conversation. */
async function startedSessionId(tab: Page): Promise<string> {
  await expect.poll(() => liveSessionId(tab), { timeout: 60_000 }).toBeTruthy();
  return (await liveSessionId(tab))!;
}

function sessionFiles(root: string, sessionId: string): string[] {
  return (fs.readdirSync(root, { recursive: true }) as string[])
    .filter((entry) => entry.endsWith(`_${sessionId}.jsonl`))
    .map((entry) => path.join(root, entry));
}

test('reloading a tab that holds a new, empty conversation reopens that conversation with no error', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await chatTab(app);
    await recordHostMessages(tab);
    const unwritten = await startedSessionId(tab);
    expect(sessionFiles(home.agentDir, unwritten)).toEqual([]);

    await tab.reload();
    await expect(chatInput(tab)).toBeVisible();
    await sendAndAwaitEcho(tab, 'after the reload');

    await expect(tab.getByText(MISSING_FILE)).toHaveCount(0);
    // The reply wrote the same conversation the tab held before the reload, and made it the tab's restore target.
    await expect.poll(() => savedSessionId(tab)).toBe(unwritten);
    expect(sessionFiles(home.agentDir, unwritten)).toHaveLength(1);
  } finally {
    await stub.close();
  }
});

test('restarting with a tab whose conversation was never written opens a fresh conversation with no error', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let desktop = await launch();
    let tab = await chatTab(desktop.app);
    await recordHostMessages(tab);
    const unwritten = await startedSessionId(tab);
    await desktop.close();

    desktop = await launch();
    tab = await chatTab(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    await sendAndAwaitEcho(tab, 'after the restart');

    await expect(tab.getByText(MISSING_FILE)).toHaveCount(0);
    await expect.poll(() => savedSessionId(tab)).toBeTruthy();
    expect(await savedSessionId(tab)).not.toBe(unwritten);
  } finally {
    await stub.close();
  }
});

test('restoring a tab whose written conversation was deleted meanwhile says so in the UI language', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let desktop = await launch({ args: ['--lang=el-GR'] });
    let tab = await chatTab(desktop.app);
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
    tab = await chatTab(desktop.app);
    await expect(tab.getByText('Το αρχείο αυτής της συνομιλίας δεν βρέθηκε. Μπορεί να έχει διαγραφεί.')).toBeVisible();
  } finally {
    await stub.close();
  }
});
