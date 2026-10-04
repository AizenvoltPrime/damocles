import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { hermeticEnv } from './support/hermetic';
import { SecondProcess } from './support/second-process';
import { shellPage } from './support/shell';
import { chatInput, listedSessionIds, setThemeSource } from './support/ui';

// Rendered --d-bg of each palette in src/desktop/main/theme.ts.
const DARK_BG = 'rgb(11, 15, 20)';
const LIGHT_BG = 'rgb(247, 249, 251)';

async function themeSource(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ nativeTheme }) => nativeTheme.themeSource);
}

async function expectBackground(pages: Page[], color: string): Promise<void> {
  for (const page of pages) await expect(page.locator('body')).toHaveCSS('background-color', color);
}

// The Geist face that covers Latin has loaded because the page renders with it, not because the check asked for it.
async function geistInUse(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const latin = [...document.fonts].some((face) => face.family.replace(/"/g, '') === 'Geist Variable' && face.status === 'loaded');
    return latin && document.fonts.check('13px "Geist Variable"');
  });
}

// .d-pulsing runs for 1 s (src/webview/styles/motion.css) unless reduced motion cuts every animation to 0.001 ms.
async function pulseSeconds(page: Page): Promise<number> {
  return page.evaluate(() => {
    const probe = document.createElement('div');
    probe.className = 'd-pulsing';
    document.body.append(probe);
    const seconds = Number.parseFloat(getComputedStyle(probe).animationDuration);
    probe.remove();
    return seconds;
  });
}

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
    const tab = await activeChat(app);
    const shell = await shellPage(app);
    await expect(chatInput(tab)).toBeVisible();
    // Only once the chat exists: main applies damocles.desktop.theme to themeSource while it starts, which undoes an earlier switch.
    await setThemeSource(app, 'dark');
    await expectBackground([tab, shell], DARK_BG);
    await expect(tab.locator('body')).toHaveClass(/vscode-dark/);

    await expect.poll(() => listedSessionIds(tab)).toContain(sessionId);

    await setThemeSource(app, 'light');
    await expectBackground([tab, shell], LIGHT_BG);
    await expect(tab.locator('body')).toHaveClass(/vscode-light/);
    const bg = await tab.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--d-bg').trim());
    expect(bg).toBe('#f7f9fb');

    await setThemeSource(app, 'dark');
    await expectBackground([tab, shell], DARK_BG);
  } finally {
    await other.dispose();
    await stub.close();
  }
});

test('damocles.desktop.theme switches every renderer live, system follows the OS, and the pages render in Geist', async ({ home, launch }) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  await expect(chatInput(tab)).toBeVisible();
  expect(await themeSource(app)).toBe('system');
  await expect.poll(() => geistInUse(tab)).toBe(true);
  await expect.poll(() => geistInUse(shell)).toBe(true);

  // Polled first: under a light OS theme the pages are light before the watcher applies the write.
  writeUserSettings(home, { 'damocles.desktop.theme': 'light' });
  await expect.poll(() => themeSource(app)).toBe('light');
  await expectBackground([tab, shell], LIGHT_BG);

  writeUserSettings(home, { 'damocles.desktop.theme': 'dark' });
  await expectBackground([tab, shell], DARK_BG);
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase())).toBe('#0b0f14');

  writeUserSettings(home, { 'damocles.desktop.theme': 'system' });
  await expect.poll(() => themeSource(app)).toBe('system');
  const osDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
  await expectBackground([tab, shell], osDark ? DARK_BG : LIGHT_BG);
  // An OS switch, which themeSource stands in for: the app follows it while the setting is system.
  await setThemeSource(app, osDark ? 'light' : 'dark');
  await expectBackground([tab, shell], osDark ? LIGHT_BG : DARK_BG);
});

test('damocles.desktop.reduceMotion and the OS reduced-motion preference stop animation in every renderer', async ({ home, launch }) => {
  const { app } = await launch();
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  await expect(chatInput(tab)).toBeVisible();
  for (const page of [tab, shell]) await page.emulateMedia({ reducedMotion: 'no-preference' });
  expect(await pulseSeconds(tab)).toBe(1);

  writeUserSettings(home, { 'damocles.desktop.reduceMotion': true });
  for (const page of [tab, shell]) await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', '');
  expect(await pulseSeconds(tab)).toBeLessThan(0.01);
  expect(await pulseSeconds(shell)).toBeLessThan(0.01);

  writeUserSettings(home, { 'damocles.desktop.reduceMotion': false });
  for (const page of [tab, shell]) await expect(page.locator('html')).not.toHaveAttribute('data-reduced-motion');
  expect(await pulseSeconds(tab)).toBe(1);

  await tab.emulateMedia({ reducedMotion: 'reduce' });
  expect(await pulseSeconds(tab)).toBeLessThan(0.01);
});
