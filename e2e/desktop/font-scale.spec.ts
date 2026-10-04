import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import type { DesktopApp, LaunchOptions } from './support/app';
import { expect, test } from './support/fixtures';
import { seedStubModel, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { openProjectChat, setPageSize, settled } from './support/screenshots';
import { setContentSize } from './support/settings';
import { chatInput, sendAndAwaitEcho } from './support/ui';

// The chat page at VS Code font sizes above the 13px default: every webview size is rem (docs/invariants.md "Design
// tokens"), so the panel scales without overflowing or clipping, and its container breakpoints move with the font.

const FONT_SIZES = [16, 20] as const;
// The narrowest panel a host allows: VS Code's side bar and secondary side bar (170px); desktop's chat slot is 360px.
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

/**
 * Each element inside a chat column that reaches past the column's sides, and the header and page when they scroll
 * sideways. An element inside its own clipping or scrolling box, and a 1px visually hidden label, do not count.
 */
async function horizontalOverflow(tab: Page): Promise<string[]> {
  return tab.evaluate(() => {
    const found: string[] = [];
    const name = (el: Element): string => `${el.tagName.toLowerCase()}${el.getAttribute('data-testid') ? `[${el.getAttribute('data-testid')}]` : ''}.${[...el.classList].slice(0, 4).join('.')}`;
    const root = document.documentElement;
    if (root.scrollWidth > root.clientWidth) found.push(`page scrolls sideways (${root.scrollWidth} > ${root.clientWidth})`);
    const header = document.querySelector('[data-testid="chat-header"]');
    if (header && header.scrollWidth > header.clientWidth) found.push(`header scrolls sideways (${header.scrollWidth} > ${header.clientWidth})`);
    for (const column of document.querySelectorAll<HTMLElement>('.chat-column')) {
      if (column.getClientRects().length === 0) continue;
      const box = column.getBoundingClientRect();
      for (const el of column.querySelectorAll<HTMLElement>('*')) {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 1 || rect.height <= 1) continue;
        if (rect.left >= box.left - 0.5 && rect.right <= box.right + 0.5) continue;
        let clipped = false;
        for (let up = el.parentElement; up && up !== column; up = up.parentElement) {
          if (getComputedStyle(up).overflowX !== 'visible') clipped = true;
        }
        if (!clipped) found.push(`${name(el)} spans ${Math.round(rect.left)}..${Math.round(rect.right)} in a column of ${Math.round(box.left)}..${Math.round(box.right)}`);
      }
    }
    return found;
  });
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
  const git = (...args: string[]): string =>
    execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
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
