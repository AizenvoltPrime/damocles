import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { activeChat, expect, test } from '../support/fixtures';
import { REPO_ROOT } from '../support/hermetic';
import { captureWindow, setWindowContentSize } from '../support/browser';
import { openProjectChat, settled, showTheme, THEMES } from '../support/screenshots';
import { overlayPage, pressKeys, shellPage } from '../support/shell';
import { closeSettingsModal, openSettingsModal } from '../support/settings';
import { quickPick } from '../support/editor';
import { menuItem, overlayMenu } from '../support/overlay';
import { chatInput } from '../support/ui';
import { activeTerminal, echoCommand, hoverTerminalText, linkHint, openTerminal, runInTerminal, terminalRows, useTestProfile, waitForOutputLine } from '../support/terminal';

// Review captures for slice 9a (terminal essentials), saved to DAMOCLES_SCREENSHOT_DIR, dark and light.
const OUT = process.env.DAMOCLES_SCREENSHOT_DIR ?? path.join(process.env.USERPROFILE ?? REPO_ROOT, '.damocles', 'screenshots', 'slice9a');
const WIDTH = 1440;
const HEIGHT = 900;

test.setTimeout(600_000);

async function shoot(app: ElectronApplication, name: string): Promise<void> {
  for (const page of [await shellPage(app), await overlayPage(app)]) await settled(page);
  await new Promise((resolve) => setTimeout(resolve, 500));
  await captureWindow(app, path.join(OUT, `${name}.png`));
}

/**
 * Captures a state in both themes. A theme switch repaints the terminal, which drops a link hover, so `open` sets the state
 * up again in each theme and `close` takes it down before the next.
 */
async function both(app: ElectronApplication, name: string, open: () => Promise<void> = async () => {}, close: () => Promise<void> = async () => {}): Promise<void> {
  const shell = await shellPage(app);
  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    await open();
    await shoot(app, `${name}-${theme}`);
    await close();
  }
}

const rowOf = (shell: Page, index: number): Locator => terminalRows(shell).nth(index);

async function pickFor(overlay: Page, row: Locator, action: 'changeIcon' | 'changeColor', itemId: string): Promise<void> {
  await row.click({ button: 'right' });
  await menuItem(overlay, action).click();
  await expect(quickPick(overlay)).toBeVisible();
  await overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${itemId}"]`).click();
  await expect(quickPick(overlay)).toHaveCount(0);
}

