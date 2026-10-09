import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { TerminalGroupInfo, TerminalState } from '../../src/desktop/preload/terminal-channels';
import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { pressKeys, shellPage, viewFocused } from './support/shell';
import { chatInput, clickMenu } from './support/ui';
import { openTerminal, runInTerminal, terminalRows } from './support/terminal';

const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
// An integrated shell, so the working directory a split inherits is the one the shell reported.
const INTEGRATED = windows ? 'windows-powershell' : 'bash';

type Launch = (options?: { env?: Record<string, string> }) => Promise<{ app: ElectronApplication; close: () => Promise<void> }>;

async function launchSplit(home: HermeticHome, launch: Launch): Promise<{ app: ElectronApplication; shell: Page; close: () => Promise<void> }> {
  writeUserSettings(home, { 'damocles.desktop.terminal.defaultProfile': INTEGRATED, 'damocles.desktop.terminal.confirmOnKill': 'never' });
  fs.mkdirSync(path.join(home.project, 'src'), { recursive: true });
  const { app, close } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  await expect.poll(async () => (await state(shell)).terminals[0]?.integrated, { timeout: 30_000 }).toBe(true);
  return { app, shell, close };
}

const state = (shell: Page): Promise<TerminalState> => shell.evaluate(() => window.damoclesShell!.terminal.getState());
const groups = async (shell: Page): Promise<readonly TerminalGroupInfo[]> => (await state(shell)).groups;
const paneBox = (shell: Page, id: string): Locator => shell.locator(`[data-testid="terminal-pane-box"][data-terminal-id="${id}"]`);
const paneInput = (shell: Page, id: string): Locator => paneBox(shell, id).locator('textarea.xterm-helper-textarea');
const row = (shell: Page, id: string): Locator => shell.locator(`[data-testid="terminal-row"][data-terminal-id="${id}"]`);
const sash = (shell: Page): Locator => shell.getByTestId('terminal-pane-sash');

// VS Code's keys: Split Ctrl+Shift+5 (Cmd+\), Focus Previous and Next Pane Alt+Left and Alt+Right (Alt+Cmd).
const split = (app: ElectronApplication): Promise<void> => (mac ? pressKeys(app, '/shell/', '\\', ['meta']) : pressKeys(app, '/shell/', '5', ['control', 'shift']));
const focusPane = (app: ElectronApplication, key: 'Left' | 'Right'): Promise<void> => pressKeys(app, '/shell/', key, mac ? ['alt', 'meta'] : ['alt']);

/** Splits the active terminal by its key and returns the new pane's id once it runs. */
async function splitActive(app: ElectronApplication, shell: Page): Promise<string> {
  const before = (await state(shell)).terminals.map((terminal) => terminal.id);
  await split(app);
  let added: string | undefined;
  await expect.poll(async () => (added = (await state(shell)).terminals.find((terminal) => !before.includes(terminal.id) && terminal.status === 'running')?.id)).toBeDefined();
  return added!;
}

test('Ctrl+Shift+5 splits the terminal into its working folder and focuses the new pane; Alt+Left and Alt+Right move between panes', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell } = await launchSplit(home, launch);
  const first = (await state(shell)).activeId!;
  await runInTerminal(shell, 'cd src');
  await expect.poll(async () => (await state(shell)).terminals.find((terminal) => terminal.id === first)?.description).toBe('src');

  await paneBox(shell, first).locator('.xterm-screen').click();
  const second = await splitActive(app, shell);
  expect(await groups(shell)).toEqual([{ id: expect.any(String), paneIds: [first, second], activePaneId: second, sizes: [0.5, 0.5] }]);
  // Both panes show side by side; the new one, right of its source, takes focus because the user asked for it.
  const [left, right] = await Promise.all([paneBox(shell, first).boundingBox(), paneBox(shell, second).boundingBox()]);
  expect(right!.x).toBeGreaterThan(left!.x + left!.width - 2);
  expect(right!.y).toBe(left!.y);
  await expect(paneInput(shell, second)).toBeFocused();
  await expect(paneBox(shell, second)).toHaveAttribute('data-active', 'true');
  // It started in the folder the source pane's shell reported, and the list shows the two as one group.
  await expect.poll(async () => (await state(shell)).terminals.find((terminal) => terminal.id === second)?.description, { timeout: 30_000 }).toBe('src');
  await expect(terminalRows(shell)).toHaveCount(2);
  await expect(row(shell, first).getByTestId('terminal-row-tree')).toHaveAttribute('data-tree', 'first');
  await expect(row(shell, second).getByTestId('terminal-row-tree')).toHaveAttribute('data-tree', 'last');

  await focusPane(app, 'Left');
  await expect(paneInput(shell, first)).toBeFocused();
  await expect.poll(async () => (await state(shell)).activeId).toBe(first);
  await focusPane(app, 'Right');
  await expect(paneInput(shell, second)).toBeFocused();
  await expect.poll(async () => (await state(shell)).activeId).toBe(second);
});

