import type { ElectronApplication, Page } from '@playwright/test';
import { PANE_CHROME_HEIGHT, PANE_DIVIDER_WIDTH, type PaneState } from '../../src/desktop/preload/pane-channels';
import type { DesktopApp, LaunchOptions } from './support/app';
import { chatTab, expect, nextTab, panelIdOf, tabById, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { chromeEnv, openPage, PAGE_TIMEOUT, paneMouse, panePage, paneState, PANE_URL, setWindowContentSize, startSite, systemChrome, typeIntoFocused, viewOf, windowViews, type Site } from './support/pane';
import { pressKeys, PRIMARY, shellPage, shellState } from './support/shell';
import { chatInput, clickMenu } from './support/ui';

const chrome = systemChrome();

test.describe.configure({ timeout: 240_000 });
test.skip(chrome === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');

let site: Site;
test.beforeAll(async () => {
  site = await startSite((pathname) => `Page ${pathname.slice(1) || 'home'}`);
});
test.afterAll(async () => {
  await site.close();
});

function enableBrowser(home: HermeticHome): void {
  writeUserSettings(home, { 'damocles.browser.enabled': true });
}

async function launchWithBrowser(launch: (options?: LaunchOptions) => Promise<DesktopApp>): Promise<DesktopApp & { tab: Page }> {
  const desktop = await launch({ env: chromeEnv() });
  const tab = await chatTab(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  return { ...desktop, tab };
}

function openSitePage(app: ElectronApplication, tab: Page, pathname: string): Promise<void> {
  return openPage(app, tab, `${site.url}${pathname}`);
}

async function paneOf(app: ElectronApplication): Promise<{ chatTabId: string | undefined; mode: PaneState['mode']; width: number; titles: string[] }> {
  const state = await paneState(app);
  return { chatTabId: state.chatTabId, mode: state.mode, width: state.width, titles: state.pages.map((page) => page.title) };
}

test('the agent opening a page opens the pane beside the chat and keyboard focus stays in the composer', async ({ home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    enableBrowser(home);
    const { app, tab } = await launchWithBrowser(launch);
    const chatId = panelIdOf(tab);
    expect((await paneState(app)).mode).toBe('collapsed');

    stub.replies.push(
      { chunks: [], toolCalls: [{ name: 'ToolSearch', arguments: { tools: ['browser'] } }] },
      { chunks: [], toolCalls: [{ name: 'BrowserOpen', arguments: { url: `${site.url}/agent` } }] },
      { chunks: ['Opened it.'] },
    );
    await app.evaluate(({ webContents }, id) => {
      webContents.getAllWebContents().find((c) => c.getURL().includes(`/panel/${id}/`))!.focus();
    }, chatId);
    await chatInput(tab).focus();
    await chatInput(tab).fill('open the page');
    await chatInput(tab).press('Enter');
    await expect(chatInput(tab)).toHaveValue('');

    // Keystrokes go to whichever view holds keyboard focus, before, while and after the page opens.
    let typed = '';
    const deadline = Date.now() + PAGE_TIMEOUT;
    do {
      if (Date.now() > deadline) throw new Error('the agent never opened a page');
      const chunk = 'typing ';
      await typeIntoFocused(app, chunk);
      typed += chunk;
    } while ((await paneState(app)).pages.length === 0);
    await typeIntoFocused(app, 'still here');
    typed += 'still here';

    await expect(chatInput(tab)).toHaveValue(typed);
    await expect.poll(() => paneOf(app)).toMatchObject({ chatTabId: chatId, mode: 'split', titles: ['Page agent'] });
    expect((await shellState(app)).selectedTabId).toBe(chatId);

    const state = await paneState(app);
    const views = await windowViews(app);
    const chat = viewOf(views, `/panel/${chatId}/`)!;
    const pane = viewOf(views, PANE_URL)!;
    const page = viewOf(views, `/panel/${state.pages[0]!.id}/`)!;
    expect(chat.focused).toBe(true);
    expect(pane.focused).toBe(false);
    expect(page.focused).toBe(false);
    // Chat, then pane, then the page view in the pane's page rectangle, in that stacking order.
    expect(views.indexOf(chat)).toBeLessThan(views.indexOf(pane));
    expect(views.indexOf(pane)).toBeLessThan(views.indexOf(page));
    expect(pane.bounds.width).toBe(state.width);
    expect(chat.bounds.x + chat.bounds.width).toBe(pane.bounds.x);
    expect(page.bounds).toEqual({
      x: pane.bounds.x + PANE_DIVIDER_WIDTH,
      y: pane.bounds.y + PANE_CHROME_HEIGHT,
      width: pane.bounds.width - PANE_DIVIDER_WIDTH,
      height: pane.bounds.height - PANE_CHROME_HEIGHT,
    });
  } finally {
    await stub.close();
  }
});

test('each chat tab has its own pane; switching tabs switches the pane, and a second tab opened over an open pane is not covered', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab: first } = await launchWithBrowser(launch);
  const firstId = panelIdOf(first);
  await openSitePage(app, first, '/first');

  const opened = nextTab(app, [first]);
  await clickMenu(app, 'damocles.openChat');
  const second = await opened;
  await expect(chatInput(second)).toBeVisible();
  const secondId = panelIdOf(second);

  await expect.poll(() => paneOf(app)).toMatchObject({ chatTabId: secondId, mode: 'collapsed', titles: [] });
  const views = await windowViews(app);
  expect(viewOf(views, PANE_URL)?.visible).toBe(false);
  const secondView = viewOf(views, `/panel/${secondId}/`)!;
  expect(secondView.visible).toBe(true);
  expect(views.filter((view) => view.visible && view.url.includes('/panel/') && view !== secondView)).toEqual([]);

  await openSitePage(app, second, '/second');
  await expect.poll(() => paneOf(app)).toMatchObject({ chatTabId: secondId, mode: 'split', titles: ['Page second'] });

  const shell = await shellPage(app);
  await shell.evaluate((id) => window.damoclesShell!.selectTab(id), firstId);
  await expect.poll(() => paneOf(app)).toMatchObject({ chatTabId: firstId, mode: 'split', titles: ['Page first'] });
  const firstPage = (await paneState(app)).pages[0]!.id;
  const after = await windowViews(app);
  expect(viewOf(after, `/panel/${firstPage}/`)?.visible).toBe(true);
  expect(viewOf(after, `/panel/${secondId}/`)?.visible).toBe(false);
});

test('divider drag and keyboard resize the pane, and the width survives a restart', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab } = await launchWithBrowser(launch);
  await setWindowContentSize(app, 1400, 900);
  await openSitePage(app, tab, '/resize');
  const pane = await panePage(app);
  const start = await paneState(app);

  // The pointer holds a fixed window position while main moves the pane view under it.
  const separator = pane.getByRole('separator');
  const paneBounds = async () => viewOf(await windowViews(app), PANE_URL)!.bounds;
  const paneLeft = async (): Promise<number> => (await paneBounds()).x;
  const pointerY = async (): Promise<number> => (await paneBounds()).y + 200;
  const drag = async (distance: number): Promise<void> => {
    const grabX = (await paneLeft()) + PANE_DIVIDER_WIDTH / 2;
    const y = await pointerY();
    await paneMouse(app, 'mouseMove', grabX, y, false);
    await paneMouse(app, 'mouseDown', grabX, y);
    for (let moved = 10; moved <= distance; moved += 10) await paneMouse(app, 'mouseMove', grabX - moved, y);
    await paneMouse(app, 'mouseUp', grabX - distance, y);
  };

  await drag(120);
  await expect.poll(async () => (await paneState(app)).width).toBe(start.width + 120);
  await expect(separator).toHaveAttribute('aria-valuenow', String(start.width + 120));

  // Dragged past the maximum, the pane stops there and the pointer is released over the chat view.
  const { minWidth, maxWidth } = await paneState(app);
  await drag(maxWidth - start.width + 200);
  await expect.poll(async () => (await paneState(app)).width).toBe(maxWidth);
  expect(await paneLeft()).toBeGreaterThan(0);
  await paneMouse(app, 'mouseMove', (await paneLeft()) - 50, await pointerY(), false);
  await paneMouse(app, 'mouseMove', (await paneLeft()) + PANE_DIVIDER_WIDTH, await pointerY(), false);
  expect((await paneState(app)).width).toBe(maxWidth);

  await separator.focus();
  await pane.keyboard.press('ArrowRight');
  await pane.keyboard.press('ArrowRight');
  await pane.keyboard.press('ArrowLeft');
  const resized = maxWidth - 16;
  await expect.poll(async () => (await paneState(app)).width).toBe(resized);
  await expect(separator).toHaveAttribute('aria-valuenow', String(resized));
  await expect(separator).toHaveAttribute('aria-valuemin', String(minWidth));
  await expect(separator).toHaveAttribute('aria-valuemax', String(maxWidth));
  await pane.keyboard.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', String(minWidth));
  await pane.keyboard.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow', String(maxWidth));
  await pane.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', String(resized));

  await app.close();
  const relaunched = await launch({ env: chromeEnv() });
  await chatTab(relaunched.app);
  await setWindowContentSize(relaunched.app, 1400, 900);
  await expect.poll(() => paneOf(relaunched.app), { timeout: PAGE_TIMEOUT }).toMatchObject({ mode: 'split', width: resized, titles: ['Page resize'] });
});

