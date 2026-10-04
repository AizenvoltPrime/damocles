import { execFileSync } from 'node:child_process';
import type { Page, TestInfo } from '@playwright/test';
import { expect, test } from '../support/fixtures';
import { seedStubModel } from '../support/hermetic';
import { startOpenAIStub } from '../support/openai-stub';
import { openProjectChat, saveScreenshot, setPageSize, settled, showTheme, THEMES, type Theme } from '../support/screenshots';
import { setContentSize } from '../support/settings';
import { chatInput, sendAndAwaitEcho } from '../support/ui';

// Review captures of the chat header, empty state and composer popups (slice 4).

// The header folds at 720px and 560px of panel width; one capture inside each band.
const WIDTHS = [['wide', 900], ['roomy', 640], ['narrow', 480]] as const;
const HEIGHT = 760;

async function setChatWidth(tab: Page, width: number): Promise<void> {
  await setPageSize(tab, width, HEIGHT);
  await expect.poll(() => tab.getByTestId('chat-header').getAttribute('data-width')).toBe(width >= 720 ? 'wide' : width >= 560 ? 'roomy' : 'narrow');
  await settled(tab);
}

async function capturePopup(tab: Page, testInfo: TestInfo, name: string, open: () => Promise<void>, popup: string): Promise<void> {
  await open();
  await expect(tab.getByTestId(popup)).toBeVisible();
  await settled(tab);
  await saveScreenshot(tab, testInfo, name);
  await tab.keyboard.press('Escape');
  await expect(tab.getByTestId(popup)).toHaveCount(0);
}

async function capture(tab: Page, testInfo: TestInfo, theme: Theme): Promise<void> {
  for (const [band, width] of WIDTHS) {
    await setChatWidth(tab, width);
    await saveScreenshot(tab, testInfo, `chrome-header-${band}-${width}-${theme}`);
  }

  await setChatWidth(tab, 480);
  await tab.getByTestId('chat-header-more').click();
  await expect(tab.getByRole('menu')).toBeVisible();
  await settled(tab);
  await saveScreenshot(tab, testInfo, `chrome-more-menu-narrow-${theme}`);
  await tab.keyboard.press('Escape');
  await expect(tab.getByRole('menu')).toHaveCount(0);

  await setChatWidth(tab, 900);
  await tab.getByTestId('chat-header-more').click();
  await expect(tab.getByRole('menu')).toBeVisible();
  await settled(tab);
  await saveScreenshot(tab, testInfo, `chrome-more-menu-wide-${theme}`);
  await tab.keyboard.press('Escape');
  await expect(tab.getByRole('menu')).toHaveCount(0);

  await capturePopup(tab, testInfo, `chrome-model-popover-${theme}`, () => tab.getByTestId('composer-model').click(), 'composer-model-menu');
  await capturePopup(tab, testInfo, `chrome-status-strip-menu-${theme}`, () => tab.getByTestId('composer-context').click(), 'composer-context-menu');

  await chatInput(tab).fill('@');
  await expect(tab.getByRole('listbox', { name: 'Files and agents to mention' }).getByRole('option').first()).toBeVisible();
  await settled(tab);
  await saveScreenshot(tab, testInfo, `chrome-autocomplete-${theme}`);
  await chatInput(tab).fill('');
}

test('chat panel header, empty state and composer popups in Dark and Light', async ({ home, launch }, testInfo) => {
  test.setTimeout(240_000);
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: home.project, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  const stub = await startOpenAIStub();
  try {
    seedStubModel(home, stub.baseUrl);
    const { app } = await launch();
    const tab = await openProjectChat(app, home.project);
    await setContentSize(app, 1280, 820);

    for (const theme of THEMES) {
      await showTheme(app, tab, theme);
      await setChatWidth(tab, 900);
      await expect(tab.getByTestId('empty-state')).toBeVisible();
      await settled(tab);
      await saveScreenshot(tab, testInfo, `chrome-empty-state-${theme}`);
    }

    await showTheme(app, tab, 'dark');
    await sendAndAwaitEcho(tab, 'Rate-limit the /login route');
    await sendAndAwaitEcho(tab, 'Add a test for the 429 case');
    for (const theme of THEMES) {
      await showTheme(app, tab, theme);
      await capture(tab, testInfo, theme);
    }
  } finally {
    await stub.close();
  }
});
