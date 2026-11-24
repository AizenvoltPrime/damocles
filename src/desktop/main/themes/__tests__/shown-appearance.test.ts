import { afterEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ native: { themeSource: 'system', shouldUseDarkColors: true, inForcedColorsMode: false, prefersReducedTransparency: false, on: vi.fn(), off: vi.fn() } }));
vi.mock('electron', () => ({ nativeTheme: H.native }));

import type { ThemeFile } from '../../../../shared/themes/schema';
import { stillUrl, themeBlobUrl, type ShellWallpaper } from '../../../../shared/themes/wallpapers';
import { currentCharacters, currentTheme, currentWallpapers, followThemeSettings, renderAppearance, setWallpaperFlashReader, setWallpaperStatsReader } from '../../theme';
import { DEFAULT_SHELL_LAYOUT } from '../../window-layout-store';
import { renderedAppearance, stillWallpaper } from '../shown-appearance';
import { BUILTIN_THEME } from '../../../../shared/themes/builtin';
import type { LibraryEntry, ThemeLibrary } from '../theme-files';

// The window's look and the drawn preview's come from one builder: for one theme they paint the same CSS, wallpapers and
// characters, and the preview serves exactly the files it draws.

const ID = '1f8fad5b-d9cb-469f-a165-70867728950e';
const VIDEO = 'a'.repeat(64);
const IMAGE = 'b'.repeat(64);
const SPRITE = 'c'.repeat(64);
const GIF = 'd'.repeat(64);
const license = {};
const THEME: ThemeFile = {
  schemaVersion: 1,
  id: ID,
  name: 'Tide',
  looks: {
    dark: {
      colors: { background: '#101418', panel: '#151a20', text: '#e6edf3', accent: '#4cc2ff', success: '#3fcf8e', warning: '#f0b429', danger: '#f2555a', info: '#8ab4ff' },
      wallpapers: [{ panels: { sidebar: { asset: VIDEO, fit: 'fill', dim: 0.1, blur: 4 }, chat: { asset: IMAGE, fit: 'fill', dim: 0.1, blur: 0 } } }],
    },
  },
  assets: {
    [VIDEO]: { kind: 'video', mime: 'video/mp4', bytes: 10, width: 1920, height: 1080, durationMs: 4000, license },
    [IMAGE]: { kind: 'image', mime: 'image/png', bytes: 10, width: 640, height: 480, license },
    [SPRITE]: { kind: 'sprite', mime: 'image/png', bytes: 10, width: 16, height: 16, license },
    [GIF]: { kind: 'sprite', mime: 'image/gif', bytes: 10, width: 16, height: 16, frames: 4, durationMs: 400, license },
  },
  characters: { name: 'Crew', characters: [{ name: 'Ada', states: { idle: { asset: SPRITE }, running: { asset: GIF } } }] },
  css: { sidebar: '[data-project-row] { color: #ff0000; }', transcript: '[data-tool-card] { color: #00ff00; }' },
};

function library(): ThemeLibrary {
  const entry: LibraryEntry = { status: 'ok', id: ID, builtin: false, theme: THEME };
  return { entry: (id: string) => (id === ID ? entry : undefined), entries: () => new Map([[ID, entry]]), onDidChange: () => ({ dispose: () => undefined }) } as unknown as ThemeLibrary;
}

function settings(values: Record<string, unknown>) {
  return { get: <T>(key: string): T | undefined => values[key] as T | undefined, onDidChange: () => ({ dispose: () => undefined }) };
}

const stats = { p10: 0.2, p90: 0.9, mean: 0.5 };
let disposals: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const disposal of disposals) disposal.dispose();
  disposals = [];
});

