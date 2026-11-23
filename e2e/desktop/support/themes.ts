import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type ElectronApplication, type Locator, type Page } from '@playwright/test';
import { writeUserSettings, type HermeticHome } from './hermetic';
import { call, type OpenAIStub } from './openai-stub';
import { openSettingsModal, setContentSize } from './settings';
import { onMainWindow, shellPage } from './shell';
import { awaitTurnEnd, chatInput } from './ui';

/** Launch options that turn on main's e2e hooks (`globalThis.__damoclesE2e`), which every helper below marked "hooks" needs. */
export const HOOKS = { env: { DAMOCLES_E2E_HOOKS: '1' } } as const;

/** What the window shows without a transient preview, as main's `themeShown` hook reports it. */
export interface ShownLook {
  readonly themeId: string;
  readonly kind: string;
  readonly decidedBy: string;
  readonly until?: number;
  readonly touches?: readonly string[];
  readonly themeSource: string;
  readonly zone: string;
}

/** One answer of main's theme blob route. */
export interface ServedBlob { readonly sha256: string; readonly status: number; readonly contentRange: string | null }

export interface MotionPins { readonly focused?: boolean; readonly onBattery?: boolean; readonly batterySaver?: boolean }

interface ThemeHooks {
  gpuCompositing(): Promise<string>;
  keepChanges: { hold(): void; expire(): boolean };
  themeClock(now: number | null): void;
  themeTick(): void;
  themeSystemLocale(locale: string | null): void;
  themeShown(): ShownLook;
  pinMotion(pinned: MotionPins): void;
  themeBlobResponses(): ServedBlob[];
}
type HookGlobals = { __damoclesE2e?: ThemeHooks };

const hooked = new WeakSet<ElectronApplication>();

// Main installs its hooks at the end of its startup, after Playwright can already reach the process.
async function hooksReady(app: ElectronApplication): Promise<void> {
  if (hooked.has(app)) return;
  await expect.poll(() => app.evaluate(() => (globalThis as unknown as HookGlobals).__damoclesE2e !== undefined), { message: 'main has no e2e hooks: launch with HOOKS' }).toBe(true);
  hooked.add(app);
}

/** Main's theme hooks (hooks). */
export const themeHooks = (app: ElectronApplication) => ({
  /** Main's schedule clock reads `now` from here on and runs on, and main's own 30 s tick stops until null gives both back. */
  clock: async (now: number | null): Promise<void> => {
    await hooksReady(app);
    await app.evaluate((_electron, at) => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.themeClock(at), now);
  },
  /** Evaluates the theme again, as main's 30 s tick does. */
  tick: async (): Promise<void> => {
    await hooksReady(app);
    await app.evaluate(() => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.themeTick());
  },
  /** The regional format the schedule screen is told, in place of the machine's. */
  region: async (locale: string | null): Promise<void> => {
    await hooksReady(app);
    await app.evaluate((_electron, given) => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.themeSystemLocale(given), locale);
  },
  shown: async (): Promise<ShownLook> => {
    await hooksReady(app);
    return app.evaluate(() => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.themeShown());
  },
  /** No keep-changes countdown that starts after this ends by the clock: call it before the turn that starts one. */
  holdKeepChanges: async (): Promise<void> => {
    await hooksReady(app);
    await app.evaluate(() => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.keepChanges.hold());
  },
  /** Ends the held countdown as its timeout does; false when none waits. */
  expireKeepChanges: async (): Promise<boolean> => {
    await hooksReady(app);
    return app.evaluate(() => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.keepChanges.expire());
  },
  /** Pins the inputs that pause moving wallpapers; an e2e window may never get the OS focus and its machine may run on battery. */
  pinMotion: async (pinned: MotionPins): Promise<void> => {
    await hooksReady(app);
    await app.evaluate((_electron, pins) => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.pinMotion(pins), pinned);
  },
  /** Every answer of the theme blob route for `sha` since launch. */
  served: async (sha: string): Promise<ServedBlob[]> => {
    await hooksReady(app);
    return app.evaluate((_electron, wanted) => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.themeBlobResponses().filter((entry) => entry.sha256 === wanted), sha);
  },
});

