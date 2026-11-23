// WCAG 2.3.1's general flash and red flash thresholds over a moving image's frames (docs/themes.md "Wallpapers").
// Pure: the theme renderer page feeds it each decoded frame as a 64x64 RGBA sample, Vitest feeds it synthetic ones.

// The sample's side in cells; each frame is this square, RGBA, row by row.
export const FLASH_SAMPLE_SIDE = 64;
export const FLASH_WINDOW_MS = 1000;
// The shortest a loop's frames may be on average, which bounds the pass past its end to FLASH_WINDOW_MS / MIN_MEAN_FRAME_MS
// frames and one more loop.
export const MIN_MEAN_FRAME_MS = 1;
// More than three flashes in a second fails, and a flash is a pair of opposing transitions.
export const MAX_TRANSITIONS_PER_WINDOW = 6;
// The share of a 10 degree visual field that must flash in the same second.
export const FLASH_AREA_SHARE = 0.25;
// WCAG's 10 degree field, 341 x 256 px of a 1024 x 768 screen, as cells of a sample of the whole window: a third of it each way.
export const WALLPAPER_FLASH_FIELD: number = Math.round((FLASH_SAMPLE_SIDE * 341) / 1024);
// A general transition: relative luminance changes by at least 10% of the maximum while the darker state is below 0.80.
export const GENERAL_DELTA = 0.1;
export const DARKER_LIMIT = 0.8;
// A red transition: to or from a state of R/(R+G+B) at least 0.8, with (R-G-B)x320 (negative read as 0) changing by more than 20.
export const RED_SATURATION = 0.8;
export const RED_DELTA = 20;

export type FlashKind = 'general' | 'red';

/** What the analysis found: flagged with the start of the first second that fails, or not. */
export interface FlashResult {
  readonly flagged: boolean;
  readonly atMs?: number;
  readonly kind?: FlashKind;
}

