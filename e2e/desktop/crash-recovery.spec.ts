import type { ElectronApplication, Page } from '@playwright/test';
import { logBeforeQuit } from './support/app';
import { activeChat, expect, nextChat, panelIdOf, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { answerToast, recordedToasts, recordToasts } from './support/shell';
import { addProject, chatInput, sendAndAwaitEcho } from './support/ui';

test('a killed chat renderer is recreated with its state', async ({ launch, home }, testInfo) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const desktop = await launch();
    const tab = await activeChat(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    const panelId = panelIdOf(tab);
    await sendAndAwaitEcho(tab, 'remember this conversation');
    // Playwright's trace screencast on a page whose renderer crashes makes the driver close the app, so the trace ends here.
    await desktop.stopTracing(testInfo.outputPath('trace-before-crash.zip'));

    const pidBefore = await desktop.app.evaluate(({ webContents }, id) => {
      const w = webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`));
      if (!w) throw new Error('chat webContents not found');
      const pid = w.getOSProcessId();
      w.forcefullyCrashRenderer();
      return pid;
    }, panelId);

    await expect.poll(() => desktop.output()).toContain(`[views] panel ${panelId} renderer gone`);
    // Same webContents, new renderer process, same page URL.
    await expect.poll(() => desktop.app.evaluate(({ webContents }, id) => {
      const w = webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`));
      return w && !w.isCrashed() && !w.isLoading() ? w.getOSProcessId() : 0;
    }, panelId)).not.toBe(0);
    const pidAfter = await desktop.app.evaluate(({ webContents }, id) => webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`))!.getOSProcessId(), panelId);
    expect(pidAfter).not.toBe(pidBefore);

    // Playwright keeps the crashed Page object dead, so the recreated renderer is read through its webContents.
    const renderedText = (): Promise<string> =>
      desktop.app.evaluate(({ webContents }, id) => {
        const w = webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`));
        return w ? (w.executeJavaScript('document.body.innerText') as Promise<string>) : Promise.resolve('');
      }, panelId);
    await expect.poll(renderedText).toContain('Echo: remember this conversation');
    await desktop.close();
    expect(logBeforeQuit(home)).not.toMatch(/\[views\] rejected/);
  } finally {
    await stub.close();
  }
});

// Text of the crash notice in src/desktop/main/index.ts.
const GAVE_UP = 'A chat stopped working because its page kept crashing.';

test('a chat whose page keeps crashing is left dead with a Reload Chat toast, which loads it again', async ({ launch }, testInfo) => {
  const desktop = await launch();
  const { app } = desktop;
  const tab = await activeChat(app);
  await expect(chatInput(tab)).toBeVisible();
  const panelId = panelIdOf(tab);
  await recordToasts(app);
  await desktop.stopTracing(testInfo.outputPath('trace-before-crash.zip'));

  const loadedRenderer = (): Promise<number> => app.evaluate(({ webContents }, id) => {
    const w = webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`));
    return w && !w.isCrashed() && !w.isLoading() ? w.getOSProcessId() : 0;
  }, panelId);
  const crash = (): Promise<void> => app.evaluate(({ webContents }, id) => {
    webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`))!.forcefullyCrashRenderer();
  }, panelId);

  // Three crashes within a minute are reloaded; the fourth leaves the page dead.
  for (let i = 0; i < 3; i++) {
    await expect.poll(loadedRenderer).not.toBe(0);
    await crash();
    await expect.poll(() => desktop.output().split(`[views] panel ${panelId} renderer gone`).length - 1).toBe(i + 1);
  }
  await expect.poll(loadedRenderer).not.toBe(0);
  await crash();
  await expect.poll(async () => (await recordedToasts(app)).find((t) => t.message === GAVE_UP)?.actions).toEqual(['Reload Chat']);
  expect(await loadedRenderer()).toBe(0);

  await answerToast(app, (await recordedToasts(app)).find((t) => t.message === GAVE_UP)!.id, 'Reload Chat');
  await expect.poll(loadedRenderer).not.toBe(0);
});

/** The chat page's webContents, which a crash keeps under the same URL; Playwright's Page for it stays dead. */
function chatPageOf(app: ElectronApplication, panelId: string) {
  const evaluate = <T>(script: string): Promise<T> => app.evaluate(({ webContents }, [id, code]) => {
    const w = webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`));
    return w && !w.isCrashed() && !w.isLoading() ? (w.executeJavaScript(code) as Promise<T>) : Promise.resolve(undefined as T);
  }, [panelId, script] as const);
  return {
    crash: (): Promise<void> => app.evaluate(({ webContents }, id) => {
      webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`))!.forcefullyCrashRenderer();
    }, panelId),
    text: async (): Promise<string> => (await evaluate<string | undefined>('document.body.innerText')) ?? '',
    sendButton: async (): Promise<string | null> => (await evaluate<string | null | undefined>('document.querySelector(\'[data-testid="composer-send"]\')?.getAttribute("aria-label") ?? null')) ?? null,
    evaluate,
  };
}

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

