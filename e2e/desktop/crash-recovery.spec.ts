import { chatTab, expect, panelIdOf, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { chatInput, sendAndAwaitEcho } from './support/ui';

test('a killed tab renderer is recreated with its state', async ({ launch, home }, testInfo) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const desktop = await launch();
    const tab = await chatTab(desktop.app);
    await expect(chatInput(tab)).toBeVisible();
    const panelId = panelIdOf(tab);
    await sendAndAwaitEcho(tab, 'remember this conversation');
    // Playwright's trace screencast on a page whose renderer crashes makes the driver close the app, so the trace ends here.
    await desktop.stopTracing(testInfo.outputPath('trace-before-crash.zip'));

    const pidBefore = await desktop.app.evaluate(({ webContents }, id) => {
      const w = webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`));
      if (!w) throw new Error('tab webContents not found');
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