test('collapse and expand through the pane button, the top-bar toggle and the shortcut; maximize and restore', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab } = await launchWithBrowser(launch);
  const chatId = panelIdOf(tab);
  await openSitePage(app, tab, '/toggle');
  const pane = await panePage(app);
  const shell = await shellPage(app);
  const toggle = shell.getByRole('button', { name: 'Browser pane' });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle).toHaveAttribute('title', /Hide browser pane \(.+\)/);

  await pane.getByRole('button', { name: 'Hide browser pane' }).click();
  await expect.poll(async () => (await paneState(app)).mode).toBe('collapsed');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  expect(viewOf(await windowViews(app), PANE_URL)?.visible).toBe(false);

  await toggle.click();
  await expect.poll(async () => (await paneState(app)).mode).toBe('split');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');

  await pressKeys(app, `/panel/${chatId}/`, 'B', [PRIMARY, 'shift']);
  await expect.poll(async () => (await paneState(app)).mode).toBe('collapsed');
  await pressKeys(app, `/panel/${chatId}/`, 'B', [PRIMARY, 'shift']);
  await expect.poll(async () => (await paneState(app)).mode).toBe('split');

  await pane.getByRole('button', { name: 'Maximize pane' }).click();
  await expect.poll(async () => (await paneState(app)).mode).toBe('maximized');
  const maximized = await windowViews(app);
  expect(viewOf(maximized, `/panel/${chatId}/`)?.visible).toBe(false);
  expect(viewOf(maximized, PANE_URL)?.bounds.width).toBe((await paneState(app)).width);
  await expect(pane.getByRole('separator')).toHaveCount(0);

  await pane.getByRole('button', { name: 'Restore side-by-side view' }).click();
  await expect.poll(async () => (await paneState(app)).mode).toBe('split');
  expect(viewOf(await windowViews(app), `/panel/${chatId}/`)?.visible).toBe(true);
});

