import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { activeChat, expect, nextChat, test } from './support/fixtures';
import { writeUserSettings, type HermeticHome } from './support/hermetic';
import { onMainWindow, selectedProjectKey, shellPage, shellState } from './support/shell';
import { openProjectChat, settled } from './support/screenshots';
import { setContentSize } from './support/settings';
import { openInEditor, toggleTerminal } from './support/editor';
import { answerOpenDialog, clickMenu } from './support/ui';
import { alpha, cssToken, HOOKS, openThemeEditor, pinNativeTheme, skipWithoutGpuCompositing, storeBlob, themeDir, windowShowsWallpapers, writeTheme } from './support/themes';
import { png } from '../../src/shared/themes/testing/image-fixtures';
import { contrastOverImage, type ImageStats } from '../../src/shared/themes/wallpapers';

// Still wallpapers (docs/invariants.md "Desktop themes"): one layer under the shell's panes, regions measured from the panes in
// the frame they change, a see-through chat view only while the chat panel has a wallpaper, transparent Monaco and xterm only
// then, readable text over the image, and the conditions that turn wallpapers off. Every launch has main's e2e hooks, which
// say whether this host composites on the GPU; a test that expects a wallpaper pins the OS's forced colors and reduced
// transparency off first, since either on the host would turn wallpapers off or their surfaces opaque.

const ID = '6e0c1a4e-2b7d-4c1e-8a2f-5d6e7f809a1c';
const COLORS = { background: '#0b1020', panel: '#10172a', text: '#e4ecf5', accent: '#5ee6b0', success: '#4fd18b', warning: '#f2c14e', danger: '#ff6b7a', info: '#8ab4ff' };
const PANELS = ['titlebar', 'sidebar', 'chat', 'editor', 'terminal'] as const;
const HOST_NEUTRAL = { inForcedColorsMode: false, prefersReducedTransparency: false };

interface Image { readonly sha: string; readonly bytes: Buffer; readonly asset: Record<string, unknown> }

// Aurora's two wallpapers as its theme.json names them: Night for the dark look, Dawn for the light one.
const AURORA = path.resolve(import.meta.dirname, '..', '..', 'resources', 'themes', 'damocles-aurora');
function auroraImage(look: 'dark' | 'light'): Image {
  const theme = JSON.parse(fs.readFileSync(path.join(AURORA, 'theme.json'), 'utf8')) as { looks: Record<string, { wallpapers: { span: { asset: string } }[] }>; assets: Record<string, Record<string, unknown>> };
  const sha = theme.looks[look]!.wallpapers[0]!.span.asset;
  return { sha, bytes: fs.readFileSync(path.join(AURORA, `${sha}.png`)), asset: theme.assets[sha]! };
}
const NIGHT = (): Image => auroraImage('dark');
const DAWN = (): Image => auroraImage('light');

type WallpaperSet = Record<string, unknown>;

/** Stores the image as core stores a blob and makes the theme with `set` the preferred dark look. */
function useWallpaper(home: HermeticHome, image: Image, set: WallpaperSet, look: Record<string, unknown> = {}, settings: Record<string, unknown> = {}): void {
  storeBlob(home, image.bytes);
  writeTheme(home, ID, {
    schemaVersion: 1, id: ID, name: 'Walled', origin: { kind: 'created', installedAt: 1 },
    looks: { dark: { colors: COLORS, wallpapers: [set], ...look } },
    assets: { [image.sha]: image.asset },
  });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID, ...settings });
}

const span = (sha: string, dim: number, blur = 0): WallpaperSet => ({ span: { asset: sha, panels: PANELS, fit: 'fill' }, spanLook: Object.fromEntries(PANELS.map((panel) => [panel, { dim, blur }])) });

async function regions(app: ElectronApplication): Promise<number> {
  return (await shellState(app)).wallpapers?.length ?? 0;
}

async function background(page: Page, selector: string): Promise<string> {
  return page.locator(selector).first().evaluate((element) => getComputedStyle(element).backgroundColor);
}

const bodyAlpha = async (page: Page): Promise<number> => alpha(await background(page, 'body'));

/**
 * Starts recording from a ResizeObserver made after the layer's. The layer keeps the one observer it made at mount for its
 * whole life, and observers are told in the order they were made, so this runs after the layer placed its regions in the
 * same frame: each region's rectangle against its pane's, and where its image's corner sits in window pixels.
 */
