import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { forgeEnv, inAccounts, launchReady, startStubOnTestCa, tokenSignIn } from '../support/forge';
import { CI_FIXTURES } from '../support/forge-stub';
import { expect, test } from '../support/fixtures';
import { git, initRepo } from '../support/git';
import { seedStubModel } from '../support/hermetic';
import { call, startOpenAIStub } from '../support/openai-stub';
import { closeWindowAt, hideEditorPane, openProjectChat, saveScreenshot, setPageSize, settled, showTheme, THEMES } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { chatInput } from '../support/ui';

// Visual parity captures of the approval card for a forge write, at the design's checked widths in both themes, beside the
// same captures of the design's own screens/S9-agent.html. The stub's gitlab.com and alexios-s/damocles stand for
// gitlab.indigital.gr and grp/damocles.

const WIDTHS = [390, 768, 1280] as const;
const HEIGHT = 900;
// the approved design's screens/S9-agent.html, outside the repository; its captures are skipped without it
const DESIGN_SCREEN = process.env.DAMOCLES_E2E_DESIGN_SCREEN;
const COMMENT = 'Pushed the fix in 4e1a9c2: refresh now runs once per account and persists the rotated token before first use. Ready for review.';

/** Sizes the window, or below its minimum width emulates `width` on `tab` alone. */
async function sizeTo(app: ElectronApplication, tab: Page, width: number): Promise<void> {
  if (width < 768) {
    await setPageSize(tab, width, HEIGHT);
    return;
  }
  await (await tab.context().newCDPSession(tab)).send('Emulation.clearDeviceMetricsOverride');
  await setContentSize(app, width, HEIGHT);
  await settled(tab);
}

async function designCaptures(app: ElectronApplication, testInfo: TestInfo): Promise<void> {
  if (DESIGN_SCREEN === undefined || !fs.existsSync(DESIGN_SCREEN)) {
    testInfo.annotations.push({ type: 'reference', description: `${DESIGN_SCREEN ?? 'DAMOCLES_E2E_DESIGN_SCREEN'} is absent; skipped the design captures` });
    return;
  }
  const url = pathToFileURL(DESIGN_SCREEN).href;
  const opened = app.waitForEvent('window', (page) => page.url().startsWith(url));
  await app.evaluate(({ BrowserWindow }, [target, height]) => {
    const win = new BrowserWindow({ width: 1280, height, show: true, webPreferences: { partition: 'design-capture' } });
    void win.loadURL(target);
  }, [url, HEIGHT] as const);
  const design = await opened;
  // the screen file shows every state's parts at once; the design tool hides all but the default state's
  await design.addStyleTag({ content: '[data-ds-state-only]:not([data-ds-state-only~="default"]){display:none!important}' });
  try {
    for (const width of WIDTHS) {
      await setPageSize(design, width, HEIGHT);
      for (const theme of THEMES) {
        await design.getByRole('radio', { name: theme === 'dark' ? 'Dark' : 'Light', exact: true }).click();
        await settled(design);
        await saveScreenshot(design, testInfo, `design-s9-${width}-${theme}`);
        await saveScreenshot(design, testInfo, `design-s9-card-${width}-${theme}`, design.locator('#perm'));
      }
    }
  } finally {
    await closeWindowAt(app, url);
  }
}

test('forge write approval card in Dark and Light at 390, 768 and 1280 px, beside the design\'s own screen', async ({ home, launch }, testInfo: TestInfo) => {
  test.setTimeout(600_000);
  const started = await startStubOnTestCa(home);
  const { stub } = started;
  const openai = await startOpenAIStub();
  try {
    seedStubModel(home, openai.baseUrl);
    const { app } = await launchReady(launch, forgeEnv(started));
    await inAccounts(app, (overlay) => tokenSignIn(overlay, 'gitlab.com', 'glpat-stubAlexiosSApi000000008', 'alexios-s'));

    const dir = path.join(home.root, 'projects', 'damocles');
    await initRepo(home, dir);
    await git(home, dir, 'remote', 'add', 'origin', `${stub.gitlab.webUrl}/alexios-s/damocles.git`);
    const tab = await openProjectChat(app, dir);
    await hideEditorPane(app, tab);
    openai.replies.push(call('ToolSearch', { tools: ['forge'] }), call('ForgeComment', { number: CI_FIXTURES.mergeRequest.number, body: COMMENT }));
    await chatInput(tab).fill('Comment on !45 that it is ready for review.');
    await chatInput(tab).press('Enter');
    const card = tab.getByTestId('permission-card');
    await expect(tab.getByRole('listbox', { name: 'Comment on merge request !45?', exact: true })).toBeVisible({ timeout: 30_000 });

    for (const width of WIDTHS) {
      await sizeTo(app, tab, width);
      for (const theme of THEMES) {
        await showTheme(app, tab, theme);
        await saveScreenshot(tab, testInfo, `app-s9-${width}-${theme}`);
        await saveScreenshot(tab, testInfo, `app-s9-card-${width}-${theme}`, card);
      }
    }
    await designCaptures(app, testInfo);
  } finally {
    await openai.close();
    await stub.close();
  }
});
