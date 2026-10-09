import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopApp, LaunchOptions } from './support/app';
import { activeChat, chatById, chatIdOf, expect, nextChat, panelIdOf, selectChatPage, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { activePageTab, browserTabs, chromeEnv, openPage, PAGE_TIMEOUT, startSite, systemChrome, typeIntoFocused, viewOf, windowViews, type Site } from './support/browser';
import { editorTab, toggleTerminal } from './support/editor';
import { chooseMenuItem } from './support/overlay';
import { settled } from './support/screenshots';
import { popupPage, popupToasts, pressKeys, PRIMARY, shellPage } from './support/shell';
import { chatInput, clickMenu, postFromWebview } from './support/ui';

const chrome = systemChrome();

test.describe.configure({ timeout: 240_000 });
test.skip(chrome === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');

let site: Site;
test.beforeAll(async () => {
  site = await startSite((pathname) => `Page ${pathname.slice(1) || 'home'}`, {
    // Repaints every 100 ms, so Chromium keeps producing screencast frames.
    '/ticking': (res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Page ticking</title><body><h1 id="t"></h1><script>setInterval(() => { t.textContent = String(Date.now()); }, 100);</script></body>');
    },
  });
});
test.afterAll(async () => {
  await site.close();
});

function enableBrowser(home: HermeticHome): void {
  writeUserSettings(home, { 'damocles.browser.enabled': true });
}

async function launchWithBrowser(launch: (options?: LaunchOptions) => Promise<DesktopApp>, env: Record<string, string> = {}): Promise<DesktopApp & { tab: Page }> {
  const desktop = await launch({ env: { ...chromeEnv(), ...env } });
  const tab = await activeChat(desktop.app);
  await expect(chatInput(tab)).toBeVisible();
  return { ...desktop, tab };
}

function openSitePage(app: ElectronApplication, tab: Page, pathname: string): Promise<void> {
  return openPage(app, tab, `${site.url}${pathname}`);
}

async function titles(app: ElectronApplication): Promise<string[]> {
  return (await browserTabs(app)).map((tab) => tab.title);
}

// The page view sits over exactly the browser tab's page area, in window DIPs, which equal the shell's CSS px at zoom 1.
async function stageBounds(app: ElectronApplication): Promise<{ x: number; y: number; width: number; height: number }> {
  const shell = await shellPage(app);
  return shell.getByTestId('browser-stage').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = Math.round(rect.left);
    const y = Math.round(rect.top);
    return { x, y, width: Math.round(rect.right) - x, height: Math.round(rect.bottom) - y };
  });
}

test('a page the agent opens is a tab of its chat, laid over the tab\'s page area, and keyboard focus stays in the composer', async ({ foreground: _foreground, home, launch }) => {
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    enableBrowser(home);
    const { app, tab } = await launchWithBrowser(launch);
    const chatId = panelIdOf(tab);
    expect(await browserTabs(app)).toEqual([]);

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

    // Keystrokes go to whichever view holds keyboard focus, before, while and after the page opens and loads.
    let typed = '';
    const deadline = Date.now() + PAGE_TIMEOUT;
    do {
      if (Date.now() > deadline) throw new Error('the agent never opened a page');
      const chunk = 'typing ';
      await typeIntoFocused(app, chunk);
      typed += chunk;
    } while ((await browserTabs(app)).length === 0);
    await expect.poll(async () => (await browserTabs(app))[0]?.title, { timeout: PAGE_TIMEOUT }).toBe('Page agent');
    await typeIntoFocused(app, 'still here');
    typed += 'still here';
    await expect(chatInput(tab)).toHaveValue(typed);
    expect(panelIdOf(await activeChat(app))).toBe(chatId);

    const page = (await activePageTab(app))!;
    expect(page.browser.url).toBe(`${site.url}/agent`);
    const shell = await shellPage(app);
    await expect(shell.getByTestId('browser-address')).toHaveValue(`${site.url}/agent`);
    await expect.poll(async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.bounds).toEqual(await stageBounds(app));
    const views = await windowViews(app);
    expect(viewOf(views, `/panel/${chatId}/`)!.focused).toBe(true);
    expect(viewOf(views, `/panel/${page.id}/`)!).toMatchObject({ visible: true, focused: false });
  } finally {
    await stub.close();
  }
});