const menuEnabled = (app: ElectronApplication, id: string): Promise<boolean | undefined> =>
  app.evaluate(({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled, id);

test('with focus outside the terminal the Terminal menu splits and moves between panes, while their keys reach the focused page', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell } = await launchSplit(home, launch);
  const first = (await state(shell)).activeId!;
  const chat = await activeChat(app);
  const chatUrl = `/panel/${panelIdOf(chat)}/`;
  // A click on the chat's view: Playwright's input reaches the page but does not focus its view.
  const focusChat = async (): Promise<void> => {
    await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)?.focus(), chat.url());
    await chatInput(chat).focus();
    await expect.poll(() => viewFocused(app, chat)).toBe(true);
  };
  await focusChat();
  // The chat records the keys it receives, so a key the menu leaves alone is seen to reach the page.
  await chat.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { seenKeys: string[] }).seenKeys = seen;
    window.addEventListener('keydown', (event) => seen.push(`${event.altKey ? 'Alt+' : ''}${event.code}`), true);
  });
  for (const id of ['damocles.terminal.split', 'damocles.terminal.focusPreviousPane', 'damocles.terminal.focusNextPane']) expect(await menuEnabled(app, id), id).toBe(true);

  await (mac ? pressKeys(app, chatUrl, '\\', ['meta']) : pressKeys(app, chatUrl, '5', ['control', 'shift']));
  await expect.poll(() => chat.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)).toContain(mac ? 'Backslash' : 'Digit5');
  expect((await state(shell)).terminals).toHaveLength(1);
  await expect(chatInput(chat)).toBeFocused();

  await clickMenu(app, 'damocles.terminal.split');
  let second: string | undefined;
  await expect.poll(async () => (second = (await groups(shell))[0]?.paneIds[1])).toBeDefined();
  await expect(paneInput(shell, second!)).toBeFocused();

  await focusChat();
  expect(await menuEnabled(app, 'damocles.terminal.focusPreviousPane')).toBe(true);
  await pressKeys(app, chatUrl, 'Left', mac ? ['alt', 'meta'] : ['alt']);
  await expect.poll(() => chat.evaluate(() => (window as unknown as { seenKeys: string[] }).seenKeys)).toContain('Alt+ArrowLeft');
  expect((await state(shell)).activeId).toBe(second);
  await expect(chatInput(chat)).toBeFocused();

  await clickMenu(app, 'damocles.terminal.focusPreviousPane');
  await expect(paneInput(shell, first)).toBeFocused();
  await expect.poll(async () => (await state(shell)).activeId).toBe(first);
});

