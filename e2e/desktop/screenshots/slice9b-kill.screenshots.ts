import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT, writeUserSettings } from '../support/hermetic';
import { setWindowContentSize } from '../support/browser';
import { captureThemes, openProjectChat } from '../support/screenshots';
import { overlayPage } from '../support/shell';
import { closeSettingsModal, openSettingsModal, settingsRow } from '../support/settings';
import { chatInput, clickMenu } from '../support/ui';
import { openTerminal, runInTerminal } from '../support/terminal';

// Review captures for slice 9b's kill confirmation and its settings rows, saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice9b');
const WIDTH = 1440;
const HEIGHT = 900;
const windows = process.platform === 'win32';
const LONG_RUNNING = 'node -e "setInterval(()=>{},1000)"';

test.setTimeout(600_000);

async function runningCount(shell: Page): Promise<number> {
  return (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.filter((terminal) => terminal.running !== null).length;
}

test('slice 9b kill confirmation captures', async ({ home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': windows ? 'windows-powershell' : 'bash' });
  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  const overlay = await overlayPage(app);
  const dialog = overlay.getByTestId('overlay-message');

  // One terminal running a program: Kill asks, naming it and its command.
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[0]?.integrated).toBe(true);
  await runInTerminal(shell, LONG_RUNNING);
  await expect.poll(() => runningCount(shell)).toBe(1);
  await clickMenu(app, 'damocles.terminal.kill');
  await expect(dialog).toBeVisible();
  await captureThemes(app, OUT, 'kill-confirmation-single');
  await overlay.getByTestId('overlay-message-cancel').click();
  await expect(dialog).toHaveCount(0);

  // A second terminal running the same program: Kill All asks once, listing both.
  await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: null, projectKey: null }));
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals[1]?.integrated).toBe(true);
  await runInTerminal(shell, LONG_RUNNING);
  await expect.poll(() => runningCount(shell)).toBe(2);
  await clickMenu(app, 'damocles.terminal.killAll');
  await expect(dialog).toBeVisible();
  await captureThemes(app, OUT, 'kill-confirmation-multi');
  await overlay.getByTestId('overlay-message-action-0').click();
  await expect.poll(async () => (await shell.evaluate(() => window.damoclesShell!.terminal.getState())).terminals.length).toBe(0);

  // Settings › Terminal with the shell integration and confirm-before-kill rows.
  await openSettingsModal(app, 'terminal');
  await settingsRow(overlay, 'damocles.desktop.terminal.confirmOnKill').scrollIntoViewIfNeeded();
  await captureThemes(app, OUT, 'settings-terminal-shell-integration');
  await closeSettingsModal(overlay);
});
