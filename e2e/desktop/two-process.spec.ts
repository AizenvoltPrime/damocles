import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { chatTab, expect, nextTab, test } from './support/fixtures';
import { hermeticEnv, seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub, STUB_MODEL_ID } from './support/openai-stub';
import { SecondProcess } from './support/second-process';
import { recordedToasts, recordToasts } from './support/shell';
import {
  addProject,
  chatInput,
  hostMessages,
  postFromWebview,
  recordHostMessages,
  selectSession,
  sessionRow,
} from './support/ui';

// Refusal text from src/core/chat-panel/session-ownership.ts.
const HELD_ELSEWHERE = 'This conversation is open in another Damocles window.';
// proper-lockfile stale threshold of the session lease (src/core/pi-session/session-store/session-lease.ts).
const LEASE_STALE_MS = 20_000;

async function openProjectTab(app: ElectronApplication, project: string): Promise<Page> {
  const homeTab = await chatTab(app);
  await expect(chatInput(homeTab)).toBeVisible();
  const opened = nextTab(app, [homeTab]);
  await addProject(app, project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

// The refusal is a non-modal notice, which desktop shows as a toast in the shell.
async function refusals(app: ElectronApplication): Promise<number> {
  return (await recordedToasts(app)).filter((toast) => toast.message === HELD_ELSEWHERE).length;
}

function leaseFile(home: HermeticHome, sessionId: string): string {
  return path.join(home.damoclesDir, 'locks', 'sessions', `${sessionId}.lock`);
}

test.describe('same folder in two processes', () => {
  test('lists the same sessions; a held conversation is refused, then taken after release and after the holder dies', async ({ home, launch }) => {
    test.setTimeout(180_000);
    const stub = await startOpenAIStub();
    seedStubModel(home, stub.baseUrl);
    const other = new SecondProcess(home.project, hermeticEnv(home), { 'damocles.model': STUB_MODEL_ID });
    try {
      await other.ready;
      await other.call({ cmd: 'openPanel' });
      const first = await other.chat('first conversation from the other process');
      expect(fs.existsSync(leaseFile(home, first))).toBe(true);

      const { app } = await launch();
      await recordToasts(app);
      const tab = await openProjectTab(app, home.project);

      // Listing: the other process's session appears on desktop.
      const row = await sessionRow(tab, first);
      await expect(row).toBeVisible();

      // Held: opening it is refused with the cross-window message, and nothing of it loads.
      await selectSession(tab, first);
      await expect.poll(() => refusals(app)).toBe(1);
      await expect(tab.getByText('Echo: first conversation from the other process')).toHaveCount(0);

      // Released: the other process starts a new conversation, unbinding the first.
      await other.call({ cmd: 'webviewMessage', message: { type: 'clearSession' } });
      await other.waitForPosted((m) => m.type === 'conversationCleared');
      await expect.poll(() => fs.existsSync(leaseFile(home, first))).toBe(false);
      await selectSession(tab, first);
      await expect(tab.getByText('Echo: first conversation from the other process', { exact: true })).toBeVisible();
      expect(await refusals(app)).toBe(1);

      // Holder dies: its second conversation's lease goes stale, and then desktop takes it.
      const second = await other.chat('second conversation from the other process');
      await expect(await sessionRow(tab, second)).toBeVisible();
      await selectSession(tab, second);
      await expect.poll(() => refusals(app)).toBe(2);
      await other.kill();
      const lock = leaseFile(home, second);
      await expect.poll(() => Date.now() - fs.statSync(lock).mtimeMs, { timeout: LEASE_STALE_MS + 20_000 }).toBeGreaterThan(LEASE_STALE_MS);
      await selectSession(tab, second);
      await expect(tab.getByText('Echo: second conversation from the other process', { exact: true })).toBeVisible();
      expect(await refusals(app)).toBe(2);
    } finally {
      await other.dispose();
      await stub.close();
    }
  });

  test('memory, usage index and compass open their shared stores while the other process holds them', async ({ home, launch }) => {
    test.setTimeout(180_000);
    const stub = await startOpenAIStub();
    seedStubModel(home, stub.baseUrl);
    fs.writeFileSync(path.join(home.project, 'index.ts'), 'export function shared(): number {\n  return 1;\n}\n');
    const settings = { 'damocles.model': STUB_MODEL_ID, 'damocles.compass.enabled': true };
    writeUserSettings(home, settings);
    const other = new SecondProcess(home.project, hermeticEnv(home), settings);
    try {
      await other.ready;
      await other.call({ cmd: 'openPanel' });
      // The other process opens and keeps open all three stores.
      await other.call({ cmd: 'webviewMessage', message: { type: 'createMemory', tier: 'global', content: 'written by the other process', requestId: 'other-1' } });
      await other.waitForPosted((m) => m.type === 'memoryCreated' && m['requestId'] === 'other-1');
      await other.chat('usage for the index');
      await other.call({ cmd: 'webviewMessage', message: usageQuery('other-usage') });
      const otherUsage = await other.waitForPosted((m) => m.type === 'usageStats' && m['requestId'] === 'other-usage' && m['final'] === true);
      expect(otherUsage['error']).toBeUndefined();
      await other.waitForPosted((m) => m.type === 'compassStatusUpdate' && (m['status'] as { state: string }).state === 'ready', 120_000);

      const { app } = await launch();
      const tab = await openProjectTab(app, home.project);
      await recordHostMessages(tab);

      await postFromWebview(tab, { type: 'createMemory', tier: 'global', content: 'written by desktop', requestId: 'desktop-1' });
      await expect.poll(async () => (await hostMessages(tab, 'memoryCreated')).some((m) => m['requestId'] === 'desktop-1')).toBe(true);
      await postFromWebview(tab, { type: 'requestMemories', tier: 'global' });
      await expect.poll(async () => {
        const updates = await hostMessages(tab, 'memoriesUpdate');
        return (updates.at(-1)?.['memories'] as { content: string }[] | undefined)?.map((m) => m.content).sort() ?? [];
      }).toEqual(['written by desktop', 'written by the other process']);

      await postFromWebview(tab, usageQuery('desktop-usage'));
      await expect.poll(async () => (await hostMessages(tab, 'usageStats')).find((m) => m['requestId'] === 'desktop-usage' && m['final'] === true) ?? null, { timeout: 60_000 }).not.toBeNull();
      const desktopUsage = (await hostMessages(tab, 'usageStats')).find((m) => m['requestId'] === 'desktop-usage' && m['final'] === true)!;
      expect(desktopUsage['error']).toBeUndefined();
      expect(desktopUsage['report']).not.toBeNull();

      // A rebuild writes the shared graph.db while the other process's worker has it open.
      await postFromWebview(tab, { type: 'requestCompassReindex' });
      await expect.poll(async () => (await hostMessages(tab, 'compassStatusUpdate')).map((m) => (m['status'] as { state: string }).state).at(-1), { timeout: 120_000 }).toBe('ready');
      const states = (await hostMessages(tab, 'compassStatusUpdate')).map((m) => (m['status'] as { state: string }).state);
      expect(states).not.toContain('error');
      expect(states).not.toContain('failed');

      // The other process still holds its connections and still reads what desktop wrote.
      await other.call({ cmd: 'webviewMessage', message: { type: 'requestMemories', tier: 'global' } });
      const before = other.posted.length;
      const otherList = await other.waitForPosted((m) => other.posted.indexOf(m) >= before - 1 && m.type === 'memoriesUpdate' && (m['memories'] as unknown[]).length === 2);
      expect((otherList['memories'] as { content: string }[]).map((m) => m.content).sort()).toEqual(['written by desktop', 'written by the other process']);
    } finally {
      await other.dispose();
      await stub.close();
    }
  });
});

function usageQuery(requestId: string): Record<string, unknown> {
  return {
    type: 'requestUsageStats',
    requestId,
    query: { startMs: 0, endMs: Date.now() + 86_400_000, previous: null, modelKeys: [], projectKeys: [], bucket: 'day', timeZone: 'UTC', scan: true },
  };
}
