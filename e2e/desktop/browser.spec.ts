import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { activeChat, expect, panelIdOf, test } from './support/fixtures';
import { seedStubModel, writeUserSettings } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { browserTabs, chromeEnv, startSite, systemChrome } from './support/browser';
import { closeSettingsModal, settingsNav } from './support/settings';
import { listChats } from './support/shell-ui';
import { answerToast, overlayPage, pressKeys, recordedToasts, recordToasts, shellPage, shellState } from './support/shell';
import { chatInput, hostMessages, postFromWebview, recordHostMessages } from './support/ui';

const PAGE_TITLE = 'E2E Browser Page';
const DOWNLOAD_BODY = 'e2e download body';
// Text of the DevTools notice in src/core/browser/index.ts.
const DEVTOOLS_OFF = 'DevTools is unavailable because the debugging port is disabled';

function filesUnder(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

async function framesReceived(page: Page): Promise<number> {
  return page.evaluate(() => ((window as unknown as { __e2eFrames?: number }).__e2eFrames ?? 0));
}

test('browser page as an editor tab: opens, screencasts, picks an element, downloads a file, and F12 offers the settings when the DevTools port is off', async ({ home, launch }) => {
  const chrome = systemChrome();
  test.skip(chrome === undefined, 'No system-wide Chrome or Edge is installed on this runner, and the browser feature launches the installed browser by channel.');
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  const site = await startSite(() => PAGE_TITLE, {
    '/report.txt': (res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="report.txt"' });
      res.end(DOWNLOAD_BODY);
    },
  });
  try {
    seedStubModel(home, stub.baseUrl);
    writeUserSettings(home, { 'damocles.browser.enabled': true });
    const { app } = await launch({ env: chromeEnv() });
    const homeTab = await activeChat(app);
    await expect(chatInput(homeTab)).toBeVisible();
    await recordHostMessages(homeTab);
    await recordToasts(app);

    // The page opens once Chrome has launched, which a cold profile can take well past the default event timeout.
    const opened = app.waitForEvent('window', { predicate: (p) => p.url().includes('/panel/') && p !== homeTab, timeout: 90_000 });
    await postFromWebview(homeTab, { type: 'openBrowser' });
    const browserPage = await opened;
    const browserId = panelIdOf(browserPage);
    const homeId = panelIdOf(homeTab);
    const shell = await shellPage(app);
    const address = shell.getByRole('textbox', { name: 'Address' });
    await address.fill(`${site.url}/`);
    await address.press('Enter');

    // Screencast frames arrive as binary through the tab's own channel.
    await browserPage.evaluate(() => {
      const w = window as unknown as { __e2eFrames?: number };
      w.__e2eFrames = 0;
      window.damoclesBridge!.onMessage((m) => {
        const frame = m as { type?: string; bytes?: unknown };
        if (frame.type === 'frame' && frame.bytes instanceof ArrayBuffer && frame.bytes.byteLength > 0) w.__e2eFrames! += 1;
      });
    });
    await expect.poll(() => framesReceived(browserPage), { timeout: 60_000 }).toBeGreaterThan(0);
    // The page is an editor tab of its chat, never a chat of its own, and the chat stays selected.
    await expect.poll(async () => (await browserTabs(app)).map((tab) => ({ id: tab.id, title: tab.title }))).toEqual([{ id: browserId, title: PAGE_TITLE }]);
    const homeChatId = (await shellState(app)).selected.chatId;
    expect(panelIdOf(await activeChat(app))).toBe(homeId);
    const listed = (await listChats(app)).chats.filter((chat) => chat.loaded).map((chat) => chat.id);
    expect(listed).toEqual([homeChatId]);

    // F12 opens DevTools for the active page tab, wherever focus is; with the debugging port off it offers the settings, which open on Tools & integrations.
    await pressKeys(app, `/panel/${homeId}/`, 'F12');
    await expect.poll(async () => (await recordedToasts(app)).find((t) => t.message.startsWith(DEVTOOLS_OFF))?.actions).toEqual(['Open Settings']);
    const devtools = (await recordedToasts(app)).find((t) => t.message.startsWith(DEVTOOLS_OFF))!;
    await answerToast(app, devtools.id, 'Open Settings');
    const settingsOverlay = await overlayPage(app);
    await expect(settingsNav(settingsOverlay, 'integrations')).toHaveAttribute('aria-selected', 'true');
    await closeSettingsModal(settingsOverlay);
    await expect.poll(async () => (await shellState(app)).selected.chatId).toBe(homeChatId);

    // Element picker: the navigation bar's pick button, then a click on the page through the screencast input path.
    const pick = shell.getByRole('button', { name: 'Pick an element for the chat' });
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
    const at = { x: 120, y: 120, modifiers: 0 };
    await expect.poll(async () => {
      await postFromWebview(browserPage, { type: 'mousemove', ...at, buttons: 0 });
      await postFromWebview(browserPage, { type: 'mousedown', ...at, button: 0, buttons: 1, clickCount: 1 });
      await postFromWebview(browserPage, { type: 'mouseup', ...at, button: 0, buttons: 0, clickCount: 1 });
      return (await hostMessages(homeTab, 'browserElementPicked')).length;
    }, { timeout: 30_000 }).toBeGreaterThan(0);
    const picked = (await hostMessages(homeTab, 'browserElementPicked'))[0]!['element'] as { tagName: string; selector: string };
    expect(picked.tagName.toLowerCase()).toBe('button');
    expect(picked.selector).toContain('target');

    await expect(pick).toHaveAttribute('aria-pressed', 'false');

    // Download: navigating the address field to an attachment saves it under the hermetic home's browser downloads.
    await address.fill(`${site.url}/report.txt`);
    await address.press('Enter');
    const downloads = path.join(home.damoclesDir, 'browser-downloads');
    await expect.poll(() => filesUnder(downloads).filter((file) => fs.readFileSync(file, 'utf8') === DOWNLOAD_BODY).length, { timeout: 30_000 }).toBe(1);
  } finally {
    await site.close();
    await stub.close();
  }
});