test('switching chats swaps the page tabs; each chat returns to its own page, and a chat holding pages stays loaded', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab: first } = await launchWithBrowser(launch);
  const firstId = panelIdOf(first);
  await openSitePage(app, first, '/first-a');
  await openSitePage(app, first, '/first-b');
  const [firstA] = await browserTabs(app);
  const shell = await shellPage(app);
  await shell.locator('[data-editor-tab]', { hasText: 'Page first-a' }).click();
  await expect.poll(async () => (await activePageTab(app))?.id).toBe(firstA!.id);

  const opened = nextChat(app, [first]);
  await clickMenu(app, 'damocles.openChat');
  const second = await opened;
  await expect(chatInput(second)).toBeVisible();
  // The first chat is an empty new chat, which leaves memory once unselected unless it holds pages.
  await expect.poll(async () => titles(app)).toEqual([]);
  let views = await windowViews(app);
  expect(views.filter((view) => view.visible && view.url.includes('/panel/') && !view.url.includes(`/panel/${panelIdOf(second)}/`))).toEqual([]);
  expect(viewOf(views, `/panel/${firstId}/`)).toBeDefined();

  await openSitePage(app, second, '/second');
  await expect.poll(async () => titles(app)).toEqual(['Page second']);
  const secondPage = (await activePageTab(app))!;

  await selectChatPage(app, first);
  await expect.poll(async () => titles(app)).toEqual(['Page first-a', 'Page first-b']);
  await expect.poll(async () => (await activePageTab(app))?.id).toBe(firstA!.id);
  await expect.poll(async () => viewOf(await windowViews(app), `/panel/${firstA!.id}/`)?.visible).toBe(true);
  views = await windowViews(app);
  expect(viewOf(views, `/panel/${secondPage.id}/`)?.visible).toBe(false);
  expect(viewOf(views, `/panel/${panelIdOf(second)}/`)?.visible).toBe(false);

  await selectChatPage(app, second);
  await expect.poll(async () => (await activePageTab(app))?.id).toBe(secondPage.id);
});

test('the address bar refuses what isNavigableUrl refuses, a file tab hides the page, and F6 reaches the page tab through the editor', async ({ foreground: _foreground, home, launch }) => {
  enableBrowser(home);
  // The agent's openFile (E2E hooks) opens a file tab beside the page tab.
  const { app, tab } = await launchWithBrowser(launch, { DAMOCLES_E2E_HOOKS: '1' });
  await openSitePage(app, tab, '/start');
  const page = (await activePageTab(app))!;
  const shell = await shellPage(app);
  const address = shell.getByTestId('browser-address');

  for (const refused of ['file:///etc/hosts', 'javascript:alert(1)', 'chrome://settings']) {
    await address.fill(refused);
    await address.press('Enter');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await address.press('Escape');
  }
  // Main refuses on its own too, whatever the shell sends.
  expect(await shell.evaluate((tabId) => window.damoclesShell!.navigateBrowser({ tabId, url: 'file:///etc/hosts' }), page.id)).toBe(false);
  expect((await activePageTab(app))?.browser.url).toBe(`${site.url}/start`);

  // A typed address navigates, and the page never takes focus from the field.
  await address.fill(`${site.url}/next`);
  await address.press('Enter');
  await expect.poll(async () => (await activePageTab(app))?.title, { timeout: PAGE_TIMEOUT }).toBe('Page next');
  await expect(address).toBeFocused();
  expect(viewOf(await windowViews(app), `/panel/${page.id}/`)?.focused).toBe(false);

  // F6 from the chat lands on the editor part, where a page tab focuses its address field.
  const chatId = panelIdOf(tab);
  await pressKeys(app, `/panel/${chatId}/`, 'F6', ['shift']);
  await expect(address).toBeFocused();

  // A file tab as the active tab hides the page view while the page stays a tab; selecting the page tab shows it again.
  const file = path.join(home.project, 'notes.md');
  fs.writeFileSync(file, '# notes\n');
  await app.evaluate(async (_electron, target) => {
    const hooks = (globalThis as unknown as { __damoclesE2e: { editor: { openFile(path: string, options: object): Promise<void> } } }).__damoclesE2e;
    await hooks.editor.openFile(target, { preserveFocus: true });
  }, file);
  await expect(editorTab(shell, 'notes.md')).toHaveAttribute('aria-selected', 'true');
  await expect.poll(async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.visible).toBe(false);
  expect((await browserTabs(app)).map((candidate) => candidate.id)).toEqual([page.id]);
  await shell.locator('[data-editor-tab]', { hasText: 'Page next' }).click();
  await expect.poll(async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.visible).toBe(true);
});