/** What the shell page sends main when its Intl resolves a zone. */
export async function reportZone(app: ElectronApplication, zone: string): Promise<void> {
  const shell = await shellPage(app);
  await shell.evaluate((reported) => (window as unknown as { damoclesShell: { reportTimeZone(zone: string): void } }).damoclesShell.reportTimeZone(reported), zone);
}

/**
 * Sets main's schedule clock to `now` in `zone` and the regional format to `region`, then fires the tick so the window shows
 * what that time decides (hooks). The clock runs on from `now`; nothing evaluates the schedule again until an input changes,
 * a power event arrives or the test fires the tick.
 */
export async function themeTimeAt(app: ElectronApplication, now: number, zone: string, region = 'en-GB'): Promise<void> {
  const hooks = themeHooks(app);
  await hooks.clock(now);
  await hooks.region(region);
  await reportZone(app, zone);
  await hooks.tick();
}

const REQUIRE_GPU = process.env['DAMOCLES_E2E_REQUIRE_GPU'] === '1';
// One answer per worker: every launch with the suite's own flags runs on the same hardware.
let compositing: string | undefined;

/** The GPU compositing status once the GPU process has reported it (hooks); until then Chromium answers software. */
export async function gpuCompositing(app: ElectronApplication): Promise<string> {
  if (compositing !== undefined) return compositing;
  await hooksReady(app);
  compositing = await app.evaluate(() => (globalThis as unknown as Required<HookGlobals>).__damoclesE2e.gpuCompositing());
  return compositing;
}

/**
 * Whether the window shows wallpapers here (hooks): it shows none without GPU compositing (software GL, as under Xvfb), by
 * design. With DAMOCLES_E2E_REQUIRE_GPU=1 a host without it fails the test, so a leg that should have a GPU cannot pass
 * with its wallpaper tests unrun.
 */
export async function windowShowsWallpapers(app: ElectronApplication): Promise<boolean> {
  const status = await gpuCompositing(app);
  if (status.startsWith('enabled')) return true;
  if (REQUIRE_GPU) throw new Error(`GPU compositing is ${status} here and DAMOCLES_E2E_REQUIRE_GPU=1 requires it: the wallpaper tests cannot run on this host`);
  return false;
}

/** Skips the running test where the window shows no wallpapers (hooks); see `windowShowsWallpapers`. */
export async function skipWithoutGpuCompositing(app: ElectronApplication): Promise<void> {
  const shows = await windowShowsWallpapers(app);
  test.skip(!shows, `GPU compositing is ${compositing} here, so the app shows no wallpapers`);
}

export const THEME_EDITOR_URL = 'app://damocles/theme-editor/index.html';

// Theme files as core writes them: ~/.damocles/themes/themes/<id>/theme.json (docs/invariants.md "Desktop themes").
export const themeDir = (home: HermeticHome, id: string): string => path.join(home.damoclesDir, 'themes', 'themes', id);

export function writeTheme(home: HermeticHome, id: string, json: unknown): void {
  fs.mkdirSync(themeDir(home, id), { recursive: true });
  fs.writeFileSync(path.join(themeDir(home, id), 'theme.json'), typeof json === 'string' ? json : JSON.stringify(json, null, 2));
}

export function readTheme(home: HermeticHome, id: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(themeDir(home, id), 'theme.json'), 'utf8')) as Record<string, unknown>;
}

