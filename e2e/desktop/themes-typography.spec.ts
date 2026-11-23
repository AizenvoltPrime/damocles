import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from '@playwright/test';
import { activeChat, expect, test } from './support/fixtures';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { startOpenAIStub } from './support/openai-stub';
import { closeSettingsModal, openSettingsModal, setContentSize } from './support/settings';
import { overlayPage, shellPage } from './support/shell';
import { cssToken, openThemeEditor, readTheme, storeBlob, themeDir, writeTheme } from './support/themes';
import { answerOpenDialog, chatInput, horizontalOverflow, pageOverflow, sendAndAwaitEcho } from './support/ui';

// A theme's type and spacing (docs/themes.md "Style"): fonts, line spacing, corners, density and the chat column, and the
// user's own text size; trusted UI keeps Damocles' fonts (docs/invariants.md "Design tokens").

const ID = '5d0c1a4e-2b7d-4c1e-8a2f-5d6e7f809a1b';
const COLORS = { background: '#141413', panel: '#1f1e1c', text: '#ece8df', accent: '#d97757', success: '#7fb069', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' };
const theme = (style: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ schemaVersion: 1, id: ID, name: 'Typeset', looks: { dark: { colors: COLORS } }, ...(Object.keys(style).length > 0 ? { style } : {}), ...extra });
const BUILTIN_UI_STACK = "'Geist Variable', 'Inter Variable', system-ui, sans-serif";
const REPO = path.resolve(import.meta.dirname, '..', '..');
// OFL-1.1 (node_modules/@fontsource-variable/geist-mono/LICENSE): a real WOFF2 that Chromium loads
const FONT_FILE = path.join(REPO, 'node_modules', '@fontsource-variable', 'geist-mono', 'files', 'geist-mono-latin-wght-normal.woff2');
const WIDTHS = [1280, 900] as const;

function useTheme(home: HermeticHome, json: Record<string, unknown>, settings: Record<string, unknown> = {}): void {
  writeTheme(home, ID, json);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID, ...settings });
}

const rootPx = (page: Page): Promise<number> => page.evaluate(() => Number.parseFloat(getComputedStyle(document.documentElement).fontSize));

/** Every visible control smaller than 1.5rem on a side: buttons, tabs, menu items, options and the like, less the glyph buttons of fixed-height rows (d-hit-free). */
async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const selector = 'button, [role="button"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], summary, select';
    return [...document.querySelectorAll<HTMLElement>(selector)].flatMap((el) => {
      if (el.getAttribute('role') === 'switch' || el.classList.contains('d-hit-free') || el.closest('[aria-hidden="true"], [inert]')) return [];
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || getComputedStyle(el).visibility === 'hidden') return [];
      const name = el.getAttribute('aria-label') ?? el.getAttribute('data-testid') ?? el.textContent?.trim().slice(0, 30) ?? '';
      return Math.min(rect.width, rect.height) < 1.5 * rem - 0.5 ? [`${el.tagName.toLowerCase()}[${name}] ${Math.round(rect.width)}x${Math.round(rect.height)}`] : [];
    });
  });
}

/**
 * The width of the transcript row's column that shows `text`, the room it is laid out in and the root font size, in px. A
 * row is positioned in the list, so its room is the list's box; any other column's is its parent's content box.
 */
async function rowColumn(tab: Page, text: string): Promise<{ readonly width: number; readonly room: number; readonly rem: number }> {
  return tab.locator('.chat-column', { hasText: text }).first().evaluate((element: HTMLElement) => {
    const parent = element.parentElement!;
    const style = getComputedStyle(parent);
    const room = getComputedStyle(element).position === 'absolute'
      ? (element.offsetParent ?? parent).clientWidth
      : parent.getBoundingClientRect().width - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return { width: element.getBoundingClientRect().width, room, rem: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) };
  });
}

