import { describe, expect, it } from 'vitest';
import { BUILTIN_PALETTES } from '../../../../shared/themes/builtin';
import { AA } from '../../../../shared/themes/contrast';
import { deriveLook } from '../../../../shared/themes/derive';
import type { Look } from '../../../../shared/themes/schema';
import { contrastOverImage, readableDim, TRUSTED_SURFACE_FLOOR, type FlashRecord, type ImageStats } from '../../../../shared/themes/wallpapers';
import { shownWallpapers, wallpapersOff, type WallpaperFlags } from '../wallpapers';
import type { ShownTheme } from '../appearance';

// Text over a wallpaper stays readable (docs/invariants.md "Desktop themes"): raiseDim dims the image until muted text reaches
// 4.5:1 over its 10th and 90th luminance percentiles; warn keeps the dim and says where it falls short.

const SHA = 'a'.repeat(64);
const BRIGHT: ImageStats = { p10: 0.35, p90: 0.85, mean: 0.6 };
const DARK_IMAGE: ImageStats = { p10: 0.01, p90: 0.08, mean: 0.04 };
const COLORS = { background: '#0b1020', panel: '#10172a', text: '#e4ecf5', accent: '#5ee6b0', success: '#4fd18b', warning: '#f2c14e', danger: '#ff6b7a', info: '#8ab4ff' };
const look: Look = { colors: COLORS, surfaceOpacity: 0.8, wallpapers: [{ span: { asset: SHA, panels: ['sidebar', 'chat'], fit: 'fill' }, spanLook: { sidebar: { dim: 0.2, blur: 4 }, chat: { dim: 0.2, blur: 4 } } }] };
const shown: Pick<ShownTheme, 'look' | 'assets' | 'decidedBy'> = {
  look,
  assets: { [SHA]: { kind: 'image', mime: 'image/png', bytes: 1000, width: 2400, height: 1600, license: {} } },
  decidedBy: 'mode',
};
const palette = deriveLook(COLORS, 'dark');
const FLAGS: WallpaperFlags = { enabled: true, gpuCompositing: true, reducedTransparency: false, contrast: 'raiseDim' };
const url = (sha: string): string => `app://damocles/theme-blob/${sha}`;

describe('readableDim', () => {
  it('raises the dim to the least value that brings muted text to 4.5:1 over both percentiles', () => {
    const muted = BUILTIN_PALETTES.dark['--d-muted']!;
    const bg = BUILTIN_PALETTES.dark['--d-bg']!;
    expect(contrastOverImage(muted, bg, 0.2, BRIGHT)).toBeLessThan(AA);
    const dim = readableDim(muted, bg, 0.2, BRIGHT);
    expect(contrastOverImage(muted, bg, dim, BRIGHT)).toBeGreaterThanOrEqual(AA);
    expect(contrastOverImage(muted, bg, dim - 0.01, BRIGHT)).toBeLessThan(AA);
  });

  it('keeps a dim that already reads, and never lowers one', () => {
    const muted = BUILTIN_PALETTES.dark['--d-muted']!;
    const bg = BUILTIN_PALETTES.dark['--d-bg']!;
    const enough = readableDim(muted, bg, 0, DARK_IMAGE);
    expect(readableDim(muted, bg, enough, DARK_IMAGE)).toBe(enough);
    expect(readableDim(muted, bg, 0.8, DARK_IMAGE)).toBe(0.8);
  });

  it('reaches 4.5:1 for light text over a bright image and dark text over a dark one, dimming up to the full pane color', () => {
    for (const kind of ['dark', 'light'] as const) {
      const { '--d-muted': muted, '--d-bg': bg } = BUILTIN_PALETTES[kind];
      for (const stats of [BRIGHT, DARK_IMAGE, { p10: 0, p90: 1, mean: 0.5 }]) {
        const dim = readableDim(muted!, bg!, 0, stats);
        expect(dim).toBeLessThanOrEqual(1);
        expect(contrastOverImage(muted!, bg!, dim, stats), `${kind} ${JSON.stringify(stats)}`).toBeGreaterThanOrEqual(AA);
      }
    }
  });
});

