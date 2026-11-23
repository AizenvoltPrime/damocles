import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Locator, Page } from '@playwright/test';
import { BUILTIN_PALETTES } from '../../src/shared/themes/builtin';
import { ALLOWED_CSS_PSEUDO_CLASSES, sanitizeThemeCss } from '../../src/shared/themes/css-sanitizer';
import { expect, test } from './support/fixtures';
import { codeEditor, editorShows, openInEditor } from './support/editor';
import { seedStubModel, writeUserSettings, type HermeticHome } from './support/hermetic';
import { call, chatRequests, startOpenAIStub, type OpenAIStub } from './support/openai-stub';
import { hostMessage, openProjectChat, settled } from './support/screenshots';
import { selectedProjectKey, shellPage, SHELL_URL, SHELL_WINDOW_CONTROLS } from './support/shell';
import { activeTerminal, openTerminal, useTestProfile } from './support/terminal';
import { loadThemeTools, readTheme, writeTheme } from './support/themes';
import { addProject, awaitTurnEnd, chatInput, promptReady } from './support/ui';

// Custom theme CSS against trusted UI (docs/invariants.md "Theme CSS and trusted regions"): the agent proposes an adversarial
// theme, the window shows it, and every trusted card stays visible and clickable, nothing loads from the network, and the
// terminal and the editor keep the colors they had without the CSS.

const CHECKED = { timeout: 30_000 };
const NIGHT = '0f8fad5b-d9cb-469f-a165-70867728950e';
const COLORS = { background: '#1a1033', panel: '#22163f', text: '#f0e8ff', accent: '#ff7ad9', success: '#5be3a0', warning: '#ffc857', danger: '#ff6b6b', info: '#8fb8ff' };
const MAGENTA = 'rgb(255, 0, 255)';

// Every trick the acceptance names; only `* { color: ... }` and the harmless padding survive the sanitizer.
const HOSTILE = [
  '[data-trusted], [data-trusted] *, [data-trusted-mark], [DATA-TRUSTED], [data-\\74 rusted] { display: none !important; opacity: 0 !important; visibility: hidden !important; }',
  '* { display: none !important; position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; transform: scale(40) !important; }',
  '*::after, *:before { content: "Approved" !important; position: fixed !important; inset: 0 !important; }',
  '* { background: url(https://evil.example/leak.png) !important; border-image: url(https://evil.example/b.png) 30 !important; }',
  '* { background-image: \\75 rl(https://evil.example/escaped.png) !important; cursor: url(https://evil.example/c.png), auto !important; }',
  '@import url(https://evil.example/x.css);',
  "@font-face { font-family: 'Geist Variable'; src: url(https://evil.example/geist.woff2); }",
  ":root, * { --d-accent: transparent !important; --d-text: transparent !important; --d-font: 'Comic Sans MS' !important; }",
  'body:has([data-trusted]) * { visibility: hidden !important; }',
  ':has(*) { opacity: 0.4 !important; }',
  '.xterm, .xterm *, .xterm-viewport, .xterm-rows span, .monaco-editor, .monaco-editor *, .view-line, .mtk1 { color: rgb(255, 0, 255) !important; background-color: rgb(255, 0, 255) !important; }',
  "p { font-family: '</style><script>window.__pwned = 1</script>'; }",
  '</style><script>window.__pwned = 1</script>',
  '/* </style><script>window.__pwned = 1</script> */',
  '@layer damocles-protected { [data-trusted] { opacity: 0 !important; } }',
  '@media (hover: hover) { @layer damocles-protected { [data-trusted] { opacity: 0 !important; } } @scope (body) { * { display: none } } }',
  '[data-theme-scope] { contain: none !important; overflow-clip-margin: 0 !important; overflow: visible !important; }',
  // the most room the allowlist gives: content may grow inside its roots, never push trusted UI out of the window
  '* { margin: 4rem !important; padding: 4rem !important; letter-spacing: 0.2em !important; border: 4px solid rgb(255, 0, 0) !important; box-shadow: 0 0 1.5rem 1.5rem rgb(255, 0, 0) !important; }',
  '* { color: rgb(255, 0, 255) !important; padding: 1px; }',
].join('\n');
const REGIONS = ['transcript', 'sidebar', 'editorChrome', 'terminalChrome', 'titlebar'] as const;
const HOOK_BLUE = 'rgb(0, 128, 255)';
// rules a theme author writes against the tool card hooks (docs/themes.md)
const HOOKS = [
  '[data-tool-card][data-tool="ToolSearch"] [data-part="header"] { background-color: rgb(0, 128, 255) !important; }',
  '[data-tool-card][data-tool-status="done"] { border-color: rgb(0, 128, 255) !important; }',
].join('\n');