// The pane glides to its new slot as a script animation, which fires no animationend, so the shell measures the page area
// again once the glide ends; with both panes showing, the grid's tracks do not change either.
test('a page tab whose pane moves with Move to from the keyboard keeps its page view on the page area of the tab', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab } = await launchWithBrowser(launch);
  await openSitePage(app, tab, '/moved');
  const page = (await activePageTab(app))!;
  const shell = await shellPage(app);
  await toggleTerminal(app);
  await expect(shell.getByTestId('terminal-pane')).toBeVisible();
  await settled(shell);
  const pageBounds = async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.bounds;
  await expect.poll(pageBounds).toEqual(await stageBounds(app));

  await shell.getByTestId('pane-grip-editor').focus();
  await shell.keyboard.press('Enter');
  await chooseMenuItem(app, 'bottom');
  await expect(shell.getByTestId('grid-pane-editor')).toHaveAttribute('data-slot', 'bottom');
  await expect(shell.getByTestId('grid-pane-terminal')).toHaveAttribute('data-slot', 'side');
  await shell.waitForTimeout(500);
  const stage = await stageBounds(app);
  expect(stage.y).toBeGreaterThan((await shell.getByTestId('grid-pane-terminal').boundingBox())!.y);
  await expect.poll(pageBounds, { timeout: 2000 }).toEqual(stage);
});

test('Open in system browser that the system cannot open says so in one toast', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab } = await launchWithBrowser(launch);
  await openSitePage(app, tab, '/start');
  // No handler for the scheme, as on Linux without xdg-open.
  await app.evaluate(({ shell }) => {
    shell.openExternal = (() => Promise.reject(new Error('No application is registered for the URL'))) as typeof shell.openExternal;
  });
  const shell = await shellPage(app);
  await shell.getByTestId('browser-open-external').click();
  const popup = await popupPage(app);
  await expect(popupToasts(popup)).toHaveCount(1);
  await expect(popupToasts(popup)).toContainText('Damocles could not open the page in the system browser.');
});

test('an address typed without a scheme tries https first, falls back to http on a TLS failure and says the page is not secure', async ({ home, launch }) => {
  enableBrowser(home);
  const desktop = await launchWithBrowser(launch, { DAMOCLES_E2E_HOOKS: '1' });
  const { app, tab } = desktop;
  await openSitePage(app, tab, '/start');
  const shell = await shellPage(app);
  const address = shell.getByTestId('browser-address');
  await expect(shell.getByTestId('browser-not-secure')).toHaveCount(0);

  // The name resolves nowhere, so both of its loads go to the http-only site: https fails its TLS handshake there.
  const requested = await app.evaluate(async (_electron, origin) => {
    const hooks = (globalThis as unknown as { __damoclesE2e: { browser(): { getActivePage(): import('patchright').Page } } }).__damoclesE2e;
    const seen: string[] = [];
    (globalThis as unknown as { __e2eFallbackRequests: string[] }).__e2eFallbackRequests = seen;
    await hooks.browser().getActivePage().context().route(/^https?:\/\/fallback\.damocles-e2e\.com\//, (route) => {
      const url = new URL(route.request().url());
      seen.push(url.href);
      return route.continue({ url: `${url.protocol}//${new URL(origin).host}${url.pathname}` });
    });
    return seen;
  }, site.url);
  expect(requested).toEqual([]);

  await address.fill('fallback.damocles-e2e.com/fell-back');
  await address.press('Enter');
  await expect.poll(async () => (await activePageTab(app))?.title, { timeout: PAGE_TIMEOUT }).toBe('Page fell-back');
  expect((await activePageTab(app))?.browser.url).toBe('http://fallback.damocles-e2e.com/fell-back');
  // Chromium may retry the TLS handshake before it gives up, so https can be asked more than once before the one http load.
  const requests = await app.evaluate(() => (globalThis as unknown as { __e2eFallbackRequests: string[] }).__e2eFallbackRequests);
  expect(requests[0]).toBe('https://fallback.damocles-e2e.com/fell-back');
  expect(requests.slice(requests.indexOf('http://fallback.damocles-e2e.com/fell-back'))).toEqual(['http://fallback.damocles-e2e.com/fell-back']);
  expect(new Set(requests.slice(0, -1))).toEqual(new Set(['https://fallback.damocles-e2e.com/fell-back']));
  await expect.poll(() => desktop.output()).toContain('[Browser] fallback.damocles-e2e.com did not load over https (net::ERR_SSL_PROTOCOL_ERROR); loading it over http');
  await expect(shell.getByTestId('browser-not-secure')).toHaveText('Not secure');
  await expect(address).toHaveAttribute('aria-describedby', 'browser-address-security');

  // An address typed with its scheme keeps it, and a loopback http page is not marked.
  await address.fill(`${site.url}/again`);
  await address.press('Enter');
  await expect.poll(async () => (await activePageTab(app))?.title, { timeout: PAGE_TIMEOUT }).toBe('Page again');
  await expect(shell.getByTestId('browser-not-secure')).toHaveCount(0);
});

