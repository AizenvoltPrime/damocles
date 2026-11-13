import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import type { ForgeStub } from '../support/forge-stub';
import { blameCard, blameLine3, detailRow, expandHead, launchHistory } from '../support/forge-history';
import { expect, test } from '../support/fixtures';
import { saveScreenshot, setPageSize, settled, showTheme, THEMES, windowShot } from '../support/screenshots';
import { setSection } from '../support/scm';
import { setContentSize } from '../support/settings';
import { shellPage } from '../support/shell';
import { clickMenu } from '../support/ui';

// Visual parity captures of the history details ( Graph avatars, the expanded commit's links and "Merged in !45",
// the blame card) at the design's checked widths, in both themes, against the forge stub's self-managed GitLab.

/** Each width and theme, named `${name}-${width}-${theme}`: the window at 768 and 1280 px, the shell alone emulated at 390 px. */
async function everyWidth(app: ElectronApplication, testInfo: TestInfo, name: string, shell: Page, widths: readonly number[], show: () => Promise<void> = async () => {}): Promise<void> {
  for (const width of widths) {
    const emulated = width < 768;
    if (emulated) await setPageSize(shell, width, 900);
    else await setContentSize(app, width, 900);
    for (const theme of THEMES) {
      await showTheme(app, await shellPage(app), theme);
      await show();
      if (emulated) await saveScreenshot(shell, testInfo, `${name}-${width}-${theme}`);
      else await windowShot(app, testInfo, `${name}-${width}-${theme}`);
    }
    if (emulated) await (await shell.context().newCDPSession(shell)).send('Emulation.clearDeviceMetricsOverride');
  }
}

/** Moves the sidebar's edge to `px` CSS px from the window's left. */
async function sidebarTo(shell: Page, px: number): Promise<void> {
  const sash = (await shell.getByTestId('sidebar-sash').boundingBox())!;
  await shell.mouse.move(sash.x + sash.width / 2, sash.y + 40);
  await shell.mouse.down();
  await shell.mouse.move(px, sash.y + 40, { steps: 6 });
  await shell.mouse.up();
  await settled(shell);
}

test('history details in Dark and Light at 390, 768 and 1280 px', async ({ foreground: _foreground, home, launch }, testInfo: TestInfo) => {
  test.setTimeout(600_000);
  let stub: ForgeStub | undefined;
  try {
    const run = await launchHistory(launch, home, 1280, {}, (started) => (stub = started));
    const { app, shell } = run;
    await expandHead(shell);
    await expect(detailRow(shell, 'status')).toHaveAccessibleName('Pipeline #4312 passed, Merged in !45', { timeout: 30_000 });
    await blameLine3(run);
    // the design's sidebar: the Graph alone at 24rem, so rows keep their avatar and author and the status row shows
    for (const section of ['sidebar-projects', 'sidebar-chats', 'files-section', 'scm-section']) await setSection(shell, section, false);
    await sidebarTo(shell, 384);

    // the Graph with avatars and the expanded commit
    await everyWidth(app, testInfo, 's6-history', shell, [390, 768, 1280]);
    // the blame card over the code, opened again at each size since a layout change closes it
    await everyWidth(app, testInfo, 's6-blame-card', shell, [768, 1280], async () => {
      await clickMenu(app, 'damocles.git.showLineBlame');
      await expect(blameCard(shell)).toBeVisible();
      await expect(blameCard(shell).getByTestId('blame-card-merged')).toBeVisible({ timeout: 30_000 });
    });
  } finally {
    await stub?.close();
  }
});
