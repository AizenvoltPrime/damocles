import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { hermeticEnv, seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub, STUB_MODEL_ID } from './support/openai-stub';
import { SecondProcess } from './support/second-process';
import { answerToast, recordedToasts, recordToasts, shellState, type RecordedNotice } from './support/shell';
import { chatRow, clickChat, listChats, readyShell } from './support/shell-ui';
import {
  addProject,
  chatInput,
  hostMessages,
  postFromWebview,
  recordHostMessages,
} from './support/ui';

// Refusal text and action from src/core/chat-panel/session-ownership.ts, offered while a live holder can be asked to let go.
const HELD_ELSEWHERE = 'This conversation is open in another Damocles window. Opening it here closes it there and stops any turn running in it.';
const OPEN_HERE = 'Open here';
// proper-lockfile stale threshold of the session lease (src/core/pi-session/session-store/session-lease.ts).
const LEASE_STALE_MS = 20_000;

async function openProjectChat(app: ElectronApplication, project: string): Promise<Page> {
  const homeTab = await activeChat(app);
  await expect(chatInput(homeTab)).toBeVisible();
  const opened = nextChat(app, [homeTab]);
  await addProject(app, project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

// The refusal is a non-modal notice, which desktop shows as a toast in the popup window.
async function refusalToasts(app: ElectronApplication): Promise<RecordedNotice[]> {
  return (await recordedToasts(app)).filter((toast) => toast.message === HELD_ELSEWHERE);
}

async function refusals(app: ElectronApplication): Promise<number> {
  const toasts = await refusalToasts(app);
  for (const toast of toasts) expect(toast.actions).toEqual([OPEN_HERE]);
  return toasts.length;
}

function leaseFile(home: HermeticHome, sessionId: string): string {
  return path.join(home.damoclesDir, 'locks', 'sessions', `${sessionId}.lock`);
}

test.describe('same folder in two processes', () => {
  test('the sidebar lists the same sessions; a held conversation is refused, then taken after release and after the holder dies', async ({ home, launch }) => {
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
      await openProjectChat(app, home.project);
      const shell = await readyShell(app);
      const projectKey = (await shellState(app)).selected.projectKey;
      const listed = async (): Promise<string[]> => (await listChats(app, projectKey)).chats.map((chat) => chat.id);

      // Listing: the other process's session appears in the Chats list.
      await expect.poll(listed).toContain(first);

      // Held: selecting it is refused with the cross-window message, and nothing of it loads.
      await clickChat(shell, first);
      await expect.poll(() => refusals(app)).toBe(1);
      await expect(chatRow(shell, first)).toHaveAttribute('aria-selected', 'false');

      // Released: the other process starts a new conversation, unbinding the first.
      await other.call({ cmd: 'webviewMessage', message: { type: 'clearSession' } });
      await other.waitForPosted((m) => m.type === 'conversationCleared');
      await expect.poll(() => fs.existsSync(leaseFile(home, first))).toBe(false);
      await clickChat(shell, first);
      await expect(chatRow(shell, first)).toHaveAttribute('aria-selected', 'true');
      await expect((await activeChat(app)).getByText('Echo: first conversation from the other process', { exact: true })).toBeVisible();
      expect(await refusals(app)).toBe(1);

      // Holder dies: its second conversation's lease goes stale, and then desktop takes it.
      const second = await other.chat('second conversation from the other process');
      await expect.poll(listed).toContain(second);
      await clickChat(shell, second);
      await expect.poll(() => refusals(app)).toBe(2);
      await other.kill();
      const lock = leaseFile(home, second);
      await expect.poll(() => Date.now() - fs.statSync(lock).mtimeMs, { timeout: LEASE_STALE_MS + 20_000 }).toBeGreaterThan(LEASE_STALE_MS);
      await clickChat(shell, second);
      await expect(chatRow(shell, second)).toHaveAttribute('aria-selected', 'true');
      await expect((await activeChat(app)).getByText('Echo: second conversation from the other process', { exact: true })).toBeVisible();
      expect(await refusals(app)).toBe(2);
    } finally {
      await other.dispose();
      await stub.close();
    }
  });

  test('a chat the other process holds is refused from the sidebar with a toast, and the selection does not move until Open here takes it over', async ({ home, launch }) => {
    test.setTimeout(180_000);
    const stub = await startOpenAIStub();
    seedStubModel(home, stub.baseUrl);
    const other = new SecondProcess(home.project, hermeticEnv(home), { 'damocles.model': STUB_MODEL_ID });
    try {
      await other.ready;
      await other.call({ cmd: 'openPanel' });
      const held = await other.chat('held by the other process');

      const { app } = await launch();
      await recordToasts(app);
      await openProjectChat(app, home.project);
      const before = await shellState(app);
      const shell = await readyShell(app);
      await expect.poll(async () => (await listChats(app, before.selected.projectKey)).chats.find((chat) => chat.id === held)).toMatchObject({ loaded: false });

      await clickChat(shell, held);
      await expect.poll(() => refusals(app)).toBe(1);
      expect((await shellState(app)).selected).toEqual(before.selected);
      await expect(chatRow(shell, held)).toHaveAttribute('aria-selected', 'false');
      expect((await listChats(app, before.selected.projectKey)).chats.find((chat) => chat.id === held)?.loaded).toBe(false);
      expect(await shell.evaluate((id) => window.damoclesShell!.selectChat(id), held)).toEqual({ ok: false, reason: 'leased' });
      await expect.poll(() => refusals(app)).toBe(2);
      expect((await shellState(app)).selected).toEqual(before.selected);

      // Open here asks the holder to let go, then opens the conversation in this window.
      await answerToast(app, (await refusalToasts(app)).at(-1)!.id, OPEN_HERE);
      await expect(chatRow(shell, held)).toHaveAttribute('aria-selected', 'true');
      await expect((await activeChat(app)).getByText('Echo: held by the other process', { exact: true })).toBeVisible();
      expect(fs.existsSync(leaseFile(home, held))).toBe(true);
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
      const tab = await openProjectChat(app, home.project);
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
