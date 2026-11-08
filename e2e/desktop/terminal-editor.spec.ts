import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { TerminalState } from '../../src/desktop/preload/terminal-channels';
import { expect, test } from './support/fixtures';
import { htmlDrag, type DragPoint } from './support/html-drag';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { shellPage } from './support/shell';
import { echoCommand, openTerminal, terminalPane, terminalRows, useTestProfile } from './support/terminal';

type Launch = () => Promise<{ app: ElectronApplication; close: () => Promise<void> }>;

const state = (shell: Page): Promise<TerminalState> => shell.evaluate(() => window.damoclesShell!.terminal.getState());
const placements = async (shell: Page): Promise<Record<string, string>> => Object.fromEntries((await state(shell)).terminals.map((terminal) => [terminal.id, terminal.placement]));
const groups = async (shell: Page): Promise<string[][]> => (await state(shell)).groups.map((group) => [...group.paneIds]);
const editorTab = (shell: Page, id: string): Locator => shell.locator(`[data-testid="editor-tab"][data-kind="terminal"][data-terminal-id="${id}"]`);
const editorView = (shell: Page, id: string): Locator => shell.locator(`#terminal-editor-host-${id} [data-testid="terminal-view"]`);
const paneBox = (shell: Page, id: string): Locator => shell.locator(`[data-testid="terminal-pane-box"][data-terminal-id="${id}"]`);
const panelView = (shell: Page, id: string): Locator => paneBox(shell, id).locator('[data-testid="terminal-view"]');
const rowOf = (shell: Page, id: string): Locator => shell.locator(`[data-testid="terminal-row"][data-terminal-id="${id}"]`);
const menuEnabled = (app: ElectronApplication, ids: readonly string[]): Promise<boolean[]> =>
  app.evaluate(({ Menu }, itemIds) => itemIds.map((id) => Menu.getApplicationMenu()?.getMenuItemById(id)?.enabled ?? false), ids);

/** A view's screen as xterm renders it, one line per row. */
const screenOf = (view: Locator): Promise<string> => view.locator('.xterm-rows').evaluate((rows) => [...rows.children].map((row) => (row.textContent ?? '').replace(/\u00a0/g, ' ').trimEnd()).join('\n'));

async function waitForLine(view: Locator, line: string): Promise<void> {
  await expect.poll(async () => (await screenOf(view)).split('\n').includes(line), { timeout: 20_000 }).toBe(true);
}

// Marks the view's element, so a later read proves it is the same element (and so the same xterm), never a new one.
const markView = (view: Locator): Promise<void> => view.evaluate((element) => void element.setAttribute('data-e2e-probe', 'kept'));

/** Launches with the test profile and starts `count` terminals in the current project; returns their ids in list order. */
async function launchTerminals(home: Parameters<typeof useTestProfile>[0], launch: Launch, count: number): Promise<{ app: ElectronApplication; shell: Page; ids: string[]; close: () => Promise<void> }> {
  useTestProfile(home);
  const { app, close } = await launch();
  await openProjectChat(app, home.project);
  const shell = await openTerminal(app);
  for (let made = 1; made < count; made++) {
    await shell.getByTestId('terminal-new').click({ modifiers: ['Shift'] });
    await expect(terminalRows(shell)).toHaveCount(made + 1);
  }
  await expect.poll(async () => (await state(shell)).terminals.every((terminal) => terminal.status === 'running'), { timeout: 30_000 }).toBe(true);
  return { app, shell, ids: (await state(shell)).terminals.map((terminal) => terminal.id), close };
}

async function center(locator: Locator, fractionX = 0.5): Promise<DragPoint> {
  const box = (await locator.boundingBox())!;
  return { x: box.x + box.width * fractionX, y: box.y + box.height / 2 };
}