test('a narrow window overlays the pane on the chat, and the scrim or Escape dismisses it', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab } = await launchWithBrowser(launch);
  const chatId = panelIdOf(tab);
  await openSitePage(app, tab, '/narrow');
  await setWindowContentSize(app, 760, 700);
  await expect.poll(async () => (await paneState(app)).mode).toBe('overlay');

  const views = await windowViews(app);
  const chat = viewOf(views, `/panel/${chatId}/`)!;
  const paneView = viewOf(views, PANE_URL)!;
  // The chat keeps the whole area; the pane view covers it, its left part being the scrim.
  expect(paneView.bounds).toEqual(chat.bounds);
  const { width } = await paneState(app);
  const pane = await panePage(app);
  await expect(pane.locator('section')).toHaveCSS('width', `${width}px`);

  await pane.mouse.click(20, 300);
  await expect.poll(async () => (await paneState(app)).mode).toBe('collapsed');

  await pressKeys(app, `/panel/${chatId}/`, 'B', [PRIMARY, 'shift']);
  await expect.poll(async () => (await paneState(app)).mode).toBe('overlay');
  await pressKeys(app, PANE_URL, 'Escape');
  await expect.poll(async () => (await paneState(app)).mode).toBe('collapsed');
});

test('closing a page removes it; closing the chat tab closes its pages; restart restores pages into their own chat\'s pane', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab: first } = await launchWithBrowser(launch);
  const firstId = panelIdOf(first);
  await openSitePage(app, first, '/one');
  await openSitePage(app, first, '/two');
  const pane = await panePage(app);
  await expect(pane.getByRole('tab')).toHaveCount(2);

  await pane.getByRole('tab', { name: 'Page two' }).focus();
  await pane.keyboard.press('Delete');
  await expect.poll(() => paneOf(app)).toMatchObject({ titles: ['Page one'] });

  const opened = nextTab(app, [first]);
  await clickMenu(app, 'damocles.openChat');
  const second = await opened;
  await expect(chatInput(second)).toBeVisible();
  const secondId = panelIdOf(second);
  await openSitePage(app, second, '/second-chat');
  await openSitePage(app, second, '/doomed');
  const doomed = (await paneState(app)).pages.map((page) => page.id);

  const third = nextTab(app, [first, second]);
  await clickMenu(app, 'damocles.openChat');
  const thirdTab = await third;
  await expect(chatInput(thirdTab)).toBeVisible();
  await openSitePage(app, thirdTab, '/closed-with-chat');
  const thirdPages = (await paneState(app)).pages.map((page) => page.id);
  await (await shellPage(app)).evaluate((id) => window.damoclesShell!.closeTab(id), panelIdOf(thirdTab));
  await expect.poll(() => app.evaluate(({ webContents }, ids) => webContents.getAllWebContents().filter((c) => ids.some((id) => c.getURL().includes(`/panel/${id}/`))).length, thirdPages)).toBe(0);

  await (await shellPage(app)).evaluate((id) => window.damoclesShell!.selectTab(id), secondId);
  await (await panePage(app)).getByRole('tab', { name: 'Page doomed' }).focus();
  await (await panePage(app)).keyboard.press('Delete');
  await expect.poll(() => paneOf(app)).toMatchObject({ chatTabId: secondId, titles: ['Page second-chat'] });
  expect(doomed).toHaveLength(2);

  await app.close();
  const relaunched = await launch({ env: chromeEnv() });
  const shellAgain = await shellPage(relaunched.app);
  await expect.poll(async () => (await shellState(relaunched.app)).tabs.map((t) => t.id)).toEqual([firstId, secondId]);
  await tabById(relaunched.app, firstId);
  await shellAgain.evaluate((id) => window.damoclesShell!.selectTab(id), firstId);
  await expect.poll(() => paneOf(relaunched.app), { timeout: PAGE_TIMEOUT }).toMatchObject({ chatTabId: firstId, titles: ['Page one'] });
  await shellAgain.evaluate((id) => window.damoclesShell!.selectTab(id), secondId);
  await expect.poll(() => paneOf(relaunched.app), { timeout: PAGE_TIMEOUT }).toMatchObject({ chatTabId: secondId, titles: ['Page second-chat'] });
});