async function recordFrames(shell: Page): Promise<void> {
  await shell.evaluate(() => {
    const frames: Array<{ panel: string; dx: number; dy: number; dw: number; dh: number; ix: number; iy: number }[]> = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const sample = (): void => {
      const frame = [...document.querySelectorAll<HTMLElement>('[data-wallpaper-region]')].filter((region) => !region.hidden).map((region) => {
        const panel = region.dataset['wallpaperRegion']!;
        const pane = document.querySelector<HTMLElement>(`[data-wallpaper-panel="${panel}"]`)!.getBoundingClientRect();
        const box = region.getBoundingClientRect();
        const image = region.firstElementChild as HTMLElement;
        const inset = Number.parseFloat(image.style.inset || '0');
        const [px, py] = image.style.backgroundPosition.split(' ').map((part) => Number.parseFloat(part));
        return { panel, dx: box.left - pane.left, dy: box.top - pane.top, dw: box.width - pane.width, dh: box.height - pane.height, ix: box.left + inset + px!, iy: box.top + inset + py! };
      });
      frames.push(frame);
    };
    const observer = new ResizeObserver(sample);
    for (const pane of document.querySelectorAll('[data-wallpaper-panel]')) observer.observe(pane);
  });
}

async function frames(shell: Page): Promise<Array<Array<{ panel: string; dx: number; dy: number; dw: number; dh: number; ix: number; iy: number }>>> {
  return shell.evaluate(() => (window as unknown as { __frames: Array<Array<{ panel: string; dx: number; dy: number; dw: number; dh: number; ix: number; iy: number }>> }).__frames);
}

async function dragSash(shell: Page, testId: string, dx: number, dy: number): Promise<void> {
  const box = (await shell.getByTestId(testId).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await shell.mouse.move(x, y);
  await shell.mouse.down();
  await shell.mouse.move(x + dx, y + dy, { steps: 8 });
  await shell.mouse.up();
  await settled(shell);
}

// The dividers are dragged with the pointer, which another worker's window would otherwise take mid-drag.
test('one image spans the title bar, sidebar, chat, editor and terminal, lined up through window resizes and divider drags', async ({ foreground: _foreground, home, launch }) => {
  useWallpaper(home, NIGHT(), span(NIGHT().sha, 0.3));
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await pinNativeTheme(app, HOST_NEUTRAL);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await toggleTerminal(app);
  await expect.poll(() => regions(app)).toBe(5);
  const layer = shell.getByTestId('wallpaper-layer');
  await expect(layer).toHaveAttribute('aria-hidden', 'true');
  // every pane lets the layer through
  for (const selector of ['[data-wallpaper-panel="titlebar"]', '[data-wallpaper-panel="sidebar"]', '[data-testid="grid-pane-chat"]', '[data-testid="editor-pane"]', '[data-testid="terminal-pane"]']) {
    await expect.poll(async () => alpha(await background(shell, selector)), { message: selector }).toBe(0);
  }
  // and the window's own background, which the layer paints over, stays the theme's opaque color
  expect(await cssToken(shell, '--d-bg')).toBe(COLORS.background);
  expect(alpha(await layer.locator('xpath=..').evaluate((root) => getComputedStyle(root).backgroundColor))).toBe(1);

  await recordFrames(shell);
  await setContentSize(app, 1100, 760);
  await settled(shell);
  await dragSash(shell, 'sash-side', -140, 0);
  await dragSash(shell, 'sash-bottom', 0, -90);
  await setContentSize(app, 1320, 840);
  await settled(shell);
  const recorded = await frames(shell);
  expect(recorded.length).toBeGreaterThan(4);
  for (const frame of recorded) {
    expect(frame).toHaveLength(5);
    for (const region of frame) {
      for (const delta of [region.dx, region.dy, region.dw, region.dh]) expect(Math.abs(delta), `${region.panel} follows its pane`).toBeLessThan(1);
      expect(Math.abs(region.ix - frame[0]!.ix), `${region.panel} lines up`).toBeLessThan(1);
      expect(Math.abs(region.iy - frame[0]!.iy), `${region.panel} lines up`).toBeLessThan(1);
    }
  }

  // A maximized pane glides to its new corner, which moves it without a resize: its region rests where the pane does, and
  // a pane the maximized one hides has no region.
  const offRegions = (): Promise<string[]> => shell.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-wallpaper-region]')].flatMap((region) => {
    const panel = region.dataset['wallpaperRegion']!;
    const pane = document.querySelector<HTMLElement>(`[data-wallpaper-panel="${panel}"]`)!.getBoundingClientRect();
    if (region.hidden) return pane.width > 0 && pane.height > 0 ? [`${panel} has no region`] : [];
    const box = region.getBoundingClientRect();
    const off = Math.max(Math.abs(box.left - pane.left), Math.abs(box.top - pane.top), Math.abs(box.width - pane.width), Math.abs(box.height - pane.height));
    return off < 1 ? [] : [`${panel} is ${off} px off its pane`];
  }));
  for (const pressed of ['true', 'false']) {
    await shell.getByTestId('terminal-maximize').click();
    await expect(shell.getByTestId('terminal-maximize')).toHaveAttribute('aria-pressed', pressed);
    await settled(shell);
    expect(await offRegions()).toEqual([]);
  }
});