/** Stores `bytes` as core stores a blob, under the SHA-256 of the bytes, which main checks before it serves one; the hash. */
export function storeBlob(home: HermeticHome, bytes: Uint8Array | string): string {
  const sha = createHash('sha256').update(bytes).digest('hex');
  const dir = path.join(home.damoclesDir, 'themes', 'blobs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, sha), bytes);
  return sha;
}

/** The theme editor dock's page, once main has made its view. */
export async function themeEditorPage(app: ElectronApplication): Promise<Page> {
  const isEditor = (p: Page): boolean => p.url() === THEME_EDITOR_URL;
  const page = app.windows().find(isEditor) ?? await app.waitForEvent('window', { predicate: isEditor });
  await page.waitForFunction(() => window.damoclesOverlay !== undefined);
  return page;
}

/** The dock view's bounds and visibility as main placed it, in window DIPs; undefined before main made the view. */
export async function themeDockView(app: ElectronApplication): Promise<{ readonly bounds: Electron.Rectangle; readonly visible: boolean; readonly content: { width: number; height: number } } | undefined> {
  return app.evaluate(({ BaseWindow }, url) => {
    for (const window of BaseWindow.getAllWindows()) {
      const view = (window.contentView.children as Electron.WebContentsView[]).find((child) => child.webContents?.getURL() === url);
      if (view) {
        const [width, height] = window.getContentSize() as [number, number];
        return { bounds: view.getBounds(), visible: view.getVisible(), content: { width, height } };
      }
    }
    return undefined;
  }, THEME_EDITOR_URL);
}

export async function cssToken(page: Page, name: string, selector = ':root'): Promise<string> {
  return page.locator(selector).first().evaluate((element, token) => getComputedStyle(element).getPropertyValue(token).trim(), name);
}

/** Waits until main reports the dock open and shown: the dock view is visible on a non-empty rectangle. */
export async function dockShown(app: ElectronApplication): Promise<void> {
  await expect.poll(async () => {
    const dock = await themeDockView(app);
    return dock !== undefined && dock.visible && dock.bounds.width > 0;
  }, { timeout: 15_000 }).toBe(true);
}

/** Settings › Appearance with its gallery, at a window `width` px wide. */
export async function openAppearance(app: ElectronApplication, width: number): Promise<Page> {
  await setContentSize(app, width, 820);
  const overlay = await openSettingsModal(app, 'appearance');
  await expect(overlay.getByTestId('theme-gallery')).toBeVisible();
  return overlay;
}

/**
 * Opens the theme named `name` in the editor dock from its card's menu (`item` is Edit for a theme of the user's, View for a
 * built-in), and resolves with the dock's page once the dock shows and Settings has closed, on `tab` when one is named.
 */
export async function openThemeEditor(app: ElectronApplication, name: string, options: { readonly tab?: string; readonly width?: number; readonly item?: 'Edit' | 'View'; readonly from?: Page } = {}): Promise<Page> {
  if (options.width !== undefined) await setContentSize(app, options.width, 820);
  // `from` is Settings › Appearance when the test has it open already
  const overlay = options.from ?? await openSettingsModal(app, 'appearance');
  await overlay.getByRole('button', { name: `More actions for ${name}`, exact: true }).click();
  await overlay.getByRole('menuitem', { name: options.item ?? 'Edit', exact: true }).click();
  const editor = await themeEditorPage(app);
  await dockShown(app);
  await expect(overlay.getByTestId('settings-modal')).toBeHidden();
  if (options.tab !== undefined) await editor.getByRole('tab', { name: options.tab, exact: true }).click();
  return editor;
}

/** The main window's background color as main set it, lower case. */
export function windowBackground(app: ElectronApplication): Promise<string> {
  return onMainWindow(app, (win) => win.getBackgroundColor().toLowerCase());
}

/** A turn in which ToolSearch loads the theme tools in the chat. */
export async function loadThemeTools(openai: OpenAIStub, tab: Page): Promise<void> {
  openai.replies.push(call('ToolSearch', { tools: ['theme'] }), { chunks: ['Loaded.'] });
  await chatInput(tab).fill('load the theme tools');
  await chatInput(tab).press('Enter');
  await expect(tab.getByText('Loaded.', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
  await awaitTurnEnd(tab);
}

/** Waits until a trusted card's `control` takes a press: the card holds its controls aria-disabled until then. */
export async function controlReady(control: Locator): Promise<void> {
  await expect(control).not.toHaveAttribute('aria-disabled');
}

const channel = (text: string): number => (text.endsWith('%') ? Number.parseFloat(text) / 100 : Number.parseFloat(text));

/**
 * The alpha of a computed or custom-property color: #rgb(a), #rrggbb(aa), rgb() and rgba() in either syntax,
 * color(<space> c1 c2 c3 [/ a]) and the keyword transparent. Throws on anything else, the empty string included, so an
 * unreadable color never reads as opaque.
 */
export function alpha(color: string): number {
  const text = color.trim().toLowerCase();
  if (text === 'transparent') return 0;
  const hex = /^#([0-9a-f]{3,8})$/.exec(text)?.[1];
  if (hex !== undefined && [3, 6].includes(hex.length)) return 1;
  if (hex !== undefined && hex.length === 4) return Number.parseInt(hex[3]!.repeat(2), 16) / 255;
  if (hex !== undefined && hex.length === 8) return Number.parseInt(hex.slice(6), 16) / 255;
  const rgb = /^rgba?\(([^()]+)\)$/.exec(text)?.[1];
  const parts = rgb?.split(/[\s,/]+/).filter(Boolean);
  if (parts?.length === 3) return 1;
  if (parts?.length === 4) return channel(parts[3]!);
  const spaced = /^color\(\s*[a-z0-9-]+((?:\s+[^\s/()]+){3})\s*(?:\/\s*([^\s/()]+)\s*)?\)$/.exec(text);
  if (spaced) return spaced[2] === undefined ? 1 : channel(spaced[2]);
  throw new Error(`alpha: cannot read ${JSON.stringify(color)}`);
}

/**
 * Makes main read the OS's forced colors and reduced transparency as given, whatever the host's are, and tells it they
 * changed. Restore a value by pinning it again, never by removing the pin: that gives the host's answer back.
 */
export async function pinNativeTheme(app: ElectronApplication, pinned: { readonly inForcedColorsMode?: boolean; readonly prefersReducedTransparency?: boolean }): Promise<void> {
  await app.evaluate(({ nativeTheme }, values) => {
    for (const [name, value] of Object.entries(values)) Object.defineProperty(nativeTheme, name, { configurable: true, get: () => value });
    nativeTheme.emit('updated');
  }, pinned);
}

const COMPACT_ID = '7c2e4b90-1f3a-4d5c-9e6b-0a1b2c3d4e5f';

/** Selects a dark theme of density 0.85 for the next launch: the compact end of a theme's spacing, where `--d-hit-min` is 1.5rem. */
export function useCompactTheme(home: HermeticHome): void {
  const colors = { background: '#141413', panel: '#1f1e1c', text: '#ece8df', accent: '#d97757', success: '#7fb069', warning: '#f0b429', danger: '#f2555a', info: '#6a9bcc' };
  writeTheme(home, COMPACT_ID, { schemaVersion: 1, id: COMPACT_ID, name: 'Compact', looks: { dark: { colors } }, style: { density: 0.85 } });
  writeUserSettings(home, { 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': COMPACT_ID });
}

export interface GlyphBox { readonly size: number; readonly inRow: boolean }

/** Each button of `row` in rem (three decimals), and whether it lies inside the row's box top to bottom. */
export function glyphButtons(row: Locator): Promise<GlyphBox[]> {
  return row.evaluate((element) => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    const box = element.getBoundingClientRect();
    return [...element.querySelectorAll('button')].map((button) => {
      const rect = button.getBoundingClientRect();
      return { size: Math.round((Math.max(rect.width, rect.height) / rem) * 1000) / 1000, inRow: rect.top >= box.top - 0.01 && rect.bottom <= box.bottom + 0.01 };
    });
  });
}

/** The least height of the overlay menu's items, in rem. */
export function menuItemHeight(overlay: Page): Promise<number> {
  return overlay.evaluate(() => {
    const rem = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
    return Math.min(...[...document.querySelectorAll('[data-menu-item]')].map((item) => item.getBoundingClientRect().height)) / rem;
  });
}