/** Every message the chat page posts to main from now on, as JSON text. */
async function recordPosts(app: ElectronApplication, tab: Page): Promise<() => Promise<string[]>> {
  await app.evaluate(({ webContents }, url) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
    if (!target) throw new Error(`no chat page at ${url}`);
    const seen: string[] = [];
    (globalThis as { __e2ePosts?: string[] }).__e2ePosts = seen;
    target.ipc.on('damocles:panel:post', (_event, payload: unknown) => seen.push(typeof payload === 'string' ? payload : JSON.stringify(payload)));
  }, tab.url());
  return () => app.evaluate(() => [...((globalThis as { __e2ePosts?: string[] }).__e2ePosts ?? [])]);
}

/**
 * A scope root drawn on the chat page with a control flush with its left edge: whether the control's green outline shows in the
 * captured pixels just outside the root, within the clip margin, and for a second control whose outline sits 2px further out.
 */
async function ringPixels(app: ElectronApplication, tab: Page): Promise<{ readonly withinMargin: boolean; readonly beyondMargin: boolean }> {
  await tab.evaluate(() => {
    for (const [top, offset] of [[200, 2], [260, 4]] as const) {
      const root = document.createElement('div');
      root.setAttribute('data-theme-scope', 'transcript');
      root.setAttribute('data-e2e-ring', '');
      Object.assign(root.style, { position: 'fixed', left: '60px', top: `${top}px`, width: '120px', height: '40px', background: 'rgb(0, 0, 0)', zIndex: '2147483647' });
      const control = document.createElement('div');
      Object.assign(control.style, { width: '60px', height: '20px', margin: '0', background: 'rgb(0, 0, 0)', outline: '2px solid rgb(0, 255, 0)', outlineOffset: `${offset}px` });
      root.append(control);
      document.body.append(root);
    }
  });
  try {
    await tab.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    return await app.evaluate(async ({ webContents }, url) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL() === url)!;
      const green = async (rect: Electron.Rectangle): Promise<boolean> => {
        const bitmap = (await target.capturePage(rect)).toBitmap();
        for (let i = 0; i + 3 < bitmap.length; i += 4) if (bitmap[i + 1]! > 180 && bitmap[i + 2]! < 90 && bitmap[i]! < 90) return true;
        return false;
      };
      // the first outline spans x 56 to 58 (offset 2, width 2), inside the 4px clip margin; the second x 54 to 56, beyond it
      return { withinMargin: await green({ x: 56, y: 210, width: 2, height: 1 }), beyondMargin: await green({ x: 54, y: 270, width: 2, height: 1 }) };
    }, tab.url());
  } finally {
    // the probes cover part of the page, which would hold a later trusted card's visibility check
    await tab.evaluate(() => {
      for (const probe of document.querySelectorAll('[data-e2e-ring]')) probe.remove();
    });
  }
}

const closers: (() => Promise<void>)[] = [];
test.afterEach(async () => {
  while (closers.length > 0) await closers.pop()!();
});

async function stub(home: HermeticHome): Promise<OpenAIStub> {
  const openai = await startOpenAIStub();
  closers.push(() => openai.close());
  seedStubModel(home, openai.baseUrl, ['text', 'image']);
  return openai;
}

async function send(tab: Page, text: string): Promise<void> {
  await chatInput(tab).fill(text);
  await chatInput(tab).press('Enter');
}

/** Every http, https and ws request a page makes from now on, in every session a page uses. */
async function recordNetwork(app: ElectronApplication): Promise<() => Promise<string[]>> {
  await app.evaluate(({ session, webContents }) => {
    const seen: string[] = [];
    (globalThis as { __e2eNetwork?: string[] }).__e2eNetwork = seen;
    const sessions = new Set([session.defaultSession, ...webContents.getAllWebContents().map((contents) => contents.session)]);
    for (const each of sessions) {
      each.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        // main's own fetches (the model stub) carry no page
        if (details.webContentsId !== undefined) seen.push(details.url);
        callback({});
      });
    }
  });
  return () => app.evaluate(() => [...((globalThis as { __e2eNetwork?: string[] }).__e2eNetwork ?? [])]);
}

/**
 * Every trusted root and mark a page renders: each must be fully shown and the topmost element at its center; `inWindow`: also
 * wholly inside the page, for the shell, whose trusted UI never scrolls.
 */
