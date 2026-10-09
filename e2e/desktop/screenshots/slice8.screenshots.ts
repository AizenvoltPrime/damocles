import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { activeChat, expect, nextChat, selectChatPage, test } from '../support/fixtures';
import { writeUserSettings } from '../support/hermetic';
import { activePageTab, browserTabs, chromeEnv, openPage, PAGE_TIMEOUT, pageFramesShown, setWindowContentSize, startSite, systemChrome, type Site } from '../support/browser';
import { saveWindowScreenshot, settled, showTheme, THEMES } from '../support/screenshots';
import { overlayPage, shellPage } from '../support/shell';
import { chatInput, clickMenu } from '../support/ui';

// Review captures for slice 8 (browser pages as editor tabs), dark and light.
const WIDTH = 1440;
const HEIGHT = 900;
const DOCS_TITLE = 'Array.prototype.map() - JavaScript | MDN';

test.describe.configure({ mode: 'serial' });
test.setTimeout(600_000);
test.skip(systemChrome() === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');

// A page that answers after a few seconds, long enough to capture its load.
const SLOW_MS = 6000;

let site: Site;
test.beforeAll(async () => {
  site = await startSite((pathname) => (pathname === '/docs' ? DOCS_TITLE : pathname === '/pricing' ? 'Pricing - Acme' : 'Acme dashboard'), {
    '/slow': (res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Slow page</title><h1 style="font:24px sans-serif;margin:24px">Slow page</h1>');
      }, SLOW_MS);
    },
  });
});
test.afterAll(async () => {
  await site.close();
});

// Waits for the shell's entrance and the page's screencast frame; a running load line never settles, so a loading shot skips it.
async function shoot(app: ElectronApplication, testInfo: TestInfo, name: string, wait = true): Promise<void> {
  if (wait) await settled(await shellPage(app));
  await pageFramesShown(app);
  await saveWindowScreenshot(app, testInfo, name);
}

async function selectPageTab(shell: Page, title: string): Promise<void> {
  await shell.locator('[data-editor-tab]', { hasText: title }).click();
  await expect(shell.locator('[data-editor-tab][aria-selected="true"]', { hasText: title })).toBeVisible();
}

test('slice 8 captures', async ({ home, launch }, testInfo) => {
  writeUserSettings(home, { 'damocles.browser.enabled': true });
  const { app } = await launch({ env: chromeEnv() });
  const first = await activeChat(app);
  await expect(chatInput(first)).toBeVisible();
  await setWindowContentSize(app, WIDTH, HEIGHT);
  await chatInput(first).fill('Check the dashboard and the docs, then compare the pricing page');
  const shell = await shellPage(app);
  const overlay = await overlayPage(app);

  await openPage(app, first, `${site.url}/`);
  await openPage(app, first, `${site.url}/docs`);

  const opened = nextChat(app, [first]);
  await clickMenu(app, 'damocles.openChat');
  const second = await opened;
  await expect(chatInput(second)).toBeVisible();
  await chatInput(second).fill('Review the pricing page copy');
  await openPage(app, second, `${site.url}/pricing`);

  for (const theme of THEMES) {
    await showTheme(app, shell, theme);
    const t = (name: string): string => `${name}-${theme}`;

    // Chat A and chat B: each chat shows its own page tabs.
    await selectChatPage(app, first);
    await expect.poll(async () => (await browserTabs(app)).map((tab) => tab.title)).toEqual(['Acme dashboard', DOCS_TITLE]);
    await selectPageTab(shell, DOCS_TITLE);
    await shoot(app, testInfo, t('chat-a-page-tabs'));
    await selectChatPage(app, second);
    await expect.poll(async () => (await browserTabs(app)).map((tab) => tab.title)).toEqual(['Pricing - Acme']);
    await shoot(app, testInfo, t('chat-b-page-tabs'));

    // A loaded page, then the same tab while a slow page loads: the load line under the navigation bar and the tab's spinner.
    await selectChatPage(app, first);
    await selectPageTab(shell, 'Acme dashboard');
    await shoot(app, testInfo, t('page-loaded'));
    const address = shell.getByTestId('browser-address');
    await address.click();
    await address.fill(`${site.url}/slow`);
    await address.press('Enter');
    await expect.poll(async () => (await activePageTab(app))?.browser.loading, { timeout: PAGE_TIMEOUT }).toBe(true);
    await expect(shell.getByTestId('browser-progress')).toHaveAttribute('data-phase', 'loading');
    await shoot(app, testInfo, t('page-loading'), false);
    await expect.poll(async () => (await activePageTab(app))?.title, { timeout: PAGE_TIMEOUT }).toBe('Slow page');
    await address.fill(`${site.url}/`);
    await address.press('Enter');
    await expect.poll(async () => (await activePageTab(app))?.title, { timeout: PAGE_TIMEOUT }).toBe('Acme dashboard');

    // The address bar refusing a file: address, the error state.
    await address.fill('file:///etc/hosts');
    await address.press('Enter');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await shoot(app, testInfo, t('address-refused'));
    await address.press('Escape');

    // The tab context menu of a page tab.
    await shell.locator('[data-editor-tab]', { hasText: DOCS_TITLE }).click({ button: 'right' });
    await expect(overlay.getByRole('menuitem', { name: 'Copy URL' })).toBeVisible();
    await settled(overlay);
    await shoot(app, testInfo, t('page-tab-context-menu'));
    await overlay.keyboard.press('Escape');
    await expect(overlay.getByRole('menuitem', { name: 'Copy URL' })).toHaveCount(0);

    // A page tab in the focus overlay.
    await selectPageTab(shell, DOCS_TITLE);
    await shell.getByTestId('editor-focus-toggle').click();
    await expect(shell.getByTestId('focus-overlay-scrim')).toBeVisible();
    await shoot(app, testInfo, t('page-focus-overlay'));
    await shell.keyboard.press('Escape');
    await expect(shell.getByTestId('focus-overlay-scrim')).toHaveCount(0);
  }
});
