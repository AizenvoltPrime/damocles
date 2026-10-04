import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import type { DesktopApp, LaunchOptions } from './support/app';
import { activeChat, expect, nextChat, panelIdOf, test } from './support/fixtures';
import { REPO_ROOT, writeUserSettings } from './support/hermetic';
import { captureWindow, chromeEnv, openPage, panePage, paneState, setWindowContentSize, startSite, systemChrome, type Site } from './support/pane';
import { shellPage } from './support/shell';
import { clickMenu, setThemeSource } from './support/ui';

// Visual record of every pane state, for people to look at; the behaviour is asserted in browser-pane.spec.ts.
const SCREENS = path.join(REPO_ROOT, 'dist', 'e2e-screens', 'side-pane');
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

function openSitePage(app: ElectronApplication, tab: Page, pathname: string, newPageName?: string): Promise<void> {
  return openPage(app, tab, `${site.url}${pathname}`, newPageName);
}

// Lets the entry animation and the first screencast frames settle before a capture.
async function shoot(app: ElectronApplication, name: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 900));
  await captureWindow(app, path.join(SCREENS, `${name}.png`));
}

for (const theme of ['dark', 'light'] as const) {
  test(`screens: every pane state (${theme})`, async ({ home, launch }) => {
    writeUserSettings(home, { 'damocles.browser.enabled': true });
    const { app, tab } = await start(launch, theme);
    const shell = await shellPage(app);

    await shell.getByRole('button', { name: 'Browser pane' }).click();
    await expect.poll(async () => (await paneState(app)).mode).toBe('split');
    await shoot(app, `${theme}-01-empty`);

    await openSitePage(app, tab, '/');
    await shoot(app, `${theme}-02-pane-open`);

    await openSitePage(app, tab, '/docs');
    await shoot(app, `${theme}-03-two-pages`);

    const pane = await panePage(app);
    await pane.getByRole('separator').focus();
    await pane.keyboard.press('ArrowLeft');
    await shoot(app, `${theme}-04-divider-focused`);

    const address = pane.getByRole('textbox', { name: 'Address' });
    await address.fill('file:///etc/hosts');
    await address.press('Enter');
    await expect(address).toHaveAttribute('aria-invalid', 'true');
    await shoot(app, `${theme}-05-address-refused`);
    await address.press('Escape');

    await address.fill(`${site.url}/slow`);
    await address.press('Enter');
    await expect.poll(async () => (await paneState(app)).pages.some((page) => page.loading)).toBe(true);
    await shoot(app, `${theme}-06-loading`);

    await openSitePage(app, tab, '/hostile');
    await shoot(app, `${theme}-07-hostile-title`);

    await pane.getByRole('button', { name: 'Maximize pane' }).click();
    await expect.poll(async () => (await paneState(app)).mode).toBe('maximized');
    await shoot(app, `${theme}-08-maximized`);
    await pane.getByRole('button', { name: 'Restore side-by-side view' }).click();
    await expect.poll(async () => (await paneState(app)).mode).toBe('split');

    await pane.getByRole('button', { name: 'Hide browser pane' }).click();
    await expect.poll(async () => (await paneState(app)).mode).toBe('collapsed');
    await shell.mouse.move(600, 400);
    await shoot(app, `${theme}-09-collapsed-toolbar-button`);

    await shell.getByRole('button', { name: 'Browser pane' }).click();
    await setWindowContentSize(app, 820, 700);
    await expect.poll(async () => (await paneState(app)).mode).toBe('overlay');
    await shoot(app, `${theme}-10-narrow-overlay`);

    await setWindowContentSize(app, 1280, 780);
    const opened = nextChat(app, [tab]);
    await clickMenu(app, 'damocles.openChat');
    await expect((await opened).locator('textarea').first()).toBeVisible();
    await expect.poll(async () => (await paneState(app)).mode).toBe('collapsed');
    await shoot(app, `${theme}-11-second-chat-own-pane`);
    expect(panelIdOf(tab)).not.toBe((await paneState(app)).chatTabId);
  });
}

test('screens: Greek', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.browser.enabled': true });
  const { app, tab } = await start(launch, 'dark', ['--lang=el-GR']);
  const shell = await shellPage(app);
  await shell.getByRole('button', { name: 'Πλαίσιο περιήγησης' }).click();
  await expect.poll(async () => (await paneState(app)).mode).toBe('split');
  await shoot(app, 'greek-01-empty');
  await openSitePage(app, tab, '/', 'Νέα σελίδα');
  await openSitePage(app, tab, '/docs', 'Νέα σελίδα');
  await shoot(app, 'greek-02-two-pages');
  await setThemeSource(app, 'light');
  await setWindowContentSize(app, 820, 700);
  await expect.poll(async () => (await paneState(app)).mode).toBe('overlay');
  await shoot(app, 'greek-03-narrow-overlay-light');
});