test('a chat page that crashes mid-turn comes back showing the running turn, and its reply lands once', async ({ launch, home }, testInfo) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    let release!: () => void;
    stub.replies.push({ chunks: ['Streamed before the crash', ' and finished after it.'], holdAfterFirst: new Promise<void>((resolve) => (release = resolve)) });
    const desktop = await launch();
    const tab = await activeChat(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    const panelId = panelIdOf(tab);
    await chatInput(tab).fill('Reply in two parts');
    await chatInput(tab).press('Enter');
    await expect(tab.getByText('Streamed before the crash', { exact: false })).toBeVisible();
    await desktop.stopTracing(testInfo.outputPath('trace-before-crash.zip'));

    const page = chatPageOf(desktop.app, panelId);
    await page.crash();
    await expect.poll(() => desktop.output()).toContain(`[views] panel ${panelId} renderer gone`);
    // the stub still holds the reply open: the page shows the text streamed so far and the turn's Stop
    await expect.poll(page.text).toContain('Streamed before the crash');
    await expect.poll(page.sendButton).toBe('Stop (Esc)');
    expect(await page.text()).not.toContain('finished after it');

    release();
    await expect.poll(page.text).toContain('Streamed before the crash and finished after it.');
    await expect.poll(page.sendButton).toBe('Send (Enter)');
    expect(occurrences(await page.text(), 'finished after it')).toBe(1);
    await desktop.close();
    expect(logBeforeQuit(home)).not.toMatch(/\[views\] rejected/);
  } finally {
    await stub.close();
  }
});

async function openProject(app: ElectronApplication, h: HermeticHome): Promise<Page> {
  const home = await activeChat(app);
  await expect(chatInput(home)).toBeVisible();
  const opened = nextChat(app, [home]);
  await addProject(app, h.project, true);
  const tab = await opened;
  await expect(chatInput(tab)).toBeVisible();
  return tab;
}

// The subagent card's state as the recreated page renders it: its status chip, and its overlay's shell card.
const SUBAGENT_CARD_STATE = `(() => {
  const card = document.querySelector('[data-testid="subagent-card"]');
  if (!card) return null;
  if (!document.querySelector('[role="dialog"]')) card.click();
  const tool = [...document.querySelectorAll('[role="dialog"] [data-testid="tool-card"]')].find((c) => c.textContent.includes('sleep 120'));
  return {
    status: card.querySelector('[data-testid="subagent-status"]')?.textContent?.trim() ?? null,
    output: tool?.querySelector('[role="log"][aria-label="Live command output"]')?.textContent ?? null,
    stop: tool?.querySelector('[aria-label="Stop, then add an optional note"]') != null,
    unrecorded: tool?.textContent?.includes('Outcome not recorded') ?? false,
  };
})()`;

test('a chat page that crashes while a subagent runs a shell tool comes back with the subagent running and the tool showing its output', async ({ launch, home }, testInfo) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const desktop = await launch();
    const tab = await openProject(desktop.app, home);
    const panelId = panelIdOf(tab);
    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'Agent', arguments: { description: 'Run the build', prompt: 'Run the build.', subagent_type: 'general-purpose' } }] },
      { chunks: [], toolCalls: [{ name: 'bash', arguments: { command: 'echo sub-build-started; sleep 120' } }] },
    );
    await chatInput(tab).fill('have a subagent run the build');
    await chatInput(tab).press('Enter');
    const prompt = tab.getByRole('region', { name: 'Permission request' });
    await expect(prompt).toContainText('Run the build wants to run this command:');
    await prompt.getByRole('option', { name: 'Yes', exact: true }).click();
    await expect(prompt).toBeHidden();
    await tab.getByTestId('subagent-card').click();
    const tool = tab.getByRole('dialog').getByTestId('tool-card').filter({ hasText: 'sleep 120' });
    await expect(tool.getByRole('log', { name: 'Live command output' })).toContainText('sub-build-started');
    await desktop.stopTracing(testInfo.outputPath('trace-before-crash.zip'));

    const page = chatPageOf(desktop.app, panelId);
    await page.crash();
    await expect.poll(() => desktop.output()).toContain(`[views] panel ${panelId} renderer gone`);
    await expect.poll(() => page.evaluate<unknown>(SUBAGENT_CARD_STATE), { timeout: 20_000 }).toEqual({
      status: 'Running',
      output: expect.stringContaining('sub-build-started'),
      stop: true,
      unrecorded: false,
    });
    await desktop.close();
  } finally {
    await stub.close();
  }
});
