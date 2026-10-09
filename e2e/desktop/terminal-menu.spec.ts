import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { openProjectChat } from './support/screenshots';
import { quickPick } from './support/editor';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { pressKeys, PRIMARY, shellPage, viewFocused } from './support/shell';
import { activeTerminal, echoCommand, openTerminal, runInTerminal, terminalPane, terminalRows, terminalText, useTestProfile, waitForOutputLine } from './support/terminal';

type Launch = () => Promise<{ app: ElectronApplication; close: () => Promise<void> }>;

async function launchWithTerminal(home: Parameters<typeof useTestProfile>[0], launch: Launch): Promise<{ app: ElectronApplication; shell: Page; overlay: Page; close: () => Promise<void> }> {
  useTestProfile(home);
  const { app, close } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  // Toggle Terminal gave the shell page keyboard focus, which main's paste gate requires.
  await expect.poll(() => viewFocused(app, shell)).toBe(true);
  return { app, shell, overlay: await readyOverlay(app), close };
}

const menuIds = (overlay: Page): Promise<string[]> => overlayMenu(overlay).locator('[data-menu-item], [role="separator"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-item-id') ?? '-'));
const rowOf = (shell: Page, id: string): Locator => shell.locator(`[data-testid="terminal-row"][data-terminal-id="${id}"]`);
const renameInput = (shell: Page): Locator => shell.getByTestId('terminal-rename-input');

/** Picks `itemId` in main's list quick pick (Change Icon..., Change Color...). */
async function pick(overlay: Page, itemId: string): Promise<void> {
  await expect(quickPick(overlay)).toBeVisible();
  await expect(quickPick(overlay)).toHaveAttribute('data-pick', 'list');
  await overlay.locator(`[data-testid="quick-pick-item"][data-item-id="${itemId}"]`).click();
  await expect(quickPick(overlay)).toHaveCount(0);
}

/** Opens the menu of `target` with a right click and chooses `itemId`. */
async function choose(overlay: Page, target: Locator, itemId: string): Promise<void> {
  await target.click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, itemId).click();
  await expect(overlayMenu(overlay)).toHaveCount(0);
}

test('the terminal menu lists VS Code\'s items, enables Copy only with a selection, and its clipboard items act on the xterm', async ({ clipboard, home, launch }) => {
  const { app, shell, overlay } = await launchWithTerminal(home, launch);
  const screen = activeTerminal(shell).locator('.xterm-screen');
  await runInTerminal(shell, echoCommand('menu-copy-3k'));
  await waitForOutputLine(shell, 'menu-copy-3k');

  // A blank cell past the first row's text: on macOS a right click first selects the word under the pointer (rightClickSelectsWord).
  await screen.click({ button: 'right', position: { x: (await screen.boundingBox())!.width - 2, y: 2 } });
  await expect(overlayMenu(overlay)).toBeVisible();
  expect(await menuIds(overlay)).toEqual(['copy', 'paste', 'selectAll', 'clear', '-', 'copyLastCommand', 'copyLastCommandOutput', 'addToChat', '-', 'split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill']);
  await expect(menuItem(overlay, 'copy')).toHaveAttribute('aria-disabled', 'true');
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);

  await choose(overlay, screen, 'selectAll');
  await expect(activeTerminal(shell).locator('.xterm-selection div').first()).toBeAttached();
  await clipboard.writeText(app, 'before');
  await screen.click({ button: 'right' });
  await expect(menuItem(overlay, 'copy')).not.toHaveAttribute('aria-disabled', 'true');
  await menuItem(overlay, 'copy').click();
  await expect.poll(() => clipboard.readText(app)).toContain('menu-copy-3k');

  // Paste goes through main, which writes the clipboard to the pty.
  await clipboard.writeText(app, 'menu-paste-8w');
  await choose(overlay, screen, 'paste');
  await expect.poll(() => terminalText(shell)).toContain('menu-paste-8w');

  await choose(overlay, screen, 'clear');
  await expect.poll(() => terminalText(shell)).not.toContain('menu-copy-3k');
});

test('Shift+F10 and the context menu key open the terminal menu from the keyboard, and Escape returns focus to the terminal', async ({ foreground: _foreground, home, launch }) => {
  const { shell, overlay } = await launchWithTerminal(home, launch);
  const textarea = activeTerminal(shell).locator('textarea.xterm-helper-textarea');
  await activeTerminal(shell).locator('.xterm-screen').click();
  for (const key of ['Shift+F10', 'ContextMenu']) {
    await shell.keyboard.press(key);
    await expect(overlayMenu(overlay)).toBeVisible();
    await expect(overlayMenu(overlay).getByRole('menu')).toHaveAttribute('aria-label', /^Actions for /);
    await expect.poll(() => overlay.evaluate(() => document.activeElement?.getAttribute('data-item-id'))).toBe('copy');
    await overlay.keyboard.press('Escape');
    await expect(overlayMenu(overlay)).toHaveCount(0);
    await expect(textarea).toBeFocused();
  }

  // A focused list row opens its own menu from the keyboard, under the row.
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(terminalRows(shell)).toHaveCount(2);
  const row = terminalRows(shell).first();
  await row.focus();
  await shell.keyboard.press('Shift+F10');
  await expect(overlayMenu(overlay)).toBeVisible();
  expect(await menuIds(overlay)).toEqual(['split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill']);
  await overlay.keyboard.press('Escape');
  await expect(overlayMenu(overlay)).toHaveCount(0);
  await expect(row).toBeFocused();
});

