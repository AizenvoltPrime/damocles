import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { mainLog } from './support/app';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { shellState } from './support/shell';
import { listChats, readyShell } from './support/shell-ui';
import { addProject, chatInput, sendAndAwaitEcho } from './support/ui';

// AD8 keeps the selected chat and three idle ones, so four stored chats are all still loaded at quit.
const SAVED_CHATS = 4;

function savedSessionIds(home: HermeticHome): string[] {
  const file = path.join(home.userData, 'panels.json');
  if (!fs.existsSync(file)) return [];
  const { chats } = JSON.parse(fs.readFileSync(file, 'utf8')) as { chats: { state: { sessionId?: string } | null }[] };
  return chats.flatMap((chat) => (chat.state?.sessionId !== undefined ? [chat.state.sessionId] : [])).sort();
}

// A page that closes between listing and reading it is no chat.
async function chatPage(app: ElectronApplication, sessionId: string): Promise<Page | undefined> {
  for (const page of app.windows().filter((p) => !p.isClosed() && p.url().includes('/panel/'))) {
    const saved = await page.evaluate(() => (window.damoclesBridge?.getState() as { sessionId?: string } | null | undefined)?.sessionId).catch(() => undefined);
    if (saved === sessionId) return page;
  }
  return undefined;
}

async function replayed(page: Page | undefined, text: string): Promise<boolean> {
  if (!page) return false;
  return (await page.getByText(text, { exact: true }).count().catch(() => 0)) > 0;
}

test('AD8: a relaunch keeps every saved idle chat loaded and saved, and lists each restoring chat under its session, never as a new chat', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let desktop = await launch();
    let app = desktop.app;
    await expect(chatInput(await activeChat(app))).toBeVisible();
    // Adding the project selects a new chat in it, which takes the first prompt.
    await addProject(app, home.project, true);
    await expect.poll(async () => (await shellState(app)).projects.some((p) => p.fsPath === home.project)).toBe(true);
    const shell = await readyShell(app);
    const projectKey = (await shellState(app)).projects.find((p) => p.fsPath === home.project)!.key;

    const ids: string[] = [];
    for (let i = 1; i <= SAVED_CHATS; i++) {
      if (i > 1) {
        const before = (await shellState(app)).selected.chatId;
        await shell.getByTestId('new-chat').click();
        await expect.poll(async () => {
          const id = (await shellState(app)).selected.chatId;
          return id !== before && id?.startsWith('new:');
        }).toBe(true);
      }
      await expect.poll(async () => (await shellState(app)).selected.chatId?.startsWith('new:')).toBe(true);
      const page = await activeChat(app);
      await expect(chatInput(page)).toBeVisible();
      await sendAndAwaitEcho(page, `saved ${i}`);
      await expect.poll(async () => (await shellState(app)).selected.chatId?.startsWith('new:')).toBe(false);
      ids.push((await shellState(app)).selected.chatId!);
    }
    const sorted = [...ids].sort();
    await expect.poll(async () => (await listChats(app, projectKey)).chats.filter((chat) => chat.loaded).map((chat) => chat.id).sort()).toEqual(sorted);
    await expect.poll(() => savedSessionIds(home)).toEqual(sorted);

    await desktop.close();
    expect(savedSessionIds(home)).toEqual(sorted);
    const logBefore = mainLog(home).length;

    desktop = await launch();
    app = desktop.app;
    // Sampled from the first moment the shell answers until every chat has replayed its conversation or one was unloaded.
    const phantoms = new Set<string>();
    const sample = async (): Promise<void> => {
      const [list, state] = await Promise.all([listChats(app, projectKey), shellState(app)]);
      for (const chat of list.chats) if (chat.id.startsWith('new:')) phantoms.add(`listed ${chat.id}`);
      if (state.selected.chatId?.startsWith('new:')) phantoms.add(`selected ${state.selected.chatId}`);
    };
    const unloaded = (): boolean => mainLog(home).slice(logBefore).includes('[chats] unloading chat');
    await expect.poll(async () => {
      await sample();
      const restored = await Promise.all(ids.map(async (id, i) => replayed(await chatPage(app, id), `Echo: saved ${i + 1}`)));
      return restored.every(Boolean) || unloaded();
    }, { timeout: 90_000 }).toBe(true);
    await sample();

    expect.soft(mainLog(home).slice(logBefore), 'no saved chat is unloaded at launch').not.toContain('[chats] unloading chat');
    expect.soft((await listChats(app, projectKey)).chats.filter((chat) => chat.loaded).map((chat) => chat.id).sort(), 'every saved chat is still loaded').toEqual(sorted);
    expect.soft(savedSessionIds(home), 'panels.json still holds every saved chat').toEqual(sorted);
    expect.soft([...phantoms], 'no restoring chat shows as a new chat').toEqual([]);
    expect((await shellState(app)).selected).toEqual({ projectKey, chatId: ids.at(-1) });
  } finally {
    await stub.close();
  }
});