test('sashes resize panes by mouse and keyboard, and double-click shares the width again', async ({ home, launch }) => {
  const { app, shell } = await launchSplit(home, launch);
  await splitActive(app, shell);
  await splitActive(app, shell);
  await expect(sash(shell)).toHaveCount(2);
  const [group] = await groups(shell);
  expect(group!.sizes.map((size) => size.toFixed(3))).toEqual(['0.333', '0.333', '0.333']);

  // A drag previews locally and sends one resize when it ends.
  const area = (await paneBox(shell, group!.paneIds[0]!).boundingBox())!;
  const handle = (await sash(shell).first().boundingBox())!;
  const groupWidth = area.width * 3;
  await shell.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(handle.x + handle.width / 2 + groupWidth * 0.1, handle.y + handle.height / 2, { steps: 6 });
  await expect.poll(async () => (await paneBox(shell, group!.paneIds[0]!).boundingBox())!.width).toBeGreaterThan(area.width * 1.2);
  expect((await groups(shell))[0]!.sizes[0]!).toBeCloseTo(1 / 3, 3);
  await shell.mouse.up();
  await expect.poll(async () => (await groups(shell))[0]!.sizes[0]!).toBeCloseTo(0.433, 2);
  expect((await groups(shell))[0]!.sizes[2]!).toBeCloseTo(0.333, 2);

  // Each arrow key step is sent; Home stops the pane right of the sash at the minimum.
  const before = (await groups(shell))[0]!.sizes[1]!;
  await sash(shell).nth(1).focus();
  await shell.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await groups(shell))[0]!.sizes[1]!).toBeLessThan(before);
  await shell.keyboard.press('Home');
  await expect.poll(async () => (await groups(shell))[0]!.sizes[2]! * groupWidth).toBeLessThan(90);

  await sash(shell).first().dblclick();
  await expect.poll(async () => (await groups(shell))[0]!.sizes.map((size) => size.toFixed(3))).toEqual(['0.333', '0.333', '0.333']);
});

test('the row menu splits a terminal and unsplits a pane into its own group at the end of the list', async ({ home, launch }) => {
  const { app, shell } = await launchSplit(home, launch);
  const overlay = await readyOverlay(app);
  const first = (await state(shell)).activeId!;
  await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
  await expect(terminalRows(shell)).toHaveCount(2);
  const other = (await state(shell)).activeId!;

  await row(shell, first).click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(menuItem(overlay, 'unsplit')).toHaveCount(0);
  await menuItem(overlay, 'split').click();
  let added: string | undefined;
  await expect.poll(async () => (added = (await groups(shell))[0]!.paneIds[1])).toBeDefined();
  expect((await groups(shell)).map((group) => group.paneIds)).toEqual([[first, added], [other]]);
  await expect(terminalRows(shell)).toHaveCount(3);

  await row(shell, first).click({ button: 'right' });
  await menuItem(overlay, 'unsplit').click();
  await expect.poll(async () => (await groups(shell)).map((group) => group.paneIds)).toEqual([[added], [other], [first]]);
  await expect(terminalRows(shell).last()).toHaveAttribute('data-terminal-id', first);
  await expect(shell.getByTestId('terminal-row-tree')).toHaveCount(0);
  // The pane kept its shell: it still answers.
  await row(shell, first).click();
  await runInTerminal(shell, windows ? "Write-Output ('still-here' + '-42')" : "echo still-here''-42");
  await expect.poll(() => paneBox(shell, first).locator('.xterm-rows').textContent()).toContain('still-here-42');
});

test('a relaunch restores the groups, their sizes and active panes without taking focus', async ({ foreground: _foreground, home, launch }) => {
  let saved: readonly TerminalGroupInfo[];
  {
    const { app, shell, close } = await launchSplit(home, launch);
    const first = (await state(shell)).activeId!;
    await splitActive(app, shell);
    await sash(shell).focus();
    for (let step = 0; step < 4; step++) await shell.keyboard.press('ArrowRight');
    await expect.poll(async () => (await groups(shell))[0]!.sizes[0]!).toBeGreaterThan(0.52);
    await row(shell, first).click();
    await expect.poll(async () => (await state(shell)).activeId).toBe(first);
    saved = await groups(shell);
    await close();
  }
  const { app } = await launch();
  const shell = await shellPage(app);
  const chat = await activeChat(app);
  await expect(chatInput(chat)).toBeVisible();
  await expect(terminalRows(shell)).toHaveCount(2);
  await expect.poll(async () => (await groups(shell)).map((group) => group.paneIds.length)).toEqual([2]);
  const [restored] = await groups(shell);
  expect(restored!.sizes[0]).toBeCloseTo(saved[0]!.sizes[0]!, 3);
  expect(restored!.paneIds.indexOf(restored!.activePaneId)).toBe(0);
  await expect(sash(shell)).toHaveCount(1);
  await expect.poll(() => viewFocused(app, chat)).toBe(true);
  await expect(chatInput(chat)).toBeFocused();
  expect(await viewFocused(app, shell)).toBe(false);
  for (const id of restored!.paneIds) await expect(paneInput(shell, id)).not.toBeFocused();
});