test('list rows rename inline with F2, take an icon and a colour from the pickers, keep them across a relaunch, and Kill ends the row', async ({ foreground: _foreground, home, launch }) => {
  let ids: string[];
  {
    const { shell, overlay, close } = await launchWithTerminal(home, launch);
    await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
    await expect(terminalRows(shell)).toHaveCount(2);
    ids = await terminalRows(shell).evaluateAll((rows) => rows.map((row) => row.getAttribute('data-terminal-id')!));
    const first = rowOf(shell, ids[0]!);

    // The row menu has no clipboard group.
    await first.click({ button: 'right' });
    expect(await menuIds(overlay)).toEqual(['split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill']);
    await overlay.keyboard.press('Escape');

    // F2 opens the field over the title with its text selected; Escape keeps the old title, Enter commits.
    await first.focus();
    const title = await first.getByTestId('terminal-row-title').textContent();
    const height = (await first.boundingBox())!.height;
    await shell.keyboard.press('F2');
    await expect(renameInput(shell)).toBeFocused();
    await expect(renameInput(shell)).toHaveAttribute('maxlength', '64');
    expect(await renameInput(shell).evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([0, title!.length]);
    expect((await first.boundingBox())!.height).toBe(height);
    await shell.keyboard.type('scratch');
    await shell.keyboard.press('Escape');
    await expect(renameInput(shell)).toHaveCount(0);
    await expect(first.getByTestId('terminal-row-title')).toHaveText(title!);
    await expect(first).toBeFocused();

    await shell.keyboard.press('F2');
    await shell.keyboard.type('  api server  ');
    await shell.keyboard.press('Enter');
    await expect(first.getByTestId('terminal-row-title')).toHaveText('api server');
    await expect(first).toBeFocused();

    await choose(overlay, first, 'changeIcon');
    await pick(overlay, 'rocket');
    await expect(first.getByTestId('terminal-row-icon')).toHaveAttribute('data-glyph', 'rocket');
    await choose(overlay, first, 'changeColor');
    await pick(overlay, 'red');
    await expect(first.getByTestId('terminal-row-icon')).toHaveAttribute('data-color', 'red');
    // The colour picker marks the current colour and starts on it.
    await choose(overlay, first, 'changeColor');
    await expect(overlay.locator('[data-testid="quick-pick-item"][data-item-id="red"]')).toHaveAttribute('aria-checked', 'true');
    await expect(overlay.locator('[data-testid="quick-pick-item"][data-item-id="red"]')).toHaveAttribute('aria-selected', 'true');
    await overlay.keyboard.press('Escape');
    await expect(quickPick(overlay)).toHaveCount(0);
    await close();
  }

  const { app } = await launch();
  const shell = await shellPage(app);
  const overlay = await readyOverlay(app);
  await expect(terminalRows(shell)).toHaveCount(2);
  const first = rowOf(shell, ids[0]!);
  await expect(first.getByTestId('terminal-row-title')).toHaveText('api server');
  await expect(first.getByTestId('terminal-row-icon')).toHaveAttribute('data-glyph', 'rocket');
  await expect(first.getByTestId('terminal-row-icon')).toHaveAttribute('data-color', 'red');

  // An emptied name restores the automatic title.
  await first.click();
  await first.focus();
  await shell.keyboard.press('F2');
  await shell.keyboard.press('Backspace');
  await shell.keyboard.press('Enter');
  await expect(first.getByTestId('terminal-row-title')).not.toHaveText('api server');

  await choose(overlay, first, 'kill');
  await expect(terminalRows(shell)).toHaveCount(0);
  await expect(terminalPane(shell).getByTestId('terminal-tab')).not.toHaveAttribute('data-terminal-id', ids[0]!);
});

test('the single tab has the row menu, and the palette\'s Rename starts the inline rename there', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, overlay } = await launchWithTerminal(home, launch);
  const tab = terminalPane(shell).getByTestId('terminal-tab');
  await tab.click({ button: 'right' });
  expect(await menuIds(overlay)).toEqual(['split', '-', 'rename', 'changeIcon', 'changeColor', '-', 'kill']);
  const project = tab.getByTestId('terminal-tab-project');
  const [tabBefore, projectBefore] = [(await tab.boundingBox())!, (await project.boundingBox())!];
  await menuItem(overlay, 'rename').click();
  await expect(renameInput(shell)).toBeFocused();
  // The field takes the title's place at the title's size: neither the tab nor the project label moves.
  const [tabAfter, projectAfter] = [(await tab.boundingBox())!, (await project.boundingBox())!];
  expect(Math.abs(tabAfter.width - tabBefore.width)).toBeLessThanOrEqual(1);
  expect(Math.abs(projectAfter.x - projectBefore.x)).toBeLessThanOrEqual(1);
  await shell.keyboard.type('tab name');
  // Blur commits, as in VS Code.
  await activeTerminal(shell).locator('.xterm-screen').click();
  await expect(tab.getByTestId('terminal-tab-title')).toHaveText('tab name');

  await pressKeys(app, '/shell/', 'P', [PRIMARY, 'shift']);
  const input = overlay.getByTestId('quick-pick-input');
  await expect(input).toHaveValue('>');
  await input.fill('>Terminal: Rename');
  await expect(overlay.locator('[data-testid="quick-pick-item"]').first()).toHaveAttribute('data-item-id', 'damocles.terminal.rename');
  await input.press('Enter');
  await expect(renameInput(shell)).toBeFocused();
  await expect(renameInput(shell)).toHaveValue('tab name');
  await shell.keyboard.press('Escape');
  await expect(tab.getByTestId('terminal-tab-title')).toHaveText('tab name');
});