// That main waits for the new chat's first frames before the swap is main's own logic, tested with a fake window in
// src/desktop/main/__tests__/views.test.ts; here the real views show the order of the swap.
test('the chat view is see-through only while the chat panel has a wallpaper, and a chat switch parks and shows the new chat, then places it as the old one hides, in one step', async ({ home, launch }) => {
  useWallpaper(home, NIGHT(), { panels: { chat: { asset: NIGHT().sha, fit: 'fill', dim: 0.3, blur: 0 } } });
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await pinNativeTheme(app, HOST_NEUTRAL);
  const first = await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  await expect.poll(() => regions(app)).toBe(1);
  // a view has no background getter, so main records what each chat view is given from here on
  await app.evaluate(({ BaseWindow }) => {
    const given = new Map<string, string>();
    (globalThis as unknown as { __viewBackground: typeof given }).__viewBackground = given;
    for (const window of BaseWindow.getAllWindows()) {
      for (const view of window.contentView.children as Electron.WebContentsView[]) {
        const url = view.webContents?.getURL() ?? '';
        if (!url.includes('/panel/')) continue;
        const set = view.setBackgroundColor.bind(view);
        view.setBackgroundColor = (color) => {
          given.set(url, color.toLowerCase());
          set(color);
        };
      }
    }
  });
  const viewBackground = (page: Page): Promise<string | undefined> => app.evaluate((_electron, url) => (globalThis as unknown as { __viewBackground: Map<string, string> }).__viewBackground.get(url), page.url());
  // the page gets its palette in a message of its own, after main's state names the region
  await expect.poll(() => bodyAlpha(first)).toBe(0);
  // only the chat pane is see-through
  expect(alpha(await background(shell, '[data-wallpaper-panel="sidebar"]'))).toBe(1);
  await clickMenu(app, 'damocles.themes.toggleWallpapers');
  await expect.poll(() => viewBackground(first)).toBe(COLORS.background);
  await expect.poll(() => bodyAlpha(first)).toBe(1);
  expect(await regions(app)).toBe(0);
  await clickMenu(app, 'damocles.themes.toggleWallpapers');
  await expect.poll(() => viewBackground(first)).toBe('#00000000');
  await expect.poll(() => bodyAlpha(first)).toBe(0);

  // a new chat replaces this one while main records, by webContents id, how every view moves
  const firstId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.id, first.url());
  await app.evaluate(({ WebContentsView }) => {
    const log: Array<{ readonly id: number; readonly call: string; readonly x?: number; readonly visible?: boolean }> = [];
    (globalThis as unknown as { __viewLog: typeof log }).__viewLog = log;
    const proto = WebContentsView.prototype as unknown as { setBounds(bounds: Electron.Rectangle): void; setVisible(visible: boolean): void; webContents: Electron.WebContents };
    const setBounds = proto.setBounds;
    const setVisible = proto.setVisible;
    proto.setBounds = function (this: typeof proto, bounds) {
      log.push({ id: this.webContents.id, call: 'bounds', x: bounds.x });
      setBounds.call(this, bounds);
    };
    proto.setVisible = function (this: typeof proto, visible) {
      log.push({ id: this.webContents.id, call: 'visible', visible });
      setVisible.call(this, visible);
    };
  });
  await shell.evaluate(async () => {
    const state = await window.damoclesShell!.getState();
    await window.damoclesShell!.newChat(state.selected.projectKey);
  });
  const second = await nextChat(app, [first]);
  const secondId = await app.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((contents) => contents.getURL() === url)!.id, second.url());
  await expect.poll(() => bodyAlpha(second)).toBe(0);
  const content = await onMainWindow(app, (win) => win.getContentSize()[0]!);
  const viewLog = (): Promise<Array<{ id: number; call: string; x?: number; visible?: boolean }>> => app.evaluate(() => (globalThis as unknown as { __viewLog: Array<{ id: number; call: string; x?: number; visible?: boolean }> }).__viewLog);
  await expect.poll(async () => (await viewLog()).some((entry) => entry.id === firstId && entry.call === 'visible' && entry.visible === false)).toBe(true);
  const log = (await viewLog()).filter((entry) => entry.id === firstId || entry.id === secondId);
  const parked = log.findIndex((entry) => entry.id === secondId && entry.call === 'bounds' && entry.x === content - 1);
  const shown = log.findIndex((entry) => entry.id === secondId && entry.call === 'visible' && entry.visible === true);
  const placed = log.findIndex((entry, i) => i > shown && entry.id === secondId && entry.call === 'bounds' && entry.x !== content - 1);
  const hidden = log.findIndex((entry) => entry.id === firstId && entry.call === 'visible' && entry.visible === false);
  // the new chat is parked and shown while the old one stays, then placed on the slot as the old one hides, in one step
  expect(parked, JSON.stringify(log)).toBeGreaterThanOrEqual(0);
  expect(shown, JSON.stringify(log)).toBeGreaterThan(parked);
  expect(placed, JSON.stringify(log)).toBeGreaterThan(shown);
  expect(hidden, JSON.stringify(log)).toBe(placed + 1);
  expect(log.slice(0, hidden).some((entry) => entry.id === firstId && entry.call === 'visible' && entry.visible === false)).toBe(false);

  // without a wallpaper the chat view and its page are opaque again
  await clickMenu(app, 'damocles.themes.toggleWallpapers');
  await expect.poll(() => bodyAlpha(second)).toBe(1);
  expect(await regions(app)).toBe(0);
});