async function trustedState(page: Page, inWindow: boolean): Promise<Array<{ readonly what: string; readonly problems: string[] }>> {
  return page.evaluate((whole) => [...document.querySelectorAll<HTMLElement>('[data-trusted], [data-trusted-mark]')]
    .filter((element) => element.getClientRects().length > 0)
    .map((element) => {
      const style = getComputedStyle(element);
      const problems: string[] = [];
      if (style.opacity !== '1') problems.push(`opacity ${style.opacity}`);
      if (style.visibility !== 'visible') problems.push(`visibility ${style.visibility}`);
      if (style.filter !== 'none') problems.push(`filter ${style.filter}`);
      if (style.display === 'none') problems.push('display none');
      if (style.position === 'fixed' && !element.matches('[data-trusted]')) problems.push('position fixed');
      if (/Comic Sans/i.test(style.fontFamily)) problems.push(`font ${style.fontFamily}`);
      const rect = element.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const inView = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
      if (whole && (rect.left < 0 || rect.top < 0 || rect.right > innerWidth + 0.5 || rect.bottom > innerHeight + 0.5)) problems.push(`outside the window at ${rect.left},${rect.top} ${rect.width}x${rect.height}`);
      const top = inView ? document.elementFromPoint(x, y) : null;
      if (inView && top !== null && !element.contains(top) && !top.closest('[data-trusted], [data-trusted-mark]')) problems.push(`covered by ${top.tagName.toLowerCase()}.${top.className}`);
      for (const pseudo of ['::before', '::after']) if (/Approved/.test(getComputedStyle(element, pseudo).content)) problems.push(`${pseudo} content`);
      return { what: `${element.tagName.toLowerCase()}[${element.getAttribute('data-testid') ?? element.className}]`, problems };
    }), inWindow);
}

async function expectTrustedIntact(page: Page, inWindow = false, atLeast = 1): Promise<void> {
  const states = await trustedState(page, inWindow);
  expect(states.length, page.url()).toBeGreaterThanOrEqual(atLeast);
  expect(states.filter((state) => state.problems.length > 0), page.url()).toEqual([]);
}

/** The terminal's and the editor's colors as Chromium paints them. */
async function codeColors(shell: Page): Promise<string[]> {
  const terminal = await activeTerminal(shell).evaluate((view) => {
    const rows = view.querySelector('.xterm-rows')!;
    const span = rows.querySelector('span') ?? rows;
    const viewport = view.querySelector('.xterm-viewport') ?? view;
    return [getComputedStyle(rows).color, getComputedStyle(span).color, getComputedStyle(viewport).backgroundColor, getComputedStyle(rows).fontFamily];
  });
  const editor = await codeEditor(shell).evaluate((host) => {
    const monaco = host.querySelector('.monaco-editor')!;
    const background = host.querySelector('.monaco-editor-background') ?? monaco;
    const token = host.querySelector('.view-line span span') ?? monaco;
    const line = host.querySelector('.view-line') ?? monaco;
    return [getComputedStyle(background).backgroundColor, getComputedStyle(token).color, getComputedStyle(line).backgroundColor, getComputedStyle(token).fontFamily];
  });
  return [...terminal, ...editor];
}

/** A focused control inside a scope root: its ring, outline or box shadow, must lie within the root's paint clip. */
async function focusRingClipped(tab: Page): Promise<{ readonly extent: number; readonly outside: number; readonly margin: number; readonly contain: string }> {
  return tab.evaluate(() => {
    const root = document.querySelector<HTMLElement>('[data-theme-scope~="transcript"]:has(button)')!;
    const control = root.querySelector<HTMLElement>('button')!;
    control.focus({ focusVisible: true } as FocusOptions);
    const style = getComputedStyle(control);
    const px = (value: string): number[] => (value.match(/-?[\d.]+px/g) ?? []).map((part) => Number.parseFloat(part));
    let extent = style.outlineStyle !== 'none' ? Number.parseFloat(style.outlineWidth) + Math.max(0, Number.parseFloat(style.outlineOffset)) : 0;
    if (style.boxShadow !== 'none') {
      for (const shadow of style.boxShadow.split(/,(?![^(]*\))/)) {
        if (/inset/.test(shadow)) continue;
        const [x = 0, y = 0, blur = 0, spread = 0] = px(shadow);
        extent = Math.max(extent, Math.max(Math.abs(x), Math.abs(y)) + blur + spread);
      }
    }
    const a = control.getBoundingClientRect();
    const rootStyle = getComputedStyle(root);
    // paint containment clips at the padding box, widened by overflow-clip-margin
    const box = root.getBoundingClientRect();
    const b = {
      left: box.left + Number.parseFloat(rootStyle.borderLeftWidth),
      right: box.right - Number.parseFloat(rootStyle.borderRightWidth),
      top: box.top + Number.parseFloat(rootStyle.borderTopWidth),
      bottom: box.bottom - Number.parseFloat(rootStyle.borderBottomWidth),
    };
    const outside = Math.max(b.left - (a.left - extent), (a.right + extent) - b.right, b.top - (a.top - extent), (a.bottom + extent) - b.bottom, 0);
    return { extent, outside, margin: Number.parseFloat(rootStyle.overflowClipMargin), contain: rootStyle.contain };
  });
}

