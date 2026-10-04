import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { answerToast, recordedToasts, recordToasts } from './support/shell';
import { chatInput, sendAndAwaitEcho } from './support/ui';

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
    expect(desktop.output()).not.toMatch(/\[views\] rejected/);
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