test('Monaco and xterm are transparent only while their panes show a wallpaper, and sticky scroll stays on the card color', async ({ home, launch }) => {
  fs.writeFileSync(path.join(home.project, 'notes.ts'), `export function outer() {\n${Array.from({ length: 80 }, (_, i) => `  const v${i} = ${i};`).join('\n')}\n}\n`);
  const image = NIGHT();
  useWallpaper(home, image, { panels: { editor: { asset: image.sha, fit: 'fill', dim: 0.3, blur: 0 }, terminal: { asset: image.sha, fit: 'tile', dim: 0.3, blur: 0 } } }, { surfaceOpacity: 0.7 });
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await pinNativeTheme(app, HOST_NEUTRAL);
  await openProjectChat(app, home.project);
  const shell = await shellPage(app);
  expect(await openInEditor(app, { projectKey: await selectedProjectKey(app), relativePath: 'notes.ts' })).toMatchObject({ ok: true });
  await toggleTerminal(app);
  await expect.poll(() => regions(app)).toBe(2);
  const editor = shell.locator('[data-testid="code-editor"] .monaco-editor').first();
  const monacoColor = (name: string): Promise<string> => editor.evaluate((element, variable) => getComputedStyle(element).getPropertyValue(variable).trim().toLowerCase(), name);
  // Monaco sets its color variables once it mounts; until then there is no color to read
  await expect.poll(() => monacoColor('--vscode-editor-background')).not.toBe('');
  await expect.poll(async () => alpha(await monacoColor('--vscode-editor-background'))).toBe(0);
  // sticky scroll and hovers keep the card color at 92% or more over the wallpaper, whatever the surface opacity
  const sticky = await monacoColor('--vscode-editorStickyScroll-background');
  expect(alpha(sticky)).toBeGreaterThanOrEqual(0.92);
  expect(alpha(sticky)).toBeLessThan(1);
  // every ground Monaco would otherwise take from the see-through editor background has the same color
  for (const name of ['editorStickyScrollGutter', 'editorStickyScrollHover', 'editorMarkerNavigation', 'editorWidget', 'editorHoverWidget', 'editorSuggestWidget']) {
    expect(await monacoColor(`--vscode-${name}-background`), name).toBe(sticky);
  }
  const viewport = shell.locator('[data-testid="terminal-pane"] .xterm-viewport').first();
  await expect.poll(async () => alpha(await viewport.evaluate((element) => getComputedStyle(element).backgroundColor))).toBe(0);

  await clickMenu(app, 'damocles.themes.toggleWallpapers');
  await expect.poll(async () => alpha(await monacoColor('--vscode-editor-background'))).toBe(1);
  await expect.poll(async () => alpha(await viewport.evaluate((element) => getComputedStyle(element).backgroundColor))).toBe(1);
});

