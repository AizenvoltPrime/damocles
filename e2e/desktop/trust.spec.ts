import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { shellState } from './support/shell';
import { seedStubModel } from './support/hermetic';
import { chatRequests, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { addProject, answerMessageBoxes, chatInput, messageBoxes, postFromWebview, sendAndAwaitEcho, TRUST_PROMPT } from './support/ui';

// Project instructions (AGENTS.md) are project-scope input; the system prompt sent to the stub shows whether they loaded.
const MARKER = 'PROJECT-SCOPE-MARKER-7c1e';

/** Adds a project and returns the chat main selects in it. */
async function openProjectChat(app: ElectronApplication, dir: string, trust: boolean): Promise<Page> {
  await addProject(app, dir, trust);
  await expect.poll(async () => {
    const state = await shellState(app);
    return state.projects.find((p) => p.key === state.selected.projectKey)?.fsPath;
  }).toBe(dir);
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeVisible();
  return chat;
}

function requestFor(stub: OpenAIStub, prompt: string): string {
  const request = chatRequests(stub).find((r) => JSON.stringify(r.body).includes(`"text":"${prompt}"`));
  if (!request) throw new Error(`no chat request carried "${prompt}"`);
  return JSON.stringify(request.body);
}

test('trust per folder: untrusted loads no project input, granting applies live, survives restart, subfolders are not trusted', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    fs.writeFileSync(path.join(home.project, 'AGENTS.md'), `# Project rules\n\n${MARKER}\n`);
    const sub = path.join(home.project, 'packages', 'sub');
    fs.mkdirSync(sub, { recursive: true });
    const trustFile = path.join(home.userData, 'trusted-folders.json');
    const trustedFolders = (): string[] => (fs.existsSync(trustFile) ? (JSON.parse(fs.readFileSync(trustFile, 'utf8')) as { folders: string[] }).folders : []);

    let desktop = await launch();
    await expect(chatInput(await activeChat(desktop.app))).toBeVisible();

    const alpha = await openProjectChat(desktop.app, home.project, false);
    expect((await messageBoxes(desktop.app)).filter((b) => b.message.startsWith(TRUST_PROMPT))).toHaveLength(1);
    expect(trustedFolders()).toEqual([]);

    await sendAndAwaitEcho(alpha, 'untrusted turn');
    expect(requestFor(stub, 'untrusted turn')).not.toContain(MARKER);

    // The webview's Trust control posts this message; the host answers with its trust prompt.
    await answerMessageBoxes(desktop.app, { [TRUST_PROMPT]: 'Trust Folder' });
    await postFromWebview(alpha, { type: 'setProjectTrusted' });
    await expect.poll(trustedFolders).toEqual([home.project]);
    // The grant reloads the folder asynchronously; each probe is a full turn, so polling never races a send.
    let probe = 0;
    await expect.poll(async () => {
      const prompt = `trusted turn ${++probe}`;
      await sendAndAwaitEcho(alpha, prompt);
      return requestFor(stub, prompt).includes(MARKER);
    }, { timeout: 60_000, intervals: [0] }).toBe(true);

    const alphaChatId = (await shellState(desktop.app)).selected.chatId;
    await desktop.close();
    desktop = await launch();
    await answerMessageBoxes(desktop.app);
    // The selected chat comes back selected, resumed from its session file.
    await expect.poll(async () => (await shellState(desktop.app)).selected.chatId).toBe(alphaChatId);
    const restored = await activeChat(desktop.app);
    await expect(chatInput(restored)).toBeVisible();
    await sendAndAwaitEcho(restored, 'after restart');
    expect(requestFor(stub, 'after restart')).toContain(MARKER);
    expect((await messageBoxes(desktop.app)).filter((b) => b.message.startsWith(TRUST_PROMPT))).toHaveLength(0);

    const subTab = await openProjectChat(desktop.app, sub, false);
    const prompts = (await messageBoxes(desktop.app)).filter((b) => b.message.startsWith(TRUST_PROMPT));
    expect(prompts.map((b) => b.message)).toEqual([`${TRUST_PROMPT} ${sub}?`]);
    await sendAndAwaitEcho(subTab, 'subfolder turn');
    // A trusted ancestor's AGENTS.md reaches a trusted child through pi's ancestor walk, so its absence proves the child is untrusted.
    expect(requestFor(stub, 'subfolder turn')).not.toContain(MARKER);
    expect(trustedFolders()).toEqual([home.project]);
  } finally {
    await stub.close();
  }
});
