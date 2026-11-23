// Palette from wallpaper (docs/themes.md "Wallpapers"): the image's most suitable source color by Material's quantizer and
// score, and the 8 colors of each look built from its tonal palettes; deriveLook keeps the text at AA. The theme render page
// and the theme editor bundle it; core and main never do.
import { argbFromHex, argbFromRgb, Blend, Hct, hexFromArgb, QuantizerCelebi, Score, TonalPalette } from '@material/material-color-utilities';
import { BUILTIN_PALETTES } from '@shared/themes/builtin';
import type { LookColors } from '@shared/themes/schema';
import type { LookKind } from '@shared/themes/tokens';
import type { WallpaperPalette } from '@shared/themes/wallpapers';

// Colors the quantizer clusters the sample into.
const MAX_COLORS = 128;
// Used when no color of the image is suitable: a mid blue.
const FALLBACK = 0xff4285f4;
// Tones of each look, in HCT tone (0 black, 100 white).
const TONES: Readonly<Record<LookKind, { readonly background: number; readonly panel: number; readonly text: number; readonly accent: number }>> = {
  dark: { background: 6, panel: 10, text: 92, accent: 80 },
  light: { background: 98, panel: 94, text: 10, accent: 40 },
};
const STATUS = ['success', 'warning', 'danger', 'info'] as const;

/** The source color of RGBA pixels; transparent pixels are skipped. */
export function sourceColor(rgba: Uint8ClampedArray): number {
  const pixels: number[] = [];
  for (let at = 0; at + 3 < rgba.length; at += 4) {
    if (rgba[at + 3]! < 255) continue;
    pixels.push(argbFromRgb(rgba[at]!, rgba[at + 1]!, rgba[at + 2]!));
  }
  if (pixels.length === 0) return FALLBACK;
  return Score.score(QuantizerCelebi.quantize(pixels, MAX_COLORS), { desired: 1, fallbackColorARGB: FALLBACK, filter: true })[0] ?? FALLBACK;
}

/** The 8 colors of each look from a source color: neutral surfaces and text of its hue, its accent, and status hues pulled toward it. */
export function paletteFromSource(source: number): WallpaperPalette {
  const hct = Hct.fromInt(source);
  const neutral = TonalPalette.fromHueAndChroma(hct.hue, Math.min(hct.chroma / 6, 8));
  const primary = TonalPalette.fromHueAndChroma(hct.hue, Math.max(hct.chroma, 36));
  const look = (kind: LookKind): LookColors => {
    const tones = TONES[kind];
    const status = Object.fromEntries(STATUS.map((tone) => [tone, hexFromArgb(Blend.harmonize(argbFromHex(BUILTIN_PALETTES[kind][`--d-${tone}-fill`]!), source))]));
    return {
      background: hexFromArgb(neutral.tone(tones.background)),
      panel: hexFromArgb(neutral.tone(tones.panel)),
      text: hexFromArgb(neutral.tone(tones.text)),
      accent: hexFromArgb(primary.tone(tones.accent)),
      ...status,
    } as LookColors;
  };
  return { dark: look('dark'), light: look('light') };
}

export const paletteFromPixels = (rgba: Uint8ClampedArray): WallpaperPalette => paletteFromSource(sourceColor(rgba));