// the window shows THEME's dark look with its characters held still, as the preview draws them
async function showTheme(values: Record<string, unknown> = {}): Promise<void> {
  setWallpaperStatsReader(async (sha) => (sha === VIDEO || sha === IMAGE ? stats : undefined));
  setWallpaperFlashReader(async (sha) => (sha === GIF || sha === VIDEO ? { flagged: false } : undefined));
  disposals.push(followThemeSettings(settings({ 'damocles.desktop.theme': 'dark', 'damocles.desktop.themes.dark': ID, 'damocles.desktop.reduceMotion': true, 'damocles.desktop.textSize': 15, ...values }), library()));
  // the window reads stats and flash checks after its first paint, and paints again once they land
  if (values['damocles.desktop.themes.showWallpapers'] !== false) await vi.waitFor(() => expect(currentWallpapers()?.regions.find((region) => region.panel === 'sidebar')?.dim).not.toBe(0.1));
  await vi.waitFor(() => expect(currentCharacters()?.characters[0]?.states.running).toBeDefined());
}

describe('shownAppearance', () => {
  it('gives the drawn preview what the window paints for the same theme, its moving wallpapers as their stills', async () => {
    await showTheme();
    const { appearance } = await renderAppearance(THEME, 'dark', DEFAULT_SHELL_LAYOUT);
    const window = currentTheme();
    expect(appearance.kind).toBe('dark');
    expect(appearance.css).toBe(window.css);
    expect(appearance.trustedCss).toBe(window.trustedCss);
    expect(appearance.shellCss).toBe(currentTheme('region', 'shell').customCss);
    expect(appearance.chatCss).toBe(currentTheme('region', 'chat').customCss);
    expect(appearance.wallpapers).toEqual(currentWallpapers()!.regions.map(stillWallpaper));
    expect(appearance.characters).toEqual(currentCharacters());
    // the readable dim, from the stats read before the drawing
    expect(appearance.wallpapers!.every((region) => region.dim > 0.1)).toBe(true);
  });

  it('serves only what the preview draws: the still image, the video\'s still frame, the still sprite and only the animated one\'s still frame', async () => {
    await showTheme();
    const { appearance, served } = await renderAppearance(THEME, 'dark', DEFAULT_SHELL_LAYOUT);
    expect(appearance.wallpapers!.map((region) => [region.panel, region.url])).toEqual([['sidebar', stillUrl(VIDEO)], ['chat', themeBlobUrl(IMAGE)]]);
    expect(appearance.wallpapers!.some((region) => region.moving !== undefined)).toBe(false);
    expect(appearance.characters?.motion).toBe('still');
    expect(Object.fromEntries(served.blobs)).toEqual({ [IMAGE]: { kind: 'image', mime: 'image/png' }, [SPRITE]: { kind: 'sprite', mime: 'image/png' } });
    expect([...served.stills].sort()).toEqual([VIDEO, GIF].sort());
  });

  it('draws the wallpapers while Show wallpapers hides them in the window, and lays the panes out in the window\'s arrangement', async () => {
    await showTheme({ 'damocles.desktop.themes.showWallpapers': false });
    expect(currentWallpapers()).toBeUndefined();
    const { appearance } = await renderAppearance(THEME, 'dark', DEFAULT_SHELL_LAYOUT);
    expect(appearance.wallpapers).toHaveLength(2);
    expect(appearance.arrangement.sidebarWidth).toBe(Math.round(DEFAULT_SHELL_LAYOUT.sidebarWidth));
    expect(Object.keys(appearance.arrangement).sort()).toEqual(['grid', 'sectionOrder', 'sections', 'sidebarWidth']);
    const own = await renderAppearance({ ...THEME, layout: { sidebarWidth: 400 } }, 'dark', DEFAULT_SHELL_LAYOUT);
    expect(own.appearance.arrangement.sidebarWidth).toBe(400);
    // the sample window always draws the sidebar, so a hidden one still takes its width from the side pane's room
    const hidden = { ...DEFAULT_SHELL_LAYOUT, sidebarVisible: false, grid: { ...DEFAULT_SHELL_LAYOUT.grid, sideWidth: 2000 } };
    const wide = (await renderAppearance(THEME, 'dark', hidden)).appearance.arrangement;
    expect(1280 - wide.sidebarWidth - wide.grid.sideWidth).toBeGreaterThanOrEqual(300);
    await expect(renderAppearance(THEME, 'light', DEFAULT_SHELL_LAYOUT)).rejects.toThrow('no light look');
    // core writes the still frame before the flash check, so a moving wallpaper with no check has no still to draw yet
    setWallpaperFlashReader(async (sha) => (sha === GIF ? { flagged: false } : undefined));
    await expect(renderAppearance(THEME, 'dark', DEFAULT_SHELL_LAYOUT)).rejects.toThrow(`The moving wallpaper ${VIDEO} has no still frame yet`);
  });
});