test('an adversarial theme leaves every trusted card visible and clickable, loads nothing, and leaves xterm and Monaco as they were', async ({ home, launch }) => {
  test.setTimeout(300_000);
  useTestProfile(home);
  fs.writeFileSync(path.join(home.project, 'notes.ts'), "export const answer = 'forty-two';\n");
  writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: COLORS } }, origin: { kind: 'created', installedAt: 1 } });
  const openai = await stub(home);
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': NIGHT });
  const { app } = await launch();
  const network = await recordNetwork(app);
  const tab = await openProjectChat(app, home.project);
  // a page error (a card that fails to render) fails the test with its message
  const pageErrors: string[] = [];
  tab.on('pageerror', (error) => pageErrors.push(error.message));
  tab.on('console', (message) => {
    if (message.type() === 'error') pageErrors.push(message.text());
  });
  const shell = await shellPage(app);

  // the terminal and the editor under the theme without CSS
  await openTerminal(app);
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'notes.ts' })).toMatchObject({ ok: true });
  await editorShows(shell, 'forty-two');
  const plainColors = await codeColors(shell);
  const plainText = await tab.locator('body').evaluate(() => getComputedStyle(document.body).getPropertyValue('--d-text').trim());

  await loadThemeTools(openai, tab);
  // a focus ring inside a scope root (the ToolSearch card's) stays inside the root's paint clip
  await tab.keyboard.press('Tab');
  const ring = await focusRingClipped(tab);
  expect(ring.contain).toContain('paint');
  expect(ring.extent).toBeGreaterThan(0);
  expect(ring.margin).toBeGreaterThan(0);
  expect(ring.outside).toBeLessThanOrEqual(ring.margin);
  // and in pixels: a 2px ring at a 2px offset on a control flush with a root's edge paints outside the root, while a ring 2px
  // further out is cut by the paint clip
  expect(await ringPixels(app, tab)).toEqual({ withinMargin: true, beyondMargin: false });
  openai.replies.push(call('ThemeSet', { theme: NIGHT, css: Object.fromEntries(REGIONS.map((region) => [region, region === 'transcript' ? `${HOSTILE}\n${HOOKS}` : HOSTILE])) }), { chunks: ['Done.'] });
  await send(tab, 'restyle everything');
  const card = tab.getByRole('region', { name: 'Preview a theme change', exact: true });
  await expect(card).toBeVisible(CHECKED);

  // Show in window paints the proposal around the card that asks about it
  // the page scrolls here (the dock is taller than this small chat pane), and a click retried on a held card scrolls it and cuts the card off
  await promptReady(card);
  await tab.getByRole('button', { name: 'Show in window', exact: true }).click();
  const strip = shell.getByRole('region', { name: 'Showing the agent\'s proposal in the window.', exact: true });
  await expect(strip).toBeVisible();
  await expect.poll(() => tab.locator('#damocles-theme-user').evaluate((style) => style.textContent ?? '')).toContain('damocles-user');
  await expectTrustedIntact(tab);
  await expectTrustedIntact(shell, true);
  // the strip's own button acts while the proposal paints the window: the strip goes and the card's toggle follows
  await strip.getByRole('button', { name: 'Stop showing', exact: true }).click();
  await expect(strip).toBeHidden();
  await expect(tab.getByRole('button', { name: 'Show in window', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await tab.getByRole('button', { name: 'Show in window', exact: true }).click();
  await expect(strip).toBeVisible();

  const apply = tab.getByRole('listbox', { name: 'Answer the theme preview', exact: true }).getByRole('option', { name: 'Apply', exact: true });
  await apply.click();
  await expect(tab.getByText('Done.', { exact: true })).toBeVisible(CHECKED);
  await awaitTurnEnd(tab);

  // core stored only what the sanitizer kept, and the model was told what it removed, as data
  const stored = readTheme(home, NIGHT)['css'] as Record<string, string>;
  expect(Object.keys(stored).sort()).toEqual([...REGIONS].sort());
  for (const css of Object.values(stored)) {
    expect(css).not.toMatch(/evil\.example|display|position|@import|@font-face|@layer|data-trusted|xterm|monaco|--d-|:root|:has|<script/i);
    expect(css).toContain('* { color: rgb(255, 0, 255) !important; padding: 1px; }');
  }
  const results = chatRequests(openai).flatMap((request) => ((request.body as { messages?: { role: string; content: unknown }[] }).messages ?? []))
    .filter((message) => message.role === 'tool').map((message) => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)));
  expect(results.some((result) => result.includes('Custom CSS the sanitizer removed') && /\\?"reason\\?":\\?"url\\?"/.test(result) && /\\?"reason\\?":\\?"atRule\\?"/.test(result))).toBe(true);

  // the surviving rule paints inside the scope roots, and only there
  const scoped = tab.locator('[data-theme-scope~="transcript"]').first();
  await expect.poll(() => scoped.evaluate((root) => getComputedStyle(root.querySelector('*') ?? root).color)).toBe(MAGENTA);
  const sidebarScoped = shell.locator('[data-theme-scope~="sidebar"]').first();
  await expect.poll(() => sidebarScoped.evaluate((root) => getComputedStyle(root.querySelector('*') ?? root).color)).toBe(MAGENTA);
  // the documented tool card hooks reach a real card
  const toolSearch = tab.locator('[data-tool-card][data-tool="ToolSearch"]').first();
  await expect.poll(() => toolSearch.evaluate((card) => getComputedStyle(card).borderTopColor)).toBe(HOOK_BLUE);
  await expect.poll(() => toolSearch.locator('[data-part="header"]').first().evaluate((header) => getComputedStyle(header).backgroundColor)).toBe(HOOK_BLUE);

  // a permission card raised over the theme is shown whole, and its answer lands once its visibility check passes
  const posts = await recordPosts(app, tab);
  await hostMessage(app, tab, { type: 'requestPermission', toolUseId: 'e2e-css-permission', toolName: 'Bash', toolInput: { command: 'echo hi' }, command: 'echo hi', owner: { kind: 'main' } });
  const permission = tab.getByTestId('permission-card');
  await expect(permission).toBeVisible();
  await expectTrustedIntact(tab);
  // with the strip gone the shell's trusted region is its window controls
  await expectTrustedIntact(shell, true, SHELL_WINDOW_CONTROLS ? 1 : 0);
  // the answer enables once the visibility check passes over the theme, and then it lands
  const firstAnswer: Locator = permission.locator('[role="option"], button').first();
  await expect(firstAnswer).not.toHaveAttribute('aria-disabled', 'true');
  await expect(permission.getByTestId('trusted-checking')).toHaveCount(0);
  await firstAnswer.click();
  await expect.poll(async () => (await posts()).some((post) => post.includes('e2e-css-permission'))).toBe(true);
  expect(await tab.locator('body').evaluate(() => getComputedStyle(document.querySelector('[data-trusted]') ?? document.body).getPropertyValue('--d-text').trim())).not.toBe('transparent');
  expect(await tab.locator('body').evaluate(() => getComputedStyle(document.body).getPropertyValue('--d-text').trim())).toBe(plainText);

  // the theme cannot lift the paint containment or the clip margin of its roots
  const contained = await focusRingClipped(tab);
  expect(contained.contain).toContain('paint');
  expect(contained.margin).toBe(ring.margin);

  // the terminal and the editor paint exactly as they did without the CSS
  expect(await codeColors(shell)).toEqual(plainColors);
  expect(plainColors).not.toContain(MAGENTA);

  for (const page of [tab, shell]) expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(await network()).toEqual([]);
  expect(pageErrors).toEqual([]);
});