test('slice 9a captures', async ({ clipboard, home, launch }) => {
  fs.mkdirSync(OUT, { recursive: true });
  useTestProfile(home);
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home.project, 'src', 'app.ts'), Array.from({ length: 60 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n'));

  const { app } = await launch();
  await expect(chatInput(await activeChat(app))).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  const overlay = await overlayPage(app);
  const screen = activeTerminal(shell).locator('.xterm-screen');

  // A compiler error's path:line:col, hovered: the accent underline and the Ctrl+click hint inside the terminal.
  await runInTerminal(shell, echoCommand('src/app.ts:42:7 - error TS2304: Cannot find name \'session\'.'));
  await waitForOutputLine(shell, 'src/app.ts:42:7 - error TS2304: Cannot find name \'session\'.');
  await both(app, 'link-hover', async () => {
    await hoverTerminalText(shell, 'src/app.ts:42:7 - error TS2304: Cannot find name \'session\'.', 'app.ts');
    await expect(linkHint(shell)).toBeVisible();
  }, async () => {
    await shell.mouse.move(5, 5);
    await expect(linkHint(shell)).toHaveCount(0);
  });

  // The terminal's context menu with a selection, so Copy is enabled.
  await both(app, 'terminal-context-menu', async () => {
    const line = activeTerminal(shell).locator('.xterm-rows > div', { hasText: 'error TS2304' }).last();
    const box = (await line.boundingBox())!;
    await shell.mouse.click(box.x + 4, box.y + box.height / 2, { clickCount: 3 });
    await shell.mouse.click(box.x + 120, box.y + box.height / 2, { button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
  }, async () => {
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
  });

  // The New Terminal split button's dropdown.
  await both(app, 'new-terminal-dropdown', async () => {
    await shell.getByTestId('terminal-new-menu').click();
    await expect(overlayMenu(overlay)).toBeVisible();
  }, async () => {
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
  });

  // One terminal: F2 on its tab renames it in place, the title's text selected.
  await both(app, 'inline-rename-tab', async () => {
    await shell.getByTestId('terminal-tab').focus();
    await shell.keyboard.press('F2');
    await expect(shell.getByTestId('terminal-rename-input')).toBeFocused();
  }, async () => {
    await shell.keyboard.press('Escape');
    await expect(shell.getByTestId('terminal-rename-input')).toHaveCount(0);
  });

  // Three terminals in the list, each with its own icon and colour.
  for (let i = 0; i < 2; i++) await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(terminalRows(shell)).toHaveCount(3);
  await pickFor(overlay, rowOf(shell, 0), 'changeIcon', 'rocket');
  await pickFor(overlay, rowOf(shell, 0), 'changeColor', 'magenta');
  await pickFor(overlay, rowOf(shell, 1), 'changeIcon', 'database');
  await pickFor(overlay, rowOf(shell, 1), 'changeColor', 'cyan');
  await pickFor(overlay, rowOf(shell, 2), 'changeColor', 'yellow');
  await rowOf(shell, 0).focus();
  await shell.keyboard.press('F2');
  await shell.keyboard.type('api server');
  await shell.keyboard.press('Enter');
  await rowOf(shell, 1).focus();
  await shell.keyboard.press('F2');
  await shell.keyboard.type('db');
  await shell.keyboard.press('Enter');

  await both(app, 'list-row-menu', async () => {
    await rowOf(shell, 1).click({ button: 'right' });
    await expect(overlayMenu(overlay)).toBeVisible();
  }, async () => {
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
  });

  await both(app, 'inline-rename', async () => {
    await rowOf(shell, 2).focus();
    await shell.keyboard.press('F2');
    await expect(shell.getByTestId('terminal-rename-input')).toBeFocused();
  }, async () => {
    await shell.keyboard.press('Escape');
    await expect(shell.getByTestId('terminal-rename-input')).toHaveCount(0);
  });

  await both(app, 'icon-picker', async () => {
    await rowOf(shell, 0).click({ button: 'right' });
    await menuItem(overlay, 'changeIcon').click();
    await expect(quickPick(overlay)).toBeVisible();
  }, async () => {
    await overlay.keyboard.press('Escape');
    await expect(quickPick(overlay)).toHaveCount(0);
  });

  await both(app, 'color-picker-colored-rows', async () => {
    await rowOf(shell, 1).click({ button: 'right' });
    await menuItem(overlay, 'changeColor').click();
    await expect(quickPick(overlay)).toBeVisible();
  }, async () => {
    await overlay.keyboard.press('Escape');
    await expect(quickPick(overlay)).toHaveCount(0);
  });

  // The multi-line paste warning (bracketed paste off in cmd; bash turns it off for the capture).
  await rowOf(shell, 2).click();
  if (process.platform !== 'win32') await runInTerminal(shell, 'bind \'set enable-bracketed-paste off\'');
  await clipboard.writeText(app, 'npm run build\nnpm test -- --watch=false\n\tdeploy --env=prod\u001b[0m\nrm -rf dist');
  await both(app, 'paste-warning-dialog', async () => {
    await screen.click();
    await pressKeys(app, '/shell/', 'V', ['control', 'shift']);
    await expect(overlay.getByTestId('overlay-message')).toBeVisible();
  }, async () => {
    await overlay.getByTestId('overlay-message-cancel').click();
    await expect(overlay.getByTestId('overlay-message')).toHaveCount(0);
  });

  await both(app, 'settings-terminal', async () => {
    await openSettingsModal(app, 'terminal');
    await overlay.getByTestId('settings-row-damocles.desktop.terminal.multiLinePasteWarning').scrollIntoViewIfNeeded();
  }, async () => {
    await closeSettingsModal(overlay);
  });
});
