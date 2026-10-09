import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT, seedStubModel, writeUserSettings } from '../support/hermetic';
import { captureWindow, setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { overlayPage, shellPage } from '../support/shell';
import { menuItem, overlayMenu } from '../support/overlay';
import { startOpenAIStub } from '../support/openai-stub';
import { chatInput } from '../support/ui';
import { activeTerminal, openTerminal, runInTerminal, terminalRows } from '../support/terminal';

// Review captures for slice 9b (shell integration), saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice9b');
const WIDTH = 1440;
const HEIGHT = 900;
const windows = process.platform === 'win32';
const INTEGRATED = windows ? 'windows-powershell' : 'bash';
const OK = windows ? 'Write-Output "12 tests passed"' : 'echo "12 tests passed"';
const FAIL = `node -e "console.error('error TS5058: The specified path does not exist: missing.json'); process.exit(2)"`;
const SLOW = windows ? 'Start-Sleep -Seconds 120' : 'sleep 120';

test.setTimeout(600_000);

async function shoot(app: ElectronApplication, name: string, settle = true): Promise<void> {
  if (settle) for (const page of [await shellPage(app), await overlayPage(app)]) await settled(page);
  await new Promise((resolve) => setTimeout(resolve, settle ? 400 : 150));
  await captureWindow(app, path.join(OUT, `${name}.png`));
}

const marks = (shell: Page) => activeTerminal(shell).getByTestId('terminal-mark');

test('slice 9b captures', async ({ clipboard: _clipboard, home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': INTEGRATED, 'damocles.desktop.terminal.confirmOnKill': 'never' });
    const { app } = await launch();
    await expect(chatInput(await activeChat(app))).toBeVisible();
    await setWindowContentSize(app, WIDTH, HEIGHT);
    const tab = await openProjectChat(app, home.project);
    const shell = await openTerminal(app);
    const overlay = await overlayPage(app);
    await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[0]?.integrated, { timeout: 30_000 }).toBe(true);

    // Marks: a success, a failure and a running command, in the gutter.
    await runInTerminal(shell, OK);
    await expect(marks(shell).last()).toHaveAttribute('data-status', 'success', { timeout: 20_000 });
    await runInTerminal(shell, FAIL);
    await expect(marks(shell).last()).toHaveAttribute('data-status', 'failure', { timeout: 60_000 });
    await runInTerminal(shell, SLOW);
    await expect(marks(shell).last()).toHaveAttribute('data-status', 'running', { timeout: 20_000 });
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      // The running mark's halo never settles, so the capture waits a fixed time instead.
      await shoot(app, `marks-running-success-failure-${theme}`, false);
    }
    await activeTerminal(shell).locator('.xterm-screen').click();
    await shell.keyboard.press('Control+C');
    await expect(marks(shell).last()).not.toHaveAttribute('data-status', 'running', { timeout: 20_000 });

    // Hover on the failed command's mark.
    const failed = marks(shell).nth(1);
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await failed.hover();
      await expect(activeTerminal(shell).getByTestId('terminal-mark-hover')).toBeVisible();
      await shoot(app, `mark-hover-failed-${theme}`);
      await activeTerminal(shell).locator('.xterm-screen').hover({ position: { x: 400, y: 5 } });
    }

    // The mark's menu in the overlay.
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await failed.click();
      await expect(overlayMenu(overlay)).toBeVisible();
      await shoot(app, `mark-menu-${theme}`);
      await overlay.keyboard.press('Escape');
      await expect(overlayMenu(overlay)).toHaveCount(0);
    }

    // Ctrl+Up's highlight on the reached command, captured mid-flash.
    for (const theme of THEMES) {
      await showTheme(app, shell, theme);
      await activeTerminal(shell).locator('.xterm-screen').click();
      await shell.keyboard.press(windows || process.platform === 'linux' ? 'Control+ArrowUp' : 'Meta+ArrowUp');
      await shoot(app, `command-navigation-highlight-${theme}`, false);
      await shell.keyboard.press('Escape');
    }

    // Two terminals: one titled by its running command, one showing its working directory's folder.
    await runInTerminal(shell, 'cd src');
    await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: null, projectKey: null }));
    await expect(terminalRows(shell)).toHaveCount(2);
    await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[1]?.integrated, { timeout: 30_000 }).toBe(true);
    await runInTerminal(shell, SLOW);
    await expect(shell.getByTestId('terminal-row-title').nth(1)).toHaveText(SLOW, { timeout: 20_000 });
    await expect(shell.getByTestId('terminal-row-description').first()).toHaveText('src');
    await captureThemes(app, OUT, 'list-command-titles-cwd-descriptions');
    await activeTerminal(shell).locator('.xterm-screen').click();
    await shell.keyboard.press('Control+C');

    // The composer with a terminal chip: the failed command's output, added from its mark.
    await shell.getByTestId('terminal-row').first().click();
    await failed.click();
    await menuItem(overlay, 'addOutputToChat').click();
    await expect(tab.getByTestId('terminal-attachment-chip')).toHaveCount(1);
    await captureThemes(app, OUT, 'composer-terminal-chip');
    await tab.getByTestId('terminal-attachment-preview-button').click();
    await expect(tab.getByTestId('terminal-attachment-preview')).toBeVisible();
    await captureThemes(app, OUT, 'composer-terminal-chip-preview');
    await tab.keyboard.press('Escape');

    // The sent message in history, with its chip.
    stub.replies.push({ chunks: ['The config file passed to -p does not exist. Point it at tsconfig.json.'] });
    await chatInput(tab).fill('Why did this fail?');
    await chatInput(tab).press('Enter');
    await expect(tab.getByTestId('user-message-terminal-attachments')).toBeVisible();
    await expect(tab.getByText('Point it at tsconfig.json.', { exact: false })).toBeVisible();
    await captureThemes(app, OUT, 'sent-message-terminal-chip');
  } finally {
    await stub.close();
  }
});
