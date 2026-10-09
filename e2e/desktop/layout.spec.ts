import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, selectedProjectKey, shellPage, shellState } from './support/shell';
import { chooseMenuItem, overlayMenu } from './support/overlay';
import { openSettingsModal, setContentSize, settingsRow } from './support/settings';
import { openProjectChat, settled } from './support/screenshots';
import { activeTabTopRow, openInEditor, toggleTerminal } from './support/editor';
import { DEFAULT_GRID_LAYOUT, type GridPane, type GridSlot } from '../../src/desktop/preload/shell-channels';

async function slots(app: ElectronApplication): Promise<Record<GridSlot, GridPane>> {
  return { ...(await shellState(app)).layout.grid.slots };
}

/** The selected chat view's bounds in window DIPs, as main placed it. */
async function chatViewBounds(app: ElectronApplication, chat: Page): Promise<Electron.Rectangle> {
  return app.evaluate(({ BaseWindow }, url) => {
    for (const window of BaseWindow.getAllWindows()) {
      const view = (window.contentView.children as Electron.WebContentsView[]).find((child) => child.webContents?.getURL() === url);
      if (view) return view.getBounds();
    }
    throw new Error(`no view for ${url}`);
  }, chat.url());
}

/**
 * Drags `pane` by its grip onto the point `at` (fractions of the layout grid), with the shell's own pointer, and returns the
 * zone the overlay highlighted just before the release. The shell keeps the pressed pointer and forwards it through main to the
 * overlay, which draws and hit-tests the zones.
 */
async function dragPane(app: ElectronApplication, shell: Page, pane: GridPane, at: { x: number; y: number }): Promise<string | null> {
  const overlay = await overlayPage(app);
  const grip = await shell.getByTestId(`pane-grip-${pane}`).boundingBox();
  const grid = await shell.getByTestId('layout-grid').boundingBox();
  if (!grip || !grid) throw new Error('grip or grid not laid out');
  await shell.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await shell.mouse.down();
  await shell.mouse.move(grip.x + grip.width / 2 + 12, grip.y + grip.height / 2 + 12, { steps: 3 });
  await expect(overlay.getByTestId('drop-zones')).toBeVisible();
  const target = { x: grid.x + grid.width * at.x, y: grid.y + grid.height * at.y };
  await shell.mouse.move(target.x, target.y, { steps: 8 });
  await expect(overlay.getByTestId('drop-zones-ghost')).toBeVisible();
  const hot = await overlay.getByTestId('drop-zones').getAttribute('data-hot');
  await shell.mouse.up();
  await expect(overlay.getByTestId('drop-zones')).toBeHidden();
  return hot;
}

test('the default grid is chat in main, editor in side, terminal hidden in bottom, and the chat view sits on the chat slot', async ({ home, launch }) => {
  const { app } = await launch();
  const chat = await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  expect((await shellState(app)).layout.grid).toEqual(DEFAULT_GRID_LAYOUT);
  await expect(shell.getByTestId('grid-pane-chat')).toHaveAttribute('data-slot', 'main');
  await expect(shell.getByTestId('grid-pane-editor')).toHaveAttribute('data-slot', 'side');
  await expect(shell.getByTestId('grid-pane-terminal')).toBeHidden();
  await expect(shell.getByTestId('editor-empty')).toContainText('Click a file in the sidebar to open it here.');
  const slot = await shell.getByTestId('chat-slot').boundingBox();
  await expect.poll(async () => {
    const bounds = await chatViewBounds(app, chat);
    return Math.abs(bounds.x - slot!.x) <= 2 && Math.abs(bounds.width - slot!.width) <= 2;
  }).toBe(true);
});

