import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopApp, LaunchOptions } from './support/app';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { REPO_ROOT, writeUserSettings } from './support/hermetic';
import { activePageTab, browserTabs, captureWindow, chromeEnv, openPage, PAGE_TIMEOUT, setWindowContentSize, startSite, systemChrome, type Site } from './support/browser';
import { windowSettled } from './support/screenshots';
import { shellPage } from './support/shell';
import { clickMenu, setThemeSource } from './support/ui';

// Visual record of every browser tab state, for people to look at; the behaviour is asserted in browser-tabs.spec.ts.
const SCREENS = path.join(REPO_ROOT, 'dist', 'e2e-screens', 'browser-tabs');
const HOSTILE_TITLE = `\u202E${'A very long page title that a hostile page chose to push the tab strip around '.repeat(4)}`;

test.describe.configure({ timeout: 300_000 });
test.skip(systemChrome() === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');

let site: Site;
let releaseSlow: () => void = () => {};
test.beforeAll(async () => {
  const held = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  site = await startSite((pathname) => (pathname === '/hostile' ? HOSTILE_TITLE : pathname === '/docs' ? 'Array.prototype.map() - JavaScript | MDN' : 'Example Domain'), {
    '/slow': (res) => {
      void held.then(() => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>Slow page</title>');
      });
    },
  });
});
test.afterAll(async () => {
  releaseSlow();
  await site.close();
});

async function start(launch: (options?: LaunchOptions) => Promise<DesktopApp>, theme: 'dark' | 'light', args: string[] = []): Promise<{ app: ElectronApplication; tab: Page }> {
  const { app } = await launch({ env: chromeEnv(), args });
  const tab = await activeChat(app);
  const composer = tab.locator('textarea').first();
  await expect(composer).toBeVisible();
  await setThemeSource(app, theme);
  await setWindowContentSize(app, 1280, 780);
  await composer.fill(args.length > 0 ? 'Σύγκρινε τις δύο σελίδες' : 'Compare the two pages and summarise the differences');
  return { app, tab };
}

function openSitePage(app: ElectronApplication, tab: Page, pathname: string): Promise<void> {
  return openPage(app, tab, `${site.url}${pathname}`);
}

async function shoot(app: ElectronApplication, name: string): Promise<void> {
  await windowSettled(app);
  await captureWindow(app, path.join(SCREENS, `${name}.png`));
}

for (const theme of ['dark', 'light'] as const) {
  test(`screens: every browser tab state (${theme})`, async ({ home, launch }) => {
    writeUserSettings(home, { 'damocles.browser.enabled': true });
    const { app, tab } = await start(launch, theme);
    const shell = await shellPage(app);

    await openSitePage(app, tab, '/');
    await shoot(app, `${theme}-01-page-tab`);

    await openSitePage(app, tab, '/docs');
    await shoot(app, `${theme}-02-two-page-tabs`);

    const address = shell.getByRole('textbox', { name: 'Address' });
    await address.fill('file:///etc/hosts');
    await address.press('Enter');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await shoot(app, `${theme}-03-address-refused`);
    await address.press('Escape');

    await address.fill(`${site.url}/slow`);
    await address.press('Enter');
    await expect.poll(async () => (await activePageTab(app))?.browser.loading, { timeout: PAGE_TIMEOUT }).toBe(true);
    await shoot(app, `${theme}-04-loading`);

    await openSitePage(app, tab, '/hostile');
    await shoot(app, `${theme}-05-hostile-title`);

    await shell.getByTestId('editor-focus-toggle').click();
    await expect(shell.getByTestId('focus-overlay-scrim')).toBeVisible();
    await shoot(app, `${theme}-06-focus-overlay`);
    await shell.keyboard.press('Escape');
    await expect(shell.getByTestId('focus-overlay-scrim')).toHaveCount(0);

    await setWindowContentSize(app, 900, 700);
    await shoot(app, `${theme}-07-narrow-window`);
    await setWindowContentSize(app, 1280, 780);

    const opened = nextChat(app, [tab]);
    await clickMenu(app, 'damocles.openChat');
    await expect((await opened).locator('textarea').first()).toBeVisible();
    await expect.poll(async () => (await browserTabs(app)).length).toBe(0);
    await shoot(app, `${theme}-08-second-chat-no-pages`);
  });
}

test('screens: Greek', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.browser.enabled': true });
  const { app, tab } = await start(launch, 'dark', ['--lang=el-GR']);
  await openSitePage(app, tab, '/');
  await openSitePage(app, tab, '/docs');
  const shell = await shellPage(app);
  await expect(shell.getByRole('textbox', { name: 'Διεύθυνση' })).toBeVisible();
  await shoot(app, 'greek-01-two-page-tabs');
  await setThemeSource(app, 'light');
  await shoot(app, 'greek-02-two-page-tabs-light');
});