// An ancestor's text decoration is drawn across every in-flow box under it, and no declaration on a descendant removes it; a
// mark's text sits in an inline-block inside a block box, which the decoration does not enter.
test('a theme that strikes through the sidebar leaves the Untrusted badge unstruck and under the default cursor rule', async ({ home, launch }) => {
  test.setTimeout(120_000);
  const STRIKE = '* { text-decoration-line: line-through; text-decoration-color: rgb(255, 0, 0); cursor: wait; }';
  writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: COLORS } }, css: { sidebar: STRIKE }, origin: { kind: 'created', installedAt: 1 } });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': NIGHT });
  const { app } = await launch();
  await addProject(app, home.project, false);
  const shell = await shellPage(app);
  const badge = shell.getByTestId('untrusted-badge');
  await expect(badge).toBeVisible();
  const name = badge.locator('xpath=ancestor::*[@role="option"][1]').getByText(path.basename(home.project), { exact: true });
  await expect(name).toBeVisible();
  // the theme's rule paints in the sidebar: the project's name takes the decoration and the cursor
  await expect.poll(() => name.evaluate((element) => getComputedStyle(element).textDecorationLine)).toBe('line-through');
  expect(await name.evaluate((element) => getComputedStyle(element).cursor)).toBe('wait');

  /** How many pixels of the element are the decoration's red. */
  const red = async (element: Locator): Promise<number> => {
    const box = (await element.boundingBox())!;
    const rect = { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) };
    return app.evaluate(async ({ webContents }, [url, area]) => {
      const target = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url))!;
      const bitmap = (await target.capturePage(area)).toBitmap();
      let count = 0;
      // BGRA
      for (let i = 0; i + 3 < bitmap.length; i += 4) if (bitmap[i + 2]! > 200 && bitmap[i + 1]! < 80 && bitmap[i]! < 80) count++;
      return count;
    }, [SHELL_URL, rect] as const);
  };
  // a row added to the list fades in, and a capture before that ends reads no text
  await settled(shell);
  expect(await red(name)).toBeGreaterThan(0);
  expect(await red(badge)).toBe(0);
  // the badge is a control of its own, so it keeps the pointer whatever cursor the theme gives the row
  expect(await badge.evaluate((element) => getComputedStyle(element).cursor)).toBe('pointer');
});