test('Move Terminal into Editor Area keeps the running terminal and its output, takes typing at once, and Move Terminal into Panel returns it', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 1);
  const [id] = ids as [string];
  const overlay = await readyOverlay(app);
  await panelView(shell, id).locator('.xterm-screen').click();
  await shell.keyboard.type(echoCommand('BEFORE_MOVE_7341'));
  await shell.keyboard.press('Enter');
  await waitForLine(panelView(shell, id), 'BEFORE_MOVE_7341');
  await markView(panelView(shell, id));

  await terminalPane(shell).getByTestId('terminal-tab').click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, 'moveToEditor').click();

  await expect(editorTab(shell, id)).toHaveAttribute('aria-selected', 'true');
  await expect(editorView(shell, id)).toBeVisible();
  // The same element, so the same xterm, its scrollback and the output printed before the move.
  await expect(editorView(shell, id)).toHaveAttribute('data-e2e-probe', 'kept');
  await waitForLine(editorView(shell, id), 'BEFORE_MOVE_7341');
  expect(await placements(shell)).toEqual({ [id]: 'editor' });
  await expect(shell.getByTestId('terminal-empty')).toBeVisible();
  // A terminal tab edits no document: Save, Save As and Format Document are off, Close Editor is on.
  await expect.poll(() => menuEnabled(app, ['damocles.editor.save', 'damocles.editor.saveAs', 'damocles.editor.formatDocument', 'damocles.editor.close'])).toEqual([false, false, false, true]);

  // Main focuses the moved terminal, so typing reaches the same shell at once.
  await expect(editorView(shell, id).locator('.xterm-helper-textarea')).toBeFocused();
  await shell.keyboard.type(echoCommand('AFTER_MOVE_7341'));
  await shell.keyboard.press('Enter');
  await waitForLine(editorView(shell, id), 'AFTER_MOVE_7341');

  await editorTab(shell, id).click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await menuItem(overlay, 'moveToPanel').click();
  await expect(editorTab(shell, id)).toHaveCount(0);
  await expect(panelView(shell, id)).toBeVisible();
  await expect(panelView(shell, id)).toHaveAttribute('data-e2e-probe', 'kept');
  await waitForLine(panelView(shell, id), 'BEFORE_MOVE_7341');
  await waitForLine(panelView(shell, id), 'AFTER_MOVE_7341');
  expect(await placements(shell)).toEqual({ [id]: 'panel' });
  await expect(terminalPane(shell).getByTestId('terminal-tab')).toHaveAttribute('data-terminal-id', id);
  // Main focuses the terminal it brought back, so typing reaches the shell in the panel at once.
  await expect(panelView(shell, id).locator('.xterm-helper-textarea')).toBeFocused();
  await shell.keyboard.type(echoCommand('BACK_IN_PANEL_7341'));
  await shell.keyboard.press('Enter');
  await waitForLine(panelView(shell, id), 'BACK_IN_PANEL_7341');
});

test('an editor terminal dropped on the panel\'s header strip, beside the one terminal left there, comes back as its own tab at the end', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 2);
  const [a, b] = ids as [string, string];
  const overlay = await readyOverlay(app);
  const header = shell.getByTestId('terminal-header');
  await rowOf(shell, b).click({ button: 'right' });
  await menuItem(overlay, 'moveToEditor').click();
  await expect(editorTab(shell, b)).toBeVisible();
  await expect(terminalPane(shell).getByTestId('terminal-tab')).toHaveAttribute('data-terminal-id', a);

  await htmlDrag(app, shell, await center(editorTab(shell, b), 0.3), async (drag) => {
    await drag.over(await center(header, 0.7));
    await expect(header).toHaveAttribute('data-drop', 'true');
    await drag.drop(await center(header, 0.7));
  });
  await expect.poll(() => groups(shell)).toEqual([[a], [b]]);
  expect(await placements(shell)).toEqual({ [a]: 'panel', [b]: 'panel' });
  await expect(header).not.toHaveAttribute('data-drop');
  await expect(editorTab(shell, b)).toHaveCount(0);
  await expect(shell.getByTestId('terminal-move-announcement')).toHaveText(/ moved to position 2 of 2$/);

  // A row dropped on the strip leaves for the end.
  await htmlDrag(app, shell, await center(rowOf(shell, a), 0.3), async (drag) => {
    await drag.over(await center(header, 0.7));
    await expect(header).toHaveAttribute('data-drop', 'true');
    await drag.drop(await center(header, 0.7));
  });
  await expect.poll(() => groups(shell)).toEqual([[b], [a]]);
});

