import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './support/fixtures';
import { overlayPage, selectedProjectKey, shellPage, shellState } from './support/shell';
import { chooseMenuItem, overlayMenu } from './support/overlay';
import { closeSettingsModal, openSettingsModal, setContentSize, settingsRow } from './support/settings';
import { openProjectChat, settled } from './support/screenshots';
import { activeTabTopRow, openInEditor, toggleTerminal } from './support/editor';
import { initRepo } from './support/git';
import { openScmProject, scmSection } from './support/scm';
import { sectionAction } from './support/shell-ui';
import { DEFAULT_GRID_LAYOUT, MIN_SECTION_SIZE, type GridPane, type GridSlot } from '../../src/desktop/preload/shell-channels';

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

test('at a larger font the grid never reaches past a window narrower than every minimum; its two columns share the room', async ({ home, launch }) => {
  const { app } = await launch();
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await setContentSize(app, 1000, 660);
  // 16px host font: the sidebar's minimum and both columns' minimums together are wider than the window
  await shell.evaluate(() => document.documentElement.style.setProperty('--d-font-size', '16px'));
  await settled(shell);
  await expect.poll(() => shell.evaluate(() => {
    const right = (testId: string): number => document.querySelector(`[data-testid="${testId}"]`)!.getBoundingClientRect().right;
    return { grid: Math.round(right('layout-grid')), editor: Math.round(right('grid-pane-editor')), window: window.innerWidth };
  })).toEqual({ grid: 1000, editor: 1000, window: 1000 });
  const chat = await shell.getByTestId('grid-pane-chat').boundingBox();
  const editor = await shell.getByTestId('grid-pane-editor').boundingBox();
  expect(Math.abs(chat!.width - editor!.width)).toBeLessThanOrEqual(2);
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

/**
 * Drags a sidebar section by its header and drops it `y` px below the top of another section. Playwright's dragTo starts no
 * HTML5 drag in Electron, so the pointer goes through the DevTools protocol: Chromium starts the drag from the header itself
 * (draggable, dragstart, the data it set), hands the drag data back, and the drop is dispatched with that data.
 */
async function dragSection(app: ElectronApplication, shell: Page, from: string, to: string, y: number): Promise<void> {
  // The sidebar slides and its sections grow in at launch: measure once they rest, or the press misses the header.
  await expect(shell.locator(`section[data-section="${to}"]`)).toBeVisible();
  await settled(shell);
  const header = (await shell.locator(`section[data-section="${from}"] [data-testid="sidebar-section-header"]`).boundingBox())!;
  const target = (await shell.locator(`section[data-section="${to}"]`).boundingBox())!;
  const cdp = await app.context().newCDPSession(shell);
  let timer: NodeJS.Timeout | undefined;
  try {
    await cdp.send('Input.setInterceptDrags', { enabled: true });
    const intercepted = new Promise<{ items: Array<{ mimeType: string; data: string }>; dragOperationsMask: number }>((resolve) => cdp.once('Input.dragIntercepted', (event) => resolve(event.data)));
    const mouse = (type: 'mouseMoved' | 'mousePressed' | 'mouseReleased', x: number, atY: number) =>
      cdp.send('Input.dispatchMouseEvent', { type, x, y: atY, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 });
    const start = { x: header.x + 30, y: header.y + header.height / 2 };
    await mouse('mouseMoved', start.x, start.y);
    await mouse('mousePressed', start.x, start.y);
    for (let step = 1; step <= 5; step++) await mouse('mouseMoved', start.x, start.y - step * 10);
    const data = await Promise.race([intercepted, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no drag started from the ${from} header`)), 5000);
    })]);
    const drop = { x: target.x + 40, y: target.y + y };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) await cdp.send('Input.dispatchDragEvent', { type, ...drop, data });
    await mouse('mouseReleased', drop.x, drop.y);
  } finally {
    clearTimeout(timer);
    try {
      await cdp.send('Input.setInterceptDrags', { enabled: false });
    } finally {
      await cdp.detach();
    }
  }
}
test('a sidebar section dragged by its header lands on the half it is dropped on, keeps its place after a restart, and its header menu moves and resets it', async ({ launch }) => {
  const header = (shell: Page, name: string) => shell.locator(`section[data-section="${name}"] [data-testid="sidebar-section-header"]`);
  const visualOrder = async (shell: Page): Promise<string[]> => {
    const tops = await shell.locator('section[data-section]').evaluateAll((nodes) => nodes.map((node) => [node.getAttribute('data-section')!, node.getBoundingClientRect().top] as const));
    return [...tops].sort((a, b) => a[1] - b[1]).map(([name]) => name);
  };
  const moved = ['projects', 'scm', 'chats', 'files', 'graph', 'repos', 'search'];
  {
    const { app, close } = await launch();
    const shell = await shellPage(app);
    // A native HTML5 drag: Source control's header onto the upper half of Chats.
    await dragSection(app, shell, 'scm', 'chats', 6);
    await expect.poll(() => visualOrder(shell)).toEqual(moved);
    await expect(shell.getByTestId('sidebar-announcement')).toHaveText('Source control moved to position 2 of 7');
    // Tab follows the order on screen (reading-flow), not the DOM's. Collapsing Projects makes its rows inert and disables the
    // projects and scm sash, so Tab from Projects' header lands on Source control's.
    expect(await shell.getByTestId('sidebar').evaluate((nav) => getComputedStyle(nav).getPropertyValue('reading-flow'))).toBe('flex-visual');
    await header(shell, 'projects').locator('button[aria-expanded]').click();
    await header(shell, 'projects').locator('button[aria-expanded]').focus();
    await shell.keyboard.press('Tab');
    await expect(header(shell, 'scm').locator('button[aria-expanded]')).toBeFocused();
    await close();
  }
  const { app } = await launch();
  const shell = await shellPage(app);
  // main read the order the shell reported back from window-layout.json
  expect((await shellState(app)).layout.sectionOrder).toEqual(moved);
  await expect.poll(() => visualOrder(shell)).toEqual(moved);

  // Shift+F10 on a header opens its menu; Move Down swaps it with the section below.
  await header(shell, 'scm').locator('button[aria-expanded]').focus();
  await shell.keyboard.press('Shift+F10');
  await chooseMenuItem(app, 'down');
  await expect.poll(() => visualOrder(shell)).toEqual(['projects', 'chats', 'scm', 'files', 'graph', 'repos', 'search']);
  await header(shell, 'files').click({ button: 'right' });
  await chooseMenuItem(app, 'reset');
  await expect.poll(() => visualOrder(shell)).toEqual(['projects', 'chats', 'files', 'scm', 'graph', 'repos', 'search']);
});

test('a sash sits in every gap between sidebar sections wherever they are, and one beside collapsed sections moves the open ones past them', async ({ launch }) => {
  const { app } = await launch();
  const shell = await shellPage(app);
  // within the 1024x768 displays of the macOS and Windows runners, whose work areas cap the height
  await setContentSize(app, 1000, 660);
  await settled(shell);
  const height = (name: string): Promise<number> => shell.locator(`section[data-section="${name}"]`).evaluate((node) => Math.round(node.getBoundingClientRect().height));
  // Each gap's sash: centred on the top of the section below it, and the element the pointer hits there unless disabled.
  const gaps = (): Promise<Array<{ between: string; atGap: boolean; hit: boolean; disabled: boolean }>> => shell.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-testid="section-sash"]')].map((sash) => {
      const rect = sash.getBoundingClientRect();
      const below = sash.dataset['between']!.split(' ')[1]!;
      const top = document.querySelector(`section[data-section="${below}"]`)!.getBoundingClientRect().top;
      const centre = rect.top + rect.height / 2;
      return { between: sash.dataset['between']!, atGap: Math.abs(centre - top) <= 2, hit: sash.contains(document.elementFromPoint(rect.left + rect.width / 2, centre)), disabled: sash.hasAttribute('data-disabled') };
    }));
  const dragSectionSash = async (between: string, dy: number): Promise<void> => {
    const box = (await shell.locator(`[data-testid="section-sash"][data-between="${between}"]`).boundingBox())!;
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await shell.mouse.down();
    await shell.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + dy, { steps: 6 });
    await shell.mouse.up();
    await settled(shell);
  };
  const enabledAtEveryGap = (between: string[]) => between.map((pair) => ({ between: pair, atGap: true, hit: true, disabled: false }));

  const toggle = (name: string) => shell.locator(`section[data-section="${name}"] [data-testid="sidebar-section-header"] button[aria-expanded]`);
  // Repositories and Search are collapsed below the Graph by default and can give or take nothing: VS Code disables those two
  // sashes.
  expect(await gaps()).toEqual([
    ...enabledAtEveryGap(['projects chats', 'chats files', 'files scm', 'scm graph']),
    { between: 'graph repos', atGap: true, hit: false, disabled: true },
    { between: 'repos search', atGap: true, hit: false, disabled: true },
  ]);
  // With Search open, the sash above collapsed Repositories moves the Graph and Search past it.
  await toggle('search').click();
  await settled(shell);
  await expect.poll(gaps).toEqual(enabledAtEveryGap(['projects chats', 'chats files', 'files scm', 'scm graph', 'graph repos', 'repos search']));
  const graph = await height('graph');
  const search = await height('search');
  await dragSectionSash('graph repos', 40);
  expect(await height('graph')).toBe(graph + 40);
  expect(await height('search')).toBe(search - 40);

  await toggle('search').click();
  await settled(shell);
  await dragSection(app, shell, 'scm', 'projects', 6);
  await expect.poll(gaps).toEqual([
    ...enabledAtEveryGap(['scm projects', 'projects chats', 'chats files', 'files graph']),
    { between: 'graph repos', atGap: true, hit: false, disabled: true },
    { between: 'repos search', atGap: true, hit: false, disabled: true },
  ]);
  // Down, so Source control on top takes 30 px from the sections below it, nearest first: Projects gives what it has above its
  // minimum (its header and MIN_SECTION_SIZE's body at the default font), and Chats only the rest.
  const projectsBefore = await height('projects');
  const chatsBefore = await height('chats');
  const scmOnTop = await height('scm');
  const header = Math.round((await shell.locator('section[data-section="projects"] [data-testid="sidebar-section-header"]').boundingBox())!.height);
  const fromProjects = Math.min(30, projectsBefore - (header + MIN_SECTION_SIZE));
  await dragSectionSash('scm projects', 30);
  expect(await height('scm')).toBe(scmOnTop + 30);
  expect(await height('projects')).toBe(projectsBefore - fromProjects);
  expect(await height('chats')).toBe(chatsBefore - (30 - fromProjects));
});

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

test('section titles read in full at rest; title actions show on hover or keyboard focus, and always with Always show section actions', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  const title = scmSection(shell).getByTestId('sidebar-section-title');
  const actions = scmSection(shell).getByTestId('sidebar-section-actions');
  const header = scmSection(shell).getByTestId('sidebar-section-header');

  // the pointer away from the sidebar and focus elsewhere: nothing claims the title's room
  await shell.mouse.move(1200, 600);
  await shell.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(actions).toBeHidden();
  await expect(title).toHaveText(/^source control$/i);
  expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);

  await header.hover();
  await expect(actions).toBeVisible();
  await expect(scmSection(shell).getByTestId('scm-more-actions')).toBeVisible();
  await shell.mouse.move(1200, 600);
  await expect(actions).toBeHidden();

  // the keyboard: focusing the header button shows them, and Tab reaches the first
  await scmSection(shell).locator('h2 button').focus();
  await expect(actions).toBeVisible();
  await shell.keyboard.press('Tab');
  await expect(scmSection(shell).getByTestId('scm-view-mode')).toBeFocused();

  // a collapsed section shows none, even focused
  await scmSection(shell).locator('h2 button').focus();
  await shell.keyboard.press('Enter');
  await expect(scmSection(shell).locator('h2 button')).toHaveAttribute('aria-expanded', 'false');
  await expect(actions).toBeHidden();
  await shell.keyboard.press('Enter');
  await expect(scmSection(shell).locator('h2 button')).toHaveAttribute('aria-expanded', 'true');

  // Settings › Appearance › Always show section actions: shown at rest while on, and off again hides them
  const settings = await openSettingsModal(app, 'appearance');
  const row = settingsRow(settings, 'damocles.desktop.sidebar.alwaysShowHeaderActions');
  await expect(row).toContainText('Always show section actions');
  await row.getByRole('switch').click();
  await closeSettingsModal(settings);
  await shell.mouse.move(1200, 600);
  await shell.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(actions).toBeVisible();
  await expect(shell.getByTestId('files-section').getByTestId('sidebar-section-actions')).toBeVisible();
  const again = await openSettingsModal(app, 'appearance');
  await settingsRow(again, 'damocles.desktop.sidebar.alwaysShowHeaderActions').getByRole('switch').click();
  await closeSettingsModal(again);
  await shell.mouse.move(1200, 600);
  await shell.locator('body').evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await expect(actions).toBeHidden();
  // hovering the section still shows them
  await sectionAction(shell, 'scm-refresh');
});

test('in a narrow sidebar a section without a chip keeps its title actions beside the title, which gives way to them', async ({ foreground: _foreground, home, launch }) => {
  await initRepo(home, home.project);
  const { app } = await launch();
  const shell = await openScmProject(app, home.project);
  await dragSash(shell, 'sidebar-sash', -400, 0);
  const header = scmSection(shell).getByTestId('sidebar-section-header');
  await header.hover();
  const actions = scmSection(shell).getByTestId('sidebar-section-actions');
  await expect(actions).toBeVisible();
  await settled(shell);
  const title = await scmSection(shell).locator('h2').boundingBox();
  const bar = await actions.boundingBox();
  expect(title!.x + title!.width).toBeLessThanOrEqual(bar!.x + 0.5);
});

test('keyboard focus on the New split button shows a whole focus ring on New and on its chevron', async ({ launch }) => {
  const { app } = await launch();
  const shell = await shellPage(app);
  await settled(shell);
  // The shadcn Button draws focus as a 2px ring past a 2px offset; no box with clipped overflow may cut into that reach.
  const ringShown = (testId: string): Promise<boolean> => shell.getByTestId(testId).evaluate((button) => {
    if (!button.matches(':focus-visible') || getComputedStyle(button).boxShadow === 'none') return false;
    const reach = 4;
    const rect = button.getBoundingClientRect();
    for (let node = button.parentElement; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const box = node.getBoundingClientRect();
      if (rect.left - reach < box.left || rect.top - reach < box.top || rect.right + reach > box.right || rect.bottom + reach > box.bottom) return false;
    }
    return true;
  });
  await shell.getByTestId('sidebar-chats').locator('h2 button').focus();
  await shell.keyboard.press('Tab');
  await shell.keyboard.press('Tab');
  await expect(shell.getByTestId('new-chat')).toBeFocused();
  expect(await ringShown('new-chat')).toBe(true);
  await shell.keyboard.press('Tab');
  await expect(shell.getByTestId('new-chat-options')).toBeFocused();
  expect(await ringShown('new-chat-options')).toBe(true);
});