test('the terminal dragged onto the side slot swaps with the editor, survives a restart, and Restore default layout resets it', async ({ home, launch }) => {
  {
    const { app, close } = await launch();
    await openProjectChat(app, home.project);
    const shell = await shellPage(app);
    await toggleTerminal(app);
    await expect(shell.getByTestId('terminal-pane')).toBeVisible();
    // Showing the hidden pane with no terminal starts one in the current project.
    await expect(shell.getByTestId('terminal-view')).toHaveAttribute('data-status', 'running');
    // The grid's tracks glide open; the grip is measured once they rest.
    await settled(shell);

    // Pointer tracking across the shell to overlay handoff: the zone under the shell's pointer lights up in the overlay.
    expect(await dragPane(app, shell, 'terminal', { x: 0.8, y: 0.3 })).toBe('side');
    await expect.poll(() => slots(app)).toEqual({ main: 'chat', side: 'terminal', bottom: 'editor' });
    await expect(shell.getByTestId('grid-pane-terminal')).toHaveAttribute('data-slot', 'side');
    await expect(shell.getByTestId('grid-pane-editor')).toHaveAttribute('data-slot', 'bottom');
    await expect(shell.getByRole('status').filter({ hasText: 'Moved terminal to right side' })).toBeAttached();
    await close();
  }
  const { app } = await launch();
  const shell = await shellPage(app);
  await expect.poll(() => slots(app)).toEqual({ main: 'chat', side: 'terminal', bottom: 'editor' });
  await expect(shell.getByTestId('grid-pane-terminal')).toHaveAttribute('data-slot', 'side');

  const overlay = await openSettingsModal(app, 'appearance');
  await settingsRow(overlay, 'restore-default-layout').getByRole('button').click();
  await expect.poll(async () => (await shellState(app)).layout.grid).toEqual(DEFAULT_GRID_LAYOUT);
});

test('a drag released outside every zone, or cancelled with Escape, moves nothing', async ({ home, launch }) => {
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  const before = await slots(app);
  const grip = (await shell.getByTestId('pane-grip-editor').boundingBox())!;
  const overlay = await overlayPage(app);
  await shell.mouse.move(grip.x + 4, grip.y + 4);
  await shell.mouse.down();
  await shell.mouse.move(grip.x + 20, grip.y + 20, { steps: 3 });
  await expect(overlay.getByTestId('drop-zones')).toBeVisible();
  await overlay.keyboard.press('Escape');
  await expect(overlay.getByTestId('drop-zones')).toBeHidden();
  await shell.mouse.up();
  expect(await slots(app)).toEqual(before);

  // Released over the sidebar, outside the grid: no zone is hot and the overlay answers none.
  await shell.mouse.move(grip.x + 4, grip.y + 4);
  await shell.mouse.down();
  await shell.mouse.move(grip.x + 20, grip.y + 20, { steps: 3 });
  await expect(overlay.getByTestId('drop-zones')).toBeVisible();
  const sidebar = (await shell.getByTestId('sidebar').boundingBox())!;
  await shell.mouse.move(sidebar.x + sidebar.width / 2, sidebar.y + sidebar.height / 2, { steps: 8 });
  await expect(overlay.getByTestId('drop-zones-ghost')).toBeVisible();
  await expect(overlay.getByTestId('drop-zones')).not.toHaveAttribute('data-hot');
  await shell.mouse.up();
  await expect(overlay.getByTestId('drop-zones')).toBeHidden();
  expect(await slots(app)).toEqual(before);
  await expect(shell.getByTestId('grid-pane-editor')).not.toHaveClass(/grid-pane-dragging/);
});

test('the Move to menu in a pane header moves it by keyboard, and the side and bottom sashes clamp to their limits', async ({ home, launch }) => {
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await shell.getByTestId('pane-grip-editor').focus();
  await shell.keyboard.press('Enter');
  const overlay = await overlayPage(app);
  await expect(overlayMenu(overlay)).toBeVisible();
  await expect(overlay.locator('[data-menu-item][data-item-id="side"]')).toHaveAttribute('aria-disabled', 'true');
  await chooseMenuItem(app, 'bottom');
  await expect.poll(() => slots(app)).toEqual({ main: 'chat', side: 'terminal', bottom: 'editor' });
  // The terminal stays hidden, so the editor in the bottom slot shares the grid with the chat only.
  await expect(shell.getByTestId('sash-bottom')).toBeVisible();
  await expect(shell.getByTestId('sash-side')).toHaveCount(0);

  // Every slot has the same minimum: End leaves the slot across the sash its minimum, the chat's slot included.
  const sash = shell.getByTestId('sash-bottom');
  await sash.focus();
  await shell.keyboard.press('End');
  const gridBox = (await shell.getByTestId('layout-grid').boundingBox())!;
  await expect.poll(async () => Math.abs((await shellState(app)).layout.grid.bottomHeight - (gridBox.height - 5 - 120))).toBeLessThanOrEqual(1);
  await settled(shell);
  expect(Math.abs((await shell.getByTestId('grid-pane-chat').boundingBox())!.height - 120)).toBeLessThanOrEqual(1);
  await shell.keyboard.press('Home');
  await expect.poll(async () => (await shellState(app)).layout.grid.bottomHeight).toBe(120);

  await shell.getByTestId('pane-grip-editor').focus();
  await shell.keyboard.press('Enter');
  await chooseMenuItem(app, 'side');
  const side = shell.getByTestId('sash-side');
  await side.focus();
  await shell.keyboard.press('Home');
  await expect.poll(async () => (await shellState(app)).layout.grid.sideWidth).toBe(300);
  await shell.keyboard.press('End');
  const gridWidth = (await shell.getByTestId('layout-grid').boundingBox())!.width;
  await expect.poll(async () => Math.abs((await shellState(app)).layout.grid.sideWidth - (gridWidth - 5 - 300))).toBeLessThanOrEqual(1);
  await settled(shell);
  expect(Math.abs((await shell.getByTestId('grid-pane-chat').boundingBox())!.width - 300)).toBeLessThanOrEqual(1);
});