// Chromium ignores a whole rule for one selector it does not read, so a rule the sanitizer keeps with such a selector would
// be listed kept and paint nothing. Each form sits beside `q`: the rule survives only when Chromium reads the form.
test('the app\'s Chromium reads every pseudo-class and pseudo-element the sanitizer keeps', async ({ launch }) => {
  const { app } = await launch();
  const shell = await shellPage(app);
  const forms = [
    ...ALLOWED_CSS_PSEUDO_CLASSES.map((name) => `:${name}`),
    ':is(a, .b)', ':where(a > b)', ':not(a, .b)', ':nth-child(2n+1)', ':nth-child(2n+1 of .a, b)', ':nth-last-child(-n+3 of .a)', ':nth-of-type(2n)', ':nth-last-of-type(2)',
    ':dir(rtl)', ':lang(en-US)', '::selection', '::placeholder', '::marker',
  ];
  const painted = forms.map((form) => {
    const result = sanitizeThemeCss({ transcript: `p${form}, q { color: red }` }, { families: [] });
    expect([form, result.dropped]).toEqual([form, []]);
    return result.scoped.transcript!;
  });
  const read = await shell.evaluate((texts) => texts.map((text) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(text);
    // the layer, the scope inside it, the rule inside that
    const scope = (sheet.cssRules[0] as CSSLayerBlockRule | undefined)?.cssRules[0] as CSSGroupingRule | undefined;
    return (scope?.cssRules[0] as CSSStyleRule | undefined)?.selectorText ?? null;
  }), painted);
  expect(forms.map((form, at) => [form, read[at]])).toEqual(forms.map((form) => [form, `:where(:scope) p${form}, :where(:scope) q`]));
});

test('a theme file whose CSS the sanitizer would cut is broken and never shows, whoever wrote it', async ({ home, launch }) => {
  writeTheme(home, NIGHT, { schemaVersion: 1, id: NIGHT, name: 'Night', looks: { dark: { colors: COLORS } }, css: { transcript: HOSTILE } });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': NIGHT });
  const { app } = await launch();
  const network = await recordNetwork(app);
  const tab = await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  // the built-in dark look shows, so the theme's background never paints
  const builtin = BUILTIN_PALETTES.dark['--d-bg']!;
  const expected = `rgb(${[1, 3, 5].map((at) => parseInt(builtin.slice(at, at + 2), 16)).join(', ')})`;
  for (const page of [tab, shell]) await expect.poll(() => page.locator('body').evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(expected);
  for (const page of [tab, shell]) expect(await page.locator('#damocles-theme-user').count()).toBe(0);
  expect(await network()).toEqual([]);
});