describe('the files a drawn preview is served', () => {
  const FONT = 'e'.repeat(64);
  const SVG = 'f'.repeat(64);
  const vector = (): ThemeFile => ({
    ...THEME,
    looks: { dark: { colors: THEME.looks.dark!.colors } },
    style: { fonts: { ui: { asset: FONT, family: 'Tide Sans' } } },
    assets: {
      [FONT]: { kind: 'font', mime: 'font/woff2', bytes: 10, family: 'Tide Sans', license },
      [SVG]: { kind: 'sprite', mime: 'image/svg+xml', bytes: 10, width: 16, height: 16, license },
    },
    characters: { name: 'Crew', characters: [{ name: 'Ada', states: { idle: { asset: SVG } } }] },
    css: {},
  });

  it('serve a bundled font as a blob, and an SVG sprite as its still frame once drawn, else as the sprite itself', async () => {
    await showTheme();
    setWallpaperFlashReader(async (sha) => (sha === SVG ? { flagged: false } : undefined));
    const drawn = await renderAppearance(vector(), 'dark', DEFAULT_SHELL_LAYOUT);
    expect(Object.fromEntries(drawn.served.blobs)).toEqual({ [FONT]: { kind: 'font', mime: 'font/woff2' } });
    expect([...drawn.served.stills]).toEqual([SVG]);
    setWallpaperFlashReader(async () => undefined);
    const undrawn = await renderAppearance(vector(), 'dark', DEFAULT_SHELL_LAYOUT);
    expect(Object.fromEntries(undrawn.served.blobs)).toEqual({ [FONT]: { kind: 'font', mime: 'font/woff2' }, [SVG]: { kind: 'sprite', mime: 'image/svg+xml' } });
    expect(undrawn.served.stills.size).toBe(0);
  });

  it('refuse a URL its theme does not name, as a builder fault', async () => {
    await showTheme();
    const { appearance } = await renderAppearance(THEME, 'dark', DEFAULT_SHELL_LAYOUT);
    const shown = { kind: 'dark', assets: THEME.assets } as unknown as Parameters<typeof renderedAppearance>[0];
    const look = { css: '', trusted: { region: '', root: '' }, custom: {}, wallpapers: { regions: [{ ...appearance.wallpapers![1]!, url: themeBlobUrl(SVG) }] } } as unknown as Parameters<typeof renderedAppearance>[1];
    expect(() => renderedAppearance(shown, look, appearance.arrangement, 'linux')).toThrow(`The drawn preview names a file its theme does not: ${themeBlobUrl(SVG)}`);
  });

  it('draw the built-in theme with its own palette, as the window paints it', async () => {
    disposals.push(followThemeSettings(settings({ 'damocles.desktop.theme': 'dark' }), library()));
    const { appearance } = await renderAppearance(BUILTIN_THEME, 'dark', DEFAULT_SHELL_LAYOUT);
    expect(appearance.css).toBe(currentTheme().css);
  });
});

describe('stillWallpaper', () => {
  it('turns a moving wallpaper into its still frame at the same place and size, and leaves a still one as it is', () => {
    const still: ShellWallpaper = { panel: 'chat', asset: IMAGE, fit: 'fill', dim: 0.3, blur: 2, url: themeBlobUrl(IMAGE), width: 640, height: 480 };
    const moving: ShellWallpaper = { ...still, panel: 'sidebar', asset: VIDEO, url: themeBlobUrl(VIDEO), width: 1920, height: 1080, moving: { kind: 'video', still: stillUrl(VIDEO), playable: true } };
    expect(stillWallpaper(still)).toBe(still);
    expect(stillWallpaper(moving)).toEqual({ panel: 'sidebar', asset: VIDEO, fit: 'fill', dim: 0.3, blur: 2, url: stillUrl(VIDEO), width: 1920, height: 1080 });
  });
});