describe('shownWallpapers', () => {
  it('raises each region\'s dim until muted text reads at 4.5:1 over its image', () => {
    const shownNow = shownWallpapers(shown, palette, FLAGS, () => BRIGHT, url)!;
    expect(shownNow.regions.map((region) => region.panel)).toEqual(['sidebar', 'chat']);
    for (const region of shownNow.regions) {
      const pane = region.panel === 'sidebar' ? palette['--d-panel']! : palette['--d-bg']!;
      expect(region.dim).toBeGreaterThan(0.2);
      expect(contrastOverImage(palette['--d-muted']!, pane, region.dim, BRIGHT)).toBeGreaterThanOrEqual(AA);
    }
    expect(shownNow.lowContrast).toEqual([]);
  });

  it('keeps the dim under warn and names each panel that reads below 4.5:1', () => {
    const warned = shownWallpapers(shown, palette, { ...FLAGS, contrast: 'warn' }, () => BRIGHT, url)!;
    expect(warned.regions.map((region) => region.dim)).toEqual([0.2, 0.2]);
    expect(warned.lowContrast.map((low) => low.panel)).toEqual(['sidebar', 'chat']);
  });

  it('keeps the set dim until the image\'s stats are known', () => {
    expect(shownWallpapers(shown, palette, FLAGS, () => undefined, url)!.regions.map((region) => region.dim)).toEqual([0.2, 0.2]);
  });

  it('makes only the wallpapered panes transparent, and sets the surface alpha with its floor on trusted cards', () => {
    const { tokens, trustedAlpha } = shownWallpapers(shown, palette, FLAGS, () => BRIGHT, url)!;
    expect(tokens['--d-pane-sidebar']).toBe(`${palette['--d-panel']}00`);
    expect(tokens['--d-pane-chat']).toBe(`${palette['--d-bg']}00`);
    expect(tokens['--d-pane-editor']).toBeUndefined();
    expect(tokens['--d-bg']).toBeUndefined();
    expect(tokens['--d-surface-alpha']).toBe('0.8');
    expect(Number(trustedAlpha)).toBe(TRUSTED_SURFACE_FLOOR);
  });

  it('keeps surfaces opaque under reduced transparency, the wallpapers still showing', () => {
    const reduced = shownWallpapers(shown, palette, { ...FLAGS, reducedTransparency: true }, () => BRIGHT, url)!;
    expect(reduced.regions).toHaveLength(2);
    expect(reduced.tokens['--d-surface-alpha']).toBe('1');
    expect(reduced.trustedAlpha).toBe('1');
  });

  it.each([
    ['forced colors', { decidedBy: 'forcedColors' as const }, FLAGS, 'forcedColors'],
    ['safe start', { decidedBy: 'safeStart' as const }, FLAGS, 'safeStart'],
    ['the Show wallpapers setting off', {}, { ...FLAGS, enabled: false }, 'setting'],
    ['GPU compositing off', {}, { ...FLAGS, gpuCompositing: false }, 'gpu'],
  ])('shows none under %s', (_name, override, flags, reason) => {
    const under = { ...shown, ...override };
    expect(wallpapersOff(under, flags)).toBe(reason);
    expect(shownWallpapers(under, palette, flags, () => BRIGHT, url)).toBeUndefined();
  });
});

describe('moving wallpapers and wallpaper sets', () => {
  const VIDEO = 'b'.repeat(64);
  const GIF = 'c'.repeat(64);
  const movingLook: Look = {
    colors: COLORS,
    wallpapers: [
      { span: { asset: VIDEO, panels: ['sidebar', 'chat'], fit: 'fill' }, spanLook: { sidebar: { dim: 0.2, blur: 20 }, chat: { dim: 0.2, blur: 6 } } },
      { panels: { editor: { asset: GIF, fit: 'tile', dim: 0.3, blur: 24 } } },
      { panels: { terminal: { asset: SHA, fit: 'fill', dim: 0.3, blur: 24 } } },
    ],
  };
  const moving: Pick<ShownTheme, 'look' | 'assets' | 'decidedBy'> = {
    look: movingLook,
    decidedBy: 'mode',
    assets: {
      [VIDEO]: { kind: 'video', mime: 'video/mp4', bytes: 1000, width: 1920, height: 1080, durationMs: 4000, license: {} },
      [GIF]: { kind: 'animated', mime: 'image/gif', bytes: 1000, width: 64, height: 64, frames: 8, license: {} },
      [SHA]: { kind: 'image', mime: 'image/png', bytes: 1000, width: 1600, height: 1000, license: {} },
    },
  };

  it('caps a moving wallpaper\'s blur at 8 px, and keeps a still one\'s up to 24 px', () => {
    const video = shownWallpapers(moving, palette, FLAGS, () => BRIGHT, url, 0)!;
    expect(video.regions.map((region) => [region.panel, region.blur])).toEqual([['sidebar', 8], ['chat', 6]]);
    expect(shownWallpapers(moving, palette, FLAGS, () => BRIGHT, url, 1)!.regions[0]).toMatchObject({ panel: 'editor', blur: 8 });
    expect(shownWallpapers(moving, palette, FLAGS, () => BRIGHT, url, 2)!.regions[0]).toMatchObject({ panel: 'terminal', blur: 24 });
  });

  it('shows the set the cycle names, wrapping past the last', () => {
    expect(shownWallpapers(moving, palette, FLAGS, () => BRIGHT, url, 4)!.regions.map((region) => region.panel)).toEqual(['editor']);
    expect(shownWallpapers(moving, palette, FLAGS, () => BRIGHT, url, -1)!.regions.map((region) => region.panel)).toEqual(['terminal']);
  });

  it('carries a moving wallpaper\'s still frame, and lets it play only once its flash check passed or the user allowed it', () => {
    const regionOf = (flash: FlashRecord | undefined) => shownWallpapers(moving, palette, FLAGS, () => BRIGHT, url, 0, () => flash)!.regions[0]!;
    expect(regionOf(undefined).moving).toEqual({ kind: 'video', still: `app://damocles/theme-cache/${VIDEO}/still.png`, playable: false });
    expect(regionOf({ flagged: false }).moving?.playable).toBe(true);
    expect(regionOf({ flagged: true, atMs: 250 }).moving?.playable).toBe(false);
    expect(regionOf({ flagged: true, atMs: 250, allowed: true }).moving?.playable).toBe(true);
    expect(shownWallpapers(moving, palette, FLAGS, () => BRIGHT, url, 2)!.regions[0]!.moving).toBeUndefined();
  });
});
