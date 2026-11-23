import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import type { DesktopApp, LaunchOptions } from './support/app';
import { expect, test } from './support/fixtures';
import { git } from './support/git';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize, settled } from './support/screenshots';
import { setContentSize } from './support/settings';
import { shellPage } from './support/shell';
import { chatInput, horizontalOverflow, pageOverflow, sendAndAwaitEcho } from './support/ui';

// The chat page at VS Code font sizes above the 13px default: every webview size is rem (docs/invariants.md "Design
// tokens"), so the panel scales without overflowing or clipping, and its container breakpoints move with the font.

const FONT_SIZES = [16, 20] as const;
// The narrowest panel a host allows: VS Code's side bar and secondary side bar (170px); desktop's narrowest grid column is 300px.
const MIN_PANEL_WIDTH = 170;
const WIDTHS = [900, 480, 360, MIN_PANEL_WIDTH] as const;
const HEIGHT = 820;
const LONG_MODEL_NAME = 'Stub model with a display name long enough to need truncating';
const LONG_PROJECT_NAME = 'a-project-folder-whose-name-is-long-enough-to-need-truncating';

/** Sets the host font the way VS Code's `--vscode-font-size` reaches the page; null restores the theme's 13px. */
async function setHostFont(tab: Page, px: number | null): Promise<void> {
  await tab.evaluate((size) => {
    if (size === null) document.documentElement.style.removeProperty('--d-font-size');
    else document.documentElement.style.setProperty('--d-font-size', `${size}px`);
  }, px);
  await settled(tab);
}

/** How the composer's text box clips its text: sideways, or downwards while it is still under its height cap. */
async function inputClipping(tab: Page): Promise<string[]> {
  return chatInput(tab).evaluate((el: HTMLTextAreaElement) => {
    const found: string[] = [];
    const style = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth) found.push(`text box scrolls sideways (${el.scrollWidth} > ${el.clientWidth})`);
    const capped = el.getBoundingClientRect().height >= Number.parseFloat(style.maxHeight) - 1;
    if (!capped && el.scrollHeight - el.clientHeight > 1) found.push(`text box clips its text (${el.scrollHeight} > ${el.clientHeight})`);
    if (capped && style.overflowY !== 'auto') found.push(`a capped text box does not scroll (overflow-y ${style.overflowY})`);
    return found;
  });
}

async function expectScreenFits(tab: Page, label: string): Promise<void> {
  for (const width of WIDTHS) {
    await setPageSize(tab, width, HEIGHT);
    expect(await horizontalOverflow(tab), `${label} at ${width}px`).toEqual([]);
    expect(await inputClipping(tab), `${label} at ${width}px`).toEqual([]);
  }
}

/** The chat of a git project with a long folder name, on the stub model under a long display name. */
async function openChat(home: HermeticHome, launch: (options?: LaunchOptions) => Promise<DesktopApp>, stubUrl: string): Promise<Page> {
  seedStubModel(home, stubUrl);
  const models = path.join(home.agentDir, 'models.json');
  const config = JSON.parse(fs.readFileSync(models, 'utf8'));
  config.providers.openai.models[0].name = LONG_MODEL_NAME;
  fs.writeFileSync(models, JSON.stringify(config, null, 2));
  const project = path.join(path.dirname(home.project), LONG_PROJECT_NAME);
  fs.mkdirSync(project);
  await git(home, project, 'init', '-q', '-b', 'main');
  await git(home, project, 'commit', '-q', '--allow-empty', '-m', 'init');
  const { app } = await launch();
  const tab = await openProjectChat(app, project);
  await setContentSize(app, 1280, HEIGHT);
  await expect(tab.getByTestId('empty-state')).toBeVisible();
  return tab;
}

/** The narrowest page width, to 1px, at which the composer's model button shows its label (`@max-[32.5rem]:hidden`). */
async function modelLabelBreakpoint(tab: Page): Promise<number> {
  const label = tab.getByTestId('composer-model').locator('span.truncate');
  let hidden = 300;
  let shown = 1600;
  await setPageSize(tab, shown, HEIGHT);
  await expect(label).toBeVisible();
  await setPageSize(tab, hidden, HEIGHT);
  await expect(label).toBeHidden();
  while (shown - hidden > 1) {
    const mid = Math.floor((hidden + shown) / 2);
    await setPageSize(tab, mid, HEIGHT);
    if (await label.isVisible()) shown = mid;
    else hidden = mid;
  }
  return shown;
}

