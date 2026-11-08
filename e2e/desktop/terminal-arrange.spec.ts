import type { ElectronApplication, Locator, Page } from '@playwright/test';
import type { TerminalState } from '../../src/desktop/preload/terminal-channels';
import { expect, test } from './support/fixtures';
import { quickPick } from './support/editor';
import { htmlDrag, type DragPoint } from './support/html-drag';
import { menuItem, overlayMenu, readyOverlay } from './support/overlay';
import { openProjectChat } from './support/screenshots';
import { shellPage } from './support/shell';
import { openTerminal, terminalRows, useTestProfile } from './support/terminal';

type Launch = () => Promise<{ app: ElectronApplication; close: () => Promise<void> }>;

const state = (shell: Page): Promise<TerminalState> => shell.evaluate(() => window.damoclesShell!.terminal.getState());
const order = async (shell: Page): Promise<string[]> => (await state(shell)).terminals.map((terminal) => terminal.id);
const groups = async (shell: Page): Promise<string[][]> => (await state(shell)).groups.map((group) => [...group.paneIds]);
const rowOf = (shell: Page, id: string): Locator => shell.locator(`[data-testid="terminal-row"][data-terminal-id="${id}"]`);
const paneBox = (shell: Page, id: string): Locator => shell.locator(`[data-testid="terminal-pane-box"][data-terminal-id="${id}"]`);
const dropLine = (shell: Page): Locator => shell.getByTestId('terminal-list-drop-line');
const dropOverlay = (shell: Page, id: string): Locator => paneBox(shell, id).getByTestId('terminal-drop-overlay');

/** Launches with the test profile, opens the terminal and starts more until `count` run; returns their ids in list order. */
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
  return { app, shell, ids: await order(shell), close };
}

// A row's box once its slide to a new place has ended; mid-slide the box still holds part of its old place.
async function settledRowBox(shell: Page, id: string): Promise<{ x: number; y: number; width: number; height: number }> {
  await expect.poll(() => rowOf(shell, id).evaluate((row) => row.getAnimations().length)).toBe(0);
  return (await rowOf(shell, id).boundingBox())!;
}

async function rowPoint(shell: Page, id: string, half: 'upper' | 'lower'): Promise<DragPoint> {
  const box = await settledRowBox(shell, id);
  return { x: box.x + box.width / 3, y: box.y + box.height * (half === 'upper' ? 0.25 : 0.75) };
}

async function panePoint(shell: Page, id: string, half: 'left' | 'right'): Promise<DragPoint> {
  const box = (await paneBox(shell, id).boundingBox())!;
  return { x: box.x + box.width * (half === 'left' ? 0.25 : 0.75), y: box.y + box.height / 2 };
}

/** Drags `id`'s row; `run` moves and drops it. */
async function dragRow(app: ElectronApplication, shell: Page, id: string, run: Parameters<typeof htmlDrag>[3]): Promise<void> {
  const box = await settledRowBox(shell, id);
  await htmlDrag(app, shell, { x: box.x + 30, y: box.y + box.height / 2 }, run);
}

test('dragging a row reorders the list, a split group moves as one block, and its own rows reorder its panes', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 3);
  const [a, b, c] = ids as [string, string, string];

  // The insertion line shows above the row while the drag is over its upper half; the dragged row dims.
  await dragRow(app, shell, c, async (drag) => {
    await drag.over(await rowPoint(shell, a, 'upper'));
    await expect(dropLine(shell)).toHaveAttribute('data-drop', 'reorder');
    await expect(rowOf(shell, c)).toHaveAttribute('data-dragging', 'true');
    await drag.drop(await rowPoint(shell, a, 'upper'));
  });
  await expect.poll(() => order(shell)).toEqual([c, a, b]);
  await expect(dropLine(shell)).toHaveCount(0);
  await expect(rowOf(shell, c)).not.toHaveAttribute('data-dragging');
  await expect(shell.getByTestId('terminal-move-announcement')).toHaveText(/ moved to position 1 of 3$/);

  // A's split group [a, d] moves before c as one block when its second pane is dropped on c's row.
  await rowOf(shell, a).getByTestId('terminal-row-split-button').click();
  await expect(terminalRows(shell)).toHaveCount(4);
  const d = (await order(shell)).find((id) => !ids.includes(id))!;
  expect(await groups(shell)).toEqual([[c], [a, d], [b]]);
  await dragRow(app, shell, d, (drag) => rowPoint(shell, c, 'upper').then((point) => drag.drop(point)));
  await expect.poll(() => groups(shell)).toEqual([[a, d], [c], [b]]);

  // Among its own group's rows a pane moves alone.
  await dragRow(app, shell, d, (drag) => rowPoint(shell, a, 'upper').then((point) => drag.drop(point)));
  await expect.poll(() => groups(shell)).toEqual([[d, a], [c], [b]]);

  // A cancelled drag changes nothing: only its dragend clears the dim, and main takes moves in order, so the move after it
  // proves the cancel sent none.
  await dragRow(app, shell, b, async (drag) => {
    await drag.over(await rowPoint(shell, c, 'upper'));
    await drag.cancel();
  });
  await expect(dropLine(shell)).toHaveCount(0);
  await expect(rowOf(shell, b)).not.toHaveAttribute('data-dragging');
  await dragRow(app, shell, c, (drag) => rowPoint(shell, d, 'upper').then((point) => drag.drop(point)));
  await expect.poll(() => groups(shell)).toEqual([[c], [d, a], [b]]);
});