// sRGB channel (0..255) to linear light, as WCAG's relative luminance reads it.
const LINEAR: Float32Array = (() => {
  const table = new Float32Array(256);
  for (let v = 0; v < 256; v++) {
    const c = v / 255;
    table[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return table;
})();

type Qualifies = (from: number, to: number, flagFrom: number, flagTo: number) => boolean;

// One measure per cell followed through its extremes: a transition completes when the value moves far enough from the extreme
// of the current trend, so a fade over several frames counts once and a flicker below the threshold never counts. `flag` is a
// per-cell state a rule may need at both ends (red saturation).
class Tracker {
  private readonly extreme: Float32Array;
  private readonly extremeFlag: Uint8Array;
  // before the first transition: the lowest and highest values seen, with their flags
  private readonly low: Float32Array;
  private readonly lowFlag: Uint8Array;
  private readonly high: Float32Array;
  private readonly highFlag: Uint8Array;
  // the direction of the last transition: 1 up, -1 down, 0 none yet
  private readonly trend: Int8Array;
  // each cell's latest transition times, a ring of MAX_TRANSITIONS_PER_WINDOW + 1
  private readonly times: Float64Array;
  private readonly counts: Uint32Array;
  // the failing cells above and left of each cell, one row and one column wider than the sample
  private readonly sums: Uint32Array;
  private readonly slots = MAX_TRANSITIONS_PER_WINDOW + 1;
  private started = false;
  private readonly pixels: number;
  private readonly side: number;
  private readonly field: number;
  private readonly qualifies: Qualifies;

  constructor(side: number, field: number, qualifies: Qualifies) {
    const pixels = side * side;
    this.pixels = pixels;
    this.side = side;
    this.field = field;
    this.qualifies = qualifies;
    this.extreme = new Float32Array(pixels);
    this.extremeFlag = new Uint8Array(pixels);
    this.low = new Float32Array(pixels);
    this.lowFlag = new Uint8Array(pixels);
    this.high = new Float32Array(pixels);
    this.highFlag = new Uint8Array(pixels);
    this.trend = new Int8Array(pixels);
    this.times = new Float64Array(pixels * this.slots);
    this.counts = new Uint32Array(pixels);
    this.sums = new Uint32Array((side + 1) * (side + 1));
  }

  push(values: Float32Array, flags: Uint8Array, atMs: number): void {
    if (!this.started) {
      this.low.set(values);
      this.high.set(values);
      this.lowFlag.set(flags);
      this.highFlag.set(flags);
      this.started = true;
      return;
    }
    for (let p = 0; p < this.pixels; p++) {
      const value = values[p]!;
      const flag = flags[p]!;
      const trend = this.trend[p]!;
      if (trend === 0) {
        if (value > this.low[p]! && this.qualifies(this.low[p]!, value, this.lowFlag[p]!, flag)) this.transition(p, 1, value, flag, atMs);
        else if (value < this.high[p]! && this.qualifies(this.high[p]!, value, this.highFlag[p]!, flag)) this.transition(p, -1, value, flag, atMs);
        else {
          if (value < this.low[p]!) [this.low[p], this.lowFlag[p]] = [value, flag];
          if (value > this.high[p]!) [this.high[p], this.highFlag[p]] = [value, flag];
        }
        continue;
      }
      const extreme = this.extreme[p]!;
      if (trend > 0 ? value >= extreme : value <= extreme) [this.extreme[p], this.extremeFlag[p]] = [value, flag];
      else if (this.qualifies(extreme, value, this.extremeFlag[p]!, flag)) this.transition(p, trend > 0 ? -1 : 1, value, flag, atMs);
    }
  }

  private transition(p: number, direction: 1 | -1, value: number, flag: number, atMs: number): void {
    this.trend[p] = direction;
    this.extreme[p] = value;
    this.extremeFlag[p] = flag;
    this.times[p * this.slots + (this.counts[p]! % this.slots)] = atMs;
    this.counts[p]!++;
  }

  /**
   * The start of the second, ending at `atMs`, in which some `field` x `field` square of cells held at least FLASH_AREA_SHARE
   * of its cells making too many transitions.
   */
  failing(atMs: number): number | undefined {
    const { side, field, sums } = this;
    const row = side + 1;
    const need = field * field * FLASH_AREA_SHARE;
    let failing = 0;
    let start = Number.POSITIVE_INFINITY;
    for (let p = 0; p < this.pixels; p++) {
      const count = this.counts[p]!;
      // the oldest of the latest `slots` transitions
      const oldest = count < this.slots ? Number.NEGATIVE_INFINITY : this.times[p * this.slots + (count % this.slots)]!;
      // a millisecond's slack for frame times that do not add up exactly, so a steady 3 flashes a second passes
      const fails = atMs - oldest < FLASH_WINDOW_MS - 1 ? 1 : 0;
      if (fails === 1) {
        failing++;
        if (oldest < start) start = oldest;
      }
      const at = (Math.floor(p / side) + 1) * row + (p % side) + 1;
      sums[at] = fails + sums[at - 1]! + sums[at - row]! - sums[at - row - 1]!;
    }
    if (failing < need) return undefined;
    for (let top = 0; top + field <= side; top++) {
      for (let left = 0; left + field <= side; left++) {
        const a = top * row + left;
        const b = (top + field) * row + left;
        if (sums[b + field]! - sums[b]! - sums[a + field]! + sums[a]! >= need) return start;
      }
    }
    return undefined;
  }
}

// What a frame paints over one backdrop, and the two thresholds followed over it.
class Backdrop {
  private readonly luminance: Float32Array;
  private readonly red: Float32Array;
  private readonly saturated: Uint8Array;
  private readonly none: Uint8Array;
  private readonly general: Tracker;
  private readonly redFlash: Tracker;
  // the backdrop's sRGB channel value, 0 or 255
  private readonly channel: number;

  constructor(side: number, field: number, channel: number) {
    const pixels = side * side;
    this.channel = channel;
    this.luminance = new Float32Array(pixels);
    this.red = new Float32Array(pixels);
    this.saturated = new Uint8Array(pixels);
    this.none = new Uint8Array(pixels);
    this.general = new Tracker(side, field, (from, to) => Math.abs(to - from) >= GENERAL_DELTA && Math.min(from, to) < DARKER_LIMIT);
    this.redFlash = new Tracker(side, field, (from, to, flagFrom, flagTo) => Math.abs(to - from) > RED_DELTA && (flagFrom === 1 || flagTo === 1));
  }

  /** The earlier failing second's start with its kind, general on a tie, or undefined. */
  push(rgba: Uint8ClampedArray | Uint8Array, atMs: number): { readonly start: number; readonly kind: FlashKind } | undefined {
    const under = this.channel;
    for (let p = 0, at = 0; p < this.luminance.length; p++, at += 4) {
      const alpha = rgba[at + 3]!;
      const rest = under * (255 - alpha);
      const r = LINEAR[Math.round((rgba[at]! * alpha + rest) / 255)]!;
      const g = LINEAR[Math.round((rgba[at + 1]! * alpha + rest) / 255)]!;
      const b = LINEAR[Math.round((rgba[at + 2]! * alpha + rest) / 255)]!;
      this.luminance[p] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      this.red[p] = Math.max(0, (r - g - b) * 320);
      const sum = r + g + b;
      this.saturated[p] = sum > 0 && r / sum >= RED_SATURATION ? 1 : 0;
    }
    this.general.push(this.luminance, this.none, atMs);
    this.redFlash.push(this.red, this.saturated, atMs);
    const general = this.general.failing(atMs);
    const red = this.redFlash.failing(atMs);
    if (red !== undefined && (general === undefined || red < general)) return { start: red, kind: 'red' };
    return general === undefined ? undefined : { start: general, kind: 'general' };
  }
}

/**
 * Takes frames in presentation order; `push` answers true once the frames fail either threshold, after which nothing changes.
 * `atMs` is each frame's presentation time from the start of the media. A frame's alpha is painted over a backdrop nobody
 * knows here, and a change is largest over black or over white, so the frames must pass over both. `field` is the side, in
 * cells, of the square a quarter of which must flash: the whole sample unless the image fills the window.
 */
export class FlashAnalyzer {
  private readonly bytes: number;
  private readonly backdrops: readonly Backdrop[];
  private found: FlashResult | undefined;

  constructor(side: number = FLASH_SAMPLE_SIDE, field: number = side) {
    if (!Number.isInteger(side) || side < 1) throw new Error(`A flash sample's side is a positive whole number, not ${side}`);
    if (!Number.isInteger(field) || field < 1 || field > side) throw new Error(`A flash field is 1 to ${side} cells a side, not ${field}`);
    this.bytes = side * side * 4;
    this.backdrops = [new Backdrop(side, field, 0), new Backdrop(side, field, 255)];
  }

  push(rgba: Uint8ClampedArray | Uint8Array, atMs: number): boolean {
    if (this.found) return true;
    if (rgba.length !== this.bytes) throw new Error(`A flash sample is ${this.bytes} bytes, not ${rgba.length}`);
    let first: { readonly start: number; readonly kind: FlashKind } | undefined;
    for (const backdrop of this.backdrops) {
      const failed = backdrop.push(rgba, atMs);
      if (failed !== undefined && (first === undefined || failed.start < first.start)) first = failed;
    }
    if (first === undefined) return false;
    this.found = { flagged: true, atMs: Math.max(0, Math.round(first.start)), kind: first.kind };
    return true;
  }

  result(): FlashResult {
    return this.found ?? { flagged: false };
  }
}

/**
 * A looping animation's frames, [rgba, durationMs] from time 0, analysed once through and on into the next loop for a second,
 * since a second that crosses the loop point flashes too. The failing time is within the first loop. Throws for a duration
 * that is not a time above 0, and for a loop whose frames average less than MIN_MEAN_FRAME_MS: a check that cannot tell how
 * long a frame shows, or that would not end, must not answer that nothing flashes.
 */
export function analyzeLoop(frames: ReadonlyArray<readonly [Uint8ClampedArray | Uint8Array, number]>, side: number = FLASH_SAMPLE_SIDE, field: number = side): FlashResult {
  const analyzer = new FlashAnalyzer(side, field);
  for (const [, duration] of frames) {
    if (!Number.isFinite(duration) || duration <= 0) throw new Error(`A frame lasts a time above 0, not ${duration} ms`);
  }
  const total = frames.reduce((sum, [, duration]) => sum + duration, 0);
  if (total < frames.length * MIN_MEAN_FRAME_MS) throw new Error(`A loop of ${frames.length} frames lasts at least ${frames.length * MIN_MEAN_FRAME_MS} ms, not ${total} ms`);
  const end = total + FLASH_WINDOW_MS;
  for (let at = 0; frames.length > 0 && at < end;) {
    for (const [rgba, duration] of frames) {
      if (analyzer.push(rgba, at)) {
        const found = analyzer.result();
        // whole ms, as the theme file and the flash record hold it: a loop's length may be a fraction of one
        return { ...found, atMs: Math.floor(found.atMs! % total) };
      }
      at += duration;
      if (at >= end) break;
    }
  }
  return analyzer.result();
}