/** Every @font-face rule of the page's stylesheets, grouping rules and layers included: its family and its src. */
function fontFaceRules(page: Page): Promise<{ readonly family: string; readonly src: string }[]> {
  return page.evaluate(() => {
    const faces: { family: string; src: string }[] = [];
    const walk = (rules: CSSRuleList): void => {
      for (const rule of rules) {
        if (rule instanceof CSSFontFaceRule) faces.push({ family: rule.style.getPropertyValue('font-family').replace(/["']/g, ''), src: rule.style.getPropertyValue('src') });
        else if ('cssRules' in rule) walk((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules);
    return faces;
  });
}

test('text size 20 px and density 1.15 overflow neither the shell nor the chat', async ({ home, launch }) => {
  useTheme(home, theme({ density: 1.15 }), { 'damocles.desktop.textSize': 20 });
  const { app } = await launch();
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  await expect(chatInput(tab)).toBeVisible();
  for (const page of [shell, tab]) {
    await expect.poll(() => cssToken(page, '--d-font-size')).toBe('20px');
    expect(await cssToken(page, '--d-density')).toBe('1.15');
    expect(await rootPx(page)).toBeCloseTo((20 * 16) / 13, 1);
  }
  for (const width of WIDTHS) {
    await setContentSize(app, width, 820);
    // the grid's tracks glide to their new sizes and main places the chat view after them
    await expect.poll(() => pageOverflow(shell), { message: `the shell at ${width} px` }).toEqual([]);
    await expect.poll(() => horizontalOverflow(tab), { message: `the chat at ${width} px` }).toEqual([]);
  }
});

test('density 0.85 keeps every control in the shell and the chat at least 1.5rem', async ({ home, launch }) => {
  useTheme(home, theme({ density: 0.85 }));
  const { app } = await launch();
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  await expect(chatInput(tab)).toBeVisible();
  await expect.poll(() => cssToken(shell, '--d-density')).toBe('0.85');
  expect(await cssToken(shell, '--d-hit-min')).toBe('1.5rem');
  // Tailwind's p-4 is calc(var(--spacing) * 4): 1rem at density 1, 0.85rem here
  expect(await shell.evaluate(() => {
    const probe = document.body.appendChild(document.createElement('div'));
    probe.style.padding = 'calc(var(--spacing) * 4)';
    const padding = Number.parseFloat(getComputedStyle(probe).paddingLeft) / Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    probe.remove();
    return Math.round(padding * 1000) / 1000;
  })).toBe(0.85);
  for (const width of WIDTHS) {
    await setContentSize(app, width, 820);
    await expect.poll(() => smallTargets(shell), { message: `the shell at ${width} px` }).toEqual([]);
    await expect.poll(() => smallTargets(tab), { message: `the chat at ${width} px` }).toEqual([]);
    // guards the check itself: the shell's title bar, sidebar and panes hold many controls
    expect(await shell.locator('button:visible').count()).toBeGreaterThan(10);
  }
});

test('a bundled font loads as dt-<sha8>-<name> from its blob, never shadows a built-in family, and trusted UI keeps Damocles\' fonts', async ({ home, launch }) => {
  const sha = storeBlob(home, fs.readFileSync(FONT_FILE));
  const family = `dt-${sha.slice(0, 8)}-Geist Variable`;
  const asset = { kind: 'font', mime: 'font/woff2', bytes: fs.statSync(FONT_FILE).size, family: 'Geist Variable', license: { spdx: 'OFL-1.1' } };
  useTheme(home, theme({ fonts: { ui: { asset: sha, family: 'Geist Variable' } } }, { assets: { [sha]: asset } }));
  const { app } = await launch();
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  await expect(chatInput(tab)).toBeVisible();
  for (const page of [shell, tab]) {
    await expect.poll(() => cssToken(page, '--d-font')).toBe(`'${family}', ${BUILTIN_UI_STACK}`);
    expect(await page.evaluate(() => getComputedStyle(document.body).fontFamily)).toContain(`"${family}"`);
    const loaded = await page.evaluate(async (name) => (await document.fonts.load(`16px "${name}"`)).length, family);
    expect(loaded, `${family} loads in ${page.url()}`).toBeGreaterThan(0);
    // the theme's file is one face under its renamed family, and no face of the built-in family reads from a theme's blob
    const faces = await fontFaceRules(page);
    expect(faces.filter((face) => face.src.includes('/theme-blob/')), page.url()).toEqual([{ family, src: expect.stringContaining(`/theme-blob/${sha}`) }]);
    const builtin = faces.filter((face) => face.family === 'Geist Variable');
    expect(builtin.length, page.url()).toBeGreaterThan(0);
    for (const face of builtin) expect(face.src, page.url()).not.toContain('theme-blob');
  }
  // trusted UI: the overlay's page palette keeps Damocles' fonts
  const overlay = await openSettingsModal(app, 'appearance');
  expect(await cssToken(overlay, '--d-font')).toBe(BUILTIN_UI_STACK);
  expect(await cssToken(shell, '--d-font', '[data-trusted]')).toBe(BUILTIN_UI_STACK);

  // main serves the blob only while a theme names it, as its sniffed type
  const fetched = await app.evaluate(async ({ session }, [named, unnamed]) => Promise.all([named, unnamed].map(async (key) => {
    const res = await session.defaultSession.fetch(`app://damocles/theme-blob/${key}`);
    return { status: res.status, type: res.headers.get('content-type'), cache: res.headers.get('cache-control'), csp: res.headers.get('content-security-policy') };
  })), [sha, 'f'.repeat(64)] as const);
  expect(fetched[0]).toEqual({ status: 200, type: 'font/woff2', cache: 'max-age=31536000, immutable', csp: "default-src 'none'" });
  expect(fetched[1]?.status).toBe(404);

  // once the theme is deleted nothing names the font, and its blob is served no more
  await overlay.getByRole('button', { name: 'More actions for Typeset', exact: true }).click();
  await overlay.getByRole('menuitem', { name: 'Delete…' }).click();
  await overlay.getByRole('alertdialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => fs.existsSync(themeDir(home, ID))).toBe(false);
  await expect.poll(() => app.evaluate(async ({ session }, key) => (await session.defaultSession.fetch(`app://damocles/theme-blob/${key}`)).status, sha)).toBe(404);
});

test('a chat column of 36rem, 44rem and full width lays out a transcript row at that width, and the miniature matches', async ({ home, launch }) => {
  const openai = await startOpenAIStub();
  try {
    seedStubModel(home, openai.baseUrl);
    useTheme(home, theme({ chatColumn: 36 }));
    const { app } = await launch();
    const tab = await activeChat(app);
    await expect(chatInput(tab)).toBeVisible();
    await setContentSize(app, 1600, 900);
    await sendAndAwaitEcho(tab, 'measure this row');
    const cases = [[36, '36rem', 92.16], [44, '44rem', 112.64], ['full', '100%', 136]] as const;
    const widths: number[] = [];
    for (const [value, token, mini] of cases) {
      writeTheme(home, ID, theme({ chatColumn: value }));
      await expect.poll(() => cssToken(tab, '--d-chat-column')).toBe(token);
      const expected = async (): Promise<number> => {
        const { room, rem } = await rowColumn(tab, 'Echo: measure this row');
        return value === 'full' ? room : Math.min(room, value * rem);
      };
      // the row is laid out again after the token changes
      await expect.poll(async () => Math.abs((await rowColumn(tab, 'Echo: measure this row')).width - await expected()), { message: `the row's column at ${token}` }).toBeLessThan(1);
      widths.push(await expected());
      expect(await horizontalOverflow(tab), `the chat at ${token}`).toEqual([]);
      const overlay = await openSettingsModal(app, 'appearance');
      const card = overlay.getByRole('img', { name: /^Typeset, dark look$/ });
      await expect.poll(async () => Number(await card.locator('[data-chat-column]').first().getAttribute('data-chat-column'))).toBeCloseTo(mini, 2);
      await closeSettingsModal(overlay);
    }
    // guards the cases: each asks for another width, so none passes on a column that ignored its value
    const [narrow, wider, full] = widths as [number, number, number];
    expect(wider - narrow).toBeGreaterThan(1);
    expect(full - wider).toBeGreaterThan(1);
  } finally {
    await openai.close();
  }
});

test('Paper is a built-in, read-only light example whose pick paints square corners, density 0.9 and a 40rem chat column', async ({ home, launch }) => {
  writeUserSettings(home, { 'damocles.desktop.theme': 'light' });
  const { app } = await launch();
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  const overlay = await openSettingsModal(app, 'appearance');
  await expect(overlay.getByRole('img', { name: 'Paper, light look', exact: true })).toBeVisible();
  await expect(overlay.getByRole('img', { name: 'Paper, light look', exact: true }).locator('[data-chat-column]').first()).toHaveAttribute('data-chat-column', '102.4');
  await expect(overlay.getByRole('radio', { name: 'Paper, dark', exact: true })).toHaveCount(0);
  await overlay.getByRole('button', { name: 'More actions for Paper', exact: true }).click();
  await expect(overlay.getByRole('menuitem')).toHaveText(['View', 'Duplicate to edit', 'Export…']);
  await overlay.keyboard.press('Escape');

  await overlay.getByRole('radio', { name: 'Paper, light', exact: true }).click();
  await expect(overlay.getByRole('radio', { name: 'Paper, light, active', exact: true })).toBeVisible();
  for (const page of [shell, tab]) {
    await expect.poll(() => cssToken(page, '--d-radius-scale')).toBe('0');
    expect(await cssToken(page, '--d-density')).toBe('0.9');
    expect(await cssToken(page, '--d-chat-column')).toBe('40rem');
    expect(await cssToken(page, '--d-font')).toBe(BUILTIN_UI_STACK);
    expect(await cssToken(page, '--d-bg')).toBe('#f6f1e7');
  }
  // trusted UI takes Paper's corners and density too
  expect(await cssToken(overlay, '--d-radius-scale')).toBe('0');
  expect(await cssToken(overlay, '--d-density')).toBe('0.9');
});

for (const width of WIDTHS) {
  test(`replays the design journey's Type steps and edits type at ${width} px`, async ({ home, launch }) => {
    useTheme(home, theme({}));
    const { app } = await launch();
    const tab = await activeChat(app);
    const shell = await shellPage(app);
    const page = await openThemeEditor(app, 'Typeset', { width });

    // the design's S5 steps for the Type section
    await page.getByRole('tab', { name: 'Type', exact: true }).click();
    await expect(page.getByRole('tabpanel', { name: 'Type', exact: true })).toContainText("Text size is yours, not the theme's");
    await page.getByRole('tab', { name: 'Type', exact: true }).press('ArrowLeft');
    await expect(page.getByRole('tab', { name: 'Colors', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Type', exact: true }).click();

    // the controls by role and name
    const panel = page.getByRole('tabpanel', { name: 'Type', exact: true });
    await expect(panel.getByRole('combobox', { name: /^UI font/ })).toContainText('Geist');
    await expect(panel.getByRole('combobox', { name: /^Mono font/ })).toContainText('Geist Mono');
    for (const name of ['Line spacing', 'Corner radius', 'Density', 'Chat column']) await expect(panel.getByRole('slider', { name, exact: true })).toBeVisible();

    // each slider paints the window as a preview; the dock keeps its trusted density
    const density = panel.getByRole('slider', { name: 'Density', exact: true });
    await density.focus();
    await density.press('Home');
    await expect.poll(() => cssToken(shell, '--d-density')).toBe('0.85');
    await expect(density).toHaveAttribute('aria-valuetext', '85%');
    expect(await cssToken(page, '--d-density')).toBe('1');
    const radius = panel.getByRole('slider', { name: 'Corner radius', exact: true });
    await radius.focus();
    await radius.press('Home');
    await expect(radius).toHaveAttribute('aria-valuetext', 'Square');
    await expect.poll(() => cssToken(tab, '--d-radius-scale')).toBe('0');
    const chatColumn = panel.getByRole('slider', { name: 'Chat column', exact: true });
    await chatColumn.focus();
    await chatColumn.press('End');
    await expect(chatColumn).toHaveAttribute('aria-valuetext', 'Full width');
    await expect.poll(() => cssToken(tab, '--d-chat-column')).toBe('100%');
    const lines = panel.getByRole('slider', { name: 'Line spacing', exact: true });
    await lines.focus();
    await lines.press('End');
    await expect(lines).toHaveAttribute('aria-valuetext', '×1.40');
    await expect.poll(() => cssToken(tab, '--d-line-scale')).toBe('1.4');

    // a font file added through main's dialog is stored as a blob and bundled under its renamed family
    await answerOpenDialog(app, FONT_FILE);
    await panel.getByRole('combobox', { name: /^UI font/ }).click();
    await expect(page.getByRole('listbox', { name: 'UI fonts', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Add a font file…', exact: true }).click();
    await expect(panel.getByRole('combobox', { name: /^UI font/ })).toContainText('Geist Mono');
    await expect(panel.getByTestId('theme-type-ui-note')).toContainText('Bundled');
    await expect.poll(() => cssToken(shell, '--d-font')).toMatch(/^'dt-[0-9a-f]{8}-Geist Mono/);
    expect(await cssToken(page, '--d-font')).toBe(BUILTIN_UI_STACK);

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => (readTheme(home, ID)['style'] as Record<string, unknown> | undefined)?.['density']).toBe(0.85);
    const saved = readTheme(home, ID);
    expect(saved['style']).toMatchObject({ radius: 0, density: 0.85, chatColumn: 'full', lineHeight: 1.4, fonts: { ui: { family: 'Geist Mono' } } });
    const sha = ((saved['style'] as { fonts: { ui: { asset: string } } }).fonts.ui).asset;
    expect(fs.existsSync(path.join(home.damoclesDir, 'themes', 'blobs', sha))).toBe(true);
    expect((saved['assets'] as Record<string, { kind: string; mime: string }>)[sha]).toMatchObject({ kind: 'font', mime: 'font/woff2' });

    // the banner's link opens Settings › Appearance, where Text size is the user's own row
    await panel.getByRole('button', { name: 'Settings › Appearance › Text size', exact: true }).click();
    const overlay = await overlayPage(app);
    const textSize = overlay.getByRole('slider', { name: 'Text size', exact: true });
    await expect(textSize).toBeVisible();
    await textSize.focus();
    await textSize.press('End');
    await expect(textSize).toHaveAttribute('aria-valuetext', '20 px');
    await expect.poll(() => cssToken(shell, '--d-font-size')).toBe('20px');
    await expect.poll(() => cssToken(overlay, '--d-font-size')).toBe('20px');
  });
}
