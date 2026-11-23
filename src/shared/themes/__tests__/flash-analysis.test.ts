import { describe, expect, it } from 'vitest';
import { analyzeLoop, DARKER_LIMIT, FLASH_SAMPLE_SIDE, FlashAnalyzer, GENERAL_DELTA, MIN_MEAN_FRAME_MS, RED_DELTA, WALLPAPER_FLASH_FIELD } from '../flash';

// WCAG 2.3.1 on a moving image's 64x64 samples: more than three flashes (pairs of opposing transitions) in any second over a
// quarter of a 10 degree field fail, for general flashes and for red ones. The field is the whole sample unless one is given.

type Rgb = readonly [number, number, number];
const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];
const GRAY: Rgb = [128, 128, 128];

/** A sample whose first `share` of rows is `top` and the rest `rest`. */
function frame(top: Rgb, share: number, rest: Rgb = GRAY): Uint8ClampedArray {
  const side = FLASH_SAMPLE_SIDE;
  const rgba = new Uint8ClampedArray(side * side * 4);
  const rows = Math.round(side * share);
  for (let y = 0; y < side; y++) {
    const [r, g, b] = y < rows ? top : rest;
    for (let x = 0; x < side; x++) rgba.set([r, g, b, 255], (y * side + x) * 4);
  }
  return rgba;
}

/** `flashes` flashes a second for `seconds`, each state shown for half a flash, over `share` of the frame. */
function flashing(flashes: number, seconds: number, share: number, on: Rgb = WHITE, off: Rgb = BLACK): Array<readonly [Uint8ClampedArray, number]> {
  const state = 1000 / (flashes * 2);
  return Array.from({ length: Math.round((seconds * 1000) / state) }, (_, i) => [frame(i % 2 === 0 ? off : on, share), state] as const);
}

const linear = (value: number): number => (value / 255 <= 0.04045 ? value / 255 / 12.92 : ((value / 255 + 0.055) / 1.055) ** 2.4);
/** The lowest sRGB level whose linear value, a gray's relative luminance, `passes`. */
const grayAt = (passes: (linear: number) => boolean): number => Array.from({ length: 256 }, (_, value) => value).find((value) => passes(linear(value)))!;

function run(frames: ReadonlyArray<readonly [Uint8ClampedArray, number]>) {
  const analyzer = new FlashAnalyzer();
  let at = 0;
  for (const [rgba, duration] of frames) {
    if (analyzer.push(rgba, at)) break;
    at += duration;
  }
  return analyzer.result();
}

