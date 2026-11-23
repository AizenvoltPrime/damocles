// A wallpaper's luminance stats, from the samples the theme render page draws of it.
import type { ImageStats } from '@shared/themes/wallpapers';

const linear = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/**
 * WCAG relative luminance at the 10th and 90th percentiles and the mean, over 64x64 samples of one frame or a few. A fully
 * transparent pixel shows the pane's own color, which the derived text already passes over, so it is left out; an image of
 * nothing else has the stats of black.
 */
export function luminanceStats(samples: readonly Uint8ClampedArray[]): ImageStats {
  const values: number[] = [];
  for (const data of samples) {
    for (let at = 0; at + 3 < data.length; at += 4) {
      if (data[at + 3] === 0) continue;
      values.push(0.2126 * linear(data[at]! / 255) + 0.7152 * linear(data[at + 1]! / 255) + 0.0722 * linear(data[at + 2]! / 255));
    }
  }
  if (values.length === 0) return { p10: 0, p90: 0, mean: 0 };
  values.sort((a, b) => a - b);
  const at = (share: number): number => values[Math.round(share * (values.length - 1))]!;
  return { p10: at(0.1), p90: at(0.9), mean: values.reduce((sum, value) => sum + value, 0) / values.length };
}