test('raiseDim dims the image until muted text reads at 4.5:1 over its luminance percentiles; warn keeps the dim', async ({ home, launch }) => {
  const image = DAWN();
  useWallpaper(home, image, span(image.sha, 0));
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await pinNativeTheme(app, HOST_NEUTRAL);
  const tab = await activeChat(app);
  // core asks main's theme renderer to decode and measure the image, and writes what it found
  const statsFile = path.join(home.damoclesDir, 'themes', 'cache', image.sha, 'stats.json');
  await expect.poll(() => fs.existsSync(statsFile), { timeout: 60_000 }).toBe(true);
  expect(fs.existsSync(path.join(home.damoclesDir, 'themes', 'cache', image.sha, 'thumb-480.webp'))).toBe(true);
  const stats = JSON.parse(fs.readFileSync(statsFile, 'utf8')) as ImageStats;
  const muted = await cssToken(tab, '--d-muted');
  const bg = await cssToken(tab, '--d-bg');
  expect(contrastOverImage(muted, bg, 0, stats)).toBeLessThan(4.5);
  await expect.poll(async () => (await shellState(app)).wallpapers?.find((region) => region.panel === 'chat')?.dim ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
  const chat = (await shellState(app)).wallpapers!.find((region) => region.panel === 'chat')!;
  expect(contrastOverImage(muted, bg, chat.dim, stats)).toBeGreaterThanOrEqual(4.5);
  expect(contrastOverImage(muted, bg, chat.dim - 0.01, stats)).toBeLessThan(4.5);

  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID, 'damocles.desktop.themes.wallpaperContrast': 'warn' });
  await expect.poll(async () => (await shellState(app)).wallpapers?.find((region) => region.panel === 'chat')?.dim).toBe(0);
});

test('forced colors and GPU compositing off show no wallpaper; reduced transparency keeps surfaces opaque', async ({ home, launch }) => {
  const image = NIGHT();
  useWallpaper(home, image, span(image.sha, 0.4), { surfaceOpacity: 0.7 });
  const noGpu = await launch({ args: ['--disable-gpu-compositing'] });
  const firstTab = await activeChat(noGpu.app);
  const firstShell = await shellPage(noGpu.app);
  expect(await noGpu.app.evaluate(({ app }) => app.getGPUFeatureStatus().gpu_compositing)).not.toMatch(/^enabled/);
  // the theme itself shows, so what follows is the wallpaper left out and not a look that failed to apply
  for (const page of [firstTab, firstShell]) await expect.poll(() => cssToken(page, '--d-bg')).toBe(COLORS.background);
  await expect.poll(async () => (await shellState(noGpu.app)).wallpapers).toBeUndefined();
  await expect(firstShell.getByTestId('wallpaper-layer')).toHaveCount(0);
  await expect.poll(() => bodyAlpha(firstTab)).toBe(1);
  await noGpu.close();

  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await pinNativeTheme(app, HOST_NEUTRAL);
  const tab = await activeChat(app);
  await expect.poll(() => regions(app)).toBe(5);
  await expect.poll(() => cssToken(tab, '--d-surface-alpha')).toBe('0.7');

  await pinNativeTheme(app, { inForcedColorsMode: true });
  await expect.poll(() => regions(app)).toBe(0);
  await expect.poll(() => bodyAlpha(tab)).toBe(1);
  await pinNativeTheme(app, { inForcedColorsMode: false });
  await expect.poll(() => regions(app)).toBe(5);

  await pinNativeTheme(app, { prefersReducedTransparency: true });
  await expect.poll(() => cssToken(tab, '--d-surface-alpha')).toBe('1');
  expect(await regions(app)).toBe(5);
  await pinNativeTheme(app, { prefersReducedTransparency: false });
  await expect.poll(() => cssToken(tab, '--d-surface-alpha')).toBe('0.7');
});