test('a row dragged onto the editor tab strip moves into the editor, and its editor tab dragged onto a pane half joins that group', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 2);
  const [a, b] = ids as [string, string];
  const strip = shell.getByTestId('editor-tabs');

  const row = await center(rowOf(shell, b), 0.3);
  await htmlDrag(app, shell, row, async (drag) => {
    await drag.over(await center(strip, 0.6));
    // The ghost tab at the strip's end shows where the terminal lands.
    await expect(shell.getByTestId('editor-tab-drop')).toHaveAttribute('data-terminal-id', b);
    await drag.drop(await center(strip, 0.6));
  });
  await expect.poll(() => placements(shell)).toEqual({ [a]: 'panel', [b]: 'editor' });
  await expect(shell.getByTestId('editor-tab-drop')).toHaveCount(0);
  await expect(editorTab(shell, b)).toBeVisible();
  await expect(editorView(shell, b)).toBeVisible();
  expect(await groups(shell)).toEqual([[a]]);

  await htmlDrag(app, shell, await center(editorTab(shell, b), 0.3), async (drag) => {
    await drag.over(await center(paneBox(shell, a), 0.75));
    await expect(paneBox(shell, a).getByTestId('terminal-drop-overlay')).toHaveAttribute('data-side', 'after');
    await drag.drop(await center(paneBox(shell, a), 0.75));
  });
  await expect.poll(() => groups(shell)).toEqual([[a, b]]);
  expect(await placements(shell)).toEqual({ [a]: 'panel', [b]: 'panel' });
  await expect(editorTab(shell, b)).toHaveCount(0);
  await expect(panelView(shell, b)).toBeVisible();
});

test('closing a terminal\'s editor tab kills the terminal', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 2);
  const [a, b] = ids as [string, string];
  const overlay = await readyOverlay(app);
  await rowOf(shell, b).click({ button: 'right' });
  await menuItem(overlay, 'moveToEditor').click();
  await expect(editorTab(shell, b)).toBeVisible();
  // confirmOnKill is never in these suites; terminal-shell-integration.spec.ts covers the question.
  await editorTab(shell, b).hover();
  await editorTab(shell, b).getByTestId('editor-tab-close').click();
  await expect.poll(async () => (await state(shell)).terminals.map((terminal) => terminal.id)).toEqual([a]);
  await expect(editorTab(shell, b)).toHaveCount(0);
});

test('a relaunch restores an editor terminal as an editor tab', async ({ foreground: _foreground, home, launch }) => {
  {
    const { app, shell, ids, close } = await launchTerminals(home, launch, 2);
    const [a, b] = ids as [string, string];
    const overlay = await readyOverlay(app);
    // Named, so the relaunch's new ids map back to these terminals.
    for (const [id, name] of [[a, 'panel one'], [b, 'editor one']] as const) {
      await rowOf(shell, id).focus();
      await shell.keyboard.press('F2');
      await shell.getByTestId('terminal-rename-input').fill(name);
      await shell.keyboard.press('Enter');
      await expect(rowOf(shell, id).getByTestId('terminal-row-title')).toHaveText(name);
    }
    await rowOf(shell, b).click({ button: 'right' });
    await menuItem(overlay, 'moveToEditor').click();
    await expect(editorTab(shell, b)).toBeVisible();
    await expect.poll(() => placements(shell)).toEqual({ [a]: 'panel', [b]: 'editor' });
    await close();
  }
  const { app } = await launch();
  const shell = await shellPage(app);
  const named = async (): Promise<Array<[string | null, string]>> => (await state(shell)).terminals.map((terminal) => [terminal.name, terminal.placement]);
  await expect.poll(named, { timeout: 30_000 }).toEqual([['panel one', 'panel'], ['editor one', 'editor']]);
  const restored = (await state(shell)).terminals.find((terminal) => terminal.name === 'editor one')!;
  await expect(editorTab(shell, restored.id).getByTestId('editor-tab-title')).toHaveText('editor one');
  await editorTab(shell, restored.id).click();
  await expect(editorView(shell, restored.id)).toBeVisible();
  await expect(editorView(shell, restored.id)).toHaveAttribute('data-status', 'running', { timeout: 30_000 });
});