// Chromium fires dragend at a drag source removed mid-drag, where its own listener still ends the drag; nothing else does.
test('the single tab removed mid-drag, when a second terminal starts, leaves no terminal dimmed', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 1);
  const [a] = ids as [string];
  const tab = shell.getByTestId('terminal-tab');
  const box = (await tab.boundingBox())!;
  await htmlDrag(app, shell, { x: box.x + 20, y: box.y + box.height / 2 }, async (drag) => {
    await drag.over({ x: box.x + 200, y: box.y + 200 });
    await shell.evaluate(() => window.damoclesShell!.terminal.create({ profileId: null, target: { current: true } }));
    await expect(terminalRows(shell)).toHaveCount(2);
    await expect(tab).toHaveCount(0);
    await expect(rowOf(shell, a)).toHaveAttribute('data-dragging', 'true');
    await drag.cancel();
  });
  await expect(rowOf(shell, a)).not.toHaveAttribute('data-dragging');
});

test('reordered rows slide to their new places', async ({ foreground: _foreground, home, launch }) => {
  const { shell, ids } = await launchTerminals(home, launch, 2);
  const [a, b] = ids as [string, string];
  // TransitionGroup slides a row, adding its move class, only when that class leaves a transform transition in its style.
  const transition = await rowOf(shell, a).evaluate((row) => {
    row.classList.add('terminal-row-move');
    const style = getComputedStyle(row);
    const out = { property: style.transitionProperty, duration: style.transitionDuration };
    row.classList.remove('terminal-row-move');
    return out;
  });
  expect(transition.property.split(', ')).toEqual(['transform', 'background-color', 'color', 'opacity']);
  expect(transition.duration.split(', ')[0]).toBe('0.22s');
  await shell.evaluate(() => {
    const slid = new Set<string>();
    (window as unknown as { slid: Set<string> }).slid = slid;
    new MutationObserver((records) => {
      for (const record of records) {
        const row = record.target as HTMLElement;
        if (row.classList.contains('terminal-row-move')) slid.add(row.dataset.terminalId!);
      }
    }).observe(document.querySelector('[data-testid="terminal-list"]')!, { subtree: true, attributeFilter: ['class'] });
  });
  await rowOf(shell, b).focus();
  await shell.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => order(shell)).toEqual([b, a]);
  await expect.poll(() => shell.evaluate(() => [...(window as unknown as { slid: Set<string> }).slid].sort())).toEqual([a, b].sort());
});

test('a row dropped on a pane half joins that group on that side, and one dropped below the rows gets a group of its own at the end', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 3);
  const [a, b, c] = ids as [string, string, string];
  await rowOf(shell, a).click();
  await expect.poll(async () => (await state(shell)).activeId).toBe(a);

  // The half under the pointer lights up, and follows the pointer across the middle.
  await dragRow(app, shell, c, async (drag) => {
    await drag.over(await panePoint(shell, a, 'left'));
    await expect(dropOverlay(shell, a)).toHaveAttribute('data-side', 'before');
    await drag.over(await panePoint(shell, a, 'right'));
    await expect(dropOverlay(shell, a)).toHaveAttribute('data-side', 'after');
    const pane = (await paneBox(shell, a).boundingBox())!;
    await expect.poll(async () => (await dropOverlay(shell, a).boundingBox())!.x).toBeGreaterThanOrEqual(pane.x + pane.width / 2 - 2);
    await drag.drop(await panePoint(shell, a, 'right'));
  });
  await expect.poll(() => groups(shell)).toEqual([[a, c], [b]]);
  await expect(dropOverlay(shell, a)).toHaveCount(0);
  await expect(paneBox(shell, c)).toBeVisible();

  await dragRow(app, shell, b, (drag) => panePoint(shell, a, 'left').then((point) => drag.drop(point)));
  await expect.poll(() => groups(shell)).toEqual([[b, a, c]]);
  // The active terminal stays active through the joins.
  expect((await state(shell)).activeId).toBe(a);

  // Below the last row: a leaves its group for one of its own at the end.
  const list = (await shell.locator('[data-testid="terminal-list"] [role="tablist"]').boundingBox())!;
  const empty = { x: list.x + list.width / 2, y: list.y + list.height - 12 };
  await dragRow(app, shell, a, async (drag) => {
    await drag.over(empty);
    await expect(dropLine(shell)).toHaveAttribute('data-drop', 'detach');
    await drag.drop(empty);
  });
  await expect.poll(() => groups(shell)).toEqual([[b, c], [a]]);
});