test('the Show wallpapers setting and safe start each show the theme with no wallpaper, and bring it back when they end', async ({ home, launch }) => {
  const image = NIGHT();
  useWallpaper(home, image, span(image.sha, 0.4));
  const { app } = await launch(HOOKS);
  await skipWithoutGpuCompositing(app);
  await pinNativeTheme(app, HOST_NEUTRAL);
  const tab = await activeChat(app);
  const shell = await shellPage(app);
  await expect.poll(() => regions(app)).toBe(5);
  await expect.poll(() => bodyAlpha(tab)).toBe(0);

  // the setting, as Settings writes it: the look stays and its wallpaper goes
  const settings = { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID };
  writeUserSettings(home, { ...settings, 'damocles.desktop.themes.showWallpapers': false });
  await expect.poll(() => regions(app)).toBe(0);
  await expect(shell.getByTestId('wallpaper-layer')).toHaveCount(0);
  await expect.poll(() => bodyAlpha(tab)).toBe(1);
  for (const page of [tab, shell]) expect(await cssToken(page, '--d-bg')).toBe(COLORS.background);
  writeUserSettings(home, { ...settings, 'damocles.desktop.themes.showWallpapers': true });
  await expect.poll(() => regions(app)).toBe(5);
  await app.close();

  // safe start shows the built-in look, which has no wallpaper, until Use my theme
  const safe = await launch({ ...HOOKS, args: ['--damocles-safe-theme'] });
  await pinNativeTheme(safe.app, HOST_NEUTRAL);
  const safeTab = await activeChat(safe.app);
  const safeShell = await shellPage(safe.app);
  const banner = safeShell.getByRole('region', { name: 'Started with the Damocles theme.' });
  await expect(banner).toBeVisible();
  await expect.poll(() => cssToken(safeTab, '--d-bg')).toBe('#0b0f14');
  expect(await regions(safe.app)).toBe(0);
  await expect(safeShell.getByTestId('wallpaper-layer')).toHaveCount(0);
  expect(await bodyAlpha(safeTab)).toBe(1);
  await banner.getByRole('button', { name: 'Use my theme', exact: true }).click();
  await expect.poll(() => regions(safe.app)).toBe(5);
  await expect.poll(() => bodyAlpha(safeTab)).toBe(0);
});

test('the editor refuses an image over 8192 pixels a side or 40 megapixels before any decode, and sets a chosen one as a panel\'s wallpaper', async ({ home, launch }) => {
  writeTheme(home, ID, { schemaVersion: 1, id: ID, name: 'Walled', origin: { kind: 'created', installedAt: 1 }, looks: { dark: { colors: COLORS } } });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID });
  const files = {
    wide: path.join(home.root, 'wide.png'),
    many: path.join(home.root, 'many.png'),
    good: path.join(home.root, 'dawn.png'),
  };
  fs.writeFileSync(files.wide, png(9000, 100));
  fs.writeFileSync(files.many, png(8000, 6000));
  fs.writeFileSync(files.good, DAWN().bytes);
  const { app } = await launch(HOOKS);
  const windowShows = await windowShowsWallpapers(app);
  await pinNativeTheme(app, HOST_NEUTRAL);
  await activeChat(app);
  const editor = await openThemeEditor(app, 'Walled', { tab: 'Wallpapers', width: 1280 });
  await editor.getByRole('radio', { name: 'One image per panel', exact: true }).click();
  await editor.getByRole('button', { name: 'Chat, no image', exact: true }).click();

  for (const [file, message] of [[files.wide, /at most 8192 pixels on a side/], [files.many, /at most 40/]] as const) {
    await answerOpenDialog(app, file);
    await editor.getByTestId('wallpaper-choose').click();
    await expect(editor.getByRole('alert')).toContainText(message);
    const sha = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    // refused from its header: never stored, so never handed to the theme renderer to decode
    expect(fs.existsSync(path.join(home.damoclesDir, 'themes', 'blobs', sha))).toBe(false);
    expect(fs.existsSync(path.join(home.damoclesDir, 'themes', 'cache', sha))).toBe(false);
  }

  await answerOpenDialog(app, files.good);
  await editor.getByTestId('wallpaper-choose').click();
  await expect(editor.getByRole('button', { name: 'Chat, has an image', exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(editor.getByTestId('wallpaper-readability')).toBeVisible();
  // the live preview paints the window with it before any save, where the window shows wallpapers at all
  if (windowShows) await expect.poll(() => regions(app)).toBe(1);
  else test.info().annotations.push({ type: 'partly skipped', description: 'no GPU compositing here, so the window shows no wallpaper' });
  await editor.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => fs.existsSync(path.join(themeDir(home, ID), 'theme.json')) && (JSON.parse(fs.readFileSync(path.join(themeDir(home, ID), 'theme.json'), 'utf8')) as { looks: { dark: { wallpapers?: unknown[] } } }).looks.dark.wallpapers?.length).toBe(1);
});