describe('the flash analysis', () => {
  it('fails 4 flashes in one second over half the frame, naming the start of the second that fails', () => {
    const result = run(flashing(4, 3, 0.5));
    expect(result).toEqual({ flagged: true, atMs: 125, kind: 'general' });
  });

  it('passes 3 flashes a second, the most the threshold allows', () => {
    expect(run(flashing(3, 4, 0.5))).toEqual({ flagged: false });
  });

  it('passes 4 flashes a second over a tenth of the frame, below a quarter of it', () => {
    expect(run(flashing(4, 3, 0.1))).toEqual({ flagged: false });
  });

  it('fails 4 flashes a second over more than a quarter of the frame', () => {
    expect(run(flashing(4, 3, 0.3)).flagged).toBe(true);
  });

  it('fails at exactly a quarter of the cells and passes one cell below', () => {
    const cells = (lit: number, on: boolean): Uint8ClampedArray => Uint8ClampedArray.from({ length: 4 * 4 * 4 }, (_, i) => (i % 4 === 3 ? 255 : on && Math.floor(i / 4) < lit ? 255 : 0));
    const sequence = (lit: number) => Array.from({ length: 24 }, (_, i) => [cells(lit, i % 2 === 1), 125] as const);
    expect(analyzeLoop(sequence(4), 4).flagged).toBe(true);
    expect(analyzeLoop(sequence(3), 4)).toEqual({ flagged: false });
  });

  it('fails at a luminance step of a tenth and passes the gray level below it', () => {
    const step = grayAt((luminance) => luminance >= GENERAL_DELTA);
    expect(run(flashing(4, 3, 1, [step, step, step], BLACK))).toMatchObject({ flagged: true, kind: 'general' });
    expect(run(flashing(4, 3, 1, [step - 1, step - 1, step - 1], BLACK))).toEqual({ flagged: false });
  });

  it('passes while the darker state is at 0.8 or above and fails the gray level below it', () => {
    const bright = grayAt((luminance) => luminance >= DARKER_LIMIT);
    expect(run(flashing(4, 3, 1, WHITE, [bright, bright, bright]))).toEqual({ flagged: false });
    expect(run(flashing(4, 3, 1, WHITE, [bright - 1, bright - 1, bright - 1]))).toMatchObject({ flagged: true, kind: 'general' });
  });

  it('fails a red change of more than 20 and passes the red level below it', () => {
    const red = grayAt((linear) => linear * 320 > RED_DELTA);
    expect(run(flashing(4, 3, 1, [red, 0, 0], BLACK))).toMatchObject({ flagged: true, kind: 'red' });
    expect(run(flashing(4, 3, 1, [red - 1, 0, 0], BLACK))).toEqual({ flagged: false });
  });

  describe('over a wallpaper, which fills the window', () => {
    const side = FLASH_SAMPLE_SIDE;
    /** Frames flashing 4 times a second in the cells `lit` picks, the rest gray. */
    const flashingCells = (lit: (x: number, y: number) => boolean): Array<readonly [Uint8ClampedArray, number]> => Array.from({ length: 24 }, (_, i) => {
      const rgba = new Uint8ClampedArray(side * side * 4);
      for (let y = 0; y < side; y++) {
        for (let x = 0; x < side; x++) {
          const value = lit(x, y) ? (i % 2 === 0 ? 0 : 255) : 128;
          rgba.set([value, value, value, 255], (y * side + x) * 4);
        }
      }
      return [rgba, 125] as const;
    });
    const block = (left: number, top: number, width: number, height: number) => (x: number, y: number): boolean => x >= left && x < left + width && y >= top && y < top + height;
    const wallpaper = (lit: (x: number, y: number) => boolean) => analyzeLoop(flashingCells(lit), side, WALLPAPER_FLASH_FIELD);

    it('takes the 10 degree field as a third of the sample each way', () => {
      expect(WALLPAPER_FLASH_FIELD).toBe(21);
    });

    it('fails a block that fills a quarter of one field, wherever it sits, and passes one cell row less', () => {
      // a quarter of 21 x 21 cells is 110.25
      expect(wallpaper(block(20, 30, 11, 11)).flagged).toBe(true);
      expect(wallpaper(block(0, 0, 11, 11)).flagged).toBe(true);
      expect(wallpaper(block(53, 53, 11, 11)).flagged).toBe(true);
      expect(wallpaper(block(20, 30, 11, 10))).toEqual({ flagged: false });
    });

    it('fails a strip a tenth of the window high, which a quarter of the whole frame would pass', () => {
      expect(wallpaper(block(0, 0, side, 6)).flagged).toBe(true);
      expect(analyzeLoop(flashingCells(block(0, 0, side, 6))).flagged).toBe(false);
    });

    it('passes flashing cells that no one field holds a quarter of, however many there are', () => {
      const scattered = (x: number, y: number): boolean => x % 4 === 0 && y % 4 === 0;
      expect(wallpaper(scattered)).toEqual({ flagged: false });
    });
  });

  describe('transparent frames', () => {
    const clear = new Uint8ClampedArray(FLASH_SAMPLE_SIDE * FLASH_SAMPLE_SIDE * 4);
    const alternating = (opaque: Rgb): Array<readonly [Uint8ClampedArray, number]> => Array.from({ length: 40 }, (_, i) => [i % 2 === 0 ? frame(opaque, 1) : clear, 50] as const);

    it('fails black against transparent, which flashes over a light backdrop', () => {
      expect(analyzeLoop(alternating(BLACK))).toMatchObject({ flagged: true, kind: 'general' });
    });

    it('fails white against transparent, which flashes over a dark backdrop', () => {
      expect(analyzeLoop(alternating(WHITE))).toMatchObject({ flagged: true, kind: 'general' });
    });

    it('passes frames of one constant alpha', () => {
      const half = frame(BLACK, 1).map((value, i) => (i % 4 === 3 ? 128 : value));
      expect(analyzeLoop(Array.from({ length: 40 }, () => [half, 50] as const))).toEqual({ flagged: false });
    });
  });

  it('passes a fast flicker of less than a tenth of the maximum luminance', () => {
    expect(run(flashing(6, 3, 1, [150, 150, 150], [128, 128, 128]))).toEqual({ flagged: false });
  });

  it('passes a fast flicker between two bright states, whose darker one is above 0.8', () => {
    expect(run(flashing(6, 3, 1, [255, 255, 255], [235, 235, 235]))).toEqual({ flagged: false });
  });

  it('counts a fade over several frames as one transition', () => {
    // dark to light over three frames and back, four times a second
    const steps: Rgb[] = [[0, 0, 0], [90, 90, 90], [170, 170, 170], [255, 255, 255], [170, 170, 170], [90, 90, 90]];
    const frames = Array.from({ length: 6 * 4 * 3 }, (_, i) => [frame(steps[i % steps.length]!, 1), 1000 / 24] as const);
    expect(run(frames)).toMatchObject({ flagged: true, kind: 'general' });
  });

  it('fails a red flash whose luminance barely changes, as red', () => {
    // saturated red against the gray of about its luminance
    const result = run(flashing(4, 3, 0.5, [255, 0, 0], [127, 127, 127]));
    expect(result).toMatchObject({ flagged: true, kind: 'red' });
  });

  it('passes a red that is not saturated', () => {
    expect(run(flashing(4, 3, 0.5, [200, 120, 120], [190, 120, 120]))).toEqual({ flagged: false });
  });

  it('finds the flashes of a short animation that only fails across its loop point, and names a time inside the loop', () => {
    // two flashes in half a second, 4 a second once it loops
    const result = analyzeLoop(flashing(4, 0.5, 0.6));
    expect(result.flagged).toBe(true);
    expect(result.atMs).toBeGreaterThanOrEqual(0);
    expect(result.atMs).toBeLessThan(500);
  });

  it('names a whole millisecond for an animation whose frames last a fraction of one', () => {
    // an animated PNG's delay is a fraction of a second, so its loop is no whole number of ms long: a calm 1000.6 ms, then
    // eight flashes in the last 0.3 ms, whose start rounds to 1001 ms, past the loop's 1000.9
    const burst = Array.from({ length: 8 }, (_, i) => [frame(i % 2 === 0 ? WHITE : BLACK, 1), 0.0375] as const);
    const result = analyzeLoop([[frame(BLACK, 1), 1000.6], ...burst]);
    expect(result.flagged).toBe(true);
    expect(Number.isSafeInteger(result.atMs)).toBe(true);
    expect(result.atMs).toBeLessThan(1001);
  });

  it('passes a looping animation below the threshold, and a still one', () => {
    expect(analyzeLoop(flashing(1, 1, 1))).toEqual({ flagged: false });
    expect(analyzeLoop([[frame(WHITE, 1), 100]])).toEqual({ flagged: false });
    expect(analyzeLoop([])).toEqual({ flagged: false });
  });

  it('refuses a sample of the wrong size', () => {
    expect(() => new FlashAnalyzer().push(new Uint8ClampedArray(16), 0)).toThrow(/bytes/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -50])('refuses a frame that lasts %s ms, which it could not time', (duration) => {
    const frames = flashing(4, 3, 1).map(([rgba], i) => [rgba, i === 3 ? duration : 125] as const);
    expect(() => analyzeLoop(frames)).toThrow(/A frame lasts/);
  });

  // the pass past the loop's end reads a second's worth of frames, so a frame of almost no length would make it endless
  it('refuses a loop whose frames are too short on average, and reads one of the shortest it takes', () => {
    const still = new Uint8ClampedArray(4 * 4 * 4);
    expect(() => analyzeLoop([[still, 1e-9]], 4)).toThrow(/A loop of 1 frames lasts/);
    expect(() => analyzeLoop([[still, MIN_MEAN_FRAME_MS], [still, MIN_MEAN_FRAME_MS / 2]], 4)).toThrow(/A loop of 2 frames lasts/);
    expect(analyzeLoop([[still, MIN_MEAN_FRAME_MS]], 4)).toEqual({ flagged: false });
  });

  it('refuses a sample or a field of no size', () => {
    expect(() => new FlashAnalyzer(0)).toThrow(/side/);
    expect(() => new FlashAnalyzer(1.5)).toThrow(/side/);
    expect(() => analyzeLoop([[new Uint8ClampedArray(0), 100]], 0)).toThrow(/side/);
    expect(() => new FlashAnalyzer(64, 0)).toThrow(/field/);
    expect(() => new FlashAnalyzer(64, 65)).toThrow(/field/);
  });
});