test('Alt+Up and Alt+Down, Move Up and Move Down move a row without a pointer, and Join Terminals... joins the checked terminals', async ({ foreground: _foreground, home, launch }) => {
  const { app, shell, ids } = await launchTerminals(home, launch, 3);
  const [a, b, c] = ids as [string, string, string];
  const overlay = await readyOverlay(app);

  await rowOf(shell, c).focus();
  await shell.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => order(shell)).toEqual([a, c, b]);
  // The moved row keeps the keyboard.
  await expect(rowOf(shell, c)).toBeFocused();
  await shell.keyboard.press('Alt+ArrowDown');
  await expect.poll(() => order(shell)).toEqual([a, b, c]);

  await rowOf(shell, a).click({ button: 'right' });
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(menuItem(overlay, 'moveUp')).toHaveAttribute('aria-disabled', 'true');
  await menuItem(overlay, 'moveDown').click();
  await expect.poll(() => order(shell)).toEqual([b, a, c]);

  // Join Terminals... offers every terminal outside a's group as a checkbox row; Down Arrow enters the list, where Space checks
  // the active row; a click checks another, and OK accepts.
  await rowOf(shell, a).click({ button: 'right' });
  await menuItem(overlay, 'joinTerminals').click();
  const pick = quickPick(overlay);
  await expect(pick).toBeVisible();
  await expect(pick.getByTestId('quick-pick-list')).toHaveAttribute('aria-multiselectable', 'true');
  await expect(pick.getByTestId('quick-pick-item')).toHaveCount(2);
  await expect(pick.getByTestId('quick-pick-count')).toHaveText('0 of 2 selected');
  await expect(pick.getByTestId('quick-pick-ok')).toBeDisabled();
  await overlay.keyboard.press('Space');
  await expect(pick.getByTestId('quick-pick-count')).toHaveText('0 of 2 selected');
  await overlay.keyboard.press('Backspace');
  await overlay.keyboard.press('ArrowDown');
  await expect(pick.getByTestId('quick-pick-list')).toBeFocused();
  await overlay.keyboard.press('Space');
  await pick.locator(`[data-testid="quick-pick-item"][data-item-id="${c}"]`).click();
  await expect(pick.getByTestId('quick-pick-count')).toHaveText('2 of 2 selected');
  await expect(pick.locator(`[data-testid="quick-pick-item"][data-item-id="${b}"]`)).toHaveAttribute('aria-checked', 'true');
  await expect(pick.locator('[data-testid="quick-pick-item"][aria-selected]')).toHaveCount(0);
  await pick.getByTestId('quick-pick-ok').click();
  await expect(pick).toHaveCount(0);
  await expect.poll(() => groups(shell)).toEqual([[a, b, c]]);
});

test('a relaunch restores the order, the groups, their sizes and the active pane', async ({ foreground: _foreground, home, launch }) => {
  const names = ['alpha', 'beta', 'gamma'];
  const hundredths = (sizes: readonly number[]): number[] => sizes.map((size) => Math.round(size * 100) / 100);
  let sizes: number[];
  {
    const { app, shell, ids, close } = await launchTerminals(home, launch, 3);
    const [a, b, c] = ids as [string, string, string];
    // Named, so the relaunch's new ids map back to these terminals.
    for (const [index, id] of ids.entries()) {
      await rowOf(shell, id).focus();
      await shell.keyboard.press('F2');
      await shell.getByTestId('terminal-rename-input').fill(names[index]!);
      await shell.keyboard.press('Enter');
      await expect(rowOf(shell, id).getByTestId('terminal-row-title')).toHaveText(names[index]!);
    }
    await rowOf(shell, a).click();
    await dragRow(app, shell, c, (drag) => panePoint(shell, a, 'right').then((point) => drag.drop(point)));
    await expect.poll(() => groups(shell)).toEqual([[a, c], [b]]);
    await dragRow(app, shell, b, (drag) => rowPoint(shell, a, 'upper').then((point) => drag.drop(point)));
    await expect.poll(() => groups(shell)).toEqual([[b], [a, c]]);
    const sash = shell.getByTestId('terminal-pane-sash');
    await sash.focus();
    for (let step = 0; step < 10; step++) await shell.keyboard.press('ArrowRight');
    await expect.poll(async () => (await state(shell)).groups[1]!.sizes[0]).toBeGreaterThan(0.55);
    sizes = hundredths((await state(shell)).groups[1]!.sizes);
    await paneBox(shell, c).locator('.xterm-screen').click();
    await expect.poll(async () => (await state(shell)).activeId).toBe(c);
    await close();
  }
  const { app } = await launch();
  const shell = await shellPage(app);
  const named = async (): Promise<{ groups: string[][]; sizes: number[][]; active: string | undefined }> => {
    const current = await state(shell);
    const nameOf = (id: string): string => current.terminals.find((terminal) => terminal.id === id)?.name ?? id;
    return { groups: current.groups.map((group) => group.paneIds.map(nameOf)), sizes: current.groups.map((group) => hundredths(group.sizes)), active: current.activeId === null ? undefined : nameOf(current.activeId) };
  };
  await expect.poll(named, { timeout: 30_000 }).toEqual({ groups: [['beta'], ['alpha', 'gamma']], sizes: [[1], sizes], active: 'gamma' });
});