test('a page tab shown again resumes its live screencast, and the header\'s open browser reveals the page at its address', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab } = await launchWithBrowser(launch, { DAMOCLES_E2E_HOOKS: '1' });
  await openSitePage(app, tab, '/ticking');
  const page = (await activePageTab(app))!;
  const shell = await shellPage(app);
  const pageView = app.windows().find((candidate) => candidate.url().includes(`/panel/${page.id}/`))!;
  await pageView.evaluate(() => {
    const w = window as unknown as { __e2eFrames: number };
    w.__e2eFrames = 0;
    window.damoclesBridge!.onMessage((m) => {
      if ((m as { type?: string }).type === 'frame') w.__e2eFrames += 1;
    });
  });
  const frames = (): Promise<number> => pageView.evaluate(() => (window as unknown as { __e2eFrames: number }).__e2eFrames);
  await expect.poll(frames, { timeout: PAGE_TIMEOUT }).toBeGreaterThan(1);

  // A file tab hides the page view, which keeps its page running and so posts no ready when shown again.
  const file = path.join(home.project, 'notes.md');
  fs.writeFileSync(file, '# notes\n');
  await app.evaluate(async (_electron, target) => {
    const hooks = (globalThis as unknown as { __damoclesE2e: { editor: { openFile(path: string, options: object): Promise<void> } } }).__damoclesE2e;
    await hooks.editor.openFile(target, { preserveFocus: true });
  }, file);
  await expect.poll(async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.visible).toBe(false);
  await pageView.evaluate(() => { (window as unknown as { __e2eFrames: number }).__e2eFrames = 0; });
  await shell.locator('[data-editor-tab]', { hasText: 'Page ticking' }).click();
  await expect.poll(async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.visible).toBe(true);
  // One frame is the replayed last frame; more are live. Under the screencast watchdog's 10 s stall restart.
  await expect.poll(frames, { timeout: 5_000 }).toBeGreaterThan(2);

  // The header's open browser after the editor pane collapsed shows the same page, not a blank one.
  await clickMenu(app, 'damocles.toggleEditor');
  await expect.poll(async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.visible).toBe(false);
  await postFromWebview(tab, { type: 'openBrowser' });
  await expect.poll(async () => viewOf(await windowViews(app), `/panel/${page.id}/`)?.visible).toBe(true);
  await expect.poll(async () => (await activePageTab(app))?.id).toBe(page.id);
  expect((await browserTabs(app)).map((candidate) => candidate.browser.url)).toEqual([`${site.url}/ticking`]);
});

