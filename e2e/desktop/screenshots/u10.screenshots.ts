import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { readyOverlay } from '../support/overlay';
import { hostMessage, openProjectChat, saveScreenshot, settled, showTheme, THEMES } from '../support/screenshots';
import { popupPage, popupToasts, shellPage } from '../support/shell';
import { activeTerminal, addLastOutputToChat, openTerminal, runInTerminal, waitForOutputLine } from '../support/terminal';
import { chatInput, clickMenu } from '../support/ui';

const windows = process.platform === 'win32';
const FAILED = windows ? `Write-Output 'FAIL a.test.ts'; cmd /c exit 2` : `echo 'FAIL a.test.ts'; bash -c 'exit 2'`;
const SLOW_HOOK = windows ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', 'Start-Sleep -Seconds 6'] : ['sleep', '6'];
const composerChips = (tab: Page) => tab.getByTestId('composer').getByTestId('terminal-attachment-chip');

async function chatWithTerminal(home: HermeticHome, launch: (options?: object) => Promise<{ app: import('@playwright/test').ElectronApplication }>, baseUrl: string, settings: Record<string, unknown> = {}) {
  seedStubModel(home, baseUrl);
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': windows ? 'windows-powershell' : 'bash', 'damocles.desktop.terminal.confirmOnKill': 'never', ...settings });
  const { app } = await launch();
  const tab = await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  const overlay = await readyOverlay(app);
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[0]?.integrated, { timeout: 30_000 }).toBe(true);
  return { app, tab, shell, overlay };
}

test('the chips back in the composer after Esc right after Enter, in Dark and Light', async ({ home, launch }, testInfo) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    fs.writeFileSync(path.join(home.damoclesDir, 'hooks.json'), JSON.stringify({ hooks: { input: [{ command: SLOW_HOOK }] } }));
    const { app, tab, shell, overlay } = await chatWithTerminal(home, launch, stub.baseUrl);
    await runInTerminal(shell, FAILED);
    await waitForOutputLine(shell, 'FAIL a.test.ts');
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      if ((await composerChips(tab).count()) === 0) await addLastOutputToChat(shell, overlay);
      await expect(composerChips(tab)).toHaveCount(1);
      await chatInput(tab).fill('what does this output mean?');
      await chatInput(tab).press('Enter');
      await expect(composerChips(tab)).toHaveCount(0);
      await tab.keyboard.press('Escape');
      await expect(chatInput(tab)).toHaveValue('what does this output mean?', { timeout: 30_000 });
      await expect(composerChips(tab)).toHaveCount(1);
      await settled(tab);
      await saveScreenshot(tab, testInfo, `interrupt-restores-chips-${theme}`);
      await chatInput(tab).fill('');
    }
  } finally {
    await stub.close();
  }
});

test('the toast refusing an Add to Chat past the pending budget, in Dark and Light', async ({ home, launch }, testInfo) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    const { app, tab, shell } = await chatWithTerminal(home, launch, stub.baseUrl, { 'damocles.desktop.terminal.scrollback': 5000 });
    const line = 'y'.repeat(70);
    await runInTerminal(shell, windows ? `1..900 | ForEach-Object { '${line}' }` : `yes ${line} | head -n 900`);
    // The output scrolls the command's mark out of view, so the Terminal menu's Add to Chat takes the last command's output.
    await expect(activeTerminal(shell).getByTestId('terminal-mark').last()).toHaveAttribute('data-status', 'success', { timeout: 30_000 });
    await clickMenu(app, 'damocles.terminal.addToChat');
    await clickMenu(app, 'damocles.terminal.addToChat');
    await expect(composerChips(tab)).toHaveCount(2);
    const shellView = await shellPage(app);
    for (const theme of THEMES) {
      await showTheme(app, shellView, theme);
      await clickMenu(app, 'damocles.terminal.addToChat');
      const popup = await popupPage(app);
      const toast = popupToasts(popup).filter({ hasText: 'Not added to the chat' });
      await expect(toast).toHaveCount(1);
      // The popup window is transparent; the capture paints the theme's background behind it.
      await popup.evaluate(() => {
        document.body.style.backgroundColor = 'var(--d-bg)';
      });
      await settled(popup);
      await saveScreenshot(popup, testInfo, `budget-refused-toast-${theme}`);
      await popup.evaluate(() => {
        document.body.style.backgroundColor = '';
      });
      await toast.getByTestId('overlay-toast-dismiss').click();
      await expect(toast).toHaveCount(0);
      await settled(tab);
      await saveScreenshot(tab, testInfo, `budget-refused-chips-${theme}`);
    }
  } finally {
    await stub.close();
  }
});

test('the notice that a command leaves the attached output in the composer, in Dark and Light', async ({ home, launch }, testInfo) => {
  test.setTimeout(240_000);
  const stub = await startOpenAIStub();
  try {
    const { app, tab, shell, overlay } = await chatWithTerminal(home, launch, stub.baseUrl);
    await runInTerminal(shell, FAILED);
    await waitForOutputLine(shell, 'FAIL a.test.ts');
    await addLastOutputToChat(shell, overlay);
    await expect(composerChips(tab)).toHaveCount(1);
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      // No extension command loads in the app, so the notice is delivered the way core posts it.
      await hostMessage(app, tab, { type: 'notification', notificationType: 'info', message: 'A command takes no terminal output, so the attached output stays in the composer for your next message.' });
      await expect(tab.getByText('A command takes no terminal output', { exact: false })).toBeVisible();
      await settled(tab);
      await saveScreenshot(tab, testInfo, `command-notice-${theme}`);
      await expect(tab.getByText('A command takes no terminal output', { exact: false })).toHaveCount(0, { timeout: 15_000 });
    }
  } finally {
    await stub.close();
  }
});
