// The theme render page's luminance stats of a wallpaper's samples.
import { describe, expect, it } from 'vitest';
import { luminanceStats } from '../stats';

const pixels = (...rgba: ReadonlyArray<readonly [number, number, number, number]>): Uint8ClampedArray => Uint8ClampedArray.from(rgba.flat());
const WHITE = [255, 255, 255, 255] as const;
const BLACK = [0, 0, 0, 255] as const;
const CLEAR = [0, 0, 0, 0] as const;

describe('luminanceStats', () => {
  it('reads the percentiles and the mean of opaque pixels', () => {
    expect(luminanceStats([pixels(WHITE, WHITE, WHITE, WHITE)])).toEqual({ p10: 1, p90: 1, mean: 1 });
    const mixed = luminanceStats([pixels(BLACK, BLACK), pixels(WHITE, WHITE)]);
    expect(mixed).toEqual({ p10: 0, p90: 1, mean: 0.5 });
  });

  it('leaves fully transparent pixels out: they show the pane, not black', () => {
    // a white logo on a transparent canvas is a light image, not a dark one with a light corner
    expect(luminanceStats([pixels(CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, CLEAR, WHITE, WHITE)])).toEqual({ p10: 1, p90: 1, mean: 1 });
  });

  it('counts a partly transparent pixel by its own color', () => {
    expect(luminanceStats([pixels([255, 255, 255, 1])])).toEqual({ p10: 1, p90: 1, mean: 1 });
  });

  it('answers the stats of black for an image that is transparent everywhere', () => {
    expect(luminanceStats([pixels(CLEAR, CLEAR)])).toEqual({ p10: 0, p90: 0, mean: 0 });
    expect(luminanceStats([])).toEqual({ p10: 0, p90: 0, mean: 0 });
  });
});
