import * as fs from 'node:fs';
import * as path from 'node:path';
import { chatTab, expect, nextTab, panelIdOf, tabById, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { shellPage, shellState } from './support/shell';
import { addProject, answerMessageBoxes, chatInput, hostMessages, postFromWebview, recordHostMessages, sendAndAwaitEcho } from './support/ui';

type RewindItem = { messageId: string; content: string };

// A catalog model whose thinking can be turned off, so the per-tab override shows in panelThinkingUpdate.
const OTHER_MODEL = 'claude-sonnet-5';

test('tabs: two projects, per-tab thinking, fork with replayed history, restart restores tabs, projects, conversation and selection, closing the last tab', async ({ home, launch }) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const beta = path.join(path.dirname(home.project), 'beta');
    fs.mkdirSync(beta, { recursive: true });

    let desktop = await launch();
    let app = desktop.app;
    const homeTab = await chatTab(app);
    await expect(chatInput(homeTab)).toBeVisible();

    const alphaOpened = nextTab(app, [homeTab]);
    await addProject(app, home.project, true);
    const alpha = await alphaOpened;
    await expect(chatInput(alpha)).toBeVisible();
    const betaOpened = nextTab(app, [homeTab, alpha]);
    await addProject(app, beta, true);
    const betaTab = await betaOpened;
    await expect(chatInput(betaTab)).toBeVisible();

    const alphaId = panelIdOf(alpha);
    const betaId = panelIdOf(betaTab);
    let state = await shellState(app);
    const tabOf = (id: string) => state.tabs.find((t) => t.id === id);
    expect(state.projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect(tabOf(alphaId)?.projectName).toBe('alpha');
    expect(tabOf(betaId)?.projectName).toBe('beta');
    expect(tabOf(alphaId)?.projectKey).not.toBe(tabOf(betaId)?.projectKey);

    // Per-tab model and thinking: changing them in the home tab leaves the beta tab on the stub model with nothing overridden.
    await recordHostMessages(homeTab);
    await recordHostMessages(betaTab);
    await postFromWebview(homeTab, { type: 'setActiveModel', model: OTHER_MODEL });
    await expect.poll(async () => (await hostMessages(homeTab, 'modelUpdate')).at(-1)?.['activeModel']).toBe(OTHER_MODEL);
    await postFromWebview(homeTab, { type: 'setPanelThinkingDisabled', disabled: true });
    await expect.poll(async () => (await hostMessages(homeTab, 'panelThinkingUpdate')).at(-1)?.['panel']).toMatchObject({ thinkingDisabled: true });
    expect(await hostMessages(betaTab, 'modelUpdate')).toEqual([]);
    expect(await hostMessages(betaTab, 'panelThinkingUpdate')).toEqual([]);
    await sendAndAwaitEcho(betaTab, 'beta still on the stub model');

    await sendAndAwaitEcho(alpha, 'alpha one');
    await sendAndAwaitEcho(alpha, 'alpha two');
    // The tab label is the conversation's title, which the session list carries once the first turn is stored.
    await expect.poll(async () => (await shellState(app)).tabs.find((t) => t.id === alphaId)?.title ?? '').not.toBe('');
    const alphaTitle = (await shellState(app)).tabs.find((t) => t.id === alphaId)!.title;

    // Fork at the second prompt: a second tab opens with the first exchange replayed and the prompt prefilled.
    await recordHostMessages(alpha);
    // A turn's checkpoint is recorded in the background after the turn settles, so ask until it is listed.
    await expect.poll(async () => {
      await postFromWebview(alpha, { type: 'requestRewindHistory' });
      const latest = (await hostMessages(alpha, 'rewindHistory')).at(-1)?.['prompts'] as RewindItem[] | undefined;
      return (latest ?? []).map((p) => p.content);
    }).toContain('alpha two');
    const prompts = (await hostMessages(alpha, 'rewindHistory')).at(-1)!['prompts'] as RewindItem[];
    const second = prompts.find((p) => p.content === 'alpha two');
    const forkOpened = nextTab(app, app.windows());
    await postFromWebview(alpha, { type: 'rewindToMessage', userMessageId: second!.messageId, option: 'fork-conversation', promptContent: 'alpha two' });
    const fork = await forkOpened;
    const forkId = panelIdOf(fork);
    await expect(fork.getByText('Echo: alpha one', { exact: true })).toBeVisible();
    await expect(chatInput(fork)).toHaveValue('alpha two');
    await expect(fork.getByText('Echo: alpha two', { exact: true })).toHaveCount(0);
    state = await shellState(app);
    expect(tabOf(forkId)?.projectName).toBe('alpha');

    // Select beta from the shell, then restart.
    const shell = await shellPage(app);
    await shell.evaluate((id) => window.damoclesShell!.selectTab(id), betaId);
    await expect.poll(async () => (await shellState(app)).selectedTabId).toBe(betaId);
    const order = (await shellState(app)).tabs.map((t) => t.id);
    expect(order).toEqual([panelIdOf(homeTab), alphaId, betaId, forkId]);

    await desktop.close();
    desktop = await launch();
    app = desktop.app;
    await answerMessageBoxes(app);
    // Every tab is listed with the saved one selected before any of them loads.
    await expect.poll(async () => (await shellState(app)).tabs.map((t) => t.id)).toEqual(order);
    state = await shellState(app);
    expect(state.selectedTabId).toBe(betaId);
    expect(state.projects.map((p) => p.name)).toEqual(['alpha', 'beta']);
    expect(tabOf(alphaId)?.projectName).toBe('alpha');
    expect(tabOf(betaId)?.projectName).toBe('beta');
    await expect.poll(async () => (await shellState(app)).tabs.find((t) => t.id === alphaId)?.title).toBe(alphaTitle);

    // A tab behind the selected one lays out only when first shown, so its conversation is read after selecting it.
    const restartedShell = await shellPage(app);
    const restoredAlpha = await tabById(app, alphaId);
    await restartedShell.evaluate((id) => window.damoclesShell!.selectTab(id), alphaId);
    await expect(restoredAlpha.getByText('Echo: alpha two', { exact: true })).toBeVisible();
    await tabById(app, forkId);

    // Closing every tab fires the core's all-panels-closed event, which desktop main logs.
    for (const id of order) await restartedShell.evaluate((tabId) => window.damoclesShell!.closeTab(tabId), id);
    await expect.poll(async () => (await shellState(app)).tabs).toEqual([]);
    await expect.poll(() => desktop.output()).toContain('[tabs] the last chat tab closed');
  } finally {
    await stub.close();
  }
});