/** Drags a sash by `dx`, `dy` with the mouse and waits out the tracks' glide. */
async function dragSash(shell: Page, testId: string, dx: number, dy: number): Promise<void> {
  const box = (await shell.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await shell.mouse.move(x, y);
  await shell.mouse.down();
  await shell.mouse.move(x + dx, y + dy, { steps: 6 });
  await shell.mouse.up();
  await settled(shell);
}

test('a sash drag keeps the size it was released at through later state pushes, and main saves it', async ({ home, launch }) => {
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await setContentSize(app, 1400, 900);
  await settled(shell);
  const size = async (pane: string, axis: 'width' | 'height'): Promise<number> => Math.round((await shell.getByTestId(pane).boundingBox())![axis]);

  const width = await size('grid-pane-editor', 'width');
  await dragSash(shell, 'sash-side', 120, 0);
  expect(await size('grid-pane-editor', 'width')).toBe(width - 120);
  await expect.poll(async () => (await shellState(app)).layout.grid.sideWidth).toBe(width - 120);

  // Showing the terminal is a state push from main; the side pane keeps the dragged width.
  await toggleTerminal(app);
  await expect(shell.getByTestId('sash-bottom')).toBeVisible();
  await settled(shell);
  expect(await size('grid-pane-editor', 'width')).toBe(width - 120);

  const height = await size('grid-pane-terminal', 'height');
  await dragSash(shell, 'sash-bottom', 0, -80);
  expect(await size('grid-pane-terminal', 'height')).toBe(height + 80);
  await expect.poll(async () => (await shellState(app)).layout.grid.bottomHeight).toBe(height + 80);
  expect(await size('grid-pane-editor', 'width')).toBe(width - 120);
});

test('the focus overlay fits the window content area with the reference insets at any window size, its header buttons all visible', async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'wide.ts'), `export const wide = '${'x'.repeat(300)}';`);
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'wide.ts' })).toMatchObject({ ok: true });
  await shell.getByTestId('editor-focus-toggle').click();
  await expect(shell.getByTestId('editor-pane')).toHaveAttribute('data-focus-overlay', 'on');
  // macOS keeps a window inside the screen's work area, so no height may exceed it (679 px on the macOS runner).
  const workHeight = await app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea.height);
  const sizes: ReadonlyArray<readonly [number, number]> = [[1100, Math.min(700, workHeight)], [1700, Math.min(1000, workHeight)]];
  for (const [width, height] of sizes) {
    await setContentSize(app, width, height);
    await settled(shell);
    await expect.poll(() => shell.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height]);
    const pane = (await shell.getByTestId('editor-pane').boundingBox())!;
    // The reference's inset: 56px top, 64px at each side, 40px at the bottom.
    expect(Math.round(pane.x)).toBe(64);
    expect(Math.round(pane.y)).toBe(56);
    expect(Math.round(width - (pane.x + pane.width))).toBe(64);
    expect(Math.round(height - (pane.y + pane.height))).toBe(40);
    await expect(shell.getByTestId('editor-close-pane')).toBeInViewport({ ratio: 1 });
    const close = (await shell.getByTestId('editor-close-pane').boundingBox())!;
    expect(close.x + close.width).toBeLessThanOrEqual(pane.x + pane.width);
    // The active tab keeps its accent bar in the expanded pane.
    await expect.poll(async () => {
      const { row, accent } = await activeTabTopRow(app);
      return row.filter((pixel) => pixel.every((value, i) => Math.abs(value - accent[i]!) <= 6)).length;
    }).toBeGreaterThan(20);
  }
  await shell.keyboard.press('Escape');
  await expect(shell.getByTestId('editor-pane')).not.toHaveAttribute('data-focus-overlay', 'on');
});
