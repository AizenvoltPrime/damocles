import { describe, expect, it } from 'vitest';
import { argbFromHex, Hct, hexFromArgb } from '@material/material-color-utilities';
import { BUILTIN_PALETTES } from '@shared/themes/builtin';
import { checkPalette, contrast, luminance, parse } from '@shared/themes/contrast';
import { deriveLook } from '@shared/themes/derive';
import { LOOK_SEEDS } from '@shared/themes/schema';
import { LOOK_KINDS } from '@shared/themes/tokens';
import { isWallpaperPalette } from '@shared/themes/wallpapers';
import { paletteFromPixels, paletteFromSource, sourceColor } from '../themes/wallpaper-palette';

// Palette from wallpaper: the source color Material's quantizer and score pick from an image's pixels, and the 8 colors of
// each look built from it, which the theme renderer answers and the editor's Palette from wallpaper applies.

const FALLBACK = 0xff4285f4;

/** RGBA pixels: `count` of each [r, g, b, a]. */
function pixels(...runs: ReadonlyArray<readonly [readonly [number, number, number, number], number]>): Uint8ClampedArray {
  const out: number[] = [];
  for (const [rgba, count] of runs) for (let i = 0; i < count; i++) out.push(...rgba);
  return new Uint8ClampedArray(out);
}

const hueOf = (argb: number): number => Hct.fromInt(argb).hue;
const hueGap = (a: number, b: number): number => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('the source color of a wallpaper', () => {
  it('is the image\'s dominant suitable color, and skips every pixel that is not fully opaque', () => {
    const teal = [0, 128, 128, 255] as const;
    const source = sourceColor(pixels([teal, 500], [[255, 0, 0, 254], 5000], [[255, 0, 0, 0], 5000]));
    expect(hueGap(hueOf(source), hueOf(argbFromHex('#008080')))).toBeLessThan(5);
  });

  it('falls back to a mid blue when no pixel is opaque, or the image holds no color Material finds suitable', () => {
    expect(sourceColor(new Uint8ClampedArray(0))).toBe(FALLBACK);
    expect(sourceColor(pixels([[200, 30, 30, 128], 100]))).toBe(FALLBACK);
    expect(sourceColor(pixels([[128, 128, 128, 255], 400]))).toBe(FALLBACK);
  });
});

describe('the palette of a source color', () => {
  const SOURCES = ['#d32f2f', '#1e88e5', '#43a047', '#fbc02d', '#8e24aa', '#4285f4'].map(argbFromHex);

  it('gives both looks all 8 seed colors as #rrggbb, a dark look dark and a light look light', () => {
    for (const source of SOURCES) {
      const palette = paletteFromSource(source);
      expect(isWallpaperPalette(palette)).toBe(true);
      for (const kind of LOOK_KINDS) {
        expect(Object.keys(palette[kind]).sort()).toEqual([...LOOK_SEEDS].sort());
        for (const seed of LOOK_SEEDS) expect(palette[kind][seed], `${kind} ${seed}`).toMatch(/^#[0-9a-f]{6}$/);
      }
      expect(luminance(parse(palette.dark.background))).toBeLessThan(0.02);
      expect(luminance(parse(palette.light.background))).toBeGreaterThan(0.85);
      expect(contrast(palette.dark.text, palette.dark.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(palette.light.text, palette.light.background)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('takes its accent and the hue of its neutrals from the source, and pulls each status color toward it', () => {
    const source = argbFromHex('#8e24aa');
    const palette = paletteFromSource(source);
    for (const kind of LOOK_KINDS) {
      expect(hueGap(hueOf(argbFromHex(palette[kind].accent)), hueOf(source)), kind).toBeLessThan(10);
      expect(hueGap(hueOf(argbFromHex(palette[kind].panel)), hueOf(source)), kind).toBeLessThan(20);
      for (const tone of ['success', 'warning', 'danger', 'info'] as const) {
        const builtin = argbFromHex(BUILTIN_PALETTES[kind][`--d-${tone}-fill`]!);
        expect(hueGap(hueOf(argbFromHex(palette[kind][tone])), hueOf(source)), `${kind} ${tone}`).toBeLessThanOrEqual(hueGap(hueOf(builtin), hueOf(source)));
      }
    }
  });

  it('derives looks whose text passes every contrast rule', () => {
    for (const source of SOURCES) {
      const palette = paletteFromSource(source);
      for (const kind of LOOK_KINDS) {
        const errors = checkPalette(deriveLook(palette[kind], kind), kind).filter((issue) => issue.severity === 'error');
        expect(errors, `${hexFromArgb(source)} ${kind}`).toEqual([]);
      }
    }
  });

  it('is the palette of the pixels\' source color', () => {
    const image = pixels([[30, 136, 229, 255], 300], [[250, 250, 250, 255], 50]);
    expect(paletteFromPixels(image)).toEqual(paletteFromSource(sourceColor(image)));
  });
});