test('closing a page tab closes its page; deleting a chat closes its pages; a restart restores each chat\'s pages as its tabs', async ({ home, launch }) => {
  enableBrowser(home);
  const { app, tab: first } = await launchWithBrowser(launch);
  const firstId = panelIdOf(first);
  await openSitePage(app, first, '/one');
  await openSitePage(app, first, '/two');
  const shell = await shellPage(app);
  // openSitePage waits for the address, not the title, which a later state update brings.
  const two = (await browserTabs(app)).find((candidate) => candidate.browser.url === `${site.url}/two`)!;
  await shell.locator('[data-editor-tab]', { hasText: 'Page two' }).click();
  await pressKeys(app, '/shell/', 'W', [PRIMARY]);
  await expect.poll(async () => titles(app)).toEqual(['Page one']);
  await expect.poll(() => app.evaluate(({ webContents }, id) => webContents.getAllWebContents().some((c) => c.getURL().includes(`/panel/${id}/`)), two.id)).toBe(false);

  const opened = nextChat(app, [first]);
  await clickMenu(app, 'damocles.openChat');
  const second = await opened;
  await expect(chatInput(second)).toBeVisible();
  const secondId = panelIdOf(second);
  await openSitePage(app, second, '/second-chat');

  const third = nextChat(app, [first, second]);
  await clickMenu(app, 'damocles.openChat');
  const thirdTab = await third;
  await expect(chatInput(thirdTab)).toBeVisible();
  await openSitePage(app, thirdTab, '/closed-with-chat');
  const thirdPages = (await browserTabs(app)).map((page) => page.id);
  const thirdId = await chatIdOf(app, thirdTab);
  expect(await shell.evaluate((id) => window.damoclesShell!.deleteChat(id), thirdId)).toEqual({ ok: true });
  await expect.poll(() => app.evaluate(({ webContents }, ids) => webContents.getAllWebContents().filter((c) => ids.some((id) => c.getURL().includes(`/panel/${id}/`))).length, thirdPages)).toBe(0);

  await app.close();
  const relaunched = await launch({ env: chromeEnv() });
  const firstAgain = await chatById(relaunched.app, `new:${firstId}`);
  const secondAgain = await chatById(relaunched.app, `new:${secondId}`);
  await selectChatPage(relaunched.app, firstAgain);
  await expect.poll(async () => titles(relaunched.app), { timeout: PAGE_TIMEOUT }).toEqual(['Page one']);
  await selectChatPage(relaunched.app, secondAgain);
  await expect.poll(async () => titles(relaunched.app), { timeout: PAGE_TIMEOUT }).toEqual(['Page second-chat']);
});

test('no page reaches the shell bridge, and browser channels from a page or chat view are rejected', async ({ home, launch }) => {
  enableBrowser(home);
  const desktop = await launchWithBrowser(launch);
  const { app, tab } = desktop;
  const chatId = panelIdOf(tab);
  await openSitePage(app, tab, '/isolated');
  const pageId = (await activePageTab(app))!.id;
  const pageView = app.windows().find((p) => p.url().includes(`/panel/${pageId}/`))!;

  const bridges = (page: Page) => page.evaluate(() => ({ shell: typeof window.damoclesShell, panel: typeof window.damoclesBridge }));
  expect(await bridges(pageView)).toEqual({ shell: 'undefined', panel: 'object' });
  expect(await bridges(tab)).toEqual({ shell: 'undefined', panel: 'object' });

  // A shell channel invoked from the chat or page view carries that view's real sender and frame, which main refuses.
  for (const fromPart of [`/panel/${chatId}/`, `/panel/${pageId}/`]) {
    await app.evaluate(({ ipcMain, webContents }, from) => {
      const sender = webContents.getAllWebContents().find((c) => c.getURL().includes(from))!;
      const event = { sender, senderFrame: sender.mainFrame, processId: sender.getProcessId(), frameId: sender.mainFrame.routingId, returnValue: undefined, reply: () => {} };
      ipcMain.emit('damocles:shell:browser:bounds', event, { x: 0, y: 0, width: 10, height: 10 });
    }, fromPart);
    await expect.poll(() => desktop.output()).toContain(`rejected damocles:shell:browser:bounds from "app://damocles${fromPart}index.html"`);
  }
  expect(viewOf(await windowViews(app), `/panel/${pageId}/`)?.bounds.width).not.toBe(10);
});