test('no page, pane or chat view reaches another surface\'s bridge, and pane channels from other views are rejected', async ({ home, launch }) => {
  enableBrowser(home);
  const desktop = await launchWithBrowser(launch);
  const { app, tab } = desktop;
  const chatId = panelIdOf(tab);
  await openSitePage(app, tab, '/isolated');
  const pageId = (await paneState(app)).pages[0]!.id;
  const pane = await panePage(app);
  const pageView = app.windows().find((p) => p.url().includes(`/panel/${pageId}/`))!;

  const bridges = (page: Page) => page.evaluate(() => ({
    shell: typeof window.damoclesShell,
    pane: typeof window.damoclesPane,
    panel: typeof window.damoclesBridge,
  }));
  expect(await bridges(pageView)).toEqual({ shell: 'undefined', pane: 'undefined', panel: 'object' });
  expect(await bridges(tab)).toEqual({ shell: 'undefined', pane: 'undefined', panel: 'object' });
  expect(await bridges(pane)).toEqual({ shell: 'undefined', pane: 'object', panel: 'undefined' });
  expect(await pane.evaluate(() => Object.keys(window.damoclesPane!).sort())).toEqual([
    'closePage', 'getState', 'goBack', 'goForward', 'navigate', 'newPage', 'onFocusRequest', 'onState', 'openDevTools', 'openExternal', 'pickElement', 'reload', 'requestWidth', 'selectPage', 'setCollapsed', 'setMaximized',
  ]);

  const prefs = await app.evaluate(({ webContents }, url) => {
    const contents = webContents.getAllWebContents().find((c) => c.getURL() === url)!;
    const p = (contents as unknown as { getLastWebPreferences(): { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean } | null }).getLastWebPreferences();
    return { contextIsolation: p?.contextIsolation, nodeIntegration: p?.nodeIntegration, sandbox: p?.sandbox };
  }, PANE_URL);
  expect(prefs).toEqual({ contextIsolation: true, nodeIntegration: false, sandbox: true });

  // A pane message delivered to the pane view's handler from the chat or page view carries that view's real sender and frame.
  for (const fromPart of [`/panel/${chatId}/`, `/panel/${pageId}/`]) {
    const delivered = await app.evaluate(({ webContents }, { from, paneUrl }) => {
      const all = webContents.getAllWebContents();
      const target = all.find((c) => c.getURL() === paneUrl);
      const sender = all.find((c) => c.getURL().includes(from));
      if (!target || !sender) throw new Error('views not found');
      const event = { sender, senderFrame: sender.mainFrame, processId: sender.getProcessId(), frameId: sender.mainFrame.routingId, returnValue: undefined, reply: () => {} };
      return target.ipc.emit('damocles:pane:request-width', event, 100, true);
    }, { from: fromPart, paneUrl: PANE_URL });
    expect(delivered).toBe(true);
    await expect.poll(() => desktop.output()).toContain(`rejected damocles:pane:request-width from "app://damocles${fromPart}index.html"`);
  }
  expect((await paneState(app)).width).not.toBe(100);
});
