import { chatTab, expect, test } from './support/fixtures';
import { seedStubModel } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { hermeticEnv } from './support/hermetic';
import { SecondProcess } from './support/second-process';
import { chatInput, sessionRow, setThemeSource } from './support/ui';

// Rendered colors of body (bg-background = --vscode-editor-background) in each palette of src/desktop/main/theme.ts.
const DARK_BG = 'rgb(31, 31, 31)';
const LIGHT_BG = 'rgb(255, 255, 255)';

test('window opens themed, follows a live OS theme switch, completes the handshake and lists sessions', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  seedStubModel(home, stub.baseUrl);
  // A session written by another host on the home target (no project), so the listing has something real to show.
  const other = new SecondProcess('-', hermeticEnv(home), { 'damocles.model': 'gpt-6-luna' });
  try {
    await other.ready;
    await other.call({ cmd: 'openPanel' });
    const sessionId = await other.chat('seed a session');
    await other.dispose();

    const { app } = await launch();
    await setThemeSource(app, 'dark');
    const tab = await chatTab(app);
    await expect(chatInput(tab)).toBeVisible();
    await expect(tab.locator('body')).toHaveCSS('background-color', DARK_BG);
    await expect(tab.locator('body')).toHaveClass(/vscode-dark/);

    await expect(await sessionRow(tab, sessionId)).toBeVisible();

    await setThemeSource(app, 'light');
    await expect(tab.locator('body')).toHaveCSS('background-color', LIGHT_BG);
    await expect(tab.locator('body')).toHaveClass(/vscode-light/);
    const editorBg = await tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim());
    expect(editorBg).toBe('#ffffff');

    await setThemeSource(app, 'dark');
    await expect(tab.locator('body')).toHaveCSS('background-color', DARK_BG);
  } finally {
    await other.dispose();
    await stub.close();
  }
});