test('the chat page scales with the host font without overflowing, clipping its input, or keeping px breakpoints', async ({ home, launch }) => {
  test.setTimeout(300_000);
  const stub = await startOpenAIStub();
  try {
    const tab = await openChat(home, launch, stub.baseUrl);

    const base = await modelLabelBreakpoint(tab);
    for (const size of FONT_SIZES) {
      await setHostFont(tab, size);
      await expectScreenFits(tab, `the empty chat at ${size}px`);
      const scaled = await modelLabelBreakpoint(tab);
      expect(scaled, `the model label's breakpoint at ${size}px against ${base}px at 13px`).toBeGreaterThan(base);
      expect(Math.abs(scaled / base - size / 13), `the breakpoint follows the font (${scaled} / ${base})`).toBeLessThan(0.02);
    }

    await setHostFont(tab, null);
    await sendAndAwaitEcho(tab, 'Rate-limit the /login route');
    await sendAndAwaitEcho(tab, 'Add a test for the 429 case');
    for (const size of FONT_SIZES) {
      await setHostFont(tab, size);
      await expectScreenFits(tab, `the conversation at ${size}px`);

      await chatInput(tab).fill(`Three lines\nof a draft that wraps ${'and keeps going '.repeat(12)}\nend`);
      await expectScreenFits(tab, `a three-line draft at ${size}px`);
      await chatInput(tab).fill(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n'));
      await settled(tab);
      const cap = await chatInput(tab).evaluate((el: HTMLTextAreaElement) => ({
        height: el.getBoundingClientRect().height,
        rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
        scrolls: el.scrollHeight > el.clientHeight,
      }));
      expect(cap.height, `the composer's cap at ${size}px is 12.5rem`).toBeCloseTo(12.5 * cap.rem, 0);
      expect(cap.scrolls).toBe(true);
      await expectScreenFits(tab, `a capped draft at ${size}px`);
      await chatInput(tab).fill('');
    }
    await setHostFont(tab, null);
  } finally {
    await stub.close();
  }
});

// Desktop's text size setting (damocles.desktop.textSize) sets --d-font-size in the window page too: the title bar, sidebar and
// grid scale with it, and the sidebar's and the grid's minimums follow the root font.
test('the window page scales with the text size setting without overflowing', async ({ home, launch }) => {
  test.setTimeout(180_000);
  for (const size of FONT_SIZES) {
    writeUserSettings(home, { 'damocles.desktop.textSize': size });
    const { app } = await launch();
    const shell = await shellPage(app);
    await expect.poll(() => shell.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--d-font-size').trim())).toBe(`${size}px`);
    const rem = await shell.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(rem).toBeCloseTo((size * 16) / 13, 1);
    for (const width of [1280, 900]) {
      await setContentSize(app, width, HEIGHT);
      await expect.poll(() => pageOverflow(shell), { message: `the window page at ${size}px and ${width}px` }).toEqual([]);
      // the sidebar keeps its minimum at the root font: 220px at 13px
      const sidebar = await shell.getByTestId('sidebar').evaluate((element) => element.getBoundingClientRect().width);
      expect(sidebar).toBeGreaterThanOrEqual(Math.floor((220 * rem) / 16) - 1);
    }
    await app.close();
  }
});

test('the chat page never scrolls sideways at any panel width a host allows, at the default and larger fonts', async ({ home, launch }) => {
  test.setTimeout(180_000);
  const stub = await startOpenAIStub();
  try {
    const tab = await openChat(home, launch, stub.baseUrl);
    await chatInput(tab).fill('A draft in the composer');
    for (const size of [13, ...FONT_SIZES]) {
      await setHostFont(tab, size);
      for (const width of WIDTHS) {
        await setPageSize(tab, width, HEIGHT);
        expect(await horizontalOverflow(tab), `a ${size}px font at ${width}px`).toEqual([]);
      }
    }
  } finally {
    await stub.close();
  }
});
